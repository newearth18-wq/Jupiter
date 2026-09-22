import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BOOTSTRAP_SCHEMA_VERSION,
  BootstrapStateSchema,
  CancelRequestSchema,
  RpcRequestEnvelopeSchema,
  RetryStartupRequestSchema,
  type BootstrapState,
  type DomainEvent,
} from '@jupiter/contracts';
import { StructuredLogger } from '@jupiter/core';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import type { IpcMainInvokeEvent, WebPreferences } from 'electron';
import { createBootstrapState } from './bootstrap.js';
import { DesktopCoreRuntime } from './core-runtime.js';

const IPC = {
  getBootstrapState: 'jupiter:bootstrap:get',
  retryStartup: 'jupiter:bootstrap:retry',
  rpcRequest: 'jupiter:rpc:request',
  rpcCancel: 'jupiter:rpc:cancel',
  domainEvent: 'jupiter:domain-event',
} as const;

let mainWindow: BrowserWindow | null = null;
let bootstrapState: BootstrapState;
let logger: StructuredLogger | undefined;
let coreRuntime: DesktopCoreRuntime | undefined;
let unsubscribeCoreEvents: (() => void) | undefined;
let normalShutdownStarted = false;
const activeRequests = new Map<string, AbortController>();

const secureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  devTools: !app.isPackaged,
} satisfies WebPreferences;

if (process.env.JUPITER_SMOKE_TEST === '1') {
  app.commandLine.appendSwitch('disable-gpu');
}

function createState(): BootstrapState {
  return createBootstrapState({
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    runtimePlatform: { platform: process.platform, architecture: process.arch },
    environment: process.env.JUPITER_APP_ENV ?? (app.isPackaged ? 'production' : 'development'),
    forceStartupFailure: process.env.JUPITER_FORCE_STARTUP_FAILURE === '1',
  });
}

function isTrustedUrl(url: string): boolean {
  if (process.env.ELECTRON_RENDERER_URL) return url.startsWith(process.env.ELECTRON_RENDERER_URL);
  return url.startsWith('file://');
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    event.sender.id !== mainWindow?.webContents.id ||
    !isTrustedUrl(event.senderFrame?.url ?? '')
  ) {
    throw new Error('Untrusted IPC sender');
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.getBootstrapState, (event) => {
    assertTrustedSender(event);
    return BootstrapStateSchema.parse(bootstrapState);
  });

  ipcMain.handle(IPC.retryStartup, (event, request: unknown) => {
    assertTrustedSender(event);
    const input = RetryStartupRequestSchema.parse(request);
    bootstrapState = createState();
    logger?.log(
      bootstrapState.runtime.status === 'operational' ? 'info' : 'warn',
      'foundation.startup.retry',
      'Foundation startup retry completed.',
      input.correlationId,
      { status: bootstrapState.runtime.status },
    );
    return BootstrapStateSchema.parse(bootstrapState);
  });

  ipcMain.handle(IPC.rpcRequest, async (event, input: unknown) => {
    assertTrustedSender(event);
    if (!coreRuntime) throw new Error('Core runtime is unavailable.');

    const parsed = RpcRequestEnvelopeSchema.safeParse(input);
    const requestId = parsed.success ? parsed.data.context.requestId : undefined;
    const controller = new AbortController();
    if (requestId !== undefined) activeRequests.set(requestId, controller);
    try {
      return await coreRuntime.request(input, 'renderer', controller.signal);
    } finally {
      if (requestId !== undefined) activeRequests.delete(requestId);
    }
  });

  ipcMain.handle(IPC.rpcCancel, (event, input: unknown) => {
    assertTrustedSender(event);
    const request = CancelRequestSchema.parse(input);
    const controller = activeRequests.get(request.requestId);
    controller?.abort();
    return controller !== undefined;
  });
}

function applySessionSecurity(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: process.env.JUPITER_SMOKE_TEST !== '1',
    backgroundColor: '#090D14',
    title: 'Jupiter',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      ...secureWebPreferences,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger?.log('error', 'renderer.preload.failed', error.message, randomUUID(), {
      preload: preloadPath,
      errorName: error.name,
    });
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL() ?? '';
    if (url !== currentUrl) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  if (process.env.JUPITER_SMOKE_TEST === '1') await writeSmokeEvidence(mainWindow);
}

function broadcastDomainEvent(event: DomainEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.domainEvent, event);
  }
}

async function writeSmokeEvidence(window: BrowserWindow): Promise<void> {
  const evidencePath = process.env.JUPITER_SMOKE_EVIDENCE_PATH;
  if (!evidencePath) throw new Error('JUPITER_SMOKE_EVIDENCE_PATH is required in smoke mode.');

  const renderer: unknown = await window.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const started = Date.now();
      const inspect = async () => {
        const status = document.querySelector('[data-testid="runtime-status"]')?.textContent ?? null;
        const eventCursor = Number(sessionStorage.getItem('jupiter:event-cursor') ?? 0);
        if ((status && eventCursor > 0) || Date.now() - started > 10000) {
          const makeContext = (actor = 'renderer') => ({
            requestId: crypto.randomUUID(),
            actor,
            timestamp: new Date().toISOString()
          });
          const ping = await window.jupiter.request({
            schemaVersion: 1,
            kind: 'query',
            name: 'core.ping',
            context: makeContext(),
            payload: { message: 'smoke-pong' }
          });
          const diagnostics = await window.jupiter.request({
            schemaVersion: 1,
            kind: 'query',
            name: 'diagnostics.get',
            context: makeContext(),
            payload: {}
          });
          const denied = await window.jupiter.request({
            schemaVersion: 1,
            kind: 'query',
            name: 'core.ping',
            context: makeContext('core'),
            payload: {}
          });
          let invalidRejected = false;
          try {
            await window.jupiter.request({ name: 'unsafe.execute', payload: {} });
          } catch {
            invalidRejected = true;
          }
          resolve({
            title: document.title,
            status,
            hasRequire: typeof require,
            hasProcess: typeof process,
            apiKeys: Object.keys(window.jupiter ?? {}).sort(),
            hasArbitraryFileApi: typeof window.jupiter?.readFile,
            hasCredentialApi: typeof window.jupiter?.getCredential,
            ping,
            diagnostics,
            denied,
            invalidRejected,
            eventCursor
          });
        } else {
          setTimeout(inspect, 50);
        }
      };
      inspect();
    });
  `);
  const reloaded = new Promise<void>((resolveReload) => {
    window.webContents.once('did-finish-load', () => resolveReload());
  });
  window.webContents.reload();
  await reloaded;
  const reconnection: unknown = await window.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const started = Date.now();
      const inspect = async () => {
        const status = document.querySelector('[data-testid="runtime-status"]')?.textContent ?? null;
        const cursor = Number(sessionStorage.getItem('jupiter:event-cursor') ?? 0);
        if ((status && cursor > 0) || Date.now() - started > 10000) {
          const response = await window.jupiter.request({
            schemaVersion: 1,
            kind: 'query',
            name: 'events.replay',
            context: {
              requestId: crypto.randomUUID(),
              actor: 'renderer',
              timestamp: new Date().toISOString()
            },
            payload: { afterSequence: cursor, limit: 500 }
          });
          resolve({
            cursor,
            replayedEventCount: response.status === 'success' ? response.data.events.length : -1
          });
        } else {
          setTimeout(inspect, 50);
        }
      };
      inspect();
    });
  `);
  const evidence = {
    timestamp: new Date().toISOString(),
    bootstrapState,
    renderer,
    reconnection,
    webPreferences: {
      contextIsolation: secureWebPreferences.contextIsolation,
      nodeIntegration: secureWebPreferences.nodeIntegration,
      sandbox: secureWebPreferences.sandbox,
      webSecurity: secureWebPreferences.webSecurity,
    },
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  unsubscribeCoreEvents?.();
  await coreRuntime?.shutdown();
  app.exit(0);
}

function installProcessGuards(): void {
  process.on('uncaughtException', (error) => {
    logger?.log('error', 'process.uncaughtException', error.message, randomUUID(), {
      name: error.name,
    });
  });
  process.on('unhandledRejection', (reason) => {
    logger?.log(
      'error',
      'process.unhandledRejection',
      'Unhandled promise rejection',
      randomUUID(),
      {
        reason: reason instanceof Error ? reason.message : String(reason),
      },
    );
  });
}

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app
    .whenReady()
    .then(async () => {
      logger = new StructuredLogger({ filePath: join(app.getPath('logs'), 'jupiter.jsonl') });
      installProcessGuards();
      bootstrapState = createState();
      const correlationId = bootstrapState.correlationId;
      logger.log(
        bootstrapState.runtime.status === 'operational' ? 'info' : 'warn',
        'foundation.startup',
        'Jupiter foundation startup completed.',
        correlationId,
        { status: bootstrapState.runtime.status, schemaVersion: BOOTSTRAP_SCHEMA_VERSION },
      );
      applySessionSecurity();
      const dataDirectory =
        process.env.JUPITER_APP_ENV === 'test' && process.env.JUPITER_DATA_DIR
          ? process.env.JUPITER_DATA_DIR
          : join(app.getPath('userData'), 'data');
      coreRuntime = new DesktopCoreRuntime({
        dataDirectory,
        version: app.getVersion(),
        forceServiceFailure: process.env.JUPITER_FORCE_SERVICE_FAILURE === '1',
      });
      unsubscribeCoreEvents = coreRuntime.subscribe(broadcastDomainEvent);
      const diagnostics = await coreRuntime.start(new AbortController().signal);
      logger.log(
        diagnostics.status === 'operational' ? 'info' : 'warn',
        'core.startup',
        'Jupiter Core startup completed.',
        correlationId,
        { status: diagnostics.status, databaseSchema: diagnostics.database.schemaVersion },
      );
      registerIpc();
      await createWindow();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown application startup error';
      logger?.log('error', 'application.startup.failed', message, randomUUID());
      app.exit(1);
    });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (!coreRuntime || normalShutdownStarted) return;
  event.preventDefault();
  normalShutdownStarted = true;
  unsubscribeCoreEvents?.();
  for (const controller of activeRequests.values()) controller.abort();
  void coreRuntime
    .shutdown()
    .catch((error: unknown) => {
      logger?.log(
        'error',
        'core.shutdown.failed',
        error instanceof Error ? error.message : 'Unknown shutdown error',
        randomUUID(),
      );
    })
    .finally(() => app.exit(0));
});
app.on('will-quit', () => {
  unsubscribeCoreEvents?.();
  for (const controller of activeRequests.values()) controller.abort();
});
