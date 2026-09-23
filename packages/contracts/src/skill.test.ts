import { describe, expect, it } from 'vitest';
import { SkillDefinitionSchema } from './skill.js';

describe('Skill contracts', () => {
  it('accepts a strict executable Skill definition', () => {
    const parsed = SkillDefinitionSchema.parse({
      skillId: 'echo_text',
      name: 'Echo text',
      description: 'Returns text.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      permissions: [],
      timeoutMs: 1_000,
      category: 'internal.utility',
      provider: 'Jupiter',
      compatibleRuntime: 'jupiter-core@0.1.0',
    });
    expect(parsed.skillId).toBe('echo_text');
  });

  it('rejects undeclared metadata fields and invalid timeout', () => {
    expect(
      SkillDefinitionSchema.safeParse({
        skillId: 'invalid',
        name: 'Invalid',
        description: 'Invalid Skill.',
        version: '1.0.0',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        permissions: [],
        timeoutMs: 0,
        category: 'test',
        provider: 'Test',
        compatibleRuntime: 'jupiter-core@0.1.0',
        prompt: 'not allowed',
      }).success,
    ).toBe(false);
  });
});
