import { randomUUID } from 'node:crypto';
import type { AuditEvent, CorrelationContext } from '@jupiter/contracts';
import { describe, expect, it } from 'vitest';
import { CapabilityDispatcher } from '../capabilities/capability-dispatcher.js';
import type { AuditRepository } from '../ports.js';
import { RpcGateway } from './rpc-gateway.js';

class MemoryAuditRepository implements AuditRepository {
  readonly events: AuditEvent[] = [];

  appendAudit(event: AuditEvent): void {
    this.events.push(event);
  }
}

function context(actor: CorrelationContext['actor'] = 'renderer'): CorrelationContext {
  return {
    requestId: randomUUID(),
    actor,
    timestamp: new Date().toISOString(),
  };
}

describe('RpcGateway', () => {
  it('returns a correlated response for a valid typed request', async () => {
    const dispatcher = new CapabilityDispatcher();
    dispatcher.register({
      capability: 'core.ping',
      allowedActors: ['renderer'],
      handler: () => ({
        message: 'pong',
        coreVersion: 'test',
        receivedAt: new Date().toISOString(),
      }),
    });
    const audit = new MemoryAuditRepository();
    const gateway = new RpcGateway(dispatcher, audit);
    const correlation = context();

    const response = await gateway.handle(
      {
        schemaVersion: 1,
        kind: 'query',
        name: 'core.ping',
        context: correlation,
        payload: {},
      },
      'renderer',
      new AbortController().signal,
    );

    expect(response.status).toBe('success');
    expect(response.requestId).toBe(correlation.requestId);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.decision).toBe('allow');
  });

  it('rejects malformed and unknown requests before dispatch', async () => {
    const gateway = new RpcGateway(new CapabilityDispatcher(), new MemoryAuditRepository());
    const response = await gateway.handle(
      { name: 'unsafe.execute', payload: { command: 'whoami' } },
      'renderer',
      new AbortController().signal,
    );

    expect(response.status).toBe('error');
    if (response.status === 'error') {
      expect(response.error.category).toBe('validation');
      expect(response.error.code).toBe('INVALID_RPC_REQUEST');
    }
  });

  it('denies a renderer that claims a different actor', async () => {
    const audit = new MemoryAuditRepository();
    const gateway = new RpcGateway(new CapabilityDispatcher(), audit);
    const response = await gateway.handle(
      {
        schemaVersion: 1,
        kind: 'query',
        name: 'core.ping',
        context: context('core'),
        payload: {},
      },
      'renderer',
      new AbortController().signal,
    );

    expect(response.status).toBe('error');
    if (response.status === 'error') expect(response.error.category).toBe('permission');
    expect(audit.events[0]?.decision).toBe('deny');
  });
});
