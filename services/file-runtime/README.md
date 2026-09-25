# File, Document, Office, and Artifact Runtime

SET 10 owns approved-root file discovery and mutation, bounded document extraction, verified Office/PDF generation, and per-Mission artifact management.

The runtime accepts only typed contracts from Core. Relative paths are resolved against a stored approved root, then checked against traversal, symlink/junction, and real-path escape. Writes require central permission and never overwrite an existing destination implicitly. Delete is an exact-target CRITICAL capability delegated to Electron Main's Recycle Bin action.

Supported reads: TXT, Markdown, PDF, DOCX, PPTX, XLSX, CSV, and JSON. Supported creation: TXT, Markdown, PDF, DOCX, PPTX, XLSX, CSV, and JSON. Generated artifacts are structurally validated, written atomically, read back, SHA-256 hashed, and persisted with Mission/source/version/lineage metadata before being reported as verified.

Share is intentionally unavailable until a destination integration is explicitly configured.
