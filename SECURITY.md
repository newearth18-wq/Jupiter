# Security principles

- Deny privileged access by default and keep Electron renderer isolation enabled.
- The preload surface is narrow, frozen, typed, and backed by allowlisted IPC only.
- Validate inputs and outputs at trust boundaries.
- Treat documents, webpages, downloads, model output, and plugin content as untrusted data.
- Never persist or log secrets in plaintext. Provider credentials use Electron `safeStorage` backed by Windows DPAPI and are kept outside SQLite, logs, renderer storage, crash evidence, and exported settings.
- Logs are structured, bounded by rotation, correlated, and recursively redacted.
- Do not execute third-party plugins in Electron Main or Renderer.
- Never silently delete user-created data.

## Reporting

Do not open a public issue containing a vulnerability, secret, or user data. Share a minimal sanitized reproduction with the repository owner through their private security channel.

## SET 3 credential and provider boundary

Only Electron Main can read the encrypted credential vault. Credential values are accepted by the validated provider-configuration RPC and are cleared from renderer form state after submission; only authentication state, validation time, and a short fingerprint return. Provider HTTP failures are mapped to bounded sanitized errors without response bodies. Cloud endpoints require HTTPS, local endpoints require loopback addresses, and URLs containing credentials, query strings, or fragments are rejected.

`LOCAL_ONLY` removes cloud providers before dispatch, so chat data cannot reach a cloud adapter under that mode. Fallback is opt-in and constrained by policy; local-to-cloud switching is never silent. Provider/model output and structured tool-call data remain untrusted data and SET 3 never executes tool calls. Plugin execution and arbitrary user-file access remain unavailable.
