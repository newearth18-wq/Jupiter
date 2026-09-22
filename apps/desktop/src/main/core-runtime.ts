import { join } from 'node:path';
import type {
  Actor,
  DiagnosticsSnapshot,
  DomainEvent,
  RpcResponseEnvelope,
} from '@jupiter/contracts';
import { JupiterCore, type DomainEventListener } from '@jupiter/core';
import { JupiterDatabase } from '@jupiter/database';

export type DesktopCoreRuntimeOptions = {
  dataDirectory: string;
  version: string;
  forceServiceFailure?: boolean;
};

export class DesktopCoreRuntime {
  readonly #database: JupiterDatabase;
  readonly #core: JupiterCore;
  #closed = false;

  constructor(options: DesktopCoreRuntimeOptions) {
    this.#database = JupiterDatabase.open(join(options.dataDirectory, 'jupiter.db'));
    this.#core = new JupiterCore({
      version: options.version,
      eventStore: this.#database,
      auditRepository: this.#database,
      serviceHealthRepository: this.#database,
      diagnosticsRepository: this.#database,
    });
    this.#core.registerService({
      serviceId: 'local-coordinator',
      version: options.version,
      capabilities: ['core.rpc', 'diagnostics.read', 'events.replay'],
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

  start(signal: AbortSignal): Promise<DiagnosticsSnapshot> {
    return this.#core.start(signal);
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

  getDiagnostics(): DiagnosticsSnapshot {
    return this.#core.getDiagnostics();
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    await this.#core.shutdown();
    this.#database.close();
    this.#closed = true;
  }
}

export type { DomainEvent };
