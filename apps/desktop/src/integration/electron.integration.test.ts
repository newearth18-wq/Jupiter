import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type SmokeEvidence = {
  bootstrapState: {
    metadata: { version: string };
    runtime: { status: string; startupError?: { recoverable: boolean } };
  };
  renderer: {
    title: string;
    status: string | null;
    hasRequire: string;
    hasProcess: string;
    apiKeys: string[];
  };
  webPreferences: {
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: boolean;
    webSecurity: boolean;
  };
};

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function runElectron(forceFailure: boolean): Promise<SmokeEvidence> {
  const directory = mkdtempSync(join(tmpdir(), 'jupiter-electron-smoke-'));
  const evidencePath = join(directory, 'evidence.json');
  const child = spawn(electronPath, [desktopDirectory], {
    cwd: desktopDirectory,
    env: {
      ...process.env,
      JUPITER_APP_ENV: 'test',
      JUPITER_SMOKE_TEST: '1',
      JUPITER_SMOKE_EVIDENCE_PATH: evidencePath,
      JUPITER_FORCE_STARTUP_FAILURE: forceFailure ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const output: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron smoke timed out. Output: ${output.join('')}`));
    }, 30_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });

  expect(exitCode, output.join('')).toBe(0);
  return JSON.parse(readFileSync(evidencePath, 'utf8')) as SmokeEvidence;
}

describe('packaged-shape Electron shell', () => {
  it('launches a real renderer with no direct Node integration', async () => {
    const evidence = await runElectron(false);
    expect(evidence.bootstrapState.runtime.status).toBe('operational');
    expect(evidence.bootstrapState.metadata.version).toBe('0.1.0');
    expect(evidence.renderer.title).toBe('Jupiter');
    expect(evidence.renderer.status).toBeTruthy();
    expect(evidence.renderer.hasRequire).toBe('undefined');
    expect(evidence.renderer.hasProcess).toBe('undefined');
    expect(evidence.renderer.apiKeys).toEqual(['getBootstrapState', 'retryStartup']);
    expect(evidence.webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });

  it('keeps the shell alive and reports a recoverable startup failure', async () => {
    const evidence = await runElectron(true);
    expect(evidence.bootstrapState.runtime.status).toBe('degraded');
    expect(evidence.bootstrapState.runtime.startupError?.recoverable).toBe(true);
    expect(evidence.renderer.status).toBeTruthy();
  });
});
