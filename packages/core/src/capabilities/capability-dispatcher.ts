import type { Actor, CorrelationContext } from '@jupiter/contracts';
import { JupiterError } from '../errors/jupiter-error.js';

export type CapabilityHandlerContext = {
  correlation: CorrelationContext;
  signal: AbortSignal;
};

export type CapabilityDefinition = {
  capability: string;
  allowedActors: readonly Actor[];
  handler: (input: unknown, context: CapabilityHandlerContext) => unknown;
};

export class CapabilityDispatcher {
  readonly #definitions = new Map<string, CapabilityDefinition>();

  register(definition: CapabilityDefinition): void {
    if (this.#definitions.has(definition.capability)) {
      throw new JupiterError({
        code: 'CAPABILITY_ALREADY_REGISTERED',
        category: 'configuration',
        message: 'The capability is already registered.',
        recoverable: false,
        retryable: false,
        userAction: 'Review the Core capability configuration.',
      });
    }
    this.#definitions.set(definition.capability, definition);
  }

  dispatch(
    capability: string,
    input: unknown,
    correlation: CorrelationContext,
    signal: AbortSignal,
  ): unknown {
    if (signal.aborted) {
      throw new JupiterError({
        code: 'REQUEST_CANCELLED',
        category: 'cancellation',
        message: 'The request was cancelled before execution.',
        recoverable: true,
        retryable: true,
        userAction: 'Retry the request when ready.',
      });
    }

    const definition = this.#definitions.get(capability);
    if (!definition) {
      throw new JupiterError({
        code: 'CAPABILITY_UNAVAILABLE',
        category: 'unsupported',
        message: 'The requested capability is unavailable.',
        recoverable: false,
        retryable: false,
        userAction: 'Use a capability listed as available.',
      });
    }
    if (!definition.allowedActors.includes(correlation.actor)) {
      throw new JupiterError({
        code: 'CAPABILITY_NOT_AUTHORIZED',
        category: 'permission',
        message: 'The actor is not authorized for this capability.',
        recoverable: false,
        retryable: false,
        userAction: 'Return to the trusted Jupiter interface.',
      });
    }
    return definition.handler(input, { correlation, signal });
  }

  listCapabilities(): string[] {
    return [...this.#definitions.keys()].sort();
  }
}
