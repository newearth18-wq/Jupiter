import {
  BrowserActionInputSchema,
  BrowserActionResultSchema,
  BrowserHistoryResultSchema,
  BrowserRuntimeStatusSchema,
  BrowserSessionListResultSchema,
  type BrowserActionInput,
  type BrowserActionResult,
  type BrowserRuntimeStatus,
  type BrowserSession,
  type Language,
} from '@jupiter/contracts';
import { Button, StatusBadge, Surface } from '@jupiter/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

export function BrowserAgentPanel({
  language,
  onPermissionRequired,
}: {
  language: Language;
  onPermissionRequired: () => void;
}): React.JSX.Element {
  const thai = language === 'th';
  const [status, setStatus] = useState<BrowserRuntimeStatus>();
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [history, setHistory] = useState<BrowserActionResult[]>([]);
  const [url, setUrl] = useState('https://example.com/');
  const [result, setResult] = useState<BrowserActionResult>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [permissionRequired, setPermissionRequired] = useState(false);
  const activeRequestId = useRef<string | undefined>(undefined);
  const activeActionId = useRef<string | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [statusResponse, sessionsResponse, historyResponse] = await Promise.all([
        rpc('query', 'browser.status', {}),
        rpc('query', 'browser.sessions', {}),
        rpc('query', 'browser.history', { limit: 20 }),
      ]);
      if (statusResponse.status === 'error') throw new Error(statusResponse.error.message);
      if (sessionsResponse.status === 'error') throw new Error(sessionsResponse.error.message);
      if (historyResponse.status === 'error') throw new Error(historyResponse.error.message);
      setStatus(BrowserRuntimeStatusSchema.parse(statusResponse.data));
      setSessions(BrowserSessionListResultSchema.parse(sessionsResponse.data).sessions);
      setHistory(BrowserHistoryResultSchema.parse(historyResponse.data).actions);
      setError(undefined);
    } catch {
      setError(thai ? 'โหลดสถานะ Browser Agent ไม่สำเร็จ' : 'Could not load Browser Agent status.');
    }
  }, [thai]);

  useEffect(() => {
    void load();
  }, [load]);

  const execute = async (action: BrowserActionInput): Promise<void> => {
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    activeActionId.current = action.actionId;
    setRunning(true);
    setError(undefined);
    setPermissionRequired(false);
    try {
      const response = await window.jupiter.request({
        schemaVersion: 1,
        kind: 'command',
        name: 'browser.execute',
        context: {
          requestId,
          actor: 'renderer',
          timestamp: new Date().toISOString(),
          ...(action.missionId ? { missionId: action.missionId } : {}),
        },
        payload: action,
      });
      if (response.status === 'error') {
        if (response.error.code === 'PERMISSION_REQUIRED') {
          setPermissionRequired(true);
          onPermissionRequired();
        }
        throw new Error(response.error.message);
      }
      setResult(BrowserActionResultSchema.parse(response.data));
      await load();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Browser action failed.');
    } finally {
      activeRequestId.current = undefined;
      activeActionId.current = undefined;
      setRunning(false);
    }
  };

  const createSession = (): void => {
    if (!status) return;
    void execute(
      BrowserActionInputSchema.parse({
        actionId: crypto.randomUUID(),
        action: 'CREATE_SESSION',
        target: { kind: 'browser', id: 'isolated-edge', display: 'Isolated Microsoft Edge' },
        parameters: {
          profileMode: 'TEMPORARY',
          allowedOrigins: [],
          downloadDirectory: status.managedDownloadDirectory,
          headless: false,
        },
      }),
    );
  };

  const navigate = (): void => {
    const session = sessions[0];
    if (!session) return;
    try {
      const parsed = new URL(url);
      void execute(
        BrowserActionInputSchema.parse({
          actionId: crypto.randomUUID(),
          action: 'NAVIGATE',
          sessionId: session.sessionId,
          target: { kind: 'page', id: parsed.origin, display: parsed.hostname },
          parameters: { url: parsed.href, expectedOrigin: parsed.origin },
        }),
      );
    } catch {
      setError(
        thai ? 'กรุณาใส่ URL แบบ HTTP หรือ HTTPS ที่ถูกต้อง' : 'Enter a valid HTTP or HTTPS URL.',
      );
    }
  };

  const readPage = (): void => {
    const session = sessions[0];
    if (!session?.activeTabId) return;
    void execute(
      BrowserActionInputSchema.parse({
        actionId: crypto.randomUUID(),
        action: 'READ_PAGE',
        sessionId: session.sessionId,
        tabId: session.activeTabId,
        target: { kind: 'page', id: session.activeTabId, display: 'Active isolated page' },
        parameters: { maxCharacters: 8_000 },
      }),
    );
  };

  const closeSession = (): void => {
    const session = sessions[0];
    if (!session) return;
    void execute(
      BrowserActionInputSchema.parse({
        actionId: crypto.randomUUID(),
        action: 'CLOSE_SESSION',
        sessionId: session.sessionId,
        target: { kind: 'session', id: session.sessionId, display: 'Isolated browser session' },
        parameters: {},
      }),
    );
  };

  const cancel = async (): Promise<void> => {
    if (activeRequestId.current) await window.jupiter.cancel(activeRequestId.current);
    if (activeActionId.current) {
      await rpc('command', 'browser.cancel', { actionId: activeActionId.current });
    }
  };

  return (
    <Surface
      className="browser-agent-panel"
      data-browser-state={status?.available ? 'operational' : 'unavailable'}
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">PLAYWRIGHT · ISOLATED PROCESS</span>
          <h2>{thai ? 'Browser Agent' : 'Browser Agent'}</h2>
          <p>
            {thai
              ? 'เนื้อหาเว็บเป็นข้อมูลที่ไม่เชื่อถือ โปรไฟล์ชั่วคราวเป็นค่าเริ่มต้น และไม่มี coordinate fallback'
              : 'Web content is untrusted, temporary profiles are the default, and coordinate fallback is disabled.'}
          </p>
        </div>
        <StatusBadge tone={status?.available ? 'success' : status ? 'warning' : 'neutral'}>
          {status?.available ? 'Operational' : status ? 'Unavailable' : 'Loading'}
        </StatusBadge>
      </div>

      <div className="browser-controls">
        <label>
          <span>URL</span>
          <input
            disabled={running}
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
          />
        </label>
        <div className="button-row">
          <Button
            disabled={running || !status?.available || sessions.length > 0}
            type="button"
            onClick={createSession}
          >
            {thai ? 'สร้าง session ชั่วคราว' : 'Create temporary session'}
          </Button>
          <Button
            disabled={running || sessions.length === 0}
            type="button"
            variant="secondary"
            onClick={navigate}
          >
            {thai ? 'เปิด URL' : 'Navigate'}
          </Button>
          <Button
            disabled={running || !sessions[0]?.activeTabId}
            type="button"
            variant="secondary"
            onClick={readPage}
          >
            {thai ? 'อ่านข้อความ' : 'Read page'}
          </Button>
          <Button
            disabled={running || sessions.length === 0}
            type="button"
            variant="danger"
            onClick={closeSession}
          >
            {thai ? 'ปิด session' : 'Close session'}
          </Button>
          {running && (
            <Button type="button" variant="danger" onClick={() => void cancel()}>
              {thai ? 'ยกเลิก' : 'Cancel'}
            </Button>
          )}
        </div>
      </div>

      {permissionRequired && (
        <p className="computer-running">
          {thai
            ? 'รอการอนุมัติใน Permission Center แล้วกดคำสั่งเดิมอีกครั้ง'
            : 'Approve in Permission Center, then retry the same action.'}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="browser-result" data-testid="browser-action-result">
          <StatusBadge
            tone={result.success ? 'success' : result.status === 'PAUSED' ? 'warning' : 'error'}
          >
            {result.status}
          </StatusBadge>
          <strong>{result.action}</strong>
          <span>{result.observation}</span>
          {result.page && (
            <small>
              {result.page.title} · {result.page.origin}
            </small>
          )}
          {result.securitySignals.map((signal) => (
            <small key={`${signal.type}-${signal.description}`}>
              {signal.type}: {signal.description}
            </small>
          ))}
          {result.output?.visibleText && <pre>{result.output.visibleText}</pre>}
        </div>
      )}

      <div className="browser-history">
        <strong>
          {thai ? 'ประวัติที่เก็บแบบตัดเนื้อหาเว็บออก' : 'Redacted action history'} ·{' '}
          {history.length}
        </strong>
        {history.slice(0, 5).map((action) => (
          <small key={action.actionId}>
            {action.status} · {action.action} · {action.observation}
          </small>
        ))}
      </div>
    </Surface>
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
