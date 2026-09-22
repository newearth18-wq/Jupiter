import { randomUUID } from 'node:crypto';
import {
  CONTRACT_SCHEMA_VERSION,
  type CoreServiceHealth,
  type DomainEvent,
} from '@jupiter/contracts';
import { describe, expect, it } from 'vitest';
import { DomainEventBus } from '../events/domain-event-bus.js';
import type { DomainEventDraft, EventStore, ServiceHealthRepository } from '../ports.js';
import { ServiceManager } from './service-manager.js';

class MemoryStore implements EventStore {
  readonly events: DomainEvent[] = [];

  append(draft: DomainEventDraft): DomainEvent {
    const event: DomainEvent = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      eventId: randomUUID(),
      sequence: this.events.length + 1,
      streamSequence: this.events.length + 1,
      ...draft,
    };
    this.events.push(event);
    return event;
  }

  listAfter(afterSequence: number, limit: number): DomainEvent[] {
    return this.events.filter((event) => event.sequence > afterSequence).slice(0, limit);
  }
}

class MemoryHealth implements ServiceHealthRepository {
  readonly records = new Map<string, CoreServiceHealth>();

  upsert(health: CoreServiceHealth): void {
    this.records.set(health.serviceId, health);
  }

  list(): CoreServiceHealth[] {
    return [...this.records.values()];
  }
}

describe('ServiceManager', () => {
  it('isolates a failed service and starts the remaining services', async () => {
    const store = new MemoryStore();
    const health = new MemoryHealth();
    const manager = new ServiceManager(health, new DomainEventBus(store));
    let healthyStarted = false;

    manager.register({
      serviceId: 'failed-service',
      version: '1.0.0',
      capabilities: [],
      start: () => {
        throw new Error('sanitized failure');
      },
      stop: () => undefined,
    });
    manager.register({
      serviceId: 'healthy-service',
      version: '1.0.0',
      capabilities: ['health.check'],
      start: () => {
        healthyStarted = true;
      },
      stop: () => undefined,
    });

    const result = await manager.startAll(randomUUID(), new AbortController().signal);

    expect(healthyStarted).toBe(true);
    expect(result.find((item) => item.serviceId === 'failed-service')?.status).toBe('failed');
    expect(result.find((item) => item.serviceId === 'healthy-service')?.status).toBe('operational');
    expect(store.events.filter((event) => event.type === 'service.health.changed')).toHaveLength(4);
  });
});
