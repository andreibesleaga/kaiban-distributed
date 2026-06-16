import type { AgentDelta } from '../../types/board';
import type { TaskDelta } from '../../types/board';
import clsx from 'clsx';

interface Props {
  agent: AgentDelta;
  currentTask?: TaskDelta;
}

const STATUS_CONFIG = {
  IDLE: {
    badge: 'bg-slate-700 text-slate-400',
    border: 'border-slate-700',
    dot: 'bg-slate-500',
    pulse: false,
    label: 'Idle',
  },
  THINKING: {
    badge: 'bg-blue-900 text-blue-300',
    border: 'border-blue-800',
    dot: 'bg-blue-400',
    pulse: true,
    label: 'Thinking',
  },
  EXECUTING: {
    badge: 'bg-cyan-900 text-cyan-300',
    border: 'border-cyan-700',
    dot: 'bg-cyan-400',
    pulse: true,
    label: 'Executing',
  },
  ERROR: {
    badge: 'bg-red-900 text-red-300',
    border: 'border-red-700',
    dot: 'bg-red-500',
    pulse: false,
    label: 'Error',
  },
} as const;

export default function AgentCard({ agent, currentTask }: Props) {
  const cfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.IDLE;

  return (
    <div className={clsx('rounded-xl border bg-[#1e293b] p-4 flex flex-col gap-3 transition-colors', cfg.border)}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-slate-100 truncate">{agent.name || agent.agentId}</p>
          <p className="text-xs text-slate-500 truncate mt-0.5">{agent.role}</p>
        </div>

        {/* Status badge with dot */}
        <div className={clsx('flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold shrink-0', cfg.badge)}>
          <span className="relative flex h-1.5 w-1.5">
            {cfg.pulse && (
              <span className={clsx('animate-ping absolute inline-flex h-full w-full rounded-full opacity-75', cfg.dot)} />
            )}
            <span className={clsx('relative inline-flex rounded-full h-1.5 w-1.5', cfg.dot)} />
          </span>
          {cfg.label}
        </div>
      </div>

      {/* Current task chip */}
      {currentTask ? (
        <div className="rounded-lg bg-slate-800 px-3 py-2">
          <p className="text-xs text-slate-500 mb-0.5">Current task</p>
          <p className="text-xs text-slate-300 truncate">{currentTask.title || currentTask.taskId}</p>
        </div>
      ) : (
        <div className="rounded-lg bg-slate-800/50 px-3 py-2">
          <p className="text-xs text-slate-600 italic">No active task</p>
        </div>
      )}
    </div>
  );
}
