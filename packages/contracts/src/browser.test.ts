import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BrowserActionInputSchema, BrowserActionResultSchema } from './browser.js';

describe('browser contracts', () => {
  it('accepts semantic browser actions and rejects untrusted protocols', () => {
    const input = BrowserActionInputSchema.parse({
      actionId: randomUUID(),
      action: 'NAVIGATE',
      target: { kind: 'page', id: 'https://example.test', display: 'Example' },
      timeoutMs: 5_000,
      parameters: { url: 'https://example.test/search', expectedOrigin: 'https://example.test' },
    });
    expect(input.action).toBe('NAVIGATE');
    expect(() =>
      BrowserActionInputSchema.parse({
        ...input,
        parameters: { url: 'file:///C:/private.txt', expectedOrigin: 'https://example.test' },
      }),
    ).toThrow();
  });

  it('does not allow paused or failed actions to claim success', () => {
    const timestamp = new Date().toISOString();
    expect(() =>
      BrowserActionResultSchema.parse({
        actionId: randomUUID(),
        action: 'CLICK',
        target: { kind: 'element', id: 'button', display: 'Button' },
        success: true,
        status: 'PAUSED',
        observation: 'Unexpected origin.',
        evidence: [],
        securitySignals: [],
        error: { code: 'UNEXPECTED_ORIGIN', message: 'Paused.', recoverable: true },
        startedAt: timestamp,
        completedAt: timestamp,
      }),
    ).toThrow('Success must match status');
  });

  it('keeps element waits and page-load waits semantically distinct', () => {
    const base = {
      actionId: randomUUID(),
      action: 'WAIT_FOR',
      sessionId: randomUUID(),
      tabId: randomUUID(),
      target: { kind: 'page', id: 'fixture', display: 'Fixture' },
      timeoutMs: 5_000,
    };
    expect(
      BrowserActionInputSchema.safeParse({
        ...base,
        parameters: { selector: { kind: 'text', text: 'Ready' }, state: 'VISIBLE' },
      }).success,
    ).toBe(true);
    expect(
      BrowserActionInputSchema.safeParse({
        ...base,
        parameters: { selector: { kind: 'text', text: 'Ready' }, state: 'NETWORKIDLE' },
      }).success,
    ).toBe(false);
    expect(
      BrowserActionInputSchema.safeParse({ ...base, parameters: { state: 'VISIBLE' } }).success,
    ).toBe(false);
  });
});
