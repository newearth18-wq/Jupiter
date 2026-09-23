import {
  ModelDescriptorSchema,
  type ChatMessage,
  type ModelDescriptor,
  type ProviderSummary,
  type ToolCallDisplaySchema,
} from '@jupiter/contracts';
import { JupiterError } from '@jupiter/core';
import type { z } from 'zod';
import type { FetchLike, ProviderAdapter, ProviderCompletion } from './types.js';

type ToolCall = z.infer<typeof ToolCallDisplaySchema>;

export class OpenAiCompatibleProvider implements ProviderAdapter {
  readonly provider: ProviderSummary;
  readonly #fetch: FetchLike;

  constructor(provider: ProviderSummary, fetchImplementation: FetchLike = fetch) {
    this.provider = provider;
    this.#fetch = fetchImplementation;
  }

  async discoverModels(
    credential: string | undefined,
    signal: AbortSignal,
  ): Promise<ModelDescriptor[]> {
    const response = await this.#request('/models', { method: 'GET', signal }, credential);
    const payload: unknown = await response.json().catch(() => undefined);
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw providerError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid model list.');
    }
    const discoveredAt = new Date().toISOString();
    return payload.data.flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) return [];
      return [
        ModelDescriptorSchema.parse({
          providerId: this.provider.providerId,
          modelId: item.id,
          displayName: item.id,
          capabilities: this.provider.capabilities,
          discoveredAt,
        }),
      ];
    });
  }

  async streamChat(
    input: {
      modelId: string;
      messages: readonly Pick<ChatMessage, 'role' | 'content'>[];
      credential: string | undefined;
    },
    onDelta: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<ProviderCompletion> {
    const response = await this.#request(
      '/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: input.modelId, messages: input.messages, stream: true }),
        signal,
      },
      input.credential,
    );
    if (!response.body) {
      throw providerError('PROVIDER_STREAM_UNAVAILABLE', 'Provider returned no response stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let content = '';
    let usage: ChatMessage['usage'];
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      buffered += decoder.decode(result.value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        const chunk: unknown = safeJson(data);
        if (!isRecord(chunk)) continue;
        const chunkUsage = parseUsage(chunk.usage);
        if (chunkUsage) usage = chunkUsage;
        const choices = chunk.choices;
        if (!Array.isArray(choices)) continue;
        const first: unknown = choices[0];
        if (!isRecord(first) || !isRecord(first.delta)) continue;
        if (typeof first.delta.content === 'string' && first.delta.content.length > 0) {
          content += first.delta.content;
          onDelta(first.delta.content);
        }
        if (Array.isArray(first.delta.tool_calls)) {
          for (const entry of first.delta.tool_calls) collectToolCall(entry, toolCalls);
        }
      }
    }

    const structuredTools: ToolCall[] = [...toolCalls.values()].map((tool, index) => ({
      toolCallId: tool.id || `tool-${index.toString()}`,
      name: tool.name || 'unknown_tool',
      argumentsSummary: tool.arguments.slice(0, 1_000),
      status: 'requested',
    }));
    return { content, toolCalls: structuredTools, ...(usage === undefined ? {} : { usage }) };
  }

  async #request(
    path: string,
    init: RequestInit,
    credential: string | undefined,
  ): Promise<Response> {
    if (this.provider.authScheme === 'bearer' && !credential) {
      throw providerError('PROVIDER_NOT_CONFIGURED', 'Provider credential is not configured.');
    }
    const headers = new Headers(init.headers);
    if (credential) headers.set('Authorization', `Bearer ${credential}`);
    let response: Response;
    try {
      response = await this.#fetch(`${this.provider.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw providerError('PROVIDER_CANCELLED', 'Generation was cancelled.', 'cancellation');
      }
      throw providerError('PROVIDER_UNREACHABLE', 'Provider could not be reached.');
    }
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) {
      throw providerError('PROVIDER_AUTH_INVALID', 'Provider rejected the configured credential.');
    }
    if (response.status === 429) {
      throw providerError('PROVIDER_RATE_LIMITED', 'Provider rate limit was reached.');
    }
    throw providerError(
      'PROVIDER_REQUEST_FAILED',
      `Provider request failed with HTTP ${response.status.toString()}.`,
    );
  }
}

function providerError(
  code: string,
  message: string,
  category: 'provider' | 'cancellation' = 'provider',
): JupiterError {
  return new JupiterError({
    code,
    category,
    message,
    recoverable: true,
    retryable: code !== 'PROVIDER_AUTH_INVALID',
    userAction:
      code === 'PROVIDER_AUTH_INVALID'
        ? 'Update the provider credential and validate it again.'
        : 'Review the provider configuration and retry.',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseUsage(value: unknown): ChatMessage['usage'] | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = value.prompt_tokens;
  const outputTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;
  const usage = {
    ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
    ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
    ...(typeof totalTokens === 'number' ? { totalTokens } : {}),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function collectToolCall(
  value: unknown,
  target: Map<number, { id: string; name: string; arguments: string }>,
): void {
  if (!isRecord(value) || typeof value.index !== 'number') return;
  const current = target.get(value.index) ?? { id: '', name: '', arguments: '' };
  const functionData = isRecord(value.function) ? value.function : undefined;
  target.set(value.index, {
    id: current.id + (typeof value.id === 'string' ? value.id : ''),
    name: current.name + (typeof functionData?.name === 'string' ? functionData.name : ''),
    arguments:
      current.arguments +
      (typeof functionData?.arguments === 'string' ? functionData.arguments : ''),
  });
}
