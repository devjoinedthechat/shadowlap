import { Fragment, useEffect, useMemo, type ReactNode } from 'react';
import type { CompareHead } from '../../src/compare.js';
import { ApiError, type CompareView, type RunDetail, type RunListItem } from '../api.js';
import { ChangesHead } from '../changes/Head.js';
import { forgetComparePair, noteComparePair } from '../changes-tab.js';
import { PageHeader } from '../components/bits.js';
import { CodeBox } from '../components/CodeBox.js';
import { tipCard } from '../components/HoverCard.js';
import { JsonDiffPart } from '../components/JsonDiffPart.js';
import { Page } from '../components/Page.js';
import { Section } from '../components/Section.js';
import { EmptyState, ErrorState, failedRead, Skeleton } from '../components/States.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { answersSub, changedAnswers, changeCards, compareFacts, comparingLive, DIFF_SHOWN, madeCard, oneRunPair, pickable, prefixCells, prefixLine, replayCommand, requestLines } from '../compare/model.js';
import { PairRows } from '../compare/Rows.js';
import { RunPicker } from '../compare/RunPicker.js';
import { PairVerdict, rescuedIn } from '../compare/Verdict.js';
import { callName, num, plural, shortId } from '../format.js';
import { useLoad, type Loaded } from '../hooks.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { defaultComparePair, isAttempt } from '../runs.js';
import { useApp } from '../state.js';
import { Elsewhere } from './held-elsewhere.js';
import { lastRunsHref } from '../runs-view.js';

/**
 * Compare, a tab of Changes: what changed between two runs (code, system prompt, tools, model), then call by call: the
 * identical prefix, what made the fork when no request shows it, the first request that differs,
 * where the paths went from there, and calls where the same request got a different answer. With no
 * runs named it opens the newest fork against its parent (with none, the newest replay that is no
 * test's and has ended; defaultComparePair); with one, that run against its
 * newest fork or replay, else its parent, else it says there is nothing to compare yet. The same run
 * on both sides, or a run not in the store, says so. A run still recording is compared again as its
 * calls arrive. Every state stands under Changes' head, the pickers on a row under its tabs; an
 * exported copy's Compare is a page of its own.
 */
export function ComparePage({ a, b, call }: { a: string | null; b: string | null; /** The row opened, `#/compare/<a>/<b>/<n>`: a row's number after the identical prefix, or none. */ call?: number | null }) {
  const { runs, exported, meta } = useApp();
  const listed = useMemo(() => (runs ?? []).filter((r) => !isAttempt(r)), [runs]);
  // An exported copy of many runs holds only the pairs with its first run: it opens on one of those.
  const pair = a ? null : defaultComparePair(listed, exported ? (meta?.compareWith ?? null) : null);
  const [pairA, pairB] = [pair?.[0], pair?.[1]];
  useEffect(() => {
    if (pairA !== undefined && pairB !== undefined) navigate(href.compare(pairA, pairB), true);
  }, [pairA, pairB]);

  // One run named: it is paired with what it was replayed into, or what it came from.
  if (a && !b) return <OneRun key={a} id={a} />;
  if (runs !== null && listed.length < 2) {
    // With no run at all, a command that needs one isn't offered: record one first.
    const one = listed[0] ?? null;
    const page = (
      <Page>
        <CompareTop />
        <EmptyState title="Compare needs two runs" text={one ? 'Replay or fork the run you have, and compare the two call by call.' : 'Record a run, then replay or fork it, and compare the two call by call.'} command={one ? `shadowlap replay ${shortId(one.runId)}` : undefined}>
          {one ? (
            <div className="actions">
              <a className="btn" href={href.run(one.runId)}>
                Open run
              </a>
            </div>
          ) : null}
        </EmptyState>
      </Page>
    );
    // A pair this project can't hold: another project may.
    return a && b ? <Elsewhere ask={{ what: 'run', ids: [a, b] }} waiting={HEAD_ONLY} fallback={page} /> : page;
  }
  if (!a || !b) return HEAD_ONLY;
  // Not keyed on the pair: another run picked keeps the pickers, and the focus on the one used,
  // while what the comparison reads starts anew for the new pair (useLoad's keys).
  return <Comparison a={a} b={b} runs={listed} call={call ?? null} />;
}

/** Compare's head: Changes', with its tabs, or an exported copy's own; then the pickers, when given, on a row under it. */
function CompareTop({ pickers = null }: { pickers?: ReactNode }) {
  const { exported } = useApp();
  return (
    <>
      {exported ? <PageHeader eyebrow="exported copy" title="Compare" text="Two runs of this copy, call by call." /> : <ChangesHead tab="compare" />}
      {pickers}
    </>
  );
}

/** Calls a row of the comparison's skeleton stands for, as bars the width of a call's name and arguments. */
const SKEL_CALLS = ['lookup_order {"order_id":"4417"}', 'get_policy {"topic":"refunds"}', 'issue_refund {"amount":42}', 'send_email {"to":"customer"}', 'end_turn'];

/**
 * The comparison while it is read, under the pickers (never drawing them): the verdict and a line a
 * run, the identical prefix's strip and line, and both runs' calls from where they part, as quiet
 * bars in their final places. Its classes are its own, since the comparison's are what says it came.
 */
const COMPARISON_LOADING = (
  <Skeleton what="the comparison">
    <div className="cmpsk">
      <VerdictLine
        word="Different endings"
        tone="mu"
        facts={
          <span className="cskends">
            <span>01M5GRYHR0 · issue_refund · answered at #21 · ≈$0.05 spent</span>
            <span>01M5GRVTKS · no write · ended at #20 · ≈$0.05 spent</span>
          </span>
        }
      >
        after #18
      </VerdictLine>
      <div className="cskpre">
        <span className="ms" style={{ gridTemplateColumns: 'repeat(17, minmax(0, 1fr))' }}>
          {Array.from({ length: 17 }, (_, i) => (
            <i key={i} />
          ))}
        </span>
        <span>The first 17 calls are identical; the two part at #18.</span>
      </div>
      <div className="cskrows">
        {SKEL_CALLS.map((call, i) => (
          <div className="cskrow" key={i}>
            <span>#{18 + i}</span>
            <span>{call}</span>
            <span>{call}</span>
          </div>
        ))}
      </div>
    </div>
  </Skeleton>
);

/** What Compare shows under its head while it reads: nothing yet, or the comparison's shape. */
const HEAD_ONLY = (
  <Page>
    <CompareTop />
  </Page>
);
const COMPARING = (
  <Page busy>
    <CompareTop />
    {COMPARISON_LOADING}
  </Page>
);

/**
 * The pair shown, noted for Changes' Compare tab and the sidebar once both runs are in, and
 * forgotten once either read says its run is gone, so the next Compare opens as `#/compare` does. An
 * exported copy has no tabs to note it for.
 */
function useNotePair(ra: Loaded<RunDetail>, rb: Loaded<RunDetail>): void {
  const { exported } = useApp();
  const [a, b] = [ra.data?.run.runId ?? null, rb.data?.run.runId ?? null];
  const gone = notHeld(ra.error) || notHeld(rb.error);
  useEffect(() => {
    if (exported) return;
    if (gone) forgetComparePair();
    else if (a && b && a !== b) noteComparePair(a, b);
  }, [exported, a, b, gone]);
}

/** An id that is the start of several runs' ids, which the server won't pick between (409): it says so, as the CLI does. */
const ambiguous = (err: Error | null | undefined): boolean => !!err && ((err instanceof ApiError && err.status === 409) || /matches several runs/.test(err.message));

/** A run the store doesn't hold: the run page says it so, and so does Compare, naming it. */
const notHeld = (err: Error | null | undefined): boolean => !!err && !ambiguous(err) && ((err instanceof ApiError && err.status === 404) || /no run|not part of it|does not exist/.test(err.message));

/** The same run on both sides: the same id twice, unless it names none (then that is what the page says), or two ids the store reads as one run. */
function bothSame(same: boolean, ra: Loaded<RunDetail>, rb: Loaded<RunDetail>): boolean {
  if (same && !notHeld(ra.error) && !ambiguous(ra.error)) return true;
  return !!ra.data && !!rb.data && ra.data.run.runId === rb.data.run.runId;
}

/** A run's id as a link to its page. */
function RunLink({ id }: { id: string }) {
  return (
    <a className="more rlink" href={href.run(id)}>
      <code>{shortId(id)}</code>
    </a>
  );
}

/**
 * `#/compare/<id>`: the run paired as the design pairs it (its newest fork, else its newest replay,
 * else its parent), the address then naming both; or, with neither, that there is nothing to compare
 * yet and the command that makes something; or that no such run is in the store.
 */
function OneRun({ id }: { id: string }) {
  const { client, live, runs, exported } = useApp();
  const run = useLoad(() => client.run(id), id);
  // A run still recording is no pair yet; an exported copy pairs only the runs it holds.
  const held = useMemo(() => new Set((runs ?? []).map((r) => r.runId)), [runs]);
  const usable = (runId: string) => !live.some((l) => l.runId === runId) && (!exported || held.has(runId));
  const mate = run.data ? oneRunPair(run.data, usable) : null;
  const [mateA, mateB] = [mate?.[0], mate?.[1]];
  useEffect(() => {
    if (mateA !== undefined && mateB !== undefined) navigate(href.compare(mateA, mateB), true);
  }, [mateA, mateB]);
  const where = exported ? 'this copy' : 'this store';
  // A run not in this store: another project may hold it.
  if (notHeld(run.error))
    return <Elsewhere ask={{ what: 'run', ids: [id] }} error={run.error} waiting={COMPARING} retry={run.reload} fallback={<OneRunMissing id={id} error={run.error!} where={where} />} />;
  // A read that failed otherwise: why, and Retry.
  if (run.error && !ambiguous(run.error))
    return (
      <Page>
        <CompareTop />
        <ErrorState retry={run.reload}>{failedRead(run.error)}</ErrorState>
      </Page>
    );
  if (run.error) return <OneRunMissing id={id} error={run.error} where={where} />;
  if (!run.data || mate) return run.data ? HEAD_ONLY : COMPARING;
  const r = run.data;
  return (
    <Page>
      <CompareTop />
      <EmptyState
        title="Nothing to compare yet"
        text={
          <>
            <RunLink id={r.run.runId} /> has no replay or fork, and no parent. Replay it, or fork it at a call, and the two compare call by call.
          </>
        }
        command={replayCommand(r)}
      >
        <div className="actions">
          <a className="btn" href={href.run(r.run.runId)}>
            Open run
          </a>
          <a className="btn" href={href.compare()}>
            Compare other runs
          </a>
        </div>
      </EmptyState>
    </Page>
  );
}

/** `#/compare/<id>` with a run this store can't name: none in it, or several it could be. */
function OneRunMissing({ id, error, where }: { id: string; error: Error; where: string }) {
  return (
    <Page>
      <CompareTop />
      <EmptyState
        title={ambiguous(error) ? 'More than one run' : `Not in ${where}`}
        text={
          ambiguous(error) ? (
            <>
              <code>{id}</code> matches several runs; use more of the id. Pick two runs to compare, or open Runs to find the one you meant.
            </>
          ) : (
            <>
              No run <code>{id}</code> in {where}. Pick two runs to compare, or open Runs to find the one you meant.
            </>
          )
        }
      >
        <div className="actions">
          <a className="btn" href={href.compare()}>
            Compare other runs
          </a>
          <a className="btn" href={lastRunsHref()}>
            Open Runs
          </a>
        </div>
      </EmptyState>
    </Page>
  );
}

function Comparison({ a, b, runs, call }: { a: string; b: string; runs: RunListItem[]; call: number | null }) {
  const { client, live, tick, exported, meta } = useApp();
  // While either run records, each change to the store reads the comparison again; once both have ended, once more.
  const refresh = comparingLive(live, a, b) ? tick : 'ended';
  // The same run named twice compares nothing, and an id with a prefix of it names one run, or no
  // single run: neither is asked for, and the runs' pages say which.
  const [x, y] = [a.toUpperCase(), b.toUpperCase()];
  const same = x === y;
  const nested = !same && (x.startsWith(y) || y.startsWith(x));
  // The server's comparison, with the code card's commits when it can read the project's git (an exported copy has none).
  const cmp = useLoad<CompareView>(() => (same || nested ? null : client.compare(a, b)), `${a}:${b}`, refresh);
  // Meanwhile, the identical prefix and the first request that differs, which come at once: a long
  // pair's whole comparison reads every model call's request of both runs.
  const head = useLoad<CompareHead | null>(() => (same || nested ? null : client.compareHead(a, b).catch(() => null)), `${a}:${b}:head`, refresh);
  const ra = useLoad(() => client.run(a), a, refresh);
  const rb = useLoad(() => client.run(b), b, refresh);
  useNotePair(ra, rb);
  const hub = exported ? (meta?.compareWith ?? null) : null;
  const header = <CompareTop pickers={<Pickers a={a} b={b} runs={runs} hub={hub} />} />;
  if (bothSame(same, ra, rb))
    return (
      <Page>
        {header}
        <EmptyState
          title="The same run on both sides"
          text={
            <>
              <RunLink id={ra.data?.run.runId ?? a} /> against itself is identical. Pick another run for A or B.
            </>
          }
        />
      </Page>
    );
  // A run the store doesn't hold is named, and so is an id that starts several runs' ids, with the side to pick again.
  const where = exported ? 'this copy' : 'this store';
  const missing = [notHeld(ra.error) ? { id: a, side: 'A' } : null, !same && notHeld(rb.error) ? { id: b, side: 'B' } : null].filter((m) => m !== null);
  const several = [ambiguous(ra.error) ? { id: a, side: 'A' } : null, !same && ambiguous(rb.error) ? { id: b, side: 'B' } : null].filter((m) => m !== null);
  const sides = same && (missing.length || several.length) ? ['A', 'B'] : [...missing, ...several].map((m) => m.side);
  if (sides.length) {
    const page = <PairMissing header={header} missing={missing} several={several} sides={sides} where={where} />;
    // A side not in this store: another project may hold it, though never one that starts several runs' ids here.
    const retry = () => [cmp, head, ra, rb].forEach((l) => l.reload());
    const waiting = (
      <Page busy>
        {header}
        {COMPARISON_LOADING}
      </Page>
    );
    return missing.length ? <Elsewhere ask={{ what: 'run', ids: missing.map((m) => m.id) }} error={ra.error ?? rb.error} waiting={waiting} retry={retry} fallback={page} /> : page;
  }
  const c = cmp.data;
  return (
    // Busy while the comparison's shape stands in for it: nothing of it has come, nor has its read failed.
    <Page busy={!c && !head.data && !cmp.error}>
      {header}
      <ComparisonBody c={c} failed={cmp.error} retry={cmp.reload} head={head.data} hub={hub} ra={ra.data} rb={rb.data} a={a} b={b} runs={runs} call={call} />
    </Page>
  );
}

/**
 * What the comparison shows under the pickers: the whole of it; while a long pair's rest is worked
 * out, its head first; while nothing has come, its shape; or why it couldn't be compared, with Retry
 * (`retry`), an exported copy naming the run it pairs with.
 */
function ComparisonBody({ c, failed, retry, head, hub, ra, rb, a, b, runs, call }: { c: CompareView | null; failed: Error | null; retry: () => void; head: CompareHead | null; hub: string | null; ra: RunDetail | null; rb: RunDetail | null; a: string; b: string; runs: RunListItem[]; call: number | null }) {
  // The rest of a long pair that couldn't be worked out (a 503: it ran past the time a request is
  // given): what came first stays, and the terminal, which has no such limit, works out the rest.
  const stopped = failed && !hub && head ? { why: failed.message, command: `shadowlap diff ${shortId(ra?.run.runId ?? a)} ${shortId(rb?.run.runId ?? b)}` } : null;
  return (
    <>
      {failed && hub ? (
        <div className="empty">{`This copy compares each run with ${shortId(hub)} only: pick it on one side.`}</div>
      ) : failed && !stopped ? (
        <ErrorState retry={retry}>{failedRead(failed)}</ErrorState>
      ) : null}
      {c ? (
        <Compared c={c} a={a} b={b} ra={ra} rb={rb} runs={runs} call={call} />
      ) : head && (!failed || stopped) ? (
        <HeadFirst h={head} stopped={stopped} />
      ) : failed ? null : (
        COMPARISON_LOADING
      )}
    </>
  );
}

/** A pair with a side this store can't name: a run it doesn't hold, or an id that starts several runs' ids, with the side to pick again. */
function PairMissing({ header, missing, several, sides, where }: { header: ReactNode; missing: Side[]; several: Side[]; sides: string[]; where: string }) {
  const ids = (list: readonly Side[]) =>
    list.map((m, i) => (
      <Fragment key={m.side}>
        {i ? (list === missing ? ' or ' : ' and ') : null}
        <code>{m.id}</code>
      </Fragment>
    ));
  return (
    <Page>
      {header}
      <EmptyState
        title={missing.length ? `Not in ${where}` : 'More than one run'}
        text={
          <>
            {missing.length ? (
              <>
                No run {ids(missing)} in {where}
                {several.length ? '; ' : '. '}
              </>
            ) : null}
            {several.length ? (
              <>
                {ids(several)} {several.length === 2 ? 'each match' : 'matches'} several runs; use more of the id, or{' '}
              </>
            ) : null}
            {several.length ? 'pick' : 'Pick'} another run for {sides.length === 2 ? 'A and for B' : sides[0]}.
          </>
        }
      />
    </Page>
  );
}

/** A side of the pair, by its letter, and the id the address gives it. */
type Side = { id: string; side: string };

function Pickers({ a, b, runs, hub }: { a: string; b: string; runs: RunListItem[]; hub: string | null }) {
  // Each side a run picker: the run's id, its about line fitted beside it, and the runs it can be compared with.
  const pick = (value: string, other: string, onChange: (v: string) => void, label: string) => {
    const options = pickable(runs, other, hub);
    const full = runs.find((x) => x.runId === value || x.runId.startsWith(value)) ?? null;
    const listed = full && !options.includes(full) ? [full, ...options] : options;
    return <RunPicker label={label} value={value} runs={listed} onPick={onChange} />;
  };
  return (
    <div className="pickers chpick">
      {pick(a, b, (v) => navigate(href.compare(v, b)), 'Run A')}
      <span className="arrow" aria-hidden="true">
        →
      </span>
      {pick(b, a, (v) => navigate(href.compare(a, v)), 'Run B')}
      <a className="btn" href={href.compare(b, a)} title="Compare the other way round">
        Swap
      </a>
    </div>
  );
}

/**
 * The whole comparison, once the server has it: the verdict and a line a run, what changed and what
 * didn't, the identical prefix and where the two part, the request that differs first, both paths in
 * one list from there, and the calls where the same request got a different answer.
 */
function Compared({ c, a, b, ra, rb, runs, call }: { c: CompareView; a: string; b: string; ra: RunDetail | null; rb: RunDetail | null; runs: RunListItem[]; call: number | null }) {
  const pair = c.pair ?? null;
  const sides = { a: { id: c.a.runId, run: ra, rescued: !!ra && rescuedIn(ra, rb) }, b: { id: c.b.runId, run: rb, rescued: !!rb && rescuedIn(rb, ra) } };
  const recording = ra?.run.status === 'running' || rb?.run.status === 'running';
  return (
    <>
      {pair && sides.a.run && sides.b.run ? <PairVerdict pair={pair} a={{ ...sides.a, run: sides.a.run }} b={{ ...sides.b, run: sides.b.run }} /> : null}
      <WhatChanged c={c} />
      <Prefix c={c} />
      {c.firstRequestDifference ? <ChangedRequest c={c} /> : null}
      {pair?.rows.length ? <PairRows a={sides.a} b={sides.b} at={{ a, b }} pair={pair} call={call} runs={runs} flag={c.intervention?.kind === 'fail' ? c.intervention.flag : null} /> : null}
      {pair?.more ? <p className="cmpmore">… {num(pair.more)} more calls</p> : null}
      {pair && recording ? <p className="cmpmore">recording · more calls as they arrive</p> : null}
      <ResponseDifferences c={c} />
    </>
  );
}

/** What changed between the two, a line a changed fact, and what didn't on one quiet line, its card naming each. */
function WhatChanged({ c }: { c: CompareView }) {
  const facts = compareFacts(changeCards(c));
  if (!facts.changed.length && !facts.same) return null;
  return (
    <div className="cmpfacts">
      {facts.changed.map((f) => (
        <p key={f.key} className="cmpch" title={f.tip ?? undefined}>
          <b>{f.lead}</b>
          {f.code ? (
            <>
              {' '}
              <code>{f.code}</code>
            </>
          ) : null}
          {f.note ? <span className="muted"> · {f.note}</span> : null}
        </p>
      ))}
      {facts.same ? (
        <p className="cmpsame" data-tip={tipCard('The same on both sides', facts.sameRows.map((r) => ({ label: r.key, value: r.value })))}>
          {facts.same}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What a comparison shows while the rest of it is worked out: the identical prefix and the first
 * request that differs, then what is still to come, said as it is under way.
 */
function HeadFirst({ h, stopped = null }: { h: CompareHead; stopped?: { why: string; command: string } | null }) {
  const rest = [
    'what changed between the two runs',
    ...(h.answersDiffer ? [`what ${plural(h.answersDiffer, 'call')} with the same request got instead`] : []),
    ...(h.firstRequestDifference ? [`where each went from #${h.firstRequestDifference.callNo}`] : []),
  ];
  const listed = rest.length > 1 ? `${rest.slice(0, -1).join(', ')} and ${rest.at(-1)!}` : rest[0]!;
  return (
    <>
      <Prefix c={{ ...h, responseDifferences: [], intervention: null }} />
      {h.firstRequestDifference ? <ChangedRequest c={h} /> : null}
      {stopped ? (
        <div className="cmpwait" role="status">
          <p>
            The rest, {listed}, could not be worked out here: {stopped.why}. What shows above is whole. A terminal compares the two runs with no time limit:
          </p>
          <CodeBox command={stopped.command} />
        </div>
      ) : (
        <p className="cmpwait" role="status">
          Comparing the rest: {listed}…
        </p>
      )}
    </>
  );
}

/**
 * The identical prefix as a quiet strip, a cell a call (at most 60), beside its sentence: how far the
 * two agree and where they part, what made the fork carrying the flag that made it on its card.
 */
function Prefix({ c }: { c: Parameters<typeof prefixLine>[0] }) {
  const n = c.identicalPrefix;
  const cells = prefixCells(n);
  const line = prefixLine(c);
  const iv = c.intervention ?? null;
  const card = line.made && iv ? madeCard(iv) : null;
  return (
    <div className="prefix">
      {/* Nothing identical: no strip, so the line has the row to itself. */}
      {n ? (
        <span className="ms" style={{ gridTemplateColumns: `repeat(${cells}, minmax(0, 1fr))` }} aria-hidden="true">
          {Array.from({ length: cells }, (_, i) => (
            <i key={i} className="rep" />
          ))}
        </span>
      ) : null}
      <span>
        <b>{line.lead}</b>{' '}
        {line.made && card ? (
          <>
            <span className="lead" data-tip={tipCard(card.title, [], card.line, card.command)}>
              {line.made}
            </span>
            {line.rest.slice(line.made.length)}
          </>
        ) : (
          line.rest
        )}
      </span>
    </div>
  );
}

/**
 * The first request that differs, under the strip: one structural diff, unified, a line naming each
 * differing field (at most 12) and its two values walked under it, each head's id opening its run at
 * that call; then how many fields differ, or that the stored requests are equal, and the engine's hints.
 */
function ChangedRequest({ c }: { c: Pick<CompareView, 'a' | 'b' | 'firstRequestDifference'> }) {
  const f = c.firstRequestDifference!;
  const diff = f.diff ?? [];
  const count = diff.length > 1 ? `${diff.length} fields differ${diff.length > DIFF_SHOWN ? `; the first ${DIFF_SHOWN} are shown` : ''}.` : null;
  const hints = f.hints ?? [];
  const lines = useMemo(() => requestLines(f.diff ?? []), [f.diff]);
  const head = (sign: '−' | '+', id: string) => (
    <h2>
      <span className={`js ${sign === '+' ? 'add' : 'del'}`} aria-hidden="true">
        {sign}
      </span>
      #{f.callNo} in{' '}
      <a href={href.run(id, f.callNo)}>
        <code className="rnm">{shortId(id)}</code>
      </a>
    </h2>
  );
  return (
    <section className="diffpanel jdp cmpdiff">
      <div className="jdh">
        {head('−', c.a.runId)}
        {head('+', c.b.runId)}
      </div>
      {diff.length ? <JsonDiffPart lines={lines} /> : <p className="cmpfn">{`${f.kind} ${callName(f.kind, f.name)}`}</p>}
      {!diff.length || count || hints.length ? (
        <div className="hint">
          {!diff.length ? (
            'The stored requests are equal; they differ in what matching also reads: the headers that change model behaviour, or values normalizers treat differently.'
          ) : count ? (
            <span title="Hover a name for its path in this call’s request: an index counts entries inside it (messages, tools), not calls in the run.">{count}</span>
          ) : null}
          {hints.map((h, i) => (
            <span key={i} className="hline">
              {h.message}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ResponseDifferences({ c }: { c: CompareView }) {
  const first = c.firstRequestDifference?.callNo;
  // A call the model answered the same way in a new response is in the prefix line, not here.
  const rows = changedAnswers(c);
  if (!rows.length)
    return <p className="cmpnote">Same request, different response: none.{first ? ` The paths differ because the request at #${first} did.` : ''}</p>;
  return (
    <Section className="cmpresp" title="Same request, different answer" sub={answersSub(c)}>
      <div className="tscroll">
        <table className="t">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Call</th>
              <th>What changed</th>
              <th className="num">Open in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.callNo} className="static">
                <td className="num">{r.callNo}</td>
                <td>{callName(r.kind, r.name)}</td>
                <td className="wrapcell">
                  {r.detail}
                  {/* The call a replay's flag answered: what it got instead, and the flag. */}
                  {r.by ? (
                    <>
                      {' · '}
                      <code>{r.by}</code>
                    </>
                  ) : null}
                </td>
                <td className="num">
                  {/* Each run by its whole id: never a few characters of it. */}
                  <a href={href.run(c.a.runId, r.callNo)} title={`Open ${shortId(c.a.runId)} at #${r.callNo}`}>
                    <code className="rnm">{shortId(c.a.runId)}</code>
                  </a>{' '}
                  ·{' '}
                  <a href={href.run(c.b.runId, r.callNo)} title={`Open ${shortId(c.b.runId)} at #${r.callNo}`}>
                    <code className="rnm">{shortId(c.b.runId)}</code>
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
