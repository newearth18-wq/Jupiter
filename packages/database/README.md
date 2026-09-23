# Jupiter database

SQLite persistence for migrations, settings, ordered domain events, sanitized audit records, service health, non-secret AI metadata, conversations/messages, normalized Mission/Workflow state, and SET 6 Skill definitions, health, and execution history. Migration 6 stores input/output shape metadata only—not Skill values or credentials. The package uses the Node/Electron built-in `node:sqlite` runtime and never stores credentials.
