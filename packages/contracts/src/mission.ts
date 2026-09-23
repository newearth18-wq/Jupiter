import { z } from 'zod';

export const MissionIdSchema = z.uuid();
export const MissionExecutionIdSchema = z.uuid();
export const MissionStatusSchema = z.enum([
  'CREATED',
  'ANALYZING',
  'PLANNING',
  'WAITING_APPROVAL',
  'WAITING_IDENTITY',
  'READY',
  'RUNNING',
  'PAUSED',
  'VERIFYING',
  'COMPLETED',
  'PARTIAL_SUCCESS',
  'FAILED',
  'CANCELLED',
]);
export const MissionPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']);
export const MissionStepStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
]);

export const MissionPlanSnapshotSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    assumptions: z.array(z.string().max(500)).max(50),
  })
  .strict();

export const MissionSchema = z
  .object({
    missionId: MissionIdSchema,
    title: z.string().min(1).max(160),
    userRequest: z.string().min(1).max(100_000),
    status: MissionStatusSchema,
    priority: MissionPrioritySchema,
    plan: MissionPlanSnapshotSchema.optional(),
    currentStepId: z.uuid().optional(),
    archivedAt: z.iso.datetime().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const MissionExecutionSchema = z
  .object({
    executionId: MissionExecutionIdSchema,
    missionId: MissionIdSchema,
    attempt: z.number().int().positive(),
    priorExecutionId: MissionExecutionIdSchema.optional(),
    status: MissionStatusSchema,
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().optional(),
  })
  .strict();

export const MissionTransitionSchema = z
  .object({
    transitionId: z.uuid(),
    missionId: MissionIdSchema,
    executionId: MissionExecutionIdSchema,
    fromStatus: MissionStatusSchema.nullable(),
    toStatus: MissionStatusSchema,
    accepted: z.boolean(),
    reason: z.string().min(1).max(1_000),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const MissionStepSchema = z
  .object({
    stepId: z.uuid(),
    missionId: MissionIdSchema,
    executionId: MissionExecutionIdSchema,
    position: z.number().int().nonnegative(),
    title: z.string().min(1).max(300),
    required: z.boolean(),
    status: MissionStepStatusSchema,
    agent: z.string().min(1).max(120).optional(),
    model: z.string().min(1).max(200).optional(),
    skills: z.array(z.string().min(1).max(120)).max(50),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    sanitizedError: z.string().max(1_000).optional(),
  })
  .strict();

export const MissionPermissionSchema = z
  .object({
    permissionId: z.uuid(),
    missionId: MissionIdSchema,
    name: z.string().min(1).max(160),
    status: z.enum(['REQUIRED', 'APPROVED', 'DENIED', 'REVOKED']),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const MissionArtifactSchema = z
  .object({
    missionArtifactId: z.uuid(),
    missionId: MissionIdSchema,
    artifactId: z.uuid(),
    name: z.string().min(1).max(255),
    kind: z.string().min(1).max(120),
    status: z.enum(['EXPECTED', 'CREATED', 'VERIFIED', 'FAILED']),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const MissionErrorSchema = z
  .object({
    missionErrorId: z.uuid(),
    missionId: MissionIdSchema,
    executionId: MissionExecutionIdSchema,
    stepId: z.uuid().optional(),
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(1_000),
    recoverable: z.boolean(),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const MissionVerificationSchema = z
  .object({
    verificationId: z.uuid(),
    missionId: MissionIdSchema,
    executionId: MissionExecutionIdSchema,
    name: z.string().min(1).max(200),
    passed: z.boolean(),
    summary: z.string().min(1).max(1_000),
    verifiedAt: z.iso.datetime(),
  })
  .strict();

export const MissionTimelineEntrySchema = z
  .object({
    timelineId: z.string().min(1).max(200),
    occurredAt: z.iso.datetime(),
    type: z.enum(['transition', 'execution', 'step', 'verification', 'error', 'artifact']),
    title: z.string().min(1).max(300),
    detail: z.string().max(1_000).optional(),
    tone: z.enum(['neutral', 'success', 'warning', 'error']),
  })
  .strict();

export const MissionDetailSchema = z
  .object({
    mission: MissionSchema,
    executions: z.array(MissionExecutionSchema),
    transitions: z.array(MissionTransitionSchema),
    steps: z.array(MissionStepSchema),
    permissions: z.array(MissionPermissionSchema),
    artifacts: z.array(MissionArtifactSchema),
    errors: z.array(MissionErrorSchema),
    verificationResults: z.array(MissionVerificationSchema),
    timeline: z.array(MissionTimelineEntrySchema),
  })
  .strict();

export const MissionCreateInputSchema = z
  .object({
    userRequest: z.string().trim().min(1).max(100_000),
    title: z.string().trim().min(1).max(160).optional(),
    priority: MissionPrioritySchema.default('NORMAL'),
  })
  .strict();
export const MissionControlInputSchema = z
  .object({ missionId: MissionIdSchema, reason: z.string().trim().min(1).max(500).optional() })
  .strict();
export const MissionArchiveInputSchema = z.object({ missionId: MissionIdSchema }).strict();
export const MissionTransitionInputSchema = z
  .object({
    missionId: MissionIdSchema,
    toStatus: MissionStatusSchema,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export const MissionStepUpsertInputSchema = MissionStepSchema.omit({
  missionId: true,
  executionId: true,
});
export const MissionVerificationInputSchema = MissionVerificationSchema.omit({
  verificationId: true,
  missionId: true,
  executionId: true,
  verifiedAt: true,
});
export const MissionErrorInputSchema = MissionErrorSchema.omit({
  missionErrorId: true,
  missionId: true,
  executionId: true,
  occurredAt: true,
});

export const MissionListResultSchema = z.object({ missions: z.array(MissionSchema) }).strict();

export type MissionStatus = z.infer<typeof MissionStatusSchema>;
export type MissionPriority = z.infer<typeof MissionPrioritySchema>;
export type Mission = z.infer<typeof MissionSchema>;
export type MissionExecution = z.infer<typeof MissionExecutionSchema>;
export type MissionTransition = z.infer<typeof MissionTransitionSchema>;
export type MissionStep = z.infer<typeof MissionStepSchema>;
export type MissionPermission = z.infer<typeof MissionPermissionSchema>;
export type MissionArtifact = z.infer<typeof MissionArtifactSchema>;
export type MissionError = z.infer<typeof MissionErrorSchema>;
export type MissionVerification = z.infer<typeof MissionVerificationSchema>;
export type MissionTimelineEntry = z.infer<typeof MissionTimelineEntrySchema>;
export type MissionDetail = z.infer<typeof MissionDetailSchema>;
export type MissionCreateInput = z.input<typeof MissionCreateInputSchema>;
export type MissionControlInput = z.infer<typeof MissionControlInputSchema>;
export type MissionTransitionInput = z.infer<typeof MissionTransitionInputSchema>;
export type MissionStepUpsertInput = z.infer<typeof MissionStepUpsertInputSchema>;
export type MissionVerificationInput = z.infer<typeof MissionVerificationInputSchema>;
export type MissionErrorInput = z.infer<typeof MissionErrorInputSchema>;
