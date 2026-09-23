import {
  AiSettingsSchema,
  ChatSendResultSchema,
  ConversationDetailSchema,
  ConversationListResultSchema,
  ModelListResultSchema,
  ProviderListResultSchema,
  type ChatMessage,
  type ChatStreamEvent,
  type Conversation,
  type ModelDescriptor,
  type ProviderSummary,
} from '@jupiter/contracts';
import { Button, EmptyState, StatusBadge, Surface } from '@jupiter/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Translator } from './copy.js';

type ConversationDetail = ReturnType<typeof ConversationDetailSchema.parse>;

export function ChatScreen({ t }: { t: Translator }): React.JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [detail, setDetail] = useState<ConversationDetail>();
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [composer, setComposer] = useState('');
  const [editTarget, setEditTarget] = useState<ChatMessage>();
  const [activeRequestId, setActiveRequestId] = useState<string>();
  const activeRequestRef = useRef<string | undefined>(undefined);
  const [stream, setStream] = useState<{ messageId?: string; content: string; status: string }>({
    content: '',
    status: 'idle',
  });
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const loadConversation = useCallback(async (conversationId: string): Promise<void> => {
    const response = await window.jupiter.request({
      schemaVersion: 1,
      kind: 'query',
      name: 'chat.conversation.get',
      context: context(),
      payload: { conversationId },
    });
    if (response.status === 'error') throw new Error(response.error.message);
    setDetail(ConversationDetailSchema.parse(response.data));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [conversationResponse, providerResponse, modelResponse, settingsResponse] =
        await Promise.all([
          window.jupiter.request({
            schemaVersion: 1,
            kind: 'query',
            name: 'chat.conversations.list',
            context: context(),
            payload: {},
          }),
          window.jupiter.request({
            schemaVersion: 1,
            kind: 'query',
            name: 'providers.list',
            context: context(),
            payload: {},
          }),
          window.jupiter.request({
            schemaVersion: 1,
            kind: 'query',
            name: 'models.list',
            context: context(),
            payload: {},
          }),
          window.jupiter.request({
            schemaVersion: 1,
            kind: 'query',
            name: 'ai.settings.get',
            context: context(),
            payload: {},
          }),
        ]);
      if (conversationResponse.status === 'error')
        throw new Error(conversationResponse.error.message);
      if (providerResponse.status === 'error') throw new Error(providerResponse.error.message);
      if (modelResponse.status === 'error') throw new Error(modelResponse.error.message);
      if (settingsResponse.status === 'error') throw new Error(settingsResponse.error.message);
      const nextConversations = ConversationListResultSchema.parse(
        conversationResponse.data,
      ).conversations;
      setConversations(nextConversations);
      setProviders(ProviderListResultSchema.parse(providerResponse.data).providers);
      setModels(ModelListResultSchema.parse(modelResponse.data).models);
      AiSettingsSchema.parse(settingsResponse.data);
      const selected = detail?.conversation.conversationId ?? nextConversations[0]?.conversationId;
      if (selected) await loadConversation(selected);
      setError(undefined);
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [detail?.conversation.conversationId, loadConversation]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      window.jupiter.onChatStream((event: ChatStreamEvent) => {
        if (event.requestId !== activeRequestRef.current) return;
        if (event.type === 'started') {
          setStream({ messageId: event.messageId, content: '', status: 'streaming' });
        } else if (event.type === 'delta') {
          setStream((current) => ({ ...current, content: current.content + (event.delta ?? '') }));
        } else if (event.type === 'cancelled' || event.type === 'failed') {
          setStream((current) => ({ ...current, status: event.type }));
          if (event.sanitizedError) setError(event.sanitizedError);
        } else if (event.type === 'completed') {
          setStream((current) => ({ ...current, status: 'complete' }));
        }
      }),
    [],
  );

  const configured = providers.some(
    (provider) => provider.enabled && provider.health === 'operational',
  );
  const providerIndicator = useMemo(() => {
    const lastAssistant = [...(detail?.messages ?? [])]
      .reverse()
      .find((message) => message.role === 'assistant' && message.providerId);
    if (!lastAssistant) return t('providerAuto');
    return `${lastAssistant.providerId ?? ''} / ${lastAssistant.modelId ?? ''}`;
  }, [detail?.messages, t]);

  const createConversation = async (): Promise<Conversation> => {
    const response = await window.jupiter.request({
      schemaVersion: 1,
      kind: 'command',
      name: 'chat.conversation.create',
      context: context(),
      payload: { title: t('newConversation') },
    });
    if (response.status === 'error') throw new Error(response.error.message);
    const conversation = response.data as Conversation;
    setConversations((current) => [conversation, ...current]);
    setDetail({ conversation, messages: [] });
    return conversation;
  };

  const runGeneration = async (
    name: 'chat.send' | 'chat.retry' | 'chat.edit_resend',
    payload:
      | { conversationId: string; content: string; attachments: never[] }
      | { messageId: string; content?: string },
  ): Promise<void> => {
    const requestId = crypto.randomUUID();
    activeRequestRef.current = requestId;
    setActiveRequestId(requestId);
    setStream({ content: '', status: 'starting' });
    setError(undefined);
    try {
      const response = await window.jupiter.request(
        name === 'chat.send'
          ? {
              schemaVersion: 1,
              kind: 'command',
              name,
              context: context(requestId),
              payload,
            }
          : name === 'chat.retry'
            ? {
                schemaVersion: 1,
                kind: 'command',
                name,
                context: context(requestId),
                payload: { messageId: (payload as { messageId: string }).messageId },
              }
            : {
                schemaVersion: 1,
                kind: 'command',
                name,
                context: context(requestId),
                payload,
              },
      );
      if (response.status === 'error') {
        throw new Error(`${response.error.message} ${response.error.userAction}`);
      }
      const result = ChatSendResultSchema.parse(response.data);
      await loadConversation(result.userMessage.conversationId);
      setComposer('');
      setEditTarget(undefined);
    } catch (generationError) {
      setError(messageOf(generationError));
      if (detail) await loadConversation(detail.conversation.conversationId).catch(() => undefined);
    } finally {
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = undefined;
        setActiveRequestId(undefined);
      }
    }
  };

  const send = async (): Promise<void> => {
    if (!composer.trim() || activeRequestId) return;
    try {
      const conversation = detail?.conversation ?? (await createConversation());
      if (editTarget) {
        await runGeneration('chat.edit_resend', {
          messageId: editTarget.messageId,
          content: composer,
        });
      } else {
        await runGeneration('chat.send', {
          conversationId: conversation.conversationId,
          content: composer,
          attachments: [],
        });
      }
    } catch (sendError) {
      setError(messageOf(sendError));
    }
  };

  const updateRoute = async (field: 'routingMode' | 'providerId' | 'modelId', value: string) => {
    if (!detail) return;
    const current = detail.conversation.routingOverride ?? {};
    const routingOverride = { ...current, [field]: value || undefined };
    const response = await window.jupiter.request({
      schemaVersion: 1,
      kind: 'command',
      name: 'chat.conversation.route',
      context: context(),
      payload: { conversationId: detail.conversation.conversationId, routingOverride },
    });
    if (response.status === 'error') {
      setError(response.error.message);
      return;
    }
    setDetail((currentDetail) =>
      currentDetail
        ? { ...currentDetail, conversation: response.data as Conversation }
        : currentDetail,
    );
  };

  return (
    <div className="screen chat-screen" data-screen="chat">
      <header className="screen-header chat-heading">
        <div>
          <span className="j-eyebrow">{configured ? t('operational') : t('notConfigured')}</span>
          <h1 data-testid="screen-title">{t('chatTitle')}</h1>
          <p>{t('chatDescription')}</p>
        </div>
        <StatusBadge tone={configured ? 'success' : 'warning'}>
          <span data-testid="provider-indicator">{providerIndicator}</span>
        </StatusBadge>
      </header>

      <div className="chat-layout">
        <Surface className="conversation-sidebar">
          <Button type="button" onClick={() => void createConversation()}>
            {t('newConversation')}
          </Button>
          <div className="conversation-list" aria-label={t('conversationHistory')}>
            {conversations.map((conversation) => (
              <button
                aria-current={detail?.conversation.conversationId === conversation.conversationId}
                key={conversation.conversationId}
                type="button"
                onClick={() => void loadConversation(conversation.conversationId)}
              >
                {conversation.title}
              </button>
            ))}
          </div>
        </Surface>

        <div className="chat-main">
          <Surface className="route-bar">
            <label>
              <span>{t('routingMode')}</span>
              <select
                aria-label={t('routingMode')}
                value={detail?.conversation.routingOverride?.routingMode ?? ''}
                onChange={(event) => void updateRoute('routingMode', event.target.value)}
              >
                <option value="">{t('useGlobalSetting')}</option>
                {['AUTO', 'CLOUD', 'HYBRID', 'LOCAL_ONLY'].map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('provider')}</span>
              <select
                value={detail?.conversation.routingOverride?.providerId ?? ''}
                onChange={(event) => void updateRoute('providerId', event.target.value)}
              >
                <option value="">{t('providerAuto')}</option>
                {providers
                  .filter((provider) => provider.enabled)
                  .map((provider) => (
                    <option key={provider.providerId} value={provider.providerId}>
                      {provider.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>{t('model')}</span>
              <select
                value={detail?.conversation.routingOverride?.modelId ?? ''}
                onChange={(event) => void updateRoute('modelId', event.target.value)}
              >
                <option value="">{t('providerAuto')}</option>
                {models.map((model) => (
                  <option key={`${model.providerId}:${model.modelId}`} value={model.modelId}>
                    {model.modelId}
                  </option>
                ))}
              </select>
            </label>
          </Surface>

          <Surface className="message-list" aria-live="polite">
            {loading ? (
              <p>{t('loading')}</p>
            ) : !detail || detail.messages.length === 0 ? (
              <EmptyState
                description={configured ? t('chatReadyDescription') : t('configureProviderFirst')}
                eyebrow={configured ? t('operational') : t('notConfigured')}
                title={t('noMessages')}
              />
            ) : (
              detail.messages.map((message) => (
                <ChatMessageView
                  key={message.messageId}
                  message={message}
                  t={t}
                  onEdit={(target) => {
                    setEditTarget(target);
                    setComposer(target.content);
                  }}
                  onRetry={(target) =>
                    void runGeneration('chat.retry', { messageId: target.messageId })
                  }
                />
              ))
            )}
            {activeRequestId && stream.messageId && (
              <article
                className="chat-message chat-message--assistant"
                data-testid="chat-stream-output"
              >
                <div className="message-meta">
                  <strong>{t('assistant')}</strong>
                </div>
                <p>{stream.content || t('waitingForProvider')}</p>
              </article>
            )}
          </Surface>

          {error && (
            <div className="chat-error" role="alert">
              <span>{error}</span>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  window.location.hash = '#/models';
                }}
              >
                {t('configureProviders')}
              </Button>
            </div>
          )}

          <Surface className="composer-shell chat-composer">
            <label htmlFor="chat-composer">
              {editTarget ? t('editAndResend') : t('composerLabel')}
            </label>
            <textarea
              data-testid="chat-composer"
              disabled={!configured || activeRequestId !== undefined}
              id="chat-composer"
              placeholder={configured ? t('composerReadyPlaceholder') : t('composerPlaceholder')}
              rows={3}
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-actions">
              <Button disabled type="button" variant="ghost">
                {t('attachmentsUnavailable')}
              </Button>
              {editTarget && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditTarget(undefined);
                    setComposer('');
                  }}
                >
                  {t('cancelEdit')}
                </Button>
              )}
              {activeRequestId ? (
                <Button
                  data-testid="stop-generation"
                  type="button"
                  variant="danger"
                  onClick={() => void window.jupiter.cancel(activeRequestId)}
                >
                  {t('stopGeneration')}
                </Button>
              ) : (
                <Button
                  data-testid="chat-send"
                  disabled={!configured || composer.trim().length === 0}
                  type="button"
                  onClick={() => void send()}
                >
                  {t('send')}
                </Button>
              )}
            </div>
          </Surface>
        </div>
      </div>
    </div>
  );
}

function ChatMessageView({
  message,
  t,
  onEdit,
  onRetry,
}: {
  message: ChatMessage;
  t: Translator;
  onEdit: (message: ChatMessage) => void;
  onRetry: (message: ChatMessage) => void;
}): React.JSX.Element {
  return (
    <article className={`chat-message chat-message--${message.role}`}>
      <div className="message-meta">
        <strong>
          {t(message.role === 'user' ? 'you' : message.role === 'assistant' ? 'assistant' : 'tool')}
        </strong>
        {message.providerId && (
          <span>
            {message.providerId} / {message.modelId}
          </span>
        )}
        <StatusBadge
          tone={
            message.status === 'failed'
              ? 'error'
              : message.status === 'cancelled'
                ? 'warning'
                : 'neutral'
          }
        >
          {message.status}
        </StatusBadge>
      </div>
      <p>{message.content || t('emptyProviderResponse')}</p>
      {message.toolCalls.map((toolCall) => (
        <details className="tool-call" key={toolCall.toolCallId}>
          <summary>
            {t('toolCall')}: {toolCall.name}
          </summary>
          <pre>{toolCall.argumentsSummary}</pre>
        </details>
      ))}
      {message.role === 'user' && (
        <div className="message-actions">
          <Button type="button" variant="ghost" onClick={() => onEdit(message)}>
            {t('edit')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onRetry(message)}>
            {t('retry')}
          </Button>
        </div>
      )}
    </article>
  );
}

function context(requestId = crypto.randomUUID()) {
  return {
    requestId,
    actor: 'renderer' as const,
    timestamp: new Date().toISOString(),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : 'Jupiter could not complete the request.';
}
