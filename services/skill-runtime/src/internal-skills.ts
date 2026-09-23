import type { SkillDataSchema } from '@jupiter/contracts';
import type { SkillExecutable, SkillRuntime } from '@jupiter/core';

const emptyObject: SkillDataSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

export function createInternalSkills(
  version: string,
  listSkills: () => ReturnType<SkillRuntime['search']>,
  now: () => Date = () => new Date(),
): SkillExecutable[] {
  const common = {
    version: '1.0.0',
    permissions: [] as string[],
    timeoutMs: 5_000,
    category: 'internal.utility',
    provider: 'Jupiter',
    compatibleRuntime: `jupiter-core@${version}`,
  };
  return [
    {
      definition: {
        ...common,
        skillId: 'echo_text',
        name: 'Echo text',
        description: 'Returns the supplied text exactly as provided.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', maxLength: 10_000 } },
          required: ['text'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { text: { type: 'string', maxLength: 10_000 } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      execute: (input) =>
        Promise.resolve({
          output: input,
          verificationHints: ['Output text must exactly match input text.'],
        }),
    },
    {
      definition: {
        ...common,
        skillId: 'get_app_version',
        name: 'Get app version',
        description: 'Returns the running Jupiter application version.',
        inputSchema: emptyObject,
        outputSchema: {
          type: 'object',
          properties: { version: { type: 'string', minLength: 1, maxLength: 40 } },
          required: ['version'],
          additionalProperties: false,
        },
      },
      execute: () =>
        Promise.resolve({
          output: { version },
          verificationHints: ['Version is sourced from trusted build metadata.'],
        }),
    },
    {
      definition: {
        ...common,
        skillId: 'get_system_time',
        name: 'Get system time',
        description: 'Returns the current system time and local IANA time zone.',
        inputSchema: emptyObject,
        outputSchema: {
          type: 'object',
          properties: {
            iso: { type: 'string', minLength: 20, maxLength: 40 },
            timezone: { type: 'string', minLength: 1, maxLength: 120 },
          },
          required: ['iso', 'timezone'],
          additionalProperties: false,
        },
      },
      execute: () =>
        Promise.resolve({
          output: {
            iso: now().toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          },
          verificationHints: ['Timestamp is an ISO-8601 value generated at invocation time.'],
        }),
    },
    {
      definition: {
        ...common,
        skillId: 'list_available_skills',
        name: 'List available skills',
        description: 'Lists enabled healthy Jupiter Skills without exposing implementations.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', maxLength: 200 } },
          required: [],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            skills: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  skillId: { type: 'string' },
                  name: { type: 'string' },
                  version: { type: 'string' },
                  category: { type: 'string' },
                },
                required: ['skillId', 'name', 'version', 'category'],
                additionalProperties: false,
              },
            },
          },
          required: ['skills'],
          additionalProperties: false,
        },
      },
      execute: (input) => {
        const query = isRecord(input) && typeof input.query === 'string' ? input.query : '';
        const skills = listSkills()
          .filter((entry) => entry.enabled && entry.health === 'HEALTHY')
          .filter((entry) =>
            query
              ? `${entry.definition.skillId} ${entry.definition.name}`
                  .toLowerCase()
                  .includes(query.toLowerCase())
              : true,
          )
          .map((entry) => ({
            skillId: entry.definition.skillId,
            name: entry.definition.name,
            version: entry.definition.version,
            category: entry.definition.category,
          }));
        return Promise.resolve({
          output: { skills },
          verificationHints: ['Only enabled healthy Skills are listed.'],
        });
      },
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
