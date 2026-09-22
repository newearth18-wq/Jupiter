import {
  DiagnosticsSnapshotSchema,
  EventsReplayResultSchema,
  type BootstrapState,
  type DiagnosticsSnapshot,
  type DomainEvent,
} from '@jupiter/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCopy } from './copy.js';

type View = 'home' | 'diagnostics' | 'settings';

function readView(): View {
  const value = window.location.hash.replace('#/', '');
  return value === 'diagnostics' || value === 'settings' ? value : 'home';
}

export function App(): React.JSX.Element {
  const strings = getCopy();
  const [state, setState] = useState<BootstrapState>();
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot>();
  const [loadError, setLoadError] = useState<string>();
  const [diagnosticsError, setDiagnosticsError] = useState<string>();
  const [view, setView] = useState<View>(readView());
  const eventCursor = useRef(readEventCursor());

  const loadDiagnostics = useCallback(async () => {
    try {
      const response = await window.jupiter.request({
        schemaVersion: 1,
        kind: 'query',
        name: 'diagnostics.get',
        context: rendererContext(),
        payload: {},
      });
      if (response.status === 'error') throw new Error(response.error.message);
      setDiagnostics(DiagnosticsSnapshotSchema.parse(response.data));
      setDiagnosticsError(undefined);
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : 'Diagnostics are unavailable');
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setLoadError(undefined);
      setState(await window.jupiter.getBootstrapState());
      await loadDiagnostics();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unknown bootstrap error');
    }
  }, [loadDiagnostics]);

  useEffect(() => {
    void load();
    const onHashChange = (): void => setView(readView());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [load]);

  useEffect(() => {
    const acceptEvent = (event: DomainEvent): void => {
      if (event.sequence <= eventCursor.current) return;
      eventCursor.current = event.sequence;
      writeEventCursor(event.sequence);
      if (event.type === 'service.health.changed') void loadDiagnostics();
    };
    const unsubscribe = window.jupiter.onDomainEvent(acceptEvent);
    void window.jupiter
      .request({
        schemaVersion: 1,
        kind: 'query',
        name: 'events.replay',
        context: rendererContext(),
        payload: { afterSequence: eventCursor.current, limit: 500 },
      })
      .then((response) => {
        if (response.status === 'error') throw new Error(response.error.message);
        const replay = EventsReplayResultSchema.parse(response.data);
        replay.events.forEach(acceptEvent);
      })
      .catch((error: unknown) => {
        setDiagnosticsError(error instanceof Error ? error.message : 'Event replay is unavailable');
      });
    return unsubscribe;
  }, [loadDiagnostics]);

  const retry = async (): Promise<void> => {
    if (!state) return;
    try {
      setState(await window.jupiter.retryStartup(crypto.randomUUID()));
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Startup retry failed');
    }
  };

  const refreshHealth = async (): Promise<void> => {
    try {
      const response = await window.jupiter.request({
        schemaVersion: 1,
        kind: 'command',
        name: 'core.health.refresh',
        context: rendererContext(),
        payload: {},
      });
      if (response.status === 'error') throw new Error(response.error.message);
      setDiagnostics(DiagnosticsSnapshotSchema.parse(response.data));
      setDiagnosticsError(undefined);
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : 'Health refresh failed');
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/home" aria-label="Jupiter home">
          <span className="brand-mark" aria-hidden="true" />
          <span>Jupiter</span>
        </a>
        <nav aria-label="Foundation navigation">
          <a aria-current={view === 'home' ? 'page' : undefined} href="#/home">
            {strings.home}
          </a>
          <a aria-current={view === 'diagnostics' ? 'page' : undefined} href="#/diagnostics">
            {strings.diagnostics}
          </a>
          <a aria-current={view === 'settings' ? 'page' : undefined} href="#/settings">
            {strings.settings}
          </a>
        </nav>
      </header>

      <main>
        {!state && !loadError && <p className="loading">{strings.loading}</p>}
        {loadError && (
          <section className="error-card" role="alert">
            <p className="eyebrow">Runtime error</p>
            <h1>Jupiter could not read its runtime state.</h1>
            <p>{loadError}</p>
            <button type="button" onClick={() => void load()}>
              {strings.retry}
            </button>
          </section>
        )}
        {state && view === 'home' && (
          <Home state={state} diagnostics={diagnostics} onRetry={retry} />
        )}
        {state && view === 'diagnostics' && (
          <Diagnostics
            state={state}
            diagnostics={diagnostics}
            error={diagnosticsError}
            onRefresh={refreshHealth}
          />
        )}
        {state && view === 'settings' && (
          <section className="content-card">
            <p className="eyebrow">{strings.notConfigured}</p>
            <h1>{strings.settings}</h1>
            <p>{strings.settingsMessage}</p>
          </section>
        )}
      </main>
    </div>
  );
}

function Home({
  state,
  diagnostics,
  onRetry,
}: {
  state: BootstrapState;
  diagnostics: DiagnosticsSnapshot | undefined;
  onRetry: () => Promise<void>;
}): React.JSX.Element {
  const strings = getCopy();
  const healthy = state.runtime.status === 'operational' && diagnostics?.status === 'operational';
  const healthLabel = diagnostics
    ? healthy
      ? strings.operational
      : strings.degraded
    : 'Unavailable';
  return (
    <section className="hero">
      <div className="orbital-mark" aria-hidden="true">
        <span className="orbit orbit-one" />
        <span className="orbit orbit-two" />
        <span className="core" />
      </div>
      <p className="eyebrow">Jupiter · {strings.foundation}</p>
      <h1>{strings.intro}</h1>
      <p className="lede">{strings.deferred}</p>
      <div className={`status-card ${healthy ? 'status-ok' : 'status-warning'}`}>
        <span className="status-dot" aria-hidden="true" />
        <div>
          <strong data-testid="runtime-status">{healthLabel}</strong>
          <span>
            v{state.metadata.version} · {state.metadata.platform}/{state.metadata.architecture} ·{' '}
            {state.metadata.environment}
          </span>
        </div>
      </div>
      {state.runtime.startupError && (
        <div className="recovery" role="alert">
          <strong>{state.runtime.startupError.message}</strong>
          <span>{state.runtime.startupError.userAction}</span>
          <button type="button" onClick={() => void onRetry()}>
            {strings.retry}
          </button>
        </div>
      )}
      <div className="deferred-grid" aria-label="Deferred capabilities">
        {['AI Models', 'Missions', 'Skills', 'Memory', 'Automations', 'Devices', 'Plugins'].map(
          (feature) => (
            <div key={feature}>
              <span>{feature}</span>
              <small>Coming later</small>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function Diagnostics({
  state,
  diagnostics,
  error,
  onRefresh,
}: {
  state: BootstrapState;
  diagnostics: DiagnosticsSnapshot | undefined;
  error: string | undefined;
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const strings = getCopy();
  return (
    <section className="content-card">
      <p className="eyebrow">Actual runtime data</p>
      <h1>{strings.diagnostics}</h1>
      <dl className="diagnostics-list">
        <div>
          <dt>Version</dt>
          <dd>{state.metadata.version}</dd>
        </div>
        <div>
          <dt>Build</dt>
          <dd>{state.metadata.buildId}</dd>
        </div>
        <div>
          <dt>Commit</dt>
          <dd>{state.metadata.commit}</dd>
        </div>
        <div>
          <dt>Channel</dt>
          <dd>{state.metadata.buildChannel}</dd>
        </div>
        <div>
          <dt>Electron</dt>
          <dd>{state.metadata.electronVersion}</dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>{diagnostics?.status ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Database</dt>
          <dd>
            {diagnostics
              ? `${diagnostics.database.engine} / ${diagnostics.database.status}`
              : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Schema / journal</dt>
          <dd>
            {diagnostics
              ? `${String(diagnostics.database.schemaVersion)} / ${diagnostics.database.journalMode}`
              : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Integrity / foreign keys</dt>
          <dd>
            {diagnostics
              ? `${diagnostics.database.integrity} / ${diagnostics.database.foreignKeysEnabled ? 'enabled' : 'disabled'}`
              : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt>Persistent records</dt>
          <dd>
            {diagnostics
              ? `${String(diagnostics.database.eventCount)} events / ${String(diagnostics.database.auditCount)} audit entries`
              : 'Unavailable'}
          </dd>
        </div>
      </dl>
      {error && (
        <p className="diagnostics-error" role="alert">
          {error}
        </p>
      )}
      {(diagnostics?.services ?? []).map((service) => (
        <article className="service-row" key={service.serviceId}>
          <div>
            <strong>{service.serviceId}</strong>
            <span>{service.status}</span>
          </div>
          <time dateTime={service.lastCheck}>{service.lastCheck}</time>
          {service.sanitizedError && <p>{service.sanitizedError}</p>}
        </article>
      ))}
      {!diagnostics && !error && <p className="loading">{strings.loading}</p>}
      <button type="button" onClick={() => void onRefresh()}>
        Refresh health
      </button>
    </section>
  );
}

function rendererContext(): {
  requestId: string;
  actor: 'renderer';
  timestamp: string;
} {
  return {
    requestId: crypto.randomUUID(),
    actor: 'renderer',
    timestamp: new Date().toISOString(),
  };
}

function readEventCursor(): number {
  try {
    const value = Number(sessionStorage.getItem('jupiter:event-cursor') ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeEventCursor(sequence: number): void {
  try {
    sessionStorage.setItem('jupiter:event-cursor', String(sequence));
  } catch {
    // Event replay remains correct for the current renderer session.
  }
}
