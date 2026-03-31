import { useState, useEffect } from 'react';
import { useBoardStore } from '../../store/boardStore';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-sm font-mono text-slate-200">{value}</span>
    </div>
  );
}

function formatDuration(startMs: number, endMs?: number): string {
  const ms = (endMs ?? Date.now()) - startMs;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

export default function EconomicsPanel() {
  const metadata = useBoardStore((s) => s.metadata);
  const topic = useBoardStore((s) => s.topic);
  const workflowStatus = useBoardStore((s) => s.workflowStatus);

  const isRunning = workflowStatus === 'RUNNING';

  // Re-render every second while running so the duration field updates live.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, [isRunning]);

  return (
    <div className="rounded-xl border border-slate-800 bg-[#1e293b] p-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
        Run Metrics
      </h2>

      <div className="flex flex-col divide-y divide-slate-800">
        {topic && <Row label="Topic" value={topic.length > 40 ? topic.slice(0, 40) + '…' : topic} />}

        <Row
          label="Total tokens"
          value={metadata?.totalTokens != null ? metadata.totalTokens.toLocaleString() : '—'}
        />

        <Row
          label="Est. cost"
          value={metadata?.estimatedCost != null ? `$${metadata.estimatedCost.toFixed(4)}` : '—'}
        />

        <Row
          label="Started"
          value={metadata?.startTime != null ? formatTime(metadata.startTime) : '—'}
        />

        <Row
          label="Ended"
          value={metadata?.endTime != null ? formatTime(metadata.endTime) : (isRunning ? 'running…' : '—')}
        />

        <Row
          label="Duration"
          value={
            metadata?.startTime != null
              ? formatDuration(metadata.startTime, metadata.endTime)
              : '—'
          }
        />
      </div>
    </div>
  );
}
