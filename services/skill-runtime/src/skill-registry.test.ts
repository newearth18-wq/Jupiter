import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@jupiter/contracts';
import type { SkillExecutable } from '@jupiter/core';
import { JupiterDatabase } from '@jupiter/database';
import { createInternalSkills } from './internal-skills.js';
import { ExecutableSkillRegistry } from './skill-registry.js';

const directories: string[] = [];
const databases: JupiterDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('ExecutableSkillRegistry', () => {
  it('registers valid Skills and rejects invalid definitions', () => {
    const fixture = registryFixture();
    const registered = fixture.registry.register(
      skill('test.valid', () => Promise.resolve({ output: {} })),
    );
    expect(registered.definition.skillId).toBe('test.valid');
    expect(fixture.registry.get({ skillId: 'test.valid' })).toBeTruthy();
    expect(() =>
      fixture.registry.register({
        ...skill('bad id', () => Promise.resolve({ output: {} })),
      }),
    ).toThrow();
    fixture.registry.register(
      skill('test.valid', () => Promise.resolve({ output: {} }), { version: '2.0.0' }),
    );
    expect(
      fixture.registry.listVersions('test.valid').map((entry) => entry.definition.version),
    ).toEqual(['2.0.0', '1.0.0']);
    expect(fixture.registry.search({ query: 'test.valid' })).toHaveLength(1);
    expect(fixture.registry.search({ query: 'test.valid' })[0]?.definition.version).toBe('2.0.0');
    expect(fixture.registry.unregister('test.valid', '1.0.0')).toBe(true);
  });

  it('executes echo_text with exact output and stores metadata without values', async () => {
    const fixture = registryFixture(true);
    const secretLikeText = 'exact private text';
    const result = await fixture.registry.invoke(
      invocation('echo_text', { text: secretLikeText }),
      new AbortController().signal,
    );
    expect(result.status).toBe('SUCCESS');
    expect(result.output).toEqual({ text: secretLikeText });
    const history = fixture.registry.listExecutions('echo_text');
    expect(history[0]?.inputMetadata).toEqual({ type: 'object', keys: ['text'] });
    expect(JSON.stringify(history)).not.toContain(secretLikeText);
    fixture.database.close();
    const reopened = JupiterDatabase.open(fixture.path);
    databases.push(reopened);
    expect(reopened.getSkill('echo_text')?.definition.version).toBe('1.0.0');
    expect(reopened.listSkillExecutions('echo_text')[0]?.status).toBe('SUCCESS');
    expect(JSON.stringify(reopened.listSkillExecutions('echo_text'))).not.toContain(secretLikeText);
  });

  it('handles timeout and cancellation with structured terminal results', async () => {
    const fixture = registryFixture();
    fixture.registry.register(
      skill(
        'test.slow',
        (_input, context) =>
          new Promise((_resolve, reject) =>
            context.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            }),
          ),
        { timeoutMs: 20 },
      ),
    );
    await fixture.registry.healthCheck('test.slow', new AbortController().signal);
    const timedOut = await fixture.registry.invoke(
      invocation('test.slow', {}, { timeoutMs: 20 }),
      new AbortController().signal,
    );
    expect(timedOut.status).toBe('TIMEOUT');

    const executionId = randomUUID();
    const running = fixture.registry.invoke(
      invocation('test.slow', {}, { executionId, timeoutMs: 1_000 }),
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fixture.registry.cancel(executionId)).toBe(true);
    expect((await running).status).toBe('CANCELLED');

    let calledAfterCancellation = false;
    fixture.registry.register(
      skill('test.pre-cancelled', () => {
        calledAfterCancellation = true;
        return Promise.resolve({ output: {} });
      }),
    );
    await fixture.registry.healthCheck('test.pre-cancelled', new AbortController().signal);
    const cancelledController = new AbortController();
    cancelledController.abort();
    const preCancelled = await fixture.registry.invoke(
      invocation('test.pre-cancelled', {}),
      cancelledController.signal,
    );
    expect(preCancelled.status).toBe('CANCELLED');
    expect(calledAfterCancellation).toBe(false);
  });

  it('blocks disabled Skills and permission mismatch before execution', async () => {
    const fixture = registryFixture();
    let called = 0;
    fixture.registry.register(
      skill(
        'test.protected',
        () => {
          called += 1;
          return Promise.resolve({ output: {} });
        },
        { permissions: ['files.read'] },
      ),
    );
    await fixture.registry.healthCheck('test.protected', new AbortController().signal);
    fixture.registry.disable('test.protected');
    await expect(
      fixture.registry.invoke(
        invocation('test.protected', {}, { permissions: ['files.read'] }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Disabled Skill');
    fixture.registry.enable('test.protected');
    await expect(
      fixture.registry.invoke(
        invocation('test.protected', {}, { permissions: ['files.write'] }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('permissions');
    expect(called).toBe(0);
  });

  it('contains broken Skills and converts invalid output into failure', async () => {
    const fixture = registryFixture(true);
    fixture.registry.register(
      skill('test.broken', () => Promise.reject(new Error('private execution detail'))),
    );
    fixture.registry.register(
      skill('test.invalid-output', () => Promise.resolve({ output: { unexpected: true } })),
    );
    await fixture.registry.healthCheck('test.broken', new AbortController().signal);
    await fixture.registry.healthCheck('test.invalid-output', new AbortController().signal);
    const broken = await fixture.registry.invoke(
      invocation('test.broken', {}),
      new AbortController().signal,
    );
    const invalid = await fixture.registry.invoke(
      invocation('test.invalid-output', {}),
      new AbortController().signal,
    );
    expect(broken).toMatchObject({ status: 'FAILED', error: { code: 'SKILL_EXECUTION_FAILED' } });
    expect(JSON.stringify(broken)).not.toContain('private execution detail');
    expect(JSON.stringify(fixture.registry.listExecutions('test.broken'))).not.toContain(
      'private execution detail',
    );
    expect(invalid.status).toBe('FAILED');
    const echo = await fixture.registry.invoke(
      invocation('echo_text', { text: 'Core is still alive.' }),
      new AbortController().signal,
    );
    expect(echo.status).toBe('SUCCESS');
  });

  it('reports health accurately and lists all required internal Skills', () => {
    const fixture = registryFixture(true);
    const entries = fixture.registry.search({ query: '' });
    expect(entries.map((entry) => entry.definition.skillId).sort()).toEqual([
      'echo_text',
      'get_app_version',
      'get_system_time',
      'list_available_skills',
    ]);
    expect(entries.every((entry) => entry.health === 'HEALTHY' && entry.lastCheckedAt)).toBe(true);
  });
});

function registryFixture(internal = false) {
  const directory = mkdtempSync(join(tmpdir(), 'jupiter-skills-'));
  directories.push(directory);
  const database = JupiterDatabase.open(join(directory, 'jupiter.db'));
  databases.push(database);
  const registry = new ExecutableSkillRegistry({ repository: database, runtimeVersion: '0.1.0' });
  if (internal) {
    for (const executable of createInternalSkills('0.1.0', () => registry.search({ query: '' }))) {
      registry.register(executable);
    }
    for (const entry of registry.search({ query: '' })) {
      database.upsertSkill({
        ...entry,
        health: 'HEALTHY',
        lastCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return { database, registry, path: join(directory, 'jupiter.db') };
}

function skill(
  skillId: string,
  execute: SkillExecutable['execute'],
  update: Partial<SkillDefinition> = {},
): SkillExecutable {
  return {
    definition: {
      skillId,
      name: skillId,
      description: `Execute ${skillId}.`,
      version: '1.0.0',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      permissions: [],
      timeoutMs: 1_000,
      category: 'test',
      provider: 'Test',
      compatibleRuntime: 'jupiter-core@0.1.0',
      ...update,
    },
    execute,
  };
}

function invocation(
  skillId: string,
  input: unknown,
  update: Partial<Parameters<ExecutableSkillRegistry['invoke']>[0]> = {},
) {
  return {
    executionId: randomUUID(),
    skillId,
    missionId: randomUUID(),
    input,
    permissions: [],
    timeoutMs: 1_000,
    idempotencyKey: randomUUID(),
    ...update,
  };
}
