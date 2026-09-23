import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkflowPlanDraftSchema } from './workflow.js';

describe('workflow contracts', () => {
  it('accepts strict structured planner output', () => {
    const stepId = randomUUID();
    expect(
      WorkflowPlanDraftSchema.parse({
        goal: 'Produce a verified output.',
        assumptions: ['The input is available.'],
        steps: [
          {
            stepId,
            title: 'Create output',
            description: 'Use the declared test executor.',
            skillId: 'test.create',
            dependencies: [],
            input: {},
            timeoutMs: 1_000,
            retryPolicy: { maxAttempts: 2, initialBackoffMs: 10, backoffMultiplier: 2 },
            verification: { required: true, strategy: 'Check the executor result.' },
            status: 'PENDING',
            requiredPermissions: [],
            producesArtifacts: ['output'],
            checkpoint: 'NONE',
          },
        ],
        requiredSkills: ['test.create'],
        requiredPermissions: [],
        expectedArtifacts: [{ artifactKey: 'output', kind: 'test', required: true }],
        verificationPlan: { summary: 'Verify output.', checks: ['Output exists.'] },
        rationale: 'One bounded step is sufficient.',
      }).steps[0]?.stepId,
    ).toBe(stepId);
  });

  it('rejects malformed model output and unknown fields', () => {
    expect(
      WorkflowPlanDraftSchema.safeParse({ goal: 'Missing workflow fields.', chainOfThought: 'x' })
        .success,
    ).toBe(false);
  });
});
