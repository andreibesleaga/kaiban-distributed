// SPDX-License-Identifier: GPL-3.0-only
import { useState } from 'react';
import { useBoardStore } from '../../store/boardStore';
import { sendStopAll } from '../../socket/socketClient';
import StopAllDialog from './StopAllDialog';

/**
 * The emergency STOP ALL button (ADR-025). Shown only when the gateway reports
 * the control plane on; opens a confirmation first.
 */
export default function StopAllButton() {
  const controlPlane = useBoardStore((s) => s.controlPlane);
  const [confirming, setConfirming] = useState(false);
  if (!controlPlane?.enabled) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-haspopup="dialog"
        className="px-3 py-1 rounded-md bg-red-700 hover:bg-red-600 text-white text-xs font-bold tracking-wider"
      >
        STOP ALL
      </button>
      {confirming && (
        <StopAllDialog onConfirm={(reason) => sendStopAll(reason)} onClose={() => setConfirming(false)} />
      )}
    </>
  );
}
