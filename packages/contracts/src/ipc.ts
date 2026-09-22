import { z } from 'zod';
import { CONTRACT_SCHEMA_VERSION, CorrelationContextSchema } from './common.js';
import { DiagnosticsSnapshotSchema } from './diagnostics.js';
import { ErrorEnvelopeSchema } from './errors.js';
import { DomainEventSchema } from './events.js';

const EmptyPayloadSchema = z.object({}).strict();

const CorePingRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    kind: z.literal('query'),
    name: z.literal('core.ping'),
    context: CorrelationContextSchema,
    payload: z.object({ message: z.string().min(1).max(200).optional() }).strict(),
  })
  .strict();

const DiagnosticsGetRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    kind: z.literal('query'),
    name: z.literal('diagnostics.get'),
    context: CorrelationContextSchema,
    payload: EmptyPayloadSchema,
  })
  .strict();

const EventsReplayRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    kind: z.literal('query'),
    name: z.literal('events.replay'),
    context: CorrelationContextSchema,
    payload: z
      .object({
        afterSequence: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .strict(),
  })
  .strict();

const CoreHealthRefreshRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    kind: z.literal('command'),
    name: z.literal('core.health.refresh'),
    context: CorrelationContextSchema,
    payload: EmptyPayloadSchema,
  })
  .strict();

export const RpcRequestEnvelopeSchema = z.discriminatedUnion('name', [
  CorePingRequestSchema,
  DiagnosticsGetRequestSchema,
  EventsReplayRequestSchema,
  CoreHealthRefreshRequestSchema,
]);

export const RpcRequestNameSchema = z.enum([
  'core.ping',
  'diagnostics.get',
  'events.replay',
  'core.health.refresh',
]);

export const RpcSuccessEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: z.uuid(),
    requestName: RpcRequestNameSchema,
    status: z.literal('success'),
    data: z.unknown(),
    completedAt: z.iso.datetime(),
  })
  .strict();

export const RpcErrorEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: z.uuid(),
    requestName: RpcRequestNameSchema.optional(),
    status: z.literal('error'),
    error: ErrorEnvelopeSchema,
    completedAt: z.iso.datetime(),
  })
  .strict();

export const RpcResponseEnvelopeSchema = z.discriminatedUnion('status', [
  RpcSuccessEnvelopeSchema,
  RpcErrorEnvelopeSchema,
]);

export const CorePingResultSchema = z
  .object({
    message: z.string().min(1),
    coreVersion: z.string().min(1),
    receivedAt: z.iso.datetime(),
  })
  .strict();

export const EventsReplayResultSchema = z
  .object({
    events: z.array(DomainEventSchema),
    cursor: z.number().int().nonnegative(),
  })
  .strict();

export const CancelRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: z.uuid(),
  })
  .strict();

export function parseRpcSuccessData(
  requestName: z.infer<typeof RpcRequestNameSchema>,
  data: unknown,
): unknown {
  switch (requestName) {
    case 'core.ping':
      return CorePingResultSchema.parse(data);
    case 'diagnostics.get':
    case 'core.health.refresh':
      return DiagnosticsSnapshotSchema.parse(data);
    case 'events.replay':
      return EventsReplayResultSchema.parse(data);
  }
}

export type RpcRequestEnvelope = z.infer<typeof RpcRequestEnvelopeSchema>;
export type RpcRequestName = z.infer<typeof RpcRequestNameSchema>;
export type RpcResponseEnvelope = z.infer<typeof RpcResponseEnvelopeSchema>;
export type RpcSuccessEnvelope = z.infer<typeof RpcSuccessEnvelopeSchema>;
