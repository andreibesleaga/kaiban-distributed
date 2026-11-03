// SPDX-License-Identifier: GPL-3.0-only
import { useBoardStore } from '../../store/boardStore';

function timeOf(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** The latest emergency stop (ADR-025): when, who, why, how many nodes acknowledged. */
export default function EmergencyStopBanner() {
  const lastStop = useBoardStore((s) => s.controlPlane?.lastStop);
  const acks = useBoardStore((s) => s.controlPlane?.acks ?? 0);
  if (!lastStop) return null;

  return (
    <div
      role="status"
      className="rounded-xl border border-red-700 bg-red-950 px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
    >
      <div className="flex items-center gap-3 text-red-200">
        <span className="text-lg" aria-hidden="true">🛑</span>
        <span className="font-semibold">
          Emergency stop at {timeOf(lastStop.issuedAt)} by {lastStop.issuedBy}
        </span>
        {lastStop.reason && <span className="text-red-300 break-words">— {lastStop.reason}</span>}
      </div>
      <span className="text-sm text-red-300 tabular-nums">
        {acks} node acknowledgement{acks === 1 ? '' : 's'}
      </span>
    </div>
  );
}
