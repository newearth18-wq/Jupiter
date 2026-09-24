import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import {
  ComputerActionErrorSchema,
  ComputerActionInputSchema,
  ComputerActionOutputSchema,
  ComputerInteractionModeSchema,
  type ComputerActionInput,
} from '@jupiter/contracts';

const NativeEvidenceSchema = z
  .object({
    kind: z.enum(['file', 'screenshot']),
    path: z.string().min(1).max(32_767),
    mediaType: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    verified: z.boolean(),
  })
  .strict();

export const NativeAutomationResponseSchema = z
  .object({
    success: z.boolean(),
    observation: z.string().trim().min(1).max(1_000),
    interactionMode: ComputerInteractionModeSchema,
    output: ComputerActionOutputSchema.optional(),
    evidence: z.array(NativeEvidenceSchema).max(10).default([]),
    error: ComputerActionErrorSchema.optional(),
  })
  .strict();

export type NativeAutomationResponse = z.infer<typeof NativeAutomationResponseSchema>;

export type AutomationProcessHost = {
  execute: (action: ComputerActionInput, signal: AbortSignal) => Promise<NativeAutomationResponse>;
};

export class AutomationHostCancelledError extends Error {
  constructor() {
    super('Windows automation was cancelled at the process boundary.');
    this.name = 'AutomationHostCancelledError';
  }
}

export class PowerShellAutomationProcessHost implements AutomationProcessHost {
  readonly #scriptPath: string;

  constructor(scriptPath: string) {
    this.#scriptPath = scriptPath;
  }

  execute(action: ComputerActionInput, signal: AbortSignal): Promise<NativeAutomationResponse> {
    const valid = ComputerActionInputSchema.parse(action);
    if (signal.aborted) return Promise.reject(new AutomationHostCancelledError());
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-Sta',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.#scriptPath,
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.#observe(child, valid, signal, resolve, reject);
    });
  }

  #observe(
    child: ChildProcessWithoutNullStreams,
    action: ComputerActionInput,
    signal: AbortSignal,
    resolve: (value: NativeAutomationResponse) => void,
    reject: (reason: Error) => void,
  ): void {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (work: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      work();
    };
    const abort = (): void => {
      child.kill();
      finish(() => reject(new AutomationHostCancelledError()));
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 4_000_000) child.kill();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code) => {
      finish(() => {
        if (signal.aborted) {
          reject(new AutomationHostCancelledError());
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `Automation host exited with code ${String(code)} for ${action.action}. ${sanitize(stderr)}`,
            ),
          );
          return;
        }
        try {
          resolve(NativeAutomationResponseSchema.parse(JSON.parse(stdout.trim())));
        } catch {
          reject(new Error('Automation host returned an invalid response.'));
        }
      });
    });
    child.stdin.end(`${JSON.stringify(action)}\n`, 'utf8');
  }
}

function sanitize(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 300);
}
