# Definition of done — SET 8

SET 8 is done only when:

- the full SET 0–7 verification remains green;
- a dedicated automation process contains crashes and accepts only strict typed JSON actions/results;
- Generic Windows, Notepad, and File Explorer adapters report their actual supported actions;
- a real Notepad process opens, receives `Hello Jupiter` through semantic UI Automation, saves to the exact approved path, and closes;
- the saved file exists, has exact content, and returns verified artifact metadata before success;
- a missing semantic control returns a structured failure and never reports success;
- cancellation interrupts the active isolated action at a safe process boundary;
- semantic selectors contain no screen-resolution coordinates;
- coordinate fallback requires separate CRITICAL permission, exact bounded coordinates, explicit result labeling, and permission audit;
- all action results include action, target, success, observation, optional evidence, structured error, and timestamps;
- persisted action history excludes typed text, UI-tree contents, screenshot bytes, and raw permission targets;
- the renderer retains sandboxing and has no direct Node integration;
- secret scan, format, lint, strict typecheck, unit tests, integration tests, production build, packaged smoke, and package validation pass;
- no SET 9 runtime or later capability has been started;
- evidence and limitations are reported from actual command output.
