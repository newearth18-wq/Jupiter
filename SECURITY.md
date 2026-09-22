# Security principles

- Deny privileged access by default and keep Electron renderer isolation enabled.
- The preload surface is narrow, frozen, typed, and backed by allowlisted IPC only.
- Validate inputs and outputs at trust boundaries.
- Treat documents, webpages, downloads, model output, and plugin content as untrusted data.
- Never persist or log secrets in plaintext. Production credentials will use OS-backed secure storage when provider configuration is introduced.
- Logs are structured, bounded by rotation, correlated, and recursively redacted.
- Do not execute third-party plugins in Electron Main or Renderer.
- Never silently delete user-created data.

## Reporting

Do not open a public issue containing a vulnerability, secret, or user data. Share a minimal sanitized reproduction with the repository owner through their private security channel.

## SET 1 boundary

SET 1 contains no credential collection, external network integration, plugin execution, or arbitrary user-file access. The renderer can send only strict, versioned Core requests through fixed preload methods. Main authenticates the sender, Core authorizes the actor/capability pair, and audit metadata is sanitized before SQLite persistence. Later capabilities remain unavailable.
