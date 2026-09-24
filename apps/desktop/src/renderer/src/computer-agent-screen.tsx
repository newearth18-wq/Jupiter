import {
  ComputerHistoryResultSchema,
  ComputerRuntimeStatusSchema,
  NotepadDemoResultSchema,
  type ComputerActionResult,
  type ComputerRuntimeStatus,
  type Language,
} from '@jupiter/contracts';
import { Button, EmptyState, StatusBadge, Surface } from '@jupiter/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { computerCopy } from './computer-copy.js';
import { BrowserAgentPanel } from './browser-agent-panel.js';

export function ComputerAgentScreen({
  language,
  onPermissionRequired,
}: {
  language: Language;
  onPermissionRequired: () => void;
}): React.JSX.Element {
  const t = computerCopy(language);
  const [status, setStatus] = useState<ComputerRuntimeStatus>();
  const [history, setHistory] = useState<ComputerActionResult[]>([]);
  const [outputPath, setOutputPath] = useState('');
  const [result, setResult] = useState<ReturnType<typeof NotepadDemoResultSchema.parse>>();
  const [error, setError] = useState<string>();
  const [permissionRequired, setPermissionRequired] = useState(false);
  const [running, setRunning] = useState(false);
  const activeRequestId = useRef<string | undefined>(undefined);
  const activeExecutionId = useRef<string | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [statusResponse, historyResponse] = await Promise.all([
        rpc('query', 'computer.status', {}),
        rpc('query', 'computer.history', { limit: 30 }),
      ]);
      if (statusResponse.status === 'error') throw new Error(statusResponse.error.message);
      if (historyResponse.status === 'error') throw new Error(historyResponse.error.message);
      const nextStatus = ComputerRuntimeStatusSchema.parse(statusResponse.data);
      setStatus(nextStatus);
      setOutputPath((current) => current || nextStatus.defaultDemoPath);
      setHistory(ComputerHistoryResultSchema.parse(historyResponse.data).actions);
      setError(undefined);
    } catch {
      setError(t.loadFailed);
    }
  }, [t.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const runDemo = async (): Promise<void> => {
    const requestId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    activeRequestId.current = requestId;
    activeExecutionId.current = executionId;
    setRunning(true);
    setError(undefined);
    setPermissionRequired(false);
    setResult(undefined);
    try {
      const response = await window.jupiter.request({
        schemaVersion: 1,
        kind: 'command',
        name: 'computer.demo.notepad',
        context: {
          requestId,
          executionId,
          actor: 'renderer',
          timestamp: new Date().toISOString(),
        },
        payload: { executionId, outputPath, text: 'Hello Jupiter', overwrite: false },
      });
      if (response.status === 'error') {
        if (response.error.code === 'PERMISSION_REQUIRED') {
          setPermissionRequired(true);
          onPermissionRequired();
          throw new Error(t.waitingPermission);
        }
        throw new Error(response.error.message);
      }
      setResult(NotepadDemoResultSchema.parse(response.data));
      await load();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : t.failed);
    } finally {
      activeRequestId.current = undefined;
      activeExecutionId.current = undefined;
      setRunning(false);
    }
  };

  const cancel = async (): Promise<void> => {
    const requestId = activeRequestId.current;
    const executionId = activeExecutionId.current;
    if (requestId) await window.jupiter.cancel(requestId);
    if (executionId) await rpc('command', 'computer.cancel', { executionId });
  };

  if (status && !status.available) {
    return (
      <div className="screen" data-screen="devices">
        <EmptyState eyebrow={t.unavailable} title={t.title} description={t.description} />
      </div>
    );
  }

  return (
    <div
      className="screen computer-agent-screen"
      data-computer-state={
        error ? 'error' : status?.available ? 'operational' : status ? 'unavailable' : 'loading'
      }
      data-screen="devices"
    >
      <header className="screen-header">
        <div>
          <span className="eyebrow">{t.eyebrow}</span>
          <h1 data-testid="screen-title">{t.title}</h1>
          <p>{t.description}</p>
        </div>
        <StatusBadge tone={status?.available ? 'success' : status ? 'warning' : 'neutral'}>
          {status?.available ? t.operational : status ? t.unavailable : t.loading}
        </StatusBadge>
      </header>

      <div className="computer-agent-grid">
        <Surface className="computer-agent-runtime">
          <div className="section-heading">
            <div>
              <span className="eyebrow">{t.processBoundary}</span>
              <h2>{t.adapters}</h2>
            </div>
            <Button disabled={running} type="button" variant="ghost" onClick={() => void load()}>
              {t.refresh}
            </Button>
          </div>
          <div className="computer-adapter-list">
            {status?.adapters.map((adapter) => (
              <div key={adapter.adapterId}>
                <strong>{adapter.name}</strong>
                <span>
                  {adapter.supportedActions.length.toString()} {t.typedActions}
                </span>
              </div>
            ))}
          </div>
          <p className="computer-fallback-policy">{t.fallbackPolicy}</p>
        </Surface>

        <Surface className="computer-demo-card">
          <span className="eyebrow">{t.demo}</span>
          <h2>Hello Jupiter</h2>
          <p>{t.demoDescription}</p>
          <label>
            <span>{t.exactText}</span>
            <input readOnly value="Hello Jupiter" />
          </label>
          <label>
            <span>{t.outputPath}</span>
            <input
              disabled={running}
              spellCheck={false}
              value={outputPath}
              onChange={(event) => setOutputPath(event.currentTarget.value)}
            />
          </label>
          <div className="button-row">
            <Button
              disabled={running || !status?.available || outputPath.length === 0}
              type="button"
              onClick={() => void runDemo()}
            >
              {permissionRequired ? t.retry : t.run}
            </Button>
            {running && (
              <Button type="button" variant="danger" onClick={() => void cancel()}>
                {t.cancel}
              </Button>
            )}
          </div>
          {running && (
            <p aria-live="polite" className="computer-running">
              {t.running}
            </p>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {result && (
            <div className="computer-demo-result" data-testid="computer-demo-result">
              <StatusBadge tone={result.success ? 'success' : 'error'}>{result.status}</StatusBadge>
              <p>{result.observation}</p>
              {result.artifact && (
                <p>
                  <strong>{t.evidence}:</strong> {result.artifact.path}
                </p>
              )}
              <ol>
                {result.actions.map((action) => (
                  <li key={action.actionId}>
                    <StatusBadge tone={action.success ? 'success' : 'error'}>
                      {action.status}
                    </StatusBadge>
                    <span>
                      <strong>{action.action}</strong>
                      <small>{action.observation}</small>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Surface>
      </div>

      <Surface>
        <div className="section-heading">
          <h2>{t.history}</h2>
          <StatusBadge tone="neutral">{history.length.toString()}</StatusBadge>
        </div>
        {history.length === 0 ? (
          <p>{t.noHistory}</p>
        ) : (
          <ol className="computer-history-list">
            {history.map((action) => (
              <li key={action.actionId}>
                <StatusBadge tone={action.success ? 'success' : 'error'}>
                  {action.status}
                </StatusBadge>
                <span>
                  <strong>{action.action}</strong>
                  <small>{action.observation}</small>
                </span>
                <time dateTime={action.completedAt}>
                  {new Date(action.completedAt).toLocaleString(language)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </Surface>
      <BrowserAgentPanel language={language} onPermissionRequired={onPermissionRequired} />
    </div>
  );
}

function rpc(
  kind: 'query' | 'command',
  name: Parameters<typeof window.jupiter.request>[0]['name'],
  payload: unknown,
) {
  return window.jupiter.request({
    schemaVersion: 1,
    kind,
    name,
    context: {
      requestId: crypto.randomUUID(),
      actor: 'renderer',
      timestamp: new Date().toISOString(),
    },
    payload,
  } as Parameters<typeof window.jupiter.request>[0]);
}
