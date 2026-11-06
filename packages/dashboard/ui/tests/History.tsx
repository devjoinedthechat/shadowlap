import type { CSSProperties } from 'react';
import type { GoldenRow, HistoryCell, TestsView } from '../api.js';
import { tipCard } from '../components/HoverCard.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { revLabel } from '../goldens.js';
import { cellNote, cellShare, cellVerdict, historyKey, KEY_WORDS, revisionTip } from './cells.js';

/**
 * A golden's history on Tests: the column's head with each revision, the row's cells, the strip a
 * phone shows under the golden's name in their place, and the key to them under the table. Each cell
 * is a picture named by its card's words; a cell with a run opens it on a click, its run reached from
 * the row by the keyboard.
 */

/** A history column's class: `r0` the newest revision, `r1` the one before, and so on, by which the oldest give way on a narrow panel. */
const revClass = (i: number, n: number) => `r${n - 1 - i}`;

/** The history column's head: its name, then each revision, the oldest first, its commit on hover. */
export function RevisionHeads({ view }: { view: Pick<TestsView, 'revisions' | 'revisionFacts'> }) {
  const { revisions } = view;
  return (
    <th className="hist">
      <span className="hn">By revision</span>
      {revisions.map((r, i) => (
        <span key={`${String(r)}:${i}`} className={`${revClass(i, revisions.length)}${r ? '' : ' norev'}`} data-tip={JSON.stringify(revisionTip(r, view.revisionFacts?.[i]))}>
          {revLabel(r)}
        </span>
      ))}
    </th>
  );
}

/** A cell's card, as its hover shows it. */
function cellTip(cell: HistoryCell, name: string): string {
  const n = cellNote(cell, name);
  return tipCard(n.title, [{ label: n.word, value: n.note, color: n.color }]);
}

/** A strip square's fill, the share that passed, as the variable its gradient reads. */
function stripFill(share: number): CSSProperties {
  const style: CSSProperties & { '--f': string } = { '--f': `${(100 * share).toFixed(1)}%` };
  return style;
}

/** The history as a phone shows it under the golden's name: a square a revision, filled from the bottom to the share that passed, each named as its cell is. */
export function HistoryStrip({ row }: { row: GoldenRow }) {
  return (
    <span className="gstrip" role="group" aria-label="By revision">
      {row.history.map((h, i) => {
        const share = cellShare(h);
        return <i key={`${String(h.revision)}:${i}`} className={`${cellVerdict(h)}${share !== null ? ' meter' : ''}${h.dropped ? ' hdrop' : ''}${h.updated ? ' upd' : ''}`} style={share !== null ? stripFill(share) : undefined} role="img" aria-label={cellNote(h, row.name).label} data-tip={cellTip(h, row.name)} />;
      })}
    </span>
  );
}

/** The row's history cells, each opening the run it was tested by where there is one. */
export function HistoryCells({ row }: { row: GoldenRow }) {
  const n = row.history.length;
  return (
    <td className="hist">
      {row.history.map((h, i) => {
        const share = cellShare(h);
        return (
          <i
            key={`${String(h.revision)}:${i}`}
            className={`hc ${revClass(i, n)} ${cellVerdict(h)}${h.revision ? '' : ' norev'}${h.updated ? ' upd' : ''}${h.dropped ? ' hdrop' : ''}${share !== null ? ' meter' : ''}${h.runId ? ' go' : ''}`}
            role="img"
            aria-label={cellNote(h, row.name).label}
            data-tip={cellTip(h, row.name)}
            data-acts={h.runId ? '' : undefined}
            onClick={
              h.runId
                ? (e) => {
                    e.stopPropagation();
                    navigate(href.run(h.runId!));
                  }
                : undefined
            }
          >
            {/* the fill is the share that passed of the 24px track, not of the cell: 64 of 80 fills 80% of it */}
            {share !== null ? <b style={{ width: `${(24 * share).toFixed(1)}px` }} /> : null}
          </i>
        );
      })}
    </td>
  );
}

/** The key to By revision's cells, once, under the table: what a dot and a bar stand for, and the rings where a cell has one. */
export function HistoryKey({ rows }: { rows: readonly GoldenRow[] }) {
  const parts = historyKey(rows);
  if (!parts.length) return null;
  return (
    <p className="hkey">
      <span className="hkh">By revision</span>
      {parts.map((k) => (
        <span key={k}>
          <i className={`hk hk-${k}`} aria-hidden="true" />
          {KEY_WORDS[k]}
        </span>
      ))}
    </p>
  );
}
