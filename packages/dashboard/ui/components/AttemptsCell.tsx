import { Fragment, useId, useState } from 'react';
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
 * What the lines under the cells leave out, as the mock words it ("10 more failed · 63 passed"):
 * one word a state, so an attempt that couldn't be judged is counted as inconclusive, never as failed.
 */
function moreWords(attempts: readonly Attempt[], shown: readonly Attempt[]): string {
  const left = (o: Attempt['outcome']) => attempts.filter((a) => a.outcome === o).length - shown.filter((a) => a.outcome === o).length;
  const failed = left('failed');
  const unsure = left('inconclusive');
  return [failed ? `${failed} more failed` : '', unsure ? `${unsure} more inconclusive` : '', `${left('passed')} passed`, 'each attempt is a cell above'].filter(Boolean).join(' · ');
}

/**
 * Each attempt, in the order it ran. A few get a line each (a dot, the run, where it went), each
 * line's run a link. More get a cell each, a mark too small to be a target of its own (WCAG 2.5.8),
 * so it is a picture with its attempt on hover, and lines for the first three that weren't judged
 * or failed, those not judged first, then how many more of each. `rescued`, the attempt that is the
 * rescued fork, says so.
 */
export function AttemptList({ attempts, rescued, id, carried = 0 }: { attempts: readonly Attempt[]; rescued?: string | null; id?: string; /** Attempts carried over from an earlier session: a hairline in the picture where this one took over. */ carried?: number }) {
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
  // the first three that weren't judged or failed, those not judged first, and how many more of each
  const shown = [...attempts.filter((a) => a.outcome === 'inconclusive'), ...attempts.filter((a) => a.outcome === 'failed')].slice(0, 3);
  const counts = (['passed', 'failed', 'inconclusive'] as const).map((o) => [o, attempts.filter((a) => a.outcome === o).length] as const).filter(([, n]) => n);
  return (
    <div className="attemptsx" id={id}>
      {/* a picture of the attempts in the order they ran: each cell's attempt on hover, its words said once for a screen reader */}
      <div className="astrip" role="img" aria-label={`${plural(attempts.length, 'attempt')} in the order they ran: ${counts.map(([o, n]) => `${n} ${o}`).join(', ')}`}>
        {attempts.map((a, i) => (
          <Fragment key={a.runId}>
            {carried > 0 && i === carried ? <span className="acsep" /> : null}
            <i className={`ac${MARK[a.outcome] ? ` ${MARK[a.outcome]}` : ''}`} data-tip={JSON.stringify({ t: `attempt ${i + 1} · ${a.runId}`, s: [a.outcome, a.note].filter(Boolean).join(' · ') })} />
          </Fragment>
        ))}
      </div>
      <div className="alist">
        {shown.map(line)}
        <span className="more2">{moreWords(attempts, shown)}</span>
      </div>
    </div>
  );
}

const BAR_TONE: Partial<Record<Tone, 'ok' | 'no' | 'y'>> = { ok: 'ok', err: 'no', warn: 'y' };

/**
 * The cell: `tally` ("17 of 18", as the server words it), what it says apart in brackets (`note`, free
 * to wrap) and `bound` ("rate >= 0.74 (95%)", the first on a page a defined term, `boundTitle` how it
 * was worked out, on hover), the interval against `marks` when a gate decided it, and a toggle that
 * shows the attempts under the tally (`open`, where it starts). A row that draws the
 * attempts elsewhere (a table's row under it) holds the toggle itself: `onToggle`, its `open` then
 * the state, and `listId`, the id of the list it draws.
 */
export function AttemptsCell({
  tally,
  note,
  bound,
  boundTitle,
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
  /** What the tally says apart, after it in brackets: verify's "1 cut short by the provider, counted against either verdict". */
  note?: string | null;
  bound?: string | null;
  /** The bound's method, as the CLI's report says it rests on: "the bound: exact under the gate’s stopping rule". */
  boundTitle?: string | undefined;
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
          {bound && !note ? ' ·' : ''}
        </span>
        {/* the note wraps; the dot after it stays with its last word */}
        {note ? ` (${note})${bound ? '\u00a0·' : ''}` : null}
        {bound ? (
          <>
            {' '}
            <span className="nw" title={boundTitle}>
              {glossed(bound)}
            </span>
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
