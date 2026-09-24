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
  MissionArtifactSchema,
  MissionErrorSchema,
  MissionExecutionSchema,
  MissionPermissionSchema,
  MissionSchema,
  MissionStepSchema,
  MissionTransitionSchema,
  MissionVerificationSchema,
  ProviderSummarySchema,
  PermissionAuditRecordSchema,
  PermissionGrantSchema,
  PermissionRequestRecordSchema,
  SkillExecutionRecordSchema,
  SkillRegistryEntrySchema,
  WorkflowArtifactBindingSchema,
  WorkflowCheckpointSchema,
  WorkflowExecutionSchema,
  WorkflowPlanSchema,
  WorkflowStepAttemptSchema,
  WorkflowStepSchema,
  ComputerActionResultSchema,
  type AiSettings,
  type AuditEvent,
  type CoreServiceHealth,
  type DatabaseDiagnostics,
  type DomainEvent,
  type ChatMessage,
  type Conversation,
  type ModelDescriptor,
  type Mission,
  type MissionArtifact,
  type MissionError,
  type MissionExecution,
  type MissionPermission,
  type MissionStep,
  type MissionTransition,
  type MissionVerification,
  type ProviderSummary,
  type PermissionAuditRecord,
  type PermissionGrant,
  type PermissionRequestRecord,
  type PermissionRequestStatus,
  type SkillExecutionRecord,
  type SkillRegistryEntry,
  type WorkflowArtifactBinding,
  type WorkflowCheckpoint,
  type WorkflowExecution,
  type WorkflowPlan,
  type WorkflowStepAttempt,
  type ComputerActionResult,
} from '@jupiter/contracts';
import type {
  AiRepository,
  AuditRepository,
  DiagnosticsRepository,
  DomainEventDraft,
  EventStore,
  MissionRepository,
  PermissionRepository,
  ServiceHealthRepository,
  SkillRepository,
  WorkflowRepository,
  ComputerActionRepository,
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
    AiRepository,
    MissionRepository,
    WorkflowRepository,
    SkillRepository,
    PermissionRepository,
    ComputerActionRepository
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

  createMission(mission: Mission): void {
    const valid = MissionSchema.parse(mission);
    this.#database
      .prepare(
        `INSERT INTO missions (
           mission_id, title, user_request, status, priority, plan_json,
           current_step_id, archived_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.missionId,
        valid.title,
        valid.userRequest,
        valid.status,
        valid.priority,
        valid.plan === undefined ? null : JSON.stringify(valid.plan),
        valid.currentStepId ?? null,
        valid.archivedAt ?? null,
        valid.createdAt,
        valid.updatedAt,
      );
  }

  updateMission(mission: Mission): void {
    const valid = MissionSchema.parse(mission);
    this.#database
      .prepare(
        `UPDATE missions SET
           title = ?, user_request = ?, status = ?, priority = ?, plan_json = ?,
           current_step_id = ?, archived_at = ?, updated_at = ?
         WHERE mission_id = ?`,
      )
      .run(
        valid.title,
        valid.userRequest,
        valid.status,
        valid.priority,
        valid.plan === undefined ? null : JSON.stringify(valid.plan),
        valid.currentStepId ?? null,
        valid.archivedAt ?? null,
        valid.updatedAt,
        valid.missionId,
      );
  }

  getMission(missionId: string): Mission | undefined {
    const row = this.#database
      .prepare('SELECT * FROM missions WHERE mission_id = ?')
      .get(missionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#parseMission(row);
  }

  listMissions(includeArchived = false): Mission[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM missions
          WHERE (? = 1 OR archived_at IS NULL)
          ORDER BY updated_at DESC, mission_id DESC`,
      )
      .all(includeArchived ? 1 : 0) as Record<string, unknown>[];
    return rows.map((row) => this.#parseMission(row));
  }

  createMissionExecution(execution: MissionExecution): void {
    const valid = MissionExecutionSchema.parse(execution);
    this.#database
      .prepare(
        `INSERT INTO mission_executions (
           execution_id, mission_id, attempt, prior_execution_id, status, started_at, ended_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.executionId,
        valid.missionId,
        valid.attempt,
        valid.priorExecutionId ?? null,
        valid.status,
        valid.startedAt,
        valid.endedAt ?? null,
      );
  }

  updateMissionExecution(execution: MissionExecution): void {
    const valid = MissionExecutionSchema.parse(execution);
    this.#database
      .prepare('UPDATE mission_executions SET status = ?, ended_at = ? WHERE execution_id = ?')
      .run(valid.status, valid.endedAt ?? null, valid.executionId);
  }

  listMissionExecutions(missionId: string): MissionExecution[] {
    const rows = this.#database
      .prepare('SELECT * FROM mission_executions WHERE mission_id = ? ORDER BY attempt ASC')
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) =>
      MissionExecutionSchema.parse({
        executionId: row.execution_id,
        missionId: row.mission_id,
        attempt: Number(row.attempt),
        ...(row.prior_execution_id === null ? {} : { priorExecutionId: row.prior_execution_id }),
        status: row.status,
        startedAt: row.started_at,
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      }),
    );
  }

  appendMissionTransition(transition: MissionTransition): void {
    const valid = MissionTransitionSchema.parse(transition);
    this.#database
      .prepare(
        `INSERT INTO mission_transitions (
           transition_id, mission_id, execution_id, from_status, to_status,
           accepted, reason, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.transitionId,
        valid.missionId,
        valid.executionId,
        valid.fromStatus,
        valid.toStatus,
        valid.accepted ? 1 : 0,
        valid.reason,
        valid.occurredAt,
      );
  }

  listMissionTransitions(missionId: string): MissionTransition[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM mission_transitions
          WHERE mission_id = ? ORDER BY occurred_at ASC, transition_id ASC`,
      )
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) =>
      MissionTransitionSchema.parse({
        transitionId: row.transition_id,
        missionId: row.mission_id,
        executionId: row.execution_id,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        accepted: Number(row.accepted) === 1,
        reason: row.reason,
        occurredAt: row.occurred_at,
      }),
    );
  }

  upsertMissionStep(step: MissionStep): void {
    const valid = MissionStepSchema.parse(step);
    this.#database
      .prepare(
        `INSERT INTO mission_steps (
           step_id, mission_id, execution_id, position, title, required, status,
           agent, model, skills_json, started_at, completed_at, sanitized_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(step_id) DO UPDATE SET
           position = excluded.position, title = excluded.title, required = excluded.required,
           status = excluded.status, agent = excluded.agent, model = excluded.model,
           skills_json = excluded.skills_json, started_at = excluded.started_at,
           completed_at = excluded.completed_at, sanitized_error = excluded.sanitized_error`,
      )
      .run(
        valid.stepId,
        valid.missionId,
        valid.executionId,
        valid.position,
        valid.title,
        valid.required ? 1 : 0,
        valid.status,
        valid.agent ?? null,
        valid.model ?? null,
        JSON.stringify(valid.skills),
        valid.startedAt ?? null,
        valid.completedAt ?? null,
        valid.sanitizedError ?? null,
      );
  }

  listMissionSteps(missionId: string): MissionStep[] {
    const rows = this.#database
      .prepare('SELECT * FROM mission_steps WHERE mission_id = ? ORDER BY position, step_id')
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) =>
      MissionStepSchema.parse({
        stepId: row.step_id,
        missionId: row.mission_id,
        executionId: row.execution_id,
        position: Number(row.position),
        title: row.title,
        required: Number(row.required) === 1,
        status: row.status,
        ...(row.agent === null ? {} : { agent: row.agent }),
        ...(row.model === null ? {} : { model: row.model }),
        skills: this.#parseJson(row.skills_json),
        ...(row.started_at === null ? {} : { startedAt: row.started_at }),
        ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
        ...(row.sanitized_error === null ? {} : { sanitizedError: row.sanitized_error }),
      }),
    );
  }

  upsertMissionPermission(permission: MissionPermission): void {
    const valid = MissionPermissionSchema.parse(permission);
    this.#database
      .prepare(
        `INSERT INTO mission_permissions (permission_id, mission_id, name, status, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(permission_id) DO UPDATE SET
           name = excluded.name, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(valid.permissionId, valid.missionId, valid.name, valid.status, valid.updatedAt);
  }

  listMissionPermissions(missionId: string): MissionPermission[] {
    const rows = this.#database
      .prepare('SELECT * FROM mission_permissions WHERE mission_id = ? ORDER BY name')
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) =>
      MissionPermissionSchema.parse({
        permissionId: row.permission_id,
        missionId: row.mission_id,
        name: row.name,
        status: row.status,
        updatedAt: row.updated_at,
      }),
    );
  }

  addMissionArtifact(artifact: MissionArtifact): void {
    const valid = MissionArtifactSchema.parse(artifact);
    this.#database
      .prepare(
        `INSERT INTO mission_artifacts (
           mission_artifact_id, mission_id, artifact_id, name, kind, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.missionArtifactId,
        valid.missionId,
        valid.artifactId,
        valid.name,
        valid.kind,
        valid.status,
        valid.createdAt,
      );
  }

  listMissionArtifacts(missionId: string): MissionArtifact[] {
    const rows = this.#database
      .prepare('SELECT * FROM mission_artifacts WHERE mission_id = ? ORDER BY created_at')
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) =>
      MissionArtifactSchema.parse({
        missionArtifactId: row.mission_artifact_id,
        missionId: row.mission_id,
        artifactId: row.artifact_id,
        name: row.name,
        kind: row.kind,
        status: row.status,
        createdAt: row.created_at,
      }),
    );
  }

  addMissionError(error: MissionError): void {
    const valid = MissionErrorSchema.parse(error);
    this.#database
      .prepare(
        `INSERT INTO mission_errors (
           mission_error_id, mission_id, execution_id, step_id, code,
           message, recoverable, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.missionErrorId,
        valid.missionId,
        valid.executionId,
        valid.stepId ?? null,
        valid.code,
        valid.message,
        valid.recoverable ? 1 : 0,
        valid.occurredAt,
      );
  }

  listMissionErrors(missionId: string): MissionError[] {
    const rows = this.#database
      .prepare('SELECT * FROM mission_errors WHERE mission_id = ? ORDER BY occurred_at')
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) =>
      MissionErrorSchema.parse({
        missionErrorId: row.mission_error_id,
        missionId: row.mission_id,
        executionId: row.execution_id,
        ...(row.step_id === null ? {} : { stepId: row.step_id }),
        code: row.code,
        message: row.message,
        recoverable: Number(row.recoverable) === 1,
        occurredAt: row.occurred_at,
      }),
    );
  }

  addMissionVerification(verification: MissionVerification): void {
    const valid = MissionVerificationSchema.parse(verification);
    this.#database
      .prepare(
        `INSERT INTO mission_verifications (
           verification_id, mission_id, execution_id, name, passed, summary, verified_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.verificationId,
        valid.missionId,
        valid.executionId,
        valid.name,
        valid.passed ? 1 : 0,
        valid.summary,
        valid.verifiedAt,
      );
  }

  listMissionVerifications(missionId: string): MissionVerification[] {
    const rows = this.#database
      .prepare('SELECT * FROM mission_verifications WHERE mission_id = ? ORDER BY verified_at')
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) =>
      MissionVerificationSchema.parse({
        verificationId: row.verification_id,
        missionId: row.mission_id,
        executionId: row.execution_id,
        name: row.name,
        passed: Number(row.passed) === 1,
        summary: row.summary,
        verifiedAt: row.verified_at,
      }),
    );
  }

  createWorkflowPlan(plan: WorkflowPlan): void {
    const valid = WorkflowPlanSchema.parse(plan);
    this.#database
      .prepare(
        `INSERT INTO workflow_plans (
           plan_id, mission_id, revision, prior_plan_id, goal, assumptions_json,
           required_skills_json, required_permissions_json, expected_artifacts_json,
           verification_plan_json, rationale, active, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.planId,
        valid.missionId,
        valid.revision,
        valid.priorPlanId ?? null,
        valid.goal,
        JSON.stringify(valid.assumptions),
        JSON.stringify(valid.requiredSkills),
        JSON.stringify(valid.requiredPermissions),
        JSON.stringify(valid.expectedArtifacts),
        JSON.stringify(valid.verificationPlan),
        valid.rationale,
        valid.active ? 1 : 0,
        valid.createdAt,
      );
    const insertStep = this.#database.prepare(
      `INSERT INTO workflow_plan_steps (
         step_id, plan_id, position, title, description, skill_id, dependencies_json,
         input_json, timeout_ms, retry_policy_json, verification_json, status,
         required_permissions_json, produces_artifacts_json, checkpoint, condition_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    valid.steps.forEach((step, position) => {
      insertStep.run(
        step.stepId,
        valid.planId,
        position,
        step.title,
        step.description,
        step.skillId,
        JSON.stringify(step.dependencies),
        JSON.stringify(step.input),
        step.timeoutMs,
        JSON.stringify(step.retryPolicy),
        JSON.stringify(step.verification),
        step.status,
        JSON.stringify(step.requiredPermissions),
        JSON.stringify(step.producesArtifacts),
        step.checkpoint,
        step.condition === undefined ? null : JSON.stringify(step.condition),
      );
    });
  }

  setWorkflowPlanActive(planId: string, active: boolean): void {
    this.#database
      .prepare('UPDATE workflow_plans SET active = ? WHERE plan_id = ?')
      .run(active ? 1 : 0, planId);
  }

  getWorkflowPlan(planId: string): WorkflowPlan | undefined {
    const row = this.#database
      .prepare('SELECT * FROM workflow_plans WHERE plan_id = ?')
      .get(planId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#parseWorkflowPlan(row);
  }

  getActiveWorkflowPlan(missionId: string): WorkflowPlan | undefined {
    const row = this.#database
      .prepare('SELECT * FROM workflow_plans WHERE mission_id = ? AND active = 1')
      .get(missionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#parseWorkflowPlan(row);
  }

  listWorkflowPlans(missionId: string): WorkflowPlan[] {
    const rows = this.#database
      .prepare('SELECT * FROM workflow_plans WHERE mission_id = ? ORDER BY revision')
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) => this.#parseWorkflowPlan(row));
  }

  createWorkflowExecution(execution: WorkflowExecution): void {
    const valid = WorkflowExecutionSchema.parse(execution);
    this.#database
      .prepare(
        `INSERT INTO workflow_executions (
           workflow_execution_id, plan_id, mission_id, status, started_at, updated_at,
           ended_at, pause_requested, cancel_requested, failure_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.workflowExecutionId,
        valid.planId,
        valid.missionId,
        valid.status,
        valid.startedAt,
        valid.updatedAt,
        valid.endedAt ?? null,
        valid.pauseRequested ? 1 : 0,
        valid.cancelRequested ? 1 : 0,
        valid.failureReason ?? null,
      );
  }

  updateWorkflowExecution(execution: WorkflowExecution): void {
    const valid = WorkflowExecutionSchema.parse(execution);
    this.#database
      .prepare(
        `UPDATE workflow_executions SET
           status = ?, updated_at = ?, ended_at = ?, pause_requested = ?,
           cancel_requested = ?, failure_reason = ?
         WHERE workflow_execution_id = ?`,
      )
      .run(
        valid.status,
        valid.updatedAt,
        valid.endedAt ?? null,
        valid.pauseRequested ? 1 : 0,
        valid.cancelRequested ? 1 : 0,
        valid.failureReason ?? null,
        valid.workflowExecutionId,
      );
  }

  getWorkflowExecution(workflowExecutionId: string): WorkflowExecution | undefined {
    const row = this.#database
      .prepare('SELECT * FROM workflow_executions WHERE workflow_execution_id = ?')
      .get(workflowExecutionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#parseWorkflowExecution(row);
  }

  getLatestWorkflowExecution(missionId: string): WorkflowExecution | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM workflow_executions
         WHERE mission_id = ? ORDER BY started_at DESC, workflow_execution_id DESC LIMIT 1`,
      )
      .get(missionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#parseWorkflowExecution(row);
  }

  listRecoverableWorkflowExecutions(): WorkflowExecution[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM workflow_executions
         WHERE status IN ('PENDING', 'RUNNING', 'WAITING') ORDER BY started_at`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.#parseWorkflowExecution(row));
  }

  upsertWorkflowStepAttempt(attempt: WorkflowStepAttempt): void {
    const valid = WorkflowStepAttemptSchema.parse(attempt);
    this.#database
      .prepare(
        `INSERT INTO workflow_step_attempts (
           step_attempt_id, workflow_execution_id, step_id, attempt, status,
           idempotency_key, input_json, output_json, verification_passed,
           verification_summary, sanitized_error, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(step_attempt_id) DO UPDATE SET
           status = excluded.status, output_json = excluded.output_json,
           verification_passed = excluded.verification_passed,
           verification_summary = excluded.verification_summary,
           sanitized_error = excluded.sanitized_error, completed_at = excluded.completed_at`,
      )
      .run(
        valid.stepAttemptId,
        valid.workflowExecutionId,
        valid.stepId,
        valid.attempt,
        valid.status,
        valid.idempotencyKey,
        JSON.stringify(valid.input),
        valid.output === undefined ? null : JSON.stringify(valid.output),
        valid.verificationPassed === undefined ? null : valid.verificationPassed ? 1 : 0,
        valid.verificationSummary ?? null,
        valid.sanitizedError ?? null,
        valid.startedAt,
        valid.completedAt ?? null,
      );
  }

  listWorkflowStepAttempts(workflowExecutionId: string): WorkflowStepAttempt[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM workflow_step_attempts
         WHERE workflow_execution_id = ? ORDER BY started_at, step_id, attempt`,
      )
      .all(workflowExecutionId) as Record<string, unknown>[];
    return rows.map((row) =>
      WorkflowStepAttemptSchema.parse({
        stepAttemptId: row.step_attempt_id,
        workflowExecutionId: row.workflow_execution_id,
        stepId: row.step_id,
        attempt: Number(row.attempt),
        status: row.status,
        idempotencyKey: row.idempotency_key,
        input: this.#parseJson(row.input_json),
        ...(row.output_json === null ? {} : { output: this.#parseJson(row.output_json) }),
        ...(row.verification_passed === null
          ? {}
          : { verificationPassed: Number(row.verification_passed) === 1 }),
        ...(row.verification_summary === null
          ? {}
          : { verificationSummary: row.verification_summary }),
        ...(row.sanitized_error === null ? {} : { sanitizedError: row.sanitized_error }),
        startedAt: row.started_at,
        ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      }),
    );
  }

  createWorkflowCheckpoint(checkpoint: WorkflowCheckpoint): void {
    const valid = WorkflowCheckpointSchema.parse(checkpoint);
    this.#database
      .prepare(
        `INSERT INTO workflow_checkpoints (
           checkpoint_id, workflow_execution_id, step_id, kind, status, reason,
           created_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.checkpointId,
        valid.workflowExecutionId,
        valid.stepId,
        valid.kind,
        valid.status,
        valid.reason,
        valid.createdAt,
        valid.resolvedAt ?? null,
      );
  }

  updateWorkflowCheckpoint(checkpoint: WorkflowCheckpoint): void {
    const valid = WorkflowCheckpointSchema.parse(checkpoint);
    this.#database
      .prepare(
        `UPDATE workflow_checkpoints SET status = ?, reason = ?, resolved_at = ?
         WHERE checkpoint_id = ?`,
      )
      .run(valid.status, valid.reason, valid.resolvedAt ?? null, valid.checkpointId);
  }

  getWorkflowCheckpoint(checkpointId: string): WorkflowCheckpoint | undefined {
    const row = this.#database
      .prepare('SELECT * FROM workflow_checkpoints WHERE checkpoint_id = ?')
      .get(checkpointId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#parseWorkflowCheckpoint(row);
  }

  listWorkflowCheckpoints(workflowExecutionId: string): WorkflowCheckpoint[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM workflow_checkpoints
         WHERE workflow_execution_id = ? ORDER BY created_at, checkpoint_id`,
      )
      .all(workflowExecutionId) as Record<string, unknown>[];
    return rows.map((row) => this.#parseWorkflowCheckpoint(row));
  }

  addWorkflowArtifactBinding(binding: WorkflowArtifactBinding): void {
    const valid = WorkflowArtifactBindingSchema.parse(binding);
    this.#database
      .prepare(
        `INSERT INTO workflow_artifact_bindings (
           binding_id, workflow_execution_id, step_id, artifact_key, value_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workflow_execution_id, artifact_key) DO UPDATE SET
           step_id = excluded.step_id, value_json = excluded.value_json,
           created_at = excluded.created_at`,
      )
      .run(
        valid.bindingId,
        valid.workflowExecutionId,
        valid.stepId,
        valid.artifactKey,
        JSON.stringify(valid.value ?? null),
        valid.createdAt,
      );
  }

  listWorkflowArtifactBindings(workflowExecutionId: string): WorkflowArtifactBinding[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM workflow_artifact_bindings
         WHERE workflow_execution_id = ? ORDER BY created_at, artifact_key`,
      )
      .all(workflowExecutionId) as Record<string, unknown>[];
    return rows.map((row) =>
      WorkflowArtifactBindingSchema.parse({
        bindingId: row.binding_id,
        workflowExecutionId: row.workflow_execution_id,
        stepId: row.step_id,
        artifactKey: row.artifact_key,
        value: this.#parseJson(row.value_json),
        createdAt: row.created_at,
      }),
    );
  }

  upsertSkill(entry: SkillRegistryEntry): void {
    const valid = SkillRegistryEntrySchema.parse(entry);
    const definition = valid.definition;
    this.#database
      .prepare(
        `INSERT INTO skill_definitions (
           skill_id, version, name, description, input_schema_json, output_schema_json,
           permissions_json, timeout_ms, category, provider, compatible_runtime, enabled,
           health, last_checked_at, sanitized_error, registered_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(skill_id, version) DO UPDATE SET
           name = excluded.name, description = excluded.description,
           input_schema_json = excluded.input_schema_json,
           output_schema_json = excluded.output_schema_json,
           permissions_json = excluded.permissions_json, timeout_ms = excluded.timeout_ms,
           category = excluded.category, provider = excluded.provider,
           compatible_runtime = excluded.compatible_runtime, enabled = excluded.enabled,
           health = excluded.health, last_checked_at = excluded.last_checked_at,
           sanitized_error = excluded.sanitized_error, updated_at = excluded.updated_at`,
      )
      .run(
        definition.skillId,
        definition.version,
        definition.name,
        definition.description,
        JSON.stringify(definition.inputSchema),
        JSON.stringify(definition.outputSchema),
        JSON.stringify(definition.permissions),
        definition.timeoutMs,
        definition.category,
        definition.provider,
        definition.compatibleRuntime,
        valid.enabled ? 1 : 0,
        valid.health,
        valid.lastCheckedAt ?? null,
        valid.sanitizedError ?? null,
        valid.registeredAt,
        valid.updatedAt,
      );
  }

  removeSkill(skillId: string, version: string): void {
    this.#database
      .prepare('DELETE FROM skill_definitions WHERE skill_id = ? AND version = ?')
      .run(skillId, version);
  }

  getSkill(skillId: string, version?: string): SkillRegistryEntry | undefined {
    const row = version
      ? this.#database
          .prepare('SELECT * FROM skill_definitions WHERE skill_id = ? AND version = ?')
          .get(skillId, version)
      : this.#database
          .prepare(
            'SELECT * FROM skill_definitions WHERE skill_id = ? ORDER BY version DESC LIMIT 1',
          )
          .get(skillId);
    return row ? this.#parseSkill(row) : undefined;
  }

  listSkills(): SkillRegistryEntry[] {
    const rows = this.#database
      .prepare('SELECT * FROM skill_definitions ORDER BY name, version DESC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.#parseSkill(row));
  }

  addSkillExecution(execution: SkillExecutionRecord): void {
    const valid = SkillExecutionRecordSchema.parse(execution);
    this.#database
      .prepare(
        `INSERT INTO skill_executions (
           execution_id, skill_id, version, mission_id, status, idempotency_key,
           input_metadata_json, output_metadata_json, error_json, verification_hints_json,
           started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.executionId,
        valid.skillId,
        valid.version,
        valid.missionId,
        valid.status,
        valid.idempotencyKey,
        JSON.stringify(valid.inputMetadata),
        JSON.stringify(valid.outputMetadata),
        valid.error ? JSON.stringify(valid.error) : null,
        JSON.stringify(valid.verificationHints),
        valid.startedAt,
        valid.completedAt,
      );
  }

  getSkillExecution(executionId: string): SkillExecutionRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM skill_executions WHERE execution_id = ?')
      .get(executionId);
    return row ? this.#parseSkillExecution(row) : undefined;
  }

  getSkillExecutionByIdempotencyKey(
    skillId: string,
    idempotencyKey: string,
  ): SkillExecutionRecord | undefined {
    const row = this.#database
      .prepare(
        'SELECT * FROM skill_executions WHERE skill_id = ? AND idempotency_key = ? ORDER BY started_at DESC LIMIT 1',
      )
      .get(skillId, idempotencyKey);
    return row ? this.#parseSkillExecution(row) : undefined;
  }

  listSkillExecutions(skillId?: string): SkillExecutionRecord[] {
    const rows = skillId
      ? this.#database
          .prepare('SELECT * FROM skill_executions WHERE skill_id = ? ORDER BY started_at')
          .all(skillId)
      : this.#database.prepare('SELECT * FROM skill_executions ORDER BY started_at').all();
    return (rows as Record<string, unknown>[]).map((row) => this.#parseSkillExecution(row));
  }

  upsertPermissionRequest(request: PermissionRequestRecord): void {
    const valid = PermissionRequestRecordSchema.parse(request);
    this.#database
      .prepare(
        `INSERT INTO permission_requests (
           request_id, capability, status, risk, actor, requester_type, requester_id,
           target_id, scope_id, mission_id, session_id, request_json, created_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           status = excluded.status, request_json = excluded.request_json,
           resolved_at = excluded.resolved_at`,
      )
      .run(
        valid.requestId,
        valid.capability,
        valid.status,
        valid.risk,
        valid.requester.actor,
        valid.requester.type,
        valid.requester.id,
        valid.target.id,
        valid.scope.id,
        valid.requester.missionId ?? null,
        valid.sessionId,
        JSON.stringify(valid),
        valid.createdAt,
        valid.resolvedAt ?? null,
      );
  }

  getPermissionRequest(requestId: string): PermissionRequestRecord | undefined {
    const row = this.#database
      .prepare('SELECT request_json FROM permission_requests WHERE request_id = ?')
      .get(requestId) as Record<string, unknown> | undefined;
    return row ? PermissionRequestRecordSchema.parse(this.#parseJson(row.request_json)) : undefined;
  }

  listPermissionRequests(status?: PermissionRequestStatus): PermissionRequestRecord[] {
    const rows = status
      ? this.#database
          .prepare(
            'SELECT request_json FROM permission_requests WHERE status = ? ORDER BY created_at DESC',
          )
          .all(status)
      : this.#database
          .prepare('SELECT request_json FROM permission_requests ORDER BY created_at DESC')
          .all();
    return (rows as Record<string, unknown>[]).map((row) =>
      PermissionRequestRecordSchema.parse(this.#parseJson(row.request_json)),
    );
  }

  upsertPermissionGrant(grant: PermissionGrant): void {
    const valid = PermissionGrantSchema.parse(grant);
    if (valid.decision === 'ALLOW_SESSION') {
      throw new Error('Session grants must not be persisted.');
    }
    this.#database
      .prepare(
        `INSERT INTO permission_grants (
           grant_id, request_id, capability, decision, actor, requester_type, requester_id,
           target_id, scope_id, mission_id, expires_at, remaining_uses, revoked_at,
           grant_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(grant_id) DO UPDATE SET
           remaining_uses = excluded.remaining_uses, revoked_at = excluded.revoked_at,
           grant_json = excluded.grant_json`,
      )
      .run(
        valid.grantId,
        valid.requestId,
        valid.capability,
        valid.decision,
        valid.actor,
        valid.requesterType,
        valid.requesterId,
        valid.targetId,
        valid.scopeId,
        valid.missionId ?? null,
        valid.expiresAt ?? null,
        valid.remainingUses ?? null,
        valid.revokedAt ?? null,
        JSON.stringify(valid),
        valid.createdAt,
      );
  }

  getPermissionGrant(grantId: string): PermissionGrant | undefined {
    const row = this.#database
      .prepare('SELECT grant_json FROM permission_grants WHERE grant_id = ?')
      .get(grantId) as Record<string, unknown> | undefined;
    return row ? PermissionGrantSchema.parse(this.#parseJson(row.grant_json)) : undefined;
  }

  listPermissionGrants(): PermissionGrant[] {
    const rows = this.#database
      .prepare('SELECT grant_json FROM permission_grants ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => PermissionGrantSchema.parse(this.#parseJson(row.grant_json)));
  }

  appendPermissionAudit(audit: PermissionAuditRecord): void {
    const valid = PermissionAuditRecordSchema.parse(audit);
    this.#database
      .prepare(
        `INSERT INTO permission_audit (
           audit_id, event_type, capability, actor, requester_type, requester_id,
           decision, reason_code, risk, target_fingerprint, mission_id, request_id,
           grant_id, metadata_redacted_json, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.auditId,
        valid.eventType,
        valid.capability,
        valid.actor,
        valid.requesterType,
        valid.requesterId,
        valid.decision,
        valid.reasonCode,
        valid.risk,
        valid.targetFingerprint,
        valid.missionId ?? null,
        valid.requestId ?? null,
        valid.grantId ?? null,
        JSON.stringify(valid.metadataRedacted),
        valid.timestamp,
      );
  }

  listPermissionAudits(limit: number): PermissionAuditRecord[] {
    const rows = this.#database
      .prepare('SELECT * FROM permission_audit ORDER BY timestamp DESC, audit_id DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) =>
      PermissionAuditRecordSchema.parse({
        auditId: row.audit_id,
        eventType: row.event_type,
        capability: row.capability,
        actor: row.actor,
        requesterType: row.requester_type,
        requesterId: row.requester_id,
        decision: row.decision,
        reasonCode: row.reason_code,
        risk: row.risk,
        targetFingerprint: row.target_fingerprint,
        ...(row.mission_id === null ? {} : { missionId: row.mission_id }),
        ...(row.request_id === null ? {} : { requestId: row.request_id }),
        ...(row.grant_id === null ? {} : { grantId: row.grant_id }),
        timestamp: row.timestamp,
        metadataRedacted: this.#parseJson(row.metadata_redacted_json),
      }),
    );
  }

  addComputerAction(action: ComputerActionResult): void {
    const valid = ComputerActionResultSchema.parse(action);
    const persisted =
      valid.output?.uiTree === undefined
        ? valid
        : {
            ...valid,
            output: {
              ...valid.output,
              uiTree: undefined,
            },
          };
    this.#database
      .prepare(
        `INSERT INTO computer_actions (
           action_id, action_type, status, success, adapter_id, interaction_mode,
           target_kind, target_id, result_json, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        valid.actionId,
        valid.action,
        valid.status,
        valid.success ? 1 : 0,
        valid.adapterId,
        valid.interactionMode,
        valid.target.kind,
        valid.target.id,
        JSON.stringify(persisted),
        valid.startedAt,
        valid.completedAt,
      );
  }

  listComputerActions(limit: number): ComputerActionResult[] {
    const rows = this.#database
      .prepare(
        'SELECT result_json FROM computer_actions ORDER BY started_at DESC, action_id DESC LIMIT ?',
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ComputerActionResultSchema.parse(this.#parseJson(row.result_json)));
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

  #parseMission(row: Record<string, unknown>): Mission {
    return MissionSchema.parse({
      missionId: row.mission_id,
      title: row.title,
      userRequest: row.user_request,
      status: row.status,
      priority: row.priority,
      ...(row.plan_json === null ? {} : { plan: this.#parseJson(row.plan_json) }),
      ...(row.current_step_id === null ? {} : { currentStepId: row.current_step_id }),
      ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  #parseWorkflowPlan(row: Record<string, unknown>): WorkflowPlan {
    const stepRows = this.#database
      .prepare('SELECT * FROM workflow_plan_steps WHERE plan_id = ? ORDER BY position')
      .all(String(row.plan_id)) as Record<string, unknown>[];
    return WorkflowPlanSchema.parse({
      planId: row.plan_id,
      missionId: row.mission_id,
      revision: Number(row.revision),
      ...(row.prior_plan_id === null ? {} : { priorPlanId: row.prior_plan_id }),
      goal: row.goal,
      assumptions: this.#parseJson(row.assumptions_json),
      steps: stepRows.map((step) =>
        WorkflowStepSchema.parse({
          stepId: step.step_id,
          title: step.title,
          description: step.description,
          skillId: step.skill_id,
          dependencies: this.#parseJson(step.dependencies_json),
          input: this.#parseJson(step.input_json),
          timeoutMs: Number(step.timeout_ms),
          retryPolicy: this.#parseJson(step.retry_policy_json),
          verification: this.#parseJson(step.verification_json),
          status: step.status,
          requiredPermissions: this.#parseJson(step.required_permissions_json),
          producesArtifacts: this.#parseJson(step.produces_artifacts_json),
          checkpoint: step.checkpoint,
          ...(step.condition_json === null
            ? {}
            : { condition: this.#parseJson(step.condition_json) }),
        }),
      ),
      requiredSkills: this.#parseJson(row.required_skills_json),
      requiredPermissions: this.#parseJson(row.required_permissions_json),
      expectedArtifacts: this.#parseJson(row.expected_artifacts_json),
      verificationPlan: this.#parseJson(row.verification_plan_json),
      rationale: row.rationale,
      active: Number(row.active) === 1,
      createdAt: row.created_at,
    });
  }

  #parseWorkflowExecution(row: Record<string, unknown>): WorkflowExecution {
    return WorkflowExecutionSchema.parse({
      workflowExecutionId: row.workflow_execution_id,
      planId: row.plan_id,
      missionId: row.mission_id,
      status: row.status,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      pauseRequested: Number(row.pause_requested) === 1,
      cancelRequested: Number(row.cancel_requested) === 1,
      ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    });
  }

  #parseWorkflowCheckpoint(row: Record<string, unknown>): WorkflowCheckpoint {
    return WorkflowCheckpointSchema.parse({
      checkpointId: row.checkpoint_id,
      workflowExecutionId: row.workflow_execution_id,
      stepId: row.step_id,
      kind: row.kind,
      status: row.status,
      reason: row.reason,
      createdAt: row.created_at,
      ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    });
  }

  #parseSkill(row: Record<string, unknown>): SkillRegistryEntry {
    return SkillRegistryEntrySchema.parse({
      definition: {
        skillId: row.skill_id,
        version: row.version,
        name: row.name,
        description: row.description,
        inputSchema: this.#parseJson(row.input_schema_json),
        outputSchema: this.#parseJson(row.output_schema_json),
        permissions: this.#parseJson(row.permissions_json),
        timeoutMs: Number(row.timeout_ms),
        category: row.category,
        provider: row.provider,
        compatibleRuntime: row.compatible_runtime,
      },
      enabled: Number(row.enabled) === 1,
      health: row.health,
      ...(row.last_checked_at === null ? {} : { lastCheckedAt: row.last_checked_at }),
      ...(row.sanitized_error === null ? {} : { sanitizedError: row.sanitized_error }),
      registeredAt: row.registered_at,
      updatedAt: row.updated_at,
    });
  }

  #parseSkillExecution(row: Record<string, unknown>): SkillExecutionRecord {
    return SkillExecutionRecordSchema.parse({
      executionId: row.execution_id,
      skillId: row.skill_id,
      missionId: row.mission_id,
      version: row.version,
      status: row.status,
      artifacts: {},
      ...(row.error_json === null ? {} : { error: this.#parseJson(row.error_json) }),
      verificationHints: this.#parseJson(row.verification_hints_json),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      idempotencyKey: row.idempotency_key,
      inputMetadata: this.#parseJson(row.input_metadata_json),
      outputMetadata: this.#parseJson(row.output_metadata_json),
    });
  }

  #parseJson(value: unknown): unknown {
    if (typeof value !== 'string') throw new Error('Stored JSON value is invalid.');
    return JSON.parse(value) as unknown;
  }
}
