import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const release = resolve(root, 'release', 'win-unpacked');
const executable = resolve(release, 'Jupiter.exe');
const archive = resolve(release, 'resources', 'app.asar');
const desktopPackage = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'));

const checks = [
  ['Windows executable', executable],
  ['ASAR application archive', archive],
];

for (const [label, path] of checks) {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`${label} missing or empty: ${path}`);
  }
}

console.log(
  JSON.stringify(
    {
      status: 'valid',
      product: desktopPackage.productName,
      version: desktopPackage.version,
      executable,
      archive,
    },
    null,
    2,
  ),
);
