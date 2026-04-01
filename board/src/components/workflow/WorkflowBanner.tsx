import { useBoardStore } from '../../store/boardStore';
import { sendHitlDecision } from '../../socket/socketClient';
import clsx from 'clsx';

function HitlButtons({ taskId }: { taskId: string }) {
  const send = (decision: 'PUBLISH' | 'REVISE' | 'REJECT') => {
    sendHitlDecision(taskId, decision);
  };

  return (
    <div className="flex items-center gap-3 mt-3 sm:mt-0">
      <button
        onClick={() => send('PUBLISH')}
        className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors"
      >
        Approve
      </button>
      <button
        onClick={() => send('REVISE')}
        className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold transition-colors"
      >
        Revise
      </button>
      <button
        onClick={() => send('REJECT')}
        className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
      >
        Reject
      </button>
    </div>
  );
}

const BANNER_CONFIG: Record<
  string,
  { bg: string; border: string; icon: string; text: string; label: string } | null
> = {
  INITIAL:  null,
  RUNNING:  null,
  FINISHED: { bg: 'bg-emerald-950', border: 'border-emerald-700', icon: '✅', text: 'text-emerald-200', label: 'Workflow finished' },
  STOPPED:  { bg: 'bg-amber-950',   border: 'border-amber-700',   icon: '⏹', text: 'text-amber-200',   label: 'Workflow stopped'  },
  ERRORED:  { bg: 'bg-red-950',     border: 'border-red-700',     icon: '🔴', text: 'text-red-200',    label: 'Workflow errored'  },
  BLOCKED:  { bg: 'bg-red-950',     border: 'border-red-700',     icon: '🔴', text: 'text-red-200',    label: 'Workflow blocked'  },
};

export default function WorkflowBanner() {
  const workflowStatus = useBoardStore((s) => s.workflowStatus);
  const tasks = useBoardStore((s) => s.tasks);
  const metadata = useBoardStore((s) => s.metadata);

  // HITL banner: only when workflow is actively running — never override terminal states.
  // (Stale AWAITING_VALIDATION tasks can remain in the store after FINISHED/STOPPED.)
  const isTerminal = workflowStatus === 'FINISHED' || workflowStatus === 'STOPPED'
    || workflowStatus === 'ERRORED' || workflowStatus === 'BLOCKED';
  const hitlTasks = !isTerminal
    ? Array.from(tasks.values()).filter((t) => t.status === 'AWAITING_VALIDATION')
    : [];
  if (hitlTasks.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        {hitlTasks.map((task) => (
          <div key={task.taskId} className="rounded-xl border border-cyan-700 bg-cyan-950 px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-cyan-200 font-semibold">
                <span>⏸</span>
                <span>Human-in-the-Loop Review Required</span>
              </div>
              <p className="text-cyan-400 text-sm mt-1 break-words" title={task.title || task.taskId}>
                Task: {task.title || task.taskId}
              </p>
            </div>
            <HitlButtons taskId={task.taskId} />
          </div>
        ))}
      </div>
    );
  }

  // Workflow-level terminal state banners (no HITL)
  const cfg = BANNER_CONFIG[workflowStatus] ?? null;
  if (!cfg) return null;

  // FINISHED banner: include final token/cost/duration summary
  if (workflowStatus === 'FINISHED' && metadata) {
    const { totalTokens, estimatedCost, startTime, endTime } = metadata;
    const durSec = startTime && endTime ? ((endTime - startTime) / 1000).toFixed(1) : null;
    return (
      <div className={clsx('rounded-xl border px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2', cfg.bg, cfg.border)}>
        <div className="flex items-center gap-3">
          <span className="text-lg">{cfg.icon}</span>
          <span className={clsx('font-semibold', cfg.text)}>{cfg.label}</span>
        </div>
        {totalTokens != null && (
          <div className="flex gap-4 text-sm text-emerald-300 tabular-nums">
            <span>{totalTokens.toLocaleString()} tokens</span>
            <span>${(estimatedCost ?? 0).toFixed(4)}</span>
            {durSec && <span>{durSec}s</span>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={clsx('rounded-xl border px-5 py-3 flex items-center gap-3', cfg.bg, cfg.border)}>
      <span className="text-lg">{cfg.icon}</span>
      <span className={clsx('font-semibold', cfg.text)}>{cfg.label}</span>
    </div>
  );
}
