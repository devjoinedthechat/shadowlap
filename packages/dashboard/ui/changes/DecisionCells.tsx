import type { CSSProperties, KeyboardEvent } from 'react';
import { tipCard } from '../components/HoverCard.js';
import { cellLook, drawnCells, type DrawnCell } from '../decisions.js';
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

/** What a drawn cell decided: its call's words, a range's changed calls and its most consequential one. */
function cellWords(c: DrawnCell<DecisionCell>, cells: readonly DecisionCell[]): string {
  if (c.count === 1) return c.top.words;
  const part = cells.slice(cells.indexOf(c.first), cells.indexOf(c.last) + 1);
  const changed = part.filter((x) => x.rank);
  return changed.length ? `${changed.length} changed call${changed.length === 1 ? '' : 's'}, most: #${c.top.callNo} ${c.top.detail ?? ''}`.trim() : `#${c.top.callNo} ${c.top.words}`;
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

/** A row's cells; `open` is the call the page shows (its cell is current), `className` the wrapper's place on its page. */
export function DecisionCells({ row, open, onOpen, className }: { row: Row; open: number | null; onOpen: (call: number) => void; className?: string }) {
  const drawn = drawnCells(row.cells);
  const holds = (c: DrawnCell<DecisionCell>, call: number | null) => call !== null && c.first.callNo <= call && call <= c.last.callNo;
  // The row's one Tab stop: the open cell, else the one it ends on, else its first.
  const stop = Math.max(0, drawn.findIndex((c) => holds(c, open ?? topCall(row))));
  return (
    <div className={className ? `dmcw ${className}` : 'dmcw'}>
      <div className={`dmc${drawn.length > 30 ? ' dense' : ''}`} style={{ '--n': drawn.length } as CSSProperties} role="group" aria-label={`${shortId(row.runId)}, its model calls`} onKeyDown={moveAlong}>
        {drawn.map((c, i) => {
          const look = cellLook(c.top);
          const words = cellWords(c, row.cells);
          // Left as recorded hollow, not asked dashed, words a judge couldn't read ringed, else its colour.
          const tone = look.hollow ? 'un' : look.dashed ? 'na' : look.ring ? 'jw' : look.fill === 'm' ? '' : look.fill;
          const cls = ['dc', tone, look.bands ? 'split' : ''].filter(Boolean).join(' ');
          return (
            <button key={c.first.callNo} type="button" className={cls} tabIndex={i === stop ? 0 : -1} aria-current={holds(c, open)} aria-label={`${cellHead(c)}: ${words}`} data-tip={tipCard(cellHead(c), [], words)} onClick={() => onOpen(c.top.callNo)}>
              {look.bands?.map((b, k) => <i key={k} className={b === 'm' ? undefined : b} />)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
