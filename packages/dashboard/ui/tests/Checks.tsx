import type { ReactNode } from 'react';
import { Words } from '../components/Copy.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { glued } from '../format.js';
import { checkMark } from '../goldens.js';
import { href } from '../route.js';
import { openResults } from '../run/panel-state.js';
import type { GoldenCheck, GoldenRow } from '../types.js';
import { CheckActs, CheckTail } from './check-entries.js';
import { gateCheck, type GateCheckView } from './gate.js';

/**
 * A golden's checks, each marked by how its last result came out on it (✓ passed, ✗ failed, ? in
 * amber when it couldn't be decided, – when it didn't apply; no mark before a result), with what
 * failed, in how many attempts, or why, under it and on hover. In the table's cell (`cell`), what
 * changes them, where the page offers it (check-entries.tsx), then its injection gate under them,
 * which its tests entry sets; a report's part draws only the checks it names, and nothing that
 * changes them.
 */
export function Checks({ row, labels, cell }: { row: GoldenRow; /** Only these, in the row's order: a report's part names those it is about. */ labels?: readonly string[]; cell?: boolean }) {
  return (
    <>
      <CheckList row={row} labels={labels} cell={!!cell} />
      {cell && row.injectionGate ? <GateCheck g={gateCheck(row.injectionGate, row.last)} /> : null}
    </>
  );
}

function CheckList({ row, labels, cell }: { row: GoldenRow; labels: readonly string[] | undefined; cell: boolean }) {
  if (!row.checks.length) {
    return (
      <>
        <em className="nil" data-tip={tipText('No checks in shadowlap.config.json: it passes when it replays and the agent exits 0')}>
          exit status only
        </em>
        {cell ? <CheckTail row={row} /> : null}
      </>
    );
  }
  const ran = row.last.result !== null;
  const shown = row.checkResults.filter((c) => !labels || labels.includes(c.label));
  return (
    <>
      {shown.map((c, i) => (
        <Check key={`${c.label}:${i}`} c={c} ran={ran} cell={cell}>
          {cell ? <CheckActs row={row} check={c.label} last={i === shown.length - 1} /> : null}
        </Check>
      ))}
      {cell ? <CheckTail row={row} /> : null}
    </>
  );
}

/**
 * One check, its mark, its words and what it found under them, with its card (a judge's with its
 * rows): the table's, whose passed judge says where its verdict came from on its card (`cell`), and
 * a report's, as its checks part and its attempts' check draw it. `children`: what follows its words.
 */
export function Check({ c, ran, cell, children }: { c: GoldenCheck; ran: boolean; cell?: boolean; children?: ReactNode }) {
  const m = checkMark(c, ran, cell);
  return (
    <span className={`ck${m.status ? ` ${m.status}` : ''}`} data-tip={tipCard(m.tip.title, m.tip.rows ?? [{ label: m.tip.label, value: m.tip.value, color: m.tip.color }], m.tip.note)}>
      {m.mark ? (
        <b className="cm" role="img" aria-label={m.word}>
          {m.mark}
        </b>
      ) : null}
      <span className="cw">
        {/* the engine's label as written, each name in it whole: a judge's `"explains-escalation"` never splits at its hyphen */}
        <Words glued={false}>{m.text}</Words>
        {m.sub ? <small>{glued(m.sub)}</small> : null}
      </span>
      {children}
    </span>
  );
}

/** Its injection gate's line: its mark, its words opening the results of its last test, and its tally unless it passed. */
function GateCheck({ g }: { g: GateCheckView }) {
  const words = (
    <>
      {g.text}
      {g.sub ? <small>{glued(g.sub)}</small> : null}
    </>
  );
  const open = g.open;
  return (
    <span className={`ck injck${g.status ? ` ${g.status}` : ''}`} data-tip={tipCard(g.title, [], g.line)}>
      {g.mark ? (
        <b className="cm" role="img" aria-label={g.status ?? undefined}>
          {g.mark}
        </b>
      ) : null}
      {open ? (
        <a
          className="cw"
          href={href.run(open.runId)}
          onClick={(e) => {
            // The row opens the run it names, or the proof: these words open the results instead.
            e.stopPropagation();
            openResults(open.runId, open.key);
          }}
        >
          {words}
        </a>
      ) : (
        <span className="cw">{words}</span>
      )}
    </span>
  );
}
