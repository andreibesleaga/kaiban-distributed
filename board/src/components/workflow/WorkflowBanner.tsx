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

  // HITL banner: any task AWAITING_VALIDATION triggers Approve/Revise/Reject buttons
  const hitlTask = Array.from(tasks.values()).find((t) => t.status === 'AWAITING_VALIDATION');
  if (hitlTask) {
    return (
      <div className="rounded-xl border border-cyan-700 bg-cyan-950 px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-cyan-200 font-semibold">
            <span>⏸</span>
            <span>Human-in-the-Loop Review Required</span>
          </div>
          <p className="text-cyan-400 text-sm mt-1 break-words" title={hitlTask.title || hitlTask.taskId}>
            Task: {hitlTask.title || hitlTask.taskId}
          </p>
        </div>
        <HitlButtons taskId={hitlTask.taskId} />
      </div>
    );
  }

  // Workflow-level terminal state banners (no HITL)
  const cfg = BANNER_CONFIG[workflowStatus] ?? null;
  if (!cfg) return null;

  return (
    <div className={clsx('rounded-xl border px-5 py-3 flex items-center gap-3', cfg.bg, cfg.border)}>
      <span className="text-lg">{cfg.icon}</span>
      <span className={clsx('font-semibold', cfg.text)}>{cfg.label}</span>
    </div>
  );
}
