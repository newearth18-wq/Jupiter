import {
  BOOTSTRAP_SCHEMA_VERSION,
  BootstrapStateSchema,
  RetryStartupRequestSchema,
  type BootstrapState,
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
});

contextBridge.exposeInMainWorld('jupiter', api);
