import { z } from 'zod';
import { CONTRACT_SCHEMA_VERSION, CorrelationContextSchema } from './common.js';
import { DiagnosticsSnapshotSchema } from './diagnostics.js';
import { ErrorEnvelopeSchema } from './errors.js';
import { DomainEventSchema } from './events.js';
import {
  AiSettingsSchema,
  AiSettingsUpdateSchema,
  ChatEditResendInputSchema,
  ChatRetryInputSchema,
  ChatSendInputSchema,
  ChatSendResultSchema,
  ConversationCreateInputSchema,
  ConversationDetailSchema,
  ConversationIdSchema,
  ConversationListResultSchema,
  ConversationRouteInputSchema,
  ConversationSchema,
  ModelListResultSchema,
  ProviderConfigureInputSchema,
  ProviderIdSchema,
  ProviderListResultSchema,
  ProviderSummarySchema,
  ProviderValidationResultSchema,
} from './ai.js';
import { UiPreferencesSchema, UiPreferencesUpdateSchema } from './ui.js';
import {
  MissionArchiveInputSchema,
  MissionControlInputSchema,
  MissionCreateInputSchema,
  MissionDetailSchema,
  MissionIdSchema,
  MissionListResultSchema,
  MissionTransitionInputSchema,
} from './mission.js';

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

const UiPreferencesGetRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    kind: z.literal('query'),
    name: z.literal('ui.preferences.get'),
    context: CorrelationContextSchema,
    payload: EmptyPayloadSchema,
  })
  .strict();

const UiPreferencesUpdateRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    kind: z.literal('command'),
    name: z.literal('ui.preferences.update'),
    context: CorrelationContextSchema,
    payload: UiPreferencesUpdateSchema,
  })
  .strict();

const ProviderListRequestSchema = rpcRequest('query', 'providers.list', EmptyPayloadSchema);
const ProviderConfigureRequestSchema = rpcRequest(
  'command',
  'providers.configure',
  ProviderConfigureInputSchema,
);
const ProviderRemoveRequestSchema = rpcRequest(
  'command',
  'providers.remove',
  z.object({ providerId: ProviderIdSchema }).strict(),
);
const ProviderValidateRequestSchema = rpcRequest(
  'command',
  'providers.validate',
  z.object({ providerId: ProviderIdSchema }).strict(),
);
const ModelsListRequestSchema = rpcRequest(
  'query',
  'models.list',
  z.object({ providerId: ProviderIdSchema.optional() }).strict(),
);
const ModelsDiscoverRequestSchema = rpcRequest(
  'command',
  'models.discover',
  z.object({ providerId: ProviderIdSchema }).strict(),
);
const AiSettingsGetRequestSchema = rpcRequest('query', 'ai.settings.get', EmptyPayloadSchema);
const AiSettingsUpdateRequestSchema = rpcRequest(
  'command',
  'ai.settings.update',
  AiSettingsUpdateSchema,
);
const ConversationsListRequestSchema = rpcRequest(
  'query',
  'chat.conversations.list',
  EmptyPayloadSchema,
);
const ConversationCreateRequestSchema = rpcRequest(
  'command',
  'chat.conversation.create',
  ConversationCreateInputSchema,
);
const ConversationGetRequestSchema = rpcRequest(
  'query',
  'chat.conversation.get',
  z.object({ conversationId: ConversationIdSchema }).strict(),
);
const ConversationRouteRequestSchema = rpcRequest(
  'command',
  'chat.conversation.route',
  ConversationRouteInputSchema,
);
const ChatSendRequestSchema = rpcRequest('command', 'chat.send', ChatSendInputSchema);
const ChatRetryRequestSchema = rpcRequest('command', 'chat.retry', ChatRetryInputSchema);
const ChatEditResendRequestSchema = rpcRequest(
  'command',
  'chat.edit_resend',
  ChatEditResendInputSchema,
);
const MissionsListRequestSchema = rpcRequest(
  'query',
  'missions.list',
  z.object({ includeArchived: z.boolean().default(false) }).strict(),
);
const MissionGetRequestSchema = rpcRequest(
  'query',
  'missions.get',
  z.object({ missionId: MissionIdSchema }).strict(),
);
const MissionCreateRequestSchema = rpcRequest(
  'command',
  'missions.create',
  MissionCreateInputSchema,
);
const MissionPauseRequestSchema = rpcRequest(
  'command',
  'missions.pause',
  MissionControlInputSchema,
);
const MissionResumeRequestSchema = rpcRequest(
  'command',
  'missions.resume',
  MissionControlInputSchema,
);
const MissionCancelRequestSchema = rpcRequest(
  'command',
  'missions.cancel',
  MissionControlInputSchema,
);
const MissionRetryRequestSchema = rpcRequest(
  'command',
  'missions.retry',
  MissionControlInputSchema,
);
const MissionArchiveRequestSchema = rpcRequest(
  'command',
  'missions.archive',
  MissionArchiveInputSchema,
);
const MissionTransitionRequestSchema = rpcRequest(
  'command',
  'missions.transition',
  MissionTransitionInputSchema,
);

export const RpcRequestEnvelopeSchema = z.discriminatedUnion('name', [
  CorePingRequestSchema,
  DiagnosticsGetRequestSchema,
  EventsReplayRequestSchema,
  CoreHealthRefreshRequestSchema,
  UiPreferencesGetRequestSchema,
  UiPreferencesUpdateRequestSchema,
  ProviderListRequestSchema,
  ProviderConfigureRequestSchema,
  ProviderRemoveRequestSchema,
  ProviderValidateRequestSchema,
  ModelsListRequestSchema,
  ModelsDiscoverRequestSchema,
  AiSettingsGetRequestSchema,
  AiSettingsUpdateRequestSchema,
  ConversationsListRequestSchema,
  ConversationCreateRequestSchema,
  ConversationGetRequestSchema,
  ConversationRouteRequestSchema,
  ChatSendRequestSchema,
  ChatRetryRequestSchema,
  ChatEditResendRequestSchema,
  MissionsListRequestSchema,
  MissionGetRequestSchema,
  MissionCreateRequestSchema,
  MissionPauseRequestSchema,
  MissionResumeRequestSchema,
  MissionCancelRequestSchema,
  MissionRetryRequestSchema,
  MissionArchiveRequestSchema,
  MissionTransitionRequestSchema,
]);

export const RpcRequestNameSchema = z.enum([
  'core.ping',
  'diagnostics.get',
  'events.replay',
  'core.health.refresh',
  'ui.preferences.get',
  'ui.preferences.update',
  'providers.list',
  'providers.configure',
  'providers.remove',
  'providers.validate',
  'models.list',
  'models.discover',
  'ai.settings.get',
  'ai.settings.update',
  'chat.conversations.list',
  'chat.conversation.create',
  'chat.conversation.get',
  'chat.conversation.route',
  'chat.send',
  'chat.retry',
  'chat.edit_resend',
  'missions.list',
  'missions.get',
  'missions.create',
  'missions.pause',
  'missions.resume',
  'missions.cancel',
  'missions.retry',
  'missions.archive',
  'missions.transition',
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
    case 'ui.preferences.get':
    case 'ui.preferences.update':
      return UiPreferencesSchema.parse(data);
    case 'providers.list':
      return ProviderListResultSchema.parse(data);
    case 'providers.configure':
      return ProviderSummarySchema.parse(data);
    case 'providers.remove':
      return z.object({ removed: z.boolean() }).strict().parse(data);
    case 'providers.validate':
      return ProviderValidationResultSchema.parse(data);
    case 'models.list':
    case 'models.discover':
      return ModelListResultSchema.parse(data);
    case 'ai.settings.get':
    case 'ai.settings.update':
      return AiSettingsSchema.parse(data);
    case 'chat.conversations.list':
      return ConversationListResultSchema.parse(data);
    case 'chat.conversation.create':
    case 'chat.conversation.route':
      return ConversationSchema.parse(data);
    case 'chat.conversation.get':
      return ConversationDetailSchema.parse(data);
    case 'chat.send':
    case 'chat.retry':
    case 'chat.edit_resend':
      return ChatSendResultSchema.parse(data);
    case 'missions.list':
      return MissionListResultSchema.parse(data);
    case 'missions.get':
    case 'missions.create':
    case 'missions.pause':
    case 'missions.resume':
    case 'missions.cancel':
    case 'missions.retry':
    case 'missions.archive':
    case 'missions.transition':
      return MissionDetailSchema.parse(data);
  }
}

function rpcRequest<TKind extends 'query' | 'command', TName extends string>(
  kind: TKind,
  name: TName,
  payload: z.ZodType,
) {
  return z
    .object({
      schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
      kind: z.literal(kind),
      name: z.literal(name),
      context: CorrelationContextSchema,
      payload,
    })
    .strict();
}

export type RpcRequestEnvelope = z.infer<typeof RpcRequestEnvelopeSchema>;
export type RpcRequestName = z.infer<typeof RpcRequestNameSchema>;
export type RpcResponseEnvelope = z.infer<typeof RpcResponseEnvelopeSchema>;
export type RpcSuccessEnvelope = z.infer<typeof RpcSuccessEnvelopeSchema>;
