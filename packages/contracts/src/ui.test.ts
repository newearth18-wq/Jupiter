import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_PREFERENCES,
  UiPreferencesSchema,
  UiPreferencesUpdateSchema,
  WindowStateSchema,
} from './ui.js';

describe('UI contracts', () => {
  it('accepts the complete default preferences and strict partial updates', () => {
    expect(UiPreferencesSchema.parse(DEFAULT_UI_PREFERENCES)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(UiPreferencesUpdateSchema.safeParse({ language: 'th' }).success).toBe(true);
    expect(UiPreferencesUpdateSchema.safeParse({}).success).toBe(false);
    expect(UiPreferencesUpdateSchema.safeParse({ language: 'th', secret: 'value' }).success).toBe(
      false,
    );
  });

  it('rejects unsafe or unusable persisted window dimensions', () => {
    expect(
      WindowStateSchema.safeParse({ x: 0, y: 0, width: 1180, height: 760, maximized: false })
        .success,
    ).toBe(true);
    expect(
      WindowStateSchema.safeParse({ x: 0, y: 0, width: 200, height: 100, maximized: false })
        .success,
    ).toBe(false);
  });
});
