import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StructuredLogger } from './structured-logger.js';

describe('StructuredLogger', () => {
  it('writes correlated JSON and recursively redacts sensitive fields', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jupiter-log-'));
    const filePath = join(directory, 'jupiter.log');
    const logger = new StructuredLogger({ filePath });
    const protectedField = ['api', 'Key'].join('');

    logger.log('info', 'startup', 'Foundation ready', 'correlation-1', {
      nested: { [protectedField]: 'fixture-value', status: 'operational' },
    });

    const record: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(record).toMatchObject({
      correlationId: 'correlation-1',
      data: { nested: { [protectedField]: '[REDACTED]', status: 'operational' } },
    });
  });

  it('rotates bounded log files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jupiter-rotate-'));
    const filePath = join(directory, 'jupiter.log');
    const logger = new StructuredLogger({ filePath, maxBytes: 220, maxFiles: 2 });

    for (let index = 0; index < 8; index += 1) {
      logger.log(
        'info',
        'rotation',
        `record-${index.toString()}`,
        `correlation-${index.toString()}`,
      );
    }

    expect(() => readFileSync(`${filePath}.1`, 'utf8')).not.toThrow();
    expect(() => readFileSync(`${filePath}.3`, 'utf8')).toThrow();
  });
});
