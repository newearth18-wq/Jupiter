import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    hasArbitraryFileApi: string;
    hasCredentialApi: string;
    invalidRejected: boolean;
    eventCursor: number;
    ping: { status: string; requestId: string; data?: { message: string } };
    diagnostics: {
      status: string;
      data?: {
        status: string;
        database: { status: string; schemaVersion: number; integrity: string };
      };
    };
    denied: { status: string; error?: { category: string } };
  };
  reconnection: { cursor: number; replayedEventCount: number };
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

async function runElectron(options: {
  forceFoundationFailure?: boolean;
  forceServiceFailure?: boolean;
}): Promise<SmokeEvidence> {
  const directory = mkdtempSync(join(tmpdir(), 'jupiter-electron-smoke-'));
  const evidencePath = join(directory, 'evidence.json');
  const child = spawn(electronPath, [desktopDirectory], {
    cwd: desktopDirectory,
    env: {
      ...process.env,
      JUPITER_APP_ENV: 'test',
      JUPITER_DATA_DIR: join(directory, 'data'),
      JUPITER_SMOKE_TEST: '1',
      JUPITER_SMOKE_EVIDENCE_PATH: evidencePath,
      JUPITER_FORCE_STARTUP_FAILURE: options.forceFoundationFailure ? '1' : '0',
      JUPITER_FORCE_SERVICE_FAILURE: options.forceServiceFailure ? '1' : '0',
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
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as SmokeEvidence;
  rmSync(directory, { force: true, recursive: true });
  return evidence;
}

describe('packaged-shape Electron shell', () => {
  it('launches a real renderer with no direct Node integration', async () => {
    const evidence = await runElectron({});
    expect(evidence.bootstrapState.runtime.status).toBe('operational');
    expect(evidence.bootstrapState.metadata.version).toBe('0.1.0');
    expect(evidence.renderer.title).toBe('Jupiter');
    expect(evidence.renderer.status).toBeTruthy();
    expect(evidence.renderer.hasRequire).toBe('undefined');
    expect(evidence.renderer.hasProcess).toBe('undefined');
    expect(evidence.renderer.apiKeys).toEqual([
      'cancel',
      'getBootstrapState',
      'onDomainEvent',
      'request',
      'retryStartup',
    ]);
    expect(evidence.renderer.hasArbitraryFileApi).toBe('undefined');
    expect(evidence.renderer.hasCredentialApi).toBe('undefined');
    expect(evidence.renderer.invalidRejected).toBe(true);
    expect(evidence.renderer.ping.status).toBe('success');
    expect(evidence.renderer.ping.data?.message).toBe('smoke-pong');
    expect(evidence.renderer.diagnostics.status).toBe('success');
    expect(evidence.renderer.diagnostics.data?.database).toMatchObject({
      status: 'operational',
      schemaVersion: 2,
      integrity: 'ok',
    });
    expect(evidence.renderer.denied.status).toBe('error');
    expect(evidence.renderer.denied.error?.category).toBe('permission');
    expect(evidence.renderer.eventCursor).toBeGreaterThan(0);
    expect(evidence.reconnection.cursor).toBeGreaterThanOrEqual(evidence.renderer.eventCursor);
    expect(evidence.reconnection.replayedEventCount).toBe(0);
    expect(evidence.webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });

  it('keeps the shell alive and reports a recoverable startup failure', async () => {
    const evidence = await runElectron({ forceFoundationFailure: true });
    expect(evidence.bootstrapState.runtime.status).toBe('degraded');
    expect(evidence.bootstrapState.runtime.startupError?.recoverable).toBe(true);
    expect(evidence.renderer.status).toBeTruthy();
  });

  it('isolates a Core service crash and exposes degraded health without exiting', async () => {
    const evidence = await runElectron({ forceServiceFailure: true });
    expect(evidence.bootstrapState.runtime.status).toBe('operational');
    expect(evidence.renderer.diagnostics.status).toBe('success');
    expect(evidence.renderer.diagnostics.data?.status).toBe('degraded');
    expect(evidence.renderer.status).toBeTruthy();
  });
});
