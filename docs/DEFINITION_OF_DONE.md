# Definition of done — SET 9

SET 9 is done only when:

- the full SET 0–8 verification remains green;
- a real isolated Edge session opens through Playwright in a dedicated process;
- a local fixture supports semantic search, typed interaction, and structured extraction;
- downloads land only in managed storage and pass filename, type, size, path, and hash validation;
- uploads use only an exact permission-approved path, type, size, and origin;
- page prompt injection is reported as untrusted content and cannot change the action plan;
- unexpected cross-origin navigation pauses with a blocked security signal;
- cancellation and browser-process crashes remain contained outside Core and Electron;
- temporary profiles are default, while persistent profiles are named opt-in and never import the main browser profile;
- login submission is MEDIUM risk, message submission HIGH, and purchase submission CRITICAL;
- action results include URL, origin, title, observation, extraction/evidence, errors, and timestamps when applicable;
- persisted history excludes page text and extracted values while retaining verified evidence metadata;
- the renderer retains sandboxing and has no direct Node integration;
- secret scan, format, lint, strict typecheck, unit tests, integration tests, production build, packaged smoke, and package validation pass;
- no SET 10 Artifact Manager or later capability has been started;
- evidence and limitations are reported from actual command output.
