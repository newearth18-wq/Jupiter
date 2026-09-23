# Definition of done — SET 5

SET 5 is done only when:

- the full SET 0–4 verification remains green;
- strict plan contracts include goal, assumptions, typed steps, skills, permissions, artifacts, verification, rationale, revision, and prior-plan linkage;
- malformed plans, missing dependencies, cycles, unavailable skills, unapproved permissions, and ambiguous artifact flow are rejected before execution;
- dependency order, safe parallel execution, conditions, bounded retry/backoff, timeout, pause/resume, cancellation propagation, checkpoints, artifact passing, idempotency, compensation, and verification use durable state;
- restart recovery preserves the execution and idempotency key instead of creating duplicate logical work;
- re-planning creates a linked immutable revision and retains failed history;
- the Mission UI shows the real workflow graph, attempts, status, checkpoints, revision, assumptions, and verification plan, or a truthful `Not configured` state;
- renderer actors can read and control existing workflows but cannot inject Planner output or resolve protected checkpoints;
- secret scan, format, lint, strict typecheck, unit tests, integration tests, production build, packaged smoke, and package validation pass;
- no fake executor or SET 6 Skill Registry/Agent implementation has been started;
- evidence and limitations are reported from actual command output.
