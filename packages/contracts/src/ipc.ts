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
import {
  WorkflowCheckpointResolveInputSchema,
  WorkflowControlInputSchema,
  WorkflowDetailSchema,
  WorkflowLookupResultSchema,
  WorkflowPlanCreateInputSchema,
  WorkflowReplanInputSchema,
} from './workflow.js';
import {
  SkillCancelInputSchema,
  SkillExecutionListResultSchema,
  SkillExecutionResultSchema,
  SkillHealthResultSchema,
  SkillInvocationSchema,
  SkillListResultSchema,
  SkillLookupInputSchema,
  SkillLookupResultSchema,
  SkillSearchInputSchema,
  SkillToggleInputSchema,
  SkillVersionsResultSchema,
} from './skill.js';
import {
  PermissionAuditListInputSchema,
  PermissionAuditListResultSchema,
  PermissionCapabilityListResultSchema,
  PermissionGrantListResultSchema,
  PermissionRequestInputSchema,
  PermissionRequestListInputSchema,
  PermissionRequestListResultSchema,
  PermissionRequestRecordSchema,
  PermissionResolutionResultSchema,
  PermissionResolveInputSchema,
  PermissionRevokeInputSchema,
} from './permission.js';
import {
  ComputerActionInputSchema,
  ComputerActionResultSchema,
  ComputerCancelInputSchema,
  ComputerCancelResultSchema,
  ComputerHistoryInputSchema,
  ComputerHistoryResultSchema,
  ComputerRuntimeStatusSchema,
  NotepadDemoInputSchema,
  NotepadDemoResultSchema,
} from './computer.js';
import {
  BrowserActionInputSchema,
  BrowserActionResultSchema,
  BrowserCancelInputSchema,
  BrowserCancelResultSchema,
  BrowserHistoryInputSchema,
  BrowserHistoryResultSchema,
  BrowserRuntimeStatusSchema,
  BrowserSessionListResultSchema,
} from './browser.js';
import {
  ApprovedFileRootSchema,
  ArtifactActionInputSchema,
  ArtifactActionResultSchema,
  ArtifactGenerateInputSchema,
  ArtifactListInputSchema,
  ArtifactListResultSchema,
  DocumentReadInputSchema,
  DocumentReadResultSchema,
  FileFindInputSchema,
  FileFindResultSchema,
  FileMutationInputSchema,
  FileMutationResultSchema,
  FileRootApproveInputSchema,
  FileRuntimeStatusSchema,
  ManagedArtifactSchema,
} from './artifact.js';

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
const WorkflowGetRequestSchema = rpcRequest(
  'query',
  'workflows.get',
  z.object({ missionId: MissionIdSchema }).strict(),
);
const WorkflowPlanCreateRequestSchema = rpcRequest(
  'command',
  'workflows.plan.create',
  WorkflowPlanCreateInputSchema,
);
const WorkflowStartRequestSchema = rpcRequest(
  'command',
  'workflows.start',
  WorkflowControlInputSchema,
);
const WorkflowResumeRequestSchema = rpcRequest(
  'command',
  'workflows.resume',
  WorkflowControlInputSchema,
);
const WorkflowCancelRequestSchema = rpcRequest(
  'command',
  'workflows.cancel',
  WorkflowControlInputSchema,
);
const WorkflowReplanRequestSchema = rpcRequest(
  'command',
  'workflows.replan',
  WorkflowReplanInputSchema,
);
const WorkflowCheckpointResolveRequestSchema = rpcRequest(
  'command',
  'workflows.checkpoint.resolve',
  WorkflowCheckpointResolveInputSchema,
);
const SkillListRequestSchema = rpcRequest('query', 'skills.list', EmptyPayloadSchema);
const SkillSearchRequestSchema = rpcRequest('query', 'skills.search', SkillSearchInputSchema);
const SkillGetRequestSchema = rpcRequest('query', 'skills.get', SkillLookupInputSchema);
const SkillVersionsRequestSchema = rpcRequest('query', 'skills.versions', SkillToggleInputSchema);
const SkillEnableRequestSchema = rpcRequest('command', 'skills.enable', SkillToggleInputSchema);
const SkillDisableRequestSchema = rpcRequest('command', 'skills.disable', SkillToggleInputSchema);
const SkillHealthRequestSchema = rpcRequest('command', 'skills.health', SkillToggleInputSchema);
const SkillInvokeRequestSchema = rpcRequest('command', 'skills.invoke', SkillInvocationSchema);
const SkillCancelRequestSchema = rpcRequest('command', 'skills.cancel', SkillCancelInputSchema);
const SkillExecutionsRequestSchema = rpcRequest(
  'query',
  'skills.executions',
  z.object({ skillId: z.string().min(1).max(120).optional() }).strict(),
);
const PermissionCapabilitiesRequestSchema = rpcRequest(
  'query',
  'permissions.capabilities',
  EmptyPayloadSchema,
);
const PermissionRequestsRequestSchema = rpcRequest(
  'query',
  'permissions.requests',
  PermissionRequestListInputSchema,
);
const PermissionGrantsRequestSchema = rpcRequest('query', 'permissions.grants', EmptyPayloadSchema);
const PermissionAuditRequestSchema = rpcRequest(
  'query',
  'permissions.audit',
  PermissionAuditListInputSchema,
);
const PermissionCreateRequestSchema = rpcRequest(
  'command',
  'permissions.request',
  PermissionRequestInputSchema,
);
const PermissionResolveRequestSchema = rpcRequest(
  'command',
  'permissions.resolve',
  PermissionResolveInputSchema,
);
const PermissionRevokeRequestSchema = rpcRequest(
  'command',
  'permissions.revoke',
  PermissionRevokeInputSchema,
);
const ComputerStatusRequestSchema = rpcRequest('query', 'computer.status', EmptyPayloadSchema);
const ComputerHistoryRequestSchema = rpcRequest(
  'query',
  'computer.history',
  ComputerHistoryInputSchema,
);
const ComputerExecuteRequestSchema = rpcRequest(
  'command',
  'computer.execute',
  ComputerActionInputSchema,
);
const ComputerCancelRequestSchema = rpcRequest(
  'command',
  'computer.cancel',
  ComputerCancelInputSchema,
);
const ComputerNotepadDemoRequestSchema = rpcRequest(
  'command',
  'computer.demo.notepad',
  NotepadDemoInputSchema,
);
const BrowserStatusRequestSchema = rpcRequest('query', 'browser.status', EmptyPayloadSchema);
const BrowserSessionsRequestSchema = rpcRequest('query', 'browser.sessions', EmptyPayloadSchema);
const BrowserHistoryRequestSchema = rpcRequest(
  'query',
  'browser.history',
  BrowserHistoryInputSchema,
);
const BrowserExecuteRequestSchema = rpcRequest(
  'command',
  'browser.execute',
  BrowserActionInputSchema,
);
const BrowserCancelRequestSchema = rpcRequest(
  'command',
  'browser.cancel',
  BrowserCancelInputSchema,
);
const FilesStatusRequestSchema = rpcRequest('query', 'files.status', EmptyPayloadSchema);
const FileRootsRequestSchema = rpcRequest('query', 'files.roots', EmptyPayloadSchema);
const FileRootApproveRequestSchema = rpcRequest(
  'command',
  'files.roots.approve',
  FileRootApproveInputSchema,
);
const FilesFindRequestSchema = rpcRequest('query', 'files.find', FileFindInputSchema);
const FilesReadRequestSchema = rpcRequest('query', 'files.read', DocumentReadInputSchema);
const FilesMutateRequestSchema = rpcRequest('command', 'files.mutate', FileMutationInputSchema);
const ArtifactsListRequestSchema = rpcRequest('query', 'artifacts.list', ArtifactListInputSchema);
const ArtifactsGenerateRequestSchema = rpcRequest(
  'command',
  'artifacts.generate',
  ArtifactGenerateInputSchema,
);
const ArtifactsActionRequestSchema = rpcRequest(
  'command',
  'artifacts.action',
  ArtifactActionInputSchema,
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
  WorkflowGetRequestSchema,
  WorkflowPlanCreateRequestSchema,
  WorkflowStartRequestSchema,
  WorkflowResumeRequestSchema,
  WorkflowCancelRequestSchema,
  WorkflowReplanRequestSchema,
  WorkflowCheckpointResolveRequestSchema,
  SkillListRequestSchema,
  SkillSearchRequestSchema,
  SkillGetRequestSchema,
  SkillVersionsRequestSchema,
  SkillEnableRequestSchema,
  SkillDisableRequestSchema,
  SkillHealthRequestSchema,
  SkillInvokeRequestSchema,
  SkillCancelRequestSchema,
  SkillExecutionsRequestSchema,
  PermissionCapabilitiesRequestSchema,
  PermissionRequestsRequestSchema,
  PermissionGrantsRequestSchema,
  PermissionAuditRequestSchema,
  PermissionCreateRequestSchema,
  PermissionResolveRequestSchema,
  PermissionRevokeRequestSchema,
  ComputerStatusRequestSchema,
  ComputerHistoryRequestSchema,
  ComputerExecuteRequestSchema,
  ComputerCancelRequestSchema,
  ComputerNotepadDemoRequestSchema,
  BrowserStatusRequestSchema,
  BrowserSessionsRequestSchema,
  BrowserHistoryRequestSchema,
  BrowserExecuteRequestSchema,
  BrowserCancelRequestSchema,
  FilesStatusRequestSchema,
  FileRootsRequestSchema,
  FileRootApproveRequestSchema,
  FilesFindRequestSchema,
  FilesReadRequestSchema,
  FilesMutateRequestSchema,
  ArtifactsListRequestSchema,
  ArtifactsGenerateRequestSchema,
  ArtifactsActionRequestSchema,
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
  'workflows.get',
  'workflows.plan.create',
  'workflows.start',
  'workflows.resume',
  'workflows.cancel',
  'workflows.replan',
  'workflows.checkpoint.resolve',
  'skills.list',
  'skills.search',
  'skills.get',
  'skills.versions',
  'skills.enable',
  'skills.disable',
  'skills.health',
  'skills.invoke',
  'skills.cancel',
  'skills.executions',
  'permissions.capabilities',
  'permissions.requests',
  'permissions.grants',
  'permissions.audit',
  'permissions.request',
  'permissions.resolve',
  'permissions.revoke',
  'computer.status',
  'computer.history',
  'computer.execute',
  'computer.cancel',
  'computer.demo.notepad',
  'browser.status',
  'browser.sessions',
  'browser.history',
  'browser.execute',
  'browser.cancel',
  'files.status',
  'files.roots',
  'files.roots.approve',
  'files.find',
  'files.read',
  'files.mutate',
  'artifacts.list',
  'artifacts.generate',
  'artifacts.action',
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
    case 'workflows.get':
      return WorkflowLookupResultSchema.parse(data);
    case 'workflows.plan.create':
    case 'workflows.start':
    case 'workflows.resume':
    case 'workflows.cancel':
    case 'workflows.replan':
    case 'workflows.checkpoint.resolve':
      return WorkflowDetailSchema.parse(data);
    case 'skills.list':
    case 'skills.search':
      return SkillListResultSchema.parse(data);
    case 'skills.get':
      return SkillLookupResultSchema.parse(data);
    case 'skills.versions':
      return SkillVersionsResultSchema.parse(data);
    case 'skills.enable':
    case 'skills.disable':
    case 'skills.health':
      return SkillHealthResultSchema.parse(data);
    case 'skills.invoke':
      return SkillExecutionResultSchema.parse(data);
    case 'skills.cancel':
      return z.object({ cancelled: z.boolean() }).strict().parse(data);
    case 'skills.executions':
      return SkillExecutionListResultSchema.parse(data);
    case 'permissions.capabilities':
      return PermissionCapabilityListResultSchema.parse(data);
    case 'permissions.requests':
      return PermissionRequestListResultSchema.parse(data);
    case 'permissions.grants':
      return PermissionGrantListResultSchema.parse(data);
    case 'permissions.audit':
      return PermissionAuditListResultSchema.parse(data);
    case 'permissions.request':
      return PermissionRequestRecordSchema.parse(data);
    case 'permissions.resolve':
      return PermissionResolutionResultSchema.parse(data);
    case 'permissions.revoke':
      return z.object({ revoked: z.boolean() }).strict().parse(data);
    case 'computer.status':
      return ComputerRuntimeStatusSchema.parse(data);
    case 'computer.history':
      return ComputerHistoryResultSchema.parse(data);
    case 'computer.execute':
      return ComputerActionResultSchema.parse(data);
    case 'computer.cancel':
      return ComputerCancelResultSchema.parse(data);
    case 'computer.demo.notepad':
      return NotepadDemoResultSchema.parse(data);
    case 'browser.status':
      return BrowserRuntimeStatusSchema.parse(data);
    case 'browser.sessions':
      return BrowserSessionListResultSchema.parse(data);
    case 'browser.history':
      return BrowserHistoryResultSchema.parse(data);
    case 'browser.execute':
      return BrowserActionResultSchema.parse(data);
    case 'browser.cancel':
      return BrowserCancelResultSchema.parse(data);
    case 'files.status':
      return FileRuntimeStatusSchema.parse(data);
    case 'files.roots':
      return z
        .object({ roots: z.array(ApprovedFileRootSchema) })
        .strict()
        .parse(data);
    case 'files.roots.approve':
      return ApprovedFileRootSchema.parse(data);
    case 'files.find':
      return FileFindResultSchema.parse(data);
    case 'files.read':
      return DocumentReadResultSchema.parse(data);
    case 'files.mutate':
      return FileMutationResultSchema.parse(data);
    case 'artifacts.list':
      return ArtifactListResultSchema.parse(data);
    case 'artifacts.generate':
      return ManagedArtifactSchema.parse(data);
    case 'artifacts.action':
      return ArtifactActionResultSchema.parse(data);
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
