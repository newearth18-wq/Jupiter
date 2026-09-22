import { describe, expect, it } from 'vitest';
import { BootstrapStateSchema } from './bootstrap.js';

const validState = {
  schemaVersion: 1,
  correlationId: '42c0793e-c305-4c8b-ae4f-99ee5e31f8fb',
  generatedAt: '2026-09-22T00:00:00.000Z',
  metadata: {
    productName: 'Jupiter',
    version: '0.1.0',
    environment: 'test',
    buildChannel: 'test',
    buildId: 'test-build',
    commit: 'unversioned',
    platform: 'win32',
    architecture: 'x64',
    electronVersion: '1.0.0',
    chromeVersion: '1.0.0',
    nodeVersion: '1.0.0',
  },
  runtime: {
    status: 'operational',
    services: [
      {
        serviceId: 'foundation-runtime',
        status: 'operational',
        version: '0.1.0',
        lastCheck: '2026-09-22T00:00:00.000Z',
        capabilities: ['foundation.health'],
      },
    ],
  },
  navigation: [
    { id: 'home', availability: 'available' },
    { id: 'diagnostics', availability: 'available' },
    { id: 'settings', availability: 'not_configured' },
  ],
} as const;

describe('BootstrapStateSchema', () => {
  it('accepts the versioned foundation state', () => {
    expect(BootstrapStateSchema.parse(validState)).toEqual(validState);
  });

  it('rejects undeclared fields at the process boundary', () => {
    expect(() =>
      BootstrapStateSchema.parse({ ...validState, privilegedPath: 'blocked' }),
    ).toThrow();
  });
});
