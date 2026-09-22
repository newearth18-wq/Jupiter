# SET 0–1 architecture

## Trust boundaries

```text
React renderer (sandboxed, no Node)
  -> frozen preload API with fixed bootstrap, RPC, cancellation, and event methods
  -> Electron Main verifies the exact webContents and origin
  -> central versioned schema validation
  -> Jupiter Core capability dispatcher
  -> repository interfaces
  -> SQLite (WAL, foreign keys, migrations, transactions)
```

The renderer cannot import Node.js, Electron, filesystem, shell, or credential APIs. `contextIsolation`, `sandbox`, and `webSecurity` are enabled; `nodeIntegration` is disabled. Navigation, new windows, and permission requests are denied. IPC accepts data only—never executable code—and unknown request names fail the strict contract.

## Repository boundaries

- `apps/desktop`: Electron Main host gateway, narrow preload, React renderer, real diagnostics, and Electron smoke tests.
- `packages/contracts`: strict versioned schemas for bootstrap, commands, queries, results, errors, progress, audit, health, and domain events.
- `packages/core`: framework-independent capability dispatcher, RPC gateway, persistent event bus, service lifecycle isolation, typed errors, and structured logging.
- `packages/database`: SQLite migrations and repositories for settings, ordered events, audit records, and service health.
- `services/*`: reserved process boundaries, explicitly unavailable until their owning SET.
- `packages/security`, `ui`, `testing`: reserved module boundaries, not later-SET implementations.
- `plugins`: reserved for the isolated plugin work in SET 15.

## Correlation and validation

Every Core request carries a UUID `requestId`, actor, and timestamp, with optional Mission, execution, and cancellation identifiers. Main authenticates renderer calls as `renderer`; a payload cannot elevate itself by claiming another actor. The RPC gateway validates the complete request before dispatch, validates method-specific results, records a sanitized audit decision, and returns a typed error envelope.

## Events and reconnection

Core persists each domain event before notifying subscribers. SQLite assigns a global sequence and a transactionally allocated per-Mission stream sequence. Renderer reconnection stores only the last non-secret global cursor in `sessionStorage`, replays events after that cursor, and ignores an already-consumed sequence. Refresh smoke coverage verifies that replay does not duplicate persistent events.

## Persistence and recovery

SQLite uses ordered migrations, `WAL`, `foreign_keys=ON`, full synchronization, and immediate transactions. Initial tables are `settings`, `events`, `audit_log`, `schema_migrations`, and `service_health`. The database module exposes a backup hook but no user-facing backup workflow yet. Migration and rollback tests use isolated fixtures and never modify user data.

## Service lifecycle and diagnostics

Services start and stop through the Core service manager. A service exception is sanitized, persisted as failed/degraded health, and emitted as a domain event without terminating unrelated services or the Electron shell. Diagnostics reports actual application/Core versions, service health, SQLite schema and safety state, record counts, integrity, and recent sanitized service errors.

## Deferred architecture

Mission orchestration, workflows, Skills, permissions, identity, model routing, artifacts, agents, providers, plugins, and the full product shell remain unavailable. They are not represented as working and belong to later SETs.
