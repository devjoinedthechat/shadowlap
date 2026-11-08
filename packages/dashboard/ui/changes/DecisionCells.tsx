import type { CSSProperties, KeyboardEvent } from 'react';
import { tipCard } from '../components/HoverCard.js';
import { cellLook, drawnCells, type DrawnCell } from '../decisions.js';
import { focusQuiet } from '../focus-manager.js';
import { shortId } from '../format.js';
import type { DecisionCell, DecisionRow } from '../types.js';

/**
 * A run's row of decision cells, as a preview's matrix and the run's Decisions view draw it: a cell
 * per model call in its consequence colour, split a band a sample where its samples differ; past 60
 * calls a cell stands for a range, drawn as its most consequential call. The row is one Tab stop,
 * ← → Home End along its cells, as the strip's are.
 */

type Row = Pick<DecisionRow, 'runId' | 'cells' | 'ending'>;

/** The call a row's links open: what it ends on, else its first. */
export const topCall = (row: Row): number | null => row.ending.callNo ?? row.cells[0]?.callNo ?? null;

/** A drawn cell's name, which its label and card start with: `#27 · step 9`, a range `#61–#64 · steps 31–32`. */
function cellHead(c: DrawnCell<DecisionCell>): string {
  return c.count > 1 ? `#${c.first.callNo}–#${c.last.callNo} · steps ${c.first.step}–${c.last.step}` : `#${c.top.callNo} · step ${c.top.step}`;
}

/** The calls a drawn cell stands for, in call order. */
const callsOf = (c: DrawnCell<DecisionCell>, cells: readonly DecisionCell[]) => cells.slice(cells.indexOf(c.first), cells.indexOf(c.last) + 1);

/** A rank's colour on a card's row, as a cell of it is drawn. */
const RANK_COLOUR: Readonly<Record<number, string>> = { 1: 'var(--cq-red)', 2: 'var(--cq-amber)', 3: 'var(--k-read)', 4: 'var(--k-read)', 5: 'var(--cq-muted-fill)' };

/**
 * What a drawn cell decided: its call's words. A range: its changed calls and its most consequential
 * one; where none changed, its most telling call within the model's own variation, else that it decided
 * as recorded at every call asked, else why its calls weren't asked.
 */
function cellWords(c: DrawnCell<DecisionCell>, cells: readonly DecisionCell[]): string {
  if (c.count === 1) return c.top.words;
  const part = callsOf(c, cells);
  const changed = part.filter((x) => x.rank);
  if (changed.length) return `${changed.length} changed call${changed.length === 1 ? '' : 's'}, most: #${c.top.callNo} ${c.top.detail ?? ''}`.trim();
  if (c.top.state === 'noise') return `#${c.top.callNo} ${c.top.words}`;
  return part.some((x) => x.state === 'same') ? 'the same decisions at every call asked' : c.top.words;
}

/**
 * A drawn cell's card: a call's head with its scope, its words and its rank; a range's head, how many of
 * its calls changed, and up to four of them, the most consequential first, each in its colour.
 */
function cellCard(c: DrawnCell<DecisionCell>, cells: readonly DecisionCell[], words: string): string {
  if (c.count === 1) {
    const t = c.top;
    return tipCard(`${cellHead(c)}${t.scope ? ` · ${t.scope}` : ''}`, t.rankWords && t.rank ? [{ label: `rank ${t.rank}`, value: t.rankWords, color: RANK_COLOUR[t.rank] ?? '' }] : [], words);
  }
  const changed = callsOf(c, cells).filter((x) => x.rank);
  const rows = [...changed]
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.callNo - b.callNo)
    .slice(0, 4)
    .map((x) => ({ label: `#${x.callNo}`, value: x.detail ?? '', color: RANK_COLOUR[x.rank ?? 0] ?? '' }));
  return tipCard(cellHead(c), rows, changed.length ? `${changed.length} call${changed.length === 1 ? '' : 's'} of ${c.count} changed` : words);
}

/** ← → Home End move along a row's cells, the focus with them: the row is one Tab stop. */
function moveAlong(e: KeyboardEvent<HTMLDivElement>): void {
  const cells = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.dc')];
  const at = cells.indexOf(document.activeElement as HTMLButtonElement);
  const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? cells.length - 1 : null;
  if (to === null || at < 0 || !cells[to]) return;
  e.preventDefault();
  for (const c of cells) c.tabIndex = c === cells[to] ? 0 : -1;
  cells[to].focus();
}

/**
 * A row's cells; `open` is the call the page shows (its cell is current), `className` the wrapper's place on
 * its page. `cols` is how many columns its grid has: a matrix gives each row its widest row's, so call k
 * sits in the same column in every row and the rows go dense together; a strip of its own, its own count.
 * A press says whether its cell was the current one, which a matrix closes.
 */
export function DecisionCells({ row, open, onOpen, className, cols }: { row: Row; open: number | null; onOpen: (call: number, current: boolean) => void; className?: string; cols?: number }) {
  const drawn = drawnCells(row.cells);
  const n = Math.max(cols ?? 0, drawn.length, 1);
  const holds = (c: DrawnCell<DecisionCell>, call: number | null) => call !== null && c.first.callNo <= call && call <= c.last.callNo;
  // The row's one Tab stop: the open cell, else the one it ends on, else its first.
  const stop = Math.max(0, drawn.findIndex((c) => holds(c, open ?? topCall(row))));
  return (
    <div className={className ? `dmcw ${className}` : 'dmcw'}>
      <div className={`dmc${n > 30 ? ' dense' : ''}`} style={{ '--n': n } as CSSProperties} role="group" aria-label={`${shortId(row.runId)}, its model calls`} onKeyDown={moveAlong}>
        {drawn.map((c, i) => {
          const look = cellLook(c.top);
          const words = cellWords(c, row.cells);
          // Left as recorded hollow, not asked dashed, words a judge couldn't read ringed, else its colour.
          const tone = look.hollow ? 'un' : look.dashed ? 'na' : look.ring ? 'jw' : look.fill === 'm' ? '' : look.fill;
          const cls = ['dc', tone, look.bands ? 'split' : ''].filter(Boolean).join(' ');
          return (
            <button key={c.first.callNo} type="button" className={cls} tabIndex={i === stop ? 0 : -1} aria-current={holds(c, open)} aria-label={`${cellHead(c)}: ${words}`} data-tip={cellCard(c, row.cells, words)} onClick={(e) => {
                // The cell keeps the focus where the page is, as the matrix draws again.
                focusQuiet(e.currentTarget);
                onOpen(c.top.callNo, holds(c, open));
              }}
            >
              {look.bands?.map((b, k) => <i key={k} className={b === 'm' ? undefined : b} />)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
