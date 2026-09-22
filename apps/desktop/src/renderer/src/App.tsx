import {
  DEFAULT_UI_PREFERENCES,
  DiagnosticsSnapshotSchema,
  EventsReplayResultSchema,
  ScreenIdSchema,
  UiPreferencesSchema,
  type BootstrapState,
  type DiagnosticsSnapshot,
  type DomainEvent,
  type ScreenId,
  type UiPreferences,
  type UiPreferencesUpdate,
} from '@jupiter/contracts';
import {
  Button,
  Dialog,
  EmptyState,
  StatusBadge,
  Surface,
  Tabs,
  ToastRegion,
  type ToastMessage,
} from '@jupiter/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createTranslator, preferredLanguage, type CopyKey, type Translator } from './copy.js';
import { windowsNotificationBridge } from './notification-bridge.js';

type DialogName = 'permission' | 'identity' | undefined;

const NAVIGATION: readonly { id: ScreenId; label: CopyKey; icon: string }[] = [
  { id: 'home', label: 'home', icon: 'home' },
  { id: 'chat', label: 'chat', icon: 'chat' },
  { id: 'missions', label: 'missions', icon: 'mission' },
  { id: 'skills', label: 'skills', icon: 'skill' },
  { id: 'memory', label: 'memory', icon: 'memory' },
  { id: 'files', label: 'files', icon: 'file' },
  { id: 'automations', label: 'automations', icon: 'automation' },
  { id: 'models', label: 'models', icon: 'model' },
  { id: 'devices', label: 'devices', icon: 'device' },
  { id: 'plugins', label: 'plugins', icon: 'plugin' },
  { id: 'settings', label: 'settings', icon: 'settings' },
  { id: 'diagnostics', label: 'diagnostics', icon: 'diagnostics' },
];

const DEFERRED_SCREENS: Readonly<
  Partial<Record<ScreenId, { title: CopyKey; description: CopyKey; availability: CopyKey }>>
> = {
  chat: { title: 'chatTitle', description: 'chatDescription', availability: 'notConfigured' },
  missions: {
    title: 'missionsTitle',
    description: 'missionsDescription',
    availability: 'unavailable',
  },
  skills: {
    title: 'skillsTitle',
    description: 'skillsDescription',
    availability: 'comingLater',
  },
  memory: {
    title: 'memoryTitle',
    description: 'memoryDescription',
    availability: 'unavailable',
  },
  files: {
    title: 'filesTitle',
    description: 'filesDescription',
    availability: 'unavailable',
  },
  automations: {
    title: 'automationsTitle',
    description: 'automationsDescription',
    availability: 'comingLater',
  },
  models: {
    title: 'modelsTitle',
    description: 'modelsDescription',
    availability: 'notConfigured',
  },
  devices: {
    title: 'devicesTitle',
    description: 'devicesDescription',
    availability: 'notConfigured',
  },
  plugins: {
    title: 'pluginsTitle',
    description: 'pluginsDescription',
    availability: 'comingLater',
  },
};

export function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<BootstrapState>();
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot>();
  const [preferences, setPreferences] = useState<UiPreferences>({
    ...DEFAULT_UI_PREFERENCES,
    language: preferredLanguage(),
  });
  const [view, setView] = useState<ScreenId>(screenFromHash() ?? 'home');
  const [events, setEvents] = useState<DomainEvent[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [diagnosticsError, setDiagnosticsError] = useState<string>();
  const [dialog, setDialog] = useState<DialogName>();
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const eventCursor = useRef(readEventCursor());
  const t = useMemo(() => createTranslator(preferences.language), [preferences.language]);

  const addToast = useCallback((message: string, tone: ToastMessage['tone']): void => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3_500);
  }, []);

  const loadDiagnostics = useCallback(async (): Promise<void> => {
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
      setDiagnostics(undefined);
      setDiagnosticsError(sanitizedMessage(error));
    }
  }, []);

  const readPreferences = useCallback(async (): Promise<UiPreferences> => {
    const response = await window.jupiter.request({
      schemaVersion: 1,
      kind: 'query',
      name: 'ui.preferences.get',
      context: rendererContext(),
      payload: {},
    });
    if (response.status === 'error') throw new Error(response.error.message);
    return UiPreferencesSchema.parse(response.data);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      setLoadError(undefined);
      const [nextBootstrap, nextPreferences] = await Promise.all([
        window.jupiter.getBootstrapState(),
        readPreferences(),
      ]);
      setBootstrap(nextBootstrap);
      setPreferences(nextPreferences);
      const initialView = screenFromHash() ?? nextPreferences.lastView;
      setView(initialView);
      if (!screenFromHash()) window.history.replaceState(null, '', `#/${initialView}`);
      await loadDiagnostics();
    } catch (error) {
      setLoadError(sanitizedMessage(error));
    }
  }, [loadDiagnostics, readPreferences]);

  const updatePreferences = useCallback(
    async (update: UiPreferencesUpdate, notify = true): Promise<void> => {
      try {
        const response = await window.jupiter.request({
          schemaVersion: 1,
          kind: 'command',
          name: 'ui.preferences.update',
          context: rendererContext(),
          payload: update,
        });
        if (response.status === 'error') throw new Error(response.error.message);
        setPreferences(UiPreferencesSchema.parse(response.data));
        if (notify) addToast(t('preferenceSaved'), 'success');
      } catch {
        addToast(t('saveError'), 'error');
      }
    },
    [addToast, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onHashChange = (): void => {
      const nextView = screenFromHash() ?? 'home';
      setView(nextView);
      void updatePreferences({ lastView: nextView }, false);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [updatePreferences]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      let destination: ScreenId | undefined;
      if (event.altKey && event.key === '1') destination = 'home';
      if (event.ctrlKey && event.key === ',') destination = 'settings';
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        destination = 'diagnostics';
      }
      if (!destination) return;
      event.preventDefault();
      window.location.hash = `#/${destination}`;
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  useEffect(() => {
    document.documentElement.lang = preferences.language;
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.dataset.motion = preferences.reduceMotion ? 'reduced' : 'full';
    document.documentElement.dataset.density = preferences.compactMode ? 'compact' : 'comfortable';
    document.documentElement.style.setProperty('--j-text-scale', String(preferences.textScale));
  }, [preferences]);

  useEffect(() => {
    const acceptEvent = (event: DomainEvent): void => {
      if (event.sequence <= eventCursor.current) return;
      eventCursor.current = event.sequence;
      writeEventCursor(event.sequence);
      setEvents((current) => [...current, event].slice(-20));
      if (event.type === 'service.health.changed') void loadDiagnostics();
      if (event.type === 'ui.preferences.updated') {
        void readPreferences()
          .then(setPreferences)
          .catch(() => undefined);
      }
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
        EventsReplayResultSchema.parse(response.data).events.forEach(acceptEvent);
      })
      .catch((error: unknown) => setDiagnosticsError(sanitizedMessage(error)));
    return unsubscribe;
  }, [loadDiagnostics, readPreferences]);

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
      setDiagnosticsError(sanitizedMessage(error));
    }
  };

  if (!bootstrap && !loadError) {
    return (
      <main className="startup-state" aria-busy="true">
        <JupiterAvatar mode={preferences.avatarMode} status="offline" />
        <p>{t('loading')}</p>
      </main>
    );
  }

  if (loadError || !bootstrap) {
    return (
      <main className="startup-state" data-testid="fatal-state">
        <StatusBadge tone="error">{t('offline')}</StatusBadge>
        <h1>{t('loadFailed')}</h1>
        <p>{loadError ?? t('failureNextStep')}</p>
        <Button type="button" onClick={() => void load()}>
          {t('retry')}
        </Button>
      </main>
    );
  }

  const runtimeStatus =
    bootstrap.runtime.status !== 'operational'
      ? 'degraded'
      : (diagnostics?.status ?? (diagnosticsError ? 'offline' : 'degraded'));

  return (
    <div
      aria-label={t('appShell')}
      className={`product-shell ${preferences.compactMode ? 'product-shell--compact' : ''}`}
    >
      <a className="skip-link" href="#main-content">
        {t('skipToContent')}
      </a>
      <header className="window-titlebar">
        <span className="titlebar-mark" aria-hidden="true" />
        <span>{t('appName')}</span>
        <span className="titlebar-status" data-testid="runtime-status">
          {statusLabel(runtimeStatus, t)}
        </span>
      </header>
      <aside className="sidebar">
        <div className="sidebar-brand" aria-hidden="true">
          <span className="sidebar-orb" />
          <strong>{t('appName')}</strong>
        </div>
        <nav aria-label={t('primaryNavigation')}>
          {NAVIGATION.map((item) => (
            <a
              aria-current={view === item.id ? 'page' : undefined}
              aria-keyshortcuts={navigationShortcut(item.id)}
              data-nav-id={item.id}
              href={`#/${item.id}`}
              key={item.id}
            >
              <NavIcon name={item.icon} />
              <span>{t(item.label)}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <StatusBadge tone={runtimeTone(runtimeStatus)}>
            {statusLabel(runtimeStatus, t)}
          </StatusBadge>
          <Button
            aria-label={preferences.compactMode ? t('expandNavigation') : t('collapseNavigation')}
            data-testid="compact-toggle"
            type="button"
            variant="ghost"
            onClick={() => void updatePreferences({ compactMode: !preferences.compactMode })}
          >
            <NavIcon name="collapse" />
            <span>{preferences.compactMode ? t('expandNavigation') : t('collapseNavigation')}</span>
          </Button>
        </div>
      </aside>
      <main id="main-content" className="workspace" tabIndex={-1}>
        <Screen
          bootstrap={bootstrap}
          diagnostics={diagnostics}
          diagnosticsError={diagnosticsError}
          events={events}
          preferences={preferences}
          runtimeStatus={runtimeStatus}
          t={t}
          view={view}
          onDialog={setDialog}
          onRefresh={refreshHealth}
          onUpdatePreferences={updatePreferences}
        />
      </main>
      <ToastRegion label={t('toastRegion')} messages={toasts} />
      <Dialog
        closeLabel={t('close')}
        description={t('permissionDescription')}
        open={dialog === 'permission'}
        title={t('permissionTitle')}
        onClose={() => setDialog(undefined)}
      >
        <p>{t('permissionBody')}</p>
      </Dialog>
      <Dialog
        closeLabel={t('close')}
        description={t('identityDescription')}
        open={dialog === 'identity'}
        title={t('identityTitle')}
        onClose={() => setDialog(undefined)}
      >
        <p>{t('identityBody')}</p>
      </Dialog>
    </div>
  );
}

function Screen({
  bootstrap,
  diagnostics,
  diagnosticsError,
  events,
  preferences,
  runtimeStatus,
  t,
  view,
  onDialog,
  onRefresh,
  onUpdatePreferences,
}: {
  bootstrap: BootstrapState;
  diagnostics: DiagnosticsSnapshot | undefined;
  diagnosticsError: string | undefined;
  events: readonly DomainEvent[];
  preferences: UiPreferences;
  runtimeStatus: 'operational' | 'degraded' | 'offline';
  t: Translator;
  view: ScreenId;
  onDialog: (dialog: DialogName) => void;
  onRefresh: () => Promise<void>;
  onUpdatePreferences: (update: UiPreferencesUpdate) => Promise<void>;
}): React.JSX.Element {
  if (view === 'home') {
    return (
      <CommandCenter
        events={events}
        preferences={preferences}
        runtimeStatus={runtimeStatus}
        t={t}
      />
    );
  }
  if (view === 'settings') {
    return (
      <SettingsScreen
        preferences={preferences}
        t={t}
        onDialog={onDialog}
        onUpdatePreferences={onUpdatePreferences}
      />
    );
  }
  if (view === 'diagnostics') {
    return (
      <DiagnosticsScreen
        bootstrap={bootstrap}
        diagnostics={diagnostics}
        error={diagnosticsError}
        t={t}
        onRefresh={onRefresh}
      />
    );
  }
  const screen = DEFERRED_SCREENS[view];
  if (!screen)
    return <EmptyState eyebrow={t('unavailable')} title={t('unavailable')} description="" />;
  return (
    <div className="screen" data-screen={view}>
      <ScreenHeader
        eyebrow={t(screen.availability)}
        title={t(screen.title)}
        description={t(screen.description)}
      />
      {view === 'chat' && <ChatComposer t={t} />}
      <Surface>
        <EmptyState
          description={t(screen.description)}
          eyebrow={t(screen.availability)}
          title={t(screen.title)}
        />
      </Surface>
    </div>
  );
}

function CommandCenter({
  events,
  preferences,
  runtimeStatus,
  t,
}: {
  events: readonly DomainEvent[];
  preferences: UiPreferences;
  runtimeStatus: 'operational' | 'degraded' | 'offline';
  t: Translator;
}): React.JSX.Element {
  return (
    <div className="screen command-center" data-screen="home">
      <ScreenHeader
        eyebrow={t('homeEyebrow')}
        title={t('homeTitle')}
        description={t('homeDescription')}
      />
      <div className="command-grid">
        <Surface className="jupiter-stage">
          <JupiterAvatar mode={preferences.avatarMode} status={runtimeStatus} />
          <StatusBadge tone={runtimeTone(runtimeStatus)}>
            {statusLabel(runtimeStatus, t)}
          </StatusBadge>
        </Surface>
        <MissionCard t={t} />
      </div>
      <ActivityTimeline events={events} language={preferences.language} t={t} />
      <ChatComposer t={t} />
    </div>
  );
}

function AppearanceSettings({
  preferences,
  t,
  onUpdatePreferences,
}: {
  preferences: UiPreferences;
  t: Translator;
  onUpdatePreferences: (update: UiPreferencesUpdate) => Promise<void>;
}): React.JSX.Element {
  return (
    <Surface>
      <h2>{t('appearance')}</h2>
      <label className="field-row">
        <span>{t('language')}</span>
        <select
          data-testid="language-select"
          value={preferences.language}
          onChange={(event) =>
            void onUpdatePreferences({ language: event.target.value === 'th' ? 'th' : 'en' })
          }
        >
          <option value="en">{t('english')}</option>
          <option value="th">{t('thai')}</option>
        </select>
      </label>
      <label className="field-row">
        <span>{t('theme')}</span>
        <select
          value={preferences.theme}
          onChange={(event) =>
            void onUpdatePreferences({
              theme: event.target.value === 'midnight' ? 'midnight' : 'dark',
            })
          }
        >
          <option value="dark">{t('darkTheme')}</option>
          <option value="midnight">{t('midnightTheme')}</option>
        </select>
      </label>
      <label className="field-row">
        <span>{t('avatar')}</span>
        <select
          value={preferences.avatarMode}
          onChange={(event) => {
            const result = event.target.value;
            void onUpdatePreferences({
              avatarMode:
                result === 'hidden' ? 'hidden' : result === 'static' ? 'static' : 'animated',
            });
          }}
        >
          <option value="animated">{t('avatarAnimated')}</option>
          <option value="static">{t('avatarStatic')}</option>
          <option value="hidden">{t('avatarHidden')}</option>
        </select>
      </label>
    </Surface>
  );
}

function AccessibilitySettings({
  preferences,
  t,
  onUpdatePreferences,
}: {
  preferences: UiPreferences;
  t: Translator;
  onUpdatePreferences: (update: UiPreferencesUpdate) => Promise<void>;
}): React.JSX.Element {
  return (
    <Surface>
      <h2>{t('accessibility')}</h2>
      <ToggleRow
        checked={preferences.reduceMotion}
        label={t('reduceMotion')}
        testId="reduce-motion-toggle"
        onChange={(checked) => void onUpdatePreferences({ reduceMotion: checked })}
      />
      <ToggleRow
        checked={preferences.compactMode}
        label={t('compactMode')}
        onChange={(checked) => void onUpdatePreferences({ compactMode: checked })}
      />
      <label className="field-row">
        <span>{t('textScale')}</span>
        <select
          value={preferences.textScale}
          onChange={(event) => {
            const value = Number(event.target.value);
            const textScale = value === 0.9 || value === 1.1 || value === 1.25 ? value : 1;
            void onUpdatePreferences({ textScale });
          }}
        >
          <option value="0.9">90%</option>
          <option value="1">100%</option>
          <option value="1.1">110%</option>
          <option value="1.25">125%</option>
        </select>
      </label>
    </Surface>
  );
}

function SafetySettings({
  t,
  onDialog,
}: {
  t: Translator;
  onDialog: (dialog: DialogName) => void;
}): React.JSX.Element {
  return (
    <Surface>
      <h2>{t('safetyInterfaces')}</h2>
      <div className="interface-list">
        <div>
          <span>{t('permissionInterface')}</span>
          <StatusBadge tone="warning">{t('unavailable')}</StatusBadge>
          <Button
            data-testid="permission-details"
            type="button"
            variant="secondary"
            onClick={() => onDialog('permission')}
          >
            {t('viewAvailability')}
          </Button>
        </div>
        <div>
          <span>{t('identityInterface')}</span>
          <StatusBadge tone="warning">{t('unavailable')}</StatusBadge>
          <Button type="button" variant="secondary" onClick={() => onDialog('identity')}>
            {t('viewAvailability')}
          </Button>
        </div>
        <div>
          <span>{t('windowsNotifications')}</span>
          <StatusBadge tone="neutral">{t(windowsNotificationBridge.availability)}</StatusBadge>
          <p>{t('windowsNotificationsBody')}</p>
        </div>
      </div>
    </Surface>
  );
}

function ScreenHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <header className="screen-header">
      <span className="j-eyebrow">{eyebrow}</span>
      <h1 data-testid="screen-title">{title}</h1>
      <p>{description}</p>
    </header>
  );
}

function JupiterAvatar({
  mode,
  status,
}: {
  mode: UiPreferences['avatarMode'];
  status: 'operational' | 'degraded' | 'offline';
}): React.JSX.Element {
  if (mode === 'hidden') return <div className="avatar-hidden" data-testid="jupiter-avatar" />;
  return (
    <div
      aria-hidden="true"
      className={`jupiter-avatar jupiter-avatar--${mode}`}
      data-status={status}
      data-testid="jupiter-avatar"
    >
      <span className="avatar-orbit avatar-orbit--one" />
      <span className="avatar-orbit avatar-orbit--two" />
      <span className="avatar-core">
        <span className="avatar-eye avatar-eye--left" />
        <span className="avatar-eye avatar-eye--right" />
      </span>
      <span className="avatar-particle avatar-particle--one" />
      <span className="avatar-particle avatar-particle--two" />
    </div>
  );
}

function MissionCard({ t }: { t: Translator }): React.JSX.Element {
  return (
    <Surface className="mission-card">
      <div className="panel-heading">
        <div>
          <span className="j-eyebrow">{t('currentMission')}</span>
          <h2>{t('noActiveMission')}</h2>
        </div>
        <StatusBadge tone="neutral">{t('unavailable')}</StatusBadge>
      </div>
      <p>{t('noActiveMissionDescription')}</p>
      <div className="mission-metadata">
        {(['elapsedTime', 'agent', 'skill', 'model'] as const).map((key) => (
          <div key={key}>
            <span>{t(key)}</span>
            <strong>{t('none')}</strong>
          </div>
        ))}
      </div>
      <p className="mission-progress">{t('progressUnavailable')}</p>
      <div className="button-row">
        <Button disabled type="button" variant="secondary">
          {t('pause')}
        </Button>
        <Button disabled type="button" variant="danger">
          {t('cancel')}
        </Button>
        <Button disabled type="button" variant="ghost">
          {t('details')}
        </Button>
      </div>
    </Surface>
  );
}

function ActivityTimeline({
  events,
  language,
  t,
}: {
  events: readonly DomainEvent[];
  language: UiPreferences['language'];
  t: Translator;
}): React.JSX.Element {
  const visibleEvents = events.slice(-6).reverse();
  return (
    <Surface className="timeline-panel">
      <div className="panel-heading">
        <h2>{t('timeline')}</h2>
        <StatusBadge tone="neutral">{String(visibleEvents.length)}</StatusBadge>
      </div>
      {visibleEvents.length === 0 ? (
        <p>{t('timelineEmpty')}</p>
      ) : (
        <ol className="timeline-list">
          {visibleEvents.map((event) => (
            <li key={event.eventId}>
              <time dateTime={event.occurredAt}>{formatTime(event.occurredAt, language)}</time>
              <span>{eventLabel(event.type, t)}</span>
            </li>
          ))}
        </ol>
      )}
    </Surface>
  );
}

function ChatComposer({ t }: { t: Translator }): React.JSX.Element {
  return (
    <Surface className="composer-shell">
      <label htmlFor="jupiter-composer">{t('composerLabel')}</label>
      <div>
        <textarea disabled id="jupiter-composer" placeholder={t('composerPlaceholder')} rows={2} />
        <Button disabled type="button">
          {t('send')}
        </Button>
      </div>
      <StatusBadge tone="warning">{t('notConfigured')}</StatusBadge>
    </Surface>
  );
}

function SettingsScreen({
  preferences,
  t,
  onDialog,
  onUpdatePreferences,
}: {
  preferences: UiPreferences;
  t: Translator;
  onDialog: (dialog: DialogName) => void;
  onUpdatePreferences: (update: UiPreferencesUpdate) => Promise<void>;
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState('appearance');
  const tabs = [
    {
      id: 'appearance',
      label: t('appearance'),
      panel: (
        <AppearanceSettings
          preferences={preferences}
          t={t}
          onUpdatePreferences={onUpdatePreferences}
        />
      ),
    },
    {
      id: 'accessibility',
      label: t('accessibility'),
      panel: (
        <AccessibilitySettings
          preferences={preferences}
          t={t}
          onUpdatePreferences={onUpdatePreferences}
        />
      ),
    },
    {
      id: 'safety',
      label: t('safetyInterfaces'),
      panel: <SafetySettings t={t} onDialog={onDialog} />,
    },
  ] as const;
  return (
    <div className="screen" data-screen="settings">
      <ScreenHeader
        eyebrow={t('operational')}
        title={t('settingsTitle')}
        description={t('settingsDescription')}
      />
      <Tabs activeId={activeTab} items={tabs} label={t('settingsTitle')} onChange={setActiveTab} />
    </div>
  );
}

function ToggleRow({
  checked,
  label,
  testId,
  onChange,
}: {
  checked: boolean;
  label: string;
  testId?: string;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input
        checked={checked}
        data-testid={testId}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function DiagnosticsScreen({
  bootstrap,
  diagnostics,
  error,
  t,
  onRefresh,
}: {
  bootstrap: BootstrapState;
  diagnostics: DiagnosticsSnapshot | undefined;
  error: string | undefined;
  t: Translator;
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const database = diagnostics?.database;
  return (
    <div className="screen" data-screen="diagnostics">
      <ScreenHeader
        eyebrow={diagnostics ? t('operational') : t('unavailable')}
        title={t('diagnosticsTitle')}
        description={t('diagnosticsDescription')}
      />
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <dl className="diagnostics-grid">
        <Metric label={t('version')} value={bootstrap.metadata.version} />
        <Metric label={t('build')} value={bootstrap.metadata.buildId} />
        <Metric label={t('commit')} value={bootstrap.metadata.commit} />
        <Metric label={t('runtime')} value={diagnostics?.status ?? t('unavailable')} />
        <Metric
          label={t('database')}
          value={database ? `${database.engine} / ${database.status}` : t('unavailable')}
        />
        <Metric
          label={t('schemaJournal')}
          value={
            database
              ? `${String(database.schemaVersion)} / ${database.journalMode}`
              : t('unavailable')
          }
        />
        <Metric
          label={t('integrityForeignKeys')}
          value={
            database
              ? `${database.integrity} / ${database.foreignKeysEnabled ? t('enabled') : t('disabled')}`
              : t('unavailable')
          }
        />
        <Metric
          label={t('records')}
          value={
            database
              ? `${String(database.eventCount)} ${t('events')} / ${String(database.auditCount)} ${t('auditEntries')}`
              : t('unavailable')
          }
        />
      </dl>
      <Surface>
        <div className="panel-heading">
          <h2>{t('serviceHealth')}</h2>
          <Button type="button" variant="secondary" onClick={() => void onRefresh()}>
            {t('refresh')}
          </Button>
        </div>
        {diagnostics?.services.length ? (
          diagnostics.services.map((service) => (
            <article className="service-row" key={service.serviceId}>
              <div>
                <strong>{service.serviceId}</strong>
                <StatusBadge tone={service.status === 'operational' ? 'success' : 'warning'}>
                  {service.status}
                </StatusBadge>
              </div>
              <time dateTime={service.lastCheck}>{service.lastCheck}</time>
              {service.sanitizedError && <p>{service.sanitizedError}</p>}
            </article>
          ))
        ) : (
          <p>{t('noServiceData')}</p>
        )}
      </Surface>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function NavIcon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, string> = {
    home: 'M3 11.5 12 4l9 7.5V21h-6v-6H9v6H3z',
    chat: 'M4 5h16v11H8l-4 4z',
    mission: 'M12 3a9 9 0 1 0 9 9h-3a6 6 0 1 1-6-6z',
    skill: 'm12 3 2.2 4.7L19 10l-4.8 2.3L12 17l-2.2-4.7L5 10l4.8-2.3z',
    memory: 'M6 5h12v14H6zm3 3h6M9 12h6M9 16h4',
    file: 'M6 3h8l4 4v14H6zm8 0v5h5',
    automation: 'M5 8h14M5 16h14M8 5v6M16 13v6',
    model: 'M12 3 4 7v10l8 4 8-4V7zm0 0v18M4 7l8 4 8-4',
    device: 'M7 4h10v16H7zm3 13h4',
    plugin: 'M8 3v5H3v8h5v5h8v-5h5V8h-5V3z',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-5v3m0 12v3M3 12h3m12 0h3',
    diagnostics: 'M4 19h16M6 16l4-5 3 3 5-8',
    collapse: 'm14 6-6 6 6 6',
  };
  return (
    <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 24 24">
      <path
        d={paths[name] ?? paths.home}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function runtimeTone(
  status: 'operational' | 'degraded' | 'offline',
): 'success' | 'warning' | 'error' {
  return status === 'operational' ? 'success' : status === 'degraded' ? 'warning' : 'error';
}

function statusLabel(status: 'operational' | 'degraded' | 'offline', t: Translator): string {
  if (status === 'operational') return t('coreOnline');
  if (status === 'degraded') return t('coreLimited');
  return t('coreUnavailable');
}

function eventLabel(type: string, t: Translator): string {
  if (type === 'core.started') return t('eventCoreStarted');
  if (type === 'core.stopped') return t('eventCoreStopped');
  if (type === 'service.health.changed') return t('eventServiceHealth');
  if (type === 'ui.preferences.updated') return t('eventPreferencesUpdated');
  return t('eventRecorded');
}

function formatTime(value: string, language: UiPreferences['language']): string {
  return new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function rendererContext(): { requestId: string; actor: 'renderer'; timestamp: string } {
  return {
    requestId: crypto.randomUUID(),
    actor: 'renderer',
    timestamp: new Date().toISOString(),
  };
}

function screenFromHash(): ScreenId | undefined {
  const result = ScreenIdSchema.safeParse(window.location.hash.replace('#/', ''));
  return result.success ? result.data : undefined;
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
    // Replay remains valid for the current renderer lifetime.
  }
}

function sanitizedMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  const language = document.documentElement.lang === 'th' ? 'th' : 'en';
  return createTranslator(language)('unknownRuntimeError');
}

function navigationShortcut(screen: ScreenId): string | undefined {
  if (screen === 'home') return 'Alt+1';
  if (screen === 'settings') return 'Control+,';
  if (screen === 'diagnostics') return 'Control+Shift+D';
  return undefined;
}
