import type {
  AiSettings,
  AiSettingsUpdate,
  Actor,
  AuditEvent,
  ChatMessage,
  ChatEditResendInput,
  ChatRetryInput,
  ChatSendInput,
  ChatSendResult,
  ChatStreamEvent,
  Conversation,
  ConversationCreateInput,
  ConversationRouteInput,
  ModelDescriptor,
  ProviderSummary,
  ProviderConfigureInput,
  CoreServiceHealth,
  DatabaseDiagnostics,
  DomainEvent,
} from '@jupiter/contracts';

export type DomainEventDraft = {
  type: string;
  missionId?: string;
  correlationId: string;
  actor: Actor;
  source: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: string;
};

export type EventStore = {
  append: (event: DomainEventDraft) => DomainEvent;
  listAfter: (afterSequence: number, limit: number) => DomainEvent[];
};

export type AuditRepository = {
  appendAudit: (event: AuditEvent) => void;
};

export type ServiceHealthRepository = {
  upsert: (health: CoreServiceHealth) => void;
  list: () => CoreServiceHealth[];
};

export type DiagnosticsRepository = {
  inspect: () => DatabaseDiagnostics;
};

export type SettingsRepository = {
  getSetting: (key: string) => unknown;
  setSetting: (key: string, value: unknown) => void;
};

export type AiRepository = {
  listProviders: () => ProviderSummary[];
  getProvider: (providerId: string) => ProviderSummary | undefined;
  upsertProvider: (provider: ProviderSummary) => void;
  removeProvider: (providerId: string) => void;
  replaceModels: (providerId: string, models: readonly ModelDescriptor[]) => void;
  listModels: (providerId?: string) => ModelDescriptor[];
  getAiSettings: () => AiSettings | undefined;
  setAiSettings: (settings: AiSettings) => void;
  createConversation: (conversation: Conversation) => void;
  updateConversation: (conversation: Conversation) => void;
  getConversation: (conversationId: string) => Conversation | undefined;
  listConversations: () => Conversation[];
  upsertMessage: (message: ChatMessage) => void;
  getMessage: (messageId: string) => ChatMessage | undefined;
  listMessages: (conversationId: string) => ChatMessage[];
};

export type ChatRuntime = {
  listProviders: () => ProviderSummary[];
  configureProvider: (
    input: ProviderConfigureInput,
    signal: AbortSignal,
  ) => Promise<ProviderSummary>;
  removeProvider: (providerId: string) => Promise<boolean>;
  validateProvider: (
    providerId: string,
    signal: AbortSignal,
  ) => Promise<{ provider: ProviderSummary; models: ModelDescriptor[] }>;
  listModels: (providerId?: string) => ModelDescriptor[];
  discoverModels: (providerId: string, signal: AbortSignal) => Promise<ModelDescriptor[]>;
  getSettings: () => AiSettings;
  updateSettings: (update: AiSettingsUpdate) => AiSettings;
  listConversations: () => Conversation[];
  createConversation: (input: ConversationCreateInput) => Conversation;
  getConversation: (conversationId: string) => {
    conversation: Conversation;
    messages: ChatMessage[];
  };
  updateConversationRoute: (input: ConversationRouteInput) => Conversation;
  send: (input: ChatSendInput, requestId: string, signal: AbortSignal) => Promise<ChatSendResult>;
  retry: (input: ChatRetryInput, requestId: string, signal: AbortSignal) => Promise<ChatSendResult>;
  editAndResend: (
    input: ChatEditResendInput,
    requestId: string,
    signal: AbortSignal,
  ) => Promise<ChatSendResult>;
  subscribe: (listener: (event: ChatStreamEvent) => void) => () => void;
  shutdown: () => Promise<void>;
};
