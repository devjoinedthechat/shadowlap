import type { ReactNode } from 'react';
import { ActionButton } from './ActionButton.js';

/**
 * On and off is one switch, drawn in ink, never a two-option picker (Format JSON, Push from CI,
 * Pull request comment, Fix on failure, Alerts, Single-key shortcuts): a button with the switch role
 * that keeps the focus when it toggles, taking taps over 44 by 24px while its track stays 28 by 16.
 * Its words beside it name it (`children`), or a label when it sits in a row that names it
 * (`label`, or the row's own ids: `labelledBy`, `describedBy`). The page says what changed in a
 * toast, as each setting's write does.
 */
export function Switch({
  on,
  onChange,
  children,
  label,
  labelledBy,
  describedBy,
  disabled,
  title,
  action = false,
  why,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Its words, beside the track: "Format JSON". */
  children?: ReactNode;
  /** Its name where no words sit beside it. */
  label?: string | undefined;
  labelledBy?: string | undefined;
  describedBy?: string | undefined;
  disabled?: boolean | undefined;
  /** Why it can't be changed here, on hover, when `disabled`. */
  title?: string | undefined;
  /** A setting the server writes: it waits as `ActionButton` does, its reason `why` or the app's. */
  action?: boolean | undefined;
  why?: string | null | undefined;
}) {
  if (action) {
    return (
      <ActionButton className="switch" role="switch" aria-checked={on} aria-label={children ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy} disabled={disabled} why={why} title={title} onClick={() => onChange(!on)}>
        <i aria-hidden="true" />
        {children}
      </ActionButton>
    );
  }
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={on}
      aria-label={children ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!on)}
    >
      <i aria-hidden="true" />
      {children}
    </button>
  );
}
