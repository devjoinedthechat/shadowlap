import { useId, useState } from 'react';
import { plural } from '../format.js';
import { Icon } from './Icon.js';
import { Id } from './Id.js';
import type { Tone } from './Status.js';
import { glossed } from './Term.js';
import { IntervalBar } from './Verdict.js';

/**
 * A gate's attempts in a cell (a fix's probes, verify's runs, a golden's last result): the tally,
 * its bound as the CLI prints it (each kept whole, breaking only after the dot), a 64px bar of the
 * interval on a 0 to 1 scale against the gate's two marks, in the verdict's colour, and its
 * attempts on request, each a run that opens. The words are the server's, from the engine: the
 * cell draws them and works out none of them.
 */
export interface Attempt {
  runId: string;
  href: string;
  /** How it came out: passed, failed, or couldn't be judged. */
  outcome: 'passed' | 'failed' | 'inconclusive';
  /** Where it went, or why it failed: "forked at #6, escalated". */
  note?: string | null;
}

/** An attempt's mark: lime passed, red failed, amber couldn't be judged. */
const MARK: Record<Attempt['outcome'], string> = { passed: '', failed: 'no', inconclusive: 'inc' };

/** Past this many attempts, each is a cell, and only the first that failed get a line. */
const FEW = 6;

/**
 * Each attempt, in the order it ran. A few get a line each (a dot, the run, where it went); more get
 * a cell each, and lines for the first three that failed or couldn't be judged, in the order they
 * ran, with how many more of each. `rescued`, the attempt that is the rescued fork, says so.
 */
export function AttemptList({ attempts, rescued, id }: { attempts: readonly Attempt[]; rescued?: string | null; id?: string }) {
  const line = (a: Attempt) => (
    <span key={a.runId} className="al">
      <i className={MARK[a.outcome]} aria-hidden="true" />
      <Id id={a.runId} href={a.href} />
      <span className="an">
        {a.note ? ` · ${a.note}` : ''}
        {a.runId === rescued ? ' · the rescued fork' : ''}
        <span className="sr"> · {a.outcome}</span>
      </span>
    </span>
  );
  if (attempts.length <= FEW)
    return (
      <div className="alist" id={id}>
        {attempts.map(line)}
      </div>
    );
  // the first three that failed or couldn't be judged, in the order they ran, and how many more of each
  const shown = attempts.filter((a) => a.outcome !== 'passed').slice(0, 3);
  const more = (o: Attempt['outcome']) => attempts.filter((a) => a.outcome === o).length - shown.filter((a) => a.outcome === o).length;
  const said = [more('failed') ? `${more('failed')} more failed` : '', more('inconclusive') ? `${more('inconclusive')} more inconclusive` : '', `${attempts.filter((a) => a.outcome === 'passed').length} passed`];
  return (
    <div className="attemptsx" id={id}>
      <div className="astrip" role="group" aria-label={`${plural(attempts.length, 'attempt')}, each opens its run`}>
        {attempts.map((a, i) => (
          <a
            key={a.runId}
            className={`ac${MARK[a.outcome] ? ` ${MARK[a.outcome]}` : ''}`}
            href={a.href}
            aria-label={`Attempt ${i + 1}, ${a.runId}, ${a.outcome}${a.note ? `, ${a.note}` : ''}`}
            data-tip={JSON.stringify({ t: `attempt ${i + 1} · ${a.runId}`, ...(a.note ? { s: a.note } : {}) })}
          />
        ))}
      </div>
      <div className="alist">
        {shown.map(line)}
        <span className="more2">{[...said, 'each attempt is a cell above'].filter(Boolean).join(' · ')}</span>
      </div>
    </div>
  );
}

const BAR_TONE: Partial<Record<Tone, 'ok' | 'no' | 'y'>> = { ok: 'ok', err: 'no', warn: 'y' };

/**
 * The cell: `tally` ("17 of 18", as the server words it) and `bound` ("rate >= 0.74 (95%)", the
 * first on a page a defined term), the interval against `marks` when a gate decided it, and a
 * toggle that shows the attempts under the tally (`open`, where it starts). A row that draws the
 * attempts elsewhere (a table's row under it) holds the toggle itself: `onToggle`, its `open` then
 * the state, and `listId`, the id of the list it draws.
 */
export function AttemptsCell({
  tally,
  bound,
  interval,
  marks = [],
  tone,
  attempts,
  rescued,
  open: held,
  onToggle,
  listId,
}: {
  tally: string;
  bound?: string | null;
  interval?: { lo: number; hi: number } | null;
  marks?: readonly number[];
  /** The verdict's colour: the bar's. */
  tone: Tone;
  attempts?: readonly Attempt[] | null;
  rescued?: string | null;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  listId?: string;
}) {
  const own = `${useId()}-attempts`;
  // held by the row when it takes the toggle (`onToggle`), its `open` then the state; else its own, `open` where it starts
  const [mine, setMine] = useState(held ?? false);
  const open = onToggle ? (held ?? false) : mine;
  const toggle = onToggle ?? setMine;
  const n = attempts?.length ?? 0;
  const barTone = BAR_TONE[tone];
  const bar = interval && barTone ? <IntervalBar lo={interval.lo} hi={interval.hi} marks={marks} tone={barTone} /> : null;
  return (
    <>
      <span className="acell">
        <span className="nw">
          {tally}
          {bound ? ' ·' : ''}
        </span>
        {bound ? (
          <>
            {' '}
            <span className="nw">{glossed(bound)}</span>
          </>
        ) : null}
        {bar || n ? (
          <>
            {' '}
            <span className="ibx">
              {bar}
              {n ? (
                <button type="button" className="xbtn" aria-expanded={open} aria-controls={!open ? undefined : onToggle ? listId : own} aria-label={`${open ? 'Hide' : 'Show'} ${plural(n, 'attempt')}`} onClick={() => toggle(!open)}>
                  <Icon name="caret" />
                </button>
              ) : null}
            </span>
          </>
        ) : null}
      </span>
      {open && n && !onToggle ? <AttemptList attempts={attempts!} rescued={rescued ?? null} id={own} /> : null}
    </>
  );
}
