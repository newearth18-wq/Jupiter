import { z } from 'zod';
import { MissionIdSchema } from './mission.js';

const IdentifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const WorkflowExecutionStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'WAITING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
]);

export const WorkflowStepStatusSchema = WorkflowExecutionStatusSchema;

export const WorkflowRetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    initialBackoffMs: z.number().int().min(0).max(60_000),
    backoffMultiplier: z.number().min(1).max(5),
  })
  .strict();

export const WorkflowStepVerificationSchema = z
  .object({
    required: z.boolean(),
    strategy: z.string().trim().min(1).max(500),
  })
  .strict();

export const WorkflowConditionSchema = z
  .object({
    sourceStepId: z.uuid(),
    path: z.string().trim().min(1).max(300),
    operator: z.enum(['equals', 'not_equals', 'exists', 'not_exists']),
    value: z.unknown().optional(),
  })
  .strict();

export const WorkflowStepSchema = z
  .object({
    stepId: z.uuid(),
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(2_000),
    skillId: IdentifierSchema,
    dependencies: z.array(z.uuid()).max(100),
    input: z.record(z.string(), z.unknown()),
    timeoutMs: z.number().int().min(100).max(3_600_000),
    retryPolicy: WorkflowRetryPolicySchema,
    verification: WorkflowStepVerificationSchema,
    status: z.literal('PENDING'),
    requiredPermissions: z.array(IdentifierSchema).max(50),
    producesArtifacts: z.array(IdentifierSchema).max(50),
    checkpoint: z.enum(['NONE', 'APPROVAL', 'IDENTITY']),
    condition: WorkflowConditionSchema.optional(),
  })
  .strict();

export const WorkflowExpectedArtifactSchema = z
  .object({
    artifactKey: IdentifierSchema,
    kind: IdentifierSchema,
    required: z.boolean(),
  })
  .strict();

export const WorkflowVerificationPlanSchema = z
  .object({
    summary: z.string().trim().min(1).max(1_000),
    checks: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  })
  .strict();

export const WorkflowPlanDraftSchema = z
  .object({
    goal: z.string().trim().min(1).max(2_000),
    assumptions: z.array(z.string().trim().min(1).max(300)).max(50),
    steps: z.array(WorkflowStepSchema).min(1).max(200),
    requiredSkills: z.array(IdentifierSchema).max(100),
    requiredPermissions: z.array(IdentifierSchema).max(100),
    expectedArtifacts: z.array(WorkflowExpectedArtifactSchema).max(100),
    verificationPlan: WorkflowVerificationPlanSchema,
    rationale: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const WorkflowPlanSchema = WorkflowPlanDraftSchema.extend({
  planId: z.uuid(),
  missionId: MissionIdSchema,
  revision: z.number().int().positive(),
  priorPlanId: z.uuid().optional(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
}).strict();

export const WorkflowExecutionSchema = z
  .object({
    workflowExecutionId: z.uuid(),
    planId: z.uuid(),
    missionId: MissionIdSchema,
    status: WorkflowExecutionStatusSchema,
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().optional(),
    pauseRequested: z.boolean(),
    cancelRequested: z.boolean(),
    failureReason: z.string().max(1_000).optional(),
  })
  .strict();

export const WorkflowStepAttemptSchema = z
  .object({
    stepAttemptId: z.uuid(),
    workflowExecutionId: z.uuid(),
    stepId: z.uuid(),
    attempt: z.number().int().positive(),
    status: WorkflowStepStatusSchema,
    idempotencyKey: z.string().min(1).max(300),
    input: z.record(z.string(), z.unknown()),
    output: z.unknown().optional(),
    verificationPassed: z.boolean().optional(),
    verificationSummary: z.string().max(1_000).optional(),
    sanitizedError: z.string().max(1_000).optional(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
  })
  .strict();

export const WorkflowCheckpointSchema = z
  .object({
    checkpointId: z.uuid(),
    workflowExecutionId: z.uuid(),
    stepId: z.uuid(),
    kind: z.enum(['APPROVAL', 'IDENTITY']),
    status: z.enum(['PENDING', 'APPROVED', 'DENIED']),
    reason: z.string().min(1).max(1_000),
    createdAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().optional(),
  })
  .strict();

export const WorkflowArtifactBindingSchema = z
  .object({
    bindingId: z.uuid(),
    workflowExecutionId: z.uuid(),
    stepId: z.uuid(),
    artifactKey: IdentifierSchema,
    value: z.unknown(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const WorkflowDetailSchema = z
  .object({
    plan: WorkflowPlanSchema,
    execution: WorkflowExecutionSchema.optional(),
    stepAttempts: z.array(WorkflowStepAttemptSchema),
    checkpoints: z.array(WorkflowCheckpointSchema),
    artifacts: z.array(WorkflowArtifactBindingSchema),
  })
  .strict();

export const WorkflowPlanCreateInputSchema = z
  .object({
    missionId: MissionIdSchema,
    modelOutput: z.unknown(),
  })
  .strict();

export const WorkflowReplanInputSchema = z
  .object({
    missionId: MissionIdSchema,
    modelOutput: z.unknown(),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const WorkflowControlInputSchema = z
  .object({ missionId: MissionIdSchema, reason: z.string().trim().min(1).max(500).optional() })
  .strict();

export const WorkflowCheckpointResolveInputSchema = z
  .object({
    checkpointId: z.uuid(),
    decision: z.enum(['APPROVED', 'DENIED']),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const WorkflowListResultSchema = z
  .object({ workflows: z.array(WorkflowDetailSchema) })
  .strict();

export const WorkflowLookupResultSchema = z
  .object({ workflow: WorkflowDetailSchema.nullable() })
  .strict();

export type WorkflowExecutionStatus = z.infer<typeof WorkflowExecutionStatusSchema>;
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatusSchema>;
export type WorkflowRetryPolicy = z.infer<typeof WorkflowRetryPolicySchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowPlanDraft = z.infer<typeof WorkflowPlanDraftSchema>;
export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;
export type WorkflowExecution = z.infer<typeof WorkflowExecutionSchema>;
export type WorkflowStepAttempt = z.infer<typeof WorkflowStepAttemptSchema>;
export type WorkflowCheckpoint = z.infer<typeof WorkflowCheckpointSchema>;
export type WorkflowArtifactBinding = z.infer<typeof WorkflowArtifactBindingSchema>;
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;
export type WorkflowPlanCreateInput = z.infer<typeof WorkflowPlanCreateInputSchema>;
export type WorkflowReplanInput = z.infer<typeof WorkflowReplanInputSchema>;
export type WorkflowControlInput = z.infer<typeof WorkflowControlInputSchema>;
export type WorkflowCheckpointResolveInput = z.infer<typeof WorkflowCheckpointResolveInputSchema>;
