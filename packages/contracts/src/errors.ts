import { z } from 'zod';

export const ErrorCategorySchema = z.enum([
  'validation',
  'permission',
  'identity',
  'configuration',
  'provider',
  'timeout',
  'cancellation',
  'dependency',
  'unsupported',
  'internal',
]);

export const ErrorEnvelopeSchema = z
  .object({
    errorId: z.uuid(),
    code: z.string().min(1),
    category: ErrorCategorySchema,
    message: z.string().min(1).max(500),
    recoverable: z.boolean(),
    retryable: z.boolean(),
    userAction: z.string().min(1).max(500),
    missionId: z.uuid().optional(),
    executionId: z.uuid().optional(),
    sanitizedDetails: z.string().max(1_000).optional(),
    timestamp: z.iso.datetime(),
  })
  .strict();

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
