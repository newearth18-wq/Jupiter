# Jupiter

Jupiter is a Windows-first desktop AI agent. This repository currently contains **SET 0 through SET 2**: the reproducible delivery foundation, secure Core coordination layer, SQLite persistence, and a localized accessible product shell built from Jupiter Visual Design Lock v1.

No AI, Mission execution, automation, browser, computer-control, plugin runtime, voice, vision, identity, or memory backend is implemented yet. Every corresponding SET 2 screen labels the capability `Unavailable`, `Not configured`, or `Coming later`; no deferred control reports simulated success.

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
