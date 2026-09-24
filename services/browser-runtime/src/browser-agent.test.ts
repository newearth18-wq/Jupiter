import { randomUUID } from 'node:crypto';
import type {
  BrowserActionInput,
  BrowserActionResult,
  PermissionCapability,
} from '@jupiter/contracts';
import type { BrowserActionRepository, PermissionRuntime } from '@jupiter/core';
import { describe, expect, it } from 'vitest';
import { PlaywrightBrowserAgent } from './browser-agent.js';
import type { BrowserProcess, NativeBrowserResponse } from './process-host.js';

describe('PlaywrightBrowserAgent', () => {
  it('contains a child-process crash and persists a truthful failure', async () => {
    const actions: BrowserActionResult[] = [];
    const capabilities: PermissionCapability[] = [];
    const agent = createAgent(
      {
        available: () => true,
        execute: () => Promise.reject(new Error('controlled worker crash')),
        shutdown: () => Promise.resolve(),
      },
      actions,
      capabilities,
    );
    const result = await agent.execute(createSession(), 'test', new AbortController().signal);
    expect(result).toMatchObject({ success: false, status: 'FAILED' });
    expect(result.error?.code).toBe('BROWSER_PROCESS_FAILED');
    expect(actions).toEqual([result]);
    await agent.shutdown();
  });

  it('does not persist untrusted page text or extracted page values', async () => {
    const actions: BrowserActionResult[] = [];
    const capabilities: PermissionCapability[] = [];
    const input: BrowserActionInput = {
      actionId: randomUUID(),
      action: 'READ_PAGE',
      sessionId: randomUUID(),
      tabId: randomUUID(),
      target: { kind: 'page', id: 'fixture', display: 'Fixture' },
      timeoutMs: 30_000,
      parameters: { maxCharacters: 1_000 },
    };
    const native: NativeBrowserResponse = {
      success: true,
      observation: 'Read as untrusted content.',
      sessionId: input.sessionId,
      tabId: input.tabId,
      output: { visibleText: 'untrusted secret-like page text' },
      evidence: [],
      securitySignals: [{ type: 'UNTRUSTED_CONTENT', severity: 'INFO', description: 'Untrusted.' }],
    };
    const agent = createAgent(
      {
        available: () => true,
        execute: () => Promise.resolve(native),
        shutdown: () => Promise.resolve(),
      },
      actions,
      capabilities,
    );
    const result = await agent.execute(input, 'test', new AbortController().signal);
    expect(result.output?.visibleText).toBe('untrusted secret-like page text');
    expect(actions[0]?.output).toBeUndefined();
    await agent.shutdown();
  });

  it('registers purchase submission as CRITICAL and login as MEDIUM', async () => {
    const capabilities: PermissionCapability[] = [];
    const agent = createAgent(
      {
        available: () => true,
        execute: () => Promise.reject(new Error('unused')),
        shutdown: () => Promise.resolve(),
      },
      [],
      capabilities,
    );
    expect(capabilities.find((item) => item.capability === 'browser.form.purchase')?.risk).toBe(
      'CRITICAL',
    );
    expect(capabilities.find((item) => item.capability === 'browser.form.login')?.risk).toBe(
      'MEDIUM',
    );
    await agent.shutdown();
  });
});

function createAgent(
  host: BrowserProcess,
  actions: BrowserActionResult[],
  capabilities: PermissionCapability[],
): PlaywrightBrowserAgent {
  const repository: BrowserActionRepository = {
    addBrowserAction: (action) => actions.push(action),
    listBrowserActions: () => [...actions],
  };
  const permissions = {
    listCapabilities: () => capabilities,
    registerCapability: (value: PermissionCapability) => {
      capabilities.push(value);
      return value;
    },
    authorize: () => ({ status: 'ALLOWED' }),
  } as unknown as PermissionRuntime;
  return new PlaywrightBrowserAgent({
    repository,
    permissions,
    host,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    managedDownloadDirectory: 'C:\\Jupiter\\browser-downloads',
  });
}

function createSession(): BrowserActionInput {
  return {
    actionId: randomUUID(),
    action: 'CREATE_SESSION',
    target: { kind: 'browser', id: 'edge', display: 'Edge' },
    timeoutMs: 30_000,
    parameters: {
      profileMode: 'TEMPORARY',
      allowedOrigins: [],
      downloadDirectory: 'C:\\Jupiter\\browser-downloads',
      headless: true,
    },
  };
}
