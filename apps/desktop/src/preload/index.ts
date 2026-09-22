import {
  BOOTSTRAP_SCHEMA_VERSION,
  BootstrapStateSchema,
  CONTRACT_SCHEMA_VERSION,
  CancelRequestSchema,
  DomainEventSchema,
  RetryStartupRequestSchema,
  RpcRequestEnvelopeSchema,
  RpcResponseEnvelopeSchema,
  parseRpcSuccessData,
  type BootstrapState,
  type DomainEvent,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from '@jupiter/contracts';
import { contextBridge, ipcRenderer } from 'electron';

const api = Object.freeze({
  async getBootstrapState(): Promise<BootstrapState> {
    const response: unknown = await ipcRenderer.invoke('jupiter:bootstrap:get');
    return BootstrapStateSchema.parse(response);
  },
  async retryStartup(correlationId: string): Promise<BootstrapState> {
    const request = RetryStartupRequestSchema.parse({
      schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
      correlationId,
    });
    const response: unknown = await ipcRenderer.invoke('jupiter:bootstrap:retry', request);
    return BootstrapStateSchema.parse(response);
  },
  async request(input: RpcRequestEnvelope): Promise<RpcResponseEnvelope> {
    const request = RpcRequestEnvelopeSchema.parse(input);
    const response: unknown = await ipcRenderer.invoke('jupiter:rpc:request', request);
    const envelope = RpcResponseEnvelopeSchema.parse(response);
    if (envelope.status === 'success') {
      return {
        ...envelope,
        data: parseRpcSuccessData(envelope.requestName, envelope.data),
      };
    }
    return envelope;
  },
  async cancel(requestId: string): Promise<boolean> {
    const request = CancelRequestSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId,
    });
    const response: unknown = await ipcRenderer.invoke('jupiter:rpc:cancel', request);
    if (typeof response !== 'boolean') throw new Error('Invalid cancellation response.');
    return response;
  },
  onDomainEvent(listener: (event: DomainEvent) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, input: unknown): void => {
      listener(DomainEventSchema.parse(input));
    };
    ipcRenderer.on('jupiter:domain-event', wrapped);
    return () => ipcRenderer.removeListener('jupiter:domain-event', wrapped);
  },
});

contextBridge.exposeInMainWorld('jupiter', api);
