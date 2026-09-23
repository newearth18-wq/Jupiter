import { randomUUID } from 'node:crypto';
import {
  SkillDefinitionSchema,
  SkillExecutionRecordSchema,
  SkillExecutionResultSchema,
  SkillInvocationSchema,
  SkillLookupInputSchema,
  SkillRegistryEntrySchema,
  SkillSearchInputSchema,
  type SkillDataSchema,
  type SkillExecutionResult,
  type SkillInvocation,
  type SkillLookupInput,
  type SkillRegistryEntry,
  type SkillSearchInput,
} from '@jupiter/contracts';
import {
  JupiterError,
  type SkillExecutable,
  type SkillRepository,
  type SkillRuntime,
  type WorkflowStepExecutor,
} from '@jupiter/core';

export type SkillRegistryDependencies = {
  repository: SkillRepository;
  runtimeVersion: string;
  now?: () => Date;
  recordEvent?: (event: {
    type: string;
    missionId: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: string;
  }) => void;
};

export class ExecutableSkillRegistry implements SkillRuntime {
  readonly #repository: SkillRepository;
  readonly #runtimeVersion: string;
  readonly #now: () => Date;
  readonly #recordEvent: SkillRegistryDependencies['recordEvent'];
  readonly #executables = new Map<string, SkillExecutable>();
  readonly #active = new Map<string, AbortController>();

  constructor(dependencies: SkillRegistryDependencies) {
    this.#repository = dependencies.repository;
    this.#runtimeVersion = dependencies.runtimeVersion;
    this.#now = dependencies.now ?? (() => new Date());
    this.#recordEvent = dependencies.recordEvent;
  }

  register(skill: SkillExecutable): SkillRegistryEntry {
    const definition = validateDefinition(skill.definition);
    const key = versionKey(definition.skillId, definition.version);
    if (this.#executables.has(key))
      throw skillError('SKILL_DUPLICATE', 'Skill version is already registered.');
    const existing = this.#repository.getSkill(definition.skillId, definition.version);
    const timestamp = this.#timestamp();
    const compatible = definition.compatibleRuntime === `jupiter-core@${this.#runtimeVersion}`;
    const entry = SkillRegistryEntrySchema.parse({
      definition,
      enabled: existing?.enabled ?? true,
      health: compatible ? 'UNKNOWN' : 'UNHEALTHY',
      ...(compatible ? {} : { sanitizedError: 'Skill runtime is incompatible.' }),
      registeredAt: existing?.registeredAt ?? timestamp,
      updatedAt: timestamp,
    });
    this.#executables.set(key, { ...skill, definition });
    this.#repository.upsertSkill(entry);
    return entry;
  }

  unregister(skillId: string, version: string): boolean {
    const removed = this.#executables.delete(versionKey(skillId, version));
    if (removed) this.#repository.removeSkill(skillId, version);
    return removed;
  }

  get(input: SkillLookupInput): SkillRegistryEntry | undefined {
    const valid = SkillLookupInputSchema.parse(input);
    return valid.version
      ? this.#repository.getSkill(valid.skillId, valid.version)
      : this.#latestEntry(valid.skillId);
  }

  search(input: SkillSearchInput): SkillRegistryEntry[] {
    const valid = SkillSearchInputSchema.parse(input);
    const query = valid.query.toLowerCase();
    const skillIds = [
      ...new Set(this.#repository.listSkills().map((entry) => entry.definition.skillId)),
    ];
    return skillIds
      .map((skillId) => this.#latestEntry(skillId))
      .filter((entry): entry is SkillRegistryEntry => entry !== undefined)
      .filter((entry) => {
        const definition = entry.definition;
        return (
          (!valid.category || definition.category === valid.category) &&
          (!query ||
            `${definition.skillId} ${definition.name} ${definition.description} ${definition.provider}`
              .toLowerCase()
              .includes(query))
        );
      });
  }

  enable(skillId: string): SkillRegistryEntry {
    return this.#toggle(skillId, true);
  }

  disable(skillId: string): SkillRegistryEntry {
    return this.#toggle(skillId, false);
  }

  async healthCheck(skillId: string, signal: AbortSignal): Promise<SkillRegistryEntry> {
    const entry = requiredEntry(this.#latestEntry(skillId));
    const executable = this.#executables.get(versionKey(skillId, entry.definition.version));
    let health: SkillRegistryEntry['health'] = 'HEALTHY';
    let sanitizedError: string | undefined;
    try {
      if (!executable) throw new Error('Skill implementation is unavailable.');
      if (entry.definition.compatibleRuntime !== `jupiter-core@${this.#runtimeVersion}`)
        throw new Error('Skill runtime is incompatible.');
      if (signal.aborted) throw new Error('Skill health check was cancelled.');
      await executable.healthCheck?.(signal);
    } catch {
      health = 'UNHEALTHY';
      sanitizedError = 'Skill health check failed.';
    }
    const updated = SkillRegistryEntrySchema.parse({
      ...entry,
      health,
      lastCheckedAt: this.#timestamp(),
      ...(sanitizedError ? { sanitizedError } : { sanitizedError: undefined }),
      updatedAt: this.#timestamp(),
    });
    this.#repository.upsertSkill(updated);
    return updated;
  }

  async invoke(
    invocation: SkillInvocation,
    parentSignal: AbortSignal,
  ): Promise<SkillExecutionResult> {
    const valid = SkillInvocationSchema.parse(invocation);
    const entry = requiredEntry(this.#latestEntry(valid.skillId));
    this.#assertInvocable(entry, valid);
    const executable = this.#executables.get(
      versionKey(entry.definition.skillId, entry.definition.version),
    );
    if (!executable) throw skillError('SKILL_MISSING', 'Skill implementation is unavailable.');
    assertValue(entry.definition.inputSchema, valid.input, 'input');
    const startedAt = this.#timestamp();
    const controller = new AbortController();
    const abort = (): void => controller.abort(parentSignal.reason ?? 'Invocation cancelled.');
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener('abort', abort, { once: true });
    this.#active.set(valid.executionId, controller);
    const timeoutMs = Math.min(valid.timeoutMs, entry.definition.timeoutMs);
    let status: SkillExecutionResult['status'] = 'SUCCESS';
    let output: unknown;
    let artifacts: Readonly<Record<string, unknown>> = {};
    let verificationHints: readonly string[] = [];
    let resultError: { code: string; message: string; recoverable: boolean } | undefined;
    try {
      const result = await executeBounded(
        executable,
        valid.input,
        {
          executionId: valid.executionId,
          missionId: valid.missionId,
          permissions: new Set(valid.permissions),
          idempotencyKey: valid.idempotencyKey,
          signal: controller.signal,
        },
        timeoutMs,
      );
      assertValue(entry.definition.outputSchema, result.output, 'output');
      output = result.output;
      artifacts = result.artifacts ?? {};
      verificationHints = result.verificationHints ?? [];
    } catch (error) {
      status =
        error instanceof SkillTimeoutError
          ? 'TIMEOUT'
          : controller.signal.aborted
            ? 'CANCELLED'
            : 'FAILED';
      resultError = {
        code:
          error instanceof SkillTimeoutError
            ? 'SKILL_TIMEOUT'
            : status === 'CANCELLED'
              ? 'SKILL_CANCELLED'
              : 'SKILL_EXECUTION_FAILED',
        message: executionFailureMessage(error, status),
        recoverable: true,
      };
    } finally {
      parentSignal.removeEventListener('abort', abort);
      this.#active.delete(valid.executionId);
    }
    const completedAt = this.#timestamp();
    const result = SkillExecutionResultSchema.parse({
      executionId: valid.executionId,
      skillId: valid.skillId,
      missionId: valid.missionId,
      version: entry.definition.version,
      status,
      ...(output === undefined ? {} : { output }),
      ...(resultError ? { error: resultError } : {}),
      artifacts,
      startedAt,
      completedAt,
      verificationHints,
    });
    this.#repository.addSkillExecution(
      SkillExecutionRecordSchema.parse({
        ...result,
        output: undefined,
        artifacts: {},
        verificationHints: [],
        idempotencyKey: valid.idempotencyKey,
        inputMetadata: valueMetadata(valid.input),
        outputMetadata: valueMetadata(output),
      }),
    );
    this.#recordEvent?.({
      type: 'skill.execution.completed',
      missionId: valid.missionId,
      payload: { executionId: valid.executionId, skillId: valid.skillId, status },
      occurredAt: completedAt,
    });
    return result;
  }

  cancel(executionId: string): boolean {
    const controller = this.#active.get(executionId);
    if (!controller) return false;
    controller.abort('Skill invocation cancelled.');
    return true;
  }

  listVersions(skillId: string): SkillRegistryEntry[] {
    return this.#repository
      .listSkills()
      .filter((entry) => entry.definition.skillId === skillId)
      .sort((left, right) => compareVersions(right.definition.version, left.definition.version));
  }

  listExecutions(skillId?: string) {
    return this.#repository.listSkillExecutions(skillId);
  }

  workflowExecutors(): WorkflowStepExecutor[] {
    const skillIds = [
      ...new Set(this.#repository.listSkills().map((entry) => entry.definition.skillId)),
    ];
    return skillIds.map((skillId) => ({
      skillId,
      execute: async ({ missionId, step, resolvedInput, idempotencyKey, signal }) => {
        const result = await this.invoke(
          {
            executionId: randomUUID(),
            skillId,
            missionId,
            input: resolvedInput,
            permissions: step.requiredPermissions,
            timeoutMs: step.timeoutMs,
            idempotencyKey,
          },
          signal,
        );
        if (result.status !== 'SUCCESS')
          throw new Error(result.error?.message ?? `Skill ended with ${result.status}.`);
        return {
          ...(result.output === undefined ? {} : { output: result.output }),
          artifacts: result.artifacts,
          verificationPassed: true,
          verificationSummary:
            result.verificationHints.join(' ') || 'Skill output passed its declared schema.',
        };
      },
    }));
  }

  shutdown(): Promise<void> {
    for (const controller of this.#active.values()) controller.abort('Jupiter is shutting down.');
    this.#active.clear();
    return Promise.resolve();
  }

  #assertInvocable(entry: SkillRegistryEntry, invocation: SkillInvocation): void {
    if (!entry.enabled) throw skillError('SKILL_DISABLED', 'Disabled Skill cannot execute.');
    if (entry.health !== 'HEALTHY')
      throw skillError('SKILL_UNHEALTHY', 'Skill health is not ready.');
    if (entry.definition.compatibleRuntime !== `jupiter-core@${this.#runtimeVersion}`)
      throw skillError('SKILL_INCOMPATIBLE', 'Skill runtime is incompatible.');
    const declared = new Set(entry.definition.permissions);
    const granted = new Set(invocation.permissions);
    const undeclared = [...granted].filter((permission) => !declared.has(permission));
    const missing = [...declared].filter((permission) => !granted.has(permission));
    if (undeclared.length || missing.length)
      throw skillError(
        'SKILL_PERMISSION_DENIED',
        'Invocation permissions do not match the Skill declaration.',
      );
  }

  #toggle(skillId: string, enabled: boolean): SkillRegistryEntry {
    const entry = requiredEntry(this.#latestEntry(skillId));
    const updated = SkillRegistryEntrySchema.parse({
      ...entry,
      enabled,
      updatedAt: this.#timestamp(),
    });
    this.#repository.upsertSkill(updated);
    return updated;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #latestEntry(skillId: string): SkillRegistryEntry | undefined {
    return this.listVersions(skillId)[0];
  }
}

function validateDefinition(input: unknown) {
  const definition = SkillDefinitionSchema.parse(input);
  validateSchemaShape(definition.inputSchema);
  validateSchemaShape(definition.outputSchema);
  if (new Set(definition.permissions).size !== definition.permissions.length)
    throw skillError('SKILL_PERMISSION_DUPLICATE', 'Skill permissions must be unique.');
  return definition;
}

function validateSchemaShape(schema: SkillDataSchema): void {
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in properties))
        throw skillError('SKILL_SCHEMA_INVALID', `Required property "${required}" is missing.`);
    }
    for (const child of Object.values(properties)) validateSchemaShape(child);
  } else if (schema.properties || schema.required || schema.additionalProperties !== undefined) {
    throw skillError('SKILL_SCHEMA_INVALID', 'Object keywords require an object schema.');
  }
  if (schema.type === 'array') {
    if (!schema.items) throw skillError('SKILL_SCHEMA_INVALID', 'Array schema requires items.');
    validateSchemaShape(schema.items);
  } else if (schema.items)
    throw skillError('SKILL_SCHEMA_INVALID', 'Items require an array schema.');
  if (
    schema.minLength !== undefined &&
    schema.maxLength !== undefined &&
    schema.minLength > schema.maxLength
  )
    throw skillError('SKILL_SCHEMA_INVALID', 'minLength cannot exceed maxLength.');
  if (
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    schema.minimum > schema.maximum
  )
    throw skillError('SKILL_SCHEMA_INVALID', 'minimum cannot exceed maximum.');
}

export function assertValue(schema: SkillDataSchema, value: unknown, path = 'value'): void {
  const fail = (detail: string): never => {
    throw skillError('SKILL_SCHEMA_VALIDATION_FAILED', `${path} ${detail}`);
  };
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value)))
    fail('is not an allowed value.');
  if (schema.type === 'null') {
    if (value !== null) fail('must be null.');
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('must be an array.');
    const itemSchema = schema.items;
    if (!itemSchema) throw skillError('SKILL_SCHEMA_INVALID', 'Array schema requires items.');
    const arrayValue = value as unknown[];
    arrayValue.forEach((item, index) =>
      assertValue(itemSchema, item, `${path}[${index.toString()}]`),
    );
    return;
  }
  if (schema.type === 'object') {
    if (!isRecord(value)) fail('must be an object.');
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? [])
      if (!(required in objectValue)) fail(`requires "${required}".`);
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(objectValue).find((key) => !(key in properties));
      if (unknown) fail(`contains undeclared field "${unknown}".`);
    }
    for (const [key, child] of Object.entries(properties))
      if (key in objectValue) assertValue(child, objectValue[key], `${path}.${key}`);
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') fail('must be a string.');
    const stringValue = value as string;
    if (schema.minLength !== undefined && stringValue.length < schema.minLength)
      fail('is too short.');
    if (schema.maxLength !== undefined && stringValue.length > schema.maxLength)
      fail('is too long.');
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail('must be a boolean.');
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('must be a finite number.');
  const numberValue = value as number;
  if (schema.type === 'integer' && !Number.isInteger(numberValue)) fail('must be an integer.');
  if (schema.minimum !== undefined && numberValue < schema.minimum) fail('is below minimum.');
  if (schema.maximum !== undefined && numberValue > schema.maximum) fail('is above maximum.');
}

async function executeBounded(
  executable: SkillExecutable,
  input: unknown,
  context: Parameters<SkillExecutable['execute']>[1],
  timeoutMs: number,
) {
  if (context.signal.aborted) throw new Error('Skill invocation cancelled.');
  const timeoutController = new AbortController();
  const onAbort = (): void => timeoutController.abort(context.signal.reason);
  context.signal.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      executable.execute(input, { ...context, signal: timeoutController.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new SkillTimeoutError());
          timeoutController.abort('SKILL_TIMEOUT');
        }, timeoutMs);
        timeoutController.signal.addEventListener(
          'abort',
          () => reject(new Error('Skill invocation cancelled.')),
          { once: true },
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    context.signal.removeEventListener('abort', onAbort);
  }
}

class SkillTimeoutError extends Error {
  constructor() {
    super('Skill exceeded its declared timeout.');
  }
}

function valueMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (isRecord(value)) return { type: 'object', keys: Object.keys(value).sort().slice(0, 100) };
  if (typeof value === 'string') return { type: 'string', length: value.length };
  return { type: typeof value };
}

function requiredEntry(entry: SkillRegistryEntry | undefined): SkillRegistryEntry {
  if (!entry) throw skillError('SKILL_MISSING', 'Skill is not registered.');
  return entry;
}

function versionKey(skillId: string, version: string): string {
  return `${skillId}@${version}`;
}
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function executionFailureMessage(error: unknown, status: SkillExecutionResult['status']): string {
  if (status === 'TIMEOUT') return 'Skill exceeded its declared timeout.';
  if (status === 'CANCELLED') return 'Skill invocation was cancelled.';
  if (error instanceof JupiterError) return error.message.slice(0, 1_000);
  return 'Skill execution failed.';
}
function skillError(code: string, message: string): JupiterError {
  return new JupiterError({
    code,
    category: code.includes('PERMISSION') ? 'permission' : 'validation',
    message,
    recoverable: true,
    retryable: false,
    userAction: 'Review the Skill definition, health, permissions, and input.',
  });
}
