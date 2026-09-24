# Windows Computer Agent

SET 8 runs Windows automation in a dedicated PowerShell process behind a strict JSON request/response
boundary. Windows UI Automation and Win32 application APIs are used before semantic keyboard input.
Coordinate fallback is disabled unless the exact bounds receive a separate CRITICAL permission.

The initial adapters are Generic Windows, Notepad, and File Explorer. Action results and verified
artifact metadata are persisted, but typed text, UI-tree contents, and screenshot bytes are not logged.
The runtime supports application/window lifecycle and geometry, window enumeration/active-window
observation, semantic click/type/scroll/select/drag-drop, shortcuts, copy/paste, UI hierarchy reads,
screenshots, waits, and verified Notepad save actions.
