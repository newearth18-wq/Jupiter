import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BOOTSTRAP_SCHEMA_VERSION,
  BootstrapStateSchema,
  RetryStartupRequestSchema,
  type BootstrapState,
} from '@jupiter/contracts';
import { StructuredLogger } from '@jupiter/core';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import type { WebPreferences } from 'electron';
import { createBootstrapState } from './bootstrap.js';

const IPC = {
  getBootstrapState: 'jupiter:bootstrap:get',
  retryStartup: 'jupiter:bootstrap:retry',
} as const;

let mainWindow: BrowserWindow | null = null;
let bootstrapState: BootstrapState;
let logger: StructuredLogger | undefined;

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

function isTrustedSender(url: string): boolean {
  if (process.env.ELECTRON_RENDERER_URL) return url.startsWith(process.env.ELECTRON_RENDERER_URL);
  return url.startsWith('file://');
}

function registerIpc(): void {
  ipcMain.handle(IPC.getBootstrapState, (event) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) throw new Error('Untrusted IPC sender');
    return BootstrapStateSchema.parse(bootstrapState);
  });

  ipcMain.handle(IPC.retryStartup, (event, request: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) throw new Error('Untrusted IPC sender');
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

async function writeSmokeEvidence(window: BrowserWindow): Promise<void> {
  const evidencePath = process.env.JUPITER_SMOKE_EVIDENCE_PATH;
  if (!evidencePath) throw new Error('JUPITER_SMOKE_EVIDENCE_PATH is required in smoke mode.');

  const renderer: unknown = await window.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const started = Date.now();
      const inspect = () => {
        const status = document.querySelector('[data-testid="runtime-status"]')?.textContent ?? null;
        if (status || Date.now() - started > 10000) {
          resolve({
            title: document.title,
            status,
            hasRequire: typeof require,
            hasProcess: typeof process,
            apiKeys: Object.keys(window.jupiter ?? {}).sort()
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
    webPreferences: {
      contextIsolation: secureWebPreferences.contextIsolation,
      nodeIntegration: secureWebPreferences.nodeIntegration,
      sandbox: secureWebPreferences.sandbox,
      webSecurity: secureWebPreferences.webSecurity,
    },
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
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
