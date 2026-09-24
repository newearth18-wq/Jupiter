import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ComputerActionInput,
  ComputerActionResult,
  PermissionCapability,
} from '@jupiter/contracts';
import type { ComputerActionRepository, PermissionRuntime } from '@jupiter/core';
import { WindowsComputerAgent } from './computer-agent.js';
import { AutomationHostCancelledError, type AutomationProcessHost } from './process-host.js';

describe('WindowsComputerAgent', () => {
  it('returns structured failure for a missing semantic element', async () => {
    const fixture = createFixture({
      execute: () =>
        Promise.resolve({
          success: false,
          observation: 'The semantic control was not found.',
          interactionMode: 'WINDOWS_UI_AUTOMATION',
          evidence: [],
          error: { code: 'UI_ELEMENT_NOT_FOUND', message: 'Control missing.', recoverable: true },
        }),
    });
    const result = await fixture.agent.execute(
      typeAction(),
      'renderer',
      new AbortController().signal,
    );
    expect(result).toMatchObject({ success: false, status: 'FAILED' });
    expect(result.error?.code).toBe('UI_ELEMENT_NOT_FOUND');
  });

  it('contains an automation process crash without crashing Jupiter', async () => {
    const fixture = createFixture({ execute: () => Promise.reject(new Error('host crash')) });
    const result = await fixture.agent.execute(
      typeAction(),
      'renderer',
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      success: false,
      status: 'FAILED',
      error: { code: 'AUTOMATION_PROCESS_FAILED' },
    });
    expect(fixture.agent.status().available).toBe(true);
  });

  it('cancels an active isolated action at the process boundary', async () => {
    const host: AutomationProcessHost = {
      execute: (_action, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new AutomationHostCancelledError()), {
            once: true,
          });
        }),
    };
    const fixture = createFixture(host);
    const input = typeAction();
    const pending = fixture.agent.execute(input, 'renderer', new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fixture.agent.cancel({ executionId: input.actionId })).toBe(true);
    expect(await pending).toMatchObject({ success: false, status: 'CANCELLED' });
  });

  it('requires the CRITICAL coordinate capability and labels fallback evidence', async () => {
    const host: AutomationProcessHost = {
      execute: () =>
        Promise.resolve({
          success: true,
          observation: 'Approved fallback used.',
          interactionMode: 'COORDINATE_FALLBACK',
          evidence: [],
        }),
    };
    const fixture = createFixture(host);
    const input: ComputerActionInput = {
      actionId: randomUUID(),
      action: 'CLICK_ELEMENT',
      target: {
        kind: 'control',
        id: 'window:fixture:missing-button',
        display: 'Missing button',
        processId: 123,
        selector: { automationId: 'missing' },
      },
      timeoutMs: 5_000,
      parameters: {
        coordinateFallback: {
          approved: true,
          reason: 'Semantic lookup and vision were unavailable.',
          bounds: { x: 10, y: 10, width: 20, height: 20 },
        },
      },
    };
    const result = await fixture.agent.execute(input, 'renderer', new AbortController().signal);
    expect(fixture.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'computer.coordinate_fallback' }),
    );
    expect(result).toMatchObject({
      success: true,
      interactionMode: 'COORDINATE_FALLBACK',
      coordinateFallbackUsed: true,
    });
  });

  it('uses semantic selectors without any screen-resolution coordinates', () => {
    const input = typeAction();
    expect(input.target.selector).toEqual({ controlType: 'Document', className: 'RichEditD2DPT' });
    expect(JSON.stringify(input)).not.toContain('bounds');
  });
});

function createFixture(host: AutomationProcessHost) {
  const actions: ComputerActionResult[] = [];
  const capabilities: PermissionCapability[] = [];
  const authorize = vi.fn<PermissionRuntime['authorize']>(() => ({
    status: 'ALLOWED',
    code: 'TEST_ALLOWED',
    grantId: randomUUID(),
    auditId: randomUUID(),
    evaluatedAt: new Date().toISOString(),
  }));
  const permissions: PermissionRuntime = {
    registerCapability: (capability) => {
      capabilities.push(capability);
      return capability;
    },
    listCapabilities: () => capabilities,
    request: () => {
      throw new Error('Permission request was not expected.');
    },
    listRequests: () => [],
    resolve: () => {
      throw new Error('Permission resolution was not expected.');
    },
    authorize,
    listGrants: () => [],
    revoke: () => false,
    listAudits: () => [],
    shutdown: () => Promise.resolve(),
  };
  const repository: ComputerActionRepository = {
    addComputerAction: (action) => actions.push(action),
    listComputerActions: (limit) => actions.slice(-limit).reverse(),
  };
  return {
    actions,
    authorize,
    agent: new WindowsComputerAgent({
      repository,
      permissions,
      host,
      defaultDemoPath: 'C:\\fixture\\Jupiter-Hello.txt',
    }),
  };
}

function typeAction(): ComputerActionInput {
  return {
    actionId: randomUUID(),
    action: 'TYPE_TEXT',
    target: {
      kind: 'control',
      id: 'process:123:notepad-editor',
      display: 'Notepad editor',
      processId: 123,
      selector: { controlType: 'Document', className: 'RichEditD2DPT' },
    },
    adapterHint: 'notepad',
    timeoutMs: 5_000,
    parameters: { text: 'Hello Jupiter', replace: true },
  };
}
