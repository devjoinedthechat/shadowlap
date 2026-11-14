import { useState } from 'react';
import { REASON_MAX } from '../../../engine/src/accepted.js';
import { Copy } from './Copy.js';
import { pressWayOn } from './Dialog.js';

/**
 * Why a golden is updated, as Update golden's dialogs ask it: one optional line, which the update
 * keeps beside the golden (`test --update --reason`, its accepted.jsonl), so a later change that
 * takes this one out is told why it is there. The command the dialog shows follows what is typed.
 * It is optional, so the dialog still opens on its way on (`startFocus`), never on the field.
 */

export interface UpdateReason {
  /** What the field holds. */
  typed: string;
  /** What goes to the job: what was typed, on one line, trimmed. */
  reason: string;
  set: (value: string) => void;
}

export function useUpdateReason(): UpdateReason {
  const [typed, set] = useState('');
  return { typed, reason: typed.replace(/\s+/g, ' ').trim(), set };
}

/** The field, under what the update does. `enter`: Enter in it presses the dialog's way on, where it has one way on alone. */
export function ReasonField({ reason, enter = true }: { reason: UpdateReason; enter?: boolean }) {
  return (
    <>
      <div className="form one updwhy">
        <label>
          <span>Why, optional</span>
          <input
            type="text"
            value={reason.typed}
            maxLength={REASON_MAX}
            autoComplete="off"
            onChange={(e) => reason.set(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && enter) {
                e.preventDefault();
                pressWayOn(e.currentTarget);
              }
            }}
          />
        </label>
      </div>
      <Copy className="dlgnote">Kept beside the golden. A later change that takes this one out is told why it is there.</Copy>
    </>
  );
}
