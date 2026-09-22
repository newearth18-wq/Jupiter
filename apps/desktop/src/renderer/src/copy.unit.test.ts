import { describe, expect, it } from 'vitest';
import { createTranslator } from './copy.js';

describe('localized copy', () => {
  it('provides real Thai and English strings without a restart', () => {
    expect(createTranslator('en')('settingsTitle')).toBe('Settings');
    expect(createTranslator('th')('settingsTitle')).toBe('การตั้งค่า');
    expect(createTranslator('th')('homeTitle')).toContain('พร้อม');
  });
});
