import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { fileURLToPath } from 'node:url';

const aliases = {
  '@jupiter/ai-runtime': fileURLToPath(
    new URL('../../services/ai-runtime/src/index.ts', import.meta.url),
  ),
  '@jupiter/mission-runtime': fileURLToPath(
    new URL('../../services/mission-runtime/src/index.ts', import.meta.url),
  ),
  '@jupiter/workflow-runtime': fileURLToPath(
    new URL('../../services/workflow-runtime/src/index.ts', import.meta.url),
  ),
  '@jupiter/skill-runtime': fileURLToPath(
    new URL('../../services/skill-runtime/src/index.ts', import.meta.url),
  ),
  '@jupiter/security': fileURLToPath(
    new URL('../../packages/security/src/index.ts', import.meta.url),
  ),
  '@jupiter/contracts': fileURLToPath(
    new URL('../../packages/contracts/src/index.ts', import.meta.url),
  ),
  '@jupiter/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
  '@jupiter/database': fileURLToPath(
    new URL('../../packages/database/src/index.ts', import.meta.url),
  ),
  '@jupiter/ui': fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
  '@jupiter/ui-tokens': fileURLToPath(new URL('../../packages/ui/src/tokens.css', import.meta.url)),
};

export default defineConfig({
  main: {
    build: { externalizeDeps: true },
    resolve: { alias: aliases },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: { output: { format: 'cjs' } },
    },
    resolve: { alias: aliases },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: aliases },
    build: {
      sourcemap: false,
    },
  },
});
