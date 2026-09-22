import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'out', 'release', 'coverage']);
const ignoredFiles = new Set(['pnpm-lock.yaml', 'check-secrets.mjs']);
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const findings = [];
const rules = [
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/u },
  { name: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{30,}/u },
  {
    name: 'assigned secret',
    pattern: /(?:api[_-]?key|token|password|secret)\s*[:=]\s*["'][^"']{8,}["']/iu,
  },
];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      (ignoredDirectories.has(entry.name) || entry.name.startsWith('node_modules.failed-'))
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!entry.isFile() || ignoredFiles.has(entry.name) || !textExtensions.has(extname(entry.name)))
      continue;
    if (statSync(path).size > 1_000_000) continue;
    const content = readFileSync(path, 'utf8');
    for (const rule of rules) {
      if (rule.pattern.test(content)) findings.push(`${relative(root, path)}: ${rule.name}`);
    }
  }
}

walk(root);
if (findings.length > 0) {
  console.error(`Potential hardcoded secrets found:\n${findings.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Secret scan passed: no credential patterns found.');
}
