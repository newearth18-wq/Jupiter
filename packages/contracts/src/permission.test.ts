import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PermissionRequestInputSchema, PermissionRequestRecordSchema } from './permission.js';

describe('permission contracts', () => {
  it('accepts a complete request and rejects undeclared fields', () => {
    const input = requestInput();
    expect(PermissionRequestInputSchema.parse(input)).toEqual(input);
    expect(() =>
      PermissionRequestInputSchema.parse({ ...input, rawPrompt: 'untrusted' }),
    ).toThrow();
  });

  it('requires the complete user-facing permission context', () => {
    const input = requestInput();
    expect(() =>
      PermissionRequestInputSchema.parse({ ...input, consequence: undefined }),
    ).toThrow();
    expect(
      PermissionRequestRecordSchema.parse({
        ...input,
        requestId: randomUUID(),
        risk: 'CRITICAL',
        status: 'PENDING',
        availableDecisions: ['ALLOW_ONCE', 'DENY'],
        sessionId: randomUUID(),
        createdAt: new Date().toISOString(),
      }).availableDecisions,
    ).not.toContain('ALWAYS_ALLOW');
  });
});

function requestInput() {
  return {
    capability: 'credentials.modify',
    action: 'Replace an AI provider credential.',
    reason: 'The user requested a provider configuration change.',
    target: { type: 'provider', id: 'provider:test', display: 'Test provider' },
    scope: { type: 'credential', id: 'provider-credential', display: 'Provider credential' },
    requester: {
      actor: 'renderer' as const,
      type: 'UI' as const,
      id: 'models-screen',
      display: 'AI Models settings',
      declaredCapabilities: ['credentials.modify'],
    },
    trustSource: 'USER_INTENT' as const,
    dataLeavingDevice: {
      value: true,
      description: 'The credential is sent only to the configured endpoint for validation.',
    },
    consequence: 'The provider authentication configuration will change.',
    reversible: true,
    automated: false,
    constraints: { operation: 'configure' },
  };
}
