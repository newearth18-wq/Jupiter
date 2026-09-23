import { randomUUID } from 'node:crypto';
import {
  AuditEventSchema,
  CONTRACT_SCHEMA_VERSION,
  ErrorEnvelopeSchema,
  RpcRequestEnvelopeSchema,
  RpcResponseEnvelopeSchema,
  parseRpcSuccessData,
  type Actor,
  type ErrorEnvelope,
  type RpcRequestEnvelope,
  type RpcRequestName,
  type RpcResponseEnvelope,
} from '@jupiter/contracts';
import type { CapabilityDispatcher } from '../capabilities/capability-dispatcher.js';
import { JupiterError } from '../errors/jupiter-error.js';
import type { AuditRepository } from '../ports.js';

const CAPABILITIES: Readonly<Record<RpcRequestName, string>> = {
  'core.ping': 'core.ping',
  'diagnostics.get': 'diagnostics.read',
  'events.replay': 'events.read',
  'core.health.refresh': 'core.health.refresh',
  'ui.preferences.get': 'ui.preferences.read',
  'ui.preferences.update': 'ui.preferences.write',
  'providers.list': 'providers.read',
  'providers.configure': 'providers.configure',
  'providers.remove': 'providers.remove',
  'providers.validate': 'providers.validate',
  'models.list': 'models.read',
  'models.discover': 'models.discover',
  'ai.settings.get': 'ai.settings.read',
  'ai.settings.update': 'ai.settings.write',
  'chat.conversations.list': 'chat.history.read',
  'chat.conversation.create': 'chat.conversation.create',
  'chat.conversation.get': 'chat.history.read',
  'chat.conversation.route': 'chat.conversation.route',
  'chat.send': 'chat.send',
  'chat.retry': 'chat.send',
  'chat.edit_resend': 'chat.send',
  'missions.list': 'missions.read',
  'missions.get': 'missions.read',
  'missions.create': 'missions.create',
  'missions.pause': 'missions.pause',
  'missions.resume': 'missions.resume',
  'missions.cancel': 'missions.cancel',
  'missions.retry': 'missions.retry',
  'missions.archive': 'missions.archive',
  'missions.transition': 'missions.transition',
  'workflows.get': 'workflows.read',
  'workflows.plan.create': 'workflows.plan.create',
  'workflows.start': 'workflows.start',
  'workflows.resume': 'workflows.resume',
  'workflows.cancel': 'workflows.cancel',
  'workflows.replan': 'workflows.replan',
  'workflows.checkpoint.resolve': 'workflows.checkpoint.resolve',
  'skills.list': 'skills.read',
  'skills.search': 'skills.read',
  'skills.get': 'skills.read',
  'skills.versions': 'skills.versions',
  'skills.enable': 'skills.enable',
  'skills.disable': 'skills.disable',
  'skills.health': 'skills.health',
  'skills.invoke': 'skills.invoke',
  'skills.cancel': 'skills.cancel',
  'skills.executions': 'skills.read',
};

export class RpcGateway {
  readonly #dispatcher: CapabilityDispatcher;
  readonly #audit: AuditRepository;

  constructor(dispatcher: CapabilityDispatcher, audit: AuditRepository) {
    this.#dispatcher = dispatcher;
    this.#audit = audit;
  }

  async handle(
    input: unknown,
    authenticatedActor: Actor,
    signal: AbortSignal,
  ): Promise<RpcResponseEnvelope> {
    const parsed = RpcRequestEnvelopeSchema.safeParse(input);
    if (!parsed.success) {
      return this.#errorResponse(
        randomUUID(),
        undefined,
        new JupiterError({
          code: 'INVALID_RPC_REQUEST',
          category: 'validation',
          message: 'The request did not match the versioned RPC contract.',
          recoverable: true,
          retryable: false,
          userAction: 'Refresh Jupiter and retry the action.',
          sanitizedDetails: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
        }),
      );
    }

    const request = parsed.data;
    const capability = CAPABILITIES[request.name];
    if (request.context.actor !== authenticatedActor) {
      const error = new JupiterError({
        code: 'ACTOR_MISMATCH',
        category: 'permission',
        message: 'The request actor does not match the authenticated caller.',
        recoverable: false,
        retryable: false,
        userAction: 'Return to the trusted Jupiter interface.',
      });
      this.#recordAudit(request, authenticatedActor, capability, 'deny');
      return this.#errorResponse(request.context.requestId, request.name, error, request);
    }

    try {
      const output = await this.#dispatcher.dispatch(
        capability,
        request.payload,
        request.context,
        signal,
      );
      const data = parseRpcSuccessData(request.name, output);
      this.#recordAudit(request, authenticatedActor, capability, 'allow');
      return RpcResponseEnvelopeSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: request.context.requestId,
        requestName: request.name,
        status: 'success',
        data,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.#recordAudit(request, authenticatedActor, capability, 'error');
      return this.#errorResponse(request.context.requestId, request.name, error, request);
    }
  }

  #errorResponse(
    requestId: string,
    requestName: RpcRequestName | undefined,
    error: unknown,
    request?: RpcRequestEnvelope,
  ): RpcResponseEnvelope {
    const envelope = this.#toErrorEnvelope(error, request);
    return RpcResponseEnvelopeSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId,
      ...(requestName === undefined ? {} : { requestName }),
      status: 'error',
      error: envelope,
      completedAt: new Date().toISOString(),
    });
  }

  #toErrorEnvelope(error: unknown, request?: RpcRequestEnvelope): ErrorEnvelope {
    const known =
      error instanceof JupiterError
        ? error
        : new JupiterError({
            code: 'INTERNAL_RPC_ERROR',
            category: 'internal',
            message: 'Jupiter could not complete the request.',
            recoverable: true,
            retryable: true,
            userAction: 'Open Diagnostics and retry.',
            ...(error instanceof Error ? { sanitizedDetails: error.message.slice(0, 500) } : {}),
          });
    return ErrorEnvelopeSchema.parse({
      errorId: randomUUID(),
      code: known.code,
      category: known.category,
      message: known.message,
      recoverable: known.recoverable,
      retryable: known.retryable,
      userAction: known.userAction,
      ...(request?.context.missionId === undefined ? {} : { missionId: request.context.missionId }),
      ...(request?.context.executionId === undefined
        ? {}
        : { executionId: request.context.executionId }),
      ...(known.sanitizedDetails === undefined ? {} : { sanitizedDetails: known.sanitizedDetails }),
      timestamp: new Date().toISOString(),
    });
  }

  #recordAudit(
    request: RpcRequestEnvelope,
    actor: Actor,
    capability: string,
    decision: 'allow' | 'deny' | 'error',
  ): void {
    this.#audit.appendAudit(
      AuditEventSchema.parse({
        auditId: randomUUID(),
        eventType: 'rpc.request',
        actor,
        capability,
        target: 'local-core',
        decision,
        riskLevel: 'LOW',
        ...(request.context.missionId === undefined
          ? {}
          : { missionId: request.context.missionId }),
        ...(request.context.executionId === undefined
          ? {}
          : { executionId: request.context.executionId }),
        timestamp: new Date().toISOString(),
        metadataRedacted: {
          requestId: request.context.requestId,
          requestName: request.name,
          schemaVersion: request.schemaVersion,
        },
      }),
    );
  }
}
