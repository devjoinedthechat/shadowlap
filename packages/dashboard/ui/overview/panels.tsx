import { memo, useMemo, useRef, useState } from 'react';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { tipCard } from '../components/HoverCard.js';
import { Id } from '../components/Id.js';
import { EventIcon, RunIcon } from '../components/RunIcon.js';
import { Section } from '../components/Section.js';
import { EmptyLine, ErrorState } from '../components/States.js';
import { MiniStrip } from '../components/Strip.js';
import { DotLine, ruleTip } from '../components/Verdict.js';
import { clock, num, plural, shortId, whenShort } from '../format.js';
import { ORIGIN_NAME } from '../origins.js';
import { href } from '../route.js';
import { isAttempt, kindWord, runOrigins, sideStatus } from '../runs.js';
import { SideStatus } from '../shell/Sidebar.js';
import { useApp } from '../state.js';
import type { ActivityItem, LiveRun, NeedsLookRow, RunListItem } from '../types.js';
import { activityGlyph, activityLine, callsSaid, needsLookAction, needsLookKey, needsLookShown, personName, recentKind, SHOW_ORIGINS } from './model.js';

/**
 * The Overview's sections, as the mock draws them: Needs a look, the newest runs and the activity
 * feed. Usage, under them, is Usage.tsx. Each takes its part of the server's summary.
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

// ---------------------------------------------------------------------------------------------- needs a look

/**
 * Most urgent first; three, then "Show N more". A recording in progress is Watch live's.
 * Each line's word says where it leads; where nothing runs (a read-only dashboard) every line opens.
 */
export function NeedsLook({ items, total }: { items: readonly NeedsLookRow[]; total: number }) {
  const { actionsOff } = useApp();
  const [open, setOpen] = useState(false);
  const shown = needsLookShown(items, open);
  // A run's about line takes one line, fitted at whole words to the room its status leaves it.
  const box = useRef<HTMLElement>(null);
  useFitAbouts(box);
  return (
    <section className="panel needs" ref={box}>
      <header>
        <h2>Needs a look</h2>
        <span className="sub">{num(total)}</span>
      </header>
      <div className="attn">
        {total === 0 ? <div className="empty">Nothing needs a look.</div> : null}
        {shown.rows.map((x) => (
          // A gate's verdict (decision 9) says its word, tally and bound, whole, and its rule on hover.
          <a key={needsLookKey(x)} href={x.href} data-tip={ruleTip(x.title.replace(/^A test (?:failed|is inconclusive): /, ''), x.rule)}>
            <EventIcon kind={x.icon} />
            <span>
              <span className="t">{x.title}</span>
              {x.rule ? (
                <span className="d gv">
                  <DotLine text={x.detail} />
                </span>
              ) : x.about?.text ? (
                // What the run was about (decision 10), then what is left to do, kept whole: the about
                // line gives way at whole words, never cut mid-word, and the dot goes with it.
                <span className="d ab">
                  <AboutLine about={x.about} />
                  <span className="abs">
                    <span className="dot">·</span>
                    {x.detail}
                  </span>
                </span>
              ) : (
                <span className="d" title={x.detail}>
                  {x.detail}
                </span>
              )}
            </span>
            <span className="go">{needsLookAction(x, actionsOff)} →</span>
          </a>
        ))}
        {shown.more ? (
          <button className="attn-more" type="button" onClick={() => setOpen(!open)}>
            {shown.more}
          </button>
        ) : null}
      </div>
    </section>
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

const RecentRow = memo(function RecentRow({ r, now }: { r: RunListItem; now: number }) {
  const origins = runOrigins(r) ?? [];
  const st = sideStatus(r);
  const id = shortId(r.runId);
  return (
    <a className="rrow" href={href.run(r.runId)} data-tip={tipCard(`${id} · ${recentKind(kindWord(r))}`, originTip(origins), r.about?.text ?? null)}>
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
            {r.about?.text ? <span className="dot">·</span> : null}
            <SideStatus st={st} />
          </span>
        ) : null}
      </span>
    </a>
  );
});

/** The eight newest runs, one being recorded first, a row each as every run list has them: its id, its calls by origin and when, then its about line and what needs a look. */
export function RecentRuns({ runs, now }: { runs: readonly RunListItem[] | null; now: number }) {
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
          <RecentRow key={r.runId} r={r} now={now} />
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- activity

/**
 * The five latest entries of the activity feed; with a team store each names who did it. A recording
 * pulses while something records it (`live`, as the top bar's chip has it): the feed goes by the
 * run's stored status, which a killed recorder leaves at running.
 */
export function ActivityCard({ items, error = null, retry, now, byPerson, live }: { items: readonly ActivityItem[] | null; error?: Error | null; retry?: () => void; now: number; byPerson: boolean; live: readonly LiveRun[] }) {
  const recording = new Set(live.map((l) => l.runId));
  return (
    <Section title="Activity" sub="latest" className="ovfeed">
      {error && !items ? <ErrorState retry={retry}>The activity feed could not be read: {error.message}</ErrorState> : null}
      <div className="feed">
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
                {a.rule ? <DotLine text={line.text} /> : line.text}
                {line.code ? <code>{line.code}</code> : null}
              </span>
            </>
          );
          // An entry with nowhere to go (a preview of a change, which no page shows yet) is a plain row, never a link back here.
          return to ? (
            <a key={a.id} href={to} data-tip={ruleTip(line.text.split(': ')[0]!, a.rule)}>
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
