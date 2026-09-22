import { z } from 'zod';
import { ActorSchema } from './common.js';

export const AuditEventSchema = z
  .object({
    auditId: z.uuid(),
    eventType: z.string().min(1).max(120),
    actor: ActorSchema,
    capability: z.string().min(1).max(160),
    target: z.string().min(1).max(300),
    decision: z.enum(['allow', 'deny', 'error']),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    missionId: z.uuid().optional(),
    executionId: z.uuid().optional(),
    timestamp: z.iso.datetime(),
    metadataRedacted: z.record(z.string(), z.unknown()),
  })
  .strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;
