import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowPlanDraft, WorkflowStep } from '@jupiter/contracts';
import type { WorkflowStepExecutor } from '@jupiter/core';
import { JupiterDatabase } from '@jupiter/database';
import { DurableMissionRuntime } from '@jupiter/mission-runtime';
import { DurableWorkflowRuntime } from './workflow-runtime.js';

const directories: string[] = [];
const databases: JupiterDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('DurableWorkflowRuntime', () => {
  it('orders dependencies and passes declared artifacts', async () => {
    const fixture = runtimeFixture([
      executor('test.read', () =>
        Promise.resolve({
          output: { selected: true },
          artifacts: { source: { title: 'Lesson' } },
          verificationPassed: true,
          verificationSummary: 'Source selected.',
        }),
      ),
      executor('test.write', ({ resolvedInput }) =>
        Promise.resolve({
          output: resolvedInput,
          artifacts: { presentation: { basedOn: resolvedInput.source } },
          verificationPassed: true,
          verificationSummary: 'Presentation created.',
        }),
      ),
    ]);
    const first = step('test.read', { producesArtifacts: ['source'] });
    const second = step('test.write', {
      dependencies: [first.stepId],
      input: { source: { $artifact: 'source' } },
      producesArtifacts: ['presentation'],
    });
    const missionId = createPlannedMission(
      fixture,
      plan([first, second], ['source', 'presentation']),
    );
    const detail = await fixture.workflows.startWorkflow({ missionId });
    expect(detail.execution?.status).toBe('COMPLETED');
    expect(detail.stepAttempts.map((attempt) => attempt.stepId)).toEqual([
      first.stepId,
      second.stepId,
    ]);
    expect(detail.artifacts.map((artifact) => artifact.artifactKey)).toEqual([
      'source',
      'presentation',
    ]);
    expect(fixture.missions.getMissionDetail(missionId).mission.status).toBe('COMPLETED');
    fixture.database.close();
  });

  it('executes independent dependency nodes in parallel', async () => {
    let active = 0;
    let maximum = 0;
    const parallel = executor('test.parallel', async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(30);
      active -= 1;
      return pass();
    });
    const fixture = runtimeFixture([parallel]);
    const missionId = createPlannedMission(
      fixture,
      plan([step('test.parallel'), step('test.parallel')]),
    );
    await fixture.workflows.startWorkflow({ missionId });
    expect(maximum).toBe(2);
    fixture.database.close();
  });

  it('pauses at a safe batch boundary, resumes, and cancels every active child', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let aborted = 0;
    const controlled = executor('test.controlled', async ({ signal }) => {
      started += 1;
      await Promise.race([
        gate,
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted += 1;
              reject(new Error('cancelled'));
            },
            { once: true },
          ),
        ),
      ]);
      return pass();
    });
    const fixture = runtimeFixture([controlled]);
    const missionId = createPlannedMission(
      fixture,
      plan([step('test.controlled'), step('test.controlled')]),
    );
    const running = fixture.workflows.startWorkflow({ missionId });
    await waitFor(() => started === 2);
    const pausing = fixture.missions.pauseMission({ missionId }, new AbortController().signal);
    release();
    await pausing;
    await running;
    expect(fixture.missions.getMissionDetail(missionId).mission.status).toBe('PAUSED');
    await fixture.workflows.resumeWorkflow({ missionId });
    expect(fixture.missions.getMissionDetail(missionId).mission.status).toBe('COMPLETED');

    const cancelling = executor('test.controlled', ({ signal }) => {
      started += 1;
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted += 1;
            reject(new Error('cancelled'));
          },
          { once: true },
        ),
      );
    });
    const cancelFixture = runtimeFixture([cancelling]);
    started = 0;
    aborted = 0;
    const cancelMissionId = createPlannedMission(
      cancelFixture,
      plan([step('test.controlled'), step('test.controlled')]),
    );
    const cancelRun = cancelFixture.workflows.startWorkflow({ missionId: cancelMissionId });
    await waitFor(() => started === 2);
    await cancelFixture.missions.cancelMission({ missionId: cancelMissionId });
    await cancelRun;
    expect(aborted).toBe(2);
    expect(cancelFixture.workflows.getWorkflow(cancelMissionId)?.execution?.status).toBe(
      'CANCELLED',
    );
    fixture.database.close();
    cancelFixture.database.close();
  });

  it('waits for an approval checkpoint and skips a false conditional branch', async () => {
    const fixture = runtimeFixture([
      executor('test.decide', () =>
        Promise.resolve({
          output: { continue: false },
          verificationPassed: true,
          verificationSummary: 'Decision recorded.',
        }),
      ),
      executor('test.branch', () => Promise.resolve(pass())),
    ]);
    const decision = step('test.decide', { checkpoint: 'APPROVAL' });
    const branch = step('test.branch', {
      dependencies: [decision.stepId],
      condition: {
        sourceStepId: decision.stepId,
        path: 'continue',
        operator: 'equals',
        value: true,
      },
    });
    const missionId = createPlannedMission(fixture, plan([decision, branch]));
    const waiting = await fixture.workflows.startWorkflow({ missionId });
    expect(waiting.execution?.status).toBe('WAITING');
    expect(fixture.missions.getMissionDetail(missionId).mission.status).toBe('WAITING_APPROVAL');
    const checkpoint = waiting.checkpoints[0];
    expect(checkpoint?.status).toBe('PENDING');
    if (!checkpoint) throw new Error('Expected approval checkpoint.');

    const completed = await fixture.workflows.resolveCheckpoint({
      checkpointId: checkpoint.checkpointId,
      decision: 'APPROVED',
      reason: 'Approved by test authority.',
    });
    expect(completed.execution?.status).toBe('COMPLETED');
    expect(completed.stepAttempts.find((item) => item.stepId === branch.stepId)?.status).toBe(
      'SKIPPED',
    );
    fixture.database.close();
  });

  it('enforces timeout and bounded retry with a stable idempotency key', async () => {
    const timeoutFixture = runtimeFixture([
      executor(
        'test.timeout',
        ({ signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true }),
          ),
      ),
    ]);
    const timeoutStep = step('test.timeout', { timeoutMs: 100 });
    const timeoutMission = createPlannedMission(timeoutFixture, plan([timeoutStep]));
    const timeoutDetail = await timeoutFixture.workflows.startWorkflow({
      missionId: timeoutMission,
    });
    expect(timeoutDetail.execution?.status).toBe('FAILED');
    expect(timeoutDetail.stepAttempts[0]?.sanitizedError).toContain('timed out');

    let calls = 0;
    const keys: string[] = [];
    const retryFixture = runtimeFixture([
      executor('test.retry', ({ idempotencyKey }) => {
        calls += 1;
        keys.push(idempotencyKey);
        if (calls === 1) throw new Error('transient');
        return Promise.resolve(pass());
      }),
    ]);
    const retryStep = step('test.retry', {
      retryPolicy: { maxAttempts: 2, initialBackoffMs: 1, backoffMultiplier: 1 },
    });
    const retryMission = createPlannedMission(retryFixture, plan([retryStep]));
    const retryDetail = await retryFixture.workflows.startWorkflow({ missionId: retryMission });
    expect(retryDetail.execution?.status).toBe('COMPLETED');
    expect(retryDetail.stepAttempts).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    timeoutFixture.database.close();
    retryFixture.database.close();
  });

  it('creates a versioned re-plan while preserving failed history', async () => {
    const fixture = runtimeFixture([
      executor('test.fail', () => Promise.reject(new Error('planned failure'))),
      executor('test.recover', () => Promise.resolve(pass())),
    ]);
    const missionId = createPlannedMission(fixture, plan([step('test.fail')]));
    await fixture.workflows.startWorkflow({ missionId });
    expect(fixture.missions.getMissionDetail(missionId).mission.status).toBe('FAILED');
    const revised = fixture.workflows.replanWorkflow({
      missionId,
      modelOutput: plan([step('test.recover')]),
      reason: 'Replace the unavailable operation.',
    });
    expect(revised.plan.revision).toBe(2);
    expect(revised.plan.priorPlanId).toBeTruthy();
    expect(fixture.database.listWorkflowPlans(missionId)).toHaveLength(2);
    expect(fixture.missions.getMissionDetail(missionId).executions).toHaveLength(2);
    fixture.database.close();
  });

  it('runs best-effort compensation for completed steps after a later failure', async () => {
    let compensated = 0;
    const createExecutor = executor('test.create', () =>
      Promise.resolve({
        output: { created: true },
        verificationPassed: true,
        verificationSummary: 'Created.',
      }),
    );
    createExecutor.compensate = () => {
      compensated += 1;
      return Promise.resolve();
    };
    const fixture = runtimeFixture([
      createExecutor,
      executor('test.fail', () => Promise.reject(new Error('later failure'))),
    ]);
    const created = step('test.create');
    const failed = step('test.fail', { dependencies: [created.stepId] });
    const missionId = createPlannedMission(fixture, plan([created, failed]));
    const detail = await fixture.workflows.startWorkflow({ missionId });
    expect(detail.execution?.status).toBe('FAILED');
    expect(compensated).toBe(1);
    fixture.database.close();
  });

  it('recovers a running attempt after database reopen with the same idempotency key', async () => {
    const directory = tempDirectory();
    const path = join(directory, 'jupiter.db');
    const database = JupiterDatabase.open(path);
    databases.push(database);
    const missions = new DurableMissionRuntime({ repository: database });
    let firstKey = '';
    const first = new DurableWorkflowRuntime({
      repository: database,
      missionRuntime: missions,
      executors: [
        executor('test.recover', ({ idempotencyKey, signal }) => {
          firstKey = idempotencyKey;
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('shutdown')), { once: true }),
          );
        }),
      ],
    });
    const missionId = missions.createMission({ userRequest: 'Recover durable workflow' }).mission
      .missionId;
    first.createPlan(missionId, plan([step('test.recover')]));
    const running = first.startWorkflow({ missionId });
    await waitFor(() => firstKey.length > 0);
    await first.shutdown();
    await running;
    database.close();

    const reopened = JupiterDatabase.open(path);
    databases.push(reopened);
    const reopenedMissions = new DurableMissionRuntime({ repository: reopened });
    let recoveredKey = '';
    const recovered = new DurableWorkflowRuntime({
      repository: reopened,
      missionRuntime: reopenedMissions,
      executors: [
        executor('test.recover', ({ idempotencyKey }) => {
          recoveredKey = idempotencyKey;
          return Promise.resolve(pass());
        }),
      ],
    });
    await recovered.recover();
    expect(recoveredKey).toBe(firstKey);
    expect(recovered.getWorkflow(missionId)?.execution?.status).toBe('COMPLETED');
    expect(reopenedMissions.getMissionDetail(missionId).mission.status).toBe('COMPLETED');
    reopened.close();
  });
});

function runtimeFixture(executors: WorkflowStepExecutor[]) {
  const directory = tempDirectory();
  const database = JupiterDatabase.open(join(directory, 'jupiter.db'));
  databases.push(database);
  const missions = new DurableMissionRuntime({ repository: database });
  const workflows = new DurableWorkflowRuntime({
    repository: database,
    missionRuntime: missions,
    executors,
    sleep: () => Promise.resolve(),
  });
  return { database, missions, workflows };
}

function createPlannedMission(
  fixture: ReturnType<typeof runtimeFixture>,
  draft: WorkflowPlanDraft,
): string {
  const missionId = fixture.missions.createMission({ userRequest: draft.goal }).mission.missionId;
  fixture.workflows.createPlan(missionId, draft);
  return missionId;
}

function step(skillId: string, update: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    stepId: randomUUID(),
    title: skillId,
    description: `Execute ${skillId}.`,
    skillId,
    dependencies: [],
    input: {},
    timeoutMs: 1_000,
    retryPolicy: { maxAttempts: 1, initialBackoffMs: 0, backoffMultiplier: 1 },
    verification: { required: true, strategy: 'Check executor result.' },
    status: 'PENDING',
    requiredPermissions: [],
    producesArtifacts: [],
    checkpoint: 'NONE',
    ...update,
  };
}

function plan(steps: WorkflowStep[], artifacts: string[] = []): WorkflowPlanDraft {
  return {
    goal: 'Execute a durable validated workflow.',
    assumptions: ['The declared test executors are available.'],
    steps,
    requiredSkills: [...new Set(steps.map((item) => item.skillId))],
    requiredPermissions: [],
    expectedArtifacts: artifacts.map((artifactKey) => ({
      artifactKey,
      kind: 'test',
      required: true,
    })),
    verificationPlan: { summary: 'All workflow checks passed.', checks: ['Steps pass.'] },
    rationale: 'The plan uses the smallest explicit dependency graph.',
  };
}

function executor(skillId: string, run: WorkflowStepExecutor['execute']): WorkflowStepExecutor {
  return { skillId, execute: run };
}

function pass() {
  return {
    verificationPassed: true,
    verificationSummary: 'Passed.',
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jupiter-workflow-'));
  directories.push(directory);
  return directory;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) throw new Error('Timed out waiting for test state.');
    await delay(5);
  }
}
