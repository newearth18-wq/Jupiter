import type { CoreServiceHealth } from '@jupiter/contracts';
import type { DomainEventBus } from '../events/domain-event-bus.js';
import type { ServiceHealthRepository } from '../ports.js';

export type ManagedService = {
  serviceId: string;
  version: string;
  capabilities: readonly string[];
  start: (signal: AbortSignal) => void | Promise<void>;
  stop: () => void | Promise<void>;
  check?: () => void | Promise<void>;
};

export class ServiceManager {
  readonly #repository: ServiceHealthRepository;
  readonly #events: DomainEventBus;
  readonly #services = new Map<string, ManagedService>();

  constructor(repository: ServiceHealthRepository, events: DomainEventBus) {
    this.#repository = repository;
    this.#events = events;
  }

  register(service: ManagedService): void {
    if (this.#services.has(service.serviceId)) {
      throw new Error(`Service already registered: ${service.serviceId}`);
    }
    this.#services.set(service.serviceId, service);
  }

  async startAll(correlationId: string, signal: AbortSignal): Promise<CoreServiceHealth[]> {
    for (const service of this.#services.values()) {
      await this.#startOne(service, correlationId, signal);
    }
    return this.#repository.list();
  }

  async refreshAll(correlationId: string): Promise<CoreServiceHealth[]> {
    for (const service of this.#services.values()) {
      const startedAt = performance.now();
      try {
        await service.check?.();
        this.#record(service, 'operational', performance.now() - startedAt, correlationId);
      } catch (error) {
        this.#record(
          service,
          'degraded',
          performance.now() - startedAt,
          correlationId,
          this.#sanitizeError(error),
        );
      }
    }
    return this.#repository.list();
  }

  async stopAll(correlationId: string): Promise<void> {
    for (const service of [...this.#services.values()].reverse()) {
      try {
        await service.stop();
      } finally {
        this.#record(service, 'stopped', undefined, correlationId);
      }
    }
  }

  listHealth(): CoreServiceHealth[] {
    return this.#repository.list();
  }

  async #startOne(
    service: ManagedService,
    correlationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.#record(service, 'starting', undefined, correlationId);
    const startedAt = performance.now();
    try {
      await service.start(signal);
      this.#record(service, 'operational', performance.now() - startedAt, correlationId);
    } catch (error) {
      this.#record(
        service,
        'failed',
        performance.now() - startedAt,
        correlationId,
        this.#sanitizeError(error),
      );
    }
  }

  #record(
    service: ManagedService,
    status: CoreServiceHealth['status'],
    latencyMs: number | undefined,
    correlationId: string,
    sanitizedError?: string,
  ): void {
    const health: CoreServiceHealth = {
      serviceId: service.serviceId,
      status,
      version: service.version,
      lastCheck: new Date().toISOString(),
      capabilities: [...service.capabilities],
      ...(latencyMs === undefined ? {} : { latencyMs }),
      ...(sanitizedError === undefined ? {} : { sanitizedError }),
    };
    this.#repository.upsert(health);
    this.#events.publish({
      type: 'service.health.changed',
      correlationId,
      actor: 'core',
      source: 'service-manager',
      payload: {
        serviceId: service.serviceId,
        status,
        ...(sanitizedError === undefined ? {} : { sanitizedError }),
      },
      occurredAt: health.lastCheck,
    });
  }

  #sanitizeError(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 500) : 'Unknown service error';
  }
}
