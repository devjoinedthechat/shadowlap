import { useMemo } from 'react';
import { PageHeader, StepList } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { useLoad } from '../hooks.js';
import { ActivityCard, CacheCard, DailyCard, FixesCard, NeedsLook, OriginCard, Outcomes, TodayCard, WatchLive, WeekGrid } from '../overview/panels.js';
import { isAttempt } from '../runs.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';
import { useTeamStore } from '../teamstore.js';
import { setupSteps } from './Setup.js';

/**
 * The Overview: this week at a glance, worked out on the server in the viewer's time zone. Outcomes
 * lead (failures reproduced, fixes verified, tests passing, what was spent); then every run of the
 * week as a row of calls beside what needs a look and what ran today; where the calls came from,
 * where the prompt cache stopped hitting and how far each failure got towards a fix; and what was
 * spent and not re-spent per day beside the latest activity. Three columns, two below 1180px, one
 * below 760px. It follows the runs as they change, a recording included.
 */

/** The viewer's own time zone: weeks and days are theirs. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function OverviewPage() {
  const { client, meta, runs, live, tick, exported } = useApp();
  const tz = useMemo(viewerTimeZone, []);
  const summary = useLoad(() => (exported ? null : client.summary(tz)), `summary:${tz}`, tick);
  const activity = useLoad(() => (exported ? null : client.activity(5)), 'activity:5', tick);
  const store = useTeamStore();
  const name = projectOf(meta)?.name ?? 'this project';
  const s = summary.data;

  if (!s) {
    // Nothing recorded yet: the steps that make a project replayable, as before the summary loads.
    const none = runs !== null && !runs.some((r) => !isAttempt(r));
    if (none)
      return (
        <Page>
          <PageHeader eyebrow={name} title="No runs yet" text="Record the agent once. Every replay after that is free." />
          <StepList steps={setupSteps(false)} />
        </Page>
      );
    return (
      <Page>
        <PageHeader eyebrow={`${name} · this week`} title="Overview" text="What failed, what got fixed and proven, and what it cost." />
        {summary.error ? <div className="empty tall">The Overview could not be worked out: {summary.error.message}</div> : <div className="empty tall">Working out this week…</div>}
      </Page>
    );
  }
  if (s.counts.runs === 0)
    return (
      <Page>
        <PageHeader eyebrow={name} title="No runs yet" text="Record the agent once. Every replay after that is free." />
        <StepList steps={setupSteps(false)} />
      </Page>
    );

  const recording = s.today.recording[0] ?? null;
  const liveCalls = recording ? (live.find((l) => l.runId === recording.runId)?.calls ?? recording.calls) : 0;
  return (
    <Page>
      <PageHeader eyebrow={`${name} · this week`} title="Overview" text="What failed, what got fixed and proven, and what it cost." actions={recording ? <WatchLive runId={recording.runId} command={recording.command} calls={liveCalls} /> : null} />
      <Outcomes o={s.outcomes} now={s.now} />
      <div className="ovg">
        <WeekGrid grid={s.grid} now={s.now} />
        <div className="ovside">
          <NeedsLook items={s.needsLook.items} total={s.needsLook.total} />
          <TodayCard today={s.today} live={live} />
        </div>
      </div>
      <div className="ovg">
        <OriginCard origins={s.grid.origins} />
        <CacheCard cache={s.cache} />
        <FixesCard fixes={s.fixes} />
      </div>
      <div className="ovg ovlast">
        <DailyCard daily={s.daily} />
        <ActivityCard items={activity.data?.items ?? null} now={s.now} byPerson={!!store} live={live} />
      </div>
    </Page>
  );
}
