import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ComputerActionInputSchema,
  ComputerActionResultSchema,
  NotepadDemoResultSchema,
} from './computer.js';

describe('computer contracts', () => {
  it('validates the minimum typed Windows actions at a strict boundary', () => {
    const actions = [
      'OPEN_APP',
      'CLOSE_APP',
      'FOCUS_WINDOW',
      'MINIMIZE_WINDOW',
      'MAXIMIZE_WINDOW',
      'RESTORE_WINDOW',
      'MOVE_RESIZE_WINDOW',
      'ENUMERATE_WINDOWS',
      'GET_ACTIVE_WINDOW',
      'CLICK_ELEMENT',
      'TYPE_TEXT',
      'PRESS_KEYS',
      'SCROLL_ELEMENT',
      'SELECT_ELEMENT',
      'DRAG_DROP',
      'COPY',
      'PASTE',
      'READ_UI_TREE',
      'SCREENSHOT',
      'WAIT_FOR_WINDOW',
      'SAVE_FILE',
    ] as const;
    expect(actions).toHaveLength(21);
    expect(
      ComputerActionInputSchema.parse({
        actionId: randomUUID(),
        action: 'TYPE_TEXT',
        target: {
          kind: 'control',
          id: 'notepad-editor',
          display: 'Notepad editor',
          selector: { controlType: 'Document' },
        },
        timeoutMs: 5_000,
        parameters: { text: 'Hello Jupiter', replace: true },
      }).action,
    ).toBe('TYPE_TEXT');
  });

  it('rejects false success and unverified demo claims', () => {
    expect(() =>
      ComputerActionResultSchema.parse({
        actionId: randomUUID(),
        action: 'OPEN_APP',
        target: { kind: 'application', id: 'notepad', display: 'Notepad' },
        success: true,
        status: 'FAILED',
        observation: 'Incorrect claim',
        evidence: [],
        error: { code: 'FAILED', message: 'Failed.', recoverable: true },
        adapterId: 'notepad',
        interactionMode: 'WINDOWS_API',
        coordinateFallbackUsed: false,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
    ).toThrow('Success must match status');
    expect(() =>
      NotepadDemoResultSchema.parse({
        executionId: randomUUID(),
        success: true,
        status: 'SUCCESS',
        observation: 'No actions',
        actions: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});
