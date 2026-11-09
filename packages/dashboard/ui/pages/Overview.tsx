import { useEffect, useMemo, useRef, useState } from 'react';
import type { OverviewSummary } from '../api.js';
import { PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { viewerTimeZone } from '../format.js';
import { useLoad } from '../hooks.js';
import { ErrorState } from '../components/States.js';
import { overviewFacts } from '../overview/model.js';
import { NeedsLook } from '../overview/NeedsLook.js';
import { ActivityCard, RecentRuns, WatchLive } from '../overview/panels.js';
import { Usage } from '../overview/Usage.js';
import { isAttempt } from '../runs.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';
import { useTeamStore } from '../teamstore.js';
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
  const { client, meta, runs, live, tick, exported } = useApp();
  const tz = useMemo(viewerTimeZone, []);
  const [nudge, setNudge] = useState(0);
  const version = `${tick}:${nudge}`;
  const summary = useLoad(() => (exported ? null : client.summary(tz)), `summary:${tz}`, version);
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
    const none = runs !== null && !runs.some((r) => !isAttempt(r));
    if (none) return <NoRunsSteps />;
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
          <div className="empty tall">Working out this week…</div>
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
        factsLabel="Overview in figures"
        actions={recording ? <WatchLive runId={recording.runId} about={recording.about?.text ?? recording.command} calls={liveCalls} /> : null}
      />
      <div className="ovg">
        <NeedsLook items={s.needsLook.items} total={s.needsLook.total} version={version} />
        <div className="ovside">
          <RecentRuns runs={runs} now={s.now} />
          <ActivityCard items={activity.data?.items ?? null} error={activity.error} retry={activity.reload} now={s.now} byPerson={!!store} live={live} />
        </div>
      </div>
      <Usage s={s} />
    </Page>
  );
}
