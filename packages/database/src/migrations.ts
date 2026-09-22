import type { DatabaseSync } from 'node:sqlite';

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_core_tables',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        mission_id TEXT,
        stream_sequence INTEGER NOT NULL,
        correlation_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE (mission_id, stream_sequence)
      ) STRICT;

      CREATE TABLE audit_log (
        audit_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        capability TEXT NOT NULL,
        target TEXT NOT NULL,
        decision TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        mission_id TEXT,
        execution_id TEXT,
        timestamp TEXT NOT NULL,
        metadata_redacted_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE service_health (
        service_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        version TEXT NOT NULL,
        last_check TEXT NOT NULL,
        latency_ms REAL,
        capabilities_json TEXT NOT NULL,
        sanitized_error TEXT
      ) STRICT;

      CREATE INDEX events_mission_order_idx ON events (mission_id, stream_sequence);
      CREATE INDEX events_correlation_idx ON events (correlation_id);
      CREATE INDEX audit_timestamp_idx ON audit_log (timestamp);
    `,
  },
  {
    version: 2,
    name: 'event_source_and_replay_index',
    sql: `
      ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'core';
      CREATE INDEX events_replay_idx ON events (sequence, occurred_at);
    `,
  },
] as const;

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function migrate(database: DatabaseSync, targetVersion = CURRENT_SCHEMA_VERSION): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const row = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as Record<string, unknown>;
  let current = Number(row.version ?? 0);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current || migration.version > targetVersion) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
      current = migration.version;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return current;
}
