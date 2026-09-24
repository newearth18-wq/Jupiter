import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type SmokeEvidence = {
  bootstrapState: {
    metadata: { version: string };
    runtime: { status: string; startupError?: { recoverable: boolean } };
  };
  renderer: {
    title: string;
    status: string | null;
    hasRequire: string;
    hasProcess: string;
    apiKeys: string[];
    hasArbitraryFileApi: string;
    hasCredentialApi: string;
    invalidRejected: boolean;
    eventCursor: number;
    screens: {
      id: string;
      rendered: boolean;
      title: string | null;
      availability: string | null;
    }[];
    thaiText: { language: string; title: string | null; fits: boolean; lineHeight: string | null };
    focus: { trapped: boolean; restored: boolean };
    motion: { setting: string | null; animationName: string | null };
    tabKeyboard: { selected: string | null; focused: string | null };
    shortcutDestination: string | null;
    keyboard: { interactiveCount: number; unreachableCount: number };
    selectedBeforeReload: boolean;
    ping: { status: string; requestId: string; data?: { message: string } };
    diagnostics: {
      status: string;
      data?: {
        status: string;
        database: { status: string; schemaVersion: number; integrity: string };
      };
    };
    denied: { status: string; error?: { category: string } };
    mission: {
      createStatus: string;
      cancelStatus: string;
      retryStatus: string;
      missionId?: string;
      finalStatus?: string;
      attempts: number;
      priorLinked: boolean;
      timelineCount: number;
      detailVisible: boolean;
    };
    workflow: {
      lookupStatus: string;
      configured: boolean | null;
      planCreateStatus: string;
      planCreateCategory: string | null;
      unavailableVisible: boolean;
    };
    skill: {
      listStatus: string;
      count: number;
      allHealthy: boolean;
      echoStatus: string;
      echoExecutionStatus: string | null;
      echoOutput: string | null;
      centerVisible: boolean;
      healthVisible: boolean;
      safeTestVisible: boolean;
    };
    permission: {
      centerVisible: boolean;
      requestVisible: boolean;
      criticalVisible: boolean;
      exactTargetVisible: boolean;
      allowOnceVisible: boolean;
      alwaysAllowVisible: boolean;
      denyVisible: boolean;
    };
  };
  ai: {
    status?: string;
    configureStatus?: string;
    firstConfigureStatus?: string;
    firstConfigureCode?: string | null;
    permissionRequestFound?: boolean;
    criticalAlwaysAllowOffered?: boolean | null;
    permissionResolutionStatus?: string;
    credentialReturned?: boolean;
    streamedDeltas?: string[];
    uiStreamSnapshots?: string[];
    uiComposerReady?: boolean;
    uiSendReady?: boolean;
    uiRequestStarted?: boolean;
    completionStatus?: string;
    completionText?: string | null;
    cancelAccepted?: boolean;
    cancelledStatus?: string;
    cancelledCode?: string | null;
    historyCount?: number;
    providerState?: string | null;
    rendererSecretExposure?: boolean;
    conversationId?: string;
  };
  fileSecurity?: { rawSecretFound: boolean; credentialFileCount: number };
  reconnection: {
    cursor: number;
    replayedEventCount: number;
    currentView: string | null;
    language: string;
    motion: string | null;
    theme: string | null;
    missionCount: number;
    skillCount: number;
  };
  responsive: {
    innerWidth: number;
    innerHeight: number;
    documentScrollWidth: number;
    horizontalOverflow: boolean;
    navigationCount: number;
    screenVisible: boolean;
  };
  keyboardNavigation: { activeNavigation: string | null };
  skillWorkflow?: {
    missionStatus: string;
    planStatus: string;
    executionStatus: string;
    workflowStatus: string | null;
    stepOutput: string | null;
  };
  permissionFixture?: { status: string };
  persistedWindowState: { width: number; height: number; maximized: boolean };
  webPreferences: {
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: boolean;
    webSecurity: boolean;
  };
};

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function runElectron(options: {
  forceFoundationFailure?: boolean;
  forceServiceFailure?: boolean;
  aiSmoke?: boolean;
}): Promise<SmokeEvidence> {
  const directory = mkdtempSync(join(tmpdir(), 'jupiter-electron-smoke-'));
  const evidencePath = join(directory, 'evidence.json');
  const credential = 'fixture-provider-credential-never-store-plain';
  const fixture = options.aiSmoke ? await startAiFixture() : undefined;
  const child = spawn(electronPath, [desktopDirectory], {
    cwd: desktopDirectory,
    env: {
      ...process.env,
      JUPITER_APP_ENV: 'test',
      JUPITER_DATA_DIR: join(directory, 'data'),
      JUPITER_LOG_DIR: join(directory, 'logs'),
      JUPITER_SMOKE_TEST: '1',
      JUPITER_SMOKE_EVIDENCE_PATH: evidencePath,
      JUPITER_FORCE_STARTUP_FAILURE: options.forceFoundationFailure ? '1' : '0',
      JUPITER_FORCE_SERVICE_FAILURE: options.forceServiceFailure ? '1' : '0',
      ...(fixture === undefined
        ? {}
        : {
            JUPITER_AI_SMOKE_BASE_URL: fixture.baseUrl,
            JUPITER_AI_SMOKE_CREDENTIAL: credential,
          }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const output: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron smoke timed out. Output: ${output.join('')}`));
    }, 30_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });

  expect(exitCode, output.join('')).toBe(0);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as SmokeEvidence;
  if (fixture) {
    evidence.fileSecurity = {
      rawSecretFound: filesBelow(directory).some((file) =>
        readFileSync(file).includes(Buffer.from(credential)),
      ),
      credentialFileCount: filesBelow(join(directory, 'data', 'credentials')).filter((file) =>
        file.endsWith('.credential'),
      ).length,
    };
    await closeServer(fixture.server);
  }
  rmSync(directory, { force: true, recursive: true });
  return evidence;
}

describe('packaged-shape Electron shell', () => {
  it('launches a real renderer with no direct Node integration', async () => {
    const evidence = await runElectron({});
    expect(evidence.bootstrapState.runtime.status).toBe('operational');
    expect(evidence.bootstrapState.metadata.version).toBe('0.1.0');
    expect(evidence.renderer.title).toBe('Jupiter');
    expect(evidence.renderer.status).toBeTruthy();
    expect(evidence.renderer.hasRequire).toBe('undefined');
    expect(evidence.renderer.hasProcess).toBe('undefined');
    expect(evidence.renderer.apiKeys).toEqual([
      'cancel',
      'getBootstrapState',
      'onChatStream',
      'onDomainEvent',
      'request',
      'retryStartup',
    ]);
    expect(evidence.renderer.hasArbitraryFileApi).toBe('undefined');
    expect(evidence.renderer.hasCredentialApi).toBe('undefined');
    expect(evidence.renderer.invalidRejected).toBe(true);
    expect(evidence.renderer.ping.status).toBe('success');
    expect(evidence.renderer.ping.data?.message).toBe('smoke-pong');
    expect(evidence.renderer.diagnostics.status).toBe('success');
    expect(evidence.renderer.diagnostics.data?.database).toMatchObject({
      status: 'operational',
      schemaVersion: 7,
      integrity: 'ok',
    });
    expect(evidence.renderer.denied.status).toBe('error');
    expect(evidence.renderer.denied.error?.category).toBe('permission');
    expect(evidence.renderer.mission).toMatchObject({
      createStatus: 'success',
      cancelStatus: 'success',
      retryStatus: 'success',
      finalStatus: 'READY',
      attempts: 2,
      priorLinked: true,
      detailVisible: true,
    });
    expect(evidence.renderer.mission.timelineCount).toBeGreaterThanOrEqual(5);
    expect(evidence.renderer.workflow).toEqual({
      lookupStatus: 'success',
      configured: false,
      planCreateStatus: 'error',
      planCreateCategory: 'permission',
      unavailableVisible: true,
    });
    expect(evidence.renderer.skill).toEqual({
      listStatus: 'success',
      count: 4,
      allHealthy: true,
      echoStatus: 'success',
      echoExecutionStatus: 'SUCCESS',
      echoOutput: 'exact smoke echo',
      centerVisible: true,
      healthVisible: true,
      safeTestVisible: true,
    });
    expect(evidence.permissionFixture?.status).toBe('success');
    expect(evidence.renderer.permission).toEqual({
      centerVisible: true,
      requestVisible: true,
      criticalVisible: true,
      exactTargetVisible: true,
      allowOnceVisible: true,
      alwaysAllowVisible: false,
      denyVisible: true,
    });
    expect(evidence.renderer.eventCursor).toBeGreaterThan(0);
    expect(evidence.skillWorkflow).toEqual({
      missionStatus: 'success',
      planStatus: 'success',
      executionStatus: 'success',
      workflowStatus: 'COMPLETED',
      stepOutput: 'workflow echo',
    });
    expect(evidence.reconnection.cursor).toBeGreaterThanOrEqual(evidence.renderer.eventCursor);
    expect(evidence.reconnection.replayedEventCount).toBe(0);
    expect(evidence.webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });

  it('keeps the shell alive and reports a recoverable startup failure', async () => {
    const evidence = await runElectron({ forceFoundationFailure: true });
    expect(evidence.bootstrapState.runtime.status).toBe('degraded');
    expect(evidence.bootstrapState.runtime.startupError?.recoverable).toBe(true);
    expect(evidence.renderer.status).toBeTruthy();
  });

  it('renders the complete localized accessible shell and persists UI state', async () => {
    const evidence = await runElectron({});
    expect(evidence.renderer.screens).toHaveLength(12);
    expect(evidence.renderer.screens.every((screen) => screen.rendered && screen.title)).toBe(true);
    const deferred = evidence.renderer.screens.filter((screen) =>
      ['memory', 'files', 'automations', 'devices', 'plugins'].includes(screen.id),
    );
    expect(deferred.every((screen) => screen.availability !== null)).toBe(true);
    expect(evidence.renderer.thaiText).toMatchObject({
      language: 'th',
      title: 'การตั้งค่า',
      fits: true,
    });
    expect(evidence.renderer.focus).toEqual({ trapped: true, restored: true });
    expect(evidence.renderer.motion).toEqual({ setting: 'reduced', animationName: 'none' });
    expect(evidence.renderer.tabKeyboard).toEqual({
      selected: 'accessibility',
      focused: 'accessibility',
    });
    expect(evidence.renderer.shortcutDestination).toBe('settings');
    expect(evidence.renderer.keyboard.interactiveCount).toBeGreaterThan(12);
    expect(evidence.renderer.keyboard.unreachableCount).toBe(0);
    expect(evidence.renderer.selectedBeforeReload).toBe(true);
    expect(evidence.reconnection).toMatchObject({
      replayedEventCount: 0,
      currentView: 'plugins',
      language: 'th',
      motion: 'reduced',
      theme: 'midnight',
      missionCount: 1,
      skillCount: 4,
    });
    expect(evidence.responsive.innerWidth).toBeGreaterThanOrEqual(600);
    expect(evidence.responsive.innerHeight).toBeGreaterThanOrEqual(320);
    expect(evidence.responsive.horizontalOverflow).toBe(false);
    expect(evidence.responsive.navigationCount).toBe(12);
    expect(evidence.responsive.screenVisible).toBe(true);
    expect(evidence.keyboardNavigation.activeNavigation).toBe('chat');
    expect(evidence.persistedWindowState).toMatchObject({
      width: 683,
      height: 384,
      maximized: false,
    });
  });

  it('streams and cancels real chat against a configured compatible endpoint without leaking its credential', async () => {
    const evidence = await runElectron({ aiSmoke: true });
    expect(evidence.ai).toMatchObject({
      configureStatus: 'success',
      firstConfigureStatus: 'error',
      firstConfigureCode: 'PERMISSION_REQUIRED',
      permissionRequestFound: true,
      criticalAlwaysAllowOffered: false,
      permissionResolutionStatus: 'success',
      credentialReturned: false,
      streamedDeltas: ['Hello ', 'Jupiter'],
      uiStreamSnapshots: ['Hello ', 'Hello Jupiter'],
      uiComposerReady: true,
      uiSendReady: true,
      uiRequestStarted: true,
      completionStatus: 'success',
      completionText: 'Hello Jupiter',
      cancelAccepted: true,
      cancelledStatus: 'error',
      cancelledCode: 'REQUEST_CANCELLED',
      providerState: 'valid',
      rendererSecretExposure: false,
    });
    expect(evidence.ai.historyCount).toBeGreaterThanOrEqual(4);
    expect(evidence.fileSecurity).toEqual({ rawSecretFound: false, credentialFileCount: 1 });
  });

  it('isolates a Core service crash and exposes degraded health without exiting', async () => {
    const evidence = await runElectron({ forceServiceFailure: true });
    expect(evidence.bootstrapState.runtime.status).toBe('operational');
    expect(evidence.renderer.diagnostics.status).toBe('success');
    expect(evidence.renderer.diagnostics.data?.status).toBe('degraded');
    expect(evidence.renderer.status).toBeTruthy();
  });
});

async function startAiFixture(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'fixture-chat-model' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const payload = JSON.parse(body) as { messages?: { content?: unknown }[] };
      const latestContent = payload.messages?.at(-1)?.content;
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream');
      if (latestContent === 'cancel fixture') {
        response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        setTimeout(() => {
          if (!response.destroyed) response.end('data: [DONE]\n\n');
        }, 500);
        return;
      }
      response.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
      setTimeout(() => {
        if (!response.destroyed) {
          response.write('data: {"choices":[{"delta":{"content":"Jupiter"}}]}\n\n');
          setTimeout(() => {
            if (!response.destroyed) response.end('data: [DONE]\n\n');
          }, 120);
        }
      }, 120);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port.toString()}/v1` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function filesBelow(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    });
  } catch {
    return [];
  }
}
