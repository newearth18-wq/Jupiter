import { z } from 'zod';
import { MissionIdSchema } from './mission.js';

const SkillIdentifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export type SkillDataSchema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, SkillDataSchema> | undefined;
  required?: string[] | undefined;
  additionalProperties?: boolean | undefined;
  items?: SkillDataSchema | undefined;
  enum?: unknown[] | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
};

export const SkillDataSchemaSchema: z.ZodType<SkillDataSchema> = z.lazy(() =>
  z
    .object({
      type: z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']),
      properties: z.record(z.string(), SkillDataSchemaSchema).optional(),
      required: z.array(z.string().min(1).max(120)).max(100).optional(),
      additionalProperties: z.boolean().optional(),
      items: SkillDataSchemaSchema.optional(),
      enum: z.array(z.unknown()).min(1).max(100).optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().max(100_000).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    })
    .strict(),
);

export const SkillDefinitionSchema = z
  .object({
    skillId: SkillIdentifierSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    inputSchema: SkillDataSchemaSchema,
    outputSchema: SkillDataSchemaSchema,
    permissions: z.array(SkillIdentifierSchema).max(100),
    timeoutMs: z.number().int().min(10).max(3_600_000),
    category: SkillIdentifierSchema,
    provider: z.string().trim().min(1).max(160),
    compatibleRuntime: z.string().trim().min(1).max(160),
  })
  .strict();

export const SkillHealthStatusSchema = z.enum(['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);

export const SkillRegistryEntrySchema = z
  .object({
    definition: SkillDefinitionSchema,
    enabled: z.boolean(),
    health: SkillHealthStatusSchema,
    lastCheckedAt: z.iso.datetime().optional(),
    sanitizedError: z.string().max(1_000).optional(),
    registeredAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const SkillInvocationSchema = z
  .object({
    executionId: z.uuid(),
    skillId: SkillIdentifierSchema,
    missionId: MissionIdSchema,
    input: z.unknown(),
    permissions: z.array(SkillIdentifierSchema).max(100),
    timeoutMs: z.number().int().min(10).max(3_600_000),
    idempotencyKey: z.string().trim().min(1).max(300),
  })
  .strict();

export const SkillExecutionStatusSchema = z.enum([
  'SUCCESS',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'WAITING_APPROVAL',
  'WAITING_IDENTITY',
]);

export const SkillExecutionErrorSchema = z
  .object({
    code: SkillIdentifierSchema,
    message: z.string().min(1).max(1_000),
    recoverable: z.boolean(),
  })
  .strict();

export const SkillExecutionResultSchema = z
  .object({
    executionId: z.uuid(),
    skillId: SkillIdentifierSchema,
    missionId: MissionIdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    status: SkillExecutionStatusSchema,
    output: z.unknown().optional(),
    error: SkillExecutionErrorSchema.optional(),
    artifacts: z.record(SkillIdentifierSchema, z.unknown()),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    verificationHints: z.array(z.string().trim().min(1).max(500)).max(100),
  })
  .strict();

export const SkillExecutionRecordSchema = SkillExecutionResultSchema.extend({
  idempotencyKey: z.string().min(1).max(300),
  inputMetadata: z.record(z.string(), z.unknown()),
  outputMetadata: z.record(z.string(), z.unknown()),
}).strict();

export const SkillListResultSchema = z
  .object({ skills: z.array(SkillRegistryEntrySchema) })
  .strict();
export const SkillLookupResultSchema = z
  .object({ skill: SkillRegistryEntrySchema.nullable() })
  .strict();
export const SkillSearchInputSchema = z
  .object({
    query: z.string().trim().max(200).default(''),
    category: SkillIdentifierSchema.optional(),
  })
  .strict();
export const SkillLookupInputSchema = z
  .object({
    skillId: SkillIdentifierSchema,
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .optional(),
  })
  .strict();
export const SkillToggleInputSchema = z.object({ skillId: SkillIdentifierSchema }).strict();
export const SkillCancelInputSchema = z.object({ executionId: z.uuid() }).strict();
export const SkillVersionsResultSchema = z
  .object({ skillId: SkillIdentifierSchema, versions: z.array(SkillRegistryEntrySchema) })
  .strict();
export const SkillHealthResultSchema = z.object({ skill: SkillRegistryEntrySchema }).strict();
export const SkillExecutionListResultSchema = z
  .object({ executions: z.array(SkillExecutionRecordSchema) })
  .strict();

export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;
export type SkillRegistryEntry = z.infer<typeof SkillRegistryEntrySchema>;
export type SkillHealthStatus = z.infer<typeof SkillHealthStatusSchema>;
export type SkillInvocation = z.infer<typeof SkillInvocationSchema>;
export type SkillExecutionResult = z.infer<typeof SkillExecutionResultSchema>;
export type SkillExecutionRecord = z.infer<typeof SkillExecutionRecordSchema>;
export type SkillSearchInput = z.infer<typeof SkillSearchInputSchema>;
export type SkillLookupInput = z.infer<typeof SkillLookupInputSchema>;
