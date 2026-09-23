import type {
  AiSettings,
  ConversationRoutingOverride,
  ModelCapability,
  ModelDescriptor,
  ProviderSummary,
} from '@jupiter/contracts';
import { JupiterError } from '@jupiter/core';

export type RouteSelection = { provider: ProviderSummary; model: ModelDescriptor };

export class ModelRouter {
  select(
    providers: readonly ProviderSummary[],
    models: readonly ModelDescriptor[],
    settings: AiSettings,
    override: ConversationRoutingOverride | undefined,
    capability: ModelCapability,
  ): RouteSelection[] {
    const mode = override?.routingMode ?? settings.routingMode;
    const providerId = override?.providerId ?? settings.preferredProviderId;
    const modelId = override?.modelId ?? preferredModel(settings, capability);
    const eligibleProviders = providers.filter(
      (provider) =>
        provider.enabled &&
        provider.health !== 'unavailable' &&
        provider.authState !== 'invalid' &&
        provider.capabilities.includes(capability) &&
        (mode !== 'LOCAL_ONLY' || provider.locality === 'local') &&
        (mode !== 'CLOUD' || provider.locality === 'cloud'),
    );
    const ranked = [...eligibleProviders].sort((left, right) => {
      if (left.providerId === providerId) return -1;
      if (right.providerId === providerId) return 1;
      if (mode === 'HYBRID' || mode === 'AUTO') {
        if (left.locality === 'local' && right.locality === 'cloud') return -1;
        if (left.locality === 'cloud' && right.locality === 'local') return 1;
      }
      return left.providerId.localeCompare(right.providerId);
    });
    const selections = ranked.flatMap((provider) => {
      const providerModels = models.filter(
        (model) =>
          model.providerId === provider.providerId && model.capabilities.includes(capability),
      );
      const selected =
        providerModels.find((model) => model.modelId === modelId) ?? providerModels.at(0);
      return selected ? [{ provider, model: selected }] : [];
    });
    if (selections.length === 0) {
      throw new JupiterError({
        code: mode === 'LOCAL_ONLY' ? 'LOCAL_MODEL_UNAVAILABLE' : 'MODEL_NOT_CONFIGURED',
        category: 'configuration',
        message:
          mode === 'LOCAL_ONLY'
            ? 'No configured local model supports this request.'
            : 'No configured model supports this request.',
        recoverable: true,
        retryable: false,
        userAction: 'Configure and validate a compatible provider and model.',
      });
    }
    return applyFallbackPolicy(selections, settings);
  }
}

function preferredModel(settings: AiSettings, capability: ModelCapability): string | undefined {
  if (capability === 'reasoning') return settings.preferredReasoningModel;
  if (capability === 'vision') return settings.preferredVisionModel;
  if (capability === 'embeddings') return settings.preferredEmbeddingModel;
  return settings.preferredChatModel;
}

function applyFallbackPolicy(selections: RouteSelection[], settings: AiSettings): RouteSelection[] {
  const first = selections[0];
  if (!first || settings.fallbackPolicy === 'NONE') return first ? [first] : [];
  if (settings.fallbackPolicy === 'SAME_LOCALITY') {
    return selections.filter(
      (selection) => selection.provider.locality === first.provider.locality,
    );
  }
  const approved = new Set(settings.fallbackProviderIds);
  return [
    first,
    ...selections.slice(1).filter((selection) => approved.has(selection.provider.providerId)),
  ];
}
