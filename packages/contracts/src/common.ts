import { z } from 'zod';

export const CONTRACT_SCHEMA_VERSION = 1 as const;

export const ActorSchema = z.enum(['renderer', 'core', 'service', 'test']);

export const CorrelationContextSchema = z
  .object({
    requestId: z.uuid(),
    missionId: z.uuid().optional(),
    executionId: z.uuid().optional(),
    actor: ActorSchema,
    timestamp: z.iso.datetime(),
    cancellationId: z.uuid().optional(),
  })
  .strict();

export type Actor = z.infer<typeof ActorSchema>;
export type CorrelationContext = z.infer<typeof CorrelationContextSchema>;
