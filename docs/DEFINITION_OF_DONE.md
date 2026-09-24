# Definition of done — SET 7

SET 7 is done only when:

- the full SET 0–6 verification remains green;
- undeclared capabilities and requests without an exact matching grant are denied;
- Core, Skills, future Agent/plugin/automation requesters, and UI use one typed permission contract;
- plugin or external-content trust sources cannot request, resolve, or elevate permissions;
- `DENY`, `ALLOW_ONCE`, `ALLOW_SESSION`, and `ALWAYS_ALLOW` follow their declared lifetime and exact-match rules;
- `ALLOW_ONCE` is consumed exactly once and session grants disappear with the process;
- CRITICAL actions always require explicit user approval and never offer persistent allow;
- persistent grants can be viewed and revoked, and revocation takes effect immediately;
- target, scope, actor, Mission, session, constraints, expiry, and requester identity are all matched;
- every authorization decision produces a sanitized audit record;
- Permission Center displays the complete action, reason, exact target/scope, risk, requester, data exposure, consequence, and reversibility from real Core data;
- provider credential configure/remove and permission-declared Skill invocation use the central engine;
- secret scan, format, lint, strict typecheck, unit tests, integration tests, production build, packaged smoke, and package validation pass;
- no SET 8 runtime or later capability has been started;
- evidence and limitations are reported from actual command output.
