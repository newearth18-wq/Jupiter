import { z } from 'zod';
import { CONTRACT_SCHEMA_VERSION } from './common.js';

export const ProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const ConversationIdSchema = z.uuid();
export const MessageIdSchema = z.uuid();

export const ProviderLocalitySchema = z.enum(['cloud', 'local']);
export const ProviderAuthSchemeSchema = z.enum(['bearer', 'none']);
export const ProviderAuthStateSchema = z.enum(['not_configured', 'stored', 'valid', 'invalid']);
export const ProviderHealthSchema = z.enum([
  'not_configured',
  'operational',
  'degraded',
  'unavailable',
]);
export const ModelCapabilitySchema = z.enum([
  'chat',
  'streaming',
  'reasoning',
  'vision',
  'embeddings',
  'tool_calling',
  'structured_output',
  'cancellation',
  'usage',
]);
export const RoutingModeSchema = z.enum(['AUTO', 'CLOUD', 'HYBRID', 'LOCAL_ONLY']);
export const FallbackPolicySchema = z.enum(['NONE', 'SAME_LOCALITY', 'EXPLICIT']);

const BaseUrlSchema = z
  .url()
  .max(500)
  .refine((value) => {
    const url = new URL(value);
    return url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  }, 'Provider URL cannot contain credentials, query parameters, or fragments.');

export const ProviderSummarySchema = z
  .object({
    providerId: ProviderIdSchema,
    displayName: z.string().min(1).max(80),
    baseUrl: BaseUrlSchema,
    locality: ProviderLocalitySchema,
    authScheme: ProviderAuthSchemeSchema,
    enabled: z.boolean(),
    capabilities: z.array(ModelCapabilitySchema).max(9),
    authState: ProviderAuthStateSchema,
    health: ProviderHealthSchema,
    credentialFingerprint: z.string().max(20).optional(),
    lastValidatedAt: z.iso.datetime().optional(),
    sanitizedError: z.string().max(500).optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const ProviderConfigureInputSchema = z
  .object({
    providerId: ProviderIdSchema,
    displayName: z.string().trim().min(1).max(80),
    baseUrl: BaseUrlSchema,
    locality: ProviderLocalitySchema,
    authScheme: ProviderAuthSchemeSchema,
    enabled: z.boolean().default(true),
    capabilities: z.array(ModelCapabilitySchema).min(1).max(9),
    credential: z.string().min(8).max(8_192).optional(),
    clearCredential: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.credential !== undefined && value.clearCredential === true) {
      context.addIssue({
        code: 'custom',
        path: ['credential'],
        message: 'Credential and clearCredential cannot be provided together.',
      });
    }
    const url = new URL(value.baseUrl);
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (value.locality === 'cloud' && url.protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Cloud providers require HTTPS.',
      });
    }
    if (value.locality === 'local' && !localHost) {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Local providers must use a loopback hostname.',
      });
    }
  });

export const ModelDescriptorSchema = z
  .object({
    providerId: ProviderIdSchema,
    modelId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    capabilities: z.array(ModelCapabilitySchema).min(1).max(9),
    contextWindow: z.number().int().positive().optional(),
    inputCostPerMillion: z.number().nonnegative().optional(),
    outputCostPerMillion: z.number().nonnegative().optional(),
    discoveredAt: z.iso.datetime(),
  })
  .strict();

export const AiSettingsSchema = z
  .object({
    routingMode: RoutingModeSchema,
    preferredProviderId: ProviderIdSchema.optional(),
    preferredChatModel: z.string().min(1).max(200).optional(),
    preferredReasoningModel: z.string().min(1).max(200).optional(),
    preferredVisionModel: z.string().min(1).max(200).optional(),
    preferredEmbeddingModel: z.string().min(1).max(200).optional(),
    fallbackPolicy: FallbackPolicySchema,
    fallbackProviderIds: z.array(ProviderIdSchema).max(20),
    optimization: z.enum(['balanced', 'cost', 'latency']),
  })
  .strict();

export const DEFAULT_AI_SETTINGS: z.infer<typeof AiSettingsSchema> = {
  routingMode: 'AUTO',
  fallbackPolicy: 'NONE',
  fallbackProviderIds: [],
  optimization: 'balanced',
};

export const AiSettingsUpdateSchema = AiSettingsSchema.partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one AI setting is required.');

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export const ChatAttachmentRefSchema = z
  .object({
    artifactId: z.uuid(),
    name: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(120),
  })
  .strict();
export const ToolCallDisplaySchema = z
  .object({
    toolCallId: z.string().min(1).max(200),
    name: z.string().min(1).max(120),
    argumentsSummary: z.string().max(1_000),
    status: z.enum(['requested', 'completed', 'failed']),
  })
  .strict();

export const ChatMessageSchema = z
  .object({
    messageId: MessageIdSchema,
    conversationId: ConversationIdSchema,
    role: ChatRoleSchema,
    content: z.string().max(200_000),
    attachments: z.array(ChatAttachmentRefSchema).max(20),
    toolCalls: z.array(ToolCallDisplaySchema).max(50),
    providerId: ProviderIdSchema.optional(),
    modelId: z.string().min(1).max(200).optional(),
    status: z.enum(['complete', 'streaming', 'cancelled', 'failed']),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const ConversationRoutingOverrideSchema = z
  .object({
    routingMode: RoutingModeSchema.optional(),
    providerId: ProviderIdSchema.optional(),
    modelId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const ConversationSchema = z
  .object({
    conversationId: ConversationIdSchema,
    title: z.string().min(1).max(160),
    routingOverride: ConversationRoutingOverrideSchema.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const ChatSendInputSchema = z
  .object({
    conversationId: ConversationIdSchema,
    content: z.string().trim().min(1).max(100_000),
    attachments: z.array(ChatAttachmentRefSchema).max(20).default([]),
    sourceMessageId: MessageIdSchema.optional(),
  })
  .strict();

export const ChatEditResendInputSchema = z
  .object({
    messageId: MessageIdSchema,
    content: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const ConversationCreateInputSchema = z
  .object({ title: z.string().trim().min(1).max(160).optional() })
  .strict();
export const ConversationRouteInputSchema = z
  .object({
    conversationId: ConversationIdSchema,
    routingOverride: ConversationRoutingOverrideSchema.nullable(),
  })
  .strict();
export const ChatRetryInputSchema = z.object({ messageId: MessageIdSchema }).strict();

export const ChatStreamEventSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: z.uuid(),
    conversationId: ConversationIdSchema,
    messageId: MessageIdSchema,
    type: z.enum(['started', 'delta', 'tool_call', 'completed', 'cancelled', 'failed']),
    delta: z.string().max(50_000).optional(),
    toolCall: ToolCallDisplaySchema.optional(),
    providerId: ProviderIdSchema.optional(),
    modelId: z.string().min(1).max(200).optional(),
    sanitizedError: z.string().max(500).optional(),
    timestamp: z.iso.datetime(),
  })
  .strict();

export const ProviderListResultSchema = z
  .object({ providers: z.array(ProviderSummarySchema) })
  .strict();
export const ModelListResultSchema = z.object({ models: z.array(ModelDescriptorSchema) }).strict();
export const ConversationListResultSchema = z
  .object({ conversations: z.array(ConversationSchema) })
  .strict();
export const ConversationDetailSchema = z
  .object({ conversation: ConversationSchema, messages: z.array(ChatMessageSchema) })
  .strict();
export const ChatSendResultSchema = z
  .object({ userMessage: ChatMessageSchema, assistantMessage: ChatMessageSchema })
  .strict();
export const ProviderValidationResultSchema = z
  .object({ provider: ProviderSummarySchema, models: z.array(ModelDescriptorSchema) })
  .strict();

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;
export type ProviderConfigureInput = z.infer<typeof ProviderConfigureInputSchema>;
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;
export type AiSettings = z.infer<typeof AiSettingsSchema>;
export type AiSettingsUpdate = z.infer<typeof AiSettingsUpdateSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type ConversationRoutingOverride = z.infer<typeof ConversationRoutingOverrideSchema>;
export type ChatSendInput = z.infer<typeof ChatSendInputSchema>;
export type ChatEditResendInput = z.infer<typeof ChatEditResendInputSchema>;
export type ConversationCreateInput = z.infer<typeof ConversationCreateInputSchema>;
export type ConversationRouteInput = z.infer<typeof ConversationRouteInputSchema>;
export type ChatRetryInput = z.infer<typeof ChatRetryInputSchema>;
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;
export type ChatSendResult = z.infer<typeof ChatSendResultSchema>;
