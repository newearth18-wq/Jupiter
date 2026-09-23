import {
  SkillExecutionResultSchema,
  SkillListResultSchema,
  SkillRegistryEntrySchema,
  type Language,
  type SkillExecutionResult,
  type SkillRegistryEntry,
} from '@jupiter/contracts';
import { Button, EmptyState, StatusBadge, Surface } from '@jupiter/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

export function SkillCenter({ language }: { language: Language }): React.JSX.Element {
  const th = language === 'th';
  const [skills, setSkills] = useState<SkillRegistryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [testInput, setTestInput] = useState('Hello Jupiter');
  const [result, setResult] = useState<SkillExecutionResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await window.jupiter.request({
        schemaVersion: 1,
        kind: 'query',
        name: 'skills.search',
        context: context(),
        payload: { query, ...(category ? { category } : {}) },
      });
      if (response.status === 'error') throw new Error(response.error.message);
      const next = SkillListResultSchema.parse(response.data).skills;
      setSkills(next);
      setSelectedId((current) =>
        current && next.some((entry) => entry.definition.skillId === current)
          ? current
          : next[0]?.definition.skillId,
      );
      setError(undefined);
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, [category, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 150);
    return () => window.clearTimeout(timer);
  }, [load]);

  const categories = useMemo(
    () => [...new Set(skills.map((entry) => entry.definition.category))].sort(),
    [skills],
  );
  const selected = skills.find((entry) => entry.definition.skillId === selectedId);

  const update = async (action: 'enable' | 'disable' | 'health'): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await window.jupiter.request({
        schemaVersion: 1,
        kind: 'command',
        name:
          action === 'enable'
            ? 'skills.enable'
            : action === 'disable'
              ? 'skills.disable'
              : 'skills.health',
        context: context(),
        payload: { skillId: selected.definition.skillId },
      });
      if (response.status === 'error') throw new Error(response.error.message);
      SkillRegistryEntrySchema.parse((response.data as { skill: unknown }).skill);
      await load();
    } catch (updateError) {
      setError(messageOf(updateError));
    } finally {
      setBusy(false);
    }
  };

  const testSkill = async (): Promise<void> => {
    if (!selected || !isSafeTestSkill(selected)) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const input =
        selected.definition.skillId === 'echo_text'
          ? { text: testInput }
          : selected.definition.skillId === 'list_available_skills' && testInput.trim()
            ? { query: testInput.trim() }
            : {};
      const response = await window.jupiter.request({
        schemaVersion: 1,
        kind: 'command',
        name: 'skills.invoke',
        context: context(),
        payload: {
          executionId: crypto.randomUUID(),
          skillId: selected.definition.skillId,
          missionId: crypto.randomUUID(),
          input,
          permissions: [],
          timeoutMs: selected.definition.timeoutMs,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      if (response.status === 'error') throw new Error(response.error.message);
      setResult(SkillExecutionResultSchema.parse(response.data));
    } catch (testError) {
      setError(messageOf(testError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen" data-screen="skills">
      <header className="screen-header">
        <span className="j-eyebrow">Skill Registry</span>
        <h1 data-testid="screen-title">{th ? 'ศูนย์ทักษะ' : 'Skill Center'}</h1>
        <p>
          {th
            ? 'ทักษะแบบ typed ที่ตรวจ schema, permission, timeout, cancellation และ health ก่อนทำงาน'
            : 'Typed capabilities validated for schema, permissions, timeout, cancellation, and health before execution.'}
        </p>
      </header>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <Surface className="skill-toolbar">
        <label>
          <span>{th ? 'ค้นหา' : 'Search'}</span>
          <input
            data-testid="skill-search"
            placeholder={th ? 'ชื่อ, ID, ผู้ให้บริการ' : 'Name, ID, or provider'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>{th ? 'หมวดหมู่' : 'Category'}</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">{th ? 'ทั้งหมด' : 'All categories'}</option>
            {categories.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <Button disabled={busy} type="button" variant="ghost" onClick={() => void load()}>
          {th ? 'รีเฟรช' : 'Refresh'}
        </Button>
      </Surface>
      <div className="skill-center-grid">
        <Surface>
          <div className="panel-heading">
            <h2>{th ? 'ทักษะที่ลงทะเบียน' : 'Registered Skills'}</h2>
            <StatusBadge tone="neutral">{skills.length.toString()}</StatusBadge>
          </div>
          {skills.length === 0 ? (
            <EmptyState
              eyebrow="Unavailable"
              title={th ? 'ไม่พบทักษะ' : 'No Skills found'}
              description={
                th ? 'เปลี่ยนตัวกรองหรือตรวจ Core' : 'Change the filters or inspect Core health.'
              }
            />
          ) : (
            <div className="skill-list" role="list">
              {skills.map((entry) => (
                <button
                  aria-current={entry.definition.skillId === selectedId}
                  key={`${entry.definition.skillId}@${entry.definition.version}`}
                  type="button"
                  onClick={() => {
                    setSelectedId(entry.definition.skillId);
                    setResult(undefined);
                  }}
                >
                  <span>
                    <strong>{entry.definition.name}</strong>
                    <small>{entry.definition.skillId}</small>
                  </span>
                  <StatusBadge tone={healthTone(entry)}>{entry.health}</StatusBadge>
                </button>
              ))}
            </div>
          )}
        </Surface>
        {selected ? (
          <Surface className="skill-detail" data-testid="skill-detail">
            <div className="panel-heading">
              <div>
                <span className="j-eyebrow">{selected.definition.provider}</span>
                <h2>{selected.definition.name}</h2>
              </div>
              <StatusBadge tone={selected.enabled ? 'success' : 'neutral'}>
                {selected.enabled ? 'Enabled' : 'Disabled'}
              </StatusBadge>
            </div>
            <p>{selected.definition.description}</p>
            <dl className="skill-metadata">
              <Metric label="Skill ID" value={selected.definition.skillId} />
              <Metric label={th ? 'เวอร์ชัน' : 'Version'} value={selected.definition.version} />
              <Metric label={th ? 'หมวดหมู่' : 'Category'} value={selected.definition.category} />
              <Metric label="Health" value={selected.health} />
              <Metric
                label={th ? 'ตรวจล่าสุด' : 'Last check'}
                value={
                  selected.lastCheckedAt
                    ? new Intl.DateTimeFormat(language, {
                        dateStyle: 'medium',
                        timeStyle: 'medium',
                      }).format(new Date(selected.lastCheckedAt))
                    : 'Not checked'
                }
              />
              <Metric label="Runtime" value={selected.definition.compatibleRuntime} />
              <Metric
                label="Timeout"
                value={`${selected.definition.timeoutMs.toLocaleString()} ms`}
              />
            </dl>
            <div>
              <h3>{th ? 'สิทธิ์ที่ประกาศ' : 'Declared permissions'}</h3>
              <p>{selected.definition.permissions.join(', ') || (th ? 'ไม่มี' : 'None')}</p>
            </div>
            {selected.sanitizedError && <p className="inline-error">{selected.sanitizedError}</p>}
            <div className="button-row">
              <Button
                disabled={busy}
                type="button"
                variant="secondary"
                onClick={() => void update('health')}
              >
                {th ? 'ตรวจ Health' : 'Check health'}
              </Button>
              <Button
                disabled={busy}
                type="button"
                variant={selected.enabled ? 'danger' : 'primary'}
                onClick={() => void update(selected.enabled ? 'disable' : 'enable')}
              >
                {selected.enabled ? (th ? 'ปิดใช้' : 'Disable') : th ? 'เปิดใช้' : 'Enable'}
              </Button>
            </div>
            <div className="skill-test-panel">
              <h3>{th ? 'ทดสอบแบบจำกัดสิทธิ์' : 'Safe test'}</h3>
              {isSafeTestSkill(selected) ? (
                <>
                  {['echo_text', 'list_available_skills'].includes(selected.definition.skillId) && (
                    <label>
                      <span>{selected.definition.skillId === 'echo_text' ? 'Text' : 'Query'}</span>
                      <input
                        value={testInput}
                        onChange={(event) => setTestInput(event.target.value)}
                      />
                    </label>
                  )}
                  <Button
                    disabled={busy || !selected.enabled || selected.health !== 'HEALTHY'}
                    type="button"
                    onClick={() => void testSkill()}
                  >
                    {busy ? (th ? 'กำลังทำงาน…' : 'Running…') : th ? 'เรียกทักษะ' : 'Invoke Skill'}
                  </Button>
                </>
              ) : (
                <p>
                  Unavailable —{' '}
                  {th
                    ? 'ทักษะนี้ต้องใช้สิทธิ์เพิ่มเติม'
                    : 'this Skill requires additional permissions.'}
                </p>
              )}
              {result && (
                <div className="skill-test-result" data-testid="skill-test-result">
                  <StatusBadge tone={result.status === 'SUCCESS' ? 'success' : 'error'}>
                    {result.status}
                  </StatusBadge>
                  <pre>{JSON.stringify(result.output ?? result.error, null, 2)}</pre>
                </div>
              )}
            </div>
          </Surface>
        ) : (
          <Surface>
            <EmptyState
              eyebrow="Skill Registry"
              title={th ? 'เลือกทักษะ' : 'Select a Skill'}
              description={
                th
                  ? 'เลือกทักษะเพื่อดู metadata และ health'
                  : 'Select a Skill to inspect metadata and health.'
              }
            />
          </Surface>
        )}
      </div>
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

function isSafeTestSkill(entry: SkillRegistryEntry): boolean {
  return entry.definition.provider === 'Jupiter' && entry.definition.permissions.length === 0;
}

function healthTone(entry: SkillRegistryEntry): 'success' | 'warning' | 'error' | 'neutral' {
  if (!entry.enabled) return 'neutral';
  if (entry.health === 'HEALTHY') return 'success';
  if (entry.health === 'UNHEALTHY') return 'error';
  return 'warning';
}

function context() {
  return {
    requestId: crypto.randomUUID(),
    actor: 'renderer' as const,
    timestamp: new Date().toISOString(),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Skill Center request failed.';
}
