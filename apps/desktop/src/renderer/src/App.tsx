import type { BootstrapState } from '@jupiter/contracts';
import { useCallback, useEffect, useState } from 'react';
import { getCopy } from './copy.js';

type View = 'home' | 'diagnostics' | 'settings';

function readView(): View {
  const value = window.location.hash.replace('#/', '');
  return value === 'diagnostics' || value === 'settings' ? value : 'home';
}

export function App(): React.JSX.Element {
  const strings = getCopy();
  const [state, setState] = useState<BootstrapState>();
  const [loadError, setLoadError] = useState<string>();
  const [view, setView] = useState<View>(readView());

  const load = useCallback(async () => {
    try {
      setLoadError(undefined);
      setState(await window.jupiter.getBootstrapState());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unknown bootstrap error');
    }
  }, []);

  useEffect(() => {
    void load();
    const onHashChange = (): void => setView(readView());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [load]);

  const retry = async (): Promise<void> => {
    if (!state) return;
    try {
      setState(await window.jupiter.retryStartup(crypto.randomUUID()));
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Startup retry failed');
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
        {state && view === 'home' && <Home state={state} onRetry={retry} />}
        {state && view === 'diagnostics' && <Diagnostics state={state} onRetry={retry} />}
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
  onRetry,
}: {
  state: BootstrapState;
  onRetry: () => Promise<void>;
}): React.JSX.Element {
  const strings = getCopy();
  const healthy = state.runtime.status === 'operational';
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
          <strong data-testid="runtime-status">
            {healthy ? strings.operational : strings.degraded}
          </strong>
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
  onRetry,
}: {
  state: BootstrapState;
  onRetry: () => Promise<void>;
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
          <dd>{state.runtime.status}</dd>
        </div>
      </dl>
      {state.runtime.services.map((service) => (
        <article className="service-row" key={service.serviceId}>
          <div>
            <strong>{service.serviceId}</strong>
            <span>{service.status}</span>
          </div>
          <time dateTime={service.lastCheck}>{service.lastCheck}</time>
          {service.sanitizedError && <p>{service.sanitizedError}</p>}
        </article>
      ))}
      {state.runtime.status !== 'operational' && (
        <button type="button" onClick={() => void onRetry()}>
          {strings.retry}
        </button>
      )}
    </section>
  );
}
