# Definition of done — SET 3

SET 3 is done only when:

- the full SET 0–2 verification remains green;
- providers can be dynamically added and removed without provider-specific changes to Jupiter Core;
- credentials are encrypted by OS-backed storage and never appear in renderer storage, SQLite, logs, or errors;
- invalid authentication and provider outages produce clear sanitized failures;
- model discovery and capability-aware routing support `AUTO`, `CLOUD`, `HYBRID`, and `LOCAL_ONLY`;
- `LOCAL_ONLY` dispatches no cloud request, and fallback is policy-controlled, approved, and recorded;
- Chat streams incrementally, Stop Generation aborts the active provider request, and retry/edit-resend are real;
- conversations and messages survive a database close/reopen;
- provider/model indicators, configuration actions, per-conversation routing, and structured tool-call display are available;
- attachments remain disabled and truthful until Artifact Manager exists;
- secret scan, format, lint, strict typecheck, unit tests, integration tests, production build, packaged smoke, and package validation pass;
- no SET 4 Mission backend has been started;
- evidence and limitations are reported from actual command output.
