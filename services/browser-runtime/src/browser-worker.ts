import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from 'playwright-core';
import type { BrowserActionInput, BrowserSelector } from '@jupiter/contracts';

type WorkerRequest =
  | { kind: 'execute'; requestId: string; action: BrowserActionInput }
  | { kind: 'cancel'; requestId: string; actionId: string }
  | { kind: 'shutdown'; requestId: string };

type WorkerResponse = {
  requestId: string;
  result?: NativeResult;
  cancelled?: boolean;
  shutdown?: boolean;
  error?: { code: string; message: string; recoverable: boolean };
};

type NativeResult = {
  success: boolean;
  status?: 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'PAUSED';
  observation: string;
  sessionId?: string;
  tabId?: string;
  page?: { url: string; origin: string; title: string };
  output?: Record<string, unknown>;
  evidence?: NativeEvidence[];
  securitySignals?: { type: string; severity: string; description: string }[];
  error?: { code: string; message: string; recoverable: boolean };
};

type NativeEvidence = {
  kind: 'screenshot' | 'download' | 'html';
  path: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  verified: boolean;
  sourceOrigin: string;
};

type SessionState = {
  sessionId: string;
  missionId?: string;
  status: 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'CRASHED';
  profileMode: 'TEMPORARY' | 'PERSISTENT';
  profileName?: string;
  allowedOrigins: Set<string>;
  downloadDirectory: string;
  browser?: Browser;
  context: BrowserContext;
  tabs: Map<string, Page>;
  activeTabId?: string;
  createdAt: string;
  updatedAt: string;
};

const configuredExecutablePath = process.env.JUPITER_BROWSER_EXECUTABLE;
const configuredProfileRoot = process.env.JUPITER_BROWSER_PROFILE_ROOT;
if (!configuredExecutablePath || !configuredProfileRoot)
  throw new Error('Browser worker configuration is incomplete.');
const executablePath = configuredExecutablePath;
const profileRoot = configuredProfileRoot;

const sessions = new Map<string, SessionState>();
const activeActions = new Map<string, AbortController>();
const pageTitles = new WeakMap<Page, string>();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on('line', (line) => {
  void handleLine(line);
});

async function handleLine(line: string): Promise<void> {
  let request: WorkerRequest;
  try {
    request = JSON.parse(line) as WorkerRequest;
    if (typeof request.requestId !== 'string') {
      throw new Error('Invalid worker request envelope.');
    }
  } catch {
    respond({
      requestId: randomUUID(),
      error: {
        code: 'INVALID_WORKER_REQUEST',
        message: 'Browser worker request was invalid.',
        recoverable: false,
      },
    });
    return;
  }

  if (request.kind === 'cancel') {
    const controller = activeActions.get(request.actionId);
    if (controller && !controller.signal.aborted) controller.abort('Browser action cancelled.');
    respond({ requestId: request.requestId, cancelled: controller !== undefined });
    return;
  }
  if (request.kind === 'shutdown') {
    await shutdown();
    respond({ requestId: request.requestId, shutdown: true });
    return;
  }
  const controller = new AbortController();
  activeActions.set(request.action.actionId, controller);
  try {
    const result = await execute(request.action, controller.signal);
    respond({ requestId: request.requestId, result });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    respond({
      requestId: request.requestId,
      result: failure(
        cancelled ? 'BROWSER_ACTION_CANCELLED' : 'BROWSER_WORKER_ACTION_FAILED',
        cancelled ? 'The browser action was cancelled.' : sanitize(error),
        cancelled ? 'CANCELLED' : 'FAILED',
      ),
    });
  } finally {
    activeActions.delete(request.action.actionId);
  }
}

async function execute(action: BrowserActionInput, signal: AbortSignal): Promise<NativeResult> {
  if (action.action === 'CREATE_SESSION') return createSession(action, signal);
  const session = requireSession(action.sessionId);
  if (action.action === 'CLOSE_SESSION') return closeSession(session);
  if (session.status === 'PAUSED' && action.action !== 'NAVIGATE') {
    return paused(
      session,
      action.tabId,
      'SESSION_PAUSED_UNEXPECTED_ORIGIN',
      'The session is paused after unexpected cross-origin navigation. Navigate explicitly to an approved origin or close it.',
    );
  }
  if (action.action === 'NAVIGATE') return navigate(session, action, signal);
  if (action.action === 'OPEN_TAB') return openTab(session, action, signal);
  if (action.action === 'CLOSE_TAB') return closeTab(session, action.tabId);
  if (action.action === 'SWITCH_TAB') return switchTab(session, action.tabId);

  const { tabId, page } = requirePage(session, action.tabId);
  const currentOrigin = originOf(page.url());
  if (!session.allowedOrigins.has(currentOrigin)) {
    return pauseUnexpectedOrigin(
      session,
      tabId,
      page,
      [...session.allowedOrigins].join(', ') || 'an explicitly approved origin',
    );
  }
  if (action.action === 'CLICK') {
    ensureCurrentOrigin(page, action.parameters.expectedOrigin);
    await cancellable(resolveSelector(page, action.parameters.selector).click(), signal, page);
    return observeAfterInteraction(
      session,
      tabId,
      page,
      action.parameters.expectedOrigin,
      'The semantic element was clicked.',
    );
  }
  if (action.action === 'TYPE_TEXT') {
    ensureCurrentOrigin(page, action.parameters.expectedOrigin);
    await cancellable(
      resolveSelector(page, action.parameters.selector).fill(action.parameters.text),
      signal,
      page,
    );
    return success(session, tabId, page, 'Text was entered through a semantic selector.');
  }
  if (action.action === 'FILL_FORM') {
    ensureCurrentOrigin(page, action.parameters.expectedOrigin);
    for (const field of action.parameters.fields) {
      await cancellable(resolveSelector(page, field.selector).fill(field.value), signal, page);
    }
    return success(
      session,
      tabId,
      page,
      'The approved fields were filled without submitting the form.',
    );
  }
  if (action.action === 'SELECT_OPTION') {
    ensureCurrentOrigin(page, action.parameters.expectedOrigin);
    await cancellable(
      resolveSelector(page, action.parameters.selector).selectOption(action.parameters.values),
      signal,
      page,
    );
    return success(session, tabId, page, 'The approved option was selected.');
  }
  if (action.action === 'PRESS_KEYS') {
    ensureCurrentOrigin(page, action.parameters.expectedOrigin);
    await cancellable(page.keyboard.press(action.parameters.keys), signal, page);
    return observeAfterInteraction(
      session,
      tabId,
      page,
      action.parameters.expectedOrigin,
      'The approved keyboard shortcut was sent.',
    );
  }
  if (action.action === 'UPLOAD_FILE') return uploadFile(session, tabId, page, action, signal);
  if (action.action === 'DOWNLOAD_FILE') return downloadFile(session, tabId, page, action, signal);
  if (action.action === 'READ_PAGE')
    return readPage(session, tabId, page, action.parameters.maxCharacters, signal);
  if (action.action === 'EXTRACT_DATA')
    return extractData(session, tabId, page, action.parameters.fields, signal);
  if (action.action === 'SCREENSHOT')
    return screenshot(
      session,
      tabId,
      page,
      action.parameters.outputPath,
      action.parameters.fullPage,
      signal,
    );
  if (action.action === 'HTML_SNAPSHOT')
    return htmlSnapshot(session, tabId, page, action.parameters.outputPath, signal);
  if (action.action === 'WAIT_FOR') return waitFor(session, tabId, page, action, signal);
  if (action.action === 'SET_COOKIES') {
    if (
      action.parameters.cookies.some((cookie) => !session.allowedOrigins.has(originOf(cookie.url)))
    ) {
      return paused(
        session,
        tabId,
        'COOKIE_ORIGIN_NOT_APPROVED',
        'Cookies cannot be set for an unapproved origin.',
      );
    }
    await session.context.addCookies(action.parameters.cookies);
    return success(
      session,
      tabId,
      page,
      `Set ${String(action.parameters.cookies.length)} approved cookies.`,
      {
        cookieCount: action.parameters.cookies.length,
      },
    );
  }
  if (action.action === 'CLEAR_COOKIES') {
    await session.context.clearCookies();
    return success(session, tabId, page, 'Cookies for the isolated browser context were cleared.', {
      cookieCount: 0,
    });
  }
  if (action.action === 'GRANT_ORIGIN_PERMISSIONS') {
    if (!session.allowedOrigins.has(action.parameters.origin)) {
      return paused(
        session,
        tabId,
        'ORIGIN_NOT_APPROVED',
        'Permissions cannot be granted to an unapproved origin.',
      );
    }
    await session.context.grantPermissions(action.parameters.permissions, {
      origin: action.parameters.origin,
    });
    return success(session, tabId, page, 'Origin-scoped browser permissions were applied.');
  }
  ensureCurrentOrigin(page, action.parameters.expectedOrigin);
  await cancellable(resolveSelector(page, action.parameters.selector).click(), signal, page);
  return observeAfterInteraction(
    session,
    tabId,
    page,
    action.parameters.expectedOrigin,
    'The explicitly approved form was submitted.',
  );
}

async function createSession(
  action: Extract<BrowserActionInput, { action: 'CREATE_SESSION' }>,
  signal: AbortSignal,
): Promise<NativeResult> {
  if (signal.aborted) throw new Error('Cancelled.');
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  mkdirSync(action.parameters.downloadDirectory, { recursive: true });
  let context: BrowserContext;
  let browser: Browser | undefined;
  if (action.parameters.profileMode === 'PERSISTENT') {
    if (!action.parameters.profileName) throw new Error('Persistent browser profile name missing.');
    const safeName = action.parameters.profileName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const userDataDirectory = join(profileRoot, safeName);
    mkdirSync(userDataDirectory, { recursive: true });
    context = await chromium.launchPersistentContext(userDataDirectory, {
      executablePath,
      headless: action.parameters.headless,
      acceptDownloads: true,
    });
    await Promise.all(context.pages().map((page) => page.close()));
  } else {
    browser = await chromium.launch({ executablePath, headless: action.parameters.headless });
    context = await browser.newContext({ acceptDownloads: true });
  }
  const session: SessionState = {
    sessionId,
    ...(action.missionId ? { missionId: action.missionId } : {}),
    status: 'ACTIVE',
    profileMode: action.parameters.profileMode,
    ...(action.parameters.profileName ? { profileName: action.parameters.profileName } : {}),
    allowedOrigins: new Set(action.parameters.allowedOrigins),
    downloadDirectory: resolve(action.parameters.downloadDirectory),
    ...(browser ? { browser } : {}),
    context,
    tabs: new Map(),
    createdAt: now,
    updatedAt: now,
  };
  browser?.on('disconnected', () => {
    if (session.status !== 'CLOSED') session.status = 'CRASHED';
  });
  sessions.set(sessionId, session);
  return {
    success: true,
    observation: 'An isolated Playwright browser session was created.',
    sessionId,
    output: { session: sessionRecord(session) },
  };
}

async function closeSession(session: SessionState): Promise<NativeResult> {
  session.status = 'CLOSED';
  session.updatedAt = new Date().toISOString();
  await session.context.close().catch(() => undefined);
  await session.browser?.close().catch(() => undefined);
  sessions.delete(session.sessionId);
  return {
    success: true,
    observation: 'The isolated browser session closed.',
    sessionId: session.sessionId,
  };
}

async function navigate(
  session: SessionState,
  action: Extract<BrowserActionInput, { action: 'NAVIGATE' }>,
  signal: AbortSignal,
): Promise<NativeResult> {
  let tabId = action.tabId;
  let page: Page;
  if (tabId) page = requirePage(session, tabId).page;
  else {
    page = await session.context.newPage();
    tabId = randomUUID();
    session.tabs.set(tabId, page);
    session.activeTabId = tabId;
  }
  await cancellable(
    page.goto(action.parameters.url, { waitUntil: 'domcontentloaded', timeout: action.timeoutMs }),
    signal,
    page,
  );
  await refreshPageTitle(page);
  const finalOrigin = originOf(page.url());
  if (finalOrigin !== action.parameters.expectedOrigin) {
    return pauseUnexpectedOrigin(session, tabId, page, action.parameters.expectedOrigin);
  }
  session.allowedOrigins.add(action.parameters.expectedOrigin);
  session.status = 'ACTIVE';
  session.updatedAt = new Date().toISOString();
  return success(session, tabId, page, 'Navigation reached the exact expected origin.', {
    session: sessionRecord(session),
  });
}

async function openTab(
  session: SessionState,
  action: Extract<BrowserActionInput, { action: 'OPEN_TAB' }>,
  signal: AbortSignal,
): Promise<NativeResult> {
  const page = await session.context.newPage();
  const tabId = randomUUID();
  session.tabs.set(tabId, page);
  session.activeTabId = tabId;
  await cancellable(
    page.goto(action.parameters.url, { waitUntil: 'domcontentloaded', timeout: action.timeoutMs }),
    signal,
    page,
  );
  await refreshPageTitle(page);
  if (originOf(page.url()) !== action.parameters.expectedOrigin) {
    return pauseUnexpectedOrigin(session, tabId, page, action.parameters.expectedOrigin);
  }
  session.allowedOrigins.add(action.parameters.expectedOrigin);
  return success(session, tabId, page, 'A new isolated tab opened at the expected origin.', {
    session: sessionRecord(session),
  });
}

async function closeTab(session: SessionState, requestedTabId?: string): Promise<NativeResult> {
  const { tabId, page } = requirePage(session, requestedTabId);
  await page.close();
  session.tabs.delete(tabId);
  const remainingTabId = [...session.tabs.keys()].at(-1);
  if (remainingTabId) session.activeTabId = remainingTabId;
  else delete session.activeTabId;
  session.updatedAt = new Date().toISOString();
  return {
    success: true,
    observation: 'The exact isolated tab closed.',
    sessionId: session.sessionId,
    tabId,
    output: { session: sessionRecord(session) },
  };
}

function switchTab(session: SessionState, requestedTabId?: string): NativeResult {
  const { tabId, page } = requirePage(session, requestedTabId);
  session.activeTabId = tabId;
  session.updatedAt = new Date().toISOString();
  void page.bringToFront();
  return success(session, tabId, page, 'The exact isolated tab became active.', {
    session: sessionRecord(session),
  });
}

async function readPage(
  session: SessionState,
  tabId: string,
  page: Page,
  maxCharacters: number,
  signal: AbortSignal,
): Promise<NativeResult> {
  const text = (await cancellable(page.locator('body').innerText(), signal, page)).slice(
    0,
    maxCharacters,
  );
  await refreshPageTitle(page);
  const securitySignals = detectPromptInjection(text);
  return success(
    session,
    tabId,
    page,
    'Visible page text was read as untrusted content.',
    { visibleText: text },
    [],
    securitySignals,
  );
}

async function extractData(
  session: SessionState,
  tabId: string,
  page: Page,
  fields: readonly { name: string; selector: BrowserSelector }[],
  signal: AbortSignal,
): Promise<NativeResult> {
  const extraction: Record<string, string | string[]> = {};
  for (const field of fields) {
    const values = await cancellable(
      resolveSelector(page, field.selector).allTextContents(),
      signal,
      page,
    );
    extraction[field.name] = values.length === 1 ? (values[0] ?? '') : values;
  }
  await refreshPageTitle(page);
  return success(
    session,
    tabId,
    page,
    'Structured data was extracted through declared semantic selectors.',
    { extraction },
  );
}

async function uploadFile(
  session: SessionState,
  tabId: string,
  page: Page,
  action: Extract<BrowserActionInput, { action: 'UPLOAD_FILE' }>,
  signal: AbortSignal,
): Promise<NativeResult> {
  ensureCurrentOrigin(page, action.parameters.expectedOrigin);
  const filePath = resolve(action.parameters.filePath);
  if (!existsSync(filePath))
    return failure(
      'UPLOAD_FILE_MISSING',
      'The exact approved upload file does not exist.',
      'FAILED',
      session,
      tabId,
      page,
    );
  const extension = extname(filePath).toLowerCase();
  if (!action.parameters.allowedExtensions.map((item) => item.toLowerCase()).includes(extension)) {
    return failure(
      'UPLOAD_FILE_TYPE_BLOCKED',
      'The approved upload file type is not allowed.',
      'FAILED',
      session,
      tabId,
      page,
    );
  }
  if (statSync(filePath).size > action.parameters.maxBytes) {
    return failure(
      'UPLOAD_FILE_TOO_LARGE',
      'The approved upload file exceeds the allowed size.',
      'FAILED',
      session,
      tabId,
      page,
    );
  }
  await cancellable(
    resolveSelector(page, action.parameters.selector).setInputFiles(filePath),
    signal,
    page,
  );
  return success(
    session,
    tabId,
    page,
    'The exact approved file was attached to the semantic file control.',
  );
}

async function downloadFile(
  session: SessionState,
  tabId: string,
  page: Page,
  action: Extract<BrowserActionInput, { action: 'DOWNLOAD_FILE' }>,
  signal: AbortSignal,
): Promise<NativeResult> {
  ensureCurrentOrigin(page, action.parameters.expectedOrigin);
  const downloadPromise = page.waitForEvent('download', { timeout: action.timeoutMs });
  await cancellable(resolveSelector(page, action.parameters.selector).click(), signal, page);
  const download = await cancellable(downloadPromise, signal, page);
  const suggested = download.suggestedFilename();
  if (basename(suggested) !== suggested)
    return failure(
      'DOWNLOAD_NAME_INVALID',
      'The download filename was unsafe.',
      'FAILED',
      session,
      tabId,
      page,
    );
  const extension = extname(suggested).toLowerCase();
  if (!action.parameters.allowedExtensions.map((item) => item.toLowerCase()).includes(extension)) {
    return failure(
      'DOWNLOAD_FILE_TYPE_BLOCKED',
      'The download file type is not approved.',
      'FAILED',
      session,
      tabId,
      page,
    );
  }
  const path = resolve(session.downloadDirectory, `${randomUUID()}-${suggested}`);
  if (!path.startsWith(`${session.downloadDirectory}${sep}`)) {
    return failure(
      'DOWNLOAD_PATH_INVALID',
      'The managed download path was invalid.',
      'FAILED',
      session,
      tabId,
      page,
    );
  }
  await download.saveAs(path);
  const size = statSync(path).size;
  if (size > action.parameters.maxBytes) {
    rmSync(path, { force: true });
    return failure(
      'DOWNLOAD_FILE_TOO_LARGE',
      'The download exceeded the approved size and was removed from the managed directory.',
      'FAILED',
      session,
      tabId,
      page,
    );
  }
  const artifact = artifactFor(path, 'download', contentType(extension), originOf(page.url()));
  return success(
    session,
    tabId,
    page,
    'The download was stored and verified in the managed directory.',
    undefined,
    [artifact],
  );
}

async function screenshot(
  session: SessionState,
  tabId: string,
  page: Page,
  outputPath: string,
  fullPage: boolean,
  signal: AbortSignal,
): Promise<NativeResult> {
  const path = resolve(outputPath);
  if (!existsSync(dirname(path)))
    return failure(
      'ARTIFACT_DIRECTORY_MISSING',
      'The approved screenshot directory does not exist.',
      'FAILED',
      session,
      tabId,
      page,
    );
  await cancellable(page.screenshot({ path, fullPage }), signal, page);
  return success(
    session,
    tabId,
    page,
    'A screenshot of the isolated page was captured.',
    undefined,
    [artifactFor(path, 'screenshot', 'image/png', originOf(page.url()))],
  );
}

async function htmlSnapshot(
  session: SessionState,
  tabId: string,
  page: Page,
  outputPath: string,
  signal: AbortSignal,
): Promise<NativeResult> {
  const path = resolve(outputPath);
  if (!existsSync(dirname(path)))
    return failure(
      'ARTIFACT_DIRECTORY_MISSING',
      'The approved snapshot directory does not exist.',
      'FAILED',
      session,
      tabId,
      page,
    );
  const html = await cancellable(page.content(), signal, page);
  writeFileSync(path, html, 'utf8');
  return success(session, tabId, page, 'An untrusted HTML snapshot was captured.', undefined, [
    artifactFor(path, 'html', 'text/html', originOf(page.url())),
  ]);
}

async function waitFor(
  session: SessionState,
  tabId: string,
  page: Page,
  action: Extract<BrowserActionInput, { action: 'WAIT_FOR' }>,
  signal: AbortSignal,
): Promise<NativeResult> {
  if (action.parameters.selector) {
    const state = action.parameters.state.toLowerCase() as
      'attached' | 'visible' | 'hidden' | 'detached';
    await cancellable(
      resolveSelector(page, action.parameters.selector).waitFor({
        state,
        timeout: action.timeoutMs,
      }),
      signal,
      page,
    );
  } else {
    const state = action.parameters.state.toLowerCase() as
      'load' | 'domcontentloaded' | 'networkidle';
    await cancellable(page.waitForLoadState(state, { timeout: action.timeoutMs }), signal, page);
  }
  return success(session, tabId, page, 'The exact page state was observed.');
}

async function observeAfterInteraction(
  session: SessionState,
  tabId: string,
  page: Page,
  expectedOrigin: string,
  observation: string,
): Promise<NativeResult> {
  await page.waitForTimeout(100);
  await refreshPageTitle(page);
  const currentOrigin = originOf(page.url());
  if (currentOrigin !== expectedOrigin && !session.allowedOrigins.has(currentOrigin)) {
    return pauseUnexpectedOrigin(session, tabId, page, expectedOrigin);
  }
  return success(session, tabId, page, observation);
}

function pauseUnexpectedOrigin(
  session: SessionState,
  tabId: string,
  page: Page,
  expectedOrigin: string,
): NativeResult {
  session.status = 'PAUSED';
  session.updatedAt = new Date().toISOString();
  const actualOrigin = originOf(page.url());
  return {
    success: false,
    status: 'PAUSED',
    observation: 'Browser work paused after an unexpected cross-origin navigation.',
    sessionId: session.sessionId,
    tabId,
    page: pageObservation(page),
    evidence: [],
    securitySignals: [
      {
        type: 'UNEXPECTED_ORIGIN',
        severity: 'BLOCKED',
        description: `Expected ${expectedOrigin}; observed ${actualOrigin}.`,
      },
    ],
    error: {
      code: 'UNEXPECTED_ORIGIN',
      message: 'Unexpected cross-origin navigation paused the session.',
      recoverable: true,
    },
  };
}

function paused(
  session: SessionState,
  tabId: string | undefined,
  code: string,
  message: string,
): NativeResult {
  const page = tabId
    ? session.tabs.get(tabId)
    : session.activeTabId
      ? session.tabs.get(session.activeTabId)
      : undefined;
  return {
    success: false,
    status: 'PAUSED',
    observation: message,
    sessionId: session.sessionId,
    ...(tabId ? { tabId } : {}),
    ...(page && isWebUrl(page.url()) ? { page: pageObservation(page) } : {}),
    evidence: [],
    securitySignals: [],
    error: { code, message, recoverable: true },
  };
}

function success(
  session: SessionState,
  tabId: string,
  page: Page,
  observation: string,
  output?: Record<string, unknown>,
  evidence: NativeEvidence[] = [],
  securitySignals: NativeResult['securitySignals'] = [],
): NativeResult {
  session.updatedAt = new Date().toISOString();
  return {
    success: true,
    observation,
    sessionId: session.sessionId,
    tabId,
    page: pageObservation(page),
    ...(output ? { output } : {}),
    evidence,
    securitySignals,
  };
}

function failure(
  code: string,
  message: string,
  status: 'FAILED' | 'CANCELLED',
  session?: SessionState,
  tabId?: string,
  page?: Page,
): NativeResult {
  return {
    success: false,
    status,
    observation: message,
    ...(session ? { sessionId: session.sessionId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(page && isWebUrl(page.url()) ? { page: pageObservation(page) } : {}),
    evidence: [],
    securitySignals: [],
    error: { code, message, recoverable: true },
  };
}

function resolveSelector(page: Page, selector: BrowserSelector): Locator {
  if (selector.kind === 'role') {
    return page.getByRole(selector.role as never, {
      ...(selector.name ? { name: selector.name } : {}),
      exact: selector.exact,
    });
  }
  if (selector.kind === 'label') return page.getByLabel(selector.label, { exact: selector.exact });
  if (selector.kind === 'text') return page.getByText(selector.text, { exact: selector.exact });
  if (selector.kind === 'testId') return page.getByTestId(selector.testId);
  return page.locator(selector.selector);
}

function requireSession(sessionId?: string): SessionState {
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session || ['CLOSED', 'CRASHED'].includes(session.status))
    throw new Error('The exact browser session is unavailable.');
  return session;
}

function requirePage(
  session: SessionState,
  requestedTabId?: string,
): { tabId: string; page: Page } {
  const tabId = requestedTabId ?? session.activeTabId;
  const page = tabId ? session.tabs.get(tabId) : undefined;
  if (!tabId || !page || page.isClosed()) throw new Error('The exact browser tab is unavailable.');
  return { tabId, page };
}

function ensureCurrentOrigin(page: Page, expectedOrigin: string): void {
  if (originOf(page.url()) !== expectedOrigin)
    throw new Error('The current page origin does not match the exact approved origin.');
}

function pageObservation(page: Page): { url: string; origin: string; title: string } {
  const url = page.url();
  return { url, origin: originOf(url), title: pageTitles.get(page) ?? 'Browser page' };
}

async function refreshPageTitle(page: Page): Promise<void> {
  pageTitles.set(page, (await page.title().catch(() => 'Browser page')).slice(0, 1_000));
}

function sessionRecord(session: SessionState): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    ...(session.missionId ? { missionId: session.missionId } : {}),
    status: session.status,
    profileMode: session.profileMode,
    ...(session.profileName ? { profileName: session.profileName } : {}),
    allowedOrigins: [...session.allowedOrigins],
    ...(session.activeTabId ? { activeTabId: session.activeTabId } : {}),
    tabCount: session.tabs.size,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function detectPromptInjection(text: string): NativeResult['securitySignals'] {
  const suspicious = [
    /ignore (all |the )?(previous|prior|system) instructions/i,
    /reveal (the )?(secret|password|token|api key)/i,
    /grant (me |this page )?permission/i,
    /upload (your|private|unrelated) files?/i,
    /disable (security|safety|policy)/i,
  ].some((pattern) => pattern.test(text));
  return suspicious
    ? [
        {
          type: 'PROMPT_INJECTION',
          severity: 'WARNING',
          description:
            'The page contains instructions that attempt to redirect the agent; they remain untrusted data.',
        },
      ]
    : [
        {
          type: 'UNTRUSTED_CONTENT',
          severity: 'INFO',
          description: 'Website text is treated only as untrusted data.',
        },
      ];
}

function artifactFor(
  path: string,
  kind: NativeEvidence['kind'],
  mediaType: string,
  sourceOrigin: string,
): NativeEvidence {
  const sizeBytes = statSync(path).size;
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { kind, path, mediaType, sha256, sizeBytes, verified: true, sourceOrigin };
}

function originOf(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('The browser reached a non-web URL.');
  return url.origin;
}

function isWebUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function cancellable<T>(operation: Promise<T>, signal: AbortSignal, page: Page): Promise<T> {
  if (signal.aborted) throw new Error('Browser action cancelled.');
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const abort = (): void => {
      void page.close().catch(() => undefined);
      rejectOperation(new Error('Browser action cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolveOperation(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        rejectOperation(error instanceof Error ? error : new Error('Browser operation failed.'));
      },
    );
  });
}

function contentType(extension: string): string {
  if (extension === '.txt') return 'text/plain';
  if (extension === '.json') return 'application/json';
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.png') return 'image/png';
  return 'application/octet-stream';
}

function sanitize(error: unknown): string {
  return (error instanceof Error ? error.message : 'The isolated browser action failed.')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:[A-Za-z]:\\|\/)[^ ]+/g, '[path]')
    .slice(0, 500);
}

async function shutdown(): Promise<void> {
  for (const controller of activeActions.values()) controller.abort('Browser worker shutdown.');
  await Promise.all([...sessions.values()].map((session) => closeSession(session)));
  lines.close();
  setTimeout(() => process.exit(0), 10);
}

function respond(response: WorkerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
