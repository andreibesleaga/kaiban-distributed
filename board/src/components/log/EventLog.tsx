import { useBoardStore } from '../../store/boardStore';
import type { LogEntry } from '../../types/board';
import clsx from 'clsx';

const TYPE_COLOR: Record<string, string> = {
  WORKFLOW:   'text-purple-400',
  AGENT:      'text-cyan-400',
  TASK:       'text-emerald-400',
  LLM:        'text-violet-400',
  HITL:       'text-amber-400',
  CONNECT:    'text-emerald-300',
  DISCONNECT: 'text-red-400',
  STATUS:     'text-slate-400',
};

function LogRow({ entry }: { entry: LogEntry }) {
  const typeColor = TYPE_COLOR[entry.type] ?? 'text-slate-500';
  return (
    <div className={clsx('flex gap-2 text-xs py-1 border-b border-slate-800/50 last:border-0', entry.highlight ? 'bg-slate-800/30' : '')}>
      <span className="text-slate-600 shrink-0 tabular-nums">{entry.time}</span>
      <span className={clsx('shrink-0 font-semibold w-[72px]', typeColor)}>{entry.type}</span>
      <span className="text-slate-300 break-all">{entry.message}</span>
    </div>
  );
}

export default function EventLog() {
  const log = useBoardStore((s) => s.log);

  return (
    <div className="rounded-xl border border-slate-800 bg-[#1e293b] p-4 flex flex-col min-h-[200px]">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Event Log
        </h2>
        <span className="text-xs text-slate-600 tabular-nums">{log.length} events</span>
      </div>

      <div className="flex-1 overflow-y-auto max-h-[360px]">
        {log.length === 0 ? (
          <p className="text-xs text-slate-700 italic text-center py-6">No events yet…</p>
        ) : (
          log.map((entry) => <LogRow key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  );
}
