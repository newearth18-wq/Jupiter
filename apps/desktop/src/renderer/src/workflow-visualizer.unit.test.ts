import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkflowDetail } from '@jupiter/contracts';
import { WorkflowVisualizer } from './workflow-visualizer.js';

describe('WorkflowVisualizer', () => {
  it('renders a truthful unavailable state without a plan', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkflowVisualizer, {
        language: 'en',
        workflow: null,
        busy: false,
        onControl: () => Promise.resolve(),
      }),
    );
    expect(markup).toContain('data-testid="workflow-unavailable"');
    expect(markup).toContain('Not configured');
  });

  it('renders persisted revision, dependency, attempt, and status data', () => {
    const missionId = randomUUID();
    const planId = randomUUID();
    const executionId = randomUUID();
    const firstStepId = randomUUID();
    const secondStepId = randomUUID();
    const timestamp = new Date().toISOString();
    const workflow: WorkflowDetail = {
      plan: {
        planId,
        missionId,
        revision: 2,
        priorPlanId: randomUUID(),
        active: true,
        createdAt: timestamp,
        goal: 'Build a verified artifact',
        assumptions: ['A real executor is configured.'],
        steps: [
          workflowStep(firstStepId, 'Collect source', []),
          workflowStep(secondStepId, 'Create artifact', [firstStepId]),
        ],
        requiredSkills: ['test.execute'],
        requiredPermissions: [],
        expectedArtifacts: [],
        verificationPlan: { summary: 'Verify every step.', checks: ['Step result passes.'] },
        rationale: 'Use an explicit dependency graph.',
      },
      execution: {
        workflowExecutionId: executionId,
        planId,
        missionId,
        status: 'RUNNING',
        startedAt: timestamp,
        updatedAt: timestamp,
        pauseRequested: false,
        cancelRequested: false,
      },
      stepAttempts: [
        {
          stepAttemptId: randomUUID(),
          workflowExecutionId: executionId,
          stepId: firstStepId,
          attempt: 1,
          status: 'COMPLETED',
          idempotencyKey: `${executionId}:${firstStepId}`,
          input: {},
          verificationPassed: true,
          verificationSummary: 'Passed.',
          startedAt: timestamp,
          completedAt: timestamp,
        },
      ],
      checkpoints: [],
      artifacts: [],
    };
    const markup = renderToStaticMarkup(
      createElement(WorkflowVisualizer, {
        language: 'en',
        workflow,
        busy: false,
        onControl: () => Promise.resolve(),
      }),
    );
    expect(markup).toContain('revision 2');
    expect(markup).toContain('Build a verified artifact');
    expect(markup).toContain('Collect source');
    expect(markup).toContain('Create artifact');
    expect(markup).toContain('COMPLETED');
    expect(markup).toContain('1 / 1');
  });
});

function workflowStep(stepId: string, title: string, dependencies: string[]) {
  return {
    stepId,
    title,
    description: `${title}.`,
    skillId: 'test.execute',
    dependencies,
    input: {},
    timeoutMs: 1_000,
    retryPolicy: { maxAttempts: 1, initialBackoffMs: 0, backoffMultiplier: 1 },
    verification: { required: true, strategy: 'Check result.' },
    status: 'PENDING' as const,
    requiredPermissions: [],
    producesArtifacts: [],
    checkpoint: 'NONE' as const,
  };
}
