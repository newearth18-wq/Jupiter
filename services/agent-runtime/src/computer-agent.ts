import { createHash, randomUUID } from 'node:crypto';
import { basename, normalize } from 'node:path';
import {
  ComputerActionInputSchema,
  ComputerActionResultSchema,
  ComputerCancelInputSchema,
  ComputerEvidenceArtifactSchema,
  ComputerRuntimeStatusSchema,
  NotepadDemoInputSchema,
  NotepadDemoResultSchema,
  type Actor,
  type ComputerActionInput,
  type ComputerActionResult,
  type ComputerCancelInput,
  type ComputerRuntimeStatus,
  type NotepadDemoInput,
  type NotepadDemoResult,
  type PermissionCapability,
} from '@jupiter/contracts';
import {
  JupiterError,
  type ComputerActionRepository,
  type ComputerRuntime,
  type PermissionRuntime,
} from '@jupiter/core';
import { COMPUTER_ADAPTERS, resolveComputerAdapter } from './adapters.js';
import {
  AutomationHostCancelledError,
  type AutomationProcessHost,
  type NativeAutomationResponse,
} from './process-host.js';

export type WindowsComputerAgentOptions = {
  repository: ComputerActionRepository;
  permissions: PermissionRuntime;
  host: AutomationProcessHost;
  defaultDemoPath: string;
  now?: () => Date;
};

const COMPUTER_CAPABILITIES: readonly PermissionCapability[] = [
  capability('computer.open_app', 'Open a Windows application', 'HIGH'),
  capability('computer.close_app', 'Close a Windows application', 'HIGH'),
  capability('computer.focus_window', 'Focus a Windows window', 'MEDIUM'),
  capability('computer.interact', 'Interact with a Windows control', 'HIGH'),
  capability('computer.read_ui', 'Read a Windows UI hierarchy', 'MEDIUM'),
  capability('computer.capture_screen', 'Capture a Windows screenshot', 'HIGH'),
  capability('computer.wait', 'Wait for an exact Windows target', 'LOW'),
  capability('filesystem.write', 'Write an exact approved file', 'HIGH'),
  capability('computer.notepad_demo', 'Run the approved Notepad save workflow', 'CRITICAL'),
  capability('computer.coordinate_fallback', 'Use exact approved screen coordinates', 'CRITICAL'),
];

export class WindowsComputerAgent implements ComputerRuntime {
  readonly #repository: ComputerActionRepository;
  readonly #permissions: PermissionRuntime;
  readonly #host: AutomationProcessHost;
  readonly #defaultDemoPath: string;
  readonly #now: () => Date;
  readonly #active = new Map<string, AbortController>();
  #closed = false;

  constructor(options: WindowsComputerAgentOptions) {
    this.#repository = options.repository;
    this.#permissions = options.permissions;
    this.#host = options.host;
    this.#defaultDemoPath = normalize(options.defaultDemoPath);
    this.#now = options.now ?? (() => new Date());
    for (const definition of COMPUTER_CAPABILITIES) {
      if (
        !this.#permissions
          .listCapabilities()
          .some((registered) => registered.capability === definition.capability)
      ) {
        this.#permissions.registerCapability(definition);
      }
    }
  }

  status(): ComputerRuntimeStatus {
    return ComputerRuntimeStatusSchema.parse({
      available: process.platform === 'win32' && !this.#closed,
      platform: 'win32',
      processIsolation: 'dedicated-powershell-process',
      defaultDemoPath: this.#defaultDemoPath,
      adapters: COMPUTER_ADAPTERS.map((adapter) => ({
        adapterId: adapter.adapterId,
        name: adapter.name,
        available: process.platform === 'win32' && !this.#closed,
        supportedActions: adapter.supportedActions,
      })),
      coordinateFallback: 'explicit-critical-permission-only',
    });
  }

  history(limit: number): ComputerActionResult[] {
    return this.#repository.listComputerActions(limit);
  }

  async execute(
    input: ComputerActionInput,
    actor: Actor,
    signal: AbortSignal,
  ): Promise<ComputerActionResult> {
    this.#assertAvailable();
    const action = ComputerActionInputSchema.parse(input);
    this.#requireActionPermission(action, actor);
    return this.#executeApproved(action, signal);
  }

  async runNotepadDemo(
    input: NotepadDemoInput,
    actor: Actor,
    parentSignal: AbortSignal,
  ): Promise<NotepadDemoResult> {
    this.#assertAvailable();
    const valid = NotepadDemoInputSchema.parse(input);
    this.#requireDemoPermission(valid, actor);
    const startedAt = this.#timestamp();
    const controller = linkedController(parentSignal);
    this.#active.set(valid.executionId, controller);
    const actions: ComputerActionResult[] = [];
    let processId: number | undefined;
    try {
      const open = await this.#executeApproved(
        action(
          'OPEN_APP',
          {
            kind: 'application',
            id: 'application:notepad',
            display: 'Windows Notepad',
          },
          {
            executable: 'notepad.exe',
            arguments: [],
          },
        ),
        controller.signal,
      );
      actions.push(open);
      processId = open.output?.processId;
      if (!open.success || processId === undefined)
        return this.#demoFailure(valid, actions, startedAt);

      const wait = await this.#executeApproved(
        action(
          'WAIT_FOR_WINDOW',
          {
            kind: 'window',
            id: `process:${String(processId)}`,
            display: 'Notepad main window',
            processId,
          },
          { processName: 'Notepad', titleContains: 'Notepad' },
        ),
        controller.signal,
      );
      actions.push(wait);
      if (!wait.success) {
        await this.#cleanupNotepad(processId);
        return this.#demoFailure(valid, actions, startedAt);
      }

      const type = await this.#executeApproved(
        action(
          'TYPE_TEXT',
          {
            kind: 'control',
            id: `process:${String(processId)}:notepad-editor`,
            display: 'Notepad editor',
            processId,
            selector: { controlType: 'Document', className: 'RichEditD2DPT' },
          },
          { text: valid.text, replace: true },
        ),
        controller.signal,
      );
      actions.push(type);
      if (!type.success) {
        await this.#cleanupNotepad(processId);
        return this.#demoFailure(valid, actions, startedAt);
      }

      const save = await this.#executeApproved(
        action(
          'SAVE_FILE',
          {
            kind: 'file',
            id: normalize(valid.outputPath),
            display: basename(valid.outputPath),
            processId,
            windowTitle: 'Notepad',
          },
          {
            outputPath: normalize(valid.outputPath),
            expectedContent: valid.text,
            overwrite: valid.overwrite,
          },
        ),
        controller.signal,
      );
      actions.push(save);
      if (!save.success || save.evidence[0]?.verified !== true) {
        await this.#cleanupNotepad(processId);
        return this.#demoFailure(valid, actions, startedAt);
      }

      const close = await this.#executeApproved(
        action(
          'CLOSE_APP',
          {
            kind: 'application',
            id: `process:${String(processId)}`,
            display: 'Windows Notepad',
            processId,
          },
          {},
        ),
        controller.signal,
      );
      actions.push(close);
      if (!close.success) {
        await this.#cleanupNotepad(processId);
        return this.#demoFailure(valid, actions, startedAt);
      }

      return NotepadDemoResultSchema.parse({
        executionId: valid.executionId,
        success: true,
        status: 'SUCCESS',
        observation: 'Notepad saved the exact approved text and Jupiter verified the file content.',
        actions,
        artifact: save.evidence[0],
        startedAt,
        completedAt: this.#timestamp(),
      });
    } catch (error) {
      if (processId !== undefined) await this.#cleanupNotepad(processId);
      const cancelled = controller.signal.aborted || error instanceof AutomationHostCancelledError;
      const fallback = this.#terminalAction(valid.outputPath, cancelled);
      actions.push(fallback);
      this.#repository.addComputerAction(fallback);
      return NotepadDemoResultSchema.parse({
        executionId: valid.executionId,
        success: false,
        status: cancelled ? 'CANCELLED' : 'FAILED',
        observation: cancelled
          ? 'The Notepad workflow was cancelled at a safe process boundary.'
          : 'The Notepad workflow stopped after a real automation failure.',
        actions,
        error: fallback.error,
        startedAt,
        completedAt: this.#timestamp(),
      });
    } finally {
      parentSignal.removeEventListener('abort', controller.abortFromParent);
      this.#active.delete(valid.executionId);
    }
  }

  cancel(input: ComputerCancelInput): boolean {
    const valid = ComputerCancelInputSchema.parse(input);
    const controller = this.#active.get(valid.executionId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort('Computer Agent cancellation requested.');
    return true;
  }

  shutdown(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#active.values()) controller.abort('Computer Agent shutdown.');
    this.#active.clear();
    return Promise.resolve();
  }

  async #executeApproved(
    actionInput: ComputerActionInput,
    parentSignal: AbortSignal,
  ): Promise<ComputerActionResult> {
    const adapter = resolveComputerAdapter(actionInput);
    const startedAt = this.#timestamp();
    const controller = linkedController(parentSignal);
    this.#active.set(actionInput.actionId, controller);
    let result: ComputerActionResult;
    try {
      const native = await this.#host.execute(actionInput, controller.signal);
      result = this.#resultFromNative(actionInput, adapter.adapterId, startedAt, native);
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof AutomationHostCancelledError;
      result = ComputerActionResultSchema.parse({
        actionId: actionInput.actionId,
        action: actionInput.action,
        target: actionInput.target,
        success: false,
        status: cancelled ? 'CANCELLED' : 'FAILED',
        observation: cancelled
          ? 'The action was cancelled at the dedicated process boundary.'
          : 'The isolated Windows automation process failed without crashing Jupiter.',
        evidence: [],
        error: {
          code: cancelled ? 'COMPUTER_ACTION_CANCELLED' : 'AUTOMATION_PROCESS_FAILED',
          message: cancelled
            ? 'The action was cancelled.'
            : 'The dedicated automation process failed.',
          recoverable: true,
        },
        adapterId: adapter.adapterId,
        interactionMode: 'WINDOWS_API',
        coordinateFallbackUsed: false,
        startedAt,
        completedAt: this.#timestamp(),
      });
    } finally {
      parentSignal.removeEventListener('abort', controller.abortFromParent);
      this.#active.delete(actionInput.actionId);
    }
    this.#repository.addComputerAction(result);
    return result;
  }

  #resultFromNative(
    actionInput: ComputerActionInput,
    adapterId: ComputerActionResult['adapterId'],
    startedAt: string,
    native: NativeAutomationResponse,
  ): ComputerActionResult {
    const evidence = native.evidence.map((item) =>
      ComputerEvidenceArtifactSchema.parse({
        artifactId: randomUUID(),
        ...item,
        createdAt: this.#timestamp(),
      }),
    );
    return ComputerActionResultSchema.parse({
      actionId: actionInput.actionId,
      action: actionInput.action,
      target: actionInput.target,
      success: native.success,
      status: native.success ? 'SUCCESS' : 'FAILED',
      observation: native.observation,
      evidence,
      ...(native.output ? { output: native.output } : {}),
      ...(native.error ? { error: native.error } : {}),
      adapterId,
      interactionMode: native.interactionMode,
      coordinateFallbackUsed: native.interactionMode === 'COORDINATE_FALLBACK',
      startedAt,
      completedAt: this.#timestamp(),
    });
  }

  #requireActionPermission(input: ComputerActionInput, actor: Actor): void {
    const coordinateFallback =
      input.action === 'CLICK_ELEMENT' && input.parameters.coordinateFallback !== undefined;
    const capabilityName = coordinateFallback
      ? 'computer.coordinate_fallback'
      : capabilityForAction(input.action);
    const constraints = {
      action: input.action,
      parameterFingerprint: fingerprint(sanitizedParameters(input)),
    };
    this.#requirePermission({
      capabilityName,
      actor,
      targetId: input.target.id,
      scopeId: `computer-action:${input.action.toLowerCase()}`,
      action: `Execute ${input.action} on ${input.target.display}.`,
      consequence: consequenceForAction(input.action, coordinateFallback),
      reversible: !['CLOSE_APP', 'SAVE_FILE'].includes(input.action),
      constraints,
      ...(input.missionId ? { missionId: input.missionId } : {}),
      dataDescription:
        input.action === 'SCREENSHOT'
          ? 'A screenshot is written only to the exact approved local path.'
          : 'No data leaves this device.',
    });
  }

  #requireDemoPermission(input: NotepadDemoInput, actor: Actor): void {
    this.#requirePermission({
      capabilityName: 'computer.notepad_demo',
      actor,
      targetId: normalize(input.outputPath),
      scopeId: 'notepad:open-type-save-verify-close',
      action: 'Open Notepad, type the approved text, save it, verify it, and close Notepad.',
      consequence: 'A new text file will be created at the exact approved path.',
      reversible: true,
      constraints: {
        textFingerprint: fingerprint(input.text),
        overwrite: input.overwrite,
      },
      dataDescription: 'The approved text remains on this device and is written to the exact path.',
    });
  }

  #requirePermission(input: {
    capabilityName: string;
    actor: Actor;
    targetId: string;
    scopeId: string;
    action: string;
    consequence: string;
    reversible: boolean;
    constraints: Readonly<Record<string, string | boolean>>;
    missionId?: string;
    dataDescription: string;
  }): void {
    const requesterType =
      input.actor === 'renderer' ? 'UI' : input.actor === 'service' ? 'AGENT' : 'CORE';
    const requesterId = requesterType === 'UI' ? 'computer-agent-screen' : 'windows-computer-agent';
    const authorization = this.#permissions.authorize({
      capability: input.capabilityName,
      actor: input.actor,
      requesterType,
      requesterId,
      declaredCapabilities: [input.capabilityName],
      targetId: input.targetId,
      scopeId: input.scopeId,
      ...(input.missionId ? { missionId: input.missionId } : {}),
      constraints: input.constraints,
      automated: false,
    });
    if (authorization.status === 'ALLOWED') return;
    if (authorization.status === 'DENIED') {
      throw permissionError('COMPUTER_PERMISSION_DENIED', 'Permission policy denied this action.');
    }
    const request = this.#permissions.request({
      capability: input.capabilityName,
      action: input.action,
      reason: 'The user requested real Windows automation.',
      target: { type: 'windows-target', id: input.targetId, display: input.targetId },
      scope: { type: 'computer-action', id: input.scopeId, display: input.scopeId },
      requester: {
        actor: input.actor,
        type: requesterType,
        id: requesterId,
        display: requesterType === 'UI' ? 'Computer Agent screen' : 'Windows Computer Agent',
        declaredCapabilities: [input.capabilityName],
        ...(input.missionId ? { missionId: input.missionId } : {}),
      },
      trustSource: requesterType === 'UI' ? 'USER_INTENT' : 'TRUSTED_RUNTIME',
      dataLeavingDevice: { value: false, description: input.dataDescription },
      consequence: input.consequence,
      reversible: input.reversible,
      automated: false,
      constraints: input.constraints,
    });
    throw new JupiterError({
      code: 'PERMISSION_REQUIRED',
      category: 'permission',
      message: 'Explicit permission is required before Windows automation can run.',
      recoverable: true,
      retryable: true,
      userAction: 'Review the exact target in Permission Center, then retry.',
      sanitizedDetails: `permissionRequestId=${request.requestId}`,
    });
  }

  #demoFailure(
    input: NotepadDemoInput,
    actions: ComputerActionResult[],
    startedAt: string,
  ): NotepadDemoResult {
    const failed = [...actions].reverse().find((item) => !item.success);
    return NotepadDemoResultSchema.parse({
      executionId: input.executionId,
      success: false,
      status: failed?.status ?? 'FAILED',
      observation: 'The workflow did not report success because an action or verification failed.',
      actions,
      error: failed?.error ?? {
        code: 'NOTEPAD_DEMO_VERIFICATION_FAILED',
        message: 'The saved artifact could not be verified.',
        recoverable: true,
      },
      startedAt,
      completedAt: this.#timestamp(),
    });
  }

  async #cleanupNotepad(processId: number): Promise<void> {
    const cleanup = action(
      'CLOSE_APP',
      {
        kind: 'application',
        id: `process:${String(processId)}`,
        display: 'Windows Notepad cleanup',
        processId,
      },
      {},
    );
    try {
      await this.#host.execute(cleanup, new AbortController().signal);
    } catch {
      // The process boundary contains cleanup failure; the original result remains authoritative.
    }
  }

  #terminalAction(outputPath: string, cancelled: boolean): ComputerActionResult {
    const timestamp = this.#timestamp();
    return ComputerActionResultSchema.parse({
      actionId: randomUUID(),
      action: 'SAVE_FILE',
      target: { kind: 'file', id: outputPath, display: basename(outputPath) },
      success: false,
      status: cancelled ? 'CANCELLED' : 'FAILED',
      observation: cancelled
        ? 'The workflow was cancelled before verification completed.'
        : 'The workflow failed inside the isolated automation boundary.',
      evidence: [],
      error: {
        code: cancelled ? 'COMPUTER_ACTION_CANCELLED' : 'NOTEPAD_DEMO_FAILED',
        message: cancelled ? 'The workflow was cancelled.' : 'The Notepad workflow failed.',
        recoverable: true,
      },
      adapterId: 'notepad',
      interactionMode: 'WINDOWS_API',
      coordinateFallbackUsed: false,
      startedAt: timestamp,
      completedAt: timestamp,
    });
  }

  #assertAvailable(): void {
    if (this.#closed || process.platform !== 'win32') {
      throw new JupiterError({
        code: 'COMPUTER_AGENT_UNAVAILABLE',
        category: 'configuration',
        message: 'Windows Computer Agent is unavailable on this runtime.',
        recoverable: true,
        retryable: false,
        userAction: 'Run Jupiter on Windows 10 or 11 and check Diagnostics.',
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

function capabilityForAction(actionType: ComputerActionInput['action']): string {
  if (actionType === 'OPEN_APP') return 'computer.open_app';
  if (actionType === 'CLOSE_APP') return 'computer.close_app';
  if (actionType === 'FOCUS_WINDOW') return 'computer.focus_window';
  if (['READ_UI_TREE', 'ENUMERATE_WINDOWS', 'GET_ACTIVE_WINDOW'].includes(actionType))
    return 'computer.read_ui';
  if (actionType === 'SCREENSHOT') return 'computer.capture_screen';
  if (actionType === 'WAIT_FOR_WINDOW') return 'computer.wait';
  if (actionType === 'SAVE_FILE') return 'filesystem.write';
  return 'computer.interact';
}

function consequenceForAction(
  actionType: ComputerActionInput['action'],
  fallback: boolean,
): string {
  if (fallback) return 'A click will occur inside the exact approved screen rectangle.';
  if (actionType === 'SAVE_FILE') return 'A file may be created at the exact approved path.';
  if (actionType === 'CLOSE_APP') return 'The exact application window may close.';
  if (actionType === 'TYPE_TEXT') return 'Text will be entered into the exact semantic control.';
  if (actionType === 'SCREENSHOT') return 'A local screenshot artifact will be created.';
  return 'The exact Windows target may be observed or changed by this action.';
}

function sanitizedParameters(input: ComputerActionInput): string {
  if (input.action === 'TYPE_TEXT' || input.action === 'PASTE') {
    return JSON.stringify({ ...input.parameters, text: fingerprint(input.parameters.text) });
  }
  if (input.action === 'SAVE_FILE') {
    return JSON.stringify({
      ...input.parameters,
      expectedContent: fingerprint(input.parameters.expectedContent),
    });
  }
  return JSON.stringify(input.parameters);
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

function action<T extends ComputerActionInput['action']>(
  actionType: T,
  target: ComputerActionInput['target'],
  parameters: Extract<ComputerActionInput, { action: T }>['parameters'],
): Extract<ComputerActionInput, { action: T }> {
  return ComputerActionInputSchema.parse({
    actionId: randomUUID(),
    action: actionType,
    target,
    adapterHint: 'notepad',
    timeoutMs: actionType === 'WAIT_FOR_WINDOW' ? 15_000 : 30_000,
    parameters,
  }) as Extract<ComputerActionInput, { action: T }>;
}
