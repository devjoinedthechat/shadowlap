import { useEffect, useMemo, useRef, useState } from 'react';
import type { OverviewSummary } from '../api.js';
import { PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { viewerTimeZone } from '../format.js';
import { useLoad } from '../hooks.js';
import { ErrorState, Skeleton } from '../components/States.js';
import { overviewFacts } from '../overview/model.js';
import { NeedsLook } from '../overview/NeedsLook.js';
import { ActivityCard, RecentRuns, WatchLive } from '../overview/panels.js';
import { Usage } from '../overview/Usage.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';
import { useTeamStore } from '../teamstore.js';
import { noRunsYet } from '../projects.js';
import { NoRunsSteps } from './no-runs.js';

/**
 * The Overview: this week at a glance, worked out on the server in the viewer's time zone. Its
 * header says the outcomes in four facts (failures reproduced, fixes verified, goldens passing, and
 * what was spent live, last and quieter), each with its makeup and last week on hover. Needs a look
 * leads, widest, beside the newest runs over the activity feed; Usage, folded until asked for, is
 * under both. Needs a look takes the width below 1180px, and one column is left below 760px. It
 * follows the runs as they change, a recording included. While the server is still adding up the
 * runs' totals (a store no dashboard has opened yet), it says how far that has got and asks again
 * every second; once it has shown the Overview, it keeps it until a whole one replaces it.
 */

/** How often the Overview asks again while the runs' totals are being added up. */
export const WARMING_ASK_MS = 1000;

export function OverviewPage() {
  const { client, meta, runs, live, tick, exported, feeds } = useApp();
  const tz = useMemo(viewerTimeZone, []);
  const [nudge, setNudge] = useState(0);
  const version = `${tick}:${nudge}`;
  // It loads again once advice is put away or back (in another tab too), and a fix step's price
  // lasts as long as `version` all the same: a Dismiss asks no step for its price again.
  const summary = useLoad(() => (exported ? null : client.summary(tz)), `summary:${tz}`, `${version}:${feeds.dismissals ?? 0}`);
  const activity = useLoad(() => (exported ? null : client.activity(5)), 'activity:5', tick);
  const store = useTeamStore();
  const name = projectOf(meta)?.name ?? 'this project';
  const answer = summary.data;
  const warming = answer && 'warming' in answer ? answer.warming : null;
  // The last whole Overview: a later answer that is still warming leaves it in place.
  const whole = useRef<OverviewSummary | null>(null);
  if (answer && !warming) whole.current = answer as OverviewSummary;
  useEffect(() => {
    if (!warming) return;
    const t = setTimeout(() => setNudge((n) => n + 1), WARMING_ASK_MS);
    return () => clearTimeout(t);
  }, [warming]);
  const s = whole.current;

  if (!s) {
    // Nothing recorded yet: the steps that make a project replayable, as before the summary loads.
    // Not while that can't be told yet: the Overview waits in its own shape meanwhile.
    if (noRunsYet({ meta, runs }) === true) return <NoRunsSteps />;
    return (
      // Busy while it works the week out; a warming store says how far it has got in a status of its own, read out as it moves.
      <Page busy={!summary.error && !warming}>
        <PageHeader eyebrow={`${name} · this week`} title="Overview" text="What failed, what got fixed and proven, and what it cost." />
        {summary.error ? (
          <ErrorState retry={summary.reload}>The Overview could not be worked out: {summary.error.message}</ErrorState>
        ) : warming ? (
          <div className="empty tall" role="status">
            Adding up what each run did: {warming.done.toLocaleString('en-US')} of {warming.total.toLocaleString('en-US')} runs so far. The Overview shows once they all are; every other page works meanwhile.
          </div>
        ) : (
          <OverviewLoading />
        )}
      </Page>
    );
  }
  if (s.counts.runs === 0)
    return <NoRunsSteps />;

  const recording = s.today.recording[0] ?? null;
  const liveCalls = recording ? (live.find((l) => l.runId === recording.runId)?.calls ?? recording.calls) : 0;
  return (
    <Page>
      <PageHeader
        eyebrow={`${name} · this week`}
        title="Overview"
        text="What failed, what got fixed and proven, and what it cost."
        facts={overviewFacts(s.outcomes, s.fixes, s.now)}
        actions={recording ? <WatchLive runId={recording.runId} about={recording.about?.text ?? recording.command} calls={liveCalls} /> : null}
      />
      <div className="ovg">
        <NeedsLook items={s.needsLook.items} total={s.needsLook.total} version={version} dismissals={s.needsLook.dismissals} />
        <div className="ovside">
          <RecentRuns runs={runs} now={s.now} />
          <ActivityCard items={activity.data?.items ?? null} error={activity.error} retry={activity.reload} now={s.now} byPerson={!!store} live={live} />
        </div>
      </div>
      <Usage s={s} />
    </Page>
  );
}

/** A section's lines while the Overview loads: placeholder words the skeleton draws as quiet bars. */
const SKEL_LINES = ['A failure nobody has looked at yet, and its step', 'A golden that diverged at a call', 'A fix to prove, and its run', 'A run that needs a look'];

/** The header's four facts while the Overview loads, figure then words, as `overviewFacts` gives them. */
const SKEL_FACTS = [
  ['0', 'failures reproduced'],
  ['0', 'fixes verified'],
  ['0 of 0', 'goldens passing'],
  ['$0.00', 'spent live'],
] as const;

/** Needs a look's rows while the Overview loads: a row's title, its line under it, and its step. */
const SKEL_ROWS = [
  ['A run failed its check: refund-in-limit', 'its run, and the call it went wrong at', 'Run blame'],
  ['A golden diverged at a call', 'its test, and what changed', 'Open →'],
  ['A fix to prove before it ships', 'its repair, and the run it came from', 'Verify'],
] as const;

/**
 * The Overview still being worked out, in its final layout as quiet bars under the header: the
 * header's facts, Needs a look's rows in its own markup, and the aside. Its grid is `.ovgs`, never
 * `.ovg`, which the tests read as the Overview drawn.
 */
function OverviewLoading() {
  const part = (title: string, lines: number) => (
    <section className="panel sec">
      <header>
        <h2>{title}</h2>
      </header>
      {SKEL_LINES.slice(0, lines).map((l) => (
        <p key={l}>{l}</p>
      ))}
    </section>
  );
  return (
    <Skeleton what="the Overview">
      <div className="metrics pfacts">
        {SKEL_FACTS.map(([value, words]) => (
          <span key={words} className="metric">
            <b>{value}</b>
            <span>{words}</span>
          </span>
        ))}
      </div>
      <div className="ovgs">
        <section className="panel sec">
          <header>
            <h2>Needs a look</h2>
            <span className="sub">0</span>
          </header>
          <div className="attn">
            <h3 className="agrp">
              Failing<span>0</span>
            </h3>
            {SKEL_ROWS.map(([title, line, step]) => (
              <div key={title} className="arow">
                <span className="ic" />
                <span className="at">
                  <span className="t">{title}</span>
                  <span className="d">{line}</span>
                </span>
                <span className="ast">
                  <span className="btn sm">{step}</span>
                </span>
                <span className="adx" />
              </div>
            ))}
          </div>
        </section>
        <div className="ovside">
          {part('Recent runs', 3)}
          {part('Activity', 2)}
        </div>
      </div>
    </Skeleton>
  );
}
