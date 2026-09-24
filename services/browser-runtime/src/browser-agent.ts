import { createHash, randomUUID } from 'node:crypto';
import { normalize } from 'node:path';
import {
  BrowserActionInputSchema,
  BrowserActionResultSchema,
  BrowserCancelInputSchema,
  BrowserEvidenceArtifactSchema,
  BrowserRuntimeStatusSchema,
  BrowserSessionSchema,
  BrowserActionTypeSchema,
  type Actor,
  type BrowserActionInput,
  type BrowserActionResult,
  type BrowserCancelInput,
  type BrowserRuntimeStatus,
  type BrowserSession,
  type PermissionCapability,
} from '@jupiter/contracts';
import {
  JupiterError,
  type BrowserActionRepository,
  type BrowserRuntime,
  type PermissionRuntime,
} from '@jupiter/core';
import {
  BrowserProcessCancelledError,
  type BrowserProcess,
  type NativeBrowserResponse,
} from './process-host.js';

export type BrowserAgentOptions = {
  repository: BrowserActionRepository;
  permissions: PermissionRuntime;
  host: BrowserProcess;
  executablePath?: string;
  managedDownloadDirectory: string;
  now?: () => Date;
};

const CAPABILITIES: readonly PermissionCapability[] = [
  capability('browser.session', 'Create or close an isolated browser session', 'MEDIUM'),
  capability('browser.navigate', 'Navigate an isolated browser tab', 'MEDIUM'),
  capability('browser.read', 'Read untrusted browser page content', 'LOW'),
  capability('browser.interact', 'Interact with a semantic browser element', 'HIGH'),
  capability('browser.capture', 'Capture browser evidence', 'MEDIUM'),
  capability('browser.download', 'Download a verified file to managed storage', 'HIGH'),
  capability('browser.upload', 'Upload an exact approved local file', 'HIGH'),
  capability('browser.cookies', 'Change isolated browser cookies', 'HIGH'),
  capability('browser.origin_permissions', 'Grant an origin-scoped browser permission', 'HIGH'),
  capability('browser.form.login', 'Submit a login form', 'MEDIUM'),
  capability('browser.form.message', 'Send a message through a web form', 'HIGH'),
  capability('browser.form.purchase', 'Submit a purchase form', 'CRITICAL'),
  capability('browser.form.generic', 'Submit a generic web form', 'HIGH'),
];

export class PlaywrightBrowserAgent implements BrowserRuntime {
  readonly #repository: BrowserActionRepository;
  readonly #permissions: PermissionRuntime;
  readonly #host: BrowserProcess;
  readonly #executablePath: string | undefined;
  readonly #managedDownloadDirectory: string;
  readonly #now: () => Date;
  readonly #active = new Map<string, AbortController>();
  readonly #sessions = new Map<string, BrowserSession>();
  #closed = false;

  constructor(options: BrowserAgentOptions) {
    this.#repository = options.repository;
    this.#permissions = options.permissions;
    this.#host = options.host;
    this.#executablePath = options.executablePath;
    this.#managedDownloadDirectory = normalize(options.managedDownloadDirectory);
    this.#now = options.now ?? (() => new Date());
    for (const definition of CAPABILITIES) {
      if (
        !this.#permissions
          .listCapabilities()
          .some((registered) => registered.capability === definition.capability)
      ) {
        this.#permissions.registerCapability(definition);
      }
    }
  }

  status(): BrowserRuntimeStatus {
    return BrowserRuntimeStatusSchema.parse({
      available: !this.#closed && this.#host.available(),
      engine: 'playwright',
      processIsolation: 'dedicated-node-process',
      ...(this.#executablePath ? { executable: this.#executablePath } : {}),
      managedDownloadDirectory: this.#managedDownloadDirectory,
      profiles: { temporary: 'default', persistent: 'explicit-opt-in' },
      browserContentTrust: 'untrusted',
      coordinateFallback: 'not-enabled',
      supportedActions: BrowserActionTypeSchema.options,
    });
  }

  sessions(): BrowserSession[] {
    return [...this.#sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  history(limit: number): BrowserActionResult[] {
    return this.#repository.listBrowserActions(limit);
  }

  async execute(
    input: BrowserActionInput,
    actor: Actor,
    parentSignal: AbortSignal,
  ): Promise<BrowserActionResult> {
    this.#assertAvailable();
    const action = BrowserActionInputSchema.parse(input);
    if (
      action.action === 'CREATE_SESSION' &&
      normalize(action.parameters.downloadDirectory) !== this.#managedDownloadDirectory
    ) {
      throw new JupiterError({
        code: 'BROWSER_DOWNLOAD_DIRECTORY_NOT_MANAGED',
        category: 'validation',
        message: 'Browser sessions must use Jupiter managed download storage.',
        recoverable: true,
        retryable: false,
        userAction: 'Use the managed download directory shown by Browser Agent.',
      });
    }
    this.#requirePermission(action, actor);
    const startedAt = this.#timestamp();
    const controller = linkedController(parentSignal);
    this.#active.set(action.actionId, controller);
    let result: BrowserActionResult;
    try {
      const native = await this.#host.execute(action, controller.signal);
      result = this.#fromNative(action, native, startedAt);
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof BrowserProcessCancelledError;
      result = BrowserActionResultSchema.parse({
        actionId: action.actionId,
        action: action.action,
        target: action.target,
        ...(action.sessionId ? { sessionId: action.sessionId } : {}),
        ...(action.tabId ? { tabId: action.tabId } : {}),
        success: false,
        status: cancelled ? 'CANCELLED' : 'FAILED',
        observation: cancelled
          ? 'The browser action was cancelled at the isolated process boundary.'
          : 'The isolated browser process failed without crashing Jupiter.',
        evidence: [],
        securitySignals: [],
        error: {
          code: cancelled ? 'BROWSER_ACTION_CANCELLED' : 'BROWSER_PROCESS_FAILED',
          message: cancelled
            ? 'The browser action was cancelled.'
            : 'The dedicated browser process failed.',
          recoverable: true,
        },
        startedAt,
        completedAt: this.#timestamp(),
      });
    } finally {
      parentSignal.removeEventListener('abort', controller.abortFromParent);
      this.#active.delete(action.actionId);
    }
    this.#trackSession(action, result);
    this.#repository.addBrowserAction(redactResultForPersistence(result));
    return result;
  }

  cancel(input: BrowserCancelInput): boolean {
    const valid = BrowserCancelInputSchema.parse(input);
    const controller = this.#active.get(valid.actionId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort('Browser Agent cancellation requested.');
    return true;
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#active.values()) controller.abort('Browser Agent shutdown.');
    this.#active.clear();
    this.#sessions.clear();
    await this.#host.shutdown();
  }

  #fromNative(
    action: BrowserActionInput,
    native: NativeBrowserResponse,
    startedAt: string,
  ): BrowserActionResult {
    const evidence = native.evidence.map((item) =>
      BrowserEvidenceArtifactSchema.parse({
        artifactId: randomUUID(),
        ...item,
        createdAt: this.#timestamp(),
      }),
    );
    return BrowserActionResultSchema.parse({
      actionId: action.actionId,
      action: action.action,
      target: action.target,
      ...(native.sessionId ? { sessionId: native.sessionId } : {}),
      ...(native.tabId ? { tabId: native.tabId } : {}),
      success: native.success,
      status: native.status ?? (native.success ? 'SUCCESS' : 'FAILED'),
      observation: native.observation,
      ...(native.page ? { page: native.page } : {}),
      ...(native.output ? { output: native.output } : {}),
      evidence,
      securitySignals: native.securitySignals,
      ...(native.error ? { error: native.error } : {}),
      startedAt,
      completedAt: this.#timestamp(),
    });
  }

  #trackSession(action: BrowserActionInput, result: BrowserActionResult): void {
    const nativeSession = result.output?.session;
    if (nativeSession) {
      this.#sessions.set(nativeSession.sessionId, nativeSession);
      return;
    }
    const sessionId = result.sessionId ?? action.sessionId;
    if (!sessionId) return;
    if (action.action === 'CLOSE_SESSION' && result.success) {
      this.#sessions.delete(sessionId);
      return;
    }
    const previous = this.#sessions.get(sessionId);
    if (!previous) return;
    let tabCount = previous.tabCount;
    if (result.success && action.action === 'OPEN_TAB') tabCount += 1;
    if (result.success && action.action === 'NAVIGATE' && !action.tabId) tabCount += 1;
    if (result.success && action.action === 'CLOSE_TAB') tabCount = Math.max(0, tabCount - 1);
    this.#sessions.set(
      sessionId,
      BrowserSessionSchema.parse({
        ...previous,
        status:
          result.error?.code === 'BROWSER_PROCESS_FAILED'
            ? 'CRASHED'
            : result.status === 'PAUSED'
              ? 'PAUSED'
              : previous.status,
        ...(result.tabId ? { activeTabId: result.tabId } : {}),
        tabCount,
        updatedAt: result.completedAt,
      }),
    );
  }

  #requirePermission(input: BrowserActionInput, actor: Actor): void {
    const capabilityName = capabilityForAction(input);
    const requesterType = actor === 'renderer' ? 'UI' : actor === 'service' ? 'AGENT' : 'CORE';
    const requesterId = requesterType === 'UI' ? 'browser-agent-panel' : 'playwright-browser-agent';
    const constraints = {
      action: input.action,
      parameterFingerprint: fingerprint(JSON.stringify(input.parameters)),
    };
    const targetId = safeTarget(input);
    const authorization = this.#permissions.authorize({
      capability: capabilityName,
      actor,
      requesterType,
      requesterId,
      declaredCapabilities: [capabilityName],
      targetId,
      scopeId: `browser-action:${input.action.toLowerCase()}`,
      ...(input.missionId ? { missionId: input.missionId } : {}),
      constraints,
      automated: false,
    });
    if (authorization.status === 'ALLOWED') return;
    if (authorization.status === 'DENIED') {
      throw permissionError(
        'BROWSER_PERMISSION_DENIED',
        'Permission policy denied this browser action.',
      );
    }
    const dataLeavesDevice = input.action === 'UPLOAD_FILE';
    const request = this.#permissions.request({
      capability: capabilityName,
      action: `Execute ${input.action} on ${input.target.display}.`,
      reason: 'The user requested real isolated browser automation.',
      target: { type: 'browser-target', id: targetId, display: targetId },
      scope: {
        type: 'browser-action',
        id: `browser-action:${input.action.toLowerCase()}`,
        display: input.action,
      },
      requester: {
        actor,
        type: requesterType,
        id: requesterId,
        display: requesterType === 'UI' ? 'Browser Agent panel' : 'Playwright Browser Agent',
        declaredCapabilities: [capabilityName],
        ...(input.missionId ? { missionId: input.missionId } : {}),
      },
      trustSource: requesterType === 'UI' ? 'USER_INTENT' : 'TRUSTED_RUNTIME',
      dataLeavingDevice: {
        value: dataLeavesDevice,
        description: dataLeavesDevice
          ? 'Only the exact approved local file will be sent to the exact approved origin.'
          : 'No unrelated local file or Jupiter secret is exposed to page content.',
      },
      consequence: consequence(input),
      reversible: !['SUBMIT_FORM', 'UPLOAD_FILE', 'DOWNLOAD_FILE'].includes(input.action),
      automated: false,
      constraints,
    });
    throw new JupiterError({
      code: 'PERMISSION_REQUIRED',
      category: 'permission',
      message: 'Explicit permission is required before browser automation can run.',
      recoverable: true,
      retryable: true,
      userAction: 'Review the exact browser target in Permission Center, then retry.',
      sanitizedDetails: `permissionRequestId=${request.requestId}`,
    });
  }

  #assertAvailable(): void {
    if (this.#closed || !this.#host.available()) {
      throw new JupiterError({
        code: 'BROWSER_AGENT_UNAVAILABLE',
        category: 'configuration',
        message: 'Browser Agent is unavailable because its isolated runtime is not configured.',
        recoverable: true,
        retryable: false,
        userAction: 'Install Microsoft Edge and check Diagnostics.',
      });
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function capability(
  name: string,
  description: string,
  risk: PermissionCapability['risk'],
): PermissionCapability {
  return {
    capability: name,
    name: description,
    description,
    risk,
    allowedRequesterTypes: ['CORE', 'AGENT', 'UI'],
    automationAllowed: false,
    available: true,
  };
}

function capabilityForAction(input: BrowserActionInput): string {
  if (input.action === 'SUBMIT_FORM')
    return `browser.form.${input.parameters.sensitivity.toLowerCase()}`;
  if (['CREATE_SESSION', 'CLOSE_SESSION'].includes(input.action)) return 'browser.session';
  if (['NAVIGATE', 'OPEN_TAB', 'CLOSE_TAB', 'SWITCH_TAB'].includes(input.action))
    return 'browser.navigate';
  if (['READ_PAGE', 'EXTRACT_DATA', 'WAIT_FOR'].includes(input.action)) return 'browser.read';
  if (['SCREENSHOT', 'HTML_SNAPSHOT'].includes(input.action)) return 'browser.capture';
  if (input.action === 'DOWNLOAD_FILE') return 'browser.download';
  if (input.action === 'UPLOAD_FILE') return 'browser.upload';
  if (['SET_COOKIES', 'CLEAR_COOKIES'].includes(input.action)) return 'browser.cookies';
  if (input.action === 'GRANT_ORIGIN_PERMISSIONS') return 'browser.origin_permissions';
  return 'browser.interact';
}

function consequence(input: BrowserActionInput): string {
  if (input.action === 'SUBMIT_FORM')
    return `A ${input.parameters.sensitivity.toLowerCase()} form will be submitted.`;
  if (input.action === 'UPLOAD_FILE') return 'The exact approved file will leave this device.';
  if (input.action === 'DOWNLOAD_FILE')
    return 'A verified file will be written to managed storage.';
  if (input.action === 'GRANT_ORIGIN_PERMISSIONS')
    return 'Browser permissions will be granted only to the exact approved origin.';
  if (input.action === 'SET_COOKIES')
    return 'Cookies will change only in the isolated browser context.';
  return 'The exact isolated browser target may be observed or changed.';
}

function safeTarget(input: BrowserActionInput): string {
  if (input.action === 'UPLOAD_FILE') {
    return `${normalize(input.parameters.filePath)} -> ${input.parameters.expectedOrigin}`.slice(
      0,
      2_048,
    );
  }
  if (input.action === 'SCREENSHOT' || input.action === 'HTML_SNAPSHOT') {
    return normalize(input.parameters.outputPath).slice(0, 2_048);
  }
  if ('expectedOrigin' in input.parameters) return input.parameters.expectedOrigin;
  if ('origin' in input.parameters) return input.parameters.origin;
  return input.target.id.slice(0, 2_048);
}

function redactResultForPersistence(result: BrowserActionResult): BrowserActionResult {
  if (!result.output?.visibleText && !result.output?.extraction) return result;
  const safeOutput = { ...result.output };
  delete safeOutput.visibleText;
  delete safeOutput.extraction;
  return BrowserActionResultSchema.parse({
    ...result,
    output: Object.keys(safeOutput).length > 0 ? safeOutput : undefined,
  });
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function permissionError(code: string, message: string): JupiterError {
  return new JupiterError({
    code,
    category: 'permission',
    message,
    recoverable: true,
    retryable: false,
    userAction: 'Review the exact request in Permission Center.',
  });
}

function linkedController(parent: AbortSignal): AbortController & { abortFromParent: () => void } {
  const controller = new AbortController() as AbortController & { abortFromParent: () => void };
  controller.abortFromParent = (): void => controller.abort(parent.reason ?? 'Parent cancelled.');
  if (parent.aborted) controller.abortFromParent();
  else parent.addEventListener('abort', controller.abortFromParent, { once: true });
  return controller;
}
