import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComputerActionInput } from '@jupiter/contracts';
import { JupiterDatabase } from '@jupiter/database';
import { CapabilityPermissionEngine } from '@jupiter/security';
import { WindowsComputerAgent } from './computer-agent.js';
import { PowerShellAutomationProcessHost } from './process-host.js';

const directories: string[] = [];
const databases: JupiterDatabase[] = [];
const scriptPath = fileURLToPath(new URL('./windows-automation-host.ps1', import.meta.url));

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'win32')('real Windows Computer Agent', () => {
  it('opens real Notepad, types exact text, saves and verifies an actual file', async () => {
    const fixture = createFixture();
    const outputPath = join(fixture.directory, 'Hello Jupiter.txt');
    const input = {
      executionId: randomUUID(),
      outputPath,
      text: 'Hello Jupiter',
      overwrite: false,
    } as const;

    await expect(
      fixture.agent.runNotepadDemo(input, 'renderer', new AbortController().signal),
    ).rejects.toThrow('Explicit permission');
    const pending = fixture.permissions
      .listRequests('PENDING')
      .find((request) => request.capability === 'computer.notepad_demo');
    expect(pending?.availableDecisions).toEqual(['ALLOW_ONCE', 'DENY']);
    fixture.permissions.resolve(
      { requestId: pending?.requestId ?? '', decision: 'ALLOW_ONCE' },
      'USER_EXPLICIT',
    );

    const result = await fixture.agent.runNotepadDemo(
      input,
      'renderer',
      new AbortController().signal,
    );
    expect(result.status, JSON.stringify(result, null, 2)).toBe('SUCCESS');
    expect(result.actions.map((action) => action.action)).toEqual([
      'OPEN_APP',
      'WAIT_FOR_WINDOW',
      'TYPE_TEXT',
      'SAVE_FILE',
      'CLOSE_APP',
    ]);
    expect(result.actions.every((action) => action.success)).toBe(true);
    expect(result.artifact).toMatchObject({ kind: 'file', verified: true });
    expect(readFileSync(outputPath, 'utf8')).toBe('Hello Jupiter');
    expect(fixture.database.listComputerActions(10)).toHaveLength(5);
    expect(
      fixture.permissions
        .listAudits(100)
        .some(
          (audit) => audit.capability === 'computer.notepad_demo' && audit.decision === 'ALLOW',
        ),
    ).toBe(true);
  });

  it('returns structured failure when a real semantic element is missing', async () => {
    const host = new PowerShellAutomationProcessHost(scriptPath);
    const open = await host.execute(openAction(), new AbortController().signal);
    expect(open.success, JSON.stringify(open, null, 2)).toBe(true);
    const processId = open.output?.processId;
    expect(processId).toBeTypeOf('number');
    const missing: ComputerActionInput = {
      actionId: randomUUID(),
      action: 'TYPE_TEXT',
      target: {
        kind: 'control',
        id: 'notepad:missing-control',
        display: 'Missing Notepad control',
        processId,
        selector: { automationId: 'definitely-missing-control' },
      },
      adapterHint: 'notepad',
      timeoutMs: 5_000,
      parameters: { text: 'must not be entered', replace: true },
    };
    const result = await host.execute(missing, new AbortController().signal);
    expect(result).toMatchObject({
      success: false,
      error: { code: 'UI_ELEMENT_NOT_FOUND' },
    });
    await host.execute(closeAction(processId ?? 0), new AbortController().signal);
  });

  it('manages and observes a real window without retaining stale handles', async () => {
    const host = new PowerShellAutomationProcessHost(scriptPath);
    const signal = new AbortController().signal;
    const open = await host.execute(openAction(), signal);
    const processId = open.output?.processId ?? 0;
    expect(open.success).toBe(true);

    const target = {
      kind: 'window' as const,
      id: `process:${String(processId)}`,
      display: 'Windows Notepad',
      processId,
    };
    const execute = (input: ComputerActionInput) => host.execute(input, signal);
    const move = await execute({
      actionId: randomUUID(),
      action: 'MOVE_RESIZE_WINDOW',
      target,
      timeoutMs: 5_000,
      parameters: { x: 80, y: 80, width: 760, height: 520 },
    });
    const maximize = await execute({
      actionId: randomUUID(),
      action: 'MAXIMIZE_WINDOW',
      target,
      timeoutMs: 5_000,
      parameters: {},
    });
    const restore = await execute({
      actionId: randomUUID(),
      action: 'RESTORE_WINDOW',
      target,
      timeoutMs: 5_000,
      parameters: {},
    });
    const windows = await execute({
      actionId: randomUUID(),
      action: 'ENUMERATE_WINDOWS',
      target: { kind: 'screen', id: 'windows:visible', display: 'Visible Windows' },
      timeoutMs: 5_000,
      parameters: { limit: 200 },
    });
    const focus = await execute({
      actionId: randomUUID(),
      action: 'FOCUS_WINDOW',
      target,
      timeoutMs: 5_000,
      parameters: {},
    });
    const active = await execute({
      actionId: randomUUID(),
      action: 'GET_ACTIVE_WINDOW',
      target: { kind: 'screen', id: 'windows:active', display: 'Active Window' },
      timeoutMs: 5_000,
      parameters: {},
    });

    expect(
      [move, maximize, restore, windows, focus, active].every((result) => result.success),
      JSON.stringify({ move, maximize, restore, windows, focus, active }, null, 2),
    ).toBe(true);
    expect(windows.output?.windows?.some((window) => window.processId === processId)).toBe(true);
    expect(active.output?.processId).toBe(processId);
    await execute(closeAction(processId));
  });

  it('interrupts a queued wait action through process cancellation', async () => {
    const fixture = createFixture();
    const input: ComputerActionInput = {
      actionId: randomUUID(),
      action: 'WAIT_FOR_WINDOW',
      target: {
        kind: 'window',
        id: 'window:never-created',
        display: 'Window that does not exist',
      },
      timeoutMs: 30_000,
      parameters: { processName: `jupiter-missing-${randomUUID()}` },
    };
    await expect(
      fixture.agent.execute(input, 'renderer', new AbortController().signal),
    ).rejects.toThrow('Explicit permission');
    const request = fixture.permissions
      .listRequests('PENDING')
      .find((item) => item.capability === 'computer.wait');
    fixture.permissions.resolve(
      { requestId: request?.requestId ?? '', decision: 'ALLOW_ONCE' },
      'USER_EXPLICIT',
    );
    const pending = fixture.agent.execute(input, 'renderer', new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.agent.cancel({ executionId: input.actionId })).toBe(true);
    expect(await pending).toMatchObject({ status: 'CANCELLED', success: false });
  });
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jupiter-computer-agent-'));
  directories.push(directory);
  const database = JupiterDatabase.open(join(directory, 'jupiter.db'));
  databases.push(database);
  const permissions = new CapabilityPermissionEngine({ repository: database });
  const agent = new WindowsComputerAgent({
    repository: database,
    permissions,
    host: new PowerShellAutomationProcessHost(scriptPath),
    defaultDemoPath: join(directory, 'Jupiter-Hello.txt'),
  });
  return { directory, database, permissions, agent };
}

function openAction(): ComputerActionInput {
  return {
    actionId: randomUUID(),
    action: 'OPEN_APP',
    target: { kind: 'application', id: 'application:notepad', display: 'Windows Notepad' },
    adapterHint: 'notepad',
    timeoutMs: 10_000,
    parameters: { executable: 'notepad.exe', arguments: [] },
  };
}

function closeAction(processId: number): ComputerActionInput {
  return {
    actionId: randomUUID(),
    action: 'CLOSE_APP',
    target: {
      kind: 'application',
      id: `process:${String(processId)}`,
      display: 'Windows Notepad',
      processId,
    },
    adapterHint: 'notepad',
    timeoutMs: 5_000,
    parameters: {},
  };
}
