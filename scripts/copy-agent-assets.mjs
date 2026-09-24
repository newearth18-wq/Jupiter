import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'services/agent-runtime/src/windows-automation-host.ps1');
const destination = resolve(root, 'services/agent-runtime/dist/windows-automation-host.ps1');
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
