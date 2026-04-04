import type { TaskDelta, AgentDelta } from '../../types/board';
import TaskCard from './TaskCard';
import clsx from 'clsx';

interface Props {
  title: string;
  tasks: TaskDelta[];
  agents: Map<string, AgentDelta>;
  accent: string;
  emptyText?: string;
  onTaskClick?: (taskId: string) => void;
}

export default function KanbanColumn({ title, tasks, agents, accent, emptyText, onTaskClick }: Props) {
  return (
    <div className="flex flex-col min-w-0 flex-1">
      {/* Column header */}
      <div className={clsx('flex items-center justify-between px-3 py-2 rounded-t-lg border-b mb-2', accent)}>
        <span className="text-xs font-semibold uppercase tracking-wider">{title}</span>
        <span className="text-xs font-bold tabular-nums opacity-80">{tasks.length}</span>
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-2 overflow-y-auto max-h-[60vh] pr-0.5">
        {tasks.length === 0 && emptyText && (
          <p className="text-xs text-slate-700 text-center py-4 italic">{emptyText}</p>
        )}
        {tasks.map((task) => (
          <TaskCard
            key={task.taskId}
            task={task}
            agent={task.assignedToAgentId ? agents.get(task.assignedToAgentId) : undefined}
            onClick={onTaskClick ? () => onTaskClick(task.taskId) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
