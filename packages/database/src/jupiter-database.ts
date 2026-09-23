import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  AiSettingsSchema,
  AuditEventSchema,
  ChatMessageSchema,
  CONTRACT_SCHEMA_VERSION,
  ConversationSchema,
  CoreServiceHealthSchema,
  DatabaseDiagnosticsSchema,
  DomainEventSchema,
  ModelDescriptorSchema,
  ProviderSummarySchema,
  type AiSettings,
  type AuditEvent,
  type CoreServiceHealth,
  type DatabaseDiagnostics,
  type DomainEvent,
  type ChatMessage,
  type Conversation,
  type ModelDescriptor,
  type ProviderSummary,
} from '@jupiter/contracts';
import type {
  AiRepository,
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
  implements
    EventStore,
    AuditRepository,
    ServiceHealthRepository,
    DiagnosticsRepository,
    AiRepository
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

  listProviders(): ProviderSummary[] {
    const rows = this.#database
      .prepare('SELECT * FROM ai_providers ORDER BY display_name ASC, provider_id ASC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.#parseProvider(row));
  }

  getProvider(providerId: string): ProviderSummary | undefined {
    const row = this.#database
      .prepare('SELECT * FROM ai_providers WHERE provider_id = ?')
      .get(providerId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#parseProvider(row);
  }

  upsertProvider(provider: ProviderSummary): void {
    const valid = ProviderSummarySchema.parse(provider);
    this.#database
      .prepare(
        `INSERT INTO ai_providers (
           provider_id, display_name, base_url, locality, auth_scheme, enabled,
           capabilities_json, auth_state, health, credential_fingerprint,
           last_validated_at, sanitized_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           display_name = excluded.display_name,
           base_url = excluded.base_url,
           locality = excluded.locality,
           auth_scheme = excluded.auth_scheme,
           enabled = excluded.enabled,
           capabilities_json = excluded.capabilities_json,
           auth_state = excluded.auth_state,
           health = excluded.health,
           credential_fingerprint = excluded.credential_fingerprint,
           last_validated_at = excluded.last_validated_at,
           sanitized_error = excluded.sanitized_error,
           updated_at = excluded.updated_at`,
      )
      .run(
        valid.providerId,
        valid.displayName,
        valid.baseUrl,
        valid.locality,
        valid.authScheme,
        valid.enabled ? 1 : 0,
        JSON.stringify(valid.capabilities),
        valid.authState,
        valid.health,
        valid.credentialFingerprint ?? null,
        valid.lastValidatedAt ?? null,
        valid.sanitizedError ?? null,
        valid.createdAt,
        valid.updatedAt,
      );
  }

  removeProvider(providerId: string): void {
    this.#database.prepare('DELETE FROM ai_providers WHERE provider_id = ?').run(providerId);
  }

  replaceModels(providerId: string, models: readonly ModelDescriptor[]): void {
    this.transaction(() => {
      this.#database.prepare('DELETE FROM ai_models WHERE provider_id = ?').run(providerId);
      const insert = this.#database.prepare(
        `INSERT INTO ai_models (
           provider_id, model_id, display_name, capabilities_json, context_window,
           input_cost_per_million, output_cost_per_million, discovered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const model of models) {
        const valid = ModelDescriptorSchema.parse(model);
        if (valid.providerId !== providerId) throw new Error('Model provider mismatch.');
        insert.run(
          valid.providerId,
          valid.modelId,
          valid.displayName,
          JSON.stringify(valid.capabilities),
          valid.contextWindow ?? null,
          valid.inputCostPerMillion ?? null,
          valid.outputCostPerMillion ?? null,
          valid.discoveredAt,
        );
      }
    });
  }

  listModels(providerId?: string): ModelDescriptor[] {
    const rows = (
      providerId === undefined
        ? this.#database.prepare('SELECT * FROM ai_models ORDER BY provider_id, model_id').all()
        : this.#database
            .prepare('SELECT * FROM ai_models WHERE provider_id = ? ORDER BY model_id')
            .all(providerId)
    ) as Record<string, unknown>[];
    return rows.map((row) =>
      ModelDescriptorSchema.parse({
        providerId: row.provider_id,
        modelId: row.model_id,
        displayName: row.display_name,
        capabilities: this.#parseJson(row.capabilities_json),
        ...(row.context_window === null ? {} : { contextWindow: Number(row.context_window) }),
        ...(row.input_cost_per_million === null
          ? {}
          : { inputCostPerMillion: Number(row.input_cost_per_million) }),
        ...(row.output_cost_per_million === null
          ? {}
          : { outputCostPerMillion: Number(row.output_cost_per_million) }),
        discoveredAt: row.discovered_at,
      }),
    );
  }

  getAiSettings(): AiSettings | undefined {
    const row = this.#database
      .prepare('SELECT settings_json FROM ai_settings WHERE singleton_id = 1')
      .get() as Record<string, unknown> | undefined;
    return row === undefined
      ? undefined
      : AiSettingsSchema.parse(this.#parseJson(row.settings_json));
  }

  setAiSettings(settings: AiSettings): void {
    const valid = AiSettingsSchema.parse(settings);
    this.#database
      .prepare(
        `INSERT INTO ai_settings (singleton_id, settings_json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           settings_json = excluded.settings_json,
           updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(valid), new Date().toISOString());
  }

  createConversation(conversation: Conversation): void {
    const valid = ConversationSchema.parse(conversation);
    this.#database
      .prepare(
        `INSERT INTO conversations (
           conversation_id, title, routing_override_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        valid.conversationId,
        valid.title,
        valid.routingOverride === undefined ? null : JSON.stringify(valid.routingOverride),
        valid.createdAt,
        valid.updatedAt,
      );
  }

  updateConversation(conversation: Conversation): void {
    const valid = ConversationSchema.parse(conversation);
    this.#database
      .prepare(
        `UPDATE conversations
            SET title = ?, routing_override_json = ?, updated_at = ?
          WHERE conversation_id = ?`,
      )
      .run(
        valid.title,
        valid.routingOverride === undefined ? null : JSON.stringify(valid.routingOverride),
        valid.updatedAt,
        valid.conversationId,
      );
  }

  getConversation(conversationId: string): Conversation | undefined {
    const row = this.#database
      .prepare('SELECT * FROM conversations WHERE conversation_id = ?')
      .get(conversationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#parseConversation(row);
  }

  listConversations(): Conversation[] {
    const rows = this.#database
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC, conversation_id DESC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.#parseConversation(row));
  }

  upsertMessage(message: ChatMessage): void {
    const valid = ChatMessageSchema.parse(message);
    this.#database
      .prepare(
        `INSERT INTO chat_messages (
           message_id, conversation_id, role, content, attachments_json, tool_calls_json,
           provider_id, model_id, status, usage_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           content = excluded.content,
           attachments_json = excluded.attachments_json,
           tool_calls_json = excluded.tool_calls_json,
           provider_id = excluded.provider_id,
           model_id = excluded.model_id,
           status = excluded.status,
           usage_json = excluded.usage_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        valid.messageId,
        valid.conversationId,
        valid.role,
        valid.content,
        JSON.stringify(valid.attachments),
        JSON.stringify(valid.toolCalls),
        valid.providerId ?? null,
        valid.modelId ?? null,
        valid.status,
        valid.usage === undefined ? null : JSON.stringify(valid.usage),
        valid.createdAt,
        valid.updatedAt,
      );
  }

  getMessage(messageId: string): ChatMessage | undefined {
    const row = this.#database
      .prepare('SELECT * FROM chat_messages WHERE message_id = ?')
      .get(messageId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#parseMessage(row);
  }

  listMessages(conversationId: string): ChatMessage[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM chat_messages
          WHERE conversation_id = ?
          ORDER BY created_at ASC, message_id ASC`,
      )
      .all(conversationId) as Record<string, unknown>[];
    return rows.map((row) => this.#parseMessage(row));
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

  #parseProvider(row: Record<string, unknown>): ProviderSummary {
    return ProviderSummarySchema.parse({
      providerId: row.provider_id,
      displayName: row.display_name,
      baseUrl: row.base_url,
      locality: row.locality,
      authScheme: row.auth_scheme,
      enabled: Number(row.enabled) === 1,
      capabilities: this.#parseJson(row.capabilities_json),
      authState: row.auth_state,
      health: row.health,
      ...(row.credential_fingerprint === null
        ? {}
        : { credentialFingerprint: row.credential_fingerprint }),
      ...(row.last_validated_at === null ? {} : { lastValidatedAt: row.last_validated_at }),
      ...(row.sanitized_error === null ? {} : { sanitizedError: row.sanitized_error }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #parseConversation(row: Record<string, unknown>): Conversation {
    return ConversationSchema.parse({
      conversationId: row.conversation_id,
      title: row.title,
      ...(row.routing_override_json === null
        ? {}
        : { routingOverride: this.#parseJson(row.routing_override_json) }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #parseMessage(row: Record<string, unknown>): ChatMessage {
    return ChatMessageSchema.parse({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      attachments: this.#parseJson(row.attachments_json),
      toolCalls: this.#parseJson(row.tool_calls_json),
      ...(row.provider_id === null ? {} : { providerId: row.provider_id }),
      ...(row.model_id === null ? {} : { modelId: row.model_id }),
      status: row.status,
      ...(row.usage_json === null ? {} : { usage: this.#parseJson(row.usage_json) }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #parseJson(value: unknown): unknown {
    if (typeof value !== 'string') throw new Error('Stored JSON value is invalid.');
    return JSON.parse(value) as unknown;
  }
}
