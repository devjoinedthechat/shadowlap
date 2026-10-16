import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { choiceAnswer } from '../actions.js';
import { dialogFocus } from '../focus.js';
import { dialogOnSwitch, noteDialogDropped, onShownProject, shownProject } from '../projects-api.js';
import { useLayer } from '../state.js';
import type { PromptChoice } from '../types.js';
import { CmdLine } from './bits.js';

/**
 * A dialog over a dimmed page: a title, a line that says what will happen, a body, and Cancel beside
 * the action. Esc or a click on the dimmed page cancels. The first field, or the action, gets focus,
 * and focus goes back where it was when it closes. A red action that can't be undone (`danger`) with
 * no field starts on Cancel, so a second Enter doesn't delete what the first one only asked about,
 * and so does a dialog given `initialFocus="cancel"` (`dialogFocus` in focus.ts). A body taller than
 * the window scrolls, so the title and the buttons stay in view.
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
  /** `cancel` focuses Cancel when the dialog opens, for a confirm that can't be undone: Enter twice never deletes anything. */
  initialFocus?: 'cancel';
  /**
   * A dialog belongs to the project the page showed when it opened: when the dashboard switches to
   * another project elsewhere (another tab), it closes, since its action would land in that one.
   * `keepOnSwitch` keeps one that holds only what was typed into it (a rule, a server's command),
   * which then acts on the project the page shows (`dialogOnSwitch`).
   */
  keepOnSwitch?: boolean;
}

export function Dialog({ title, text, children, ok, tone = 'lime', okDisabled = false, onOk, onClose, cancel = 'Cancel', className = '', initialFocus, keepOnSwitch = false }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayer('dialog', true, onClose);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(dialogFocus(tone, initialFocus));
    first?.focus();
    if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) first.select();
    return () => prev?.focus?.();
  }, []);
  // Asked in one project, never answered in another: the page turning to another project closes it.
  const openedIn = useRef(shownProject());
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(
    () =>
      onShownProject((now) => {
        const what = dialogOnSwitch({ openedIn: openedIn.current, shown: now, keeps: keepOnSwitch });
        if (what === 'adopt') openedIn.current = now;
        if (what !== 'close') return;
        noteDialogDropped();
        close.current();
      }),
    [keepOnSwitch],
  );
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <header>
          <h3 id={id}>{title}</h3>
          {text ? <p>{text}</p> : null}
        </header>
        {children ? <div className="db">{children}</div> : null}
        <footer>
          <button type="button" className="btn dlg-cancel" onClick={onClose}>
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

const OTHER = '\u0000other';

/**
 * A dialog that asks one thing before an action runs: a line of text, a longer one, or one of a few
 * answers (`choices`, a select like the mock's, with "Something else…" for an answer of your own).
 * A choice with a field of its own (`text`, such as "error, with a message") shows that field and
 * sends the choice's value followed by what was typed.
 */
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
  choices,
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
  /** The command it will run, shown under the field: as it is, or worked out from the answer so far. */
  command?: string | ((answer: string) => string);
  maxLength?: number;
  /** Answers to pick from; any other answer is accepted too. */
  choices?: readonly PromptChoice[];
  onRun: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const listed = !!choices?.length;
  const [own, setOwn] = useState(listed && !choices!.some((c) => c.value === initial));
  // The few words a picked choice asks for: the message of "error, with a message".
  const [words, setWords] = useState('');
  const picked = listed && !own ? choices!.find((c) => c.value === value) : undefined;
  const answer = picked ? choiceAnswer(picked, words) : value.trim();
  const ready = answer.length > 0;
  const submit = () => ready && onRun(answer);
  const field = multiline ? (
    <textarea
      value={value}
      placeholder={placeholder}
      autoFocus={listed}
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
      autoFocus={listed}
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
  const select = listed ? (
    <select
      value={own ? OTHER : value}
      onChange={(e) => {
        if (e.target.value === OTHER) {
          setOwn(true);
          setValue('');
        } else {
          setOwn(false);
          setValue(e.target.value);
        }
      }}
    >
      {choices!.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
      <option value={OTHER}>Something else…</option>
    </select>
  ) : null;
  return (
    <Dialog title={title} text={text} ok={ok} okDisabled={!ready} onOk={submit} onClose={onClose}>
      {label || select ? (
        <div className="form one">
          <label>
            {label}
            {select ?? field}
          </label>
          {select && own ? <label>{field}</label> : null}
          {select && picked?.text ? (
            <label>
              {picked.text}
              <input
                type="text"
                value={words}
                spellCheck={false}
                autoFocus
                onChange={(e) => setWords(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            </label>
          ) : null}
        </div>
      ) : (
        field
      )}
      {command ? <CmdLine>{typeof command === 'function' ? command(answer) : command}</CmdLine> : null}
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
