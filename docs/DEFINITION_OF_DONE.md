# Definition of done — SET 10

SET 10 is done only when:

- the full SET 0–9 verification remains green;
- controlled file discovery returns the real newest matching file after sort/filter;
- TXT, Markdown, PDF, DOCX, PPTX, XLSX, CSV, and JSON readers use real document bytes and return structured metadata or structured failure;
- generated DOCX, PPTX, XLSX, and PDF artifacts pass format-aware structural validation;
- PPTX generation supports the declared Jupiter/minimal theme, layouts, images, and notes;
- XLSX generation preserves explicit types/formulas, blocks external formula references, and neutralizes untrusted formula-like text;
- every verified generated artifact is linked to its Mission with source, exact path, size, SHA-256, verification details, version, and lineage metadata;
- managed writes are atomic and do not implicitly overwrite existing files;
- absolute paths, parent traversal, symlinks/junctions, and resolved approved-root escapes are rejected;
- file root approval, writes, artifact generation, Open/Reveal, and Delete use central typed permissions;
- Delete is CRITICAL, exact-target, never persistently allowed, and uses the host Recycle Bin operation;
- user-selected outputs are protected from managed cleanup;
- nonexistent and corrupt inputs fail without crashing Core, Electron, or the File Runtime;
- the Files UI is backed by real RPC state and Share is truthfully `Unavailable` until configured;
- the renderer retains sandboxing and has no direct Node integration;
- secret scan, format, lint, strict typecheck, unit tests, integration tests, production build, real Electron smoke, packaged smoke, and package validation pass;
- no SET 11 Automation capability has been started;
- evidence and limitations are reported from actual command output.
