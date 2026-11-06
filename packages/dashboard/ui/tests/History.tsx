import type { GoldenRow, TestsView } from '../api.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { historyTip, revLabel } from '../goldens.js';
import { href } from '../route.js';
import { navigate } from '../router.js';

/**
 * A golden's history on Tests: the column's head with each revision, the row's cells, and the strip a
 * phone shows under the golden's name in their place.
 */

/** A history column's class: `r0` the newest revision, `r1` the one before, and so on, by which the oldest give way on a narrow panel. */
const revClass = (i: number, n: number) => `r${n - 1 - i}`;

/** A history cell's class: how the golden came out at that revision, inconclusive told apart. */
const cellClass = (h: GoldenRow['history'][number]) => (h.verdict === 'inconclusive' ? 'inc' : (h.result ?? 'none'));

/** The history column's head: its name, then each revision, the oldest first. */
export function RevisionHeads({ revisions }: { revisions: TestsView['revisions'] }) {
  return (
    <th className="hist">
      <span className="hn">By revision</span>
      {revisions.map((r, i) => (
        <span key={`${String(r)}:${i}`} className={revClass(i, revisions.length)} data-tip={tipText(r ? `revision ${r}` : 'no revision: not in a git repository')}>
          {revLabel(r)}
        </span>
      ))}
    </th>
  );
}

/** The history as a phone shows it under the golden's name: a strip of its cells. */
export function HistoryStrip({ row }: { row: GoldenRow }) {
  return (
    <span className="gstrip" aria-hidden="true">
      {row.history.map((h, i) => (
        <i key={`${String(h.revision)}:${i}`} className={cellClass(h)} />
      ))}
    </span>
  );
}

/** The row's history cells, each opening the run it was tested by where there is one. */
export function HistoryCells({ row }: { row: GoldenRow }) {
  const n = row.history.length;
  return (
    <td className="hist">
      {row.history.map((h, i) => {
        const t = historyTip(h, row.name);
        return (
          <i
            key={`${String(h.revision)}:${i}`}
            className={`${cellClass(h)} ${revClass(i, n)}${h.updated ? ' upd' : ''}${h.runId ? ' go' : ''}`}
            data-tip={tipCard(t.title, [{ label: t.label, value: t.value, color: t.color }])}
            data-acts={h.runId ? '' : undefined}
            onClick={
              h.runId
                ? (e) => {
                    e.stopPropagation();
                    navigate(href.run(h.runId!));
                  }
                : undefined
            }
          />
        );
      })}
    </td>
  );
}
