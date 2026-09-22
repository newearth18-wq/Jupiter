# SET 0 architecture

## Trust boundaries

```text
React renderer (sandboxed, no Node)
  -> frozen preload API with two allowlisted calls
  -> Electron Main validates request and response schemas
  -> foundation runtime health + structured logger
```

The renderer cannot import Node.js, Electron, filesystem, shell, or credential APIs. `contextIsolation`, `sandbox`, and `webSecurity` are enabled; `nodeIntegration` is disabled. Navigation and new-window creation are denied.

## Repository boundaries

- `apps/desktop`: Electron Main, narrow preload, React renderer, smoke integration tests.
- `packages/contracts`: versioned SET 0 bootstrap schemas shared across the process boundary.
- `packages/core`: framework-independent structured logging foundation.
- `services/*`: reserved process boundaries, explicitly unavailable until their owning SET.
- `packages/database`, `security`, `ui`, `testing`: reserved module boundaries, not implementations.
- `plugins`: reserved for the isolated plugin work in SET 15.

## Startup and recovery

Main initializes the foundation runtime before publishing bootstrap state. A startup exception is sanitized and converted to a `degraded` state with a real retry action; the UI remains available. The test-only environment switch `JUPITER_FORCE_STARTUP_FAILURE=1` exercises this path and is not a simulated success.

## Metadata

`scripts/generate-build-metadata.mjs` creates build metadata from the desktop package version, environment channel, Git commit when available, target platform, and build timestamp. The renderer receives the running application's version from `app.getVersion()` and never embeds a UI version string.

## Deferred architecture

Mission orchestration, generalized IPC/event buses, database migrations, permissions, agents, providers, plugins, and full diagnostics belong to later SETs. They are not partially implemented here.
