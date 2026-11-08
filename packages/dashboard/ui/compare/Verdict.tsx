import { Fragment, type ReactNode } from 'react';
import type { RunDetail } from '../api.js';
import { Status } from '../components/Status.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { ORIGIN_NAME } from '../origins.js';
import { rescuedAt } from '../run/model.js';
import { runFact, runSpentWords, useJudgedAt } from '../run/parts.js';
import { presetAttempt } from '../run/preset.js';
import { useApp } from '../state.js';
import { endingParts, type EndingPart } from './model.js';
import type { Pair } from './paths.js';

/** Each side's run as Compare read it, and whether blame rescued it with a fork (its eyebrow says `fork @7` then). */
export interface PairRun {
  id: string;
  run: RunDetail | null;
  rescued: boolean;
}

/** Whether blame rescued a run with this fork, as its page says it (rescuedAt): the other side's blame counts where it is the run's parent. */
export function rescuedIn(run: RunDetail, other: RunDetail | null): boolean {
  return rescuedAt(run, other && run.parent?.runId === other.run.runId ? other : null, null) !== null;
}

/**
 * The verdict first, right under the pickers: what differs most between the two from where they
 * part (`Different writes after #18`, `Different endings from #1`), in its colour, then a line a run:
 * its HTTP failures, its writes by what became of them, how its turn ended, its checks' verdict and
 * what it spent. While a side records there is no verdict yet: the lines alone, its end `still running`.
 */
export function PairVerdict({ pair, a, b }: { pair: Pair; a: PairRun & { run: RunDetail }; b: PairRun & { run: RunDetail } }) {
  const lines = (
    <span className="cmpends">
      <RunLine side={a} parts={endingParts(pair.endings.a)} />
      <RunLine side={b} parts={endingParts(pair.endings.b)} />
    </span>
  );
  const v = pair.verdict;
  if (!v) return pair.endings.a.end.kind === 'running' || pair.endings.b.end.kind === 'running' ? <p className="cmpv cmplive">{lines}</p> : null;
  return (
    <VerdictLine word={v.words} tone={v.tone} className="cmpv" facts={lines}>
      {v.where}
    </VerdictLine>
  );
}

/**
 * A writes part: each tool as code with how many times, kept whole, those a replay fenced with their
 * origin's word in its colour after the last; `and` stays with the last, so a list wider than the
 * line breaks between its writes.
 */
function writesPart(p: Extract<EndingPart, { kind: 'writes' }>): ReactNode {
  const last = p.tools.length - 1;
  const origin = p.fate === 'blocked' ? 'block' : 'stub';
  return p.tools.map((t, i) => (
    <Fragment key={t.tool}>
      {i ? (i === last ? ' and\u00a0' : ', ') : null}
      <span className="nw">
        <code>{t.tool}</code>
        {t.times ? ` ${t.times}` : null}
        {p.fate && i === last ? (
          <>
            {' '}
            <span className={`org ${origin}`}>{ORIGIN_NAME[origin]}</span>
          </>
        ) : null}
      </span>
    </Fragment>
  ));
}

/** A part of the line a run as it is drawn: its writes, or its words with the status it names kept on one line. */
function partOf(p: EndingPart): ReactNode {
  if (p.kind === 'writes') return writesPart(p);
  if (p.kind === 'failures')
    return (
      <>
        <span className="nw">{p.http}</span> {p.words}
      </>
    );
  return p.http ? (
    <>
      {p.words} <span className="nw">{p.http}</span>
    </>
  ) : (
    p.words
  );
}

/** One run's line: its id, then each part kept whole, joined by ` ·`, its checks as a status in their tone and what it spent last. */
function RunLine({ side, parts }: { side: PairRun & { run: RunDetail }; parts: EndingPart[] }) {
  const checks = useChecks(side.run, side.rescued);
  const spent = runSpentWords(side.run);
  const drawn: ReactNode[] = [...parts.map(partOf), ...(checks ? [checks] : []), `${spent.value} ${spent.label}`];
  return (
    <>
      <code className="rnm">{shortId(side.id)}</code>
      <span>
        {drawn.map((p, i) => (
          <Fragment key={i}>
            {i ? ' ' : null}
            <span className="cmpp">
              {p}
              {i < drawn.length - 1 ? ' ·' : null}
            </span>
          </Fragment>
        ))}
      </span>
    </>
  );
}

/**
 * Its checks' verdict as the run's header works it out, a status in its tone (`check failed at #18`):
 * an error-path preset's from the presets of the session that decided it. None for `no checks`, a
 * run still recording, and a long run its analysis hasn't judged yet.
 */
function useChecks(run: RunDetail, rescued: boolean): ReactNode {
  const { client } = useApp();
  const live = run.run.status === 'running';
  const runId = run.run.runId;
  const presets = useLoad(() => (run.run.meta?.chaos && !live ? client.runChaos(runId) : null), `${runId}:presets`).data ?? null;
  const { judged } = useJudgedAt(run);
  if (live || judged === undefined) return null;
  const fact = runFact(run, judged, { preset: presetAttempt(presets, runId), rescued });
  if (fact.words === 'no checks') return null;
  return <Status tone={fact.tone}>{fact.callNo !== null ? `${fact.words} #${fact.callNo}` : fact.words}</Status>;
}
