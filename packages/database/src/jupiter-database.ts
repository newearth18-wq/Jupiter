import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  AuditEventSchema,
  CONTRACT_SCHEMA_VERSION,
  CoreServiceHealthSchema,
  DatabaseDiagnosticsSchema,
  DomainEventSchema,
  type AuditEvent,
  type CoreServiceHealth,
  type DatabaseDiagnostics,
  type DomainEvent,
} from '@jupiter/contracts';
import type {
  AuditRepository,
  DiagnosticsRepository,
  DomainEventDraft,
  EventStore,
  ServiceHealthRepository,
} from '@jupiter/core';
import { CURRENT_SCHEMA_VERSION, migrate } from './migrations.js';

type OpenOptions = {
  targetVersion?: number;
};

type EventRow = {
  sequence: number | bigint;
  event_id: string;
  type: string;
  mission_id: string | null;
  stream_sequence: number | bigint;
  correlation_id: string;
  actor: string;
  source: string;
  payload_json: string;
  occurred_at: string;
};

export class JupiterDatabase
  implements EventStore, AuditRepository, ServiceHealthRepository, DiagnosticsRepository
{
  readonly #database: DatabaseSync;
  readonly #filePath: string;
  #closed = false;

  private constructor(database: DatabaseSync, filePath: string) {
    this.#database = database;
    this.#filePath = filePath;
  }

  static open(filePath: string, options: OpenOptions = {}): JupiterDatabase {
    const absolutePath = resolve(filePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    const database = new DatabaseSync(absolutePath, {
      allowExtension: false,
      timeout: 5_000,
    });
    try {
      database.exec('PRAGMA foreign_keys = ON;');
      database.exec('PRAGMA journal_mode = WAL;');
      database.exec('PRAGMA synchronous = FULL;');
      database.exec('PRAGMA busy_timeout = 5000;');
      migrate(database, options.targetVersion ?? CURRENT_SCHEMA_VERSION);
      return new JupiterDatabase(database, absolutePath);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  append(draft: DomainEventDraft): DomainEvent {
    return this.transaction(() => {
      const streamRow = this.#database
        .prepare(
          `SELECT COALESCE(MAX(stream_sequence), 0) AS stream_sequence
             FROM events
            WHERE (mission_id = ? OR (mission_id IS NULL AND ? IS NULL))`,
        )
        .get(draft.missionId ?? null, draft.missionId ?? null) as Record<string, unknown>;
      const streamSequence = Number(streamRow.stream_sequence ?? 0) + 1;
      const eventId = randomUUID();
      const result = this.#database
        .prepare(
          `INSERT INTO events (
             event_id, type, mission_id, stream_sequence, correlation_id,
             actor, source, payload_json, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          draft.type,
          draft.missionId ?? null,
          streamSequence,
          draft.correlationId,
          draft.actor,
          draft.source,
          JSON.stringify(draft.payload),
          draft.occurredAt,
        );

      return DomainEventSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        eventId,
        sequence: Number(result.lastInsertRowid),
        streamSequence,
        type: draft.type,
        ...(draft.missionId === undefined ? {} : { missionId: draft.missionId }),
        correlationId: draft.correlationId,
        actor: draft.actor,
        source: draft.source,
        payload: draft.payload,
        occurredAt: draft.occurredAt,
      });
    });
  }

  listAfter(afterSequence: number, limit: number): DomainEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT sequence, event_id, type, mission_id, stream_sequence,
                correlation_id, actor, source, payload_json, occurred_at
           FROM events
          WHERE sequence > ?
          ORDER BY sequence ASC
          LIMIT ?`,
      )
      .all(afterSequence, limit) as unknown as EventRow[];
    return rows.map((row) => this.#parseEvent(row));
  }

  appendAudit(event: AuditEvent): void {
    const valid = AuditEventSchema.parse(event);
    this.#database
      .prepare(
        `INSERT INTO audit_log (
           audit_id, event_type, actor, capability, target, decision,
           risk_level, mission_id, execution_id, timestamp, metadata_redacted_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.auditId,
        valid.eventType,
        valid.actor,
        valid.capability,
        valid.target,
        valid.decision,
        valid.riskLevel,
        valid.missionId ?? null,
        valid.executionId ?? null,
        valid.timestamp,
        JSON.stringify(valid.metadataRedacted),
      );
  }

  upsert(health: CoreServiceHealth): void {
    const valid = CoreServiceHealthSchema.parse(health);
    this.#database
      .prepare(
        `INSERT INTO service_health (
           service_id, status, version, last_check, latency_ms,
           capabilities_json, sanitized_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service_id) DO UPDATE SET
           status = excluded.status,
           version = excluded.version,
           last_check = excluded.last_check,
           latency_ms = excluded.latency_ms,
           capabilities_json = excluded.capabilities_json,
           sanitized_error = excluded.sanitized_error`,
      )
      .run(
        valid.serviceId,
        valid.status,
        valid.version,
        valid.lastCheck,
        valid.latencyMs ?? null,
        JSON.stringify(valid.capabilities),
        valid.sanitizedError ?? null,
      );
  }

  list(): CoreServiceHealth[] {
    const rows = this.#database
      .prepare(
        `SELECT service_id, status, version, last_check, latency_ms,
                capabilities_json, sanitized_error
           FROM service_health
          ORDER BY service_id ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) =>
      CoreServiceHealthSchema.parse({
        serviceId: row.service_id,
        status: row.status,
        version: row.version,
        lastCheck: row.last_check,
        ...(row.latency_ms === null ? {} : { latencyMs: Number(row.latency_ms) }),
        capabilities: this.#parseJson(row.capabilities_json),
        ...(row.sanitized_error === null ? {} : { sanitizedError: row.sanitized_error }),
      }),
    );
  }

  inspect(): DatabaseDiagnostics {
    const migration = this.#database
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as Record<string, unknown>;
    const journal = this.#database.prepare('PRAGMA journal_mode').get() as Record<string, unknown>;
    const foreignKeys = this.#database.prepare('PRAGMA foreign_keys').get() as Record<
      string,
      unknown
    >;
    const integrity = this.#database.prepare('PRAGMA integrity_check').get() as Record<
      string,
      unknown
    >;
    const eventCount = this.#database
      .prepare('SELECT COUNT(*) AS count FROM events')
      .get() as Record<string, unknown>;
    const auditCount = this.#database
      .prepare('SELECT COUNT(*) AS count FROM audit_log')
      .get() as Record<string, unknown>;
    const journalValue = Object.values(journal).at(0);
    const integrityValue = Object.values(integrity).at(0);

    return DatabaseDiagnosticsSchema.parse({
      status: integrityValue === 'ok' ? 'operational' : 'degraded',
      engine: 'SQLite',
      schemaVersion: Number(migration.version ?? 0),
      journalMode: typeof journalValue === 'string' ? journalValue : 'unknown',
      foreignKeysEnabled: Number(Object.values(foreignKeys).at(0) ?? 0) === 1,
      integrity: integrityValue === 'ok' ? 'ok' : 'failed',
      eventCount: Number(eventCount.count ?? 0),
      auditCount: Number(auditCount.count ?? 0),
      storageLabel: basename(this.#filePath),
    });
  }

  setSetting(key: string, value: unknown): void {
    if (key.length === 0) throw new Error('Setting key cannot be empty.');
    this.#database
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  getSetting(key: string): unknown {
    const row = this.#database.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#parseJson(row.value_json);
  }

  transaction<T>(work: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  async backupTo(destinationPath: string): Promise<void> {
    const absoluteDestination = resolve(destinationPath);
    mkdirSync(dirname(absoluteDestination), { recursive: true });
    await backup(this.#database, absoluteDestination);
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #parseEvent(row: EventRow): DomainEvent {
    return DomainEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      eventId: row.event_id,
      sequence: Number(row.sequence),
      streamSequence: Number(row.stream_sequence),
      type: row.type,
      ...(row.mission_id === null ? {} : { missionId: row.mission_id }),
      correlationId: row.correlation_id,
      actor: row.actor,
      source: row.source,
      payload: this.#parseJson(row.payload_json),
      occurredAt: row.occurred_at,
    });
  }

  #parseJson(value: unknown): unknown {
    if (typeof value !== 'string') throw new Error('Stored JSON value is invalid.');
    return JSON.parse(value) as unknown;
  }
}
