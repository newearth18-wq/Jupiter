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
  Mission,
  MissionArtifact,
  MissionControlInput,
  MissionCreateInput,
  MissionDetail,
  MissionError,
  MissionErrorInput,
  MissionExecution,
  MissionPermission,
  MissionStep,
  MissionStepUpsertInput,
  MissionTransition,
  MissionTransitionInput,
  MissionVerification,
  MissionVerificationInput,
  MissionPlanSnapshot,
  WorkflowArtifactBinding,
  WorkflowCheckpoint,
  WorkflowCheckpointResolveInput,
  WorkflowControlInput,
  WorkflowDetail,
  WorkflowExecution,
  WorkflowPlan,
  WorkflowReplanInput,
  WorkflowStep,
  WorkflowStepAttempt,
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

export type MissionRepository = {
  transaction: <T>(work: () => T) => T;
  createMission: (mission: Mission) => void;
  updateMission: (mission: Mission) => void;
  getMission: (missionId: string) => Mission | undefined;
  listMissions: (includeArchived?: boolean) => Mission[];
  createMissionExecution: (execution: MissionExecution) => void;
  updateMissionExecution: (execution: MissionExecution) => void;
  listMissionExecutions: (missionId: string) => MissionExecution[];
  appendMissionTransition: (transition: MissionTransition) => void;
  listMissionTransitions: (missionId: string) => MissionTransition[];
  upsertMissionStep: (step: MissionStep) => void;
  listMissionSteps: (missionId: string) => MissionStep[];
  upsertMissionPermission: (permission: MissionPermission) => void;
  listMissionPermissions: (missionId: string) => MissionPermission[];
  addMissionArtifact: (artifact: MissionArtifact) => void;
  listMissionArtifacts: (missionId: string) => MissionArtifact[];
  addMissionError: (error: MissionError) => void;
  listMissionErrors: (missionId: string) => MissionError[];
  addMissionVerification: (verification: MissionVerification) => void;
  listMissionVerifications: (missionId: string) => MissionVerification[];
};

export type MissionChildRuntime = {
  pauseAtSafeBoundary: (signal: AbortSignal) => Promise<void>;
  cancel: (reason: string) => Promise<void>;
};

export type MissionRuntime = {
  listMissions: (includeArchived?: boolean) => Mission[];
  getMissionDetail: (missionId: string) => MissionDetail;
  createMission: (input: MissionCreateInput) => MissionDetail;
  pauseMission: (input: MissionControlInput, signal: AbortSignal) => Promise<MissionDetail>;
  resumeMission: (input: MissionControlInput) => MissionDetail;
  cancelMission: (input: MissionControlInput) => Promise<MissionDetail>;
  retryMission: (input: MissionControlInput) => MissionDetail;
  archiveMission: (missionId: string) => MissionDetail;
  transitionMission: (input: MissionTransitionInput) => MissionDetail;
  upsertStep: (missionId: string, input: MissionStepUpsertInput) => MissionDetail;
  recordVerification: (missionId: string, input: MissionVerificationInput) => MissionDetail;
  recordError: (missionId: string, input: MissionErrorInput) => MissionDetail;
  setPlanSnapshot: (missionId: string, plan: MissionPlanSnapshot) => MissionDetail;
  attachChildRuntime: (
    missionId: string,
    controller: AbortController,
    child: MissionChildRuntime,
  ) => () => void;
  shutdown: () => Promise<void>;
};

export type WorkflowRepository = {
  transaction: <T>(work: () => T) => T;
  createWorkflowPlan: (plan: WorkflowPlan) => void;
  setWorkflowPlanActive: (planId: string, active: boolean) => void;
  getWorkflowPlan: (planId: string) => WorkflowPlan | undefined;
  getActiveWorkflowPlan: (missionId: string) => WorkflowPlan | undefined;
  listWorkflowPlans: (missionId: string) => WorkflowPlan[];
  createWorkflowExecution: (execution: WorkflowExecution) => void;
  updateWorkflowExecution: (execution: WorkflowExecution) => void;
  getWorkflowExecution: (workflowExecutionId: string) => WorkflowExecution | undefined;
  getLatestWorkflowExecution: (missionId: string) => WorkflowExecution | undefined;
  listRecoverableWorkflowExecutions: () => WorkflowExecution[];
  upsertWorkflowStepAttempt: (attempt: WorkflowStepAttempt) => void;
  listWorkflowStepAttempts: (workflowExecutionId: string) => WorkflowStepAttempt[];
  createWorkflowCheckpoint: (checkpoint: WorkflowCheckpoint) => void;
  updateWorkflowCheckpoint: (checkpoint: WorkflowCheckpoint) => void;
  getWorkflowCheckpoint: (checkpointId: string) => WorkflowCheckpoint | undefined;
  listWorkflowCheckpoints: (workflowExecutionId: string) => WorkflowCheckpoint[];
  addWorkflowArtifactBinding: (binding: WorkflowArtifactBinding) => void;
  listWorkflowArtifactBindings: (workflowExecutionId: string) => WorkflowArtifactBinding[];
};

export type WorkflowStepResult = {
  output?: unknown;
  artifacts?: Readonly<Record<string, unknown>>;
  verificationPassed: boolean;
  verificationSummary: string;
};

export type WorkflowStepExecutor = {
  skillId: string;
  execute: (input: {
    missionId: string;
    workflowExecutionId: string;
    step: WorkflowStep;
    resolvedInput: Readonly<Record<string, unknown>>;
    idempotencyKey: string;
    signal: AbortSignal;
  }) => Promise<WorkflowStepResult>;
  compensate?: (input: {
    missionId: string;
    workflowExecutionId: string;
    step: WorkflowStep;
    output: unknown;
    signal: AbortSignal;
  }) => Promise<void>;
};

export type WorkflowRuntime = {
  getWorkflow: (missionId: string) => WorkflowDetail | undefined;
  createPlan: (missionId: string, modelOutput: unknown) => WorkflowDetail;
  startWorkflow: (input: WorkflowControlInput) => Promise<WorkflowDetail>;
  resumeWorkflow: (input: WorkflowControlInput) => Promise<WorkflowDetail>;
  cancelWorkflow: (input: WorkflowControlInput) => Promise<WorkflowDetail>;
  replanWorkflow: (input: WorkflowReplanInput) => WorkflowDetail;
  resolveCheckpoint: (input: WorkflowCheckpointResolveInput) => Promise<WorkflowDetail>;
  recover: () => Promise<void>;
  shutdown: () => Promise<void>;
};
