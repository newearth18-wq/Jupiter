import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopPackagePath = resolve(root, 'apps/desktop/package.json');
const outputPath = resolve(root, 'apps/desktop/src/generated/build-metadata.json');
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'));
const channelArgument = process.argv.find((argument) => argument.startsWith('--channel='));
const requestedChannel = channelArgument?.slice('--channel='.length);

function readCommit() {
  if (process.env.JUPITER_COMMIT) return process.env.JUPITER_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unversioned';
  }
}

const generatedAt = new Date().toISOString();
const commit = readCommit();
const channel = process.env.JUPITER_BUILD_CHANNEL ?? requestedChannel ?? 'development';
const metadata = {
  schemaVersion: 1,
  productName: 'Jupiter',
  version: desktopPackage.version,
  channel,
  commit,
  buildId: process.env.JUPITER_BUILD_ID ?? `${channel}-${generatedAt.replace(/[:.]/g, '-')}`,
  targetPlatform: process.env.JUPITER_TARGET_PLATFORM ?? `${process.platform}-${process.arch}`,
  generatedAt,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
console.log(`Generated ${outputPath}`);
