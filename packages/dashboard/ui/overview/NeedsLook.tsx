import { memo, type RefObject, useRef } from 'react';
import { LOOK_GROUPS } from '../../src/needs-look/groups.js';
import { EventIcon } from '../components/RunIcon.js';
import { Section } from '../components/Section.js';
import { EmptyLine } from '../components/States.js';
import { ruleTip } from '../components/Verdict.js';
import { num, shortId } from '../format.js';
import { type RowScope, useListKeys } from '../list-keys.js';
import { navigate } from '../router.js';
import { type PaletteCommand, useApp } from '../state.js';
import type { NeedsLookRow } from '../types.js';
import { DismissButton, DismissedFold, type Dismissing, RestoreButton, rowAt, useDismissals } from './Dismiss.js';
import { drawnRows, type LookGroupRows } from './dismissed.js';
import { keepParts } from './model.js';
import { LookStepButton, type LookWait, stepRun, useLookWaits } from './steps.js';
import { type AboutOf, DotPieces, Pieces, useAbouts } from './words.js';

/**
 * Needs a look, the Overview's first column: every item, in its groups, as an inbox reads. A group's
 * head is quiet, with the count of what is left in it (none when nothing is); a row is its icon, what
 * it is about (the whole row opens it), and its step at its end, small and plain, which runs or asks
 * from here (steps.tsx); its last column, which every row keeps so the steps share one right edge,
 * holds Dismiss on advice (Dismiss.tsx). A group ends with what was dismissed from it, folded under
 * Dismissed (n). Its words stay whole where a line wraps, and a run it names is named as every run
 * is, its id with its about line on hover.
 */

const HEADS = new Map<string, string>(LOOK_GROUPS);

interface RowProps {
  x: NeedsLookRow;
  /** Put away: muted, with Restore in its step's place, and no ×. */
  off: boolean;
  wait: LookWait | null;
  version: string;
  aboutOf: AboutOf;
  focused: boolean;
  onDismiss: (x: NeedsLookRow) => void;
  onRestore: (x: NeedsLookRow) => void;
}

const LookRow = memo(function LookRow({ x, off, wait, version, aboutOf, focused, onDismiss, onRestore }: RowProps) {
  const own = x.runId && x.about?.text ? { id: shortId(x.runId), about: x.about.text } : null;
  const about: AboutOf = (id) => (own?.id === id ? own.about : aboutOf(id));
  return (
    <div className={`arow${off ? ' off' : ''}${focused ? ' krow' : ''}`} data-rowkey={x.key} data-agrp={x.group} data-adv={x.advice?.key}>
      <EventIcon kind={x.icon} />
      {/* A gate's verdict says its word, tally and bound, whole, and its rule on hover. */}
      <a className="at" href={x.href} data-tip={x.rule ? ruleTip(x.name ?? x.title, x.rule) : undefined}>
        <span className="t">
          <Pieces parts={keepParts(x.title)} aboutOf={about} />
        </span>
        {x.detail ? (
          <span className={`d${x.rule ? ' gv' : ''}`}>
            <DotPieces text={x.detail} max={32} cut={keepParts} aboutOf={about} />
          </span>
        ) : null}
      </a>
      <span className="ast">{off ? <RestoreButton x={x} onRestore={onRestore} /> : <LookStepButton row={x} wait={wait} version={version} />}</span>
      <span className="adx">{x.advice && !off ? <DismissButton x={x} onDismiss={onDismiss} /> : null}</span>
    </div>
  );
});

/** A drawn control as ⌘K offers it: waiting as it waits (`data-why`), and pressed as it is. */
function pressOf(b: HTMLElement, label: string, hint: string): Omit<PaletteCommand, 'group'> {
  const why = b.getAttribute('data-why');
  return { label, hint: why ?? hint, ...(b.tagName === 'BUTTON' ? { job: true } : {}), ...(why ? { wait: why } : {}), run: () => b.click() };
}

/** A row's step as ⌘K offers it: as its button says it, its card's command or line as its hint. */
function stepOf(b: HTMLElement): Omit<PaletteCommand, 'group'> {
  let tip: { s?: string; cmd?: string } = {};
  try {
    tip = JSON.parse(b.getAttribute('data-tip') ?? '{}') as typeof tip;
  } catch {
    tip = {};
  }
  return pressOf(b, b.textContent?.trim() ?? '', tip.cmd?.replace(/^\$ /, '') ?? tip.s ?? '');
}

/**
 * ⌘K on a row: what it opens, then its step, as its button says it, waiting as its button waits, and
 * pressed as its button is, then Dismiss on advice (its hint when it comes back); on a dismissed row,
 * Open and Restore. A row whose step opens its page, and that is no advice, offers nothing of its own.
 */
function lookScope(x: NeedsLookRow, box: RefObject<HTMLElement | null>, off: boolean): RowScope | null {
  const inRow = (sel: string) => box.current?.querySelector<HTMLElement>(`${rowAt(x.key)} ${sel}`) ?? null;
  if (!inRow('.ast .btn') && !inRow('.adis')) return null;
  return {
    name: x.title.slice(0, 48),
    items: () => {
      const open = { label: 'Open', hint: x.href, run: () => navigate(x.href) };
      const b = inRow('.ast .btn');
      if (off) return b ? [open, pressOf(b, 'Restore', '')] : [open];
      const cross = inRow('.adis');
      return [open, ...(b ? [stepOf(b)] : []), ...(cross && x.advice ? [pressOf(cross, 'Dismiss', x.advice.until)] : [])];
    },
  };
}

interface RowsProps {
  d: Dismissing;
  box: RefObject<HTMLDivElement | null>;
  wait: LookWait | null;
  version: string;
}

/** A group: its head, its rows left to look at, then its Dismissed (n) and, opened, the rows under it. */
function LookGroup({ g, d, wait, version, aboutOf, inFocus }: Omit<RowsProps, 'box'> & { g: LookGroupRows; aboutOf: AboutOf; inFocus: string | null }) {
  const open = d.open.has(g.group);
  const row = (x: NeedsLookRow, off: boolean) => <LookRow key={x.key} x={x} off={off} wait={wait} version={version} aboutOf={aboutOf} focused={inFocus === x.key} onDismiss={d.dismiss} onRestore={d.restore} />;
  return (
    <>
      <h3 className="agrp">
        {HEADS.get(g.group)}
        {g.count ? <span>{num(g.count)}</span> : null}
      </h3>
      {g.open.map((x) => row(x, false))}
      {g.dismissed.length ? <DismissedFold group={g.group} n={g.dismissed.length} open={open} onToggle={d.toggle} /> : null}
      {open ? g.dismissed.map((x) => row(x, true)) : null}
    </>
  );
}

/** The rows, under their groups' heads; j and k walk them, an open fold's too, Enter opens one, ⌘K offers its step. */
function Rows({ d, box, wait, version }: RowsProps) {
  const aboutOf = useAbouts();
  const shown = drawnRows(d.groups, d.open);
  const off = new Set(d.groups.flatMap((g) => g.dismissed.map((x) => x.key)));
  const inFocus = useListKeys({ rows: shown, keyOf: (x) => x.key, root: box, open: (x) => navigate(x.href), actions: (x) => lookScope(x, box, off.has(x.key)) });
  return (
    <div className="attn" ref={box}>
      {d.left ? null : <EmptyLine>Nothing needs a look.</EmptyLine>}
      {d.groups.map((g) => (
        <LookGroup key={g.group} g={g} d={d} wait={wait} version={version} aboutOf={aboutOf} inFocus={inFocus} />
      ))}
    </div>
  );
}

/** The rows with the server's jobs read once for all of them, for a list where a row's step runs one. */
function WaitingRows(p: Omit<RowsProps, 'wait'>) {
  const wait = useLookWaits();
  return <Rows {...p} wait={wait} />;
}

/**
 * Needs a look: every item, with the count of what is left to look at. A dashboard that runs nothing
 * reads no jobs: every step there opens its page. `version` names the summary's answer, which a fix
 * step's price lasts as long as (RowStep.tsx); left out, as long as the page. `dismissals` is the
 * list's stamp (the store's dismissals counter), until which a press holds its own view.
 */
export function NeedsLook({ items, total, version = '', dismissals }: { items: readonly NeedsLookRow[]; total: number; version?: string; dismissals?: number }) {
  const { actionsOff, exported } = useApp();
  const box = useRef<HTMLDivElement>(null);
  const d = useDismissals(items, total, dismissals, box);
  const runs = !actionsOff && !exported && items.some((x) => stepRun(x.step));
  return (
    <Section title="Needs a look" sub={num(d.left)} className="ovattn">
      {!items.length ? <EmptyLine>Nothing needs a look.</EmptyLine> : runs ? <WaitingRows d={d} box={box} version={version} /> : <Rows d={d} box={box} wait={null} version={version} />}
    </Section>
  );
}
