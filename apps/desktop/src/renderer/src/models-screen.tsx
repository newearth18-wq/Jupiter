import {
  AiSettingsSchema,
  ModelListResultSchema,
  ProviderListResultSchema,
  ProviderSummarySchema,
  ProviderValidationResultSchema,
  type AiSettings,
  type ModelCapability,
  type ModelDescriptor,
  type ProviderSummary,
} from '@jupiter/contracts';
import { Button, EmptyState, StatusBadge, Surface } from '@jupiter/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Translator } from './copy.js';

const DEFAULT_CAPABILITIES: ModelCapability[] = ['chat', 'streaming', 'cancellation', 'usage'];

type ProviderDraft = {
  providerId: string;
  displayName: string;
  baseUrl: string;
  locality: 'cloud' | 'local';
  authScheme: 'bearer' | 'none';
  capabilities: ModelCapability[];
};

const EMPTY_DRAFT: ProviderDraft = {
  providerId: '',
  displayName: '',
  baseUrl: 'http://127.0.0.1:11434/v1',
  locality: 'local',
  authScheme: 'none',
  capabilities: DEFAULT_CAPABILITIES,
};

const ALL_CAPABILITIES: ModelCapability[] = [
  'chat',
  'streaming',
  'reasoning',
  'vision',
  'embeddings',
  'tool_calling',
  'structured_output',
  'cancellation',
  'usage',
];

export function ModelsScreen({
  t,
  onPermissionRequired,
}: {
  t: Translator;
  onPermissionRequired: () => void;
}): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [settings, setSettings] = useState<AiSettings>();
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [pendingRemoval, setPendingRemoval] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const credentialRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [providerResponse, modelResponse, settingsResponse] = await Promise.all([
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
      if (providerResponse.status === 'error') throw new Error(providerResponse.error.message);
      if (modelResponse.status === 'error') throw new Error(modelResponse.error.message);
      if (settingsResponse.status === 'error') throw new Error(settingsResponse.error.message);
      setProviders(ProviderListResultSchema.parse(providerResponse.data).providers);
      setModels(ModelListResultSchema.parse(modelResponse.data).models);
      setSettings(AiSettingsSchema.parse(settingsResponse.data));
      setError(undefined);
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProvider = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const credential = credentialRef.current?.value ?? '';
      const request = window.jupiter.request({
        schemaVersion: 1,
        kind: 'command',
        name: 'providers.configure',
        context: context(),
        payload: {
          providerId: draft.providerId.trim().toLowerCase(),
          displayName: draft.displayName.trim(),
          baseUrl: draft.baseUrl.trim(),
          locality: draft.locality,
          authScheme: draft.authScheme,
          enabled: true,
          capabilities: draft.capabilities,
          ...(credential ? { credential } : {}),
        },
      });
      if (credentialRef.current) credentialRef.current.value = '';
      const response = await request;
      if (response.status === 'error') {
        if (response.error.code === 'PERMISSION_REQUIRED') onPermissionRequired();
        throw new Error(`${response.error.message} ${response.error.userAction}`);
      }
      ProviderSummarySchema.parse(response.data);
      setNotice(t('providerSavedValidated'));
      setDraft(EMPTY_DRAFT);
      await load();
    } catch (saveError) {
      if (credentialRef.current) credentialRef.current.value = '';
      setError(messageOf(saveError));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const validateProvider = async (providerId: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await window.jupiter.request({
        schemaVersion: 1,
        kind: 'command',
        name: 'providers.validate',
        context: context(),
        payload: { providerId },
      });
      if (response.status === 'error') {
        throw new Error(`${response.error.message} ${response.error.userAction}`);
      }
      ProviderValidationResultSchema.parse(response.data);
      setNotice(t('providerValidated'));
      await load();
    } catch (validationError) {
      setError(messageOf(validationError));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const removeProvider = async (providerId: string): Promise<void> => {
    const response = await window.jupiter.request({
      schemaVersion: 1,
      kind: 'command',
      name: 'providers.remove',
      context: context(),
      payload: { providerId },
    });
    if (response.status === 'error') {
      if (response.error.code === 'PERMISSION_REQUIRED') onPermissionRequired();
      setError(response.error.message);
      return;
    }
    setPendingRemoval(undefined);
    setNotice(t('providerRemoved'));
    await load();
  };

  const updateSettings = async (update: Partial<AiSettings>): Promise<void> => {
    const response = await window.jupiter.request({
      schemaVersion: 1,
      kind: 'command',
      name: 'ai.settings.update',
      context: context(),
      payload: update,
    });
    if (response.status === 'error') {
      setError(response.error.message);
      return;
    }
    setSettings(AiSettingsSchema.parse(response.data));
    setNotice(t('routingSaved'));
  };

  return (
    <div className="screen models-screen" data-screen="models">
      <header className="screen-header">
        <span className="j-eyebrow">
          {providers.length > 0 ? t('experimental') : t('notConfigured')}
        </span>
        <h1 data-testid="screen-title">{t('modelsTitle')}</h1>
        <p>{t('modelsDescription')}</p>
      </header>

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="inline-success" role="status">
          {notice}
        </p>
      )}

      <div className="models-grid">
        <Surface className="provider-form">
          <h2>{t('addProvider')}</h2>
          <p>{t('providerFormDescription')}</p>
          <label className="field-row">
            <span>{t('providerId')}</span>
            <input
              autoComplete="off"
              value={draft.providerId}
              onChange={(event) => setDraft({ ...draft, providerId: event.target.value })}
            />
          </label>
          <label className="field-row">
            <span>{t('displayName')}</span>
            <input
              value={draft.displayName}
              onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
            />
          </label>
          <label className="field-row">
            <span>{t('endpoint')}</span>
            <input
              inputMode="url"
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </label>
          <label className="field-row">
            <span>{t('providerLocation')}</span>
            <select
              value={draft.locality}
              onChange={(event) => {
                const locality = event.target.value === 'cloud' ? 'cloud' : 'local';
                setDraft({
                  ...draft,
                  locality,
                  authScheme: locality === 'cloud' ? 'bearer' : draft.authScheme,
                });
              }}
            >
              <option value="local">{t('localProvider')}</option>
              <option value="cloud">{t('cloudProvider')}</option>
            </select>
          </label>
          <label className="field-row">
            <span>{t('authentication')}</span>
            <select
              value={draft.authScheme}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  authScheme: event.target.value === 'bearer' ? 'bearer' : 'none',
                })
              }
            >
              <option value="none">{t('noCredential')}</option>
              <option value="bearer">{t('bearerCredential')}</option>
            </select>
          </label>
          {draft.authScheme === 'bearer' && (
            <label className="field-row">
              <span>{t('apiCredential')}</span>
              <input
                autoComplete="new-password"
                data-testid="provider-credential"
                ref={credentialRef}
                type="password"
              />
            </label>
          )}
          <fieldset className="provider-capabilities">
            <legend>{t('providerCapabilities')}</legend>
            {ALL_CAPABILITIES.map((capability) => {
              const checked = draft.capabilities.includes(capability);
              return (
                <label key={capability}>
                  <input
                    checked={checked}
                    type="checkbox"
                    onChange={() =>
                      setDraft({
                        ...draft,
                        capabilities: checked
                          ? draft.capabilities.filter((entry) => entry !== capability)
                          : [...draft.capabilities, capability],
                      })
                    }
                  />
                  <span>{t(capabilityCopyKey(capability))}</span>
                </label>
              );
            })}
          </fieldset>
          <p className="secure-note">{t('credentialSecurityNote')}</p>
          <Button
            data-testid="save-provider"
            disabled={
              busy ||
              draft.capabilities.length === 0 ||
              !draft.providerId.trim() ||
              !draft.displayName.trim() ||
              !draft.baseUrl.trim()
            }
            type="button"
            onClick={() => void saveProvider()}
          >
            {busy ? t('validating') : t('saveAndValidate')}
          </Button>
        </Surface>

        <Surface className="routing-settings">
          <h2>{t('routingSettings')}</h2>
          {!settings ? (
            <p>{t('loading')}</p>
          ) : (
            <>
              <label className="field-row">
                <span>{t('routingMode')}</span>
                <select
                  data-testid="routing-mode"
                  value={settings.routingMode}
                  onChange={(event) =>
                    void updateSettings({
                      routingMode: event.target.value as AiSettings['routingMode'],
                    })
                  }
                >
                  {['AUTO', 'CLOUD', 'HYBRID', 'LOCAL_ONLY'].map((mode) => (
                    <option key={mode}>{mode}</option>
                  ))}
                </select>
              </label>
              <label className="field-row">
                <span>{t('preferredProvider')}</span>
                <select
                  value={settings.preferredProviderId ?? ''}
                  onChange={(event) =>
                    void updateSettings({ preferredProviderId: event.target.value || undefined })
                  }
                >
                  <option value="">{t('providerAuto')}</option>
                  {providers.map((provider) => (
                    <option key={provider.providerId} value={provider.providerId}>
                      {provider.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-row">
                <span>{t('preferredChatModel')}</span>
                <select
                  value={settings.preferredChatModel ?? ''}
                  onChange={(event) =>
                    void updateSettings({ preferredChatModel: event.target.value || undefined })
                  }
                >
                  <option value="">{t('providerAuto')}</option>
                  {models.map((model) => (
                    <option key={`${model.providerId}:${model.modelId}`} value={model.modelId}>
                      {model.providerId} / {model.modelId}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-row">
                <span>{t('preferredReasoningModel')}</span>
                <select
                  value={settings.preferredReasoningModel ?? ''}
                  onChange={(event) =>
                    void updateSettings({
                      preferredReasoningModel: event.target.value || undefined,
                    })
                  }
                >
                  <option value="">{t('providerAuto')}</option>
                  {models
                    .filter((model) => model.capabilities.includes('reasoning'))
                    .map((model) => (
                      <option key={`${model.providerId}:${model.modelId}`} value={model.modelId}>
                        {model.providerId} / {model.modelId}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field-row">
                <span>{t('preferredVisionModel')}</span>
                <select
                  value={settings.preferredVisionModel ?? ''}
                  onChange={(event) =>
                    void updateSettings({ preferredVisionModel: event.target.value || undefined })
                  }
                >
                  <option value="">{t('providerAuto')}</option>
                  {models
                    .filter((model) => model.capabilities.includes('vision'))
                    .map((model) => (
                      <option key={`${model.providerId}:${model.modelId}`} value={model.modelId}>
                        {model.providerId} / {model.modelId}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field-row">
                <span>{t('preferredEmbeddingModel')}</span>
                <select
                  value={settings.preferredEmbeddingModel ?? ''}
                  onChange={(event) =>
                    void updateSettings({
                      preferredEmbeddingModel: event.target.value || undefined,
                    })
                  }
                >
                  <option value="">{t('providerAuto')}</option>
                  {models
                    .filter((model) => model.capabilities.includes('embeddings'))
                    .map((model) => (
                      <option key={`${model.providerId}:${model.modelId}`} value={model.modelId}>
                        {model.providerId} / {model.modelId}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field-row">
                <span>{t('fallbackPolicy')}</span>
                <select
                  value={settings.fallbackPolicy}
                  onChange={(event) =>
                    void updateSettings({
                      fallbackPolicy: event.target.value as AiSettings['fallbackPolicy'],
                    })
                  }
                >
                  <option value="NONE">{t('noFallback')}</option>
                  <option value="SAME_LOCALITY">{t('sameLocalityFallback')}</option>
                  <option value="EXPLICIT">{t('explicitFallback')}</option>
                </select>
              </label>
              <label className="field-row">
                <span>{t('optimization')}</span>
                <select
                  value={settings.optimization}
                  onChange={(event) =>
                    void updateSettings({
                      optimization: event.target.value as AiSettings['optimization'],
                    })
                  }
                >
                  <option value="balanced">{t('balanced')}</option>
                  <option value="cost">{t('cost')}</option>
                  <option value="latency">{t('latency')}</option>
                </select>
              </label>
              {settings.fallbackPolicy === 'EXPLICIT' && (
                <fieldset className="fallback-provider-list">
                  <legend>{t('approvedFallbackProviders')}</legend>
                  {providers.length === 0 ? (
                    <p>{t('noProviders')}</p>
                  ) : (
                    providers.map((provider) => {
                      const checked = settings.fallbackProviderIds.includes(provider.providerId);
                      return (
                        <label key={provider.providerId}>
                          <input
                            checked={checked}
                            type="checkbox"
                            onChange={() =>
                              void updateSettings({
                                fallbackProviderIds: checked
                                  ? settings.fallbackProviderIds.filter(
                                      (providerId) => providerId !== provider.providerId,
                                    )
                                  : [...settings.fallbackProviderIds, provider.providerId],
                              })
                            }
                          />
                          <span>{provider.displayName}</span>
                        </label>
                      );
                    })
                  )}
                </fieldset>
              )}
              <p className="secure-note">{t('localOnlyDescription')}</p>
            </>
          )}
        </Surface>
      </div>

      <Surface className="provider-list-panel">
        <div className="panel-heading">
          <h2>{t('configuredProviders')}</h2>
          <StatusBadge tone="neutral">{String(providers.length)}</StatusBadge>
        </div>
        {providers.length === 0 ? (
          <EmptyState
            eyebrow={t('notConfigured')}
            title={t('noProviders')}
            description={t('noProvidersDescription')}
          />
        ) : (
          <div className="provider-cards">
            {providers.map((provider) => (
              <article className="provider-card" key={provider.providerId}>
                <div className="panel-heading">
                  <div>
                    <strong>{provider.displayName}</strong>
                    <code>{provider.providerId}</code>
                  </div>
                  <StatusBadge
                    tone={
                      provider.health === 'operational'
                        ? 'success'
                        : provider.authState === 'invalid'
                          ? 'error'
                          : 'warning'
                    }
                  >
                    {provider.health}
                  </StatusBadge>
                </div>
                <dl>
                  <div>
                    <dt>{t('endpoint')}</dt>
                    <dd>{provider.baseUrl}</dd>
                  </div>
                  <div>
                    <dt>{t('authentication')}</dt>
                    <dd>{provider.authState}</dd>
                  </div>
                  <div>
                    <dt>{t('credentialFingerprint')}</dt>
                    <dd>{provider.credentialFingerprint ?? t('none')}</dd>
                  </div>
                  <div>
                    <dt>{t('discoveredModels')}</dt>
                    <dd>
                      {models.filter((model) => model.providerId === provider.providerId).length}
                    </dd>
                  </div>
                </dl>
                {provider.sanitizedError && (
                  <p className="inline-error">{provider.sanitizedError}</p>
                )}
                <div className="button-row">
                  <Button
                    disabled={busy}
                    type="button"
                    variant="secondary"
                    onClick={() => void validateProvider(provider.providerId)}
                  >
                    {t('validateAgain')}
                  </Button>
                  {pendingRemoval === provider.providerId ? (
                    <>
                      <span>{t('confirmProviderRemoval')}</span>
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => void removeProvider(provider.providerId)}
                      >
                        {t('confirmRemove')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setPendingRemoval(undefined)}
                      >
                        {t('cancel')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setPendingRemoval(provider.providerId)}
                    >
                      {t('remove')}
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </Surface>
    </div>
  );
}

function context() {
  return {
    requestId: crypto.randomUUID(),
    actor: 'renderer' as const,
    timestamp: new Date().toISOString(),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : 'Jupiter could not complete the request.';
}

function capabilityCopyKey(
  capability: ModelCapability,
):
  | 'capabilityChat'
  | 'capabilityStreaming'
  | 'capabilityReasoning'
  | 'capabilityVision'
  | 'capabilityEmbeddings'
  | 'capabilityToolCalling'
  | 'capabilityStructuredOutput'
  | 'capabilityCancellation'
  | 'capabilityUsage' {
  return (
    {
      chat: 'capabilityChat',
      streaming: 'capabilityStreaming',
      reasoning: 'capabilityReasoning',
      vision: 'capabilityVision',
      embeddings: 'capabilityEmbeddings',
      tool_calling: 'capabilityToolCalling',
      structured_output: 'capabilityStructuredOutput',
      cancellation: 'capabilityCancellation',
      usage: 'capabilityUsage',
    } as const
  )[capability];
}
