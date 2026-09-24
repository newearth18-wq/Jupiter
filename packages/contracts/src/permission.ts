import { z } from 'zod';
import { ActorSchema } from './common.js';

const IdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

const ConstraintValueSchema = z.union([
  z.string().max(300),
  z.number(),
  z.boolean(),
  z.array(z.string().max(300)).max(50),
]);

export const PermissionRiskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const PermissionDecisionSchema = z.enum([
  'ALLOW_ONCE',
  'ALLOW_SESSION',
  'ALWAYS_ALLOW',
  'DENY',
]);
export const PermissionRequesterTypeSchema = z.enum([
  'CORE',
  'SKILL',
  'AGENT',
  'PLUGIN',
  'AUTOMATION',
  'UI',
]);
export const PermissionTrustSourceSchema = z.enum([
  'USER_INTENT',
  'TRUSTED_RUNTIME',
  'EXTERNAL_CONTENT',
]);

export const PermissionCapabilitySchema = z
  .object({
    capability: IdentifierSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000),
    risk: PermissionRiskSchema,
    allowedRequesterTypes: z.array(PermissionRequesterTypeSchema).min(1).max(10),
    automationAllowed: z.boolean(),
    available: z.boolean(),
  })
  .strict();

export const PermissionResourceSchema = z
  .object({
    type: IdentifierSchema,
    id: z.string().trim().min(1).max(500),
    display: z.string().trim().min(1).max(500),
  })
  .strict();

export const PermissionRequesterSchema = z
  .object({
    actor: ActorSchema,
    type: PermissionRequesterTypeSchema,
    id: IdentifierSchema,
    display: z.string().trim().min(1).max(300),
    declaredCapabilities: z.array(IdentifierSchema).max(100),
    missionId: z.uuid().optional(),
    stepId: IdentifierSchema.optional(),
  })
  .strict();

export const PermissionRequestInputSchema = z
  .object({
    capability: IdentifierSchema,
    action: z.string().trim().min(1).max(500),
    reason: z.string().trim().min(1).max(1_000),
    target: PermissionResourceSchema,
    scope: PermissionResourceSchema,
    requester: PermissionRequesterSchema,
    trustSource: PermissionTrustSourceSchema,
    dataLeavingDevice: z
      .object({
        value: z.boolean(),
        description: z.string().trim().min(1).max(1_000),
      })
      .strict(),
    consequence: z.string().trim().min(1).max(1_000),
    reversible: z.boolean(),
    automated: z.boolean(),
    constraints: z.record(IdentifierSchema, ConstraintValueSchema),
  })
  .strict();

export const PermissionRequestStatusSchema = z.enum(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED']);

export const PermissionRequestRecordSchema = PermissionRequestInputSchema.extend({
  requestId: z.uuid(),
  risk: PermissionRiskSchema,
  status: PermissionRequestStatusSchema,
  availableDecisions: z.array(PermissionDecisionSchema),
  sessionId: z.uuid(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().optional(),
  resolutionDecision: PermissionDecisionSchema.optional(),
  grantId: z.uuid().optional(),
}).strict();

export const PermissionGrantSchema = z
  .object({
    grantId: z.uuid(),
    requestId: z.uuid(),
    capability: IdentifierSchema,
    decision: PermissionDecisionSchema,
    actor: ActorSchema,
    requesterType: PermissionRequesterTypeSchema,
    requesterId: IdentifierSchema,
    targetId: z.string().min(1).max(500),
    scopeId: z.string().min(1).max(500),
    missionId: z.uuid().optional(),
    sessionId: z.uuid().optional(),
    constraints: z.record(IdentifierSchema, ConstraintValueSchema),
    risk: PermissionRiskSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    remainingUses: z.number().int().min(0).max(1).optional(),
    revokedAt: z.iso.datetime().optional(),
  })
  .strict();

export const PermissionResolveInputSchema = z
  .object({
    requestId: z.uuid(),
    decision: PermissionDecisionSchema,
  })
  .strict();

export const PermissionResolutionAuthoritySchema = z.enum([
  'USER_EXPLICIT',
  'TRUSTED_POLICY',
  'EXTERNAL_CONTENT',
  'PLUGIN',
]);

export const PermissionResolutionResultSchema = z
  .object({
    request: PermissionRequestRecordSchema,
    grant: PermissionGrantSchema.nullable(),
  })
  .strict();

export const PermissionAuthorizationInputSchema = z
  .object({
    capability: IdentifierSchema,
    actor: ActorSchema,
    requesterType: PermissionRequesterTypeSchema,
    requesterId: IdentifierSchema,
    declaredCapabilities: z.array(IdentifierSchema).max(100),
    targetId: z.string().min(1).max(500),
    scopeId: z.string().min(1).max(500),
    missionId: z.uuid().optional(),
    constraints: z.record(IdentifierSchema, ConstraintValueSchema),
    automated: z.boolean(),
  })
  .strict();

export const PermissionAuthorizationResultSchema = z
  .object({
    status: z.enum(['ALLOWED', 'DENIED', 'PROMPT']),
    code: IdentifierSchema,
    grantId: z.uuid().optional(),
    auditId: z.uuid(),
    evaluatedAt: z.iso.datetime(),
  })
  .strict();

export const PermissionAuditRecordSchema = z
  .object({
    auditId: z.uuid(),
    eventType: z.enum(['REQUESTED', 'RESOLVED', 'AUTHORIZED', 'DENIED', 'REVOKED', 'REJECTED']),
    capability: IdentifierSchema,
    actor: ActorSchema,
    requesterType: PermissionRequesterTypeSchema,
    requesterId: IdentifierSchema,
    decision: z.enum(['ALLOW', 'DENY', 'PROMPT', 'ERROR']),
    reasonCode: IdentifierSchema,
    risk: PermissionRiskSchema,
    targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    missionId: z.uuid().optional(),
    requestId: z.uuid().optional(),
    grantId: z.uuid().optional(),
    timestamp: z.iso.datetime(),
    metadataRedacted: z.record(IdentifierSchema, ConstraintValueSchema),
  })
  .strict();

export const PermissionRequestListInputSchema = z
  .object({ status: PermissionRequestStatusSchema.optional() })
  .strict();
export const PermissionRequestListResultSchema = z
  .object({ requests: z.array(PermissionRequestRecordSchema) })
  .strict();
export const PermissionGrantListResultSchema = z
  .object({ grants: z.array(PermissionGrantSchema) })
  .strict();
export const PermissionAuditListInputSchema = z
  .object({ limit: z.number().int().min(1).max(500).default(100) })
  .strict();
export const PermissionAuditListResultSchema = z
  .object({ audits: z.array(PermissionAuditRecordSchema) })
  .strict();
export const PermissionCapabilityListResultSchema = z
  .object({ capabilities: z.array(PermissionCapabilitySchema) })
  .strict();
export const PermissionRevokeInputSchema = z.object({ grantId: z.uuid() }).strict();

export type PermissionRisk = z.infer<typeof PermissionRiskSchema>;
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
export type PermissionRequesterType = z.infer<typeof PermissionRequesterTypeSchema>;
export type PermissionCapability = z.infer<typeof PermissionCapabilitySchema>;
export type PermissionRequestInput = z.infer<typeof PermissionRequestInputSchema>;
export type PermissionRequestRecord = z.infer<typeof PermissionRequestRecordSchema>;
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;
export type PermissionResolveInput = z.infer<typeof PermissionResolveInputSchema>;
export type PermissionResolutionAuthority = z.infer<typeof PermissionResolutionAuthoritySchema>;
export type PermissionResolutionResult = z.infer<typeof PermissionResolutionResultSchema>;
export type PermissionAuthorizationInput = z.infer<typeof PermissionAuthorizationInputSchema>;
export type PermissionAuthorizationResult = z.infer<typeof PermissionAuthorizationResultSchema>;
export type PermissionAuditRecord = z.infer<typeof PermissionAuditRecordSchema>;
export type PermissionRequestStatus = z.infer<typeof PermissionRequestStatusSchema>;
