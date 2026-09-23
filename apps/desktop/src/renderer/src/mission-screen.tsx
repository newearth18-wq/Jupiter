import {
  MissionDetailSchema,
  MissionListResultSchema,
  type Language,
  type Mission,
  type MissionDetail,
  type MissionPriority,
  type MissionStatus,
} from '@jupiter/contracts';
import { Button, EmptyState, StatusBadge, Surface } from '@jupiter/ui';
import { useCallback, useEffect, useState } from 'react';

const COPY = {
  en: {
    eyebrow: 'Mission Manager',
    title: 'Missions',
    description:
      'Durable actionable requests with explicit state, attempts, verification, and audit history.',
    newMission: 'New Mission',
    titleOptional: 'Title (optional)',
    request: 'Actionable request',
    requestPlaceholder: 'Describe the concrete outcome Jupiter should deliver.',
    priority: 'Priority',
    create: 'Create Mission',
    creating: 'Creating…',
    list: 'Mission list',
    refresh: 'Refresh',
    none: 'No Missions yet',
    noneDescription: 'Create an actionable request. Nothing will run until execution is available.',
    select: 'Select a Mission to inspect its durable record.',
    status: 'Status',
    progress: 'Progress',
    progressUnavailable: 'Unavailable — no execution steps exist.',
    currentStep: 'Current step',
    nextStep: 'Next step',
    elapsed: 'Elapsed',
    agent: 'Agent',
    model: 'Model',
    skills: 'Skills',
    notConfigured: 'Not configured',
    plan: 'Plan',
    planUnavailable: 'Not configured — planning arrives in a later SET.',
    userRequest: 'Original request',
    executionHistory: 'Execution history',
    attempts: 'attempts',
    steps: 'Steps',
    permissions: 'Permissions',
    artifacts: 'Artifacts',
    verification: 'Verification results',
    errors: 'Errors',
    timeline: 'Timeline',
    noRecords: 'No records.',
    pause: 'Pause',
    resume: 'Resume',
    cancel: 'Cancel',
    retry: 'Retry as new attempt',
    archive: 'Archive',
    confirmCancel: 'Cancel this Mission and propagate cancellation to active work?',
    confirmArchive: 'Archive this terminal Mission?',
    createdTruth:
      'Request saved. Analysis, planning, and execution are not started because the Planner is not available yet.',
    archived: 'Archived',
  },
  th: {
    eyebrow: 'ตัวจัดการภารกิจ',
    title: 'ภารกิจ',
    description: 'คำขอที่ลงมือทำได้และบันทึกถาวร พร้อมสถานะ รอบการทำงาน ผลตรวจ และประวัติ audit',
    newMission: 'ภารกิจใหม่',
    titleOptional: 'ชื่อ (ไม่บังคับ)',
    request: 'คำขอที่ต้องการให้ลงมือทำ',
    requestPlaceholder: 'อธิบายผลลัพธ์ที่ชัดเจนซึ่งต้องการให้ Jupiter ส่งมอบ',
    priority: 'ความสำคัญ',
    create: 'สร้างภารกิจ',
    creating: 'กำลังสร้าง…',
    list: 'รายการภารกิจ',
    refresh: 'รีเฟรช',
    none: 'ยังไม่มีภารกิจ',
    noneDescription: 'สร้างคำขอที่ลงมือทำได้ ระบบจะไม่เริ่มทำงานจนกว่าส่วนดำเนินงานจะพร้อม',
    select: 'เลือกภารกิจเพื่อตรวจข้อมูลที่บันทึกถาวร',
    status: 'สถานะ',
    progress: 'ความคืบหน้า',
    progressUnavailable: 'Unavailable — ยังไม่มีขั้นตอนการดำเนินงาน',
    currentStep: 'ขั้นตอนปัจจุบัน',
    nextStep: 'ขั้นตอนถัดไป',
    elapsed: 'เวลาที่ใช้',
    agent: 'Agent',
    model: 'โมเดล',
    skills: 'ทักษะ',
    notConfigured: 'ยังไม่ได้กำหนดค่า',
    plan: 'แผน',
    planUnavailable: 'Not configured — ระบบวางแผนจะมาใน SET ภายหลัง',
    userRequest: 'คำขอต้นฉบับ',
    executionHistory: 'ประวัติการดำเนินงาน',
    attempts: 'รอบ',
    steps: 'ขั้นตอน',
    permissions: 'สิทธิ์',
    artifacts: 'ผลงาน',
    verification: 'ผลการตรวจสอบ',
    errors: 'ข้อผิดพลาด',
    timeline: 'ลำดับเหตุการณ์',
    noRecords: 'ไม่มีข้อมูล',
    pause: 'หยุดชั่วคราว',
    resume: 'ทำต่อ',
    cancel: 'ยกเลิก',
    retry: 'ลองใหม่เป็นรอบใหม่',
    archive: 'เก็บถาวร',
    confirmCancel: 'ยกเลิกภารกิจนี้และส่งต่อการยกเลิกไปยังงานที่กำลังทำอยู่หรือไม่',
    confirmArchive: 'เก็บภารกิจที่สิ้นสุดแล้วนี้เข้าคลังหรือไม่',
    createdTruth:
      'บันทึกคำขอแล้ว แต่ยังไม่เริ่มวิเคราะห์ วางแผน หรือดำเนินงาน เพราะ Planner ยังไม่พร้อมใช้งาน',
    archived: 'เก็บถาวรแล้ว',
  },
} as const;

type Copy = { [K in keyof (typeof COPY)['en']]: string };

const TERMINAL = new Set<MissionStatus>(['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED']);

export function MissionScreen({ language }: { language: Language }): React.JSX.Element {
  const copy: Copy = COPY[language];
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<MissionDetail>();
  const [title, setTitle] = useState('');
  const [request, setRequest] = useState('');
  const [priority, setPriority] = useState<MissionPriority>('NORMAL');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const loadDetail = useCallback(async (missionId: string): Promise<void> => {
    const response = await window.jupiter.request({
      schemaVersion: 1,
      kind: 'query',
      name: 'missions.get',
      context: context(missionId),
      payload: { missionId },
    });
    if (response.status === 'error') throw new Error(response.error.message);
    setDetail(MissionDetailSchema.parse(response.data));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await window.jupiter.request({
        schemaVersion: 1,
        kind: 'query',
        name: 'missions.list',
        context: context(),
        payload: { includeArchived: false },
      });
      if (response.status === 'error') throw new Error(response.error.message);
      const next = MissionListResultSchema.parse(response.data).missions;
      setMissions(next);
      setError(undefined);
      const nextSelected = next.some((mission) => mission.missionId === selectedId)
        ? selectedId
        : next[0]?.missionId;
      setSelectedId(nextSelected);
      if (nextSelected) await loadDetail(nextSelected);
      else setDetail(undefined);
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, [loadDetail, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectMission = async (missionId: string): Promise<void> => {
    setSelectedId(missionId);
    setError(undefined);
    try {
      await loadDetail(missionId);
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  };

  const createMission = async (event: React.SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await window.jupiter.request({
        schemaVersion: 1,
        kind: 'command',
        name: 'missions.create',
        context: context(),
        payload: {
          userRequest: request.trim(),
          priority,
          ...(title.trim() ? { title: title.trim() } : {}),
        },
      });
      if (response.status === 'error') throw new Error(response.error.message);
      const created = MissionDetailSchema.parse(response.data);
      setTitle('');
      setRequest('');
      setSelectedId(created.mission.missionId);
      setDetail(created);
      setNotice(copy.createdTruth);
      await load();
    } catch (createError) {
      setError(messageOf(createError));
    } finally {
      setBusy(false);
    }
  };

  const control = async (
    action: 'pause' | 'resume' | 'cancel' | 'retry' | 'archive',
  ): Promise<void> => {
    if (!detail) return;
    if (action === 'cancel' && !window.confirm(copy.confirmCancel)) return;
    if (action === 'archive' && !window.confirm(copy.confirmArchive)) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const missionId = detail.mission.missionId;
      const response =
        action === 'pause'
          ? await window.jupiter.request({
              schemaVersion: 1,
              kind: 'command',
              name: 'missions.pause',
              context: context(missionId),
              payload: { missionId },
            })
          : action === 'resume'
            ? await window.jupiter.request({
                schemaVersion: 1,
                kind: 'command',
                name: 'missions.resume',
                context: context(missionId),
                payload: { missionId },
              })
            : action === 'cancel'
              ? await window.jupiter.request({
                  schemaVersion: 1,
                  kind: 'command',
                  name: 'missions.cancel',
                  context: context(missionId),
                  payload: { missionId },
                })
              : action === 'retry'
                ? await window.jupiter.request({
                    schemaVersion: 1,
                    kind: 'command',
                    name: 'missions.retry',
                    context: context(missionId),
                    payload: { missionId },
                  })
                : await window.jupiter.request({
                    schemaVersion: 1,
                    kind: 'command',
                    name: 'missions.archive',
                    context: context(missionId),
                    payload: { missionId },
                  });
      if (response.status === 'error') throw new Error(response.error.message);
      setDetail(MissionDetailSchema.parse(response.data));
      if (action === 'archive') setNotice(copy.archived);
      await load();
    } catch (controlError) {
      setError(messageOf(controlError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen" data-screen="missions">
      <header className="screen-header">
        <span className="j-eyebrow">{copy.eyebrow}</span>
        <h1 data-testid="screen-title">{copy.title}</h1>
        <p>{copy.description}</p>
      </header>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="inline-success" role="status">
          {notice}
        </p>
      )}
      <div className="mission-manager-grid">
        <div className="mission-manager-sidebar">
          <Surface>
            <h2>{copy.newMission}</h2>
            <form className="mission-create-form" onSubmit={(event) => void createMission(event)}>
              <label>
                <span>{copy.titleOptional}</span>
                <input
                  maxLength={160}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                <span>{copy.request}</span>
                <textarea
                  required
                  maxLength={100_000}
                  placeholder={copy.requestPlaceholder}
                  rows={5}
                  value={request}
                  onChange={(event) => setRequest(event.target.value)}
                />
              </label>
              <label>
                <span>{copy.priority}</span>
                <select
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as MissionPriority)}
                >
                  <option value="LOW">LOW</option>
                  <option value="NORMAL">NORMAL</option>
                  <option value="HIGH">HIGH</option>
                  <option value="CRITICAL">CRITICAL</option>
                </select>
              </label>
              <Button disabled={busy || request.trim().length === 0} type="submit">
                {busy ? copy.creating : copy.create}
              </Button>
            </form>
          </Surface>
          <Surface>
            <div className="panel-heading">
              <h2>{copy.list}</h2>
              <Button disabled={busy} type="button" variant="ghost" onClick={() => void load()}>
                {copy.refresh}
              </Button>
            </div>
            {missions.length === 0 ? (
              <EmptyState
                eyebrow={copy.eyebrow}
                title={copy.none}
                description={copy.noneDescription}
              />
            ) : (
              <div className="mission-list" role="list">
                {missions.map((mission) => (
                  <button
                    aria-current={mission.missionId === selectedId}
                    key={mission.missionId}
                    type="button"
                    onClick={() => void selectMission(mission.missionId)}
                  >
                    <strong>{mission.title}</strong>
                    <span>
                      {mission.status} · {mission.priority}
                    </span>
                    <time dateTime={mission.updatedAt}>
                      {formatDate(mission.updatedAt, language)}
                    </time>
                  </button>
                ))}
              </div>
            )}
          </Surface>
        </div>
        {detail ? (
          <MissionDetailPanel
            copy={copy}
            detail={detail}
            language={language}
            busy={busy}
            onControl={control}
          />
        ) : (
          <Surface>
            <EmptyState eyebrow={copy.eyebrow} title={copy.none} description={copy.select} />
          </Surface>
        )}
      </div>
    </div>
  );
}

function MissionDetailPanel({
  copy,
  detail,
  language,
  busy,
  onControl,
}: {
  copy: Copy;
  detail: MissionDetail;
  language: Language;
  busy: boolean;
  onControl: (action: 'pause' | 'resume' | 'cancel' | 'retry' | 'archive') => Promise<void>;
}): React.JSX.Element {
  const { mission } = detail;
  const latestExecution = detail.executions.at(-1);
  const activeSteps = latestExecution
    ? detail.steps.filter((step) => step.executionId === latestExecution.executionId)
    : [];
  const current =
    activeSteps.find((step) => step.stepId === mission.currentStepId) ??
    activeSteps.find((step) => step.status === 'RUNNING');
  const next = activeSteps.find((step) => step.status === 'PENDING');
  const completed = activeSteps.filter((step) => step.status === 'COMPLETED').length;
  const progress = activeSteps.length
    ? `${completed.toString()} / ${activeSteps.length.toString()} (${Math.round((completed / activeSteps.length) * 100).toString()}%)`
    : copy.progressUnavailable;
  const latestStep = current ?? activeSteps.at(-1);
  return (
    <div className="mission-detail" data-testid="mission-detail">
      <Surface>
        <div className="panel-heading">
          <div>
            <span className="j-eyebrow">{copy.status}</span>
            <h2>{mission.title}</h2>
          </div>
          <StatusBadge tone={statusTone(mission.status)}>{mission.status}</StatusBadge>
        </div>
        <p className="mission-request">{mission.userRequest}</p>
        <dl className="mission-summary-grid">
          <Metric label={copy.progress} value={progress} />
          <Metric label={copy.currentStep} value={current?.title ?? copy.notConfigured} />
          <Metric label={copy.nextStep} value={next?.title ?? copy.notConfigured} />
          <Metric
            label={copy.elapsed}
            value={elapsed(latestExecution?.startedAt, latestExecution?.endedAt, language)}
          />
          <Metric label={copy.agent} value={latestStep?.agent ?? copy.notConfigured} />
          <Metric label={copy.model} value={latestStep?.model ?? copy.notConfigured} />
          <Metric
            label={copy.skills}
            value={
              latestStep && latestStep.skills.length > 0
                ? latestStep.skills.join(', ')
                : copy.notConfigured
            }
          />
          <Metric label={copy.priority} value={mission.priority} />
        </dl>
        <div className="button-row mission-controls">
          {mission.status === 'RUNNING' && (
            <Button
              disabled={busy}
              type="button"
              variant="secondary"
              onClick={() => void onControl('pause')}
            >
              {copy.pause}
            </Button>
          )}
          {mission.status === 'PAUSED' && (
            <Button disabled={busy} type="button" onClick={() => void onControl('resume')}>
              {copy.resume}
            </Button>
          )}
          {!TERMINAL.has(mission.status) && (
            <Button
              disabled={busy}
              type="button"
              variant="danger"
              onClick={() => void onControl('cancel')}
            >
              {copy.cancel}
            </Button>
          )}
          {['FAILED', 'PARTIAL_SUCCESS', 'CANCELLED'].includes(mission.status) && (
            <Button disabled={busy} type="button" onClick={() => void onControl('retry')}>
              {copy.retry}
            </Button>
          )}
          {TERMINAL.has(mission.status) && !mission.archivedAt && (
            <Button
              disabled={busy}
              type="button"
              variant="ghost"
              onClick={() => void onControl('archive')}
            >
              {copy.archive}
            </Button>
          )}
        </div>
      </Surface>
      <Surface>
        <h2>{copy.plan}</h2>
        {mission.plan ? (
          <>
            <p>{mission.plan.summary}</p>
            <ul>
              {mission.plan.assumptions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>{copy.planUnavailable}</p>
        )}
        <h3>{copy.userRequest}</h3>
        <p>{mission.userRequest}</p>
      </Surface>
      <Surface>
        <div className="panel-heading">
          <h2>{copy.executionHistory}</h2>
          <StatusBadge tone="neutral">
            {detail.executions.length.toString()} {copy.attempts}
          </StatusBadge>
        </div>
        <div className="mission-record-list">
          {detail.executions.map((execution) => (
            <article key={execution.executionId}>
              <strong>
                #{execution.attempt.toString()} · {execution.status}
              </strong>
              <span>
                {formatDate(execution.startedAt, language)}
                {execution.endedAt ? ` — ${formatDate(execution.endedAt, language)}` : ''}
              </span>
              {execution.priorExecutionId && <small>↳ {execution.priorExecutionId}</small>}
            </article>
          ))}
        </div>
      </Surface>
      <RecordSection
        title={copy.steps}
        empty={copy.noRecords}
        items={detail.steps.map((step) => ({
          id: step.stepId,
          title: `${(step.position + 1).toString()}. ${step.title}`,
          meta: `${step.status}${step.required ? ' · required' : ''}`,
          ...(step.sanitizedError ? { detail: step.sanitizedError } : {}),
        }))}
      />
      <RecordSection
        title={copy.permissions}
        empty={copy.noRecords}
        items={detail.permissions.map((item) => ({
          id: item.permissionId,
          title: item.name,
          meta: item.status,
        }))}
      />
      <RecordSection
        title={copy.artifacts}
        empty={copy.noRecords}
        items={detail.artifacts.map((item) => ({
          id: item.missionArtifactId,
          title: item.name,
          meta: `${item.kind} · ${item.status}`,
        }))}
      />
      <RecordSection
        title={copy.verification}
        empty={copy.noRecords}
        items={detail.verificationResults.map((item) => ({
          id: item.verificationId,
          title: item.name,
          meta: item.passed ? 'PASS' : 'FAIL',
          detail: item.summary,
        }))}
      />
      <RecordSection
        title={copy.errors}
        empty={copy.noRecords}
        items={detail.errors.map((item) => ({
          id: item.missionErrorId,
          title: item.code,
          meta: item.recoverable ? 'Recoverable' : 'Not recoverable',
          detail: item.message,
        }))}
      />
      <Surface>
        <h2>{copy.timeline}</h2>
        {detail.timeline.length === 0 ? (
          <p>{copy.noRecords}</p>
        ) : (
          <ol className="mission-timeline">
            {[...detail.timeline].reverse().map((item) => (
              <li data-tone={item.tone} key={item.timelineId}>
                <time dateTime={item.occurredAt}>{formatDate(item.occurredAt, language)}</time>
                <strong>{item.title}</strong>
                {item.detail && <span>{item.detail}</span>}
              </li>
            ))}
          </ol>
        )}
      </Surface>
    </div>
  );
}

function RecordSection({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: { id: string; title: string; meta: string; detail?: string }[];
}): React.JSX.Element {
  return (
    <Surface>
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <div className="mission-record-list">
          {items.map((item) => (
            <article key={item.id}>
              <strong>{item.title}</strong>
              <span>{item.meta}</span>
              {item.detail && <p>{item.detail}</p>}
            </article>
          ))}
        </div>
      )}
    </Surface>
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

function context(missionId?: string) {
  return {
    requestId: crypto.randomUUID(),
    actor: 'renderer' as const,
    timestamp: new Date().toISOString(),
    ...(missionId ? { missionId } : {}),
  };
}

function statusTone(status: MissionStatus): 'success' | 'warning' | 'error' | 'neutral' {
  if (status === 'COMPLETED') return 'success';
  if (['FAILED', 'CANCELLED'].includes(status)) return 'error';
  if (['PARTIAL_SUCCESS', 'WAITING_APPROVAL', 'WAITING_IDENTITY', 'PAUSED'].includes(status))
    return 'warning';
  return 'neutral';
}

function formatDate(value: string, language: Language): string {
  return new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function elapsed(start?: string, end?: string, language: Language = 'en'): string {
  if (!start) return language === 'th' ? 'ยังไม่มีข้อมูล' : 'Unavailable';
  const seconds = Math.max(
    0,
    Math.floor((new Date(end ?? Date.now()).getTime() - new Date(start).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds.toString()}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes.toString()}m ${String(seconds % 60)}s`;
  return `${Math.floor(minutes / 60).toString()}h ${String(minutes % 60)}m`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Jupiter could not complete the Mission request.';
}
