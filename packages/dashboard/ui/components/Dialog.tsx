import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { choiceAnswer, consentTitle } from '../actions.js';
import { coarsePointer } from '../dom.js';
import { dialogFocus } from '../focus.js';
import { useLatest, useScrollStop } from '../hooks.js';
import { firstFocus } from '../overlays/focus-back.js';
import { modalOpened, openersNow } from '../overlays/modal-store.js';
import { InSlot } from '../overlays/slots.js';
import { dialogOnSwitch, noteDialogDropped, onShownProject, shownProject } from '../projects-api.js';
import type { PromptChoice } from '../types.js';
import { CmdLine } from './bits.js';

/**
 * What every modal stands on: a scrim in the layer slot, the app behind it inert, Tab kept inside it,
 * and the focus back on what opened it however it closes (the modal store). A press on the scrim asks
 * it to close only when it both starts and ends there, so a selection dragged out of a command never
 * closes it. `requestClose` is what Esc and the scrim ask of it: to close, or to ask first.
 */
export function Modal({ requestClose, scrimClass, children }: { requestClose: () => void; scrimClass?: string; children: ReactNode }) {
  const scrim = useRef<HTMLDivElement>(null);
  const asks = useLatest(requestClose);
  // What opened it, read as it is drawn: a field it holds can take the focus as soon as it is in the page.
  const [openers] = useState(openersNow);
  useEffect(() => modalOpened({ root: () => scrim.current, requestClose: () => asks.current(), openers }), [asks, openers]);
  const press = useRef({ down: false, up: false });
  return (
    <InSlot name="layer">
      <div
        ref={scrim}
        className={`scrim${scrimClass ? ` ${scrimClass}` : ''}`}
        onMouseDown={(e) => {
          press.current = { down: e.target === e.currentTarget, up: false };
          // A press on the scrim leaves the focus where it was: it may stay open.
          if (press.current.down) e.preventDefault();
        }}
        onMouseUp={(e) => {
          press.current.up = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          // What opens over the page never acts on what drew it: a dialog's clicks stay out of the row it was asked from.
          e.stopPropagation();
          const { down, up } = press.current;
          press.current = { down: false, up: false };
          if (e.target === e.currentTarget && down && up) asks.current();
        }}
      >
        {children}
      </div>
    </InSlot>
  );
}

/** What a dialog's fields hold, to tell an edit from the dialog as it opened. */
function formState(root: HTMLElement): string {
  return [...root.querySelectorAll<HTMLInputElement>('input, textarea, select, [aria-pressed], [role="switch"]')]
    .map((x) => (x.matches('[type="checkbox"], [type="radio"]') ? String(x.checked) : x.matches('input, textarea, select') ? x.value : (x.getAttribute('aria-pressed') ?? x.getAttribute('aria-checked'))))
    .join('\u241f');
}

/**
 * A dialog over a dimmed page: a title, a line that says what will happen, a body, and Cancel beside
 * the action. Esc or a press on the dimmed page cancels; where its fields were changed they ask first
 * in the footer, "Discard what you changed?", with Keep editing focused and Discard. It always fits,
 * its header and footer in view and its body scrolling; on a phone it is a sheet. The focus starts by
 * rule (`dialogFocus`, `firstFocus`): on Cancel when the action is red or `initialFocus="cancel"`
 * asks for it, so Enter twice never does what can't be undone; else on the first field, not on a
 * touch screen; else on the way on.
 */

export interface DialogProps {
  /** Words, or words with code in them: a file's name, a run's id. */
  title: ReactNode;
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
  const body = useRef<HTMLDivElement>(null);
  useScrollStop(body);
  const id = useId();
  const askId = `${id}ask`;
  // Where it opens is chosen as it opens: nothing the dialog shows later moves the focus.
  const [opensOn] = useState(() => dialogFocus(tone, initialFocus, coarsePointer()));
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const first = firstFocus(root, opensOn);
    first.focus();
    // A line is selected, ready to type over; longer text to edit (a recorded result, a reply) keeps
    // it, with the cursor at its end, as the design's dialogs do.
    if (first instanceof HTMLInputElement) first.select();
    else if (first instanceof HTMLTextAreaElement) first.setSelectionRange(first.value.length, first.value.length);
  }, [opensOn]);

  // What the fields held before anything was changed: a value that arrives as the dialog loads is no edit.
  const opened = useRef<string | null>(null);
  const edited = useRef(false);
  useLayoutEffect(() => {
    if (!edited.current && ref.current) opened.current = formState(ref.current);
  });
  const [asking, setAsking] = useState(false);
  const askedFrom = useRef<HTMLElement | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const keepEditing = (refocus: boolean) => {
    setAsking(false);
    if (refocus) askedFrom.current?.focus();
  };
  const requestClose = () => {
    if (asking) return keepEditing(true);
    if (!edited.current || !ref.current || formState(ref.current) === opened.current) return onClose();
    askedFrom.current = document.activeElement as HTMLElement | null;
    setAsking(true);
  };
  useEffect(() => {
    if (asking) keep.current?.focus();
  }, [asking]);

  // Asked in one project, never answered in another: the page turning to another project closes it.
  const openedIn = useRef(shownProject());
  const close = useLatest(onClose);
  useEffect(
    () =>
      onShownProject((now) => {
        const what = dialogOnSwitch({ openedIn: openedIn.current, shown: now, keeps: keepOnSwitch });
        if (what === 'adopt') openedIn.current = now;
        if (what !== 'close') return;
        noteDialogDropped();
        close.current();
      }),
    [keepOnSwitch, close],
  );
  return (
    <Modal requestClose={requestClose}>
      <div
        className={`dialog${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        ref={ref}
        onChange={() => {
          edited.current = true;
        }}
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest('[aria-pressed], [role="switch"]')) edited.current = true;
          // A click anywhere in it while it asks goes back to editing.
          if (asking && !t.closest('.dlg-keep, .dlg-discard')) keepEditing(false);
        }}
      >
        <header>
          <h3 id={id}>{title}</h3>
          {text ? <p>{text}</p> : null}
        </header>
        {children ? (
          <div className="db" ref={body}>
            {children}
          </div>
        ) : null}
        <footer>
          <button type="button" className="btn dlg-cancel" hidden={asking} onClick={onClose}>
            {ok ? cancel : 'Close'}
          </button>
          {ok ? (
            <button type="button" className={`btn ${tone} dlg-ok`} hidden={asking} disabled={okDisabled} onClick={() => onOk?.()}>
              {ok}
            </button>
          ) : null}
          {asking ? (
            <>
              <span className="dlgask" id={askId}>
                Discard what you changed?
              </span>
              <button ref={keep} type="button" className="btn dlg-keep" aria-describedby={askId} onClick={() => keepEditing(true)}>
                Keep editing
              </button>
              <button type="button" className="btn danger dlg-discard" onClick={onClose}>
                Discard
              </button>
            </>
          ) : null}
        </footer>
      </div>
    </Modal>
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
  after,
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
  /** Under the command, worked out from the answer so far: Copy for a command too long to show whole. */
  after?: (answer: string) => ReactNode;
  maxLength?: number;
  /** Answers to pick from; any other answer is accepted too. */
  choices?: readonly PromptChoice[];
  onRun: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const listed = !!choices?.length;
  const [own, setOwn] = useState(listed && !choices.some((c) => c.value === initial));
  // The few words a picked choice asks for: the message of "error, with a message".
  const [words, setWords] = useState('');
  const picked = listed && !own ? choices.find((c) => c.value === value) : undefined;
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
      {choices.map((c) => (
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
      {after?.(answer)}
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

/**
 * The yes a job waits for before it runs the command of a run from someone else's pack or the team
 * store (`consentAsked`): where it came from, the server's words naming the command, and the action.
 * It opens on Cancel, as it comes up after a click or an Enter of its own: an Enter pressed once too
 * often never runs someone else's command.
 */
export function ConsentDialog({ why, ok, onOk, onClose }: { why: string; ok: string; onOk: () => void; onClose: () => void }) {
  return <Dialog title={consentTitle(why)} text={`${why}.`} ok={ok} initialFocus="cancel" onOk={onOk} onClose={onClose} />;
}
