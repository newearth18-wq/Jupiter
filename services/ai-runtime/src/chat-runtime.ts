import { createHash, randomUUID } from 'node:crypto';
import {
  AiSettingsSchema,
  AiSettingsUpdateSchema,
  ChatEditResendInputSchema,
  ChatMessageSchema,
  ChatRetryInputSchema,
  ChatSendInputSchema,
  ChatStreamEventSchema,
  ConversationCreateInputSchema,
  ConversationRouteInputSchema,
  ConversationSchema,
  DEFAULT_AI_SETTINGS,
  ProviderConfigureInputSchema,
  ProviderSummarySchema,
  type AiSettings,
  type AiSettingsUpdate,
  type ChatEditResendInput,
  type ChatMessage,
  type ChatRetryInput,
  type ChatSendInput,
  type ChatSendResult,
  type ChatStreamEvent,
  type Conversation,
  type ConversationCreateInput,
  type ConversationRouteInput,
  type ModelDescriptor,
  type ProviderConfigureInput,
  type ProviderSummary,
} from '@jupiter/contracts';
import { JupiterError, type AiRepository, type ChatRuntime } from '@jupiter/core';
import { ModelRouter, type RouteSelection } from './model-router.js';
import { OpenAiCompatibleProvider } from './openai-compatible-provider.js';
import type { CredentialVault, FetchLike, ProviderAdapter } from './types.js';

export type AiRuntimeDependencies = {
  repository: AiRepository;
  credentialVault: CredentialVault;
  fetchImplementation?: FetchLike;
  recordEvent?: (input: {
    type: string;
    correlationId: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: string;
  }) => void;
  now?: () => Date;
};

export class ProviderAgnosticChatRuntime implements ChatRuntime {
  readonly #repository: AiRepository;
  readonly #credentialVault: CredentialVault;
  readonly #fetchImplementation: FetchLike;
  readonly #recordEvent: AiRuntimeDependencies['recordEvent'];
  readonly #now: () => Date;
  readonly #router = new ModelRouter();
  readonly #listeners = new Set<(event: ChatStreamEvent) => void>();

  constructor(dependencies: AiRuntimeDependencies) {
    this.#repository = dependencies.repository;
    this.#credentialVault = dependencies.credentialVault;
    this.#fetchImplementation = dependencies.fetchImplementation ?? fetch;
    this.#recordEvent = dependencies.recordEvent;
    this.#now = dependencies.now ?? (() => new Date());
  }

  listProviders(): ProviderSummary[] {
    return this.#repository.listProviders();
  }

  async configureProvider(
    input: ProviderConfigureInput,
    signal: AbortSignal,
  ): Promise<ProviderSummary> {
    const valid = ProviderConfigureInputSchema.parse(input);
    const existing = this.#repository.getProvider(valid.providerId);
    const timestamp = this.#timestamp();
    let fingerprint = existing?.credentialFingerprint;
    let authState: ProviderSummary['authState'] = existing?.authState ?? 'not_configured';
    if (valid.clearCredential === true) {
      await this.#credentialVault.delete(valid.providerId);
      fingerprint = undefined;
      authState = valid.authScheme === 'none' ? 'valid' : 'not_configured';
    } else if (valid.credential !== undefined) {
      fingerprint = await this.#credentialVault.set(valid.providerId, valid.credential);
      authState = 'stored';
    } else if (valid.authScheme === 'none') {
      authState = 'valid';
    }
    const provider = ProviderSummarySchema.parse({
      providerId: valid.providerId,
      displayName: valid.displayName,
      baseUrl: normalizeBaseUrl(valid.baseUrl),
      locality: valid.locality,
      authScheme: valid.authScheme,
      enabled: valid.enabled,
      capabilities: valid.capabilities,
      authState,
      health: 'not_configured',
      ...(fingerprint === undefined ? {} : { credentialFingerprint: fingerprint }),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    this.#repository.upsertProvider(provider);
    if (!valid.enabled) return provider;
    return (await this.validateProvider(valid.providerId, signal)).provider;
  }

  async removeProvider(providerId: string): Promise<boolean> {
    const exists = this.#repository.getProvider(providerId) !== undefined;
    await this.#credentialVault.delete(providerId);
    this.#repository.removeProvider(providerId);
    return exists;
  }

  async validateProvider(
    providerId: string,
    signal: AbortSignal,
  ): Promise<{ provider: ProviderSummary; models: ModelDescriptor[] }> {
    const provider = this.#requiredProvider(providerId);
    const credential = await this.#credentialVault.get(providerId);
    try {
      const models = await this.#adapter(provider).discoverModels(credential, signal);
      const updated = ProviderSummarySchema.parse({
        ...provider,
        authState: provider.authScheme === 'none' || credential ? 'valid' : 'not_configured',
        health: 'operational',
        lastValidatedAt: this.#timestamp(),
        sanitizedError: undefined,
        updatedAt: this.#timestamp(),
      });
      this.#repository.upsertProvider(updated);
      this.#repository.replaceModels(providerId, models);
      return { provider: updated, models };
    } catch (error) {
      const known = toJupiterError(error);
      const updated = ProviderSummarySchema.parse({
        ...provider,
        authState: known.code === 'PROVIDER_AUTH_INVALID' ? 'invalid' : provider.authState,
        health: 'unavailable',
        lastValidatedAt: this.#timestamp(),
        sanitizedError: known.message,
        updatedAt: this.#timestamp(),
      });
      this.#repository.upsertProvider(updated);
      throw known;
    }
  }

  listModels(providerId?: string): ModelDescriptor[] {
    return this.#repository.listModels(providerId);
  }

  async discoverModels(providerId: string, signal: AbortSignal): Promise<ModelDescriptor[]> {
    return (await this.validateProvider(providerId, signal)).models;
  }

  getSettings(): AiSettings {
    return this.#repository.getAiSettings() ?? DEFAULT_AI_SETTINGS;
  }

  updateSettings(update: AiSettingsUpdate): AiSettings {
    const valid = AiSettingsUpdateSchema.parse(update);
    const settings = AiSettingsSchema.parse({ ...this.getSettings(), ...valid });
    this.#repository.setAiSettings(settings);
    return settings;
  }

  listConversations(): Conversation[] {
    return this.#repository.listConversations();
  }

  createConversation(input: ConversationCreateInput): Conversation {
    const valid = ConversationCreateInputSchema.parse(input);
    const timestamp = this.#timestamp();
    const conversation = ConversationSchema.parse({
      conversationId: randomUUID(),
      title: valid.title ?? 'New conversation',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#repository.createConversation(conversation);
    return conversation;
  }

  getConversation(conversationId: string): {
    conversation: Conversation;
    messages: ChatMessage[];
  } {
    const conversation = this.#repository.getConversation(conversationId);
    if (!conversation) throw notFound('Conversation');
    return { conversation, messages: this.#repository.listMessages(conversationId) };
  }

  updateConversationRoute(input: ConversationRouteInput): Conversation {
    const valid = ConversationRouteInputSchema.parse(input);
    const conversation = this.#repository.getConversation(valid.conversationId);
    if (!conversation) throw notFound('Conversation');
    const updated = ConversationSchema.parse({
      ...conversation,
      ...(valid.routingOverride === null ? { routingOverride: undefined } : valid),
      updatedAt: this.#timestamp(),
    });
    this.#repository.updateConversation(updated);
    return updated;
  }

  send(input: ChatSendInput, requestId: string, signal: AbortSignal): Promise<ChatSendResult> {
    return this.#send(ChatSendInputSchema.parse(input), requestId, signal);
  }

  retry(input: ChatRetryInput, requestId: string, signal: AbortSignal): Promise<ChatSendResult> {
    const valid = ChatRetryInputSchema.parse(input);
    const message = this.#repository.getMessage(valid.messageId);
    if (message?.role !== 'user') throw notFound('User message');
    return this.#send(
      {
        conversationId: message.conversationId,
        content: message.content,
        attachments: message.attachments,
      },
      requestId,
      signal,
    );
  }

  editAndResend(
    input: ChatEditResendInput,
    requestId: string,
    signal: AbortSignal,
  ): Promise<ChatSendResult> {
    const valid = ChatEditResendInputSchema.parse(input);
    const message = this.#repository.getMessage(valid.messageId);
    if (message?.role !== 'user') throw notFound('User message');
    return this.#send(
      {
        conversationId: message.conversationId,
        content: valid.content,
        attachments: message.attachments,
        sourceMessageId: message.messageId,
      },
      requestId,
      signal,
    );
  }

  subscribe(listener: (event: ChatStreamEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  shutdown(): Promise<void> {
    this.#listeners.clear();
    return Promise.resolve();
  }

  async #send(
    input: ChatSendInput,
    requestId: string,
    signal: AbortSignal,
  ): Promise<ChatSendResult> {
    const conversation = this.#repository.getConversation(input.conversationId);
    if (!conversation) throw notFound('Conversation');
    const previous = this.#repository.listMessages(input.conversationId);
    const userMessage = this.#message({
      conversationId: conversation.conversationId,
      role: 'user',
      content: input.content,
      attachments: input.attachments,
      status: 'complete',
    });
    this.#repository.upsertMessage(userMessage);
    if (!previous.some((message) => message.role === 'user')) {
      this.#repository.updateConversation(
        ConversationSchema.parse({
          ...conversation,
          title: input.content.replace(/\s+/g, ' ').slice(0, 80),
          updatedAt: this.#timestamp(),
        }),
      );
    }

    const selections = this.#router.select(
      this.#repository.listProviders(),
      this.#repository.listModels(),
      this.getSettings(),
      conversation.routingOverride,
      'chat',
    );
    const messages = [...previous, userMessage].map(({ role, content }) => ({ role, content }));
    let lastError: JupiterError | undefined;
    for (const [index, selection] of selections.entries()) {
      if (signal.aborted) throw cancelledError();
      try {
        return await this.#runSelection(selection, messages, userMessage, requestId, signal);
      } catch (error) {
        const known = toJupiterError(error);
        lastError = known;
        if (known.category === 'cancellation' || index === selections.length - 1) throw known;
        this.#recordEvent?.({
          type: 'ai.route.fallback',
          correlationId: requestId,
          payload: {
            fromProviderId: selection.provider.providerId,
            toProviderId: selections[index + 1]?.provider.providerId,
            reasonCode: known.code,
          },
          occurredAt: this.#timestamp(),
        });
      }
    }
    throw lastError ?? notFound('Compatible model');
  }

  async #runSelection(
    selection: RouteSelection,
    messages: readonly Pick<ChatMessage, 'role' | 'content'>[],
    userMessage: ChatMessage,
    requestId: string,
    signal: AbortSignal,
  ): Promise<ChatSendResult> {
    const assistantMessage = this.#message({
      conversationId: userMessage.conversationId,
      role: 'assistant',
      content: '',
      attachments: [],
      status: 'streaming',
      providerId: selection.provider.providerId,
      modelId: selection.model.modelId,
    });
    this.#repository.upsertMessage(assistantMessage);
    this.#emit({
      requestId,
      conversationId: userMessage.conversationId,
      messageId: assistantMessage.messageId,
      type: 'started',
      providerId: selection.provider.providerId,
      modelId: selection.model.modelId,
    });
    let partial = '';
    try {
      const credential = await this.#credentialVault.get(selection.provider.providerId);
      const completion = await this.#adapter(selection.provider).streamChat(
        { modelId: selection.model.modelId, messages, credential },
        (delta) => {
          partial += delta;
          this.#emit({
            requestId,
            conversationId: userMessage.conversationId,
            messageId: assistantMessage.messageId,
            type: 'delta',
            delta,
            providerId: selection.provider.providerId,
            modelId: selection.model.modelId,
          });
        },
        signal,
      );
      const completed = ChatMessageSchema.parse({
        ...assistantMessage,
        content: completion.content,
        toolCalls: completion.toolCalls,
        status: 'complete',
        ...(completion.usage === undefined ? {} : { usage: completion.usage }),
        updatedAt: this.#timestamp(),
      });
      this.#repository.upsertMessage(completed);
      for (const toolCall of completed.toolCalls) {
        this.#emit({
          requestId,
          conversationId: completed.conversationId,
          messageId: completed.messageId,
          type: 'tool_call',
          toolCall,
        });
      }
      this.#emit({
        requestId,
        conversationId: completed.conversationId,
        messageId: completed.messageId,
        type: 'completed',
        providerId: completed.providerId,
        modelId: completed.modelId,
      });
      return { userMessage, assistantMessage: completed };
    } catch (error) {
      const known = signal.aborted ? cancelledError() : toJupiterError(error);
      const failed = ChatMessageSchema.parse({
        ...assistantMessage,
        content: partial,
        status: known.category === 'cancellation' ? 'cancelled' : 'failed',
        updatedAt: this.#timestamp(),
      });
      this.#repository.upsertMessage(failed);
      this.#emit({
        requestId,
        conversationId: failed.conversationId,
        messageId: failed.messageId,
        type: known.category === 'cancellation' ? 'cancelled' : 'failed',
        sanitizedError: known.message,
        providerId: failed.providerId,
        modelId: failed.modelId,
      });
      if (partial.length > 0 && known.category !== 'cancellation') {
        throw new JupiterError({
          code: 'PARTIAL_RESPONSE_FAILED',
          category: known.category,
          message: 'Provider failed after returning a partial response.',
          recoverable: known.recoverable,
          retryable: known.retryable,
          userAction: known.userAction,
          ...(known.sanitizedDetails === undefined
            ? {}
            : { sanitizedDetails: known.sanitizedDetails }),
        });
      }
      throw known;
    }
  }

  #message(input: {
    conversationId: string;
    role: ChatMessage['role'];
    content: string;
    attachments: ChatMessage['attachments'];
    status: ChatMessage['status'];
    providerId?: string;
    modelId?: string;
  }): ChatMessage {
    const timestamp = this.#timestamp();
    return ChatMessageSchema.parse({
      messageId: randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      attachments: input.attachments,
      toolCalls: [],
      status: input.status,
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  #requiredProvider(providerId: string): ProviderSummary {
    const provider = this.#repository.getProvider(providerId);
    if (!provider) throw notFound('Provider');
    return provider;
  }

  #adapter(provider: ProviderSummary): ProviderAdapter {
    return new OpenAiCompatibleProvider(provider, this.#fetchImplementation);
  }

  #emit(input: Omit<ChatStreamEvent, 'schemaVersion' | 'timestamp'>): void {
    const event = ChatStreamEventSchema.parse({
      schemaVersion: 1,
      ...input,
      timestamp: this.#timestamp(),
    });
    for (const listener of this.#listeners) listener(event);
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function notFound(target: string): JupiterError {
  return new JupiterError({
    code: `${target.toUpperCase().replace(/\s+/g, '_')}_NOT_FOUND`,
    category: 'configuration',
    message: `${target} was not found.`,
    recoverable: true,
    retryable: false,
    userAction: `Select an available ${target.toLowerCase()} and retry.`,
  });
}

function cancelledError(): JupiterError {
  return new JupiterError({
    code: 'REQUEST_CANCELLED',
    category: 'cancellation',
    message: 'Generation was cancelled.',
    recoverable: true,
    retryable: true,
    userAction: 'Edit or resend the message when ready.',
  });
}

function toJupiterError(error: unknown): JupiterError {
  if (error instanceof JupiterError) return error;
  return new JupiterError({
    code: 'PROVIDER_RUNTIME_ERROR',
    category: 'provider',
    message: 'Provider request failed.',
    recoverable: true,
    retryable: true,
    userAction: 'Review provider health and retry.',
  });
}

export function credentialFingerprint(credential: string): string {
  return `sha256:${createHash('sha256').update(credential).digest('hex').slice(0, 8)}`;
}
