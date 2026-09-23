import { randomUUID } from 'node:crypto';
import {
  WorkflowArtifactBindingSchema,
  WorkflowCheckpointResolveInputSchema,
  WorkflowCheckpointSchema,
  WorkflowControlInputSchema,
  WorkflowDetailSchema,
  WorkflowExecutionSchema,
  WorkflowPlanSchema,
  WorkflowReplanInputSchema,
  WorkflowStepAttemptSchema,
  type MissionStatus,
  type WorkflowControlInput,
  type WorkflowDetail,
  type WorkflowExecution,
  type WorkflowPlan,
  type WorkflowPlanDraft,
  type WorkflowReplanInput,
  type WorkflowStep,
  type WorkflowStepAttempt,
  type WorkflowStepStatus,
} from '@jupiter/contracts';
import {
  JupiterError,
  type MissionRuntime,
  type WorkflowRepository,
  type WorkflowRuntime,
  type WorkflowStepExecutor,
  type WorkflowStepResult,
} from '@jupiter/core';
import { validateStructuredPlan } from './planner.js';

type RuntimeEvent = {
  type: string;
  missionId: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: string;
};

export type DurableWorkflowRuntimeDependencies = {
  repository: WorkflowRepository;
  missionRuntime: MissionRuntime;
  executors?: readonly WorkflowStepExecutor[];
  approvedPermissions?: ReadonlySet<string>;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  recordEvent?: (event: RuntimeEvent) => void;
};

type ActiveRun = {
  missionId: string;
  executionId: string;
  controller: AbortController;
  detach: () => void;
  pauseRequested: boolean;
  activeBatch: number;
  boundaryWaiters: (() => void)[];
};

const TERMINAL_STEP = new Set<WorkflowStepStatus>(['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED']);

export class DurableWorkflowRuntime implements WorkflowRuntime {
  readonly #repository: WorkflowRepository;
  readonly #missions: MissionRuntime;
  readonly #executors: ReadonlyMap<string, WorkflowStepExecutor>;
  readonly #approvedPermissions: ReadonlySet<string>;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #recordEvent: DurableWorkflowRuntimeDependencies['recordEvent'];
  readonly #active = new Map<string, ActiveRun>();

  constructor(dependencies: DurableWorkflowRuntimeDependencies) {
    this.#repository = dependencies.repository;
    this.#missions = dependencies.missionRuntime;
    this.#executors = new Map(
      (dependencies.executors ?? []).map((executor) => [executor.skillId, executor]),
    );
    this.#approvedPermissions = dependencies.approvedPermissions ?? new Set();
    this.#now = dependencies.now ?? (() => new Date());
    this.#sleep = dependencies.sleep ?? abortableDelay;
    this.#recordEvent = dependencies.recordEvent;
  }

  getWorkflow(missionId: string): WorkflowDetail | undefined {
    const plan = this.#repository.getActiveWorkflowPlan(missionId);
    if (!plan) return undefined;
    const execution = this.#repository.getLatestWorkflowExecution(missionId);
    return WorkflowDetailSchema.parse({
      plan,
      ...(execution?.planId === plan.planId ? { execution } : {}),
      stepAttempts: execution
        ? this.#repository.listWorkflowStepAttempts(execution.workflowExecutionId)
        : [],
      checkpoints: execution
        ? this.#repository.listWorkflowCheckpoints(execution.workflowExecutionId)
        : [],
      artifacts: execution
        ? this.#repository.listWorkflowArtifactBindings(execution.workflowExecutionId)
        : [],
    });
  }

  createPlan(missionId: string, modelOutput: unknown): WorkflowDetail {
    const draft = this.#validate(modelOutput);
    let mission = this.#missions.getMissionDetail(missionId).mission;
    if (mission.status === 'CREATED') {
      mission = this.#missions.transitionMission({
        missionId,
        toStatus: 'ANALYZING',
        reason: 'Structured planning began.',
      }).mission;
    }
    if (mission.status === 'ANALYZING') {
      mission = this.#missions.transitionMission({
        missionId,
        toStatus: 'PLANNING',
        reason: 'Intent analysis completed and plan validation began.',
      }).mission;
    }
    if (mission.status !== 'PLANNING') {
      throw workflowError(
        'WORKFLOW_PLAN_STATE_INVALID',
        'A new initial plan requires a Mission in PLANNING state.',
      );
    }
    const plan = this.#persistPlan(missionId, draft);
    this.#missions.setPlanSnapshot(missionId, {
      summary: plan.goal,
      assumptions: plan.assumptions,
    });
    for (const step of plan.steps) this.#syncMissionStep(missionId, step, 'PENDING');
    this.#missions.transitionMission({
      missionId,
      toStatus: 'READY',
      reason: `Validated workflow plan revision ${plan.revision.toString()} is ready.`,
    });
    this.#emit('workflow.plan.created', missionId, {
      planId: plan.planId,
      revision: plan.revision,
      stepCount: plan.steps.length,
    });
    return requiredDetail(this.getWorkflow(missionId));
  }

  replanWorkflow(input: WorkflowReplanInput): WorkflowDetail {
    const valid = WorkflowReplanInputSchema.parse(input);
    const draft = this.#validate(valid.modelOutput);
    const mission = this.#missions.getMissionDetail(valid.missionId).mission;
    if (!['FAILED', 'PARTIAL_SUCCESS', 'CANCELLED'].includes(mission.status)) {
      throw workflowError(
        'WORKFLOW_REPLAN_STATE_INVALID',
        'Re-planning requires a failed, partial, or cancelled Mission.',
      );
    }
    this.#missions.retryMission({ missionId: valid.missionId, reason: valid.reason });
    const plan = this.#persistPlan(valid.missionId, draft);
    this.#missions.setPlanSnapshot(valid.missionId, {
      summary: plan.goal,
      assumptions: plan.assumptions,
    });
    for (const step of plan.steps) this.#syncMissionStep(valid.missionId, step, 'PENDING');
    this.#emit('workflow.plan.revised', valid.missionId, {
      planId: plan.planId,
      priorPlanId: plan.priorPlanId,
      revision: plan.revision,
      reason: valid.reason,
    });
    return requiredDetail(this.getWorkflow(valid.missionId));
  }

  async startWorkflow(input: WorkflowControlInput): Promise<WorkflowDetail> {
    const valid = WorkflowControlInputSchema.parse(input);
    const plan = this.#requiredPlan(valid.missionId);
    const mission = this.#missions.getMissionDetail(valid.missionId).mission;
    if (mission.status !== 'READY') {
      throw workflowError('WORKFLOW_START_STATE_INVALID', 'Workflow requires a READY Mission.');
    }
    const current = this.#repository.getLatestWorkflowExecution(valid.missionId);
    if (current && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)) {
      throw workflowError('WORKFLOW_ALREADY_ACTIVE', 'A workflow execution is already active.');
    }
    const timestamp = this.#timestamp();
    const execution = WorkflowExecutionSchema.parse({
      workflowExecutionId: randomUUID(),
      planId: plan.planId,
      missionId: valid.missionId,
      status: 'RUNNING',
      startedAt: timestamp,
      updatedAt: timestamp,
      pauseRequested: false,
      cancelRequested: false,
    });
    this.#repository.createWorkflowExecution(execution);
    this.#missions.transitionMission({
      missionId: valid.missionId,
      toStatus: 'RUNNING',
      reason: valid.reason ?? 'Validated workflow execution started.',
    });
    this.#emit('workflow.started', valid.missionId, {
      workflowExecutionId: execution.workflowExecutionId,
      planId: plan.planId,
    });
    await this.#run(execution);
    return requiredDetail(this.getWorkflow(valid.missionId));
  }

  async resumeWorkflow(input: WorkflowControlInput): Promise<WorkflowDetail> {
    const valid = WorkflowControlInputSchema.parse(input);
    const execution = this.#requiredExecution(valid.missionId);
    if (execution.status !== 'WAITING' || !execution.pauseRequested) {
      throw workflowError(
        'WORKFLOW_RESUME_STATE_INVALID',
        'Only a workflow paused at a safe boundary can resume.',
      );
    }
    const updated = WorkflowExecutionSchema.parse({
      ...execution,
      status: 'RUNNING',
      pauseRequested: false,
      updatedAt: this.#timestamp(),
    });
    this.#repository.updateWorkflowExecution(updated);
    const mission = this.#missions.getMissionDetail(valid.missionId).mission;
    if (mission.status === 'PAUSED') {
      this.#missions.resumeMission({ missionId: valid.missionId, reason: valid.reason });
    }
    await this.#run(updated);
    return requiredDetail(this.getWorkflow(valid.missionId));
  }

  async cancelWorkflow(input: WorkflowControlInput): Promise<WorkflowDetail> {
    const valid = WorkflowControlInputSchema.parse(input);
    const execution = this.#requiredExecution(valid.missionId);
    const active = this.#active.get(valid.missionId);
    if (active) await this.#cancelActive(active, valid.reason ?? 'Workflow cancelled.');
    else this.#markExecutionCancelled(execution, valid.reason ?? 'Workflow cancelled.');
    const mission = this.#missions.getMissionDetail(valid.missionId).mission;
    if (!['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'].includes(mission.status)) {
      await this.#missions.cancelMission({ missionId: valid.missionId, reason: valid.reason });
    }
    return requiredDetail(this.getWorkflow(valid.missionId));
  }

  async resolveCheckpoint(input: {
    checkpointId: string;
    decision: 'APPROVED' | 'DENIED';
    reason: string;
  }): Promise<WorkflowDetail> {
    const valid = WorkflowCheckpointResolveInputSchema.parse(input);
    const checkpoint = this.#repository.getWorkflowCheckpoint(valid.checkpointId);
    if (checkpoint?.status !== 'PENDING') {
      throw workflowError(
        'WORKFLOW_CHECKPOINT_INVALID',
        'Checkpoint is missing or has already been resolved.',
      );
    }
    const execution = this.#repository.getWorkflowExecution(checkpoint.workflowExecutionId);
    if (!execution) throw workflowError('WORKFLOW_NOT_FOUND', 'Workflow execution was not found.');
    this.#repository.updateWorkflowCheckpoint(
      WorkflowCheckpointSchema.parse({
        ...checkpoint,
        status: valid.decision,
        reason: valid.reason,
        resolvedAt: this.#timestamp(),
      }),
    );
    if (valid.decision === 'DENIED') {
      await this.#failWorkflow(execution, `Checkpoint denied: ${valid.reason}`);
    } else {
      const pending = this.#repository
        .listWorkflowCheckpoints(execution.workflowExecutionId)
        .some((item) => item.status === 'PENDING');
      if (!pending) {
        const updated = WorkflowExecutionSchema.parse({
          ...execution,
          status: 'RUNNING',
          updatedAt: this.#timestamp(),
        });
        this.#repository.updateWorkflowExecution(updated);
        const mission = this.#missions.getMissionDetail(execution.missionId).mission;
        if (mission.status === 'WAITING_APPROVAL' || mission.status === 'WAITING_IDENTITY') {
          this.#missions.transitionMission({
            missionId: execution.missionId,
            toStatus: 'RUNNING',
            reason: 'Required workflow checkpoint was resolved.',
          });
        }
        await this.#run(updated);
      }
    }
    return requiredDetail(this.getWorkflow(execution.missionId));
  }

  async recover(): Promise<void> {
    for (const execution of this.#repository.listRecoverableWorkflowExecutions()) {
      if (execution.status === 'WAITING') continue;
      const mission = this.#missions.getMissionDetail(execution.missionId).mission;
      if (mission.status === 'READY') {
        this.#missions.transitionMission({
          missionId: execution.missionId,
          toStatus: 'RUNNING',
          reason: 'Durable workflow recovered after restart.',
        });
      }
      await this.#run(
        WorkflowExecutionSchema.parse({
          ...execution,
          status: 'RUNNING',
          updatedAt: this.#timestamp(),
        }),
      );
    }
  }

  shutdown(): Promise<void> {
    const active = [...this.#active.values()];
    for (const run of active) {
      run.controller.abort('Jupiter is shutting down.');
      this.#resolveBoundary(run);
      run.detach();
    }
    this.#active.clear();
    return Promise.resolve();
  }

  #validate(modelOutput: unknown): WorkflowPlanDraft {
    return validateStructuredPlan(modelOutput, {
      availableSkills: new Set(this.#executors.keys()),
      approvedPermissions: this.#approvedPermissions,
    });
  }

  #persistPlan(missionId: string, draft: WorkflowPlanDraft): WorkflowPlan {
    const prior = this.#repository.getActiveWorkflowPlan(missionId);
    const revision = (prior?.revision ?? 0) + 1;
    const plan = WorkflowPlanSchema.parse({
      ...draft,
      planId: randomUUID(),
      missionId,
      revision,
      ...(prior ? { priorPlanId: prior.planId } : {}),
      active: true,
      createdAt: this.#timestamp(),
    });
    this.#repository.transaction(() => {
      if (prior) this.#repository.setWorkflowPlanActive(prior.planId, false);
      this.#repository.createWorkflowPlan(plan);
    });
    return plan;
  }

  async #run(initial: WorkflowExecution): Promise<void> {
    if (this.#active.has(initial.missionId)) return;
    const controller = new AbortController();
    const active: ActiveRun = {
      missionId: initial.missionId,
      executionId: initial.workflowExecutionId,
      controller,
      detach: () => undefined,
      pauseRequested: initial.pauseRequested,
      activeBatch: 0,
      boundaryWaiters: [],
    };
    active.detach = this.#missions.attachChildRuntime(initial.missionId, controller, {
      pauseAtSafeBoundary: () => this.#pauseAtBoundary(active),
      cancel: (reason) => this.#cancelActive(active, reason),
    });
    this.#active.set(initial.missionId, active);
    try {
      await this.#drive(initial, active);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      active.detach();
      this.#active.delete(initial.missionId);
      this.#resolveBoundary(active);
    }
  }

  async #drive(initial: WorkflowExecution, active: ActiveRun): Promise<void> {
    const plan = this.#requiredPlan(initial.missionId);
    let execution = initial;
    while (!active.controller.signal.aborted) {
      execution = this.#repository.getWorkflowExecution(execution.workflowExecutionId) ?? execution;
      if (execution.cancelRequested) return;
      if (active.pauseRequested || execution.pauseRequested) {
        this.#markExecutionWaiting(execution, true);
        this.#resolveBoundary(active);
        return;
      }
      const latest = latestAttempts(
        this.#repository.listWorkflowStepAttempts(execution.workflowExecutionId),
      );
      const failed = plan.steps.filter((step) => latest.get(step.stepId)?.status === 'FAILED');
      if (failed.length > 0) {
        await this.#failWorkflow(
          execution,
          failed.map((step) => `${step.title} failed`).join('; '),
        );
        return;
      }
      const unfinished = plan.steps.filter(
        (step) => !TERMINAL_STEP.has(latest.get(step.stepId)?.status ?? 'PENDING'),
      );
      if (unfinished.length === 0) {
        await this.#completeWorkflow(execution, plan);
        return;
      }
      const ready = unfinished.filter((step) =>
        step.dependencies.every((dependency) => {
          const status = latest.get(dependency)?.status;
          return status === 'COMPLETED' || status === 'SKIPPED';
        }),
      );
      if (ready.length === 0) {
        await this.#failWorkflow(execution, 'Workflow has no executable node.');
        return;
      }
      const gated: WorkflowStep[] = [];
      const runnable: WorkflowStep[] = [];
      for (const step of ready) {
        if (step.checkpoint === 'NONE' || this.#checkpointApproved(execution, step)) {
          runnable.push(step);
        } else {
          gated.push(step);
        }
      }
      active.activeBatch = runnable.length;
      await Promise.all(
        runnable.map(async (step) => {
          try {
            await this.#runStep(execution, plan, step, active.controller.signal);
          } finally {
            active.activeBatch -= 1;
          }
        }),
      );
      this.#resolveBoundary(active);
      if (pauseRequested(active)) continue;
      if (gated.length > 0) {
        for (const step of gated) this.#createCheckpoint(execution, step);
        this.#markExecutionWaiting(execution, false);
        const waitStatus: MissionStatus = gated.some((step) => step.checkpoint === 'IDENTITY')
          ? 'WAITING_IDENTITY'
          : 'WAITING_APPROVAL';
        this.#missions.transitionMission({
          missionId: execution.missionId,
          toStatus: waitStatus,
          reason: 'Workflow is waiting for a required human checkpoint.',
        });
        return;
      }
    }
  }

  async #runStep(
    execution: WorkflowExecution,
    plan: WorkflowPlan,
    step: WorkflowStep,
    parentSignal: AbortSignal,
  ): Promise<void> {
    if (
      !evaluateCondition(
        step,
        this.#repository.listWorkflowStepAttempts(execution.workflowExecutionId),
      )
    ) {
      this.#recordSyntheticAttempt(execution, step, 'SKIPPED', 'Conditional branch did not match.');
      return;
    }
    const executor = this.#executors.get(step.skillId);
    if (!executor)
      throw workflowError('WORKFLOW_SKILL_MISSING', 'Required executor is unavailable.');
    const existing = this.#repository
      .listWorkflowStepAttempts(execution.workflowExecutionId)
      .filter((attempt) => attempt.stepId === step.stepId);
    const completed = existing.find((attempt) => attempt.status === 'COMPLETED');
    if (completed) return;
    const idempotencyKey = `${execution.workflowExecutionId}:${step.stepId}`;
    let recoverable = existing.find((attempt) => attempt.status === 'RUNNING');
    let attemptNumber = recoverable ? recoverable.attempt - 1 : existing.length;
    while (attemptNumber < step.retryPolicy.maxAttempts) {
      if (parentSignal.aborted) return;
      attemptNumber = recoverable?.attempt ?? attemptNumber + 1;
      const resolvedInput = this.#resolveInput(step.input, execution.workflowExecutionId);
      const startedAt = recoverable?.startedAt ?? this.#timestamp();
      const attempt = WorkflowStepAttemptSchema.parse({
        stepAttemptId: recoverable?.stepAttemptId ?? randomUUID(),
        workflowExecutionId: execution.workflowExecutionId,
        stepId: step.stepId,
        attempt: attemptNumber,
        status: 'RUNNING',
        idempotencyKey,
        input: resolvedInput,
        startedAt,
      });
      this.#repository.upsertWorkflowStepAttempt(attempt);
      recoverable = undefined;
      this.#syncMissionStep(execution.missionId, step, 'RUNNING', startedAt);
      this.#emit('workflow.step.started', execution.missionId, {
        workflowExecutionId: execution.workflowExecutionId,
        stepId: step.stepId,
        attempt: attemptNumber,
      });
      try {
        const result = await executeWithTimeout(
          executor,
          {
            missionId: execution.missionId,
            workflowExecutionId: execution.workflowExecutionId,
            step,
            resolvedInput,
            idempotencyKey,
          },
          step.timeoutMs,
          parentSignal,
        );
        this.#validateStepResult(step, result);
        const completedAt = this.#timestamp();
        this.#repository.upsertWorkflowStepAttempt(
          WorkflowStepAttemptSchema.parse({
            ...attempt,
            status: 'COMPLETED',
            ...(result.output === undefined ? {} : { output: result.output }),
            verificationPassed: result.verificationPassed,
            verificationSummary: result.verificationSummary,
            completedAt,
          }),
        );
        this.#bindArtifacts(execution, step, result.artifacts ?? {});
        this.#syncMissionStep(execution.missionId, step, 'COMPLETED', startedAt, completedAt);
        if (step.verification.required) {
          this.#missions.recordVerification(execution.missionId, {
            name: step.title,
            passed: result.verificationPassed,
            summary: result.verificationSummary,
          });
        }
        this.#emit('workflow.step.completed', execution.missionId, {
          workflowExecutionId: execution.workflowExecutionId,
          stepId: step.stepId,
          attempt: attemptNumber,
        });
        return;
      } catch (error) {
        if (isShutdownAbort(parentSignal)) {
          return;
        }
        const cancelled = signalWasAborted(parentSignal);
        const message = sanitizedError(error);
        this.#repository.upsertWorkflowStepAttempt(
          WorkflowStepAttemptSchema.parse({
            ...attempt,
            status: cancelled ? 'CANCELLED' : 'FAILED',
            sanitizedError: message,
            completedAt: this.#timestamp(),
          }),
        );
        if (cancelled) {
          this.#syncMissionStep(
            execution.missionId,
            step,
            'CANCELLED',
            startedAt,
            this.#timestamp(),
          );
          return;
        }
        if (attemptNumber >= step.retryPolicy.maxAttempts) {
          this.#syncMissionStep(
            execution.missionId,
            step,
            'FAILED',
            startedAt,
            this.#timestamp(),
            message,
          );
          this.#missions.recordError(execution.missionId, {
            stepId: step.stepId,
            code:
              error instanceof StepTimeoutError ? 'WORKFLOW_STEP_TIMEOUT' : 'WORKFLOW_STEP_FAILED',
            message,
            recoverable: true,
          });
          return;
        }
        const backoff = Math.round(
          step.retryPolicy.initialBackoffMs *
            step.retryPolicy.backoffMultiplier ** Math.max(0, attemptNumber - 1),
        );
        await this.#sleep(backoff, parentSignal);
      }
    }
  }

  async #completeWorkflow(execution: WorkflowExecution, plan: WorkflowPlan): Promise<void> {
    const bindings = this.#repository.listWorkflowArtifactBindings(execution.workflowExecutionId);
    const produced = new Set(bindings.map((binding) => binding.artifactKey));
    const missing = plan.expectedArtifacts.filter(
      (artifact) => artifact.required && !produced.has(artifact.artifactKey),
    );
    if (missing.length > 0) {
      await this.#failWorkflow(
        execution,
        `Required artifacts are missing: ${missing.map((item) => item.artifactKey).join(', ')}.`,
      );
      return;
    }
    this.#missions.transitionMission({
      missionId: execution.missionId,
      toStatus: 'VERIFYING',
      reason: 'Workflow steps completed; final verification began.',
    });
    this.#missions.recordVerification(execution.missionId, {
      name: 'Workflow verification plan',
      passed: true,
      summary: plan.verificationPlan.summary,
    });
    const updated = WorkflowExecutionSchema.parse({
      ...execution,
      status: 'COMPLETED',
      updatedAt: this.#timestamp(),
      endedAt: this.#timestamp(),
    });
    this.#repository.updateWorkflowExecution(updated);
    this.#missions.transitionMission({
      missionId: execution.missionId,
      toStatus: 'COMPLETED',
      reason: 'All required workflow steps and verification checks passed.',
    });
    this.#emit('workflow.completed', execution.missionId, {
      workflowExecutionId: execution.workflowExecutionId,
      planId: plan.planId,
    });
  }

  async #failWorkflow(execution: WorkflowExecution, reason: string): Promise<void> {
    const current =
      this.#repository.getWorkflowExecution(execution.workflowExecutionId) ?? execution;
    if (['FAILED', 'CANCELLED', 'COMPLETED'].includes(current.status)) return;
    const attempts = this.#repository.listWorkflowStepAttempts(execution.workflowExecutionId);
    await this.#compensate(current, attempts);
    this.#repository.updateWorkflowExecution(
      WorkflowExecutionSchema.parse({
        ...current,
        status: 'FAILED',
        failureReason: reason,
        updatedAt: this.#timestamp(),
        endedAt: this.#timestamp(),
      }),
    );
    const hasCompleted = attempts.some((attempt) => attempt.status === 'COMPLETED');
    const mission = this.#missions.getMissionDetail(execution.missionId).mission;
    if (!['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'].includes(mission.status)) {
      this.#missions.transitionMission({
        missionId: execution.missionId,
        toStatus: hasCompleted ? 'PARTIAL_SUCCESS' : 'FAILED',
        reason,
      });
    }
    this.#emit('workflow.failed', execution.missionId, {
      workflowExecutionId: execution.workflowExecutionId,
      reason,
    });
  }

  async #compensate(
    execution: WorkflowExecution,
    attempts: readonly WorkflowStepAttempt[],
  ): Promise<void> {
    const plan = this.#requiredPlan(execution.missionId);
    const completed = [...attempts].filter((attempt) => attempt.status === 'COMPLETED').reverse();
    for (const attempt of completed) {
      const step = plan.steps.find((candidate) => candidate.stepId === attempt.stepId);
      const executor = step ? this.#executors.get(step.skillId) : undefined;
      if (!step || !executor?.compensate) continue;
      try {
        await executor.compensate({
          missionId: execution.missionId,
          workflowExecutionId: execution.workflowExecutionId,
          step,
          output: attempt.output,
          signal: new AbortController().signal,
        });
      } catch {
        // The original failure remains authoritative; compensation is best effort and sanitized.
      }
    }
  }

  #validateStepResult(step: WorkflowStep, result: WorkflowStepResult): void {
    if (step.verification.required && !result.verificationPassed) {
      throw workflowError('WORKFLOW_VERIFICATION_FAILED', result.verificationSummary);
    }
    const artifactKeys = Object.keys(result.artifacts ?? {});
    const unexpected = artifactKeys.filter((key) => !step.producesArtifacts.includes(key));
    if (unexpected.length > 0) {
      throw workflowError(
        'WORKFLOW_ARTIFACT_UNDECLARED',
        `Executor returned undeclared artifacts: ${unexpected.join(', ')}.`,
      );
    }
    const missing = step.producesArtifacts.filter((key) => !(key in (result.artifacts ?? {})));
    if (missing.length > 0) {
      throw workflowError(
        'WORKFLOW_ARTIFACT_MISSING',
        `Executor did not return declared artifacts: ${missing.join(', ')}.`,
      );
    }
  }

  #bindArtifacts(
    execution: WorkflowExecution,
    step: WorkflowStep,
    artifacts: Readonly<Record<string, unknown>>,
  ): void {
    for (const [artifactKey, value] of Object.entries(artifacts)) {
      this.#repository.addWorkflowArtifactBinding(
        WorkflowArtifactBindingSchema.parse({
          bindingId: randomUUID(),
          workflowExecutionId: execution.workflowExecutionId,
          stepId: step.stepId,
          artifactKey,
          value,
          createdAt: this.#timestamp(),
        }),
      );
    }
  }

  #resolveInput(
    input: Readonly<Record<string, unknown>>,
    workflowExecutionId: string,
  ): Record<string, unknown> {
    const artifacts = new Map(
      this.#repository
        .listWorkflowArtifactBindings(workflowExecutionId)
        .map((binding) => [binding.artifactKey, binding.value]),
    );
    return resolveArtifactReferences(input, artifacts) as Record<string, unknown>;
  }

  #checkpointApproved(execution: WorkflowExecution, step: WorkflowStep): boolean {
    const checkpoint = this.#repository
      .listWorkflowCheckpoints(execution.workflowExecutionId)
      .find((item) => item.stepId === step.stepId);
    return checkpoint?.status === 'APPROVED';
  }

  #createCheckpoint(execution: WorkflowExecution, step: WorkflowStep): void {
    const existing = this.#repository
      .listWorkflowCheckpoints(execution.workflowExecutionId)
      .find((item) => item.stepId === step.stepId);
    if (existing) return;
    this.#repository.createWorkflowCheckpoint(
      WorkflowCheckpointSchema.parse({
        checkpointId: randomUUID(),
        workflowExecutionId: execution.workflowExecutionId,
        stepId: step.stepId,
        kind: step.checkpoint,
        status: 'PENDING',
        reason: `${step.checkpoint} checkpoint required before "${step.title}".`,
        createdAt: this.#timestamp(),
      }),
    );
  }

  #recordSyntheticAttempt(
    execution: WorkflowExecution,
    step: WorkflowStep,
    status: 'SKIPPED' | 'CANCELLED',
    detail: string,
  ): void {
    const timestamp = this.#timestamp();
    this.#repository.upsertWorkflowStepAttempt(
      WorkflowStepAttemptSchema.parse({
        stepAttemptId: randomUUID(),
        workflowExecutionId: execution.workflowExecutionId,
        stepId: step.stepId,
        attempt: 1,
        status,
        idempotencyKey: `${execution.workflowExecutionId}:${step.stepId}`,
        input: step.input,
        sanitizedError: detail,
        startedAt: timestamp,
        completedAt: timestamp,
      }),
    );
    this.#syncMissionStep(execution.missionId, step, status, timestamp, timestamp, detail);
  }

  async #pauseAtBoundary(active: ActiveRun): Promise<void> {
    active.pauseRequested = true;
    const execution = this.#repository.getWorkflowExecution(active.executionId);
    if (execution) {
      this.#repository.updateWorkflowExecution(
        WorkflowExecutionSchema.parse({
          ...execution,
          pauseRequested: true,
          updatedAt: this.#timestamp(),
        }),
      );
    }
    if (active.activeBatch === 0) {
      if (execution) this.#markExecutionWaiting(execution, true);
      return;
    }
    await new Promise<void>((resolve) => active.boundaryWaiters.push(resolve));
  }

  #cancelActive(active: ActiveRun, reason: string): Promise<void> {
    active.controller.abort(reason);
    const execution = this.#repository.getWorkflowExecution(active.executionId);
    if (execution) this.#markExecutionCancelled(execution, reason);
    this.#resolveBoundary(active);
    return Promise.resolve();
  }

  #markExecutionWaiting(execution: WorkflowExecution, paused: boolean): void {
    this.#repository.updateWorkflowExecution(
      WorkflowExecutionSchema.parse({
        ...execution,
        status: 'WAITING',
        pauseRequested: paused,
        updatedAt: this.#timestamp(),
      }),
    );
  }

  #markExecutionCancelled(execution: WorkflowExecution, reason: string): void {
    this.#repository.updateWorkflowExecution(
      WorkflowExecutionSchema.parse({
        ...execution,
        status: 'CANCELLED',
        cancelRequested: true,
        failureReason: reason,
        updatedAt: this.#timestamp(),
        endedAt: this.#timestamp(),
      }),
    );
    this.#emit('workflow.cancelled', execution.missionId, {
      workflowExecutionId: execution.workflowExecutionId,
      reason,
    });
  }

  #resolveBoundary(active: ActiveRun): void {
    if (active.activeBatch > 0) return;
    for (const resolve of active.boundaryWaiters.splice(0)) resolve();
  }

  #syncMissionStep(
    missionId: string,
    step: WorkflowStep,
    status: WorkflowStepStatus,
    startedAt?: string,
    completedAt?: string,
    sanitizedFailure?: string,
  ): void {
    this.#missions.upsertStep(missionId, {
      stepId: step.stepId,
      position: this.#requiredPlan(missionId).steps.findIndex(
        (candidate) => candidate.stepId === step.stepId,
      ),
      title: step.title,
      required: step.condition === undefined,
      status: status === 'WAITING' ? 'PENDING' : status,
      agent: 'Workflow Engine',
      skills: [step.skillId],
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(sanitizedFailure ? { sanitizedError: sanitizedFailure } : {}),
    });
  }

  #requiredPlan(missionId: string): WorkflowPlan {
    const plan = this.#repository.getActiveWorkflowPlan(missionId);
    if (!plan)
      throw workflowError('WORKFLOW_PLAN_NOT_FOUND', 'Active workflow plan was not found.');
    return plan;
  }

  #requiredExecution(missionId: string): WorkflowExecution {
    const execution = this.#repository.getLatestWorkflowExecution(missionId);
    if (!execution) throw workflowError('WORKFLOW_NOT_FOUND', 'Workflow execution was not found.');
    return execution;
  }

  #emit(type: string, missionId: string, payload: Readonly<Record<string, unknown>>): void {
    this.#recordEvent?.({ type, missionId, payload, occurredAt: this.#timestamp() });
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

class StepTimeoutError extends Error {
  constructor() {
    super('Workflow step exceeded its declared timeout.');
  }
}

async function executeWithTimeout(
  executor: WorkflowStepExecutor,
  input: Omit<Parameters<WorkflowStepExecutor['execute']>[0], 'signal'>,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<WorkflowStepResult> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', onParentAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort('STEP_TIMEOUT');
  }, timeoutMs);
  try {
    return await Promise.race([
      executor.execute({ ...input, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(timedOut ? new StepTimeoutError() : new Error('Workflow cancelled.')),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onParentAbort);
  }
}

function latestAttempts(
  attempts: readonly WorkflowStepAttempt[],
): Map<string, WorkflowStepAttempt> {
  const result = new Map<string, WorkflowStepAttempt>();
  for (const attempt of attempts) {
    const current = result.get(attempt.stepId);
    if (!current || attempt.attempt >= current.attempt) result.set(attempt.stepId, attempt);
  }
  return result;
}

function evaluateCondition(step: WorkflowStep, attempts: readonly WorkflowStepAttempt[]): boolean {
  if (!step.condition) return true;
  const source = latestAttempts(attempts).get(step.condition.sourceStepId)?.output;
  const value = readPath(source, step.condition.path);
  switch (step.condition.operator) {
    case 'equals':
      return Object.is(value, step.condition.value);
    case 'not_equals':
      return !Object.is(value, step.condition.value);
    case 'exists':
      return value !== undefined;
    case 'not_exists':
      return value === undefined;
  }
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveArtifactReferences(
  value: unknown,
  artifacts: ReadonlyMap<string, unknown>,
): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveArtifactReferences(item, artifacts));
  if (typeof value !== 'object' || value === null) return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1 && typeof object.$artifact === 'string') {
    if (!artifacts.has(object.$artifact)) {
      throw workflowError(
        'WORKFLOW_ARTIFACT_UNAVAILABLE',
        `Required artifact "${object.$artifact}" is not available.`,
      );
    }
    return artifacts.get(object.$artifact);
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, resolveArtifactReferences(item, artifacts)]),
  );
}

function requiredDetail(detail: WorkflowDetail | undefined): WorkflowDetail {
  if (!detail) throw workflowError('WORKFLOW_NOT_FOUND', 'Workflow was not found.');
  return detail;
}

function pauseRequested(active: ActiveRun): boolean {
  return active.pauseRequested;
}

function signalWasAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isShutdownAbort(signal: AbortSignal): boolean {
  return signalWasAborted(signal) && signal.reason === 'Jupiter is shutting down.';
}

function sanitizedError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : 'Workflow step failed without a structured error.';
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Workflow cancelled.'));
      },
      { once: true },
    );
  });
}

function workflowError(code: string, message: string): JupiterError {
  return new JupiterError({
    code,
    category: 'validation',
    message,
    recoverable: true,
    retryable: false,
    userAction: 'Open Mission details and choose an action allowed by the current workflow state.',
  });
}
