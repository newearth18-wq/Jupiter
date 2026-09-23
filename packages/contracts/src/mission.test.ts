import { describe, expect, it } from 'vitest';
import { MissionDetailSchema, MissionStatusSchema } from './mission.js';

describe('mission contracts', () => {
  it('contains every locked Mission state', () => {
    expect(MissionStatusSchema.options).toHaveLength(13);
    expect(MissionStatusSchema.options).toContain('PARTIAL_SUCCESS');
  });

  it('rejects incomplete detail records at the boundary', () => {
    expect(MissionDetailSchema.safeParse({ mission: {} }).success).toBe(false);
  });
});
