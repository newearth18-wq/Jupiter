# Jupiter database

SQLite persistence for migrations, settings, ordered domain events, sanitized audit records, service health, non-secret AI metadata, conversations/messages, normalized Mission/Workflow state, Skill definitions/health/execution history, and SET 7 permission state. Migration 6 stores Skill input/output shape metadata only. Migration 7 stores permission requests, durable grants/revocations, and sanitized audit with hashed targets; session grants stay in memory. The package uses the Node/Electron built-in `node:sqlite` runtime and never stores credentials.
