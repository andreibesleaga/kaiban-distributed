import { useBoardStore } from '../../store/boardStore';
import type { ConnectionStatus } from '../../types/board';
import clsx from 'clsx';

const CONFIG: Record<ConnectionStatus, { label: string; dot: string; text: string; pulse: boolean }> = {
  connecting: { label: 'CONNECTING', dot: 'bg-amber-400',   text: 'text-amber-400',  pulse: true  },
  live:        { label: 'LIVE',       dot: 'bg-emerald-400', text: 'text-emerald-400', pulse: true  },
  disconnected:{ label: 'OFFLINE',    dot: 'bg-slate-500',   text: 'text-slate-400',  pulse: false },
  error:       { label: 'ERROR',      dot: 'bg-red-500',     text: 'text-red-400',    pulse: false },
};

export default function ConnectionBadge() {
  const status = useBoardStore((s) => s.connectionStatus);
  const cfg = CONFIG[status];

  return (
    <div className={clsx('flex items-center gap-1.5 text-xs font-semibold tracking-wider', cfg.text)}>
      <span className="relative flex h-2 w-2">
        {cfg.pulse && (
          <span className={clsx('animate-ping absolute inline-flex h-full w-full rounded-full opacity-75', cfg.dot)} />
        )}
        <span className={clsx('relative inline-flex rounded-full h-2 w-2', cfg.dot)} />
      </span>
      {cfg.label}
    </div>
  );
}
