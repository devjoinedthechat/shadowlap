import { useMemo } from 'react';
import type { RunListItem } from '../api.js';
import { DeltaPill, Kpi, Legend, PageHeader, StepList } from '../components/bits.js';
import { tipCard } from '../components/HoverCard.js';
import { Page } from '../components/Page.js';
import { EventIcon, RunIcon } from '../components/RunIcon.js';
import { GridStrip } from '../components/Strip.js';
import { cents, num, plural, shortId, whenShort } from '../format.js';
import { ORIGIN_COLOR, ORIGIN_NAME, countOrigins, emptyCounts, presentOrigins, type OriginCounts } from '../origins.js';
import { href } from '../route.js';
import { isAttempt, isFailed, isLive, kindWord, runOrigins, runTree, runType, sideLine } from '../runs.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';
import { GRID_MIN } from '../strip.js';
import { setupSteps } from './Setup.js';

/**
 * The Overview, for now from what the run list holds: this week's outcomes, every run this week as a
 * row of calls, and what ran today. A later version reads a summary endpoint for the numbers a list
 * of the newest runs cannot give (last week's, past 500 runs).
 */

const DAY = 86_400_000;

export function OverviewPage() {
  const { meta, runs, live } = useApp();
  const name = projectOf(meta)?.name ?? 'this project';
  const listed = useMemo(() => (runs ?? []).filter((r) => !isAttempt(r)), [runs]);
  const recording = listed.find(isLive) ?? null;
  const liveCalls = recording ? (live.find((l) => l.runId === recording.runId)?.calls ?? recording.calls) : 0;

  if (runs === null) return <Page>{null}</Page>;
  if (!listed.length)
    return (
      <Page>
        <PageHeader eyebrow={name} title="No runs yet" text="Record the agent once. Every replay after that is free." />
        <StepList steps={setupSteps(false)} />
      </Page>
    );
  return (
    <Page>
      <PageHeader
        eyebrow={`${name} · this week`}
        title="Overview"
        text="What failed, what got replayed and forked, and what it cost."
        actions={
          recording ? (
            <a className="livebtn" href={href.run(recording.runId)} title={`Recording ${shortId(recording.runId)} · ${recording.command}`}>
              <span className="pulse" aria-hidden="true" />
              <span className="lt">Watch live</span>
              <span className="lc">{plural(liveCalls, 'call')}</span>
            </a>
          ) : null
        }
      />
      <Outcomes runs={listed} />
      <div className="ovg">
        <WeekGrid runs={listed} />
        <div className="ovside">
          <Today runs={listed} />
        </div>
      </div>
    </Page>
  );
}

function Outcomes({ runs }: { runs: RunListItem[] }) {
  const now = Date.now();
  const week = runs.filter((r) => r.startedAt >= now - 7 * DAY);
  // Last week only when the list reaches back past it: the server sends the newest 500 runs.
  const reaches = runs.length < 500 || runs.some((r) => r.startedAt < now - 14 * DAY);
  const last = reaches ? runs.filter((r) => r.startedAt >= now - 14 * DAY && r.startedAt < now - 7 * DAY) : null;
  const count = (list: RunListItem[], f: (r: RunListItem) => boolean) => list.filter(f).length;
  const failed = count(week, isFailed);
  const blamed = count(week, (r) => !!r.blame?.callNo);
  const forks = count(week, (r) => runType(r) === 'fork');
  const recordings = new Set(week.filter((r) => runType(r) === 'fork').map((r) => r.parentRunId)).size;
  const clean = count(week, (r) => runType(r) === 'clean');
  const spent = week.reduce((s, r) => s + r.spent, 0);
  const saved = week.reduce((s, r) => s + r.saved, 0);
  return (
    <div className="panel kstrip">
      <Kpi
        k="Failed runs"
        value={num(failed)}
        tone={failed ? 'err' : ''}
        pill={last ? <DeltaPill now={failed} then={count(last, isFailed)} good="down" /> : null}
        note={failed ? (blamed ? `${blamed} blamed · ${failed - blamed} not yet` : 'none blamed yet') : 'nothing failed this week'}
        href={href.runs()}
      />
      <Kpi k="Forks" value={num(forks)} pill={last ? <DeltaPill now={forks} then={count(last, (r) => runType(r) === 'fork')} /> : null} note={forks ? `from ${plural(recordings, 'recording')}` : 'none this week'} href={href.runs()} />
      <Kpi k="Clean replays" value={num(clean)} tone={clean ? 'lime' : ''} pill={last ? <DeltaPill now={clean} then={count(last, (r) => runType(r) === 'clean')} good="up" /> : null} note="every call matched the recording" href={href.runs()} />
      <Kpi k="Spent live" value={cents(spent)} pill={last ? <DeltaPill now={spent} then={last.reduce((s, r) => s + r.spent, 0)} format={cents} good="down" /> : null} note={`${cents(saved)} not re-spent`} />
    </div>
  );
}

function WeekGrid({ runs }: { runs: RunListItem[] }) {
  const now = Date.now();
  const week = useMemo(() => runs.filter((r) => r.startedAt >= now - 7 * DAY), [runs, now]);
  // Each recording with its replays and forks under it; the newest families, then All runs.
  const families = useMemo(() => {
    const out: Array<Array<{ run: RunListItem; depth: number }>> = [];
    for (const row of runTree(week)) {
      if (row.depth === 0) out.push([row]);
      else out[out.length - 1]?.push(row);
    }
    return out.slice(0, 12);
  }, [week]);
  const totals = useMemo(() => {
    const c: OriginCounts = emptyCounts();
    let calls = 0;
    for (const r of week) {
      calls += r.calls;
      const o = runOrigins(r);
      if (o) {
        const n = countOrigins(o);
        for (const k of Object.keys(n) as Array<keyof OriginCounts>) c[k] += n[k];
      }
    }
    return { calls, counts: c };
  }, [week]);
  const withOrigins = week.some((r) => runOrigins(r));
  return (
    <section className="panel ovgrid">
      <header>
        <h2>This week’s runs</h2>
        <span className="sub">{withOrigins ? 'every call, by what happened to it' : 'newest first'}</span>
        <span className="sp" />
        <a className="more" href={href.runs()}>
          All runs
        </a>
      </header>
      <div className="pbody">
        <div className="gtop">
          <div className="ovbig">
            <b>{num(totals.calls)}</b>
            <span>calls in {plural(week.length, 'run')}</span>
          </div>
          {withOrigins ? <Legend origins={presentOrigins(totals.counts)} /> : null}
        </div>
        {week.length === 0 ? <div className="empty">No runs this week. The newest are on Runs.</div> : null}
        {families.map((rows) => {
          const scale = Math.max(GRID_MIN, ...rows.map((x) => x.run.calls));
          return (
            <div className="gfam" key={rows[0]!.run.runId}>
              {rows.map(({ run: r, depth }) => {
                const origins = runOrigins(r);
                const counts = origins ? countOrigins(origins) : null;
                const tip = tipCard(
                  `${shortId(r.runId)} · ${kindWord(r)}`,
                  counts ? presentOrigins(counts).map((o) => ({ label: ORIGIN_NAME[o], value: num(counts[o]), color: ORIGIN_COLOR[o] })) : [{ label: 'calls', value: num(r.calls) }],
                );
                return (
                  <a key={r.runId} className="grow" href={href.run(r.runId)} data-tip={tip}>
                    <span className="gid" style={{ paddingLeft: depth * 14 }}>
                      <RunIcon run={r} />
                      <code>{shortId(r.runId)}</code>
                    </span>
                    {origins ? <GridStrip origins={origins} scale={scale} forkAt={r.divergence?.callNo ?? null} live={isLive(r)} /> : <Line run={r} />}
                    <span className="gw">{whenShort(r.startedAt, now)}</span>
                  </a>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Line({ run }: { run: RunListItem }) {
  const l = sideLine(run);
  return (
    <span className="gline">
      {l.err ? <em>{l.err}</em> : null}
      {l.text}
    </span>
  );
}

function Today({ runs }: { runs: RunListItem[] }) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = runs.filter((r) => r.startedAt >= start.getTime());
  const of = (t: string) => today.filter((r) => runType(r) === t);
  const replayed = today.reduce((s, r) => s + (runOrigins(r)?.filter((o) => o === 'rep').length ?? 0), 0);
  const saved = today.reduce((s, r) => s + r.saved, 0);
  const live = runs.filter(isLive);
  const forks = of('fork');
  const clean = of('clean');
  const tests = of('test');
  const failed = today.filter(isFailed);
  return (
    <section className="panel ovtoday">
      <header>
        <h2>Today</h2>
        <span className="sub">{start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
      </header>
      <div className="pbody">
        <div className="ovbig">
          <b>{num(today.length)}</b>
          <span>
            {today.length === 1 ? 'run' : 'runs'} today{replayed ? ` · ${num(replayed)} calls served from recordings` : ''} · <em>{cents(saved)}</em> not re-spent
          </span>
        </div>
      </div>
      <div className="attn">
        {live.map((r) => (
          <a key={r.runId} href={href.run(r.runId)}>
            <EventIcon kind="live" live />
            <span>
              <span className="t">
                Recording <code>{shortId(r.runId)}</code>
              </span>
              <span className="d">{r.command}</span>
            </span>
            <span className="go">
              <span className="now">{plural(r.calls, 'call')}…</span>
            </span>
          </a>
        ))}
        <a href={href.runs()}>
          <EventIcon kind="clean" />
          <span>
            <span className="t">Replays</span>
            <span className="d">{clean.length ? 'every call matched the recording' : 'none yet today'}</span>
          </span>
          <span className="go">{clean.length} today</span>
        </a>
        <a href={href.runs()}>
          <EventIcon kind="fork" />
          <span>
            <span className="t">Forks</span>
            <span className="d">{forks.length ? `${plural(forks.reduce((s, r) => s + r.calls, 0), 'call')} in ${plural(forks.length, 'fork')}` : 'none yet today'}</span>
          </span>
          <span className="go">{forks.length} today</span>
        </a>
        {tests.length ? (
          <a href={href.tests()}>
            <EventIcon kind={tests.some(isFailed) ? 'fail' : 'test'} />
            <span>
              <span className="t">Tests</span>
              <span className="d">{tests.some(isFailed) ? `${tests.filter(isFailed).length} failed` : 'all clean'}</span>
            </span>
            <span className="go">{tests.length} today</span>
          </a>
        ) : null}
        {failed.length ? (
          <a href={href.runs()}>
            <EventIcon kind="fail" />
            <span>
              <span className="t">Failed</span>
              <span className="d">{failed.map((r) => shortId(r.runId)).slice(0, 3).join(', ')}</span>
            </span>
            <span className="go">{failed.length} today</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
