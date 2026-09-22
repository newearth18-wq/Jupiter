import { randomUUID } from 'node:crypto';
import {
  BOOTSTRAP_SCHEMA_VERSION,
  BootstrapStateSchema,
  EnvironmentSchema,
  type AppEnvironment,
  type BootstrapState,
} from '@jupiter/contracts';
import buildMetadata from '../generated/build-metadata.json' with { type: 'json' };

type RuntimeVersions = {
  app: string;
  electron: string;
  chrome: string;
  node: string;
};

type RuntimePlatform = {
  platform: string;
  architecture: string;
};

export type BootstrapDependencies = {
  versions: RuntimeVersions;
  runtimePlatform: RuntimePlatform;
  environment?: string;
  forceStartupFailure?: boolean;
  now?: () => Date;
};

function resolveEnvironment(value: string | undefined): AppEnvironment {
  const result = EnvironmentSchema.safeParse(value);
  return result.success ? result.data : 'production';
}

function sanitizedError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return 'Unknown foundation runtime error';
}

export function createBootstrapState(dependencies: BootstrapDependencies): BootstrapState {
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const environment = resolveEnvironment(dependencies.environment);
  let runtime: BootstrapState['runtime'];

  try {
    initializeFoundationRuntime(dependencies.forceStartupFailure ?? false);
    runtime = {
      status: 'operational',
      services: [
        {
          serviceId: 'foundation-runtime',
          status: 'operational',
          version: dependencies.versions.app,
          lastCheck: now,
          capabilities: ['foundation.health', 'foundation.metadata'],
        },
      ],
    };
  } catch (error) {
    const details = sanitizedError(error);
    runtime = {
      status: 'degraded',
      services: [
        {
          serviceId: 'foundation-runtime',
          status: 'degraded',
          version: dependencies.versions.app,
          lastCheck: now,
          capabilities: [],
          sanitizedError: details,
        },
      ],
      startupError: {
        code: 'FOUNDATION_STARTUP_FAILED',
        message: 'Jupiter could not start its foundation runtime.',
        recoverable: true,
        userAction: 'Review Diagnostics, then retry startup.',
        sanitizedDetails: details,
        timestamp: now,
      },
    };
  }

  return BootstrapStateSchema.parse({
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    correlationId: randomUUID(),
    generatedAt: now,
    metadata: {
      productName: 'Jupiter',
      version: dependencies.versions.app,
      environment,
      buildChannel: buildMetadata.channel,
      buildId: buildMetadata.buildId,
      commit: buildMetadata.commit,
      platform: dependencies.runtimePlatform.platform,
      architecture: dependencies.runtimePlatform.architecture,
      electronVersion: dependencies.versions.electron,
      chromeVersion: dependencies.versions.chrome,
      nodeVersion: dependencies.versions.node,
    },
    runtime,
    navigation: [
      { id: 'home', availability: 'available' },
      { id: 'diagnostics', availability: 'available' },
      { id: 'settings', availability: 'not_configured' },
    ],
  });
}

function initializeFoundationRuntime(forceFailure: boolean): void {
  if (forceFailure) {
    throw new Error('Foundation runtime failure was requested by the controlled test environment.');
  }
}
