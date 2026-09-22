import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogData = Readonly<Record<string, unknown>>;

export type StructuredLoggerOptions = {
  filePath: string;
  maxBytes?: number;
  maxFiles?: number;
  clock?: () => Date;
};

const sensitiveKey =
  /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|biometric|audio|prompt|document|screenshot)/iu;
const sensitiveValue = /(?:bearer\s+[^\s]+|[?&](?:token|key|secret|password)=[^&\s]+)/giu;

export function redactSensitive(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(sensitiveValue, '[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitive(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export class StructuredLogger {
  readonly #filePath: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #clock: () => Date;

  constructor(options: StructuredLoggerOptions) {
    this.#filePath = options.filePath;
    this.#maxBytes = options.maxBytes ?? 2_000_000;
    this.#maxFiles = options.maxFiles ?? 5;
    this.#clock = options.clock ?? (() => new Date());
    mkdirSync(dirname(this.#filePath), { recursive: true });
  }

  log(
    level: LogLevel,
    event: string,
    message: string,
    correlationId: string,
    data: LogData = {},
  ): void {
    const record = {
      timestamp: this.#clock().toISOString(),
      level,
      event,
      message: redactSensitive(message),
      correlationId,
      data: redactSensitive(data),
    };
    const line = `${JSON.stringify(record)}\n`;
    this.#rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(this.#filePath, line, { encoding: 'utf8', mode: 0o600 });
  }

  #rotateIfNeeded(incomingBytes: number): void {
    const currentBytes = existsSync(this.#filePath) ? statSync(this.#filePath).size : 0;
    if (currentBytes + incomingBytes <= this.#maxBytes) return;

    const oldest = `${this.#filePath}.${this.#maxFiles.toString()}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = this.#maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.#filePath}.${index.toString()}`;
      if (existsSync(source)) renameSync(source, `${this.#filePath}.${(index + 1).toString()}`);
    }
    if (existsSync(this.#filePath)) renameSync(this.#filePath, `${this.#filePath}.1`);
  }
}
