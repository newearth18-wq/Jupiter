import { createHash, randomUUID } from 'node:crypto';
import {
  PermissionAuditRecordSchema,
  PermissionAuthorizationInputSchema,
  PermissionAuthorizationResultSchema,
  PermissionCapabilitySchema,
  PermissionGrantSchema,
  PermissionRequestInputSchema,
  PermissionRequestRecordSchema,
  PermissionResolveInputSchema,
  PermissionResolutionResultSchema,
  type Actor,
  type PermissionAuditRecord,
  type PermissionAuthorizationInput,
  type PermissionAuthorizationResult,
  type PermissionCapability,
  type PermissionDecision,
  type PermissionGrant,
  type PermissionRequestInput,
  type PermissionRequestRecord,
  type PermissionRequestStatus,
  type PermissionResolutionAuthority,
  type PermissionResolutionResult,
} from '@jupiter/contracts';
import { JupiterError, type PermissionRepository, type PermissionRuntime } from '@jupiter/core';

export type PermissionEngineOptions = {
  repository: PermissionRepository;
  sessionId?: string;
  now?: () => Date;
};

export class CapabilityPermissionEngine implements PermissionRuntime {
  readonly #repository: PermissionRepository;
  readonly #sessionId: string;
  readonly #now: () => Date;
  readonly #capabilities = new Map<string, PermissionCapability>();
  readonly #sessionGrants = new Map<string, PermissionGrant>();

  constructor(options: PermissionEngineOptions) {
    this.#repository = options.repository;
    this.#sessionId = options.sessionId ?? randomUUID();
    this.#now = options.now ?? (() => new Date());
  }

  registerCapability(input: PermissionCapability): PermissionCapability {
    const capability = PermissionCapabilitySchema.parse(input);
    if (this.#capabilities.has(capability.capability)) {
      throw permissionError('PERMISSION_CAPABILITY_DUPLICATE', 'Capability is already declared.');
    }
    if (
      new Set(capability.allowedRequesterTypes).size !== capability.allowedRequesterTypes.length
    ) {
      throw permissionError(
        'PERMISSION_CAPABILITY_INVALID',
        'Capability requester types must be unique.',
      );
    }
    this.#capabilities.set(capability.capability, capability);
    return capability;
  }

  listCapabilities(): PermissionCapability[] {
    return [...this.#capabilities.values()].sort((left, right) =>
      left.capability.localeCompare(right.capability),
    );
  }

  request(input: PermissionRequestInput): PermissionRequestRecord {
    const valid = PermissionRequestInputSchema.parse(input);
    const capability = this.#capabilities.get(valid.capability);
    if (!capability) {
      this.#audit({
        eventType: 'REJECTED',
        input: authorizationFromRequest(valid),
        decision: 'DENY',
        reasonCode: 'UNDECLARED_CAPABILITY',
        risk: 'HIGH',
      });
      throw permissionError('UNDECLARED_CAPABILITY', 'Capability is not declared.');
    }
    const reasonCode = this.#requestRejectionCode(valid, capability);
    if (!reasonCode) {
      const existing = this.#repository
        .listPermissionRequests('PENDING')
        .find((request) => sameRequest(request, valid));
      if (existing) return existing;
    }
    const now = this.#timestamp();
    const request = PermissionRequestRecordSchema.parse({
      ...valid,
      requestId: randomUUID(),
      risk: capability.risk,
      status: reasonCode ? 'DENIED' : 'PENDING',
      availableDecisions: reasonCode ? [] : availableDecisions(capability.risk, valid.automated),
      sessionId: this.#sessionId,
      createdAt: now,
      ...(reasonCode ? { resolvedAt: now, resolutionDecision: 'DENY' } : {}),
    });
    this.#repository.upsertPermissionRequest(request);
    this.#audit({
      eventType: reasonCode ? 'REJECTED' : 'REQUESTED',
      input: authorizationFromRequest(valid),
      decision: reasonCode ? 'DENY' : 'PROMPT',
      reasonCode: reasonCode ?? 'EXPLICIT_APPROVAL_REQUIRED',
      risk: capability.risk,
      requestId: request.requestId,
      trustSource: valid.trustSource,
    });
    return request;
  }

  listRequests(status?: PermissionRequestStatus): PermissionRequestRecord[] {
    return this.#repository.listPermissionRequests(status);
  }

  resolve(
    input: { requestId: string; decision: PermissionDecision },
    authority: PermissionResolutionAuthority,
  ): PermissionResolutionResult {
    const valid = PermissionResolveInputSchema.parse(input);
    const request = this.#repository.getPermissionRequest(valid.requestId);
    if (!request) throw permissionError('PERMISSION_REQUEST_MISSING', 'Request was not found.');
    if (authority === 'EXTERNAL_CONTENT' || authority === 'PLUGIN') {
      this.#audit({
        eventType: 'REJECTED',
        input: authorizationFromRequest(request),
        decision: 'DENY',
        reasonCode: 'UNTRUSTED_POLICY_CHANGE',
        risk: request.risk,
        requestId: request.requestId,
      });
      throw permissionError(
        'UNTRUSTED_POLICY_CHANGE',
        'Untrusted content cannot change permission policy.',
      );
    }
    if (request.status !== 'PENDING') {
      throw permissionError('PERMISSION_REQUEST_RESOLVED', 'Request is no longer pending.');
    }
    if (!request.availableDecisions.includes(valid.decision)) {
      throw permissionError(
        'PERMISSION_DECISION_INVALID',
        'Decision is unavailable for this risk.',
      );
    }
    if (request.risk === 'CRITICAL' && authority !== 'USER_EXPLICIT') {
      throw permissionError(
        'CRITICAL_EXPLICIT_CONFIRMATION_REQUIRED',
        'Critical actions require explicit user confirmation.',
      );
    }

    const now = this.#timestamp();
    const grant = this.#createGrant(request, valid.decision, now);
    const updated = PermissionRequestRecordSchema.parse({
      ...request,
      status: valid.decision === 'DENY' ? 'DENIED' : 'APPROVED',
      resolvedAt: now,
      resolutionDecision: valid.decision,
      grantId: grant.grantId,
    });
    this.#repository.transaction(() => {
      if (grant.decision === 'ALLOW_SESSION') this.#sessionGrants.set(grant.grantId, grant);
      else this.#repository.upsertPermissionGrant(grant);
      this.#repository.upsertPermissionRequest(updated);
      this.#audit({
        eventType: 'RESOLVED',
        input: authorizationFromRequest(request),
        decision: valid.decision === 'DENY' ? 'DENY' : 'ALLOW',
        reasonCode: `DECISION_${valid.decision}`,
        risk: request.risk,
        requestId: request.requestId,
        grantId: grant.grantId,
      });
    });
    return PermissionResolutionResultSchema.parse({ request: updated, grant });
  }

  authorize(input: PermissionAuthorizationInput): PermissionAuthorizationResult {
    const valid = PermissionAuthorizationInputSchema.parse(input);
    const capability = this.#capabilities.get(valid.capability);
    if (!capability)
      return this.#authorizationResult(valid, 'DENIED', 'UNDECLARED_CAPABILITY', 'HIGH');
    if (!valid.declaredCapabilities.includes(valid.capability)) {
      return this.#authorizationResult(
        valid,
        'DENIED',
        'CAPABILITY_NOT_DECLARED_BY_REQUESTER',
        capability.risk,
      );
    }
    if (!capability.available || !capability.allowedRequesterTypes.includes(valid.requesterType)) {
      return this.#authorizationResult(valid, 'DENIED', 'REQUESTER_NOT_ALLOWED', capability.risk);
    }
    if (valid.automated && !capability.automationAllowed) {
      return this.#authorizationResult(valid, 'DENIED', 'AUTOMATION_NOT_ALLOWED', capability.risk);
    }

    const grants = [...this.#repository.listPermissionGrants(), ...this.#sessionGrants.values()];
    const matching = grants.filter((grant) => this.#grantMatches(grant, valid));
    const denied = matching.find((grant) => grant.decision === 'DENY');
    if (denied) {
      return this.#authorizationResult(
        valid,
        'DENIED',
        'DENY_POLICY_MATCHED',
        capability.risk,
        denied,
      );
    }
    if (capability.risk === 'CRITICAL' || (valid.automated && capability.risk === 'HIGH')) {
      const once = matching.find(
        (grant) => grant.decision === 'ALLOW_ONCE' && (grant.remainingUses ?? 0) === 1,
      );
      if (once) return this.#consumeOnce(valid, once, capability.risk);
      return this.#authorizationResult(
        valid,
        'PROMPT',
        'EXECUTION_CONFIRMATION_REQUIRED',
        capability.risk,
      );
    }
    const once = matching.find(
      (grant) => grant.decision === 'ALLOW_ONCE' && (grant.remainingUses ?? 0) === 1,
    );
    if (once) return this.#consumeOnce(valid, once, capability.risk);
    const reusable = matching.find(
      (grant) => grant.decision === 'ALLOW_SESSION' || grant.decision === 'ALWAYS_ALLOW',
    );
    if (reusable) {
      return this.#authorizationResult(
        valid,
        'ALLOWED',
        'GRANT_MATCHED',
        capability.risk,
        reusable,
      );
    }
    return this.#authorizationResult(valid, 'PROMPT', 'NO_MATCHING_GRANT', capability.risk);
  }

  listGrants(): PermissionGrant[] {
    return [...this.#repository.listPermissionGrants(), ...this.#sessionGrants.values()].sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt),
    );
  }

  revoke(grantId: string, actor: Actor): boolean {
    const session = this.#sessionGrants.get(grantId);
    const persisted = this.#repository.getPermissionGrant(grantId);
    const grant = session ?? persisted;
    if (!grant || grant.revokedAt) return false;
    const updated = PermissionGrantSchema.parse({ ...grant, revokedAt: this.#timestamp() });
    if (session) this.#sessionGrants.set(grantId, updated);
    else this.#repository.upsertPermissionGrant(updated);
    this.#audit({
      eventType: 'REVOKED',
      input: authorizationFromGrant(updated, actor),
      decision: 'DENY',
      reasonCode: 'GRANT_REVOKED',
      risk: updated.risk,
      requestId: updated.requestId,
      grantId: updated.grantId,
    });
    return true;
  }

  listAudits(limit: number): PermissionAuditRecord[] {
    return this.#repository.listPermissionAudits(limit);
  }

  shutdown(): Promise<void> {
    this.#sessionGrants.clear();
    return Promise.resolve();
  }

  #requestRejectionCode(
    request: PermissionRequestInput,
    capability: PermissionCapability,
  ): string | undefined {
    if (request.trustSource === 'EXTERNAL_CONTENT') return 'UNTRUSTED_PERMISSION_REQUEST';
    if (!request.requester.declaredCapabilities.includes(request.capability)) {
      return request.requester.type === 'PLUGIN'
        ? 'PLUGIN_SELF_ELEVATION_DENIED'
        : 'CAPABILITY_NOT_DECLARED_BY_REQUESTER';
    }
    if (!capability.allowedRequesterTypes.includes(request.requester.type)) {
      return 'REQUESTER_NOT_ALLOWED';
    }
    if (!capability.available) return 'CAPABILITY_UNAVAILABLE';
    if (request.automated && !capability.automationAllowed) return 'AUTOMATION_NOT_ALLOWED';
    return undefined;
  }

  #createGrant(
    request: PermissionRequestRecord,
    decision: PermissionDecision,
    now: string,
  ): PermissionGrant {
    return PermissionGrantSchema.parse({
      grantId: randomUUID(),
      requestId: request.requestId,
      capability: request.capability,
      decision,
      actor: request.requester.actor,
      requesterType: request.requester.type,
      requesterId: request.requester.id,
      targetId: request.target.id,
      scopeId: request.scope.id,
      ...(request.requester.missionId ? { missionId: request.requester.missionId } : {}),
      ...(decision === 'ALLOW_SESSION' ? { sessionId: this.#sessionId } : {}),
      constraints: request.constraints,
      risk: request.risk,
      createdAt: now,
      ...(decision === 'ALLOW_ONCE'
        ? {
            expiresAt: new Date(this.#now().getTime() + 15 * 60_000).toISOString(),
            remainingUses: 1,
          }
        : {}),
    });
  }

  #grantMatches(grant: PermissionGrant, input: PermissionAuthorizationInput): boolean {
    if (grant.revokedAt) return false;
    if (grant.expiresAt && grant.expiresAt <= this.#timestamp()) return false;
    if (grant.decision === 'ALLOW_ONCE' && (grant.remainingUses ?? 0) < 1) return false;
    if (grant.decision === 'ALLOW_SESSION' && grant.sessionId !== this.#sessionId) return false;
    return (
      grant.capability === input.capability &&
      grant.actor === input.actor &&
      grant.requesterType === input.requesterType &&
      grant.requesterId === input.requesterId &&
      grant.targetId === input.targetId &&
      grant.scopeId === input.scopeId &&
      (grant.missionId ?? null) === (input.missionId ?? null) &&
      stableJson(grant.constraints) === stableJson(input.constraints)
    );
  }

  #consumeOnce(
    input: PermissionAuthorizationInput,
    grant: PermissionGrant,
    risk: PermissionCapability['risk'],
  ): PermissionAuthorizationResult {
    return this.#repository.transaction(() => {
      const latest = this.#repository.getPermissionGrant(grant.grantId) ?? grant;
      if ((latest.remainingUses ?? 0) !== 1 || latest.revokedAt) {
        return this.#authorizationResult(input, 'PROMPT', 'ALLOW_ONCE_CONSUMED', risk);
      }
      this.#repository.upsertPermissionGrant({ ...latest, remainingUses: 0 });
      return this.#authorizationResult(input, 'ALLOWED', 'ALLOW_ONCE_CONSUMED', risk, latest);
    });
  }

  #authorizationResult(
    input: PermissionAuthorizationInput,
    status: PermissionAuthorizationResult['status'],
    code: string,
    risk: PermissionCapability['risk'],
    grant?: PermissionGrant,
  ): PermissionAuthorizationResult {
    const audit = this.#audit({
      eventType: status === 'ALLOWED' ? 'AUTHORIZED' : 'DENIED',
      input,
      decision: status === 'ALLOWED' ? 'ALLOW' : status === 'PROMPT' ? 'PROMPT' : 'DENY',
      reasonCode: code,
      risk,
      ...(grant ? { requestId: grant.requestId, grantId: grant.grantId } : {}),
    });
    return PermissionAuthorizationResultSchema.parse({
      status,
      code,
      ...(grant ? { grantId: grant.grantId } : {}),
      auditId: audit.auditId,
      evaluatedAt: audit.timestamp,
    });
  }

  #audit(input: {
    eventType: PermissionAuditRecord['eventType'];
    input: PermissionAuthorizationInput;
    decision: PermissionAuditRecord['decision'];
    reasonCode: string;
    risk: PermissionAuditRecord['risk'];
    requestId?: string;
    grantId?: string;
    trustSource?: PermissionRequestInput['trustSource'];
  }): PermissionAuditRecord {
    const audit = PermissionAuditRecordSchema.parse({
      auditId: randomUUID(),
      eventType: input.eventType,
      capability: input.input.capability,
      actor: input.input.actor,
      requesterType: input.input.requesterType,
      requesterId: input.input.requesterId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      risk: input.risk,
      targetFingerprint: fingerprint(`${input.input.targetId}\u0000${input.input.scopeId}`),
      ...(input.input.missionId ? { missionId: input.input.missionId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.grantId ? { grantId: input.grantId } : {}),
      timestamp: this.#timestamp(),
      metadataRedacted: {
        automated: input.input.automated,
        constraintKeys: Object.keys(input.input.constraints).sort(),
        ...(input.trustSource ? { trustSource: input.trustSource } : {}),
      },
    });
    this.#repository.appendPermissionAudit(audit);
    return audit;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function availableDecisions(
  risk: PermissionCapability['risk'],
  automated: boolean,
): PermissionDecision[] {
  if (risk === 'CRITICAL' || (automated && risk === 'HIGH')) return ['ALLOW_ONCE', 'DENY'];
  return ['ALLOW_ONCE', 'ALLOW_SESSION', 'ALWAYS_ALLOW', 'DENY'];
}

function authorizationFromRequest(request: PermissionRequestInput): PermissionAuthorizationInput {
  return PermissionAuthorizationInputSchema.parse({
    capability: request.capability,
    actor: request.requester.actor,
    requesterType: request.requester.type,
    requesterId: request.requester.id,
    declaredCapabilities: request.requester.declaredCapabilities,
    targetId: request.target.id,
    scopeId: request.scope.id,
    ...(request.requester.missionId ? { missionId: request.requester.missionId } : {}),
    constraints: request.constraints,
    automated: request.automated,
  });
}

function authorizationFromGrant(
  grant: PermissionGrant,
  actor: Actor,
): PermissionAuthorizationInput {
  return PermissionAuthorizationInputSchema.parse({
    capability: grant.capability,
    actor,
    requesterType: grant.requesterType,
    requesterId: grant.requesterId,
    declaredCapabilities: [grant.capability],
    targetId: grant.targetId,
    scopeId: grant.scopeId,
    ...(grant.missionId ? { missionId: grant.missionId } : {}),
    constraints: grant.constraints,
    automated: false,
  });
}

function sameRequest(left: PermissionRequestRecord, right: PermissionRequestInput): boolean {
  return (
    left.capability === right.capability &&
    left.action === right.action &&
    left.reason === right.reason &&
    left.target.type === right.target.type &&
    left.requester.actor === right.requester.actor &&
    left.requester.type === right.requester.type &&
    left.requester.id === right.requester.id &&
    left.requester.display === right.requester.display &&
    stableJson({ values: [...left.requester.declaredCapabilities].sort() }) ===
      stableJson({ values: [...right.requester.declaredCapabilities].sort() }) &&
    (left.requester.stepId ?? null) === (right.requester.stepId ?? null) &&
    left.target.id === right.target.id &&
    left.target.display === right.target.display &&
    left.scope.type === right.scope.type &&
    left.scope.id === right.scope.id &&
    left.scope.display === right.scope.display &&
    (left.requester.missionId ?? null) === (right.requester.missionId ?? null) &&
    left.trustSource === right.trustSource &&
    left.dataLeavingDevice.value === right.dataLeavingDevice.value &&
    left.dataLeavingDevice.description === right.dataLeavingDevice.description &&
    left.consequence === right.consequence &&
    left.reversible === right.reversible &&
    left.automated === right.automated &&
    stableJson(left.constraints) === stableJson(right.constraints)
  );
}

function stableJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function permissionError(code: string, message: string): JupiterError {
  return new JupiterError({
    code,
    category: 'permission',
    message,
    recoverable: true,
    retryable: false,
    userAction: 'Review the exact permission request in Jupiter before retrying.',
  });
}
