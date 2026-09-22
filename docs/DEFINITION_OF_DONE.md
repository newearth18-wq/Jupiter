# Definition of done — SET 0

SET 0 is done only when:

- a clean frozen-lockfile install succeeds;
- lint, strict type checking, unit tests, integration tests, production build, and package validation pass;
- a real Electron window loads in development and production smoke runs;
- the Windows installer or validated unpacked package is produced;
- renderer isolation is measured in the running app;
- the failure-recovery integration test proves a startup failure is shown truthfully;
- the secret scan passes and logs redact sensitive fields;
- documentation and CI describe the same commands;
- no later-SET feature is represented as available;
- evidence and limitations are reported from actual command output.
