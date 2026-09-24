import { createHash, randomUUID } from 'node:crypto';
import {
  CONTRACT_SCHEMA_VERSION,
  DEFAULT_UI_PREFERENCES,
  DiagnosticsSnapshotSchema,
  UiPreferencesSchema,
  UiPreferencesUpdateSchema,
  type Actor,
  type ChatStreamEvent,
  type DiagnosticsSnapshot,
  type PermissionRequestInput,
  type PermissionResolveInput,
  type ProviderConfigureInput,
  type RpcResponseEnvelope,
  type SkillInvocation,
  type SkillLookupInput,
  type WorkflowCheckpointResolveInput,
  type WorkflowControlInput,
  type WorkflowPlanCreateInput,
  type WorkflowReplanInput,
} from '@jupiter/contracts';
import { CapabilityDispatcher } from '../capabilities/capability-dispatcher.js';
import { JupiterError } from '../errors/jupiter-error.js';
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
  SkillRuntime,
  PermissionRuntime,
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
  skillRuntime?: SkillRuntime;
  permissionRuntime?: PermissionRuntime;
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
  readonly #skillRuntime: SkillRuntime | undefined;
  readonly #permissionRuntime: PermissionRuntime | undefined;
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
    this.#skillRuntime = dependencies.skillRuntime;
    this.#permissionRuntime = dependencies.permissionRuntime;
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
      this.#skillRuntime?.shutdown(),
      this.#permissionRuntime?.shutdown(),
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
    if (this.#skillRuntime) this.#registerSkillCapabilities(this.#skillRuntime);
    if (this.#permissionRuntime) this.#registerPermissionCapabilities(this.#permissionRuntime);
  }

  #registerPermissionCapabilities(runtime: PermissionRuntime): void {
    const register = (
      capability: string,
      handler: Parameters<CapabilityDispatcher['register']>[0]['handler'],
      allowedActors: Actor[] = ['renderer', 'core', 'test'],
    ): void => this.#dispatcher.register({ capability, allowedActors, handler });
    register('permissions.capabilities.read', () => ({ capabilities: runtime.listCapabilities() }));
    register('permissions.requests.read', (input) => ({
      requests: runtime.listRequests(
        (input as { status?: Parameters<PermissionRuntime['listRequests']>[0] }).status,
      ),
    }));
    register('permissions.grants.read', () => ({ grants: runtime.listGrants() }));
    register('permissions.audit.read', (input) => ({
      audits: runtime.listAudits((input as { limit?: number }).limit ?? 100),
    }));
    register('permissions.request', (input) => runtime.request(input as PermissionRequestInput), [
      'core',
      'service',
      'test',
    ]);
    register('permissions.resolve', (input, context) =>
      runtime.resolve(
        input as PermissionResolveInput,
        context.correlation.actor === 'renderer' || context.correlation.actor === 'test'
          ? 'USER_EXPLICIT'
          : 'TRUSTED_POLICY',
      ),
    );
    register('permissions.revoke', (input, context) => ({
      revoked: runtime.revoke((input as { grantId: string }).grantId, context.correlation.actor),
    }));
  }

  #registerSkillCapabilities(runtime: SkillRuntime): void {
    const register = (
      capability: string,
      handler: Parameters<CapabilityDispatcher['register']>[0]['handler'],
      allowedActors: Actor[] = ['renderer', 'core', 'test'],
    ): void => this.#dispatcher.register({ capability, allowedActors, handler });
    register('skills.read', (input) => {
      const payload = input as {
        skillId?: string;
        version?: string;
        query?: string;
        category?: string;
      };
      if (payload.skillId) {
        return { skill: runtime.get(payload as SkillLookupInput) ?? null };
      }
      return {
        skills: runtime.search({
          query: payload.query ?? '',
          ...(payload.category ? { category: payload.category } : {}),
        }),
      };
    });
    register('skills.versions', (input) => {
      const skillId = (input as { skillId: string }).skillId;
      return { skillId, versions: runtime.listVersions(skillId) };
    });
    register('skills.enable', (input) => ({
      skill: runtime.enable((input as { skillId: string }).skillId),
    }));
    register('skills.disable', (input) => ({
      skill: runtime.disable((input as { skillId: string }).skillId),
    }));
    register('skills.health', async (input, context) => ({
      skill: await runtime.healthCheck((input as { skillId: string }).skillId, context.signal),
    }));
    register('skills.invoke', (input, context) =>
      runtime.invoke(input as SkillInvocation, context.signal),
    );
    register('skills.cancel', (input) => ({
      cancelled: runtime.cancel((input as { executionId: string }).executionId),
    }));
    register('skills.executions', (input) => ({
      executions: runtime.listExecutions((input as { skillId?: string }).skillId),
    }));
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
    register('providers.configure', async (input, context) => {
      const payload = input as ProviderConfigureInput;
      this.#requireProviderPermission(
        payload.providerId,
        'configure',
        `Configure ${payload.displayName}`,
        `Credential and endpoint settings for ${payload.baseUrl}`,
        context.correlation.actor,
        providerConfigurationFingerprint(payload),
      );
      return runtime.configureProvider(payload, context.signal);
    });
    register('providers.remove', async (input, context) => {
      const providerId = (input as { providerId: string }).providerId;
      this.#requireProviderPermission(
        providerId,
        'remove',
        `Remove provider ${providerId}`,
        'Stored provider configuration and credential',
        context.correlation.actor,
      );
      return { removed: await runtime.removeProvider(providerId) };
    });
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

  #requireProviderPermission(
    providerId: string,
    operation: 'configure' | 'remove',
    targetDisplay: string,
    scopeDisplay: string,
    actor: Actor,
    configurationFingerprint?: string,
  ): void {
    const runtime = this.#permissionRuntime;
    if (!runtime) {
      throw new JupiterError({
        code: 'PERMISSION_ENGINE_UNAVAILABLE',
        category: 'permission',
        message: 'The permission engine is unavailable.',
        recoverable: true,
        retryable: false,
        userAction: 'Open Diagnostics and restore the permission service before retrying.',
      });
    }
    const requesterType = actor === 'core' || actor === 'service' ? 'CORE' : 'UI';
    const requesterId = requesterType === 'UI' ? 'models-screen' : 'jupiter-core';
    const authorization = runtime.authorize({
      capability: 'credentials.modify',
      actor,
      requesterType,
      requesterId,
      declaredCapabilities: ['credentials.modify'],
      targetId: `provider:${providerId}`,
      scopeId: 'provider-credentials',
      constraints: {
        operation,
        ...(configurationFingerprint ? { configurationFingerprint } : {}),
      },
      automated: false,
    });
    if (authorization.status === 'ALLOWED') return;
    if (authorization.status === 'DENIED') {
      throw new JupiterError({
        code: 'PERMISSION_DENIED',
        category: 'permission',
        message: 'Permission policy denied the provider change.',
        recoverable: true,
        retryable: false,
        userAction: 'Review or revoke the matching policy in Permission Center.',
      });
    }
    const request = runtime.request({
      capability: 'credentials.modify',
      action:
        operation === 'configure'
          ? 'Add or update an AI provider and its credential.'
          : 'Remove an AI provider and its stored credential.',
      reason: 'The user requested this provider configuration change.',
      target: { type: 'provider', id: `provider:${providerId}`, display: targetDisplay },
      scope: { type: 'credential', id: 'provider-credentials', display: scopeDisplay },
      requester: {
        actor,
        type: requesterType,
        id: requesterId,
        display: requesterType === 'UI' ? 'AI Models settings' : 'Jupiter Core',
        declaredCapabilities: ['credentials.modify'],
      },
      trustSource: requesterType === 'UI' ? 'USER_INTENT' : 'TRUSTED_RUNTIME',
      dataLeavingDevice: {
        value: operation === 'configure',
        description:
          operation === 'configure'
            ? 'Provider settings and any credential are sent only to the exact configured endpoint for validation.'
            : 'No data leaves the device while removing this local configuration.',
      },
      consequence:
        operation === 'configure'
          ? 'Jupiter provider authentication and routing availability may change.'
          : 'Jupiter will no longer use this provider until it is configured again.',
      reversible: true,
      automated: false,
      constraints: {
        operation,
        ...(configurationFingerprint ? { configurationFingerprint } : {}),
      },
    });
    throw new JupiterError({
      code: 'PERMISSION_REQUIRED',
      category: 'permission',
      message: 'Explicit permission is required before changing provider credentials.',
      recoverable: true,
      retryable: true,
      userAction: 'Review the exact request in Permission Center, then retry the action.',
      sanitizedDetails: `permissionRequestId=${request.requestId}`,
    });
  }
}

function providerConfigurationFingerprint(input: ProviderConfigureInput): string {
  const nonSecretConfiguration = JSON.stringify({
    providerId: input.providerId,
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    locality: input.locality,
    authScheme: input.authScheme,
    enabled: input.enabled,
    capabilities: [...input.capabilities].sort(),
    credentialAction:
      input.clearCredential === true
        ? 'clear'
        : input.credential === undefined
          ? 'retain'
          : 'replace',
  });
  return createHash('sha256').update(nonSecretConfiguration).digest('hex');
}
