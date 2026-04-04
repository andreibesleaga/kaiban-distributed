import { useEffect, useRef } from 'react';
import type { TaskDelta, AgentDelta } from '../../types/board';
import clsx from 'clsx';

interface Props {
  task: TaskDelta;
  agent?: AgentDelta;
  onClose: () => void;
}

const STATUS_BADGE: Record<string, string> = {
  TODO:                 'bg-slate-700 text-slate-400',
  DOING:                'bg-cyan-900 text-cyan-300',
  DONE:                 'bg-emerald-900 text-emerald-300',
  BLOCKED:              'bg-red-900 text-red-300',
  AWAITING_VALIDATION:  'bg-amber-900 text-amber-300',
};

const AGENT_STATUS_ICON: Record<string, string> = {
  IDLE:      '⚪',
  THINKING:  '🔵',
  EXECUTING: '🟢',
  ERROR:     '🔴',
};

/** Full-detail modal for a single task. Uses the native <dialog> element for a11y. */
export default function TaskDetailModal({ task, agent, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Open the dialog when mounted; focus is managed automatically by the browser.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  // Close on backdrop click (clicks outside the inner panel).
  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) {
      dialogRef.current?.close();
    }
  }

  const badgeClass = STATUS_BADGE[task.status] ?? 'bg-slate-700 text-slate-400';

  return (
    <dialog
      ref={dialogRef}
      className="rounded-xl border border-slate-700 bg-slate-900 text-slate-200 p-0
                 max-w-2xl w-full shadow-2xl backdrop:bg-black/60"
      onClick={handleBackdropClick}
      aria-labelledby="task-modal-title"
      aria-describedby="task-modal-desc"
    >
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-700">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-xs font-mono text-slate-500 break-all" id="task-modal-desc">
            {task.taskId}
          </span>
          <h2 id="task-modal-title" className="text-base font-semibold leading-snug break-words">
            {task.title || task.taskId}
          </h2>
        </div>
        <button
          onClick={() => dialogRef.current?.close()}
          className="shrink-0 text-slate-400 hover:text-slate-100 transition-colors text-xl leading-none"
          aria-label="Close task detail"
        >
          ✕
        </button>
      </div>

      {/* ── Body ── */}
      <div className="px-6 py-4 flex flex-col gap-4 overflow-y-auto max-h-[70vh]">
        {/* Status + Agent row */}
        <div className="flex flex-wrap items-center gap-3">
          <span className={clsx('text-xs font-semibold px-2.5 py-1 rounded', badgeClass)}>
            {task.status}
          </span>
          {agent && (
            <span className="text-xs text-slate-400">
              {AGENT_STATUS_ICON[agent.status] ?? '⬡'}{' '}
              <span className="font-medium text-slate-300">{agent.name || agent.agentId}</span>
              {agent.role && (
                <span className="text-slate-500"> — {agent.role}</span>
              )}
            </span>
          )}
        </div>

        {/* Cost / tokens */}
        {(task.tokens != null || task.cost != null) && (
          <section aria-label="Token and cost summary">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">
              Cost
            </h3>
            <div className="flex gap-6 text-sm tabular-nums">
              {task.tokens != null && (
                <div>
                  <span className="text-slate-400">Tokens </span>
                  <span className="text-slate-200 font-medium">{task.tokens.toLocaleString()}</span>
                </div>
              )}
              {task.cost != null && (
                <div>
                  <span className="text-slate-400">Cost </span>
                  <span className="text-slate-200 font-medium">${task.cost.toFixed(6)}</span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Result */}
        {task.result && (
          <section aria-label="Task result">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">
              Result
            </h3>
            <pre className="whitespace-pre-wrap break-words text-sm text-slate-300
                            bg-slate-800 rounded-lg p-3 leading-relaxed max-h-80 overflow-y-auto
                            border border-slate-700">
              {task.result}
            </pre>
          </section>
        )}

        {/* Empty state */}
        {!task.result && (
          <p className="text-sm text-slate-600 italic">No result yet.</p>
        )}
      </div>
    </dialog>
  );
}
