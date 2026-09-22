import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProgressEventSchema, RpcRequestEnvelopeSchema } from './index.js';

describe('versioned IPC contracts', () => {
  it('accepts a known request and rejects unknown channels and extra fields', () => {
    const valid = {
      schemaVersion: 1,
      kind: 'query',
      name: 'core.ping',
      context: {
        requestId: randomUUID(),
        actor: 'renderer',
        timestamp: new Date().toISOString(),
      },
      payload: {},
    };

    expect(RpcRequestEnvelopeSchema.safeParse(valid).success).toBe(true);
    expect(RpcRequestEnvelopeSchema.safeParse({ ...valid, name: 'shell.execute' }).success).toBe(
      false,
    );
    expect(RpcRequestEnvelopeSchema.safeParse({ ...valid, executable: 'cmd.exe' }).success).toBe(
      false,
    );
  });

  it('only permits measurable progress values', () => {
    const progress = {
      schemaVersion: 1,
      eventId: randomUUID(),
      requestId: randomUUID(),
      status: 'progress',
      completedUnits: 2,
      message: 'Working',
      timestamp: new Date().toISOString(),
    };

    expect(ProgressEventSchema.safeParse(progress).success).toBe(false);
    expect(ProgressEventSchema.safeParse({ ...progress, totalUnits: 4 }).success).toBe(true);
    expect(ProgressEventSchema.safeParse({ ...progress, totalUnits: 1 }).success).toBe(false);
  });
});
