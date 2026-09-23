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
  {
    version: 3,
    name: 'ai_providers_models_and_conversations',
    sql: `
      CREATE TABLE ai_providers (
        provider_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        locality TEXT NOT NULL CHECK (locality IN ('cloud', 'local')),
        auth_scheme TEXT NOT NULL CHECK (auth_scheme IN ('bearer', 'none')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        capabilities_json TEXT NOT NULL,
        auth_state TEXT NOT NULL,
        health TEXT NOT NULL,
        credential_fingerprint TEXT,
        last_validated_at TEXT,
        sanitized_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE ai_models (
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        context_window INTEGER,
        input_cost_per_million REAL,
        output_cost_per_million REAL,
        discovered_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, model_id),
        FOREIGN KEY (provider_id) REFERENCES ai_providers(provider_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE ai_settings (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        routing_override_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE chat_messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        tool_calls_json TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'cancelled', 'failed')),
        usage_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX conversations_updated_idx ON conversations (updated_at DESC);
      CREATE INDEX chat_messages_conversation_idx ON chat_messages (conversation_id, created_at, message_id);
    `,
  },
  {
    version: 4,
    name: 'normalized_mission_system',
    sql: `
      CREATE TABLE missions (
        mission_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        user_request TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        plan_json TEXT,
        current_step_id TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE mission_executions (
        execution_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        prior_execution_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        UNIQUE (mission_id, attempt),
        FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE,
        FOREIGN KEY (prior_execution_id) REFERENCES mission_executions(execution_id)
      ) STRICT;

      CREATE TABLE mission_transitions (
        transition_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
        reason TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE,
        FOREIGN KEY (execution_id) REFERENCES mission_executions(execution_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE mission_steps (
        step_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        title TEXT NOT NULL,
        required INTEGER NOT NULL CHECK (required IN (0, 1)),
        status TEXT NOT NULL,
        agent TEXT,
        model TEXT,
        skills_json TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        sanitized_error TEXT,
        FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE,
        FOREIGN KEY (execution_id) REFERENCES mission_executions(execution_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE mission_permissions (
        permission_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE mission_artifacts (
        mission_artifact_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE mission_errors (
        mission_error_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        step_id TEXT,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        recoverable INTEGER NOT NULL CHECK (recoverable IN (0, 1)),
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE,
        FOREIGN KEY (execution_id) REFERENCES mission_executions(execution_id) ON DELETE CASCADE,
        FOREIGN KEY (step_id) REFERENCES mission_steps(step_id)
      ) STRICT;

      CREATE TABLE mission_verifications (
        verification_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        name TEXT NOT NULL,
        passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
        summary TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE,
        FOREIGN KEY (execution_id) REFERENCES mission_executions(execution_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX missions_updated_idx ON missions (archived_at, updated_at DESC);
      CREATE INDEX mission_executions_order_idx ON mission_executions (mission_id, attempt);
      CREATE INDEX mission_transitions_order_idx ON mission_transitions (mission_id, occurred_at, transition_id);
      CREATE INDEX mission_steps_order_idx ON mission_steps (mission_id, position, step_id);
      CREATE INDEX mission_verifications_order_idx ON mission_verifications (mission_id, verified_at, verification_id);
    `,
  },
  {
    version: 5,
    name: 'durable_plans_and_workflows',
    sql: `
      CREATE TABLE workflow_plans (
        plan_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        prior_plan_id TEXT,
        goal TEXT NOT NULL,
        assumptions_json TEXT NOT NULL,
        required_skills_json TEXT NOT NULL,
        required_permissions_json TEXT NOT NULL,
        expected_artifacts_json TEXT NOT NULL,
        verification_plan_json TEXT NOT NULL,
        rationale TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE (mission_id, revision),
        FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE,
        FOREIGN KEY (prior_plan_id) REFERENCES workflow_plans(plan_id)
      ) STRICT;

      CREATE TABLE workflow_plan_steps (
        step_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms >= 100),
        retry_policy_json TEXT NOT NULL,
        verification_json TEXT NOT NULL,
        status TEXT NOT NULL,
        required_permissions_json TEXT NOT NULL,
        produces_artifacts_json TEXT NOT NULL,
        checkpoint TEXT NOT NULL,
        condition_json TEXT,
        FOREIGN KEY (plan_id) REFERENCES workflow_plans(plan_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE workflow_executions (
        workflow_execution_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        pause_requested INTEGER NOT NULL CHECK (pause_requested IN (0, 1)),
        cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
        failure_reason TEXT,
        FOREIGN KEY (plan_id) REFERENCES workflow_plans(plan_id),
        FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE workflow_step_attempts (
        step_attempt_id TEXT PRIMARY KEY,
        workflow_execution_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        verification_passed INTEGER,
        verification_summary TEXT,
        sanitized_error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (workflow_execution_id, step_id, attempt),
        FOREIGN KEY (workflow_execution_id) REFERENCES workflow_executions(workflow_execution_id) ON DELETE CASCADE,
        FOREIGN KEY (step_id) REFERENCES workflow_plan_steps(step_id)
      ) STRICT;

      CREATE TABLE workflow_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        workflow_execution_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE (workflow_execution_id, step_id),
        FOREIGN KEY (workflow_execution_id) REFERENCES workflow_executions(workflow_execution_id) ON DELETE CASCADE,
        FOREIGN KEY (step_id) REFERENCES workflow_plan_steps(step_id)
      ) STRICT;

      CREATE TABLE workflow_artifact_bindings (
        binding_id TEXT PRIMARY KEY,
        workflow_execution_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        artifact_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workflow_execution_id, artifact_key),
        FOREIGN KEY (workflow_execution_id) REFERENCES workflow_executions(workflow_execution_id) ON DELETE CASCADE,
        FOREIGN KEY (step_id) REFERENCES workflow_plan_steps(step_id)
      ) STRICT;

      CREATE INDEX workflow_plans_mission_revision_idx ON workflow_plans (mission_id, revision);
      CREATE UNIQUE INDEX workflow_plans_one_active_idx ON workflow_plans (mission_id) WHERE active = 1;
      CREATE INDEX workflow_steps_plan_position_idx ON workflow_plan_steps (plan_id, position);
      CREATE INDEX workflow_executions_mission_idx ON workflow_executions (mission_id, started_at);
      CREATE INDEX workflow_attempts_execution_idx ON workflow_step_attempts (workflow_execution_id, step_id, attempt);
    `,
  },
  {
    version: 6,
    name: 'executable_skill_registry',
    sql: `
      CREATE TABLE skill_definitions (
        skill_id TEXT NOT NULL,
        version TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        input_schema_json TEXT NOT NULL,
        output_schema_json TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms >= 10),
        category TEXT NOT NULL,
        provider TEXT NOT NULL,
        compatible_runtime TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        health TEXT NOT NULL,
        last_checked_at TEXT,
        sanitized_error TEXT,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (skill_id, version)
      ) STRICT;

      CREATE TABLE skill_executions (
        execution_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        version TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_metadata_json TEXT NOT NULL,
        output_metadata_json TEXT NOT NULL,
        error_json TEXT,
        verification_hints_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX skill_definitions_search_idx ON skill_definitions (enabled, health, category, name);
      CREATE INDEX skill_executions_history_idx ON skill_executions (skill_id, started_at, execution_id);
      CREATE INDEX skill_executions_idempotency_idx ON skill_executions (skill_id, idempotency_key, started_at);
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
