import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@jupiter/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)),
      '@jupiter/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@jupiter/database': fileURLToPath(new URL('../database/src/index.ts', import.meta.url)),
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
