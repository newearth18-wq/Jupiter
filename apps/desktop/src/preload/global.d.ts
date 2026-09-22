import type { BootstrapState } from '@jupiter/contracts';

declare global {
  interface Window {
    jupiter: Readonly<{
      getBootstrapState: () => Promise<BootstrapState>;
      retryStartup: (correlationId: string) => Promise<BootstrapState>;
    }>;
  }
}

export {};
