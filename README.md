# Jupiter

Jupiter is a Windows-first desktop AI agent. This repository currently contains **SET 0 through SET 9**: the reproducible delivery foundation, secure Core coordination layer, SQLite persistence, localized accessible product shell, provider-agnostic AI/chat, durable Mission and Workflow runtimes, an executable Skill Registry, a central deny-by-default Permission Engine, a permission-gated Windows Computer Agent, and an isolated Playwright Browser Agent built within Jupiter Visual Design Lock v1.

Chat becomes available only after the user configures and validates an installed OpenAI-compatible cloud or loopback provider. Provider credentials are encrypted by Electron `safeStorage` (Windows DPAPI), routing is policy-controlled, and conversations persist locally. Mission, workflow, sanitized Skill execution records, permission requests, durable grants, revocations, permission audit, Computer Agent actions, and redacted Browser Agent action records persist locally. SET 9 adds a persistent dedicated Playwright process controlling an isolated Microsoft Edge profile, semantic browser actions, managed/verified downloads, exact approved uploads, cancellation, prompt-injection signaling, and cross-origin pause. Automatic plan generation, Artifact Manager, Automation, plugin execution, voice, identity, and memory backends remain truthfully unavailable.

## Requirements

- Windows 10/11 x64
- Node.js 24 or newer
- pnpm 11.19.0 through Corepack

## Start

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

## Quality gates

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm package:windows
pnpm verify
```

The unpacked Windows application is written to `release/win-unpacked`. The NSIS installer is written to `release`.

See [architecture](docs/ARCHITECTURE.md), [contribution guide](CONTRIBUTING.md), [security principles](SECURITY.md), and [definition of done](docs/DEFINITION_OF_DONE.md).
