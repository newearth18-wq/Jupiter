import { z } from 'zod';
import { ActorSchema, CONTRACT_SCHEMA_VERSION } from './common.js';

export const DomainEventSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    eventId: z.uuid(),
    sequence: z.number().int().positive(),
    streamSequence: z.number().int().positive(),
    type: z.string().min(1).max(120),
    missionId: z.uuid().optional(),
    correlationId: z.uuid(),
    actor: ActorSchema,
    source: z.string().min(1).max(120),
    payload: z.record(z.string(), z.unknown()),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const ProgressEventSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    eventId: z.uuid(),
    requestId: z.uuid(),
    missionId: z.uuid().optional(),
    executionId: z.uuid().optional(),
    status: z.enum(['started', 'progress', 'waiting', 'completed', 'failed', 'cancelled']),
    completedUnits: z.number().nonnegative().optional(),
    totalUnits: z.number().positive().optional(),
    message: z.string().min(1).max(300),
    timestamp: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completedUnits !== undefined && value.totalUnits === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'totalUnits is required when completedUnits is present',
        path: ['totalUnits'],
      });
    }
    if (
      value.completedUnits !== undefined &&
      value.totalUnits !== undefined &&
      value.completedUnits > value.totalUnits
    ) {
      context.addIssue({
        code: 'custom',
        message: 'completedUnits cannot exceed totalUnits',
        path: ['completedUnits'],
      });
    }
  });

export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
