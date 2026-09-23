# Jupiter database

SQLite persistence for migrations, settings, ordered domain events, sanitized audit records, service health, non-secret AI provider/model metadata, routing settings, durable conversations/messages, and normalized Mission records (executions, transitions, steps, permissions, artifacts, errors, and verification). The package uses the Node/Electron built-in `node:sqlite` runtime and never stores credentials.
