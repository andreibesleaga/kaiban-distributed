import { useBoardStore } from '../../store/boardStore';
import { getGatewayUrl } from '../../socket/socketClient';
import ConnectionBadge from './ConnectionBadge';
import clsx from 'clsx';

const STATUS_PILL: Record<string, string> = {
  INITIAL:  'bg-slate-700 text-slate-300',
  RUNNING:  'bg-cyan-900 text-cyan-300',
  FINISHED: 'bg-emerald-900 text-emerald-300',
  STOPPED:  'bg-amber-900 text-amber-300',
  ERRORED:  'bg-red-900 text-red-300',
  BLOCKED:  'bg-red-900 text-red-300',
};

export default function Header() {
  const workflowStatus = useBoardStore((s) => s.workflowStatus);
  const topic = useBoardStore((s) => s.topic);
  const pillClass = STATUS_PILL[workflowStatus] ?? 'bg-slate-700 text-slate-300';

  return (
    <header className="sticky top-0 z-10 border-b border-slate-800 bg-[#0f172a]/95 backdrop-blur-sm">
      <div className="max-w-[1600px] mx-auto px-4 h-14 flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xl">⬡</span>
          <span className="font-bold text-slate-100 tracking-tight">Kaiban</span>
          <span className="font-light text-slate-400 tracking-tight">Distributed</span>
        </div>

        {/* Topic (centre, truncated) */}
        {topic && (
          <div className="flex-1 min-w-0 text-center">
            <span className="text-sm text-slate-400 truncate block px-4">
              {topic}
            </span>
          </div>
        )}
        {!topic && <div className="flex-1" />}

        {/* Right: gateway chip + status pill + connection badge */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden sm:block text-xs text-slate-600 font-mono truncate max-w-[200px]">
            {getGatewayUrl()}
          </span>

          <span className={clsx('px-2 py-0.5 rounded text-xs font-semibold tracking-wider', pillClass)}>
            {workflowStatus}
          </span>

          <ConnectionBadge />
        </div>
      </div>
    </header>
  );
}
