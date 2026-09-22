# Jupiter

Jupiter is a Windows-first desktop AI agent. This repository currently contains **SET 0 and SET 1**: the reproducible delivery foundation, secure Electron shell, trusted Core coordination layer, typed IPC/event contracts, SQLite persistence, and real diagnostics.

No AI, Mission, automation, browser, computer-control, plugin, voice, vision, identity, or memory feature is implemented yet. The shell labels those capabilities `Coming later` or `Not configured`; the SET 1 capability dispatcher does not expose them.

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
