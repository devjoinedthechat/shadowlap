import { memo, useMemo, useRef } from 'react';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { tipCard } from '../components/HoverCard.js';
import { Id } from '../components/Id.js';
import { EventIcon, RunIcon } from '../components/RunIcon.js';
import { Section } from '../components/Section.js';
import { EmptyLine, ErrorState } from '../components/States.js';
import { MiniStrip } from '../components/Strip.js';
import { ruleTip } from '../components/Verdict.js';
import { clock, num, plural, shortId, whenShort } from '../format.js';
import { ORIGIN_NAME } from '../origins.js';
import { useListKeys } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { runRowScope } from '../run-row.js';
import { isAttempt, kindWord, runOrigins, sideStatus } from '../runs.js';
import { SideStatus } from '../shell/Sidebar.js';
import { useApp } from '../state.js';
import type { ActivityItem, LiveRun, RunListItem } from '../types.js';
import { activityGlyph, activityKeep, activityLine, callsSaid, keepPieces, personName, recentKind, SHOW_ORIGINS } from './model.js';
import { DotPieces, useAbouts } from './words.js';

/**
 * The Overview's aside, as the mock draws it: the newest runs over the activity feed, and Watch live
 * in the header. Needs a look is NeedsLook.tsx and Usage, under them, Usage.tsx. Each takes its part
 * of the server's summary.
 */

/** Watch live, with a call count that goes up as calls arrive; its hover names the recording by what it is about. */
export function WatchLive({ runId, about, calls }: { runId: string; about: string; calls: number }) {
  return (
    <a className="btn livebtn" href={href.run(runId)} title={`Recording ${shortId(runId)} · ${about}`}>
      <span className="pulse" aria-hidden="true" />
      <span className="lt">Watch live</span>
      <span className="lc">{plural(calls, 'call')}</span>
    </a>
  );
}

// ---------------------------------------------------------------------------------------------- recent runs

/** How many of the newest runs the Overview lists: the sidebar holds their tree and Runs every run. */
export const RECENT_SHOWN = 8;

/** A run's calls by origin, for its hover: each origin it has, in the Overview's order, in its colour. */
function originTip(origins: readonly string[]) {
  const counts = new Map<string, number>();
  for (const o of origins) counts.set(o, (counts.get(o) ?? 0) + 1);
  return SHOW_ORIGINS.filter((o) => counts.get(o)).map((o) => ({ label: ORIGIN_NAME[o], value: num(counts.get(o)!), color: `var(--o-${o})` }));
}

const RecentRow = memo(function RecentRow({ r, now, focused }: { r: RunListItem; now: number; focused: boolean }) {
  const origins = runOrigins(r) ?? [];
  const st = sideStatus(r);
  const id = shortId(r.runId);
  return (
    <a className={`rrow${focused ? ' krow' : ''}`} href={href.run(r.runId)} data-rowkey={href.run(r.runId)} data-tip={tipCard(`${id} · ${recentKind(kindWord(r), r.rescues)}`, originTip(origins), r.about?.text ?? null)}>
      <RunIcon run={r} />
      <span className="rr1">
        <Id id={id} list />
        {origins.length ? <MiniStrip origins={origins} said={callsSaid(origins)} /> : <span className="ms" />}
        <span className="rw">{whenShort(r.startedAt, now)}</span>
      </span>
      <span className="rr2">
        <AboutLine about={r.about} className="rab" />
        {st ? (
          <span className="r2s">
            <SideStatus st={st} />
          </span>
        ) : null}
      </span>
    </a>
  );
});

/** The eight newest runs, one being recorded first, a row each as every run list has them: its id, its calls by origin and when, then its about line and what needs a look. */
export function RecentRuns({ runs, now }: { runs: readonly RunListItem[] | null; now: number }) {
  const { exported, toast } = useApp();
  const box = useRef<HTMLDivElement>(null);
  useFitAbouts(box);
  const list = useMemo(
    () =>
      (runs ?? [])
        .filter((r) => !isAttempt(r))
        .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
        .slice(0, RECENT_SHOWN),
    [runs],
  );
  // j and k walk the runs after Needs a look's rows; ⌘K offers a run's own actions, as every run list does.
  const inFocus = useListKeys({ rows: list, keyOf: (r) => href.run(r.runId), root: box, open: (r) => navigate(href.run(r.runId)), actions: (r) => (exported ? null : runRowScope(r, { runs: runs ?? [], toast })) });
  return (
    <Section
      title="Recent runs"
      sub="calls by origin"
      className="ovruns"
      actions={
        <a className="more" href={href.runs()}>
          All runs →
        </a>
      }
    >
      {runs && !list.length ? <EmptyLine>No runs yet.</EmptyLine> : null}
      <div className="rrows" ref={box}>
        {list.map((r) => (
          <RecentRow key={r.runId} r={r} now={now} focused={inFocus === href.run(r.runId)} />
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- activity

/**
 * The five latest entries of the activity feed; with a team store each names who did it. Each ends on
 * what it happened to: a run by its id, with its about line on hover, else the fix, verdict, file or
 * rule as it is. A tally or why a preview settled nothing stays one piece where the line wraps. A
 * recording pulses while something records it (`live`, as the top bar's chip has it): the feed goes
 * by the run's stored status, which a killed recorder leaves at running.
 */
export function ActivityCard({ items, error = null, retry, now, byPerson, live }: { items: readonly ActivityItem[] | null; error?: Error | null; retry?: () => void; now: number; byPerson: boolean; live: readonly LiveRun[] }) {
  const recording = new Set(live.map((l) => l.runId));
  const aboutOf = useAbouts();
  const box = useRef<HTMLDivElement>(null);
  // j and k walk the entries that lead somewhere, by the entry (two can lead to one run).
  const linked = useMemo(() => (items ?? []).filter((a) => activityHref(a)), [items]);
  const inFocus = useListKeys({ rows: linked, keyOf: (a) => a.id, root: box, open: (a) => navigate(activityHref(a)!) });
  return (
    <Section title="Activity" sub="latest" className="ovfeed">
      {error && !items ? <ErrorState retry={retry}>The activity feed could not be read: {error.message}</ErrorState> : null}
      <div className="feed" ref={box}>
        {items && !items.length ? <div className="empty">Nothing yet. Recordings, replays, forks, tests and fixes show here.</div> : null}
        {(items ?? []).map((a) => {
          const line = activityLine(a.text, a.runId ?? a.ref);
          const to = activityHref(a);
          const body = (
            <>
              <span className="at">{whenShortOrClock(a.at, now)}</span>
              <EventIcon kind={activityGlyph(a.kind)} live={!!a.live && !!a.runId && recording.has(a.runId)} outcome={a.outcome} />
              <span className={`w${a.rule ? ' gv' : ''}`}>
                {byPerson && a.actor ? <b className="actor">{personName(a.actor)}</b> : null}
                {byPerson && a.actor ? ' ' : null}
                <DotPieces text={activityKeep(line.text)} max={a.rule ? 44 : 24} cut={keepPieces} aboutOf={aboutOf} />
                {/* What it happened to wraps as one piece after the words, never dragging the last word with it. */}
                {line.code ? ' ' : null}
                {line.code && a.runId ? <Id id={line.code} about={aboutOf(line.code)} /> : line.code ? <code>{line.code}</code> : null}
              </span>
            </>
          );
          // An entry with nowhere to go (a preview of a change, which no page shows yet) is a plain row, never a link back here.
          return to ? (
            <a key={a.id} className={inFocus === a.id ? 'krow' : undefined} href={to} data-rowkey={a.id} data-tip={ruleTip(line.text.split(': ')[0]!, a.rule)}>
              {body}
            </a>
          ) : (
            <div key={a.id} className="plain">
              {body}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** Where an activity entry goes: its own destination, else the run it names; none for one that names neither. */
export function activityHref(a: Pick<ActivityItem, 'href' | 'runId'>): string | null {
  return a.href ?? (a.runId ? href.run(a.runId) : null);
}

/** 10:14 today, Sep 30 before. */
function whenShortOrClock(at: number, now: number): string {
  const d = new Date(at);
  const t = new Date(now);
  return d.toDateString() === t.toDateString() ? clock(at) : whenShort(at, now);
}
