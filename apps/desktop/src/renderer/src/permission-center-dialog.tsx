import {
  PermissionAuditListResultSchema,
  PermissionCapabilityListResultSchema,
  PermissionGrantListResultSchema,
  PermissionRequestListResultSchema,
  PermissionResolutionResultSchema,
  type Language,
  type PermissionDecision,
  type PermissionGrant,
  type PermissionRequestRecord,
} from '@jupiter/contracts';
import { Button, Dialog, StatusBadge } from '@jupiter/ui';
import { useCallback, useEffect, useState } from 'react';
import { permissionCopy } from './permission-copy.js';

export function PermissionCenterDialog({
  language,
  open,
  onClose,
}: {
  language: Language;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const t = permissionCopy(language);
  const [requests, setRequests] = useState<PermissionRequestRecord[]>([]);
  const [grants, setGrants] = useState<PermissionGrant[]>([]);
  const [audits, setAudits] = useState<
    ReturnType<typeof PermissionAuditListResultSchema.parse>['audits']
  >([]);
  const [capabilities, setCapabilities] = useState<
    ReturnType<typeof PermissionCapabilityListResultSchema.parse>['capabilities']
  >([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    try {
      const [requestResponse, grantResponse, auditResponse, capabilityResponse] = await Promise.all(
        [
          rpc('permissions.requests', {}),
          rpc('permissions.grants', {}),
          rpc('permissions.audit', { limit: 50 }),
          rpc('permissions.capabilities', {}),
        ],
      );
      if (requestResponse.status === 'error') throw new Error(requestResponse.error.message);
      if (grantResponse.status === 'error') throw new Error(grantResponse.error.message);
      if (auditResponse.status === 'error') throw new Error(auditResponse.error.message);
      if (capabilityResponse.status === 'error') throw new Error(capabilityResponse.error.message);
      const nextRequests = PermissionRequestListResultSchema.parse(requestResponse.data).requests;
      setRequests(nextRequests);
      setGrants(PermissionGrantListResultSchema.parse(grantResponse.data).grants);
      setAudits(PermissionAuditListResultSchema.parse(auditResponse.data).audits);
      setCapabilities(
        PermissionCapabilityListResultSchema.parse(capabilityResponse.data).capabilities,
      );
      setSelectedId((current) =>
        current && nextRequests.some((request) => request.requestId === current)
          ? current
          : nextRequests.find((request) => request.status === 'PENDING')?.requestId,
      );
      setError(undefined);
    } catch {
      setError(t.loadError);
    }
  }, [t.loadError]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const selected = requests.find((request) => request.requestId === selectedId);
  const pending = requests.filter((request) => request.status === 'PENDING');

  const resolve = async (decision: PermissionDecision): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      const response = await rpc('permissions.resolve', {
        requestId: selected.requestId,
        decision,
      });
      if (response.status === 'error') throw new Error(response.error.message);
      PermissionResolutionResultSchema.parse(response.data);
      await load();
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : t.loadError);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grantId: string): Promise<void> => {
    setBusy(true);
    try {
      const response = await rpc('permissions.revoke', { grantId });
      if (response.status === 'error') throw new Error(response.error.message);
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : t.loadError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      closeLabel={language === 'th' ? 'ปิด' : 'Close'}
      description={t.description}
      open={open}
      title={t.title}
      onClose={onClose}
    >
      <div className="permission-center" data-testid="permission-center">
        <div className="permission-center__toolbar">
          <StatusBadge tone={pending.length > 0 ? 'warning' : 'success'}>
            {pending.length.toString()} {t.pending}
          </StatusBadge>
          <Button disabled={busy} type="button" variant="ghost" onClick={() => void load()}>
            {t.refresh}
          </Button>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <section>
          <h3>{t.pending}</h3>
          {pending.length === 0 ? (
            <p>{t.noPending}</p>
          ) : (
            <div className="permission-request-list">
              {pending.map((request) => (
                <button
                  aria-current={request.requestId === selectedId}
                  key={request.requestId}
                  type="button"
                  onClick={() => setSelectedId(request.requestId)}
                >
                  <strong>{request.action}</strong>
                  <span>{request.target.display}</span>
                  <StatusBadge tone={riskTone(request.risk)}>{request.risk}</StatusBadge>
                </button>
              ))}
            </div>
          )}
        </section>
        {selected?.status === 'PENDING' && (
          <section className="permission-request-detail" data-testid="permission-request-detail">
            {selected.risk === 'CRITICAL' && (
              <p className="permission-critical-notice">{t.criticalNotice}</p>
            )}
            <dl>
              <Detail label={t.action} value={selected.action} />
              <Detail label={t.reason} value={selected.reason} />
              <Detail
                label={t.target}
                value={`${selected.target.display} — ${selected.target.id}`}
              />
              <Detail label={t.scope} value={`${selected.scope.display} — ${selected.scope.id}`} />
              <Detail label={t.risk} value={selected.risk} />
              <Detail
                label={t.requester}
                value={`${selected.requester.display} (${selected.requester.type}/${selected.requester.actor})`}
              />
              <Detail
                label={t.mission}
                value={`${selected.requester.missionId ?? 'Not configured'} / ${selected.requester.stepId ?? 'Not configured'}`}
              />
              <Detail
                label={t.data}
                value={`${selected.dataLeavingDevice.value ? t.yes : t.no} — ${selected.dataLeavingDevice.description}`}
              />
              <Detail label={t.consequence} value={selected.consequence} />
              <Detail label={t.reversible} value={selected.reversible ? t.yes : t.no} />
              <Detail label={t.automation} value={selected.automated ? t.yes : t.no} />
            </dl>
            <div className="button-row" data-testid="permission-decisions">
              {selected.availableDecisions.map((decision) => (
                <Button
                  data-decision={decision}
                  disabled={busy}
                  key={decision}
                  type="button"
                  variant={decision === 'DENY' ? 'danger' : 'primary'}
                  onClick={() => void resolve(decision)}
                >
                  {decisionLabel(decision, t)}
                </Button>
              ))}
            </div>
          </section>
        )}
        <section>
          <h3>{t.grants}</h3>
          {grants.length === 0 ? (
            <p>{t.noGrants}</p>
          ) : (
            <div className="permission-grant-list">
              {grants.map((grant) => {
                const status = grant.revokedAt
                  ? t.revoked
                  : grant.decision === 'ALLOW_ONCE' && grant.remainingUses === 0
                    ? t.consumed
                    : t.active;
                return (
                  <div key={grant.grantId}>
                    <span>
                      <strong>{grant.capability}</strong>
                      <small>
                        {grant.decision} · {grant.requesterType} · {status}
                      </small>
                    </span>
                    {!grant.revokedAt && status === t.active && (
                      <Button
                        disabled={busy}
                        type="button"
                        variant="secondary"
                        onClick={() => void revoke(grant.grantId)}
                      >
                        {t.revoke}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <section>
          <h3>{t.capabilities}</h3>
          <div className="permission-capability-list">
            {capabilities.map((capability) => (
              <span key={capability.capability}>
                <strong>{capability.name}</strong>
                <small>
                  {capability.capability} · {capability.risk}
                </small>
              </span>
            ))}
          </div>
        </section>
        <section>
          <h3>{t.audit}</h3>
          {audits.length === 0 ? (
            <p>{t.noAudit}</p>
          ) : (
            <ol className="permission-audit-list">
              {audits.slice(0, 20).map((audit) => (
                <li key={audit.auditId}>
                  <strong>{audit.decision}</strong> {audit.capability} · {audit.reasonCode}
                  <small>{new Date(audit.timestamp).toLocaleString(language)}</small>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function decisionLabel(
  decision: PermissionDecision,
  copy: ReturnType<typeof permissionCopy>,
): string {
  if (decision === 'ALLOW_ONCE') return copy.approveOnce;
  if (decision === 'ALLOW_SESSION') return copy.approveSession;
  if (decision === 'ALWAYS_ALLOW') return copy.alwaysAllow;
  return copy.deny;
}

function riskTone(risk: PermissionRequestRecord['risk']): 'neutral' | 'warning' | 'error' {
  if (risk === 'CRITICAL') return 'error';
  if (risk === 'HIGH' || risk === 'MEDIUM') return 'warning';
  return 'neutral';
}

function rpc(name: Parameters<typeof window.jupiter.request>[0]['name'], payload: unknown) {
  return window.jupiter.request({
    schemaVersion: 1,
    kind:
      name.includes('.audit') || name.endsWith('s') || name.endsWith('capabilities')
        ? 'query'
        : 'command',
    name,
    context: {
      requestId: crypto.randomUUID(),
      actor: 'renderer',
      timestamp: new Date().toISOString(),
    },
    payload,
  } as Parameters<typeof window.jupiter.request>[0]);
}
