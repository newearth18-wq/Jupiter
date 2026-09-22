import { DomainEventSchema, type DomainEvent } from '@jupiter/contracts';
import type { DomainEventDraft, EventStore } from '../ports.js';

export type DomainEventListener = (event: DomainEvent) => void;

export class DomainEventBus {
  readonly #store: EventStore;
  readonly #listeners = new Set<DomainEventListener>();

  constructor(store: EventStore) {
    this.#store = store;
  }

  publish(draft: DomainEventDraft): DomainEvent {
    const event = DomainEventSchema.parse(this.#store.append(draft));
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  subscribe(listener: DomainEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  replayAfter(afterSequence: number, limit = 100): DomainEvent[] {
    return this.#store
      .listAfter(afterSequence, limit)
      .map((event) => DomainEventSchema.parse(event));
  }
}
