# Definition of done — SET 4

SET 4 is done only when:

- the full SET 0–3 verification remains green;
- an actionable request creates a normalized durable Mission and first execution attempt;
- only declared state transitions succeed, while invalid transitions preserve state and record their rejection reason;
- Mission detail, status, attempts, transitions, steps, permissions, artifacts, errors, verification, and timeline survive database close/reopen and renderer refresh;
- pause requests reach attached work at a safe boundary, cancellation propagates, and retry creates a linked attempt without erasing history;
- `COMPLETED` is blocked without successful verification or with unresolved required steps;
- `PARTIAL_SUCCESS` exposes both completed and incomplete outcomes;
- create, pause, resume, cancel, retry, archive, list, and detail actions are typed, validated, audited, and only enabled when real state permits;
- absent planning and execution data is shown as unavailable or not configured, never simulated;
- secret scan, format, lint, strict typecheck, unit tests, integration tests, production build, packaged smoke, and package validation pass;
- no SET 5 Planner or Agent execution has been started;
- evidence and limitations are reported from actual command output.
