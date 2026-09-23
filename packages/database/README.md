# Jupiter database

SQLite persistence for migrations, settings, ordered domain events, sanitized audit records, service health, non-secret AI provider/model metadata, routing settings, durable conversations/messages, normalized Mission records, and SET 5 workflow plans, revisions, executions, step attempts, checkpoints, and artifact bindings. Schema migration 5 keeps workflow history normalized and restart-recoverable. The package uses the Node/Electron built-in `node:sqlite` runtime and never stores credentials.
