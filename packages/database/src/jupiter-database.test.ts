import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';
import { JupiterDatabase } from './jupiter-database.js';

const temporaryDirectories: string[] = [];

function createDatabasePath(name = 'jupiter.db'): string {
  const directory = mkdtempSync(join(tmpdir(), 'jupiter-database-'));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('JupiterDatabase', () => {
  it('migrates a new database with durable safety pragmas', () => {
    const database = JupiterDatabase.open(createDatabasePath());
    const diagnostics = database.inspect();

    expect(diagnostics).toMatchObject({
      status: 'operational',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      journalMode: 'wal',
      foreignKeysEnabled: true,
      integrity: 'ok',
    });
    database.close();
  });

  it('upgrades a previous schema fixture without losing settings', () => {
    const databasePath = createDatabasePath();
    const previous = JupiterDatabase.open(databasePath, { targetVersion: 1 });
    previous.setSetting('fixture.version', 1);
    expect(previous.inspect().schemaVersion).toBe(1);
    previous.close();

    const current = JupiterDatabase.open(databasePath);
    expect(current.inspect().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(current.getSetting('fixture.version')).toBe(1);
    current.close();
  });

  it('rolls back an interrupted transaction and remains healthy', () => {
    const database = JupiterDatabase.open(createDatabasePath());

    expect(() =>
      database.transaction(() => {
        database.setSetting('transaction.fixture', { state: 'partial' });
        throw new Error('simulated interruption');
      }),
    ).toThrow('simulated interruption');

    expect(database.getSetting('transaction.fixture')).toBeUndefined();
    expect(database.inspect().integrity).toBe('ok');
    database.close();
  });

  it('preserves per-mission order and cursor replay without duplicates', () => {
    const database = JupiterDatabase.open(createDatabasePath());
    const missionId = randomUUID();
    const correlationId = randomUUID();
    const occurredAt = new Date().toISOString();

    const first = database.append({
      type: 'mission.test.first',
      missionId,
      correlationId,
      actor: 'test',
      source: 'database-test',
      payload: { ordinal: 1 },
      occurredAt,
    });
    const second = database.append({
      type: 'mission.test.second',
      missionId,
      correlationId,
      actor: 'test',
      source: 'database-test',
      payload: { ordinal: 2 },
      occurredAt,
    });

    expect([first.streamSequence, second.streamSequence]).toEqual([1, 2]);
    expect(database.listAfter(0, 100).map((event) => event.eventId)).toEqual([
      first.eventId,
      second.eventId,
    ]);
    expect(database.listAfter(first.sequence, 100).map((event) => event.eventId)).toEqual([
      second.eventId,
    ]);
    database.close();
  });

  it('creates a readable online backup through the database backup hook', async () => {
    const databasePath = createDatabasePath();
    const backupPath = join(dirname(databasePath), 'backup', 'jupiter-backup.db');
    const database = JupiterDatabase.open(databasePath);
    database.append({
      type: 'backup.fixture',
      correlationId: randomUUID(),
      actor: 'test',
      source: 'database-test',
      payload: { persisted: true },
      occurredAt: new Date().toISOString(),
    });

    await database.backupTo(backupPath);
    database.close();

    const restored = JupiterDatabase.open(backupPath);
    expect(restored.inspect()).toMatchObject({ integrity: 'ok', eventCount: 1 });
    expect(restored.listAfter(0, 10)[0]?.type).toBe('backup.fixture');
    restored.close();
  });
});
