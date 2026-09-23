import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { JupiterDatabase } from '@jupiter/database';
import type { ProviderConfigureInput, ProviderSummary } from '@jupiter/contracts';
import { ProviderAgnosticChatRuntime } from './chat-runtime.js';
import { ModelRouter } from './model-router.js';
import type { CredentialVault, FetchLike } from './types.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('ProviderAgnosticChatRuntime', () => {
  it('adds/removes providers dynamically and streams a durable conversation', async () => {
    const { database, path } = databaseFixture();
    const vault = memoryVault();
    const deltas: string[] = [];
    const runtime = new ProviderAgnosticChatRuntime({
      repository: database,
      credentialVault: vault,
      fetchImplementation: fixtureFetch({ chunks: ['Jupi', 'ter'] }),
    });
    await runtime.configureProvider(localProvider('local-one'), new AbortController().signal);
    expect(runtime.listProviders().map((provider) => provider.providerId)).toEqual(['local-one']);
    const conversation = runtime.createConversation({ title: 'Durable fixture' });
    runtime.subscribe((event) => {
      if (event.type === 'delta') deltas.push(event.delta ?? '');
    });
    const result = await runtime.send(
      { conversationId: conversation.conversationId, content: 'Hello', attachments: [] },
      randomUUID(),
      new AbortController().signal,
    );
    expect(deltas).toEqual(['Jupi', 'ter']);
    expect(result.assistantMessage).toMatchObject({ content: 'Jupiter', status: 'complete' });
    expect(await runtime.removeProvider('local-one')).toBe(true);
    database.close();

    const reopened = JupiterDatabase.open(path);
    expect(
      reopened.listMessages(conversation.conversationId).map((message) => message.content),
    ).toEqual(['Hello', 'Jupiter']);
    expect(readFileSync(path).includes(Buffer.from('fixture-secret'))).toBe(false);
    reopened.close();
  });

  it('returns a sanitized invalid-key error without persisting the secret', async () => {
    const { database, path } = databaseFixture();
    const vault = memoryVault();
    const runtime = new ProviderAgnosticChatRuntime({
      repository: database,
      credentialVault: vault,
      fetchImplementation: () => Promise.resolve(new Response('', { status: 401 })),
    });
    const fixtureCredential = 'sensitive-provider-fixture-value';
    await expect(
      runtime.configureProvider(
        {
          ...cloudProvider('cloud-one'),
          credential: fixtureCredential,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_INVALID',
      message: 'Provider rejected the configured credential.',
    });
    const stored = database.getProvider('cloud-one');
    expect(stored).toMatchObject({ authState: 'invalid', health: 'unavailable' });
    expect(JSON.stringify(stored)).not.toContain(fixtureCredential);
    expect(readFileSync(path).includes(Buffer.from(fixtureCredential))).toBe(false);
    database.close();
  });

  it('cancels an active stream and preserves the partial response as cancelled', async () => {
    const { database } = databaseFixture();
    const runtime = new ProviderAgnosticChatRuntime({
      repository: database,
      credentialVault: memoryVault(),
      fetchImplementation: cancellableFetch(),
    });
    await runtime.configureProvider(localProvider('local-cancel'), new AbortController().signal);
    const conversation = runtime.createConversation({});
    const controller = new AbortController();
    let sawDelta = false;
    const streamed = new Promise<void>((resolve) => {
      runtime.subscribe((event) => {
        if (event.type === 'delta') {
          sawDelta = true;
          controller.abort();
          resolve();
        }
      });
    });
    const generation = runtime.send(
      { conversationId: conversation.conversationId, content: 'Cancel me', attachments: [] },
      randomUUID(),
      controller.signal,
    );
    await streamed;
    await expect(generation).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(sawDelta).toBe(true);
    expect(database.listMessages(conversation.conversationId).at(-1)).toMatchObject({
      status: 'cancelled',
      content: 'partial',
    });
    database.close();
  });

  it('blocks cloud traffic at the router in LOCAL_ONLY mode', async () => {
    const { database } = databaseFixture();
    let networkCalls = 0;
    const runtime = new ProviderAgnosticChatRuntime({
      repository: database,
      credentialVault: memoryVault(),
      fetchImplementation: () => {
        networkCalls += 1;
        return Promise.reject(new Error('must not run'));
      },
    });
    const timestamp = new Date().toISOString();
    database.upsertProvider({
      providerId: 'cloud-only',
      displayName: 'Cloud only',
      baseUrl: 'https://provider.example/v1',
      locality: 'cloud',
      authScheme: 'bearer',
      enabled: true,
      capabilities: ['chat', 'streaming'],
      authState: 'valid',
      health: 'operational',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    database.replaceModels('cloud-only', [
      {
        providerId: 'cloud-only',
        modelId: 'cloud-model',
        displayName: 'Cloud model',
        capabilities: ['chat', 'streaming'],
        discoveredAt: timestamp,
      },
    ]);
    runtime.updateSettings({ routingMode: 'LOCAL_ONLY' });
    const conversation = runtime.createConversation({});
    await expect(
      runtime.send(
        { conversationId: conversation.conversationId, content: 'Private', attachments: [] },
        randomUUID(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_MODEL_UNAVAILABLE' });
    expect(networkCalls).toBe(0);
    database.close();
  });

  it('uses only policy-approved fallback and records the routing decision', async () => {
    const { database } = databaseFixture();
    const events: string[] = [];
    const runtime = new ProviderAgnosticChatRuntime({
      repository: database,
      credentialVault: memoryVault(),
      fetchImplementation: fallbackFetch(),
      recordEvent: (event) => events.push(event.type),
    });
    await runtime.configureProvider(localProvider('a-failing'), new AbortController().signal);
    await runtime.configureProvider(localProvider('b-working'), new AbortController().signal);
    runtime.updateSettings({
      preferredProviderId: 'a-failing',
      fallbackPolicy: 'EXPLICIT',
      fallbackProviderIds: ['b-working'],
    });
    const conversation = runtime.createConversation({});
    const result = await runtime.send(
      { conversationId: conversation.conversationId, content: 'Fallback', attachments: [] },
      randomUUID(),
      new AbortController().signal,
    );
    expect(result.assistantMessage).toMatchObject({
      providerId: 'b-working',
      content: 'fallback-ok',
    });
    expect(events).toEqual(['ai.route.fallback']);
    database.close();
  });

  it('reports an outage truthfully without leaking the response or using unapproved fallback', async () => {
    const { database, path } = databaseFixture();
    const upstreamBody = 'upstream-private-diagnostic-value';
    let chatCalls = 0;
    const runtime = new ProviderAgnosticChatRuntime({
      repository: database,
      credentialVault: memoryVault(),
      fetchImplementation: (input, init) => {
        if (requestUrl(input).endsWith('/models')) {
          return Promise.resolve(modelResponse('fixture-model'));
        }
        if (init?.method === 'POST') chatCalls += 1;
        return Promise.resolve(new Response(upstreamBody, { status: 503 }));
      },
    });
    await runtime.configureProvider(localProvider('outage'), new AbortController().signal);
    await runtime.configureProvider(localProvider('unapproved'), new AbortController().signal);
    runtime.updateSettings({
      preferredProviderId: 'outage',
      fallbackPolicy: 'EXPLICIT',
      fallbackProviderIds: [],
    });
    const conversation = runtime.createConversation({});
    const generation = runtime.send(
      { conversationId: conversation.conversationId, content: 'Status?', attachments: [] },
      randomUUID(),
      new AbortController().signal,
    );
    await expect(generation).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_FAILED',
      message: 'Provider request failed with HTTP 503.',
    });
    await expect(generation).rejects.not.toThrow(upstreamBody);
    expect(chatCalls).toBe(1);
    expect(database.listMessages(conversation.conversationId).at(-1)).toMatchObject({
      status: 'failed',
      content: '',
    });
    expect(readFileSync(path).includes(Buffer.from(upstreamBody))).toBe(false);
    database.close();
  });
});

describe('ModelRouter', () => {
  it('selects the requested model capability', () => {
    const now = new Date().toISOString();
    const provider: ProviderSummary = {
      providerId: 'local',
      displayName: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      locality: 'local' as const,
      authScheme: 'none' as const,
      enabled: true,
      capabilities: ['chat', 'vision'],
      authState: 'valid' as const,
      health: 'operational' as const,
      createdAt: now,
      updatedAt: now,
    };
    const selection = new ModelRouter().select(
      [provider],
      [
        {
          providerId: 'local',
          modelId: 'chat',
          displayName: 'Chat',
          capabilities: ['chat'],
          discoveredAt: now,
        },
        {
          providerId: 'local',
          modelId: 'vision',
          displayName: 'Vision',
          capabilities: ['vision'],
          discoveredAt: now,
        },
      ],
      {
        routingMode: 'AUTO',
        preferredVisionModel: 'vision',
        fallbackPolicy: 'NONE',
        fallbackProviderIds: [],
        optimization: 'balanced',
      },
      undefined,
      'vision',
    );
    expect(selection[0]?.model.modelId).toBe('vision');
  });
});

function databaseFixture(): { database: JupiterDatabase; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'jupiter-ai-runtime-'));
  directories.push(directory);
  const path = join(directory, 'jupiter.db');
  return { database: JupiterDatabase.open(path), path };
}

function memoryVault(): CredentialVault {
  const credentials = new Map<string, string>();
  return {
    get: (providerId) => Promise.resolve(credentials.get(providerId)),
    set: (providerId, credential) => {
      credentials.set(providerId, credential);
      return Promise.resolve('sha256:test1234');
    },
    delete: (providerId) => {
      credentials.delete(providerId);
      return Promise.resolve();
    },
  };
}

function localProvider(providerId: string): ProviderConfigureInput {
  return {
    providerId,
    displayName: providerId,
    baseUrl: `http://127.0.0.1:11434/${providerId}/v1`,
    locality: 'local' as const,
    authScheme: 'none' as const,
    enabled: true,
    capabilities: ['chat', 'streaming', 'cancellation', 'usage'],
  };
}

function cloudProvider(providerId: string): ProviderConfigureInput {
  return {
    providerId,
    displayName: providerId,
    baseUrl: 'https://provider.example/v1',
    locality: 'cloud' as const,
    authScheme: 'bearer' as const,
    enabled: true,
    capabilities: ['chat', 'streaming', 'cancellation', 'usage'],
  };
}

function fixtureFetch(options: { chunks: string[] }): FetchLike {
  return (input, init) => {
    const url = requestUrl(input);
    if (url.endsWith('/models')) return Promise.resolve(modelResponse('fixture-model'));
    if (init?.method === 'POST') return Promise.resolve(sseResponse(options.chunks));
    return Promise.resolve(new Response('', { status: 404 }));
  };
}

function cancellableFetch(): FetchLike {
  return (input, init) => {
    if (requestUrl(input).endsWith('/models')) {
      return Promise.resolve(modelResponse('fixture-model'));
    }
    const signal = init?.signal;
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
            );
            signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Aborted', 'AbortError')),
            );
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
  };
}

function fallbackFetch(): FetchLike {
  return (input, init) => {
    const url = requestUrl(input);
    if (url.endsWith('/models')) return Promise.resolve(modelResponse('fixture-model'));
    if (url.includes('a-failing') && init?.method === 'POST')
      return Promise.resolve(new Response('', { status: 503 }));
    return Promise.resolve(sseResponse(['fallback-ok']));
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function modelResponse(modelId: string): Response {
  return Response.json({ data: [{ id: modelId }] });
}

function sseResponse(chunks: string[]): Response {
  const body =
    chunks
      .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
