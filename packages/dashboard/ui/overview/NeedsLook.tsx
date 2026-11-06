import { Fragment, memo, type RefObject, useRef } from 'react';
import { LOOK_GROUPS } from '../../src/needs-look/groups.js';
import { EventIcon } from '../components/RunIcon.js';
import { Section } from '../components/Section.js';
import { EmptyLine } from '../components/States.js';
import { ruleTip } from '../components/Verdict.js';
import { num, shortId } from '../format.js';
import { type RowScope, useListKeys } from '../list-keys.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import type { NeedsLookRow } from '../types.js';
import { keepParts } from './model.js';
import { LookStepButton, type LookWait, stepRun, useLookWaits } from './steps.js';
import { type AboutOf, DotPieces, Pieces, useAbouts } from './words.js';

/**
 * Needs a look, the Overview's first column: every item, in its groups, as an inbox reads. A group's
 * head is quiet, with its count; a row is its icon, what it is about (the whole row opens it), and
 * its step at its end, small and plain, which runs or asks from here (steps.tsx); the last column is
 * kept empty on every row, for Dismiss. Its words stay whole where a line wraps, and a run it names
 * is named as every run is, its id with its about line on hover.
 */

const HEADS = new Map<string, string>(LOOK_GROUPS);

const LookRow = memo(function LookRow({ x, wait, aboutOf, focused }: { x: NeedsLookRow; wait: LookWait | null; aboutOf: AboutOf; focused: boolean }) {
  const own = x.runId && x.about?.text ? { id: shortId(x.runId), about: x.about.text } : null;
  const about: AboutOf = (id) => (own?.id === id ? own.about : aboutOf(id));
  return (
    <div className={`arow${focused ? ' krow' : ''}`} data-rowkey={x.key} data-agrp={x.group}>
      <EventIcon kind={x.icon} />
      {/* A gate's verdict says its word, tally and bound, whole, and its rule on hover. */}
      <a className="at" href={x.href} data-tip={x.rule ? ruleTip(x.title.replace(/^A test (?:failed|is inconclusive): /, ''), x.rule) : undefined}>
        <span className="t">
          <Pieces parts={keepParts(x.title)} aboutOf={about} />
        </span>
        {x.detail ? (
          <span className={`d${x.rule ? ' gv' : ''}`}>
            <DotPieces text={x.detail} max={32} cut={keepParts} aboutOf={about} />
          </span>
        ) : null}
      </a>
      <span className="ast">
        <LookStepButton row={x} wait={wait} />
      </span>
      <span className="adx" />
    </div>
  );
});

/**
 * ⌘K on a row: what it opens, then its step, as its button says it, waiting as its button waits, and
 * pressed as its button is. A row whose step opens its page offers nothing of its own.
 */
function lookScope(x: NeedsLookRow, box: RefObject<HTMLElement | null>): RowScope | null {
  const button = () => box.current?.querySelector<HTMLElement>(`[data-rowkey="${CSS.escape(x.key)}"] .ast .btn`) ?? null;
  if (!button()) return null;
  return {
    name: x.title.slice(0, 48),
    items: () => {
      const b = button();
      const open = { label: 'Open', hint: x.href, run: () => navigate(x.href) };
      if (!b) return [open];
      let tip: { s?: string; cmd?: string } = {};
      try {
        tip = JSON.parse(b.dataset.tip ?? '{}') as typeof tip;
      } catch {
        tip = {};
      }
      const why = b.dataset.why ?? null;
      const step = { label: b.textContent?.trim() ?? '', hint: why ?? tip.cmd?.replace(/^\$ /, '') ?? tip.s ?? '', ...(b.tagName === 'BUTTON' ? { job: true } : {}), ...(why ? { wait: why } : {}), run: () => b.click() };
      return [open, step];
    },
  };
}

/** The rows, under their groups' heads; j and k walk them, Enter opens one, ⌘K offers its step. */
function Rows({ items, wait }: { items: readonly NeedsLookRow[]; wait: LookWait | null }) {
  const box = useRef<HTMLDivElement>(null);
  const aboutOf = useAbouts();
  const inFocus = useListKeys({ rows: items, keyOf: (x) => x.key, root: box, open: (x) => navigate(x.href), actions: (x) => lookScope(x, box) });
  // A group's count is its rows, a line for the rest of a source as many as it stands for.
  const counts = new Map<string, number>();
  for (const x of items) counts.set(x.group, (counts.get(x.group) ?? 0) + (x.more ?? 1));
  return (
    <div className="attn" ref={box}>
      {items.map((x, i) => (
        <Fragment key={x.key}>
          {x.group !== items[i - 1]?.group ? (
            <h3 className="agrp">
              {HEADS.get(x.group)}
              <span>{num(counts.get(x.group) ?? 0)}</span>
            </h3>
          ) : null}
          <LookRow x={x} wait={wait} aboutOf={aboutOf} focused={inFocus === x.key} />
        </Fragment>
      ))}
    </div>
  );
}

/** The rows with the server's jobs read once for all of them, for a list where a row's step runs one. */
function WaitingRows({ items }: { items: readonly NeedsLookRow[] }) {
  const wait = useLookWaits();
  return <Rows items={items} wait={wait} />;
}

/** Needs a look: every item, with its count. A dashboard that runs nothing reads no jobs: every step there opens its page. */
export function NeedsLook({ items, total }: { items: readonly NeedsLookRow[]; total: number }) {
  const { actionsOff, exported } = useApp();
  const runs = !actionsOff && !exported && items.some((x) => stepRun(x.step));
  return (
    <Section title="Needs a look" sub={num(total)} className="ovattn">
      {!items.length ? <EmptyLine>Nothing needs a look.</EmptyLine> : runs ? <WaitingRows items={items} /> : <Rows items={items} wait={null} />}
    </Section>
  );
}
