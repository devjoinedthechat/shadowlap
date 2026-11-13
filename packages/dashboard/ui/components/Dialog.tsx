import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { choiceAnswer, consentTitle } from '../actions.js';
import { DOCS, docsHref, type DocKey } from '../docs-links.js';
import { coarsePointer } from '../dom.js';
import { dialogFocus } from '../focus.js';
import { useLatest, useScrollStop } from '../hooks.js';
import { firstFocus } from '../overlays/focus-back.js';
import { modalOpened, openersNow } from '../overlays/modal-store.js';
import { InSlot } from '../overlays/slots.js';
import { dialogOnSwitch, noteDialogDropped, onShownProject, shownProject } from '../projects-api.js';
import type { PromptChoice } from '../types.js';
import { CommandRow, type CommandRowProps } from './CommandRow.js';
import { Copy, textOf, titled } from './Copy.js';
import { CostLine, useCostStick, type CostLineProps } from './CostLine.js';
import { DialogFacts, factId, inCode, shownFacts, type DialogFactRows } from './DialogFacts.js';
import { ActionButton } from './ActionButton.js';

/**
 * What every modal stands on: a scrim in the layer slot, the app behind it inert, Tab kept inside it,
 * and the focus back on what opened it however it closes (the modal store). A press on the scrim asks
 * it to close only when it both starts and ends there, so a selection dragged out of a command never
 * closes it. `requestClose` is what Esc (`key`) and the scrim ask of it, to close or to ask first, and
 * what the page it opened on going (`page`) tells it: to close.
 */
export function Modal({ requestClose, scrimClass, children }: { requestClose: (by: 'key' | 'scrim' | 'page') => void; scrimClass?: string; children: ReactNode }) {
  const scrim = useRef<HTMLDivElement>(null);
  const asks = useLatest(requestClose);
  // What opened it, read as it is drawn: a field it holds can take the focus as soon as it is in the page.
  const [openers] = useState(openersNow);
  useEffect(() => modalOpened({ root: () => scrim.current, requestClose: () => asks.current('key'), close: () => asks.current('page'), openers }), [asks, openers]);
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
          if (e.target === e.currentTarget && down && up) asks.current('scrim');
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
 * One dialog anatomy, every dialog and every ask before a job, its slots in this order so none writes
 * its own: a title that is verb and object; a lead of one sentence, ending on the docs page that says
 * how the job works; one amber or red line, where it can't help yet or acts for real; what decides
 * whether to press, as label and value rows; its fields; a row that says what a field does; the runs
 * it acts on; the `$` command, following the fields; what it bills in one quiet line; and Cancel, then
 * the way on, lime, red where it deletes, plain beside a second way on. A screen reader hears the
 * warning and any amber or red row, then the lead without its link, after the title.
 *
 * The way on closes it, unless it says it can't start, or closes it itself or opens what comes next:
 * `onOk` returning false, or a promise of false, keeps it open with what was typed. Esc or a press on the dimmed page cancels; where its fields were
 * changed they ask first in the footer, "Discard what you changed?", with Keep editing focused and
 * Discard. It always fits, its header and footer in view and its body scrolling; on a phone it is a
 * sheet. The focus starts by rule (`dialogFocus`, `firstFocus`): on Cancel when the action is red or
 * `initialFocus="cancel"` asks for it, so Enter twice never does what can't be undone; else on the
 * first field, not on a touch screen; else on the way on; on a touch screen on Cancel while the way on
 * waits.
 */

/** A way on: false, or a promise of false, when it can't start, which keeps the dialog open; anything else closes it. */
export type WayOn = () => unknown;

export interface DialogWarning {
  text: ReactNode;
  /** Red acts for real, and is answered as a delete is: the confirm red, the focus on Cancel. */
  tone?: 'amber' | 'red' | undefined;
  /** An error's message as the server wrote it (a failed save's): drawn as written, since a no-break space would spoil a path or a command in it. */
  written?: boolean;
}

export interface DialogProps {
  /** Words, or words with code in them: a file's name, a run's id. */
  title: ReactNode;
  /** One sentence: what it does to what. */
  lead?: ReactNode;
  /** The docs page the lead ends on. */
  doc?: DocKey | undefined;
  /** One line, before the facts. */
  warn?: DialogWarning | null | undefined;
  /** Rows above the fields. */
  facts?: DialogFactRows | undefined;
  /** The fields. */
  children?: ReactNode;
  /** A row that says what a field does, sitting under the fields. */
  factsUnder?: DialogFactRows | undefined;
  /** The runs it acts on. */
  runs?: ReactNode;
  /** The `$` row. */
  command?: CommandRowProps | string | readonly string[] | null | undefined;
  /** What it bills. */
  cost?: CostLineProps | null | undefined;
  /** At the left of its footer: an ask's Spending note (AskNote), which takes a row of its own where the buttons don't fit beside it. */
  footNote?: ReactNode;
  /** The action's words; omit for a dialog with Close only. */
  ok?: string;
  /** `danger` turns the action red; `plain` gives it no colour. */
  tone?: 'lime' | 'danger' | 'plain';
  okDisabled?: boolean;
  /** Why the way on can't run yet: it reads off, why on its card and, pressed, in a toast (ActionButton's `why`). */
  okWhy?: string | null | undefined;
  /** The line on the way on's card while it can run. */
  okSub?: string | null | undefined;
  onOk?: WayOn;
  /** A second way on: lime, the first reading plain beside it. */
  alt?: { label: string; onClick: WayOn; disabled?: boolean } | null | undefined;
  onClose: () => void;
  cancel?: string;
  className?: string;
  /** `cancel` focuses Cancel when the dialog opens, for a confirm that can't be undone: Enter twice never deletes anything. */
  initialFocus?: 'cancel';
  /** A control the focus starts on where the dialog holds one, ahead of the rule, though not on a touch screen (the check builder's pressed kind). */
  startFocus?: string | undefined;
  /** `ignore`: a press on the scrim never closes it, edited or not, for a dialog that holds work built up (the check builder). Esc still closes it, or asks first. */
  scrim?: 'ignore';
  /** Something no field holds was changed (a file dropped): Esc and the scrim ask first, as they do for a field's edit. */
  dirty?: boolean;
  /**
   * A dialog belongs to the project the page showed when it opened: when the dashboard switches to
   * another project elsewhere (another tab), it closes, since its action would land in that one.
   * `keepOnSwitch` keeps one that holds only what was typed into it (a rule, a server's command),
   * which then acts on the project the page shows (`dialogOnSwitch`).
   */
  keepOnSwitch?: boolean;
  /**
   * Its action changes nothing on the server (a Copy): it never waits. Every other confirm is a
   * server action, which waits as an `ActionButton` does, the dialog staying open with what was typed.
   */
  local?: boolean;
}

/** Enter on a dialog's field presses its way on, which may refuse or wait (ActionButton): as the button does. */
export function pressWayOn(from: EventTarget): void {
  const ok = (from as HTMLElement).closest('.dialog')?.querySelector<HTMLButtonElement>('.dlg-ok');
  if (ok && !ok.disabled) ok.click();
}

/**
 * The docs page a lead ends on, in a new tab; its arrow is drawn only, so a screen reader says the
 * page's name alone. An element whose children are its words, so the lead's `Copy` reads them and
 * keeps it with the sentence before it where the two fit a line.
 */
function docLink(doc: DocKey) {
  const link = DOCS[doc];
  return (
    <a className="more dlgdoc" href={docsHref(link)} target="_blank" rel="noopener">
      {link.what} in the docs<span aria-hidden="true">{'\u00a0→'}</span>
    </a>
  );
}

/**
 * A dialog's title: a string's words glued (`titled`), and a node with a name in it (`namedIn`) set as
 * copy, the name kept whole, so neither ends a line on a small word.
 */
function DialogTitle({ id, title }: { id: string; title: ReactNode }) {
  if (typeof title !== 'string') {
    return (
      <Copy as="h3" id={id}>
        {title}
      </Copy>
    );
  }
  const head = titled(title);
  return (
    <h3 id={id} aria-label={head['aria-label']}>
      {head.children}
    </h3>
  );
}

/**
 * A dialog's title and lead: the title's words set (`DialogTitle`), the lead set as copy with its docs
 * link inside it, and the lead as written in a hidden span first, which the description reads, so a
 * screen reader hears it once and never the breaks the setting adds.
 */
function DialogHead({ id, title, lead, doc }: Pick<DialogProps, 'title' | 'lead' | 'doc'> & { id: string }) {
  return (
    <header>
      <DialogTitle id={id} title={title} />
      {lead || doc ? (
        <p>
          <span id={`${id}lead`} hidden>
            {textOf(lead)}
          </span>
          <Copy as="span" phrases>
            {lead}
            {doc ? ' ' : null}
            {doc ? docLink(doc) : null}
          </Copy>
        </p>
      ) : null}
    </header>
  );
}

/** The ids a dialog's description names, in the order it is read: the warning, any amber or red row, then the lead. */
function describedBy(id: string, { warn, facts, factsUnder, lead }: Pick<DialogProps, 'warn' | 'facts' | 'factsUnder' | 'lead'>): string | undefined {
  const toned = (rows: DialogFactRows | undefined, at: string) => shownFacts(rows).flatMap((f, i) => (f.tone ? [factId(at, i)] : []));
  const ids = [...(warn ? [`${id}warn`] : []), ...toned(facts, `${id}a`), ...toned(factsUnder, `${id}b`), ...(lead ? [`${id}lead`] : [])];
  return ids.length ? ids.join(' ') : undefined;
}

/** The amber or red line: words set as a lead is (`Copy` with phrases); an error's message as written, and a node, as they are. */
function WarnLine({ id, warn }: { id: string; warn: DialogWarning }) {
  const className = `dwarn${warn.tone === 'red' ? ' red' : ''}`;
  return typeof warn.text === 'string' && !warn.written ? (
    <Copy id={`${id}warn`} className={className} phrases>
      {inCode(warn.text)}
    </Copy>
  ) : (
    <p id={`${id}warn`} className={className}>
      {inCode(warn.text)}
    </p>
  );
}

/** The body's slots, in order, after the header. */
function DialogBody({ id, warn, facts, children, factsUnder, runs, command, cost, body }: Pick<DialogProps, 'warn' | 'facts' | 'children' | 'factsUnder' | 'runs' | 'command' | 'cost'> & { id: string; body: RefObject<HTMLDivElement | null> }) {
  const row = typeof command === 'string' || Array.isArray(command) ? { command: command as string | readonly string[] } : (command as CommandRowProps | null | undefined);
  return (
    <div className="db" ref={body}>
      {warn ? <WarnLine id={id} warn={warn} /> : null}
      <DialogFacts rows={facts ?? []} id={`${id}a`} />
      {children}
      <DialogFacts rows={factsUnder ?? []} id={`${id}b`} />
      {runs ? <div className="dvrows">{runs}</div> : null}
      {row ? <CommandRow {...row} /> : null}
      {cost ? <CostLine {...cost} /> : null}
    </div>
  );
}

/**
 * A dialog's ways on: its confirm, then `alt`, each a server action that waits as an `ActionButton`
 * does, the dialog staying open with what was typed. A confirm that changes nothing on the server
 * (`local`) is a plain button, and never waits.
 */
function DialogWays({ ok, alt, local, tone, okDisabled, okWhy, okSub, onOk, press, hidden }: { ok: string | undefined; alt: DialogProps['alt']; local: boolean; tone: NonNullable<DialogProps['tone']>; okDisabled: boolean; okWhy: string | null | undefined; okSub: string | null | undefined; onOk: WayOn | undefined; press: (way?: WayOn) => void; hidden: boolean }) {
  const okClass = `btn${alt || tone === 'plain' ? '' : ` ${tone}`} dlg-ok`;
  return (
    <>
      {ok && local ? (
        <button type="button" className={okClass} hidden={hidden} disabled={okDisabled} onClick={() => press(onOk)}>
          {ok}
        </button>
      ) : ok ? (
        <ActionButton className={okClass} hidden={hidden} disabled={okDisabled} why={okWhy} {...(okSub ? { tip: ok, sub: okSub } : {})} onClick={() => press(onOk)}>
          {ok}
        </ActionButton>
      ) : null}
      {alt ? (
        <ActionButton className="btn lime dlg-alt" hidden={hidden} disabled={alt.disabled} onClick={() => press(alt.onClick)}>
          {alt.label}
        </ActionButton>
      ) : null}
    </>
  );
}

export function Dialog({ title, lead, doc, warn, facts, children, factsUnder, runs, command, cost, footNote, ok, tone: asked = 'lime', okDisabled = false, okWhy, okSub, onOk, alt, onClose, cancel = 'Cancel', className = '', initialFocus, startFocus, scrim, dirty = false, keepOnSwitch = false, local = false }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useScrollStop(body);
  const id = useId();
  const askId = `${id}ask`;
  // A red line acts for real, and is answered as a delete is.
  const tone = warn?.tone === 'red' ? 'danger' : asked;
  const hasBody = !!(warn || shownFacts(facts).length || children || shownFacts(factsUnder).length || runs || command || cost);
  useCostStick(body, hasBody);
  // Where it opens is chosen as it opens: nothing the dialog shows later moves the focus.
  const [[opensOn, touch]] = useState(() => {
    const coarse = coarsePointer();
    const rule = dialogFocus(tone, initialFocus, coarse);
    return [startFocus && !coarse ? [startFocus, ...rule] : rule, coarse] as const;
  });
  const startedOn = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const first = firstFocus(root, opensOn, touch);
    first.focus();
    // A line is selected, ready to type over; longer text to edit (a recorded result, a reply) keeps
    // it, with the cursor at its end, as the design's dialogs do.
    if (first instanceof HTMLInputElement) first.select();
    else if (first instanceof HTMLTextAreaElement) first.setSelectionRange(first.value.length, first.value.length);
    startedOn.current = first;
  }, [opensOn, touch]);
  // A way on that waited for something (Run repair, reading its repairer) takes the focus from Cancel
  // once it can, if no one has moved it; one that asked for a file leaves it where it is.
  useEffect(() => {
    const ok = ref.current?.querySelector<HTMLElement>('.dlg-ok');
    const from = startedOn.current;
    if (!okDisabled && ok && from && from === document.activeElement && from.matches('.dlg-cancel') && opensOn.includes('.dlg-ok')) ok.focus();
  }, [okDisabled, opensOn]);

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
  const requestClose = (by: 'key' | 'scrim' | 'page') => {
    // The page it was asked on has gone: what it asked about went with it.
    if (by === 'page') return onClose();
    if (by === 'scrim' && scrim === 'ignore') return;
    // While it asks, a second Esc keeps editing, and the scrim does nothing.
    if (asking) return by === 'key' ? keepEditing(true) : undefined;
    const changed = dirty || (edited.current && !!ref.current && formState(ref.current) !== opened.current);
    if (!changed) return onClose();
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
  const pressing = useRef(false);
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const press = (way?: WayOn) => {
    if (pressing.current) return;
    const out = way?.();
    if (out === false) return;
    if (!(out instanceof Promise)) return close.current();
    // It waits for the answer once, however often it is pressed.
    pressing.current = true;
    void out.then(
      (v) => {
        pressing.current = false;
        if (v !== false && shown.current) close.current();
      },
      () => {
        pressing.current = false;
      },
    );
  };
  return (
    <Modal requestClose={requestClose}>
      <div
        className={`dialog${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        aria-describedby={describedBy(id, { warn, facts, factsUnder, lead })}
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
        <DialogHead {...{ id, title, lead, doc }} />
        {hasBody ? <DialogBody {...{ id, warn, facts, factsUnder, runs, command, cost, body, children }} /> : null}
        <footer>
          {asking ? null : footNote}
          <button type="button" className="btn dlg-cancel" hidden={asking} onClick={onClose}>
            {ok ? cancel : 'Close'}
          </button>
          <DialogWays {...{ ok, alt, local, tone, okDisabled, okWhy, okSub, onOk, press }} hidden={asking} />
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

/** A field's `list`, naming its suggestions, where it has any. */
export const suggestedList = (id: string, values: readonly string[] | undefined) => (values?.length ? { list: id } : {});

/** What a field offers as you type, for its `list`: none drawn where it has none. A dialog's field, and a run's Add label. */
export function Suggestions({ id, values }: { id: string; values: readonly string[] | undefined }) {
  if (!values?.length) return null;
  return (
    <datalist id={id}>
      {values.map((v) => (
        <option key={v} value={v} />
      ))}
    </datalist>
  );
}

/** What `PromptDialog` takes: its field, its answers and its way on, and the anatomy's slots it passes through. */
type PromptDialogProps = Pick<DialogProps, 'title' | 'lead' | 'doc' | 'warn' | 'facts' | 'factsUnder' | 'cost' | 'footNote' | 'onClose'> & {
  ok: string;
  label?: string;
  /** The field's name for a screen reader, where no label shows. */
  fieldName?: string;
  /** A list that fills the field, which can then be edited or replaced. */
  startFrom?: { label: string; choices: readonly PromptChoice[]; note: string };
  initial?: string;
  placeholder?: string;
  multiline?: boolean;
  /** The command it will run, shown under the field: as it is, or worked out from the answer so far. */
  command?: string | ((answer: string) => string | CommandRowProps);
  /** What follows the field, worked out from the answer so far: a gate's entry for the folder typed. */
  after?: (answer: string) => ReactNode;
  /** Told the answer as it changes: Switch model prices the model typed. */
  onAnswer?: (answer: string) => void;
  maxLength?: number;
  /** Answers to pick from; any other answer is accepted too. */
  choices?: readonly PromptChoice[];
  /** Answers the field offers as you type (a datalist): the labels runs carry. Any other is typed. */
  suggestions?: readonly string[];
  onRun: (value: string) => unknown;
};

/**
 * A dialog that asks one thing before an action runs: a line of text, a longer one, or one of a few
 * answers (`choices`, a select like the mock's, with "Something else…" for an answer of your own).
 * A choice with a field of its own (`text`, such as "error, with a message") shows that field and
 * sends the choice's value followed by what was typed. Its field always has a name: its label, or
 * `fieldName` where the title says what it is. Everything else of the anatomy passes through.
 */
export function PromptDialog({
  label,
  fieldName,
  startFrom,
  initial = '',
  placeholder = '',
  multiline = false,
  command,
  after,
  onAnswer,
  maxLength,
  choices,
  suggestions,
  onRun,
  ...slots
}: PromptDialogProps) {
  const [value, setValue] = useState(initial);
  const suggested = useId();
  const listed = !!choices?.length;
  const [own, setOwn] = useState(listed && !choices.some((c) => c.value === initial));
  // The few words a picked choice asks for: the message of "error, with a message".
  const [words, setWords] = useState('');
  const picked = listed && !own ? choices.find((c) => c.value === value) : undefined;
  const answer = picked ? choiceAnswer(picked, words) : value.trim();
  useEffect(() => onAnswer?.(answer), [answer, onAnswer]);
  const ready = answer.length > 0;
  const named = !label && !listed ? { 'aria-label': fieldName ?? (typeof slots.title === 'string' ? slots.title : 'Your answer') } : {};
  const field = multiline ? (
    <textarea
      value={value}
      placeholder={placeholder}
      autoFocus={listed}
      {...named}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          pressWayOn(e.currentTarget);
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
      {...named}
      {...suggestedList(suggested, suggestions)}
      {...(maxLength ? { maxLength } : {})}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          pressWayOn(e.currentTarget);
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
  const row = typeof command === 'function' ? command(answer) : command;
  return (
    <Dialog {...slots} command={row} okDisabled={!ready} onOk={() => onRun(answer)}>
      <Suggestions id={suggested} values={suggestions} />
      {startFrom ? (
        <>
          <div className="form one">
            <label>
              {startFrom.label}
              <select onChange={(e) => setValue(e.target.value)}>
                {startFrom.choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {field}
          <Copy className="muted fieldhint">{startFrom.note}</Copy>
        </>
      ) : label || select ? (
        <div className="form one">
          <label>
            {label}
            {select ?? field}
          </label>
          {select && own ? (
            <label>
              {fieldName ?? 'Your answer'}
              {field}
            </label>
          ) : null}
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
                    pressWayOn(e.currentTarget);
                  }
                }}
              />
            </label>
          ) : null}
        </div>
      ) : (
        field
      )}
      {after?.(answer)}
    </Dialog>
  );
}

/** A yes-or-no before something that cannot be undone, with the command it runs. */
export function ConfirmDialog({ danger = false, ...slots }: Pick<DialogProps, 'title' | 'lead' | 'doc' | 'warn' | 'facts' | 'command' | 'cost' | 'footNote' | 'onOk' | 'onClose'> & { ok: string; danger?: boolean }) {
  return <Dialog {...slots} tone={danger ? 'danger' : 'lime'} />;
}

/**
 * The yes a job waits for before it runs the command of a run from someone else's pack or the team
 * store (`consentAsked`): where it came from, the server's words naming the command as its amber
 * line, and the action. It opens on Cancel, as it comes up after a click or an Enter of its own: an
 * Enter pressed once too often never runs someone else's command.
 */
export function ConsentDialog({ why, ok, onOk, onClose }: { why: string; ok: string; onOk: WayOn; onClose: () => void }) {
  return <Dialog title={consentTitle(why)} lead="Runs a command someone else recorded, on this machine." doc="commandsFromSomeoneElse" warn={{ text: why }} ok={ok} initialFocus="cancel" onOk={onOk} onClose={onClose} />;
}
