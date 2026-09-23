import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkflowPlanDraft, WorkflowStep } from '@jupiter/contracts';
import { validateStructuredPlan } from './planner.js';

describe('structured Planner boundary', () => {
  it('accepts a valid dependency graph with declared capabilities', () => {
    const first = step('test.read');
    const second = step('test.write', [first.stepId]);
    expect(
      validateStructuredPlan(plan([first, second]), {
        availableSkills: new Set(['test.read', 'test.write']),
        approvedPermissions: new Set(),
      }).steps,
    ).toHaveLength(2);
  });

  it('rejects malformed model output, cycles, missing skills, and invalid permissions', () => {
    expect(() =>
      validateStructuredPlan('{broken', {
        availableSkills: new Set(),
        approvedPermissions: new Set(),
      }),
    ).toThrow('not valid JSON');

    const left = step('test.run');
    const right = step('test.run', [left.stepId]);
    const cyclic = plan([{ ...left, dependencies: [right.stepId] }, right]);
    expect(() =>
      validateStructuredPlan(cyclic, {
        availableSkills: new Set(['test.run']),
        approvedPermissions: new Set(),
      }),
    ).toThrow('dependency cycle');

    const missingDependency = step('test.run', [randomUUID()]);
    expect(() =>
      validateStructuredPlan(plan([missingDependency]), {
        availableSkills: new Set(['test.run']),
        approvedPermissions: new Set(),
      }),
    ).toThrow('missing dependency');

    expect(() =>
      validateStructuredPlan(plan([step('missing.skill')]), {
        availableSkills: new Set(),
        approvedPermissions: new Set(),
      }),
    ).toThrow('unavailable skills');

    const protectedStep = {
      ...step('test.run'),
      requiredPermissions: ['files.write'],
    };
    expect(() =>
      validateStructuredPlan(
        { ...plan([protectedStep]), requiredPermissions: ['files.write'] },
        {
          availableSkills: new Set(['test.run']),
          approvedPermissions: new Set(),
        },
      ),
    ).toThrow('not approved');

    const producer = {
      ...step('test.run'),
      producesArtifacts: ['shared'],
    };
    const secondProducer = {
      ...step('test.run'),
      producesArtifacts: ['shared'],
    };
    expect(() =>
      validateStructuredPlan(
        {
          ...plan([producer, secondProducer]),
          expectedArtifacts: [{ artifactKey: 'shared', kind: 'test', required: true }],
        },
        {
          availableSkills: new Set(['test.run']),
          approvedPermissions: new Set(),
        },
      ),
    ).toThrow('more than one producer');
  });
});

function step(skillId: string, dependencies: string[] = []): WorkflowStep {
  return {
    stepId: randomUUID(),
    title: skillId,
    description: `Execute ${skillId}.`,
    skillId,
    dependencies,
    input: {},
    timeoutMs: 1_000,
    retryPolicy: { maxAttempts: 1, initialBackoffMs: 0, backoffMultiplier: 1 },
    verification: { required: true, strategy: 'Check the result.' },
    status: 'PENDING',
    requiredPermissions: [],
    producesArtifacts: [],
    checkpoint: 'NONE',
  };
}

function plan(steps: WorkflowStep[]): WorkflowPlanDraft {
  return {
    goal: 'Execute the validated test workflow.',
    assumptions: ['Test executors are deterministic.'],
    steps,
    requiredSkills: [...new Set(steps.map((item) => item.skillId))],
    requiredPermissions: [],
    expectedArtifacts: [],
    verificationPlan: { summary: 'All steps must pass.', checks: ['Step verification passes.'] },
    rationale: 'The dependency graph is minimal and explicit.',
  };
}
