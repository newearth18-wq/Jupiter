# Definition of done — SET 1

SET 1 is done only when:

- the complete SET 0 verification remains green;
- a clean frozen-lockfile install succeeds;
- lint, strict type checking, unit tests, integration tests, production build, and package validation pass;
- valid IPC is correlated and malformed, unknown, or unauthorized input is rejected;
- the event stream is durable, ordered per Mission, and reconnects without duplicate replay;
- new and previous SQLite fixtures migrate, interrupted transactions roll back, and integrity remains valid;
- a failed service is visible in diagnostics without crashing the Electron app;
- the running renderer has no Node, arbitrary file, or credential API;
- the secret scan passes and logs/audit data remain sanitized;
- no SET 2 or later feature is represented as available;
- evidence and limitations are reported from actual command output.
