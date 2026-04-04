import type { TaskDelta, AgentDelta } from '../../types/board';
import clsx from 'clsx';

interface Props {
  task: TaskDelta;
  agent?: AgentDelta;
  onClick?: () => void;
}

const STATUS_BADGE: Record<string, string> = {
  TODO:                 'bg-slate-700 text-slate-400',
  DOING:                'bg-cyan-900 text-cyan-300',
  DONE:                 'bg-emerald-900 text-emerald-300',
  BLOCKED:              'bg-red-900 text-red-300',
  AWAITING_VALIDATION:  'bg-amber-900 text-amber-300',
};

export default function TaskCard({ task, agent, onClick }: Props) {
  const badgeClass = STATUS_BADGE[task.status] ?? 'bg-slate-700 text-slate-400';
  const fullTitle = task.title || task.taskId;

  return (
    <div
      className={clsx(
        'group rounded-lg border border-slate-700 bg-slate-800 p-3 flex flex-col gap-2 hover:border-slate-500 transition-colors',
        onClick && 'cursor-pointer',
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={`View details for task: ${fullTitle}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          onClick?.();
        } else if (e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      {/* Title — expands on hover to show full text */}
      <p
        className="text-sm text-slate-200 font-medium leading-snug line-clamp-2 group-hover:line-clamp-none break-words"
        title={fullTitle}
      >
        {fullTitle}
      </p>

      {/* Agent chip */}
      {agent && (
        <p className="text-xs text-slate-500 truncate" title={agent.name || agent.agentId}>
          ⬡ {agent.name || agent.agentId}
        </p>
      )}

      {/* Result — hidden initially, expands fully on card hover */}
      {task.result && (
        <p
          className="text-xs text-slate-400 line-clamp-2 group-hover:line-clamp-none bg-slate-900/60 rounded px-2 py-1 break-words"
          title={task.result}
        >
          {task.result}
        </p>
      )}

      {/* Token/cost badge (shown when task is DONE and data is available) */}
      {task.tokens != null && (
        <p className="text-xs text-slate-500 tabular-nums">
          {task.tokens.toLocaleString()} tok · ${(task.cost ?? 0).toFixed(4)}
        </p>
      )}

      {/* Status badge */}
      <div className="flex justify-end">
        <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded', badgeClass)}>
          {task.status}
        </span>
      </div>
    </div>
  );
}
