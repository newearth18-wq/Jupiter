# SET 0–3 architecture

## Trust boundaries

```text
React product shell (sandboxed, no Node)
  -> frozen preload API with fixed bootstrap, RPC, cancellation, Core events, and chat-stream events
  -> Electron Main verifies exact webContents and origin
  -> strict versioned schema validation
  -> Jupiter Core capability dispatcher
  -> provider-agnostic chat/runtime port and repository interfaces
  -> SQLite (WAL, foreign keys, migrations, transactions) + Windows DPAPI credential vault
```

The renderer cannot import Node.js, Electron, filesystem, shell, or credential APIs. `contextIsolation`, `sandbox`, and `webSecurity` are enabled; `nodeIntegration` is disabled. Navigation, new windows, and permission requests are denied. IPC accepts data only—never executable code—and unknown request names fail the strict contract.

## Repository boundaries

- `apps/desktop`: Electron Main host gateway, DPAPI vault, narrow preload, localized React shell, service-backed screens, and Electron acceptance tests.
- `packages/contracts`: strict schemas for bootstrap, Core RPC/events, diagnostics, UI preferences, routes, AI providers/models/settings, conversations, messages, and transient stream events.
- `packages/core`: provider-neutral capability dispatcher, RPC gateway, persistent event bus, service lifecycle isolation, typed errors, structured logging, and runtime ports. Core contains no provider-specific code.
- `packages/database`: SQLite migrations and repositories for settings, ordered events, audit records, service health, non-secret provider/model metadata, routing settings, conversations, and messages.
- `packages/ui`: reusable Visual Design Lock tokens and accessible primitives for buttons, surfaces, status, empty states, tabs, dialogs, and toasts.
- `services/ai-runtime`: dynamic provider registry, OpenAI-compatible adapter, capability/privacy model router, explicit fallback policy, and cancelable streaming chat orchestration.
- Other `services/*`, `packages/security`, and `plugins`: reserved and unavailable until their owning SETs.

## Product shell

The custom Windows title-bar overlay and compact sidebar expose all twelve required destinations. Home, Chat, AI Models, Settings, and Diagnostics have live behavior. Other screens render localized truthful availability states. The central Jupiter form retains the locked spherical core, orbital rings, restrained particles, and service-derived operational/degraded/offline state. Current Mission remains disabled because its backend belongs to a later SET.

## AI provider and chat boundary

Provider adapters implement a typed contract for validation, model discovery, capability metadata, streaming chat, cancellation, usage, health, and sanitized failures. Adapters can be registered or removed in `services/ai-runtime` without modifying Jupiter Core. The initial adapter speaks the configured OpenAI-compatible HTTP/SSE protocol and does not assume any commercial provider is available.

Renderer requests cross strict RPC schemas; only incremental, validated chat events return through the fixed preload bridge. Credentials never cross back to the renderer. Electron Main stores bearer credentials as encrypted binary data through `safeStorage`, using hashed filenames, and persists only status plus a short non-secret fingerprint in SQLite. Logs and error objects receive sanitized metadata, never provider response bodies or authorization headers.

The router filters by requested capability and the active `AUTO`, `CLOUD`, `HYBRID`, or `LOCAL_ONLY` mode before any adapter request. `LOCAL_ONLY` excludes cloud providers at that boundary. Fallback is disabled, same-locality only, or restricted to an explicit approved-provider list; a used fallback is recorded as redacted Core event metadata. No eligible model returns a configuration error rather than generated content.

Streaming deltas are transient UI events while completed, cancelled, or failed messages are durable. Stop Generation aborts the active request. Retry and edit/resend create new durable messages; conversation routing can override the global provider/model policy. Attachment references are typed for the future Artifact Manager, but the control remains disabled and labeled unavailable until that manager exists. Tool calls are displayed structurally and are not executed in SET 3.

## Localization and accessibility

All interface copy is selected from complete English and Thai dictionaries. The document language changes immediately and Thai uses the locked font stack and expanded line height. Navigation, forms, roving-tab tabs, modal focus trapping/restoration, skip links, live toasts, focus indicators, and keyboard shortcuts use semantic browser behavior.

Shortcuts:

- `Alt+1`: Home
- `Ctrl+,`: Settings
- `Ctrl+Shift+D`: Diagnostics

Reduce Motion disables nonessential avatar animation. Static Avatar, Hide Avatar, compact mode, and 90–125% text scaling are persisted through typed Core capabilities.

## Persistence

Schema migration 3 adds providers, discovered models, AI settings, conversations, and ordered chat messages. It stores no credential material. `ui.preferences` continues to store language, dark-theme variant, motion, avatar, density, text scale, and last view. Electron Main stores sanitized window bounds and maximized state under `ui.window-state`, validates them, and rejects off-screen restoration. Event cursors remain non-secret session state and prevent duplicate replay after renderer refresh.

## Deferred architecture

Mission execution, Skills, Memory, Files/Artifacts, Automations, devices, plugins, Permission Engine, Identity Engine, and native Windows notifications remain unavailable. SET 3 does not execute tool calls or begin Mission behavior.
