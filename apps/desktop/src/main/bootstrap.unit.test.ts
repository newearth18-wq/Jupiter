import { describe, expect, it } from 'vitest';
import { createBootstrapState } from './bootstrap.js';

const dependencies = {
  versions: { app: '9.8.7', electron: '44.4.3', chrome: '142.0.0', node: '24.0.0' },
  runtimePlatform: { platform: 'win32', architecture: 'x64' },
  environment: 'test',
  now: () => new Date('2026-09-22T00:00:00.000Z'),
};

describe('createBootstrapState', () => {
  it('reports the actual application version and healthy foundation runtime', () => {
    const state = createBootstrapState(dependencies);
    expect(state.metadata.version).toBe('9.8.7');
    expect(state.runtime.status).toBe('operational');
    expect(state.runtime.startupError).toBeUndefined();
  });

  it('turns a startup failure into a truthful recoverable state', () => {
    const state = createBootstrapState({ ...dependencies, forceStartupFailure: true });
    expect(state.runtime.status).toBe('degraded');
    expect(state.runtime.startupError).toMatchObject({
      code: 'FOUNDATION_STARTUP_FAILED',
      recoverable: true,
    });
    expect(state.runtime.services[0]?.status).toBe('degraded');
  });
});
