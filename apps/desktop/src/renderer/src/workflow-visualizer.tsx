import type { Language, WorkflowDetail, WorkflowStepStatus } from '@jupiter/contracts';
import { Button, EmptyState, StatusBadge, Surface } from '@jupiter/ui';

const ACTIVE = new Set<WorkflowStepStatus>(['PENDING', 'RUNNING', 'WAITING']);

export function WorkflowVisualizer({
  language,
  workflow,
  busy,
  onControl,
}: {
  language: Language;
  workflow: WorkflowDetail | null;
  busy: boolean;
  onControl: (action: 'start' | 'resume' | 'cancel') => Promise<void>;
}): React.JSX.Element {
  const th = language === 'th';
  if (!workflow) {
    return (
      <Surface data-testid="workflow-unavailable">
        <EmptyState
          eyebrow="Not configured"
          title={th ? 'ยังไม่มี Workflow Plan' : 'No Workflow Plan'}
          description={
            th
              ? 'ยังไม่มีแผนที่ผ่านการตรวจสอบสำหรับภารกิจนี้ การเชื่อมต่อ Planner และ skill executor ยังไม่ได้กำหนดค่า'
              : 'No validated plan exists for this Mission. Planner and skill executors are not configured.'
          }
        />
      </Surface>
    );
  }

  const { plan, execution } = workflow;
  const latestAttempts = new Map<string, (typeof workflow.stepAttempts)[number]>();
  for (const attempt of workflow.stepAttempts) {
    const current = latestAttempts.get(attempt.stepId);
    if (!current || attempt.attempt > current.attempt) latestAttempts.set(attempt.stepId, attempt);
  }
  const pendingCheckpoints = workflow.checkpoints.filter((item) => item.status === 'PENDING');
  const canStart = !execution || ['FAILED', 'CANCELLED'].includes(execution.status);
  const canResume = execution?.status === 'WAITING' && execution.pauseRequested;
  const canCancel = execution ? ACTIVE.has(execution.status) : false;

  return (
    <Surface className="workflow-visualizer" data-testid="workflow-visualizer">
      <div className="panel-heading">
        <div>
          <span className="j-eyebrow">Workflow · revision {plan.revision.toString()}</span>
          <h2>{plan.goal}</h2>
        </div>
        <StatusBadge tone={workflowTone(execution?.status)}>
          {execution?.status ?? 'PENDING'}
        </StatusBadge>
      </div>
      <p>{plan.rationale}</p>
      {plan.priorPlanId && (
        <p className="workflow-revision">
          {th ? 'ปรับแผนต่อจาก' : 'Replanned from'} <code>{plan.priorPlanId}</code>
        </p>
      )}
      <div className="button-row">
        {canStart && (
          <Button disabled={busy} type="button" onClick={() => void onControl('start')}>
            {th ? 'เริ่ม Workflow' : 'Start Workflow'}
          </Button>
        )}
        {canResume && (
          <Button disabled={busy} type="button" onClick={() => void onControl('resume')}>
            {th ? 'ทำต่อ' : 'Resume'}
          </Button>
        )}
        {canCancel && (
          <Button
            disabled={busy}
            type="button"
            variant="danger"
            onClick={() => void onControl('cancel')}
          >
            {th ? 'ยกเลิก Workflow' : 'Cancel Workflow'}
          </Button>
        )}
      </div>
      {pendingCheckpoints.length > 0 && (
        <div className="workflow-checkpoint" role="status">
          <strong>{th ? 'กำลังรอ checkpoint' : 'Waiting at checkpoint'}</strong>
          <span>
            {pendingCheckpoints.map((item) => `${item.kind}: ${item.reason}`).join(' · ')}
          </span>
          <small>
            {th
              ? 'การอนุมัติหรือยืนยันตัวตนต้องดำเนินการผ่านช่องทาง Core ที่ได้รับสิทธิ์'
              : 'Approval or identity resolution requires an authorized Core channel.'}
          </small>
        </div>
      )}
      <ol className="workflow-graph" aria-label={th ? 'ขั้นตอน Workflow' : 'Workflow steps'}>
        {plan.steps.map((step, index) => {
          const attempt = latestAttempts.get(step.stepId);
          const status = attempt?.status ?? step.status;
          const dependencies = step.dependencies
            .map((id) => plan.steps.find((candidate) => candidate.stepId === id)?.title ?? id)
            .join(', ');
          return (
            <li data-status={status} key={step.stepId}>
              <div className="workflow-node-heading">
                <span className="workflow-node-index">{(index + 1).toString()}</span>
                <div>
                  <strong>{step.title}</strong>
                  <span>{step.skillId}</span>
                </div>
                <StatusBadge tone={workflowTone(status)}>{status}</StatusBadge>
              </div>
              <p>{step.description}</p>
              <dl>
                <div>
                  <dt>{th ? 'ขึ้นกับ' : 'Depends on'}</dt>
                  <dd>{dependencies || (th ? 'ไม่มี' : 'None')}</dd>
                </div>
                <div>
                  <dt>{th ? 'รอบที่ลอง' : 'Attempts'}</dt>
                  <dd>
                    {attempt
                      ? `${attempt.attempt.toString()} / ${step.retryPolicy.maxAttempts.toString()}`
                      : `0 / ${step.retryPolicy.maxAttempts.toString()}`}
                  </dd>
                </div>
                <div>
                  <dt>Timeout</dt>
                  <dd>{step.timeoutMs.toLocaleString()} ms</dd>
                </div>
              </dl>
              {attempt?.sanitizedError && <p className="inline-error">{attempt.sanitizedError}</p>}
            </li>
          );
        })}
      </ol>
      <div className="workflow-plan-meta">
        <div>
          <h3>{th ? 'สมมติฐาน' : 'Assumptions'}</h3>
          {plan.assumptions.length ? (
            <ul>
              {plan.assumptions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>{th ? 'ไม่มี' : 'None'}</p>
          )}
        </div>
        <div>
          <h3>{th ? 'แผนตรวจสอบ' : 'Verification plan'}</h3>
          <p>{plan.verificationPlan.summary}</p>
          <ul>
            {plan.verificationPlan.checks.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </Surface>
  );
}

function workflowTone(
  status: WorkflowStepStatus | undefined,
): 'success' | 'warning' | 'error' | 'neutral' {
  if (status === 'COMPLETED') return 'success';
  if (status === 'FAILED' || status === 'CANCELLED') return 'error';
  if (status === 'RUNNING' || status === 'WAITING') return 'warning';
  return 'neutral';
}
