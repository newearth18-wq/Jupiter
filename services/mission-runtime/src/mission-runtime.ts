import { randomUUID } from 'node:crypto';
import {
  MissionCreateInputSchema,
  MissionDetailSchema,
  MissionErrorSchema,
  MissionSchema,
  MissionStepSchema,
  MissionTransitionInputSchema,
  MissionTransitionSchema,
  MissionVerificationSchema,
  type Mission,
  type MissionControlInput,
  type MissionCreateInput,
  type MissionDetail,
  type MissionErrorInput,
  type MissionExecution,
  type MissionPlanSnapshot,
  type MissionStatus,
  type MissionStepUpsertInput,
  type MissionTimelineEntry,
  type MissionTransitionInput,
  type MissionVerificationInput,
} from '@jupiter/contracts';
import {
  JupiterError,
  type MissionChildRuntime,
  type MissionRepository,
  type MissionRuntime,
} from '@jupiter/core';

const TERMINAL = new Set<MissionStatus>(['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED']);

export const ALLOWED_MISSION_TRANSITIONS: Readonly<
  Record<MissionStatus, readonly MissionStatus[]>
> = {
  CREATED: ['ANALYZING', 'CANCELLED'],
  ANALYZING: ['PLANNING', 'FAILED', 'CANCELLED'],
  PLANNING: ['WAITING_APPROVAL', 'WAITING_IDENTITY', 'READY', 'FAILED', 'CANCELLED'],
  WAITING_APPROVAL: ['READY', 'RUNNING', 'FAILED', 'CANCELLED'],
  WAITING_IDENTITY: ['READY', 'RUNNING', 'FAILED', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: [
    'WAITING_APPROVAL',
    'WAITING_IDENTITY',
    'PAUSED',
    'VERIFYING',
    'PARTIAL_SUCCESS',
    'FAILED',
    'CANCELLED',
  ],
  PAUSED: ['RUNNING', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  PARTIAL_SUCCESS: ['READY'],
  FAILED: ['READY'],
  CANCELLED: ['READY'],
};

type ActiveWork = {
  controller: AbortController;
  child: MissionChildRuntime;
};

export type MissionRuntimeDependencies = {
  repository: MissionRepository;
  now?: () => Date;
  recordEvent?: (event: {
    type: string;
    missionId: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: string;
  }) => void;
};

export class DurableMissionRuntime implements MissionRuntime {
  readonly #repository: MissionRepository;
  readonly #now: () => Date;
  readonly #recordEvent: MissionRuntimeDependencies['recordEvent'];
  readonly #active = new Map<string, Set<ActiveWork>>();

  constructor(dependencies: MissionRuntimeDependencies) {
    this.#repository = dependencies.repository;
    this.#now = dependencies.now ?? (() => new Date());
    this.#recordEvent = dependencies.recordEvent;
  }

  listMissions(includeArchived = false): Mission[] {
    return this.#repository.listMissions(includeArchived);
  }

  getMissionDetail(missionId: string): MissionDetail {
    const mission = this.#requiredMission(missionId);
    const executions = this.#repository.listMissionExecutions(missionId);
    const transitions = this.#repository.listMissionTransitions(missionId);
    const steps = this.#repository.listMissionSteps(missionId);
    const permissions = this.#repository.listMissionPermissions(missionId);
    const artifacts = this.#repository.listMissionArtifacts(missionId);
    const errors = this.#repository.listMissionErrors(missionId);
    const verificationResults = this.#repository.listMissionVerifications(missionId);
    return MissionDetailSchema.parse({
      mission,
      executions,
      transitions,
      steps,
      permissions,
      artifacts,
      errors,
      verificationResults,
      timeline: buildTimeline({
        executions,
        transitions,
        steps,
        artifacts,
        errors,
        verificationResults,
      }),
    });
  }

  createMission(input: MissionCreateInput): MissionDetail {
    const valid = MissionCreateInputSchema.parse(input);
    const timestamp = this.#timestamp();
    const missionId = randomUUID();
    const executionId = randomUUID();
    const mission = MissionSchema.parse({
      missionId,
      title: valid.title ?? deriveTitle(valid.userRequest),
      userRequest: valid.userRequest,
      status: 'CREATED',
      priority: valid.priority,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const execution: MissionExecution = {
      executionId,
      missionId,
      attempt: 1,
      status: 'CREATED',
      startedAt: timestamp,
    };
    const transition = MissionTransitionSchema.parse({
      transitionId: randomUUID(),
      missionId,
      executionId,
      fromStatus: null,
      toStatus: 'CREATED',
      accepted: true,
      reason: 'Mission created from an actionable user request.',
      occurredAt: timestamp,
    });
    this.#repository.transaction(() => {
      this.#repository.createMission(mission);
      this.#repository.createMissionExecution(execution);
      this.#repository.appendMissionTransition(transition);
    });
    this.#emit('mission.created', missionId, { status: 'CREATED', priority: mission.priority });
    return this.getMissionDetail(missionId);
  }

  async pauseMission(input: MissionControlInput, signal: AbortSignal): Promise<MissionDetail> {
    const mission = this.#requiredMission(input.missionId);
    if (mission.status !== 'RUNNING') {
      return this.#rejectTransition(mission, 'PAUSED', 'Only a running Mission can be paused.');
    }
    for (const active of this.#active.get(mission.missionId) ?? []) {
      await active.child.pauseAtSafeBoundary(signal);
    }
    return this.transitionMission({
      missionId: mission.missionId,
      toStatus: 'PAUSED',
      reason: input.reason ?? 'Paused at a safe execution boundary by the user.',
    });
  }

  resumeMission(input: MissionControlInput): MissionDetail {
    return this.transitionMission({
      missionId: input.missionId,
      toStatus: 'RUNNING',
      reason: input.reason ?? 'Execution resumed by the user.',
    });
  }

  async cancelMission(input: MissionControlInput): Promise<MissionDetail> {
    const mission = this.#requiredMission(input.missionId);
    if (TERMINAL.has(mission.status)) {
      return this.#rejectTransition(
        mission,
        'CANCELLED',
        'A terminal Mission cannot be cancelled.',
      );
    }
    const reason = input.reason ?? 'Cancelled by the user.';
    const activeWork = [...(this.#active.get(mission.missionId) ?? [])];
    for (const active of activeWork) active.controller.abort(reason);
    await Promise.all(activeWork.map((active) => active.child.cancel(reason)));
    this.#active.delete(mission.missionId);
    return this.transitionMission({ missionId: mission.missionId, toStatus: 'CANCELLED', reason });
  }

  retryMission(input: MissionControlInput): MissionDetail {
    const mission = this.#requiredMission(input.missionId);
    if (!['FAILED', 'PARTIAL_SUCCESS', 'CANCELLED'].includes(mission.status)) {
      return this.#rejectTransition(
        mission,
        'READY',
        'Only an incomplete terminal Mission can be retried.',
      );
    }
    const executions = this.#repository.listMissionExecutions(mission.missionId);
    const prior = executions.at(-1);
    if (!prior) throw missionError('MISSION_EXECUTION_MISSING');
    const timestamp = this.#timestamp();
    const execution: MissionExecution = {
      executionId: randomUUID(),
      missionId: mission.missionId,
      attempt: prior.attempt + 1,
      priorExecutionId: prior.executionId,
      status: 'READY',
      startedAt: timestamp,
    };
    const missionForRetry = { ...mission };
    delete missionForRetry.currentStepId;
    const updated = MissionSchema.parse({
      ...missionForRetry,
      status: 'READY',
      updatedAt: timestamp,
    });
    const transition = MissionTransitionSchema.parse({
      transitionId: randomUUID(),
      missionId: mission.missionId,
      executionId: execution.executionId,
      fromStatus: mission.status,
      toStatus: 'READY',
      accepted: true,
      reason: input.reason ?? `Retry attempt ${execution.attempt.toString()} created.`,
      occurredAt: timestamp,
    });
    this.#repository.transaction(() => {
      this.#repository.createMissionExecution(execution);
      this.#repository.updateMission(updated);
      this.#repository.appendMissionTransition(transition);
    });
    this.#emit('mission.retried', mission.missionId, {
      executionId: execution.executionId,
      priorExecutionId: prior.executionId,
      attempt: execution.attempt,
    });
    return this.getMissionDetail(mission.missionId);
  }

  archiveMission(missionId: string): MissionDetail {
    const mission = this.#requiredMission(missionId);
    if (!TERMINAL.has(mission.status)) {
      throw new JupiterError({
        code: 'MISSION_ARCHIVE_UNSAFE',
        category: 'validation',
        message: 'Only a terminal Mission can be archived.',
        recoverable: true,
        retryable: false,
        userAction: 'Complete or cancel the Mission before archiving it.',
      });
    }
    const timestamp = this.#timestamp();
    this.#repository.updateMission(
      MissionSchema.parse({ ...mission, archivedAt: timestamp, updatedAt: timestamp }),
    );
    this.#emit('mission.archived', missionId, { status: mission.status });
    return this.getMissionDetail(missionId);
  }

  transitionMission(input: MissionTransitionInput): MissionDetail {
    const valid = MissionTransitionInputSchema.parse(input);
    const mission = this.#requiredMission(valid.missionId);
    const allowed = ALLOWED_MISSION_TRANSITIONS[mission.status].includes(valid.toStatus);
    if (!allowed) {
      return this.#rejectTransition(
        mission,
        valid.toStatus,
        `Transition ${mission.status} -> ${valid.toStatus} is not allowed.`,
      );
    }
    const guardFailure = this.#completionGuard(mission.missionId, valid.toStatus);
    if (guardFailure) return this.#rejectTransition(mission, valid.toStatus, guardFailure);
    const executions = this.#repository.listMissionExecutions(mission.missionId);
    const execution = executions.at(-1);
    if (!execution) throw missionError('MISSION_EXECUTION_MISSING');
    const timestamp = this.#timestamp();
    const updatedMission = MissionSchema.parse({
      ...mission,
      status: valid.toStatus,
      updatedAt: timestamp,
    });
    const updatedExecution: MissionExecution = {
      ...execution,
      status: valid.toStatus,
      ...(TERMINAL.has(valid.toStatus) ? { endedAt: timestamp } : {}),
    };
    const transition = MissionTransitionSchema.parse({
      transitionId: randomUUID(),
      missionId: mission.missionId,
      executionId: execution.executionId,
      fromStatus: mission.status,
      toStatus: valid.toStatus,
      accepted: true,
      reason: valid.reason,
      occurredAt: timestamp,
    });
    this.#repository.transaction(() => {
      this.#repository.updateMission(updatedMission);
      this.#repository.updateMissionExecution(updatedExecution);
      this.#repository.appendMissionTransition(transition);
    });
    this.#emit('mission.transitioned', mission.missionId, {
      fromStatus: mission.status,
      toStatus: valid.toStatus,
      executionId: execution.executionId,
    });
    return this.getMissionDetail(mission.missionId);
  }

  upsertStep(missionId: string, input: MissionStepUpsertInput): MissionDetail {
    const mission = this.#requiredMission(missionId);
    const execution = this.#currentExecution(missionId);
    const step = MissionStepSchema.parse({
      ...input,
      missionId,
      executionId: execution.executionId,
    });
    this.#repository.upsertMissionStep(step);
    const missionUpdate = {
      ...mission,
      updatedAt: this.#timestamp(),
    };
    if (step.status === 'RUNNING') missionUpdate.currentStepId = step.stepId;
    else if (missionUpdate.currentStepId === step.stepId) delete missionUpdate.currentStepId;
    const updated = MissionSchema.parse(missionUpdate);
    this.#repository.updateMission(updated);
    return this.getMissionDetail(missionId);
  }

  recordVerification(missionId: string, input: MissionVerificationInput): MissionDetail {
    this.#requiredMission(missionId);
    const execution = this.#currentExecution(missionId);
    this.#repository.addMissionVerification(
      MissionVerificationSchema.parse({
        ...input,
        verificationId: randomUUID(),
        missionId,
        executionId: execution.executionId,
        verifiedAt: this.#timestamp(),
      }),
    );
    return this.getMissionDetail(missionId);
  }

  recordError(missionId: string, input: MissionErrorInput): MissionDetail {
    this.#requiredMission(missionId);
    const execution = this.#currentExecution(missionId);
    this.#repository.addMissionError(
      MissionErrorSchema.parse({
        ...input,
        missionErrorId: randomUUID(),
        missionId,
        executionId: execution.executionId,
        occurredAt: this.#timestamp(),
      }),
    );
    return this.getMissionDetail(missionId);
  }

  setPlanSnapshot(missionId: string, plan: MissionPlanSnapshot): MissionDetail {
    const mission = this.#requiredMission(missionId);
    this.#repository.updateMission(
      MissionSchema.parse({ ...mission, plan, updatedAt: this.#timestamp() }),
    );
    return this.getMissionDetail(missionId);
  }

  attachChildRuntime(
    missionId: string,
    controller: AbortController,
    child: MissionChildRuntime,
  ): () => void {
    this.#requiredMission(missionId);
    const work = { controller, child };
    const active = this.#active.get(missionId) ?? new Set<ActiveWork>();
    active.add(work);
    this.#active.set(missionId, active);
    return () => {
      active.delete(work);
      if (active.size === 0) this.#active.delete(missionId);
    };
  }

  async shutdown(): Promise<void> {
    const cancellations: Promise<void>[] = [];
    for (const activeSet of this.#active.values()) {
      for (const active of activeSet) {
        active.controller.abort('Jupiter is shutting down.');
        cancellations.push(active.child.cancel('Jupiter is shutting down.'));
      }
    }
    this.#active.clear();
    await Promise.all(cancellations);
  }

  #completionGuard(missionId: string, toStatus: MissionStatus): string | undefined {
    const execution = this.#currentExecution(missionId);
    const steps = this.#repository
      .listMissionSteps(missionId)
      .filter((step) => step.executionId === execution.executionId);
    if (toStatus === 'COMPLETED') {
      const verified = this.#repository
        .listMissionVerifications(missionId)
        .some(
          (verification) =>
            verification.executionId === execution.executionId && verification.passed,
        );
      if (!verified) return 'COMPLETED requires at least one successful verification.';
      if (steps.some((step) => step.required && step.status !== 'COMPLETED')) {
        return 'COMPLETED requires every required step to be resolved successfully.';
      }
    }
    if (toStatus === 'PARTIAL_SUCCESS') {
      const hasCompleted = steps.some((step) => step.status === 'COMPLETED');
      const hasIncompleteOutcome = steps.some((step) =>
        ['FAILED', 'SKIPPED', 'CANCELLED'].includes(step.status),
      );
      if (!hasCompleted || !hasIncompleteOutcome) {
        return 'PARTIAL_SUCCESS requires both completed and failed, skipped, or cancelled outcomes.';
      }
    }
    return undefined;
  }

  #rejectTransition(mission: Mission, toStatus: MissionStatus, reason: string): never {
    const execution = this.#currentExecution(mission.missionId);
    this.#repository.appendMissionTransition(
      MissionTransitionSchema.parse({
        transitionId: randomUUID(),
        missionId: mission.missionId,
        executionId: execution.executionId,
        fromStatus: mission.status,
        toStatus,
        accepted: false,
        reason,
        occurredAt: this.#timestamp(),
      }),
    );
    this.#emit('mission.transition.rejected', mission.missionId, {
      fromStatus: mission.status,
      toStatus,
      reason,
    });
    throw new JupiterError({
      code: 'MISSION_TRANSITION_INVALID',
      category: 'validation',
      message: reason,
      recoverable: true,
      retryable: false,
      userAction: 'Choose an action available for the current Mission status.',
    });
  }

  #requiredMission(missionId: string): Mission {
    const mission = this.#repository.getMission(missionId);
    if (!mission) throw missionError('MISSION_NOT_FOUND');
    return mission;
  }

  #currentExecution(missionId: string): MissionExecution {
    const execution = this.#repository.listMissionExecutions(missionId).at(-1);
    if (!execution) throw missionError('MISSION_EXECUTION_MISSING');
    return execution;
  }

  #emit(type: string, missionId: string, payload: Readonly<Record<string, unknown>>): void {
    this.#recordEvent?.({ type, missionId, payload, occurredAt: this.#timestamp() });
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function buildTimeline(input: {
  executions: MissionDetail['executions'];
  transitions: MissionDetail['transitions'];
  steps: MissionDetail['steps'];
  artifacts: MissionDetail['artifacts'];
  errors: MissionDetail['errors'];
  verificationResults: MissionDetail['verificationResults'];
}): MissionTimelineEntry[] {
  const entries: MissionTimelineEntry[] = [];
  for (const execution of input.executions) {
    entries.push({
      timelineId: `execution:${execution.executionId}:start`,
      occurredAt: execution.startedAt,
      type: 'execution',
      title: `Attempt ${execution.attempt.toString()} started`,
      ...(execution.priorExecutionId ? { detail: 'Linked retry attempt' } : {}),
      tone: 'neutral',
    });
  }
  for (const transition of input.transitions) {
    entries.push({
      timelineId: `transition:${transition.transitionId}`,
      occurredAt: transition.occurredAt,
      type: 'transition',
      title: transition.accepted
        ? `Status changed to ${transition.toStatus}`
        : `Rejected transition to ${transition.toStatus}`,
      detail: transition.reason,
      tone: transition.accepted
        ? transition.toStatus === 'COMPLETED'
          ? 'success'
          : TERMINAL.has(transition.toStatus)
            ? 'warning'
            : 'neutral'
        : 'error',
    });
  }
  for (const step of input.steps) {
    const occurredAt = step.completedAt ?? step.startedAt;
    if (!occurredAt) continue;
    entries.push({
      timelineId: `step:${step.stepId}:${step.status}`,
      occurredAt,
      type: 'step',
      title: `${step.title}: ${step.status}`,
      ...(step.sanitizedError ? { detail: step.sanitizedError } : {}),
      tone:
        step.status === 'COMPLETED'
          ? 'success'
          : ['FAILED', 'CANCELLED'].includes(step.status)
            ? 'error'
            : 'neutral',
    });
  }
  for (const verification of input.verificationResults) {
    entries.push({
      timelineId: `verification:${verification.verificationId}`,
      occurredAt: verification.verifiedAt,
      type: 'verification',
      title: `${verification.name}: ${verification.passed ? 'passed' : 'failed'}`,
      detail: verification.summary,
      tone: verification.passed ? 'success' : 'error',
    });
  }
  for (const error of input.errors) {
    entries.push({
      timelineId: `error:${error.missionErrorId}`,
      occurredAt: error.occurredAt,
      type: 'error',
      title: error.code,
      detail: error.message,
      tone: 'error',
    });
  }
  for (const artifact of input.artifacts) {
    entries.push({
      timelineId: `artifact:${artifact.missionArtifactId}`,
      occurredAt: artifact.createdAt,
      type: 'artifact',
      title: `${artifact.name}: ${artifact.status}`,
      tone: artifact.status === 'VERIFIED' ? 'success' : 'neutral',
    });
  }
  return entries.sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.timelineId.localeCompare(right.timelineId),
  );
}

function deriveTitle(userRequest: string): string {
  const oneLine = userRequest.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}…`;
}

function missionError(code: string): JupiterError {
  return new JupiterError({
    code,
    category: 'configuration',
    message:
      code === 'MISSION_NOT_FOUND' ? 'Mission was not found.' : 'Mission execution is missing.',
    recoverable: true,
    retryable: false,
    userAction: 'Refresh Missions and select an available record.',
  });
}
