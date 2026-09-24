import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'services/browser-runtime/dist/browser-worker.mjs');
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(resolve(root, 'services/browser-runtime/dist/browser-worker.js'), destination);
