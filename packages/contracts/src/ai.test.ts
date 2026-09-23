import { describe, expect, it } from 'vitest';
import { AiSettingsSchema, ChatStreamEventSchema, ProviderConfigureInputSchema } from './ai.js';

describe('AI contracts', () => {
  it('requires HTTPS for cloud providers and loopback for local providers', () => {
    const base = {
      providerId: 'fixture',
      displayName: 'Fixture',
      authScheme: 'none' as const,
      capabilities: ['chat' as const],
      enabled: true,
    };
    expect(
      ProviderConfigureInputSchema.safeParse({
        ...base,
        locality: 'cloud',
        baseUrl: 'http://example.com/v1',
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigureInputSchema.safeParse({
        ...base,
        locality: 'local',
        baseUrl: 'http://192.168.1.2:11434/v1',
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigureInputSchema.safeParse({
        ...base,
        locality: 'local',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }).success,
    ).toBe(true);
  });

  it('rejects credentials embedded in provider URLs', () => {
    expect(
      ProviderConfigureInputSchema.safeParse({
        providerId: 'fixture',
        displayName: 'Fixture',
        baseUrl: 'https://secret@example.com/v1?key=value',
        locality: 'cloud',
        authScheme: 'bearer',
        capabilities: ['chat'],
      }).success,
    ).toBe(false);
  });

  it('validates LOCAL_ONLY settings and typed stream events', () => {
    expect(
      AiSettingsSchema.parse({
        routingMode: 'LOCAL_ONLY',
        fallbackPolicy: 'NONE',
        fallbackProviderIds: [],
        optimization: 'balanced',
      }).routingMode,
    ).toBe('LOCAL_ONLY');
    expect(() =>
      ChatStreamEventSchema.parse({
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        type: 'delta',
        delta: 'hello',
        timestamp: new Date().toISOString(),
        credential: 'must be rejected',
      }),
    ).toThrow();
  });
});
