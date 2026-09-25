import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@jupiter/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
      '@jupiter/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@jupiter/database': fileURLToPath(
        new URL('../../packages/database/src/index.ts', import.meta.url),
      ),
      '@jupiter/security': fileURLToPath(
        new URL('../../packages/security/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
