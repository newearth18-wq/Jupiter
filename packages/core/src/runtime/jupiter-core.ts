import { randomUUID } from 'node:crypto';
import {
  CONTRACT_SCHEMA_VERSION,
  DEFAULT_UI_PREFERENCES,
  DiagnosticsSnapshotSchema,
  UiPreferencesSchema,
  UiPreferencesUpdateSchema,
  type Actor,
  type ChatStreamEvent,
  type DiagnosticsSnapshot,
  type RpcResponseEnvelope,
  type WorkflowCheckpointResolveInput,
  type WorkflowControlInput,
  type WorkflowPlanCreateInput,
  type WorkflowReplanInput,
} from '@jupiter/contracts';
import { CapabilityDispatcher } from '../capabilities/capability-dispatcher.js';
import { DomainEventBus, type DomainEventListener } from '../events/domain-event-bus.js';
import type {
  AuditRepository,
  DiagnosticsRepository,
  DomainEventDraft,
  ChatRuntime,
  EventStore,
  MissionRuntime,
  SettingsRepository,
  ServiceHealthRepository,
  WorkflowRuntime,
} from '../ports.js';
import { RpcGateway } from '../rpc/rpc-gateway.js';
import { ServiceManager, type ManagedService } from '../services/service-manager.js';

export type JupiterCoreDependencies = {
  version: string;
  eventStore: EventStore;
  auditRepository: AuditRepository;
  serviceHealthRepository: ServiceHealthRepository;
  diagnosticsRepository: DiagnosticsRepository;
  settingsRepository: SettingsRepository;
  chatRuntime?: ChatRuntime;
  missionRuntime?: MissionRuntime;
  workflowRuntime?: WorkflowRuntime;
};

export class JupiterCore {
  readonly #version: string;
  readonly #events: DomainEventBus;
  readonly #services: ServiceManager;
  readonly #diagnosticsRepository: DiagnosticsRepository;
  readonly #dispatcher: CapabilityDispatcher;
  readonly #gateway: RpcGateway;
  readonly #settingsRepository: SettingsRepository;
  readonly #chatRuntime: ChatRuntime | undefined;
  readonly #missionRuntime: MissionRuntime | undefined;
  readonly #workflowRuntime: WorkflowRuntime | undefined;
  #started = false;

  constructor(dependencies: JupiterCoreDependencies) {
    this.#version = dependencies.version;
    this.#events = new DomainEventBus(dependencies.eventStore);
    this.#services = new ServiceManager(dependencies.serviceHealthRepository, this.#events);
    this.#diagnosticsRepository = dependencies.diagnosticsRepository;
    this.#settingsRepository = dependencies.settingsRepository;
    this.#chatRuntime = dependencies.chatRuntime;
    this.#missionRuntime = dependencies.missionRuntime;
    this.#workflowRuntime = dependencies.workflowRuntime;
    this.#dispatcher = new CapabilityDispatcher();
    this.#gateway = new RpcGateway(this.#dispatcher, dependencies.auditRepository);
    this.#registerCapabilities();
  }

  registerService(service: ManagedService): void {
    this.#services.register(service);
  }

  async start(signal: AbortSignal): Promise<DiagnosticsSnapshot> {
    const correlationId = randomUUID();
    await this.#services.startAll(correlationId, signal);
    this.#started = true;
    this.#events.publish({
      type: 'core.started',
      correlationId,
      actor: 'core',
      source: 'jupiter-core',
      payload: { version: this.#version },
      occurredAt: new Date().toISOString(),
    });
    return this.getDiagnostics();
  }

  async shutdown(): Promise<void> {
    if (!this.#started) return;
    const correlationId = randomUUID();
    await this.#services.stopAll(correlationId);
    this.#events.publish({
      type: 'core.stopped',
      correlationId,
      actor: 'core',
      source: 'jupiter-core',
      payload: {},
      occurredAt: new Date().toISOString(),
    });
    this.#started = false;
    await Promise.all([
      this.#chatRuntime?.shutdown(),
      this.#workflowRuntime?.shutdown(),
      this.#missionRuntime?.shutdown(),
    ]);
  }

  handleRpc(
    input: unknown,
    authenticatedActor: Actor,
    signal: AbortSignal,
  ): Promise<RpcResponseEnvelope> {
    return this.#gateway.handle(input, authenticatedActor, signal);
  }

  subscribe(listener: DomainEventListener): () => void {
    return this.#events.subscribe(listener);
  }

  publishRuntimeEvent(
    event: Omit<DomainEventDraft, 'correlationId' | 'actor' | 'source'>,
    source: string,
  ): void {
    this.#events.publish({
      ...event,
      correlationId: randomUUID(),
      actor: 'service',
      source,
    });
  }

  subscribeChat(listener: (event: ChatStreamEvent) => void): () => void {
    return this.#chatRuntime?.subscribe(listener) ?? (() => undefined);
  }

  getDiagnostics(): DiagnosticsSnapshot {
    const services = this.#services.listHealth();
    const recentErrors = services
      .filter((service) => service.sanitizedError !== undefined)
      .slice(0, 20)
      .map((service) => ({
        serviceId: service.serviceId,
        code: 'SERVICE_UNHEALTHY',
        message: service.sanitizedError ?? 'Service is unhealthy.',
        timestamp: service.lastCheck,
      }));
    const degraded = services.some(
      (service) => service.status === 'degraded' || service.status === 'failed',
    );
    return DiagnosticsSnapshotSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      coreVersion: this.#version,
      status: degraded ? 'degraded' : 'operational',
      database: this.#diagnosticsRepository.inspect(),
      services,
      recentErrors,
    });
  }

  #registerCapabilities(): void {
    this.#dispatcher.register({
      capability: 'core.ping',
      allowedActors: ['renderer', 'core', 'test'],
      handler: (input) => {
        const message =
          typeof input === 'object' &&
          input !== null &&
          'message' in input &&
          typeof input.message === 'string'
            ? input.message
            : 'pong';
        return { message, coreVersion: this.#version, receivedAt: new Date().toISOString() };
      },
    });
    this.#dispatcher.register({
      capability: 'diagnostics.read',
      allowedActors: ['renderer', 'core', 'test'],
      handler: () => this.getDiagnostics(),
    });
    this.#dispatcher.register({
      capability: 'events.read',
      allowedActors: ['renderer', 'core', 'test'],
      handler: (input) => {
        const payload = input as { afterSequence: number; limit: number };
        const events = this.#events.replayAfter(payload.afterSequence, payload.limit);
        return { events, cursor: events.at(-1)?.sequence ?? payload.afterSequence };
      },
    });
    this.#dispatcher.register({
      capability: 'core.health.refresh',
      allowedActors: ['renderer', 'core', 'test'],
      handler: async (_input, context) => {
        await this.#services.refreshAll(context.correlation.requestId);
        return this.getDiagnostics();
      },
    });
    this.#dispatcher.register({
      capability: 'ui.preferences.read',
      allowedActors: ['renderer', 'core', 'test'],
      handler: () => this.#readUiPreferences(),
    });
    this.#dispatcher.register({
      capability: 'ui.preferences.write',
      allowedActors: ['renderer', 'core', 'test'],
      handler: (input, context) => {
        const update = UiPreferencesUpdateSchema.parse(input);
        const preferences = UiPreferencesSchema.parse({
          ...this.#readUiPreferences(),
          ...update,
        });
        this.#settingsRepository.setSetting('ui.preferences', preferences);
        this.#events.publish({
          type: 'ui.preferences.updated',
          correlationId: context.correlation.requestId,
          actor: context.correlation.actor,
          source: 'jupiter-core',
          payload: { changed: Object.keys(update) },
          occurredAt: new Date().toISOString(),
        });
        return preferences;
      },
    });
    if (this.#chatRuntime) this.#registerAiCapabilities(this.#chatRuntime);
    if (this.#missionRuntime) this.#registerMissionCapabilities(this.#missionRuntime);
    if (this.#workflowRuntime) this.#registerWorkflowCapabilities(this.#workflowRuntime);
  }

  #registerWorkflowCapabilities(runtime: WorkflowRuntime): void {
    const register = (
      capability: string,
      handler: Parameters<CapabilityDispatcher['register']>[0]['handler'],
      allowedActors: Actor[] = ['renderer', 'core', 'test'],
    ): void => this.#dispatcher.register({ capability, allowedActors, handler });
    register('workflows.read', (input) => ({
      workflow: runtime.getWorkflow((input as { missionId: string }).missionId) ?? null,
    }));
    register(
      'workflows.plan.create',
      (input) => {
        const payload = input as WorkflowPlanCreateInput;
        return runtime.createPlan(payload.missionId, payload.modelOutput);
      },
      ['core', 'test'],
    );
    register('workflows.start', (input) => runtime.startWorkflow(input as WorkflowControlInput));
    register('workflows.resume', (input) => runtime.resumeWorkflow(input as WorkflowControlInput));
    register('workflows.cancel', (input) => runtime.cancelWorkflow(input as WorkflowControlInput));
    register('workflows.replan', (input) => runtime.replanWorkflow(input as WorkflowReplanInput), [
      'core',
      'test',
    ]);
    register(
      'workflows.checkpoint.resolve',
      (input) => runtime.resolveCheckpoint(input as WorkflowCheckpointResolveInput),
      ['core', 'test'],
    );
  }

  #registerMissionCapabilities(runtime: MissionRuntime): void {
    const register = (
      capability: string,
      handler: Parameters<CapabilityDispatcher['register']>[0]['handler'],
      allowedActors: Actor[] = ['renderer', 'core', 'test'],
    ): void => {
      this.#dispatcher.register({ capability, allowedActors, handler });
    };
    register('missions.read', (input) => {
      if ('missionId' in (input as object)) {
        return runtime.getMissionDetail((input as { missionId: string }).missionId);
      }
      return {
        missions: runtime.listMissions((input as { includeArchived?: boolean }).includeArchived),
      };
    });
    register('missions.create', (input) => runtime.createMission(input as never));
    register('missions.pause', (input, context) =>
      runtime.pauseMission(input as never, context.signal),
    );
    register('missions.resume', (input) => runtime.resumeMission(input as never));
    register('missions.cancel', (input) => runtime.cancelMission(input as never));
    register('missions.retry', (input) => runtime.retryMission(input as never));
    register('missions.archive', (input) =>
      runtime.archiveMission((input as { missionId: string }).missionId),
    );
    register('missions.transition', (input) => runtime.transitionMission(input as never), [
      'core',
      'test',
    ]);
  }

  #registerAiCapabilities(runtime: ChatRuntime): void {
    const register = (
      capability: string,
      handler: Parameters<CapabilityDispatcher['register']>[0]['handler'],
    ): void => {
      this.#dispatcher.register({
        capability,
        allowedActors: ['renderer', 'core', 'test'],
        handler,
      });
    };
    register('providers.read', () => ({ providers: runtime.listProviders() }));
    register('providers.configure', (input, context) =>
      runtime.configureProvider(input as never, context.signal),
    );
    register('providers.remove', async (input) => ({
      removed: await runtime.removeProvider((input as { providerId: string }).providerId),
    }));
    register('providers.validate', (input, context) =>
      runtime.validateProvider((input as { providerId: string }).providerId, context.signal),
    );
    register('models.read', (input) => ({
      models: runtime.listModels((input as { providerId?: string }).providerId),
    }));
    register('models.discover', async (input, context) => ({
      models: await runtime.discoverModels(
        (input as { providerId: string }).providerId,
        context.signal,
      ),
    }));
    register('ai.settings.read', () => runtime.getSettings());
    register('ai.settings.write', (input) => runtime.updateSettings(input as never));
    register('chat.history.read', (input) => {
      if ('conversationId' in (input as object)) {
        return runtime.getConversation((input as { conversationId: string }).conversationId);
      }
      return { conversations: runtime.listConversations() };
    });
    register('chat.conversation.create', (input) => runtime.createConversation(input as never));
    register('chat.conversation.route', (input) => runtime.updateConversationRoute(input as never));
    register('chat.send', (input, context) => {
      if ('messageId' in (input as object) && 'content' in (input as object)) {
        return runtime.editAndResend(input as never, context.correlation.requestId, context.signal);
      }
      if ('messageId' in (input as object)) {
        return runtime.retry(input as never, context.correlation.requestId, context.signal);
      }
      return runtime.send(input as never, context.correlation.requestId, context.signal);
    });
  }

  #readUiPreferences(): ReturnType<typeof UiPreferencesSchema.parse> {
    const stored = UiPreferencesSchema.safeParse(
      this.#settingsRepository.getSetting('ui.preferences'),
    );
    return stored.success ? stored.data : DEFAULT_UI_PREFERENCES;
  }
}
