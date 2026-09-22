# SET 0–2 architecture

## Trust boundaries

```text
React product shell (sandboxed, no Node)
  -> frozen preload API with fixed bootstrap, RPC, cancellation, and event methods
  -> Electron Main verifies exact webContents and origin
  -> strict versioned schema validation
  -> Jupiter Core capability dispatcher
  -> repository interfaces
  -> SQLite (WAL, foreign keys, migrations, transactions)
```

The renderer cannot import Node.js, Electron, filesystem, shell, or credential APIs. `contextIsolation`, `sandbox`, and `webSecurity` are enabled; `nodeIntegration` is disabled. Navigation, new windows, and permission requests are denied. IPC accepts data only—never executable code—and unknown request names fail the strict contract.

## Repository boundaries

- `apps/desktop`: Electron Main host gateway, narrow preload, localized React shell, service-backed screens, and Electron acceptance tests.
- `packages/contracts`: strict schemas for bootstrap, Core RPC/events, diagnostics, UI preferences, routes, and window state.
- `packages/core`: capability dispatcher, RPC gateway, persistent event bus, service lifecycle isolation, typed errors, structured logging, and UI-preference capabilities.
- `packages/database`: SQLite migrations and repositories for settings, ordered events, audit records, and service health.
- `packages/ui`: reusable Visual Design Lock tokens and accessible primitives for buttons, surfaces, status, empty states, tabs, dialogs, and toasts.
- `services/*`, `packages/security`, and `plugins`: reserved and unavailable until their owning SETs.

## Product shell

The custom Windows title-bar overlay and compact sidebar expose all twelve required destinations. Only Home, Settings, and Diagnostics have live SET 2 behavior. Other screens render localized truthful availability states. The central Jupiter form uses the locked spherical core, orbital rings, restrained particles, and service-derived operational/degraded/offline state. The Current Mission and Chat shells remain disabled because their backends are not implemented.

## Localization and accessibility

All interface copy is selected from complete English and Thai dictionaries. The document language changes immediately and Thai uses the locked font stack and expanded line height. Navigation, forms, roving-tab tabs, modal focus trapping/restoration, skip links, live toasts, focus indicators, and keyboard shortcuts use semantic browser behavior.

Shortcuts:

- `Alt+1`: Home
- `Ctrl+,`: Settings
- `Ctrl+Shift+D`: Diagnostics

Reduce Motion disables nonessential avatar animation. Static Avatar, Hide Avatar, compact mode, and 90–125% text scaling are persisted through typed Core capabilities.

## Persistence

SET 2 reuses the existing `settings` table; no schema migration is required. `ui.preferences` stores language, dark-theme variant, motion, avatar, density, text scale, and last view. Electron Main stores sanitized window bounds and maximized state under `ui.window-state`, validates them, and rejects off-screen restoration. Event cursors remain non-secret session state and prevent duplicate replay after renderer refresh.

## Deferred architecture

Mission execution, AI/chat providers, Skills, Memory, Files/Artifacts, Automations, devices, plugins, Permission Engine, Identity Engine, and native Windows notifications remain unavailable. SET 2 supplies accessible interface shells only and does not implement or simulate later-SET behavior.
