import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PermissionAuthorizationInput,
  PermissionCapability,
  PermissionRequestInput,
} from '@jupiter/contracts';
import { JupiterDatabase } from '@jupiter/database';
import { CapabilityPermissionEngine } from './permission-engine.js';

const directories: string[] = [];
const databases: JupiterDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('CapabilityPermissionEngine', () => {
  it('denies undeclared capabilities and plugin self-elevation', () => {
    const fixture = createFixture();
    expect(fixture.engine.authorize(authorization('shell.execute')).status).toBe('DENIED');
    fixture.engine.registerCapability(capability('shell.execute', 'CRITICAL', ['PLUGIN']));
    const denied = fixture.engine.request(
      request('shell.execute', {
        requester: {
          actor: 'service',
          type: 'PLUGIN',
          id: 'plugin.untrusted',
          display: 'Untrusted plugin',
          declaredCapabilities: [],
        },
      }),
    );
    expect(denied.status).toBe('DENIED');
    expect(denied.availableDecisions).toEqual([]);
  });

  it('persists DENY and consumes ALLOW_ONCE exactly once', () => {
    const fixture = createFixture();
    fixture.engine.registerCapability(capability('files.write', 'HIGH'));
    const deniedRequest = fixture.engine.request(request('files.write'));
    fixture.engine.resolve(
      { requestId: deniedRequest.requestId, decision: 'DENY' },
      'USER_EXPLICIT',
    );
    expect(fixture.engine.authorize(authorization('files.write')).status).toBe('DENIED');

    fixture.engine.registerCapability(capability('email.send', 'HIGH'));
    const onceRequest = fixture.engine.request(request('email.send'));
    fixture.engine.resolve(
      { requestId: onceRequest.requestId, decision: 'ALLOW_ONCE' },
      'USER_EXPLICIT',
    );
    expect(fixture.engine.authorize(authorization('email.send')).status).toBe('ALLOWED');
    expect(fixture.engine.authorize(authorization('email.send')).status).toBe('PROMPT');
  });

  it('expires session grants across a runtime restart', async () => {
    const fixture = createFixture();
    fixture.engine.registerCapability(capability('memory.read', 'MEDIUM'));
    const pending = fixture.engine.request(request('memory.read'));
    fixture.engine.resolve(
      { requestId: pending.requestId, decision: 'ALLOW_SESSION' },
      'USER_EXPLICIT',
    );
    expect(fixture.engine.authorize(authorization('memory.read')).status).toBe('ALLOWED');
    await fixture.engine.shutdown();

    const restarted = new CapabilityPermissionEngine({ repository: fixture.database });
    restarted.registerCapability(capability('memory.read', 'MEDIUM'));
    expect(restarted.authorize(authorization('memory.read')).status).toBe('PROMPT');
    expect(fixture.database.listPermissionGrants()).toHaveLength(0);
  });

  it('requires explicit per-execution confirmation for CRITICAL actions', () => {
    const fixture = createFixture();
    fixture.engine.registerCapability(capability('credentials.modify', 'CRITICAL'));
    const pending = fixture.engine.request(request('credentials.modify'));
    expect(pending.availableDecisions).toEqual(['ALLOW_ONCE', 'DENY']);
    expect(() =>
      fixture.engine.resolve(
        { requestId: pending.requestId, decision: 'ALWAYS_ALLOW' },
        'USER_EXPLICIT',
      ),
    ).toThrow('unavailable');
    expect(() =>
      fixture.engine.resolve(
        { requestId: pending.requestId, decision: 'ALLOW_ONCE' },
        'TRUSTED_POLICY',
      ),
    ).toThrow('explicit user');
    fixture.engine.resolve(
      { requestId: pending.requestId, decision: 'ALLOW_ONCE' },
      'USER_EXPLICIT',
    );
    expect(fixture.engine.authorize(authorization('credentials.modify')).status).toBe('ALLOWED');
    expect(fixture.engine.authorize(authorization('credentials.modify')).status).toBe('PROMPT');
  });

  it('revokes persisted grants and rejects target mismatches', () => {
    const fixture = createFixture();
    fixture.engine.registerCapability(capability('files.read', 'MEDIUM'));
    const pending = fixture.engine.request(request('files.read'));
    const resolved = fixture.engine.resolve(
      { requestId: pending.requestId, decision: 'ALWAYS_ALLOW' },
      'USER_EXPLICIT',
    );
    expect(fixture.engine.authorize(authorization('files.read')).status).toBe('ALLOWED');
    expect(
      fixture.engine.authorize(authorization('files.read', { targetId: 'file:other' })).status,
    ).toBe('PROMPT');
    expect(fixture.engine.revoke(resolved.grant?.grantId ?? '', 'renderer')).toBe(true);
    expect(fixture.engine.authorize(authorization('files.read')).status).toBe('PROMPT');
  });

  it('prevents external content from granting policy and keeps sanitized audit evidence', () => {
    const fixture = createFixture();
    fixture.engine.registerCapability(capability('browser.submit_form', 'HIGH'));
    const target = 'https://private.example/account/secret-name';
    const pending = fixture.engine.request(
      request('browser.submit_form', {
        target: { type: 'url', id: target, display: 'Private account page' },
      }),
    );
    const external = fixture.engine.request(
      request('browser.submit_form', {
        trustSource: 'EXTERNAL_CONTENT',
        target: { type: 'url', id: target, display: 'Private account page' },
      }),
    );
    expect(external.status).toBe('DENIED');
    expect(external.requestId).not.toBe(pending.requestId);
    expect(() =>
      fixture.engine.resolve(
        { requestId: pending.requestId, decision: 'ALLOW_ONCE' },
        'EXTERNAL_CONTENT',
      ),
    ).toThrow('Untrusted content');
    const audits = fixture.engine.listAudits(100);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audits)).not.toContain(target);
    expect(audits.every((audit) => audit.targetFingerprint.length === 64)).toBe(true);
  });
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jupiter-permissions-'));
  directories.push(directory);
  const database = JupiterDatabase.open(join(directory, 'jupiter.db'));
  databases.push(database);
  return { database, engine: new CapabilityPermissionEngine({ repository: database }) };
}

function capability(
  name: string,
  risk: PermissionCapability['risk'],
  allowedRequesterTypes: PermissionCapability['allowedRequesterTypes'] = ['UI'],
): PermissionCapability {
  return {
    capability: name,
    name,
    description: `Controls ${name}.`,
    risk,
    allowedRequesterTypes,
    automationAllowed: false,
    available: true,
  };
}

function request(
  capabilityName: string,
  update: Partial<PermissionRequestInput> = {},
): PermissionRequestInput {
  return {
    capability: capabilityName,
    action: `Use ${capabilityName}.`,
    reason: 'The user explicitly requested this action.',
    target: { type: 'file', id: 'file:approved', display: 'Approved file' },
    scope: { type: 'operation', id: 'single-target', display: 'This target only' },
    requester: {
      actor: 'renderer',
      type: 'UI',
      id: 'test-ui',
      display: 'Test UI',
      declaredCapabilities: [capabilityName],
    },
    trustSource: 'USER_INTENT',
    dataLeavingDevice: { value: false, description: 'No data leaves this device.' },
    consequence: 'The exact requested target may change.',
    reversible: true,
    automated: false,
    constraints: { operation: 'test' },
    ...update,
  };
}

function authorization(
  capabilityName: string,
  update: Partial<PermissionAuthorizationInput> = {},
): PermissionAuthorizationInput {
  return {
    capability: capabilityName,
    actor: 'renderer',
    requesterType: 'UI',
    requesterId: 'test-ui',
    declaredCapabilities: [capabilityName],
    targetId: 'file:approved',
    scopeId: 'single-target',
    constraints: { operation: 'test' },
    automated: false,
    ...update,
  };
}
