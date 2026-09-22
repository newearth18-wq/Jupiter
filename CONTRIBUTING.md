# Contributing

## Scope discipline

Work on one Jupiter prompt SET at a time. Do not expose unfinished behavior as functional. Preserve user-created artifacts and report observed results only.

## Workflow

1. Read the Global Contract and current SET.
2. Inspect the repository and tests before editing.
3. Make the smallest compatible change behind typed, validated boundaries.
4. Add or update tests for success and failure paths.
5. Run `pnpm verify` on Windows.
6. Record limitations and evidence. A failed acceptance test blocks completion.

## Code requirements

- Strict TypeScript is mandatory.
- Renderer code cannot import Node.js or Electron modules.
- New cross-process data needs a versioned schema in `packages/contracts`.
- Never add credentials, tokens, raw private content, or biometric data to source, fixtures, logs, or screenshots.
- User-visible states must be truthful: `Unavailable`, `Not configured`, `Experimental`, or `Coming later` when appropriate.
