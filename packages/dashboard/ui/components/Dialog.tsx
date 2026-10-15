import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useLayer } from '../state.js';
import { CmdLine } from './bits.js';

/**
 * A dialog over a dimmed page: a title, a line that says what will happen, a body, and Cancel beside
 * the action. Esc or a click on the dimmed page cancels. The first field, or the action, gets focus,
 * and focus goes back where it was when it closes.
 */

export interface DialogProps {
  title: string;
  text?: ReactNode;
  children?: ReactNode;
  /** The action's words; omit for a dialog with Close only. */
  ok?: string;
  /** `danger` turns the action red; `solid` is the calm dark button. */
  tone?: 'lime' | 'danger' | 'solid';
  okDisabled?: boolean;
  onOk?: () => void;
  onClose: () => void;
  cancel?: string;
  className?: string;
}

export function Dialog({ title, text, children, ok, tone = 'lime', okDisabled = false, onOk, onClose, cancel = 'Cancel', className = '' }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayer('dialog', true, onClose);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('textarea, input:not([type="checkbox"]):not([type="hidden"]), select, .dlg-ok');
    first?.focus();
    if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) first.select();
    return () => prev?.focus?.();
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <header>
          <h3 id={id}>{title}</h3>
          {text ? <p>{text}</p> : null}
        </header>
        {children ? <div className="db">{children}</div> : null}
        <footer>
          <button type="button" className="btn" onClick={onClose}>
            {ok ? cancel : 'Close'}
          </button>
          {ok ? (
            <button type="button" className={`btn ${tone} dlg-ok`} disabled={okDisabled} onClick={() => onOk?.()}>
              {ok}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

/** A dialog that asks one thing before an action runs: a line of text, or a longer one. */
export function PromptDialog({
  title,
  text,
  label,
  initial = '',
  placeholder = '',
  multiline = false,
  ok,
  command,
  maxLength,
  onRun,
  onClose,
}: {
  title: string;
  text?: ReactNode;
  label?: string;
  initial?: string;
  placeholder?: string;
  multiline?: boolean;
  ok: string;
  /** The command it will run, shown under the field. */
  command?: string;
  maxLength?: number;
  onRun: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ready = value.trim().length > 0;
  const submit = () => ready && onRun(value.trim());
  const field = multiline ? (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    />
  ) : (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      {...(maxLength ? { maxLength } : {})}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      }}
    />
  );
  return (
    <Dialog title={title} text={text} ok={ok} okDisabled={!ready} onOk={submit} onClose={onClose}>
      {label ? (
        <div className="form one">
          <label>
            {label}
            {field}
          </label>
        </div>
      ) : (
        field
      )}
      {command ? <CmdLine>{command}</CmdLine> : null}
    </Dialog>
  );
}

/** A yes-or-no before something that cannot be undone, with the command it runs. */
export function ConfirmDialog({ title, text, ok, danger = false, command, onOk, onClose }: { title: string; text: ReactNode; ok: string; danger?: boolean; command?: string; onOk: () => void; onClose: () => void }) {
  return (
    <Dialog title={title} text={text} ok={ok} tone={danger ? 'danger' : 'lime'} onOk={onOk} onClose={onClose}>
      {command ? <CmdLine>{command}</CmdLine> : null}
    </Dialog>
  );
}
