import { useMemo, useRef } from 'react';
import { Code } from '../components/Copy.js';
import { Id } from '../components/Id.js';
import { EventIcon } from '../components/RunIcon.js';
import { Section } from '../components/Section.js';
import { ErrorState } from '../components/States.js';
import { ruleTip } from '../components/Verdict.js';
import { clock, plural, shortId, whenShort } from '../format.js';
import { useListKeys } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import type { ActivityItem, LiveRun } from '../types.js';
import { activityGlyph, activityKeep, activityLine, keepPieces, personName, shortPaths } from './model.js';
import { DotPieces, useAbouts } from './words.js';

/**
 * The Overview's aside, the activity feed beside Needs a look, and Watch live in the header. Needs a
 * look is NeedsLook.tsx and Usage, under it, Usage.tsx. Each takes its part of the server's summary.
 * The newest runs are the sidebar's, on every page, and Runs has every run.
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

// ---------------------------------------------------------------------------------------------- activity

/** How many of the feed's latest entries the Overview shows. */
export const ACTIVITY_SHOWN = 8;

/**
 * The latest entries of the activity feed, a row each as a run's row reads: its glyph, what happened,
 * and when at its end. With a team store each names who did it. Each ends on what it happened to: a
 * run by its id, with its about line on hover, else the fix, verdict, file or rule as it is. A tally
 * or why a preview settled nothing stays one piece where the line wraps, and a folder's path is its
 * last folders, whole on hover. What an entry names is inline code (`Code`): whole where a line
 * holds it, else broken after a slash, as a bucket's address with its endpoint is. A recording pulses while something records it (`live`, as the top
 * bar's chip has it): the feed goes by the run's stored status, which a killed recorder leaves at
 * running.
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
          const words = shortPaths(line.text);
          const to = activityHref(a);
          const body = (
            <>
              <EventIcon kind={activityGlyph(a.kind)} live={!!a.live && !!a.runId && recording.has(a.runId)} outcome={a.outcome} />
              {/* A path drawn as its last folders is whole on its hover. */}
              <span className={`w${a.rule ? ' gv' : ''}`} title={words === line.text ? undefined : line.text}>
                {byPerson && a.actor ? <b className="actor">{personName(a.actor)}</b> : null}
                {byPerson && a.actor ? ' ' : null}
                <DotPieces text={activityKeep(words)} max={a.rule ? 44 : 24} cut={keepPieces} aboutOf={aboutOf} />
                {/* What it happened to wraps as one piece after the words, never dragging the last word with it; one too long for a line breaks as inline code does. */}
                {line.code ? ' ' : null}
                {line.code && a.runId ? <Id id={line.code} about={aboutOf(line.code)} /> : line.code ? <Code>{line.code}</Code> : null}
              </span>
              <span className="at">{whenShortOrClock(a.at, now)}</span>
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
