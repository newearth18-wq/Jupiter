import { WorkflowPlanDraftSchema, type WorkflowPlanDraft } from '@jupiter/contracts';
import { JupiterError } from '@jupiter/core';

export type PlanValidationContext = {
  availableSkills: ReadonlySet<string>;
  approvedPermissions: ReadonlySet<string>;
};

export function validateStructuredPlan(
  modelOutput: unknown,
  context: PlanValidationContext,
): WorkflowPlanDraft {
  const candidate = parseModelOutput(modelOutput);
  const parsed = WorkflowPlanDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    throw planError(
      'PLAN_SCHEMA_INVALID',
      'Planner output did not match the strict workflow schema.',
      parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
    );
  }
  const plan = parsed.data;
  const byId = new Map(plan.steps.map((step) => [step.stepId, step]));
  if (byId.size !== plan.steps.length) {
    throw planError('PLAN_STEP_DUPLICATE', 'Plan contains duplicate step IDs.');
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependencies) {
      if (!byId.has(dependency)) {
        throw planError(
          'PLAN_DEPENDENCY_MISSING',
          `Step "${step.title}" references a missing dependency.`,
        );
      }
      if (dependency === step.stepId) {
        throw planError('PLAN_CYCLE', `Step "${step.title}" cannot depend on itself.`);
      }
    }
    if (step.condition && !step.dependencies.includes(step.condition.sourceStepId)) {
      throw planError(
        'PLAN_CONDITION_AMBIGUOUS',
        `Conditional step "${step.title}" must directly depend on its condition source.`,
      );
    }
  }
  topologicalOrder(plan);

  const declaredSkills = new Set(plan.requiredSkills);
  for (const step of plan.steps) {
    if (!declaredSkills.has(step.skillId)) {
      throw planError('PLAN_SKILL_UNDECLARED', `Step "${step.title}" uses an undeclared skill.`);
    }
  }
  const missingSkills = [...declaredSkills].filter((skill) => !context.availableSkills.has(skill));
  if (missingSkills.length > 0) {
    throw planError(
      'PLAN_SKILL_MISSING',
      `Plan requires unavailable skills: ${missingSkills.join(', ')}.`,
    );
  }

  const declaredPermissions = new Set(plan.requiredPermissions);
  for (const step of plan.steps) {
    const undeclared = step.requiredPermissions.filter(
      (permission) => !declaredPermissions.has(permission),
    );
    if (undeclared.length > 0) {
      throw planError(
        'PLAN_PERMISSION_UNDECLARED',
        `Step "${step.title}" uses undeclared permissions: ${undeclared.join(', ')}.`,
      );
    }
  }
  const unapproved = [...declaredPermissions].filter(
    (permission) => !context.approvedPermissions.has(permission),
  );
  if (unapproved.length > 0) {
    throw planError(
      'PLAN_PERMISSION_INVALID',
      `Plan requires permissions that are not approved: ${unapproved.join(', ')}.`,
    );
  }

  validateArtifacts(plan, byId);
  return plan;
}

export function topologicalOrder(plan: WorkflowPlanDraft): string[] {
  const incoming = new Map(plan.steps.map((step) => [step.stepId, step.dependencies.length]));
  const dependants = new Map<string, string[]>();
  for (const step of plan.steps) {
    for (const dependency of step.dependencies) {
      const values = dependants.get(dependency) ?? [];
      values.push(step.stepId);
      dependants.set(dependency, values);
    }
  }
  const ready = plan.steps
    .filter((step) => step.dependencies.length === 0)
    .map((step) => step.stepId);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const stepId = ready.shift();
    if (!stepId) break;
    ordered.push(stepId);
    for (const dependant of dependants.get(stepId) ?? []) {
      const remaining = (incoming.get(dependant) ?? 0) - 1;
      incoming.set(dependant, remaining);
      if (remaining === 0) ready.push(dependant);
    }
  }
  if (ordered.length !== plan.steps.length) {
    throw planError('PLAN_CYCLE', 'Plan contains a dependency cycle.');
  }
  return ordered;
}

function parseModelOutput(modelOutput: unknown): unknown {
  if (typeof modelOutput !== 'string') return modelOutput;
  try {
    return JSON.parse(modelOutput) as unknown;
  } catch {
    throw planError('PLAN_JSON_INVALID', 'Planner output is not valid JSON.');
  }
}

function validateArtifacts(
  plan: WorkflowPlanDraft,
  byId: ReadonlyMap<string, WorkflowPlanDraft['steps'][number]>,
): void {
  const declared = new Set(plan.expectedArtifacts.map((artifact) => artifact.artifactKey));
  if (declared.size !== plan.expectedArtifacts.length) {
    throw planError('PLAN_ARTIFACT_AMBIGUOUS', 'Plan declares duplicate artifact keys.');
  }
  const producers = new Map<string, string>();
  for (const step of plan.steps) {
    for (const artifactKey of step.producesArtifacts) {
      if (!declared.has(artifactKey)) {
        throw planError(
          'PLAN_ARTIFACT_UNDECLARED',
          `Step "${step.title}" produces undeclared artifact "${artifactKey}".`,
        );
      }
      if (producers.has(artifactKey)) {
        throw planError(
          'PLAN_ARTIFACT_AMBIGUOUS',
          `Artifact "${artifactKey}" has more than one producer.`,
        );
      }
      producers.set(artifactKey, step.stepId);
    }
  }
  for (const artifact of plan.expectedArtifacts) {
    if (artifact.required && !producers.has(artifact.artifactKey)) {
      throw planError(
        'PLAN_ARTIFACT_MISSING',
        `Required artifact "${artifact.artifactKey}" has no producer.`,
      );
    }
  }
  for (const step of plan.steps) {
    const ancestors = collectAncestors(step.stepId, byId);
    for (const reference of collectArtifactReferences(step.input)) {
      if (!declared.has(reference)) {
        throw planError(
          'PLAN_ARTIFACT_UNDECLARED',
          `Step "${step.title}" references undeclared artifact "${reference}".`,
        );
      }
      const producer = producers.get(reference);
      if (!producer || !ancestors.has(producer)) {
        throw planError(
          'PLAN_ARTIFACT_AMBIGUOUS',
          `Step "${step.title}" references artifact "${reference}" before its producer dependency.`,
        );
      }
    }
  }
}

function collectAncestors(
  stepId: string,
  byId: ReadonlyMap<string, WorkflowPlanDraft['steps'][number]>,
): Set<string> {
  const result = new Set<string>();
  const visit = (current: string): void => {
    for (const dependency of byId.get(current)?.dependencies ?? []) {
      if (result.has(dependency)) continue;
      result.add(dependency);
      visit(dependency);
    }
  };
  visit(stepId);
  return result;
}

function collectArtifactReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectArtifactReferences);
  if (typeof value !== 'object' || value === null) return [];
  const object = value as Record<string, unknown>;
  const own =
    Object.keys(object).length === 1 && typeof object.$artifact === 'string'
      ? [object.$artifact]
      : [];
  return [...own, ...Object.values(object).flatMap(collectArtifactReferences)];
}

function planError(code: string, message: string, sanitizedDetails?: string): JupiterError {
  return new JupiterError({
    code,
    category: 'validation',
    message,
    recoverable: true,
    retryable: false,
    userAction: 'Correct the structured plan and submit a new revision.',
    ...(sanitizedDetails ? { sanitizedDetails: sanitizedDetails.slice(0, 500) } : {}),
  });
}
