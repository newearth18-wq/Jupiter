import { randomUUID } from 'node:crypto';
import {
  CONTRACT_SCHEMA_VERSION,
  DiagnosticsSnapshotSchema,
  type Actor,
  type DiagnosticsSnapshot,
  type RpcResponseEnvelope,
} from '@jupiter/contracts';
import { CapabilityDispatcher } from '../capabilities/capability-dispatcher.js';
import { DomainEventBus, type DomainEventListener } from '../events/domain-event-bus.js';
import type {
  AuditRepository,
  DiagnosticsRepository,
  EventStore,
  ServiceHealthRepository,
} from '../ports.js';
import { RpcGateway } from '../rpc/rpc-gateway.js';
import { ServiceManager, type ManagedService } from '../services/service-manager.js';

export type JupiterCoreDependencies = {
  version: string;
  eventStore: EventStore;
  auditRepository: AuditRepository;
  serviceHealthRepository: ServiceHealthRepository;
  diagnosticsRepository: DiagnosticsRepository;
};

export class JupiterCore {
  readonly #version: string;
  readonly #events: DomainEventBus;
  readonly #services: ServiceManager;
  readonly #diagnosticsRepository: DiagnosticsRepository;
  readonly #dispatcher: CapabilityDispatcher;
  readonly #gateway: RpcGateway;
  #started = false;

  constructor(dependencies: JupiterCoreDependencies) {
    this.#version = dependencies.version;
    this.#events = new DomainEventBus(dependencies.eventStore);
    this.#services = new ServiceManager(dependencies.serviceHealthRepository, this.#events);
    this.#diagnosticsRepository = dependencies.diagnosticsRepository;
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
  }
}
