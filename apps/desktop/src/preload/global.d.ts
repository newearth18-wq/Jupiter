import type {
  BootstrapState,
  DomainEvent,
  RpcRequestEnvelope,
  RpcResponseEnvelope,
} from '@jupiter/contracts';

declare global {
  interface Window {
    jupiter: Readonly<{
      getBootstrapState: () => Promise<BootstrapState>;
      retryStartup: (correlationId: string) => Promise<BootstrapState>;
      request: (input: RpcRequestEnvelope) => Promise<RpcResponseEnvelope>;
      cancel: (requestId: string) => Promise<boolean>;
      onDomainEvent: (listener: (event: DomainEvent) => void) => () => void;
    }>;
  }
}

export {};
