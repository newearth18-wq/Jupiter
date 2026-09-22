import type {
  Actor,
  AuditEvent,
  CoreServiceHealth,
  DatabaseDiagnostics,
  DomainEvent,
} from '@jupiter/contracts';

export type DomainEventDraft = {
  type: string;
  missionId?: string;
  correlationId: string;
  actor: Actor;
  source: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: string;
};

export type EventStore = {
  append: (event: DomainEventDraft) => DomainEvent;
  listAfter: (afterSequence: number, limit: number) => DomainEvent[];
};

export type AuditRepository = {
  appendAudit: (event: AuditEvent) => void;
};

export type ServiceHealthRepository = {
  upsert: (health: CoreServiceHealth) => void;
  list: () => CoreServiceHealth[];
};

export type DiagnosticsRepository = {
  inspect: () => DatabaseDiagnostics;
};
