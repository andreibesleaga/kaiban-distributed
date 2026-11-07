// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Called with the optional reason when the operator confirms. */
  onConfirm: (reason?: string) => void;
  onClose: () => void;
}

const MAX_REASON_LEN = 500;

/**
 * Confirmation for the emergency STOP ALL (ADR-025). Native <dialog>: focus is
 * trapped by the browser, Escape cancels.
 */
export default function StopAllDialog({ onConfirm, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  function confirm() {
    const trimmed = reason.trim();
    onConfirm(trimmed ? trimmed : undefined);
    dialogRef.current?.close();
  }

  return (
    <dialog
      ref={dialogRef}
      className="m-auto rounded-xl border border-red-700 bg-slate-900 text-slate-200 p-0 max-w-lg w-full shadow-2xl backdrop:bg-black/70"
      aria-labelledby="stop-all-title"
      aria-describedby="stop-all-desc"
    >
      <div className="px-6 py-5 flex flex-col gap-4">
        <h2 id="stop-all-title" className="text-lg font-semibold text-red-300">
          Stop everything now?
        </h2>
        <p id="stop-all-desc" className="text-sm text-slate-300 leading-relaxed">
          This kills every running model call, task and workflow, including tasks still waiting in a
          queue. Nothing is resumed. Work started after the stop runs normally.
        </p>
        <label className="flex flex-col gap-1 text-sm text-slate-300">
          Reason (optional)
          <input
            type="text"
            value={reason}
            maxLength={MAX_REASON_LEN}
            onChange={(e) => setReason(e.target.value)}
            className="rounded-md border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100"
          />
        </label>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-semibold"
          >
            Stop all
          </button>
        </div>
      </div>
    </dialog>
  );
}
