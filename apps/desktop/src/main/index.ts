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
import { app, BrowserWindow, ipcMain, screen, session } from 'electron';
import type { IpcMainInvokeEvent, Rectangle, WebPreferences } from 'electron';
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
let windowStateTimer: NodeJS.Timeout | undefined;

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
  const savedWindowState = coreRuntime?.getWindowState();
  const savedBounds = savedWindowState ? visibleWindowBounds(savedWindowState) : undefined;
  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1180,
    height: savedBounds?.height ?? 760,
    ...(savedBounds === undefined ? {} : { x: savedBounds.x, y: savedBounds.y }),
    minWidth: 600,
    minHeight: 320,
    show: process.env.JUPITER_SMOKE_TEST !== '1',
    backgroundColor: '#090D14',
    title: 'Jupiter',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#090D14',
      symbolColor: '#EDF7FF',
      height: 42,
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      ...secureWebPreferences,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (savedWindowState?.maximized === true) mainWindow.maximize();
  const scheduleWindowStateSave = (): void => {
    if (windowStateTimer) clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(saveWindowState, 250);
  };
  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('move', scheduleWindowStateSave);
  mainWindow.on('maximize', scheduleWindowStateSave);
  mainWindow.on('unmaximize', scheduleWindowStateSave);
  mainWindow.on('close', saveWindowState);
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

function visibleWindowBounds(saved: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Rectangle | undefined {
  const matchingDisplay = screen.getDisplayMatching(saved);
  const area = matchingDisplay.workArea;
  const intersectionWidth = Math.max(
    0,
    Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y),
  );
  if (intersectionWidth < 120 || intersectionHeight < 80) return undefined;
  return {
    x: Math.max(area.x, Math.min(saved.x, area.x + area.width - 120)),
    y: Math.max(area.y, Math.min(saved.y, area.y + area.height - 80)),
    width: Math.min(saved.width, area.width),
    height: Math.min(saved.height, area.height),
  };
}

function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !coreRuntime) return;
  const bounds = mainWindow.getNormalBounds();
  coreRuntime.saveWindowState({
    ...bounds,
    maximized: mainWindow.isMaximized(),
  });
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
          const wait = (duration) => new Promise((done) => setTimeout(done, duration));
          const screenIds = [
            'home', 'chat', 'missions', 'skills', 'memory', 'files',
            'automations', 'models', 'devices', 'plugins', 'settings', 'diagnostics'
          ];
          const screens = [];
          for (const screenId of screenIds) {
            location.hash = '#/' + screenId;
            await wait(80);
            screens.push({
              id: screenId,
              rendered: document.querySelector('[data-screen="' + screenId + '"]') !== null,
              title: document.querySelector('[data-testid="screen-title"]')?.textContent ?? null,
              availability: document.querySelector('[data-testid="availability-state"]')?.getAttribute('data-availability') ?? null
            });
          }

          location.hash = '#/settings';
          await wait(80);
          const languageSelect = document.querySelector('[data-testid="language-select"]');
          if (languageSelect instanceof HTMLSelectElement) {
            languageSelect.value = 'th';
            languageSelect.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const languageStarted = Date.now();
          while (document.documentElement.lang !== 'th' && Date.now() - languageStarted < 3000) {
            await wait(50);
          }
          const thaiTitle = document.querySelector('[data-testid="screen-title"]');
          const thaiText = {
            language: document.documentElement.lang,
            title: thaiTitle?.textContent ?? null,
            fits: thaiTitle instanceof HTMLElement
              ? thaiTitle.scrollHeight <= thaiTitle.clientHeight + 1
              : false,
            lineHeight: thaiTitle instanceof HTMLElement
              ? getComputedStyle(thaiTitle).lineHeight
              : null
          };
          const themeSelect = [...document.querySelectorAll('select')].find((element) =>
            [...element.options].some((option) => option.value === 'midnight')
          );
          if (themeSelect instanceof HTMLSelectElement) {
            themeSelect.value = 'midnight';
            themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const appearanceTab = document.querySelector('[data-tab-id="appearance"]');
          if (appearanceTab instanceof HTMLElement) {
            appearanceTab.focus();
            appearanceTab.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'ArrowRight', bubbles: true
            }));
          }
          await wait(40);
          const tabKeyboard = {
            selected: document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-tab-id') ?? null,
            focused: document.activeElement?.getAttribute('data-tab-id') ?? null
          };
          const safetyTab = document.querySelector('[data-tab-id="safety"]');
          if (safetyTab instanceof HTMLElement) safetyTab.click();
          await wait(40);

          const permissionTrigger = document.querySelector('[data-testid="permission-details"]');
          if (permissionTrigger instanceof HTMLElement) {
            permissionTrigger.focus();
            permissionTrigger.click();
          }
          await wait(60);
          const dialog = document.querySelector('[role="dialog"]');
          const dialogButton = dialog?.querySelector('button');
          if (dialogButton instanceof HTMLElement) dialogButton.focus();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
          const focusTrapped = dialog?.contains(document.activeElement) ?? false;
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await wait(60);
          const focusRestored = document.activeElement === permissionTrigger;

          const accessibilityTab = document.querySelector('[data-tab-id="accessibility"]');
          if (accessibilityTab instanceof HTMLElement) accessibilityTab.click();
          await wait(40);
          const reduceMotion = document.querySelector('[data-testid="reduce-motion-toggle"]');
          if (reduceMotion instanceof HTMLElement) reduceMotion.click();
          const motionStarted = Date.now();
          while (document.documentElement.dataset.motion !== 'reduced' && Date.now() - motionStarted < 3000) {
            await wait(50);
          }
          location.hash = '#/home';
          await wait(80);
          const orbit = document.querySelector('.avatar-orbit');
          const motion = {
            setting: document.documentElement.dataset.motion ?? null,
            animationName: orbit instanceof HTMLElement ? getComputedStyle(orbit).animationName : null
          };
          window.dispatchEvent(new KeyboardEvent('keydown', {
            key: ',', ctrlKey: true, bubbles: true
          }));
          await wait(80);
          const shortcutDestination = document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null;

          const interactive = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
          const keyboard = {
            interactiveCount: interactive.length,
            unreachableCount: interactive.filter((element) =>
              element instanceof HTMLElement &&
              element.tabIndex < 0 &&
              element.getAttribute('role') !== 'tab'
            ).length
          };

          location.hash = '#/plugins';
          await wait(250);
          const selectedBeforeReload = document.querySelector('[data-screen="plugins"]') !== null;
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
            eventCursor,
            screens,
            thaiText,
            focus: { trapped: focusTrapped, restored: focusRestored },
            motion,
            tabKeyboard,
            shortcutDestination,
            keyboard,
            selectedBeforeReload
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
            replayedEventCount: response.status === 'success' ? response.data.events.length : -1,
            currentView: document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null,
            language: document.documentElement.lang,
            motion: document.documentElement.dataset.motion ?? null,
            theme: document.documentElement.dataset.theme ?? null
          });
        } else {
          setTimeout(inspect, 50);
        }
      };
      inspect();
    });
  `);
  window.setContentSize(683, 384);
  saveWindowState();
  const responsive: unknown = await window.webContents.executeJavaScript(`({
    innerWidth,
    innerHeight,
    documentScrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    navigationCount: document.querySelectorAll('[data-nav-id]').length,
    screenVisible: document.querySelector('[data-screen]') !== null
  })`);

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-nav-id="home"]')?.focus()`,
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  const keyboardNavigation: unknown = await window.webContents
    .executeJavaScript(`new Promise((resolve) => {
    setTimeout(() => resolve({
      activeNavigation: document.activeElement?.getAttribute('data-nav-id') ?? null
    }), 50);
  })`);
  const screenshotPath = process.env.JUPITER_SMOKE_SCREENSHOT_PATH;
  if (screenshotPath) {
    window.setContentSize(1180, 760);
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
      location.hash = '#/home';
      const startedAt = Date.now();
      const waitForHome = () => {
        const activeScreen = document.querySelector('[data-screen]')?.getAttribute('data-screen');
        if (activeScreen === 'home' || Date.now() - startedAt >= 3000) {
          setTimeout(resolve, 250);
          return;
        }
        setTimeout(waitForHome, 50);
      };
      waitForHome();
    })`);
    const screenshot = await window.webContents.capturePage();
    mkdirSync(dirname(screenshotPath), { recursive: true });
    writeFileSync(screenshotPath, screenshot.toPNG());
  }
  const evidence = {
    timestamp: new Date().toISOString(),
    bootstrapState,
    renderer,
    reconnection,
    responsive,
    keyboardNavigation,
    persistedWindowState: coreRuntime?.getWindowState(),
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
