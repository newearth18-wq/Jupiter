# Jupiter

Jupiter is a Windows-first desktop AI agent. This repository currently contains **SET 0 through SET 6**: the reproducible delivery foundation, secure Core coordination layer, SQLite persistence, localized accessible product shell, provider-agnostic AI/chat, durable Mission and Workflow runtimes, and an executable Skill Registry built within Jupiter Visual Design Lock v1.

Chat becomes available only after the user configures and validates an installed OpenAI-compatible cloud or loopback provider. Provider credentials are encrypted by Electron `safeStorage` (Windows DPAPI), routing is policy-controlled, and conversations persist locally. Mission, workflow, and sanitized Skill execution records persist locally. SET 6 supplies four real low-risk internal Skills (`echo_text`, `get_app_version`, `get_system_time`, and `list_available_skills`) through a strict, cancellable, permission-declared registry. Automatic plan generation, privileged Skills, Artifact Manager, Automation, browser/computer control, plugin runtime, voice, identity, and memory backends remain truthfully unavailable.

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
