// SPDX-License-Identifier: GPL-3.0-only
import { useBoardStore } from '../../store/boardStore';

/**
 * Why the last STOP ALL did not go through (refused, not confirmed, not connected).
 * The element is always in the page so assistive technology announces the text when it appears;
 * the same message is also written to the event log.
 */
export default function ControlErrorAlert() {
  const message = useBoardStore((s) => s.controlError);
  return (
    <div
      role="alert"
      className={message ? 'border-t border-red-800 bg-red-950 px-4 py-2 text-sm font-semibold text-red-200' : undefined}
    >
      {message}
    </div>
  );
}
