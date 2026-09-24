import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BrowserActionErrorSchema,
  BrowserActionInputSchema,
  BrowserActionOutputSchema,
  BrowserPageObservationSchema,
  BrowserSecuritySignalSchema,
  type BrowserActionInput,
} from '@jupiter/contracts';

const NativeEvidenceSchema = z
  .object({
    kind: z.enum(['screenshot', 'download', 'html']),
    path: z.string().min(1).max(32_767),
    mediaType: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    verified: z.boolean(),
    sourceOrigin: z.url(),
  })
  .strict();

export const NativeBrowserResponseSchema = z
  .object({
    success: z.boolean(),
    status: z.enum(['SUCCESS', 'FAILED', 'CANCELLED', 'PAUSED']).optional(),
    observation: z.string().trim().min(1).max(2_000),
    sessionId: z.uuid().optional(),
    tabId: z.uuid().optional(),
    page: BrowserPageObservationSchema.optional(),
    output: BrowserActionOutputSchema.optional(),
    evidence: z.array(NativeEvidenceSchema).max(20).default([]),
    securitySignals: z.array(BrowserSecuritySignalSchema).max(50).default([]),
    error: BrowserActionErrorSchema.optional(),
  })
  .strict();

const WorkerEnvelopeSchema = z
  .object({
    requestId: z.uuid(),
    result: NativeBrowserResponseSchema.optional(),
    cancelled: z.boolean().optional(),
    shutdown: z.boolean().optional(),
    error: BrowserActionErrorSchema.optional(),
  })
  .strict();

export type NativeBrowserResponse = z.infer<typeof NativeBrowserResponseSchema>;

export type BrowserProcess = {
  execute: (action: BrowserActionInput, signal: AbortSignal) => Promise<NativeBrowserResponse>;
  available: () => boolean;
  shutdown: () => Promise<void>;
};

export type BrowserProcessHostOptions = {
  workerPath: string;
  executablePath: string;
  profileRoot: string;
  runtimeExecutable?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export class BrowserProcessCancelledError extends Error {
  constructor() {
    super('Browser action was cancelled at the dedicated process boundary.');
    this.name = 'BrowserProcessCancelledError';
  }
}

export class PlaywrightBrowserProcessHost implements BrowserProcess {
  readonly #options: BrowserProcessHostOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #lines: Interface | undefined;
  #closed = false;

  constructor(options: BrowserProcessHostOptions) {
    this.#options = options;
  }

  available(): boolean {
    return (
      !this.#closed &&
      existsSync(this.#options.workerPath) &&
      existsSync(this.#options.executablePath)
    );
  }

  async execute(input: BrowserActionInput, signal: AbortSignal): Promise<NativeBrowserResponse> {
    const action = BrowserActionInputSchema.parse(input);
    if (signal.aborted) throw new BrowserProcessCancelledError();
    const result = await this.#send({ kind: 'execute', action }, signal, action.actionId);
    return NativeBrowserResponseSchema.parse(result);
  }

  async shutdown(): Promise<void> {
    const child = this.#child;
    if (child) {
      try {
        await this.#send({ kind: 'shutdown' }, new AbortController().signal);
      } catch {
        child.kill();
      }
    }
    this.#closed = true;
    this.#dispose(new Error('Browser process host shut down.'));
  }

  async #send(
    body: Record<string, unknown>,
    signal: AbortSignal,
    actionId?: string,
  ): Promise<unknown> {
    const child = this.#ensureChild();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (work: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        this.#pending.delete(requestId);
        work();
      };
      const abort = (): void => {
        if (actionId && this.#child?.stdin.writable) {
          this.#child.stdin.write(
            `${JSON.stringify({ kind: 'cancel', requestId: randomUUID(), actionId })}\n`,
          );
        }
        finish(() => reject(new BrowserProcessCancelledError()));
      };
      signal.addEventListener('abort', abort, { once: true });
      this.#pending.set(requestId, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      child.stdin.write(`${JSON.stringify({ ...body, requestId })}\n`, (error) => {
        if (error) finish(() => reject(error));
      });
    });
  }

  #ensureChild(): ChildProcessWithoutNullStreams {
    if (this.#closed || !this.available()) {
      throw new Error('The isolated browser process is unavailable.');
    }
    if (this.#child && this.#child.exitCode === null) return this.#child;
    const child = spawn(
      this.#options.runtimeExecutable ?? process.execPath,
      [this.#options.workerPath],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          JUPITER_BROWSER_EXECUTABLE: this.#options.executablePath,
          JUPITER_BROWSER_PROFILE_ROOT: this.#options.profileRoot,
        },
      },
    );
    this.#child = child;
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#lines.on('line', (line) => this.#handleLine(line));
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => this.#dispose(error));
    child.on('exit', (code) => {
      this.#dispose(
        new Error(
          `The isolated browser process exited with code ${String(code)}. ${sanitize(stderr)}`,
        ),
      );
    });
    return child;
  }

  #handleLine(line: string): void {
    let envelope: z.infer<typeof WorkerEnvelopeSchema>;
    try {
      envelope = WorkerEnvelopeSchema.parse(JSON.parse(line));
    } catch {
      this.#dispose(new Error('The isolated browser process returned an invalid response.'));
      return;
    }
    const pending = this.#pending.get(envelope.requestId);
    if (!pending) return;
    if (envelope.error) pending.reject(new Error(envelope.error.message));
    else if (envelope.result) pending.resolve(envelope.result);
    else if (envelope.shutdown) pending.resolve({ shutdown: true });
    else pending.reject(new Error('The isolated browser response was incomplete.'));
  }

  #dispose(error: Error): void {
    const child = this.#child;
    this.#lines?.close();
    this.#lines = undefined;
    this.#child = undefined;
    if (child?.exitCode === null) child.kill();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function sanitize(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:[A-Za-z]:\\|\/)[^ ]+/g, '[path]')
    .trim()
    .slice(0, 300);
}

export function findWindowsBrowserExecutable(): string | undefined {
  const configured = process.env.JUPITER_BROWSER_EXECUTABLE;
  const candidates = [
    configured,
    process.env['PROGRAMFILES(X86)']
      ? join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : undefined,
    process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : undefined,
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : undefined,
  ];
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate)),
  );
}
