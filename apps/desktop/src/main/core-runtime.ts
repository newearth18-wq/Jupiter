import { join } from 'node:path';
import {
  type ChatStreamEvent,
  WindowStateSchema,
  type Actor,
  type DiagnosticsSnapshot,
  type DomainEvent,
  type RpcResponseEnvelope,
  type WindowState,
} from '@jupiter/contracts';
import { JupiterCore, type DomainEventListener } from '@jupiter/core';
import { JupiterDatabase } from '@jupiter/database';
import { CapabilityPermissionEngine } from '@jupiter/security';
import { ProviderAgnosticChatRuntime } from '@jupiter/ai-runtime';
import { DurableMissionRuntime, type MissionRuntimeDependencies } from '@jupiter/mission-runtime';
import {
  DurableWorkflowRuntime,
  type DurableWorkflowRuntimeDependencies,
} from '@jupiter/workflow-runtime';
import { createInternalSkills, ExecutableSkillRegistry } from '@jupiter/skill-runtime';
import { DpapiCredentialVault } from './dpapi-credential-vault.js';

export type DesktopCoreRuntimeOptions = {
  dataDirectory: string;
  version: string;
  forceServiceFailure?: boolean;
};

export class DesktopCoreRuntime {
  readonly #database: JupiterDatabase;
  readonly #core: JupiterCore;
  readonly #workflowRuntime: DurableWorkflowRuntime;
  readonly #skillRuntime: ExecutableSkillRegistry;
  readonly #permissionRuntime: CapabilityPermissionEngine;
  #closed = false;

  constructor(options: DesktopCoreRuntimeOptions) {
    this.#database = JupiterDatabase.open(join(options.dataDirectory, 'jupiter.db'));
    const chatRuntime = new ProviderAgnosticChatRuntime({
      repository: this.#database,
      credentialVault: new DpapiCredentialVault(join(options.dataDirectory, 'credentials')),
      recordEvent: (event) => {
        this.#database.append({
          ...event,
          actor: 'service',
          source: 'ai-runtime',
        });
      },
    });
    const missionEventBridge: {
      publish?: NonNullable<MissionRuntimeDependencies['recordEvent']>;
    } = {};
    const missionRuntime = new DurableMissionRuntime({
      repository: this.#database,
      recordEvent: (event) => {
        missionEventBridge.publish?.(event);
      },
    });
    const workflowEventBridge: {
      publish?: NonNullable<DurableWorkflowRuntimeDependencies['recordEvent']>;
    } = {};
    const skillEventBridge: {
      publish?: DurableWorkflowRuntimeDependencies['recordEvent'];
    } = {};
    this.#permissionRuntime = new CapabilityPermissionEngine({ repository: this.#database });
    this.#permissionRuntime.registerCapability({
      capability: 'credentials.modify',
      name: 'Modify credentials',
      description: 'Add, replace, or remove provider authentication and endpoint settings.',
      risk: 'CRITICAL',
      allowedRequesterTypes: ['CORE', 'UI'],
      automationAllowed: false,
      available: true,
    });
    this.#skillRuntime = new ExecutableSkillRegistry({
      repository: this.#database,
      runtimeVersion: options.version,
      recordEvent: (event) => skillEventBridge.publish?.(event),
      permissionRuntime: this.#permissionRuntime,
    });
    for (const skill of createInternalSkills(options.version, () =>
      this.#skillRuntime.search({ query: '' }),
    )) {
      this.#skillRuntime.register(skill);
    }
    this.#workflowRuntime = new DurableWorkflowRuntime({
      repository: this.#database,
      missionRuntime,
      executors: this.#skillRuntime.workflowExecutors(),
      recordEvent: (event) => {
        workflowEventBridge.publish?.(event);
      },
    });
    this.#core = new JupiterCore({
      version: options.version,
      eventStore: this.#database,
      auditRepository: this.#database,
      serviceHealthRepository: this.#database,
      diagnosticsRepository: this.#database,
      settingsRepository: this.#database,
      chatRuntime,
      missionRuntime,
      workflowRuntime: this.#workflowRuntime,
      skillRuntime: this.#skillRuntime,
      permissionRuntime: this.#permissionRuntime,
    });
    missionEventBridge.publish = (event) =>
      this.#core.publishRuntimeEvent(event, 'mission-runtime');
    workflowEventBridge.publish = (event) =>
      this.#core.publishRuntimeEvent(event, 'workflow-runtime');
    skillEventBridge.publish = (event) => this.#core.publishRuntimeEvent(event, 'skill-runtime');
    this.#core.registerService({
      serviceId: 'local-coordinator',
      version: options.version,
      capabilities: [
        'core.rpc',
        'diagnostics.read',
        'events.replay',
        'providers.configure',
        'models.route',
        'chat.stream',
        'missions.manage',
        'workflows.manage',
        'skills.manage',
        'permissions.manage',
      ],
      start: () => {
        if (options.forceServiceFailure === true) {
          throw new Error('Controlled local coordinator failure.');
        }
      },
      check: () => {
        if (options.forceServiceFailure === true) {
          throw new Error('Controlled local coordinator failure.');
        }
      },
      stop: () => undefined,
    });
  }

  async start(signal: AbortSignal): Promise<DiagnosticsSnapshot> {
    const diagnostics = await this.#core.start(signal);
    await Promise.all(
      this.#skillRuntime
        .search({ query: '' })
        .map((entry) => this.#skillRuntime.healthCheck(entry.definition.skillId, signal)),
    );
    await this.#workflowRuntime.recover();
    return diagnostics;
  }

  request(
    input: unknown,
    authenticatedActor: Actor,
    signal: AbortSignal,
  ): Promise<RpcResponseEnvelope> {
    return this.#core.handleRpc(input, authenticatedActor, signal);
  }

  subscribe(listener: DomainEventListener): () => void {
    return this.#core.subscribe(listener);
  }

  subscribeChat(listener: (event: ChatStreamEvent) => void): () => void {
    return this.#core.subscribeChat(listener);
  }

  getDiagnostics(): DiagnosticsSnapshot {
    return this.#core.getDiagnostics();
  }

  getWindowState(): WindowState | undefined {
    const parsed = WindowStateSchema.safeParse(this.#database.getSetting('ui.window-state'));
    return parsed.success ? parsed.data : undefined;
  }

  saveWindowState(state: WindowState): void {
    this.#database.setSetting('ui.window-state', WindowStateSchema.parse(state));
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    await this.#core.shutdown();
    this.#database.close();
    this.#closed = true;
  }
}

export type { DomainEvent };
