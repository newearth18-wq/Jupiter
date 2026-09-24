# SET 0–7 architecture

## Trust boundaries

```text
React product shell (sandboxed, no Node)
  -> frozen preload API with fixed bootstrap, RPC, cancellation, Core events, and chat-stream events
  -> Electron Main verifies exact webContents and origin
  -> strict versioned schema validation
  -> Jupiter Core capability dispatcher
  -> central deny-by-default Permission Engine
  -> provider-agnostic chat, durable Mission/Workflow, and executable Skill runtime ports
  -> SQLite (WAL, foreign keys, migrations, transactions) + Windows DPAPI credential vault
```

The renderer cannot import Node.js, Electron, filesystem, shell, or credential APIs. `contextIsolation`, `sandbox`, and `webSecurity` are enabled; `nodeIntegration` is disabled. Navigation, new windows, and permission requests are denied. IPC accepts data only—never executable code—and unknown request names fail the strict contract.

## Repository boundaries

- `apps/desktop`: Electron Main host gateway, DPAPI vault, narrow preload, localized React shell, service-backed screens, and Electron acceptance tests.
- `packages/contracts`: strict schemas for bootstrap, Core RPC/events, diagnostics, UI preferences, routes, AI, Mission, Workflow, Skills, permission requests/grants/decisions/audit, and transient stream events.
- `packages/core`: provider-neutral capability dispatcher, RPC gateway, persistent event bus, service lifecycle isolation, typed errors, structured logging, and runtime ports. Core contains no provider-specific code.
- `packages/database`: SQLite migrations and repositories for settings, ordered events, audit records, service health, AI metadata, conversations/messages, Mission/Workflow state, Skill definitions, permission state, and sanitized execution metadata.
- `packages/security`: central capability catalog and exact-match Permission Engine with deny-by-default authorization, one-time/session/persistent grants, revocation, and sanitized audit.
- `packages/ui`: reusable Visual Design Lock tokens and accessible primitives for buttons, surfaces, status, empty states, tabs, dialogs, and toasts.
- `services/ai-runtime`: dynamic provider registry, OpenAI-compatible adapter, capability/privacy model router, explicit fallback policy, and cancelable streaming chat orchestration.
- `services/mission-runtime`: explicit finite-state machine, durable attempts, transition audit, safe-boundary pause, cancellation propagation, retry linkage, and completion/partial-success guards.
- `services/workflow-runtime`: strict Planner validation, dependency scheduling, safe parallel batches, conditions, bounded retry/backoff, timeouts, checkpoints, idempotent attempt recovery, artifact passing, compensation, and versioned re-planning.
- `services/skill-runtime`: versioned executable registry, recursive schema validation, permission/time/health gates, cancellation, structured isolation of failures, sanitized history, four internal Skills, and Workflow executor adapters.
- Other reserved `services/*` and `plugins`: unavailable until their owning SETs.

## Product shell

The custom Windows title-bar overlay and compact sidebar expose all twelve required destinations. Home, Chat, Missions, Skills, AI Models, Settings, and Diagnostics have live behavior. Other screens render localized truthful availability states. The central Jupiter form retains the locked spherical core, orbital rings, restrained particles, and service-derived operational/degraded/offline state. Current Mission reads the latest durable Mission; controls are enabled only when the real state permits them.

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

## Mission boundary

Mission creation persists the actionable request immediately in `CREATED`. The finite-state machine accepts only declared transitions and stores rejected attempts with their reason. Each retry creates a linked execution attempt without erasing prior steps, errors, verification, or transitions. Pause waits for attached child runtimes to reach a safe boundary, while cancellation aborts and notifies attached work before changing state.

`COMPLETED` requires successful verification and no unresolved required step. `PARTIAL_SUCCESS` requires visible completed and incomplete outcomes. The detail UI reconstructs its human-readable timeline from normalized records and reports absent plan, Agent, Skill, Model, progress, and execution as not configured. SET 4 does not add a planner or agent executor.

## Persistence

Schema migration 4 adds Missions, executions, transitions, steps, declared permissions, artifacts, errors, and verification results with foreign keys and deterministic ordering. Migration 6 adds Skill definitions, health, and sanitized execution metadata. Migration 7 adds central permission requests, durable grants/revocations, and target-hashed audit; session grants never enter SQLite. Migration 3 provider/chat tables store no credential material. `ui.preferences` continues to store language, dark-theme variant, motion, avatar, density, text scale, and last view. Electron Main stores sanitized window bounds and maximized state under `ui.window-state`, validates them, and rejects off-screen restoration. Event cursors remain non-secret session state and prevent duplicate replay after renderer refresh.

## Workflow boundary

Planner model output is treated as untrusted data. It must satisfy the strict plan schema and semantic validation before persistence: dependency references must exist and be acyclic; skills and permissions must be declared and available or approved; artifacts must have a single producer and be consumed only through dependency ancestry. Invalid plans never enter the scheduler.

The engine persists plans, revisions, executions, step attempts, checkpoints, and artifact bindings before exposing state. Ready dependency nodes run concurrently; retries retain one idempotency key, timeouts abort the executor, pause waits for a safe batch boundary, and cancellation propagates to all active children. Restart recovery resumes durable `RUNNING` attempts using the same idempotency key. Approval and identity checkpoints enter `WAITING` and can only be resolved through Core-authorized RPC.

The Mission screen renders a data-backed workflow graph, revision, current statuses, attempts, dependencies, checkpoint state, assumptions, and verification plan. If no validated plan exists it shows `Not configured`. SET 6 connects the four declared internal Skills through the same Workflow executor port; no privileged or simulated executor is registered.

## Skill boundary

A Skill definition declares identity, semantic version, strict recursive input/output schemas, permissions, timeout, category, provider, and compatible runtime. Registry invocation validates metadata, enabled state, health, compatibility, exact declared/granted permissions, input, output, and terminal result. Timeout and cancellation abort the isolated invocation signal and return structured status; handler or schema failures are contained and cannot crash Core.

Only sanitized shape metadata—types, object keys, and collection/string lengths—is stored for inputs and outputs. Values, credentials, and secrets are not written to Skill history. The Skill Center reads registry state through typed RPC and exposes search/filter, health, enable/disable, version/runtime/permission metadata, and a safe test interface only for permission-free Jupiter internal Skills.

## Permission boundary

All privileged actions use the same typed Permission Engine through Core. A request declares capability, actor, requester type and identity, exact target and scope, Mission/session context, constraints, risk, user-facing reason, data leaving the device, consequence, and reversibility. Authorization matches every declared dimension; a missing capability, mismatch, expiry, or missing grant is denied.

`ALLOW_ONCE` is atomically consumed. `ALLOW_SESSION` exists only in process memory and expires on restart. `ALWAYS_ALLOW` persists until revoked. `CRITICAL` operations require an explicit user decision for every use and never offer `ALWAYS_ALLOW`; automated HIGH-risk work is also reduced to one-time approval. Durable grants and revocations are visible in Permission Center. Audit records contain a target fingerprint and bounded metadata keys, never the raw target, reason, document content, or credentials.

External content cannot request or resolve permissions, plugins cannot elevate themselves, and only authenticated Core/test actors may create a permission request. Renderer decisions are marked as explicit user authority. Provider credential configure/remove operations are real CRITICAL actions behind this boundary. Permission-declared Skills call the same engine before their handler can run; the four built-in low-risk Skills currently declare no privileged access.

## Deferred architecture

Privileged host adapters, external plugin loading/execution, the Agent runtime, Memory, Files/Artifact Manager, Automations, devices, computer/browser control, Identity Engine UI, and native Windows notifications remain unavailable. SET 7 defines requester contracts for these future runtimes but does not implement or simulate SET 8 capabilities.
