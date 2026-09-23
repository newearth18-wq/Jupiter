# Definition of done — SET 6

SET 6 is done only when:

- the full SET 0–5 verification remains green;
- valid Skills register with versioned metadata while invalid definitions and schemas are rejected;
- input, output, permissions, timeout, enabled state, health, compatibility, and results are validated at the registry boundary;
- `echo_text` returns exact input and all four required internal Skills are registered and healthy;
- timeout and cancellation terminate or isolate invocation work and return structured terminal results;
- disabled or permission-invalid Skills cannot enter their handler;
- broken handlers and invalid output schemas become structured failures without crashing Core;
- Skill execution history stores sanitized shape metadata rather than input/output values or secrets;
- Workflow execution reaches Skills only through the typed registry adapter and invocation context;
- Skill Center shows provider, category, enabled state, permissions, version, health, last check, runtime, search/filter, and safe internal tests using real Core data;
- secret scan, format, lint, strict typecheck, unit tests, integration tests, production build, packaged smoke, and package validation pass;
- no SET 7 Agent runtime or later capability has been started;
- evidence and limitations are reported from actual command output.
