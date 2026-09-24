# Permission and security engine

SET 7 provides Jupiter's central deny-by-default capability policy. Requests carry the complete
user-facing action, reason, exact target/scope, requester, data exposure, consequence, reversibility,
automation state, and constraints. Grants match every security dimension exactly.

`ALLOW_SESSION` grants are memory-only and disappear when the runtime stops. `ALLOW_ONCE` is consumed
transactionally. `CRITICAL` requests allow only explicit `ALLOW_ONCE` or `DENY`. Audit records keep a
SHA-256 target fingerprint and bounded metadata keys rather than raw targets, prompts, or secrets.

SET 8 Computer Agent actions use this engine through declared capabilities and exact target, scope,
requester, and constraint matching. CRITICAL Notepad demonstrations and coordinate fallbacks are
one-time approvals only; the security package itself still contains no operating-system adapter.
