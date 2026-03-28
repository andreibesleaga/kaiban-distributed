import { useBoardStore } from '../../store/boardStore';
import KanbanColumn from './KanbanColumn';
import type { TaskDelta, TaskStatus } from '../../types/board';

const COLUMNS: Array<{
  status: TaskStatus;
  title: string;
  accent: string;
  emptyText: string;
}> = [
  {
    status: 'TODO',
    title: 'To Do',
    accent: 'border-slate-700 bg-slate-800/50 text-slate-400',
    emptyText: 'No pending tasks',
  },
  {
    status: 'DOING',
    title: 'In Progress',
    accent: 'border-cyan-800 bg-cyan-900/30 text-cyan-300',
    emptyText: 'Nothing in progress',
  },
  {
    status: 'AWAITING_VALIDATION',
    title: 'Review',
    accent: 'border-amber-800 bg-amber-900/30 text-amber-300',
    emptyText: 'No items in review',
  },
  {
    status: 'DONE',
    title: 'Done',
    accent: 'border-emerald-800 bg-emerald-900/30 text-emerald-300',
    emptyText: 'Nothing completed yet',
  },
  {
    status: 'BLOCKED',
    title: 'Blocked',
    accent: 'border-red-800 bg-red-900/30 text-red-300',
    emptyText: 'No blocked tasks',
  },
];

export default function KanbanBoard() {
  const tasks = useBoardStore((s) => s.tasks);
  const agents = useBoardStore((s) => s.agents);

  const tasksByStatus = new Map<TaskStatus, TaskDelta[]>();
  for (const col of COLUMNS) {
    tasksByStatus.set(col.status, []);
  }
  for (const task of tasks.values()) {
    const col = tasksByStatus.get(task.status as TaskStatus);
    if (col) col.push(task);
  }

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
        Tasks ({tasks.size})
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {COLUMNS.map((col) => (
          <div key={col.status} className="min-w-[220px] flex-1">
            <KanbanColumn
              title={col.title}
              tasks={tasksByStatus.get(col.status) ?? []}
              agents={agents}
              accent={col.accent}
              emptyText={col.emptyText}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
