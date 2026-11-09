import type { GoldenCheck, GoldenRow } from '../types.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { glued } from '../format.js';
import { checkMark } from '../goldens.js';

/**
 * A golden's checks, each marked by how its last result came out on it (✓ passed, ✗ failed, ? in
 * amber when it couldn't be decided, – when it didn't apply; no mark before a result), with what
 * failed, in how many attempts, or why, under it and on hover.
 */
export function Checks({ row, labels }: { row: GoldenRow; /** Only these, in the row's order: a report's part names those it is about. */ labels?: readonly string[] }) {
  if (!row.checks.length) {
    return (
      <em className="nil" data-tip={tipText('No checks in shadowlap.config.json: it passes when it replays and the agent exits 0')}>
        exit status only
      </em>
    );
  }
  const ran = row.last.result !== null;
  return (
    <>
      {row.checkResults
        .filter((c) => !labels || labels.includes(c.label))
        .map((c, i) => (
          <Check key={`${c.label}:${i}`} c={c} ran={ran} />
        ))}
    </>
  );
}

/** One check, its mark, its words and what it found under them: the table's, and a report's check its attempts failed. */
export function Check({ c, ran }: { c: GoldenCheck; ran: boolean }) {
  const m = checkMark(c, ran);
  return (
    <span className={`ck${m.status ? ` ${m.status}` : ''}`} data-tip={tipCard(m.tip.title, [{ label: m.tip.label, value: m.tip.value, color: m.tip.color }])}>
      {m.mark ? (
        <b className="cm" role="img" aria-label={m.word}>
          {m.mark}
        </b>
      ) : null}
      <span className="cw">
        {m.text}
        {m.sub ? <small>{glued(m.sub)}</small> : null}
      </span>
    </span>
  );
}
