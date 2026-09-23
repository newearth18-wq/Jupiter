import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JupiterDatabase } from '@jupiter/database';
import { DurableMissionRuntime } from './mission-runtime.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DurableMissionRuntime', () => {
  it('creates a Mission and reconstructs its timeline after restart', () => {
    const { database, path } = databaseFixture();
    const runtime = new DurableMissionRuntime({ repository: database, now: clock() });
    const created = runtime.createMission({ userRequest: 'Prepare the verified report' });
    runtime.transitionMission({
      missionId: created.mission.missionId,
      toStatus: 'ANALYZING',
      reason: 'Analysis began.',
    });
    const timelineBefore = runtime
      .getMissionDetail(created.mission.missionId)
      .timeline.map((entry) => entry.title);
    database.close();

    const reopened = JupiterDatabase.open(path);
    const restored = new DurableMissionRuntime({ repository: reopened }).getMissionDetail(
      created.mission.missionId,
    );
    expect(restored.mission.userRequest).toBe('Prepare the verified report');
    expect(restored.timeline.map((entry) => entry.title)).toEqual(timelineBefore);
    reopened.close();
  });

  it('accepts valid transitions and audits an invalid transition without changing state', () => {
    const { database } = databaseFixture();
    const runtime = new DurableMissionRuntime({ repository: database });
    const missionId = runtime.createMission({ userRequest: 'Transition fixture' }).mission
      .missionId;
    expect(
      runtime.transitionMission({ missionId, toStatus: 'ANALYZING', reason: 'Begin.' }).mission
        .status,
    ).toBe('ANALYZING');
    expect(() =>
      runtime.transitionMission({ missionId, toStatus: 'COMPLETED', reason: 'Invalid jump.' }),
    ).toThrow('Transition ANALYZING -> COMPLETED is not allowed.');
    const detail = runtime.getMissionDetail(missionId);
    expect(detail.mission.status).toBe('ANALYZING');
    expect(detail.transitions.at(-1)).toMatchObject({
      accepted: false,
      fromStatus: 'ANALYZING',
      toStatus: 'COMPLETED',
    });
    database.close();
  });

  it.each(['WAITING_APPROVAL', 'WAITING_IDENTITY'] as const)(
    'accepts the %s waiting branch and returns to READY',
    (waitingStatus) => {
      const { database } = databaseFixture();
      const runtime = new DurableMissionRuntime({ repository: database });
      const missionId = runtime.createMission({ userRequest: `${waitingStatus} fixture` }).mission
        .missionId;
      runtime.transitionMission({ missionId, toStatus: 'ANALYZING', reason: 'Analyze.' });
      runtime.transitionMission({ missionId, toStatus: 'PLANNING', reason: 'Plan.' });
      runtime.transitionMission({ missionId, toStatus: waitingStatus, reason: 'Wait.' });
      expect(
        runtime.transitionMission({ missionId, toStatus: 'READY', reason: 'Resolved.' }).mission
          .status,
      ).toBe('READY');
      database.close();
    },
  );

  it('pauses at a child safe boundary, resumes, and propagates cancellation', async () => {
    const { database } = databaseFixture();
    const runtime = new DurableMissionRuntime({ repository: database });
    const missionId = runtime.createMission({ userRequest: 'Controlled work' }).mission.missionId;
    advanceToRunning(runtime, missionId);
    const controller = new AbortController();
    let pauses = 0;
    let cancellations = 0;
    runtime.attachChildRuntime(missionId, controller, {
      pauseAtSafeBoundary: () => {
        pauses += 1;
        return Promise.resolve();
      },
      cancel: () => {
        cancellations += 1;
        return Promise.resolve();
      },
    });
    expect(
      (await runtime.pauseMission({ missionId }, new AbortController().signal)).mission.status,
    ).toBe('PAUSED');
    expect(pauses).toBe(1);
    expect(runtime.resumeMission({ missionId }).mission.status).toBe('RUNNING');
    expect((await runtime.cancelMission({ missionId })).mission.status).toBe('CANCELLED');
    expect(controller.signal.aborted).toBe(true);
    expect(cancellations).toBe(1);
    database.close();
  });

  it('creates a linked retry attempt without erasing failed history', () => {
    const { database } = databaseFixture();
    const runtime = new DurableMissionRuntime({ repository: database });
    const missionId = runtime.createMission({ userRequest: 'Retry fixture' }).mission.missionId;
    runtime.transitionMission({ missionId, toStatus: 'ANALYZING', reason: 'Begin.' });
    runtime.transitionMission({ missionId, toStatus: 'FAILED', reason: 'Dependency failed.' });
    const retried = runtime.retryMission({ missionId });
    expect(retried.mission.status).toBe('READY');
    expect(retried.executions).toHaveLength(2);
    expect(retried.executions[0]).toMatchObject({ attempt: 1, status: 'FAILED' });
    expect(retried.executions[1]).toMatchObject({
      attempt: 2,
      priorExecutionId: retried.executions[0]?.executionId,
      status: 'READY',
    });
    database.close();
  });

  it('evaluates completion only against the current linked retry attempt', () => {
    const { database } = databaseFixture();
    const runtime = new DurableMissionRuntime({ repository: database });
    const missionId = runtime.createMission({ userRequest: 'Retry isolation fixture' }).mission
      .missionId;
    advanceToRunning(runtime, missionId);
    runtime.upsertStep(missionId, {
      stepId: randomUUID(),
      position: 0,
      title: 'Old completed part',
      required: true,
      status: 'COMPLETED',
      skills: [],
      completedAt: new Date().toISOString(),
    });
    runtime.upsertStep(missionId, {
      stepId: randomUUID(),
      position: 1,
      title: 'Old failed part',
      required: true,
      status: 'FAILED',
      skills: [],
      completedAt: new Date().toISOString(),
      sanitizedError: 'Old attempt failure.',
    });
    runtime.recordVerification(missionId, {
      name: 'Old attempt check',
      passed: true,
      summary: 'This verification belongs only to attempt one.',
    });
    runtime.transitionMission({ missionId, toStatus: 'PARTIAL_SUCCESS', reason: 'Retry needed.' });
    runtime.retryMission({ missionId });
    runtime.transitionMission({ missionId, toStatus: 'RUNNING', reason: 'Retry started.' });
    runtime.upsertStep(missionId, {
      stepId: randomUUID(),
      position: 0,
      title: 'Retry output',
      required: true,
      status: 'COMPLETED',
      skills: [],
      completedAt: new Date().toISOString(),
    });
    runtime.transitionMission({ missionId, toStatus: 'VERIFYING', reason: 'Verify retry.' });
    expect(() =>
      runtime.transitionMission({ missionId, toStatus: 'COMPLETED', reason: 'Not yet verified.' }),
    ).toThrow('COMPLETED requires at least one successful verification.');
    runtime.recordVerification(missionId, {
      name: 'Retry check',
      passed: true,
      summary: 'The retry output passed.',
    });
    expect(
      runtime.transitionMission({ missionId, toStatus: 'COMPLETED', reason: 'Retry verified.' })
        .mission.status,
    ).toBe('COMPLETED');
    database.close();
  });

  it('requires successful verification and resolved required steps before COMPLETED', () => {
    const { database } = databaseFixture();
    const runtime = new DurableMissionRuntime({ repository: database });
    const missionId = runtime.createMission({ userRequest: 'Verified completion' }).mission
      .missionId;
    advanceToRunning(runtime, missionId);
    runtime.upsertStep(missionId, {
      stepId: randomUUID(),
      position: 0,
      title: 'Create output',
      required: true,
      status: 'COMPLETED',
      skills: [],
      completedAt: new Date().toISOString(),
    });
    runtime.transitionMission({ missionId, toStatus: 'VERIFYING', reason: 'Verify output.' });
    expect(() =>
      runtime.transitionMission({ missionId, toStatus: 'COMPLETED', reason: 'Done.' }),
    ).toThrow('COMPLETED requires at least one successful verification.');
    runtime.recordVerification(missionId, {
      name: 'Output check',
      passed: true,
      summary: 'Expected output exists and passed validation.',
    });
    const pendingStepId = randomUUID();
    runtime.upsertStep(missionId, {
      stepId: pendingStepId,
      position: 1,
      title: 'Required finalization',
      required: true,
      status: 'PENDING',
      skills: [],
    });
    expect(() =>
      runtime.transitionMission({ missionId, toStatus: 'COMPLETED', reason: 'Still incomplete.' }),
    ).toThrow('COMPLETED requires every required step to be resolved successfully.');
    runtime.upsertStep(missionId, {
      stepId: pendingStepId,
      position: 1,
      title: 'Required finalization',
      required: true,
      status: 'COMPLETED',
      skills: [],
      completedAt: new Date().toISOString(),
    });
    const completed = runtime.transitionMission({
      missionId,
      toStatus: 'COMPLETED',
      reason: 'Verified successfully.',
    });
    expect(completed.mission.status).toBe('COMPLETED');
    expect(completed.verificationResults.some((result) => result.passed)).toBe(true);
    database.close();
  });

  it('archives only terminal Missions and excludes them from the default list', async () => {
    const { database } = databaseFixture();
    const runtime = new DurableMissionRuntime({ repository: database });
    const missionId = runtime.createMission({ userRequest: 'Archive fixture' }).mission.missionId;
    expect(() => runtime.archiveMission(missionId)).toThrow(
      'Only a terminal Mission can be archived.',
    );
    await runtime.cancelMission({ missionId });
    const archived = runtime.archiveMission(missionId);
    expect(archived.mission.archivedAt).toBeTruthy();
    expect(runtime.listMissions()).toHaveLength(0);
    expect(runtime.listMissions(true)).toHaveLength(1);
    database.close();
  });

  it('requires and exposes both complete and incomplete outcomes for partial success', () => {
    const { database } = databaseFixture();
    const runtime = new DurableMissionRuntime({ repository: database });
    const missionId = runtime.createMission({ userRequest: 'Partial fixture' }).mission.missionId;
    advanceToRunning(runtime, missionId);
    runtime.upsertStep(missionId, {
      stepId: randomUUID(),
      position: 0,
      title: 'Completed part',
      required: true,
      status: 'COMPLETED',
      skills: [],
      completedAt: new Date().toISOString(),
    });
    runtime.upsertStep(missionId, {
      stepId: randomUUID(),
      position: 1,
      title: 'Unavailable part',
      required: true,
      status: 'FAILED',
      skills: [],
      sanitizedError: 'Required dependency was unavailable.',
      completedAt: new Date().toISOString(),
    });
    const detail = runtime.transitionMission({
      missionId,
      toStatus: 'PARTIAL_SUCCESS',
      reason: 'One required part could not be completed.',
    });
    expect(detail.steps.map((step) => step.status)).toEqual(['COMPLETED', 'FAILED']);
    expect(detail.mission.status).toBe('PARTIAL_SUCCESS');
    database.close();
  });
});

function advanceToRunning(runtime: DurableMissionRuntime, missionId: string): void {
  runtime.transitionMission({ missionId, toStatus: 'ANALYZING', reason: 'Analyze.' });
  runtime.transitionMission({ missionId, toStatus: 'PLANNING', reason: 'Plan snapshot received.' });
  runtime.transitionMission({ missionId, toStatus: 'READY', reason: 'Ready.' });
  runtime.transitionMission({ missionId, toStatus: 'RUNNING', reason: 'Started.' });
}

function databaseFixture(): { database: JupiterDatabase; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'jupiter-mission-runtime-'));
  directories.push(directory);
  const path = join(directory, 'jupiter.db');
  return { database: JupiterDatabase.open(path), path };
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}
