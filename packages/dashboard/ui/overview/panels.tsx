import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
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
import type { ActivityItem, LiveRun, OverviewSummary } from '../types.js';
import { activityGlyph, activityKeep, activityLine, keepPieces, personName, shortPaths } from './model.js';
import { DotPieces, useAbouts } from './words.js';

/**
 * The Overview's aside, the activity feed beside Needs a look, and Watch live in the header. Needs a
 * look is NeedsLook.tsx and Usage, under it, Usage.tsx. Each takes its part of the server's summary.
 * The newest runs are the sidebar's, on every page, and Runs has every run.
 */

/**
 * Watch live, with a call count that goes up as calls arrive; its hover names the recording by what it
 * is about. With several recording (`named`), each says which it is at a glance, by its short id as
 * the sidebar draws it, the words Watch live left for a screen reader to say.
 */
export function WatchLive({ runId, about, calls, named = false }: { runId: string; about: string; calls: number; named?: boolean }) {
  return (
    <a className={`btn livebtn${named ? ' named' : ''}`} href={href.run(runId)} title={`Recording ${shortId(runId)} · ${about}`}>
      <span className="pulse" aria-hidden="true" />
      {named ? (
        <span className="lt">
          <span className="sr">Watch live </span>
          <Id id={shortId(runId)} list />
        </span>
      ) : (
        <span className="lt">Watch live</span>
      )}{' '}
      {/* a space a flex row draws nothing of, so a screen reader says the words apart */}
      <span className="lc">{plural(calls, 'call')}</span>
    </a>
  );
}

/** How many recordings in progress the header has a Watch live for; past them, one link lists the rest on Runs. */
export const WATCHED = 3;

/**
 * Watch live for each recording in progress, newest first, its calls as the change feed counts them
 * (`live`); past WATCHED, `2 more recording` opens Runs on every run recording now. With several,
 * each names its run. They stay beside the title, as one recording's does: where the header has no
 * room for them there, the newest stay and the rest are counted in the link (useRoomBeside).
 */
export function LiveRecordings({ rows, live }: { rows: OverviewSummary['today']['recording']; live: readonly LiveRun[] }) {
  const box = useRef<HTMLSpanElement>(null);
  const calls = rows.map((r) => live.find((l) => l.runId === r.runId)?.calls ?? r.calls);
  const shown = useRoomBeside(box, rows.map((r) => r.runId).join(' '), Math.min(WATCHED, rows.length), calls.join(' '));
  const more = rows.length - shown;
  return (
    <span className="lives" ref={box}>
      {rows.slice(0, shown).map((r, i) => (
        <WatchLive key={r.runId} runId={r.runId} about={r.about?.text ?? r.command} calls={calls[i]!} named={rows.length > 1} />
      ))}
      {more > 0 ? (
        <a className="btn" href={href.runs({ q: 'status:live' })}>
          {more} more recording
        </a>
      ) : null}
    </span>
  );
}

/**
 * How many of `most` a page header's actions show while they stay beside its title, at least one:
 * fitted as they are drawn and as their words change (`drawn`: a count of calls grows a button),
 * from `most` again as the window changes, once the fonts land, and whenever what is listed
 * (`key`) changes. Where nothing is laid out (a page not shown), all of them.
 */
function useRoomBeside(box: RefObject<HTMLElement | null>, key: string, most: number, drawn: string): number {
  const [fit, setFit] = useState({ key, most, shown: most });
  const shown = fit.key === key && fit.most === most ? fit.shown : most;
  // Each fit is a new state, so the boxes are read again after it: one fewer only while they sit under the title.
  useLayoutEffect(() => {
    const actions = box.current?.closest<HTMLElement>('.ph > .actions');
    const head = actions?.parentElement?.querySelector<HTMLElement>(':scope > .phl');
    if (!actions || !head || !actions.getClientRects().length) return;
    if (shown > 1 && actions.getBoundingClientRect().top > head.getBoundingClientRect().top + 1) setFit({ key, most, shown: shown - 1 });
  }, [box, fit, key, most, shown, drawn]);
  useEffect(() => {
    const again = () => setFit({ key, most, shown: most });
    const fonts = typeof document.fonts?.addEventListener === 'function' ? document.fonts : null;
    window.addEventListener('resize', again);
    fonts?.addEventListener('loadingdone', again);
    return () => {
      window.removeEventListener('resize', again);
      fonts?.removeEventListener('loadingdone', again);
    };
  }, [key, most]);
  return shown;
}

// ---------------------------------------------------------------------------------------------- activity

/** How many of the feed's latest entries the Overview shows. */
export const ACTIVITY_SHOWN = 8;

/**
 * The latest entries of the activity feed, a row each (ActivityRows), with All activity → to the
 * whole feed (pages/Activity.tsx), where older entries come a page at a time.
 */
export function ActivityCard({ items, error = null, retry, now, byPerson, live }: { items: readonly ActivityItem[] | null; error?: Error | null; retry?: () => void; now: number; byPerson: boolean; live: readonly LiveRun[] }) {
  return (
    <Section
      title="Activity"
      sub="latest"
      className="ovfeed"
      actions={
        <a className="more" href={href.activity()}>
          All activity →
        </a>
      }
    >
      {error && !items ? <ErrorState retry={retry}>The activity feed could not be read: {error.message}</ErrorState> : null}
      <ActivityRows items={items} now={now} byPerson={byPerson} live={live} />
    </Section>
  );
}

/**
 * Activity entries, a row each as a run's row reads: its glyph, what happened, and when at its end.
 * With a team store each names who did it. Each ends on what it happened to: a run by its id, with
 * its about line on hover, else the fix, verdict, file or rule as it is. A tally or why a preview
 * settled nothing stays one piece where the line wraps, and a folder's path is its last folders,
 * whole on hover. What an entry names is inline code (`Code`): whole where a line holds it, else
 * broken after a slash, as a bucket's address with its endpoint is. A recording pulses while
 * something records it (`live`, as the top bar's chip has it): the feed goes by the run's stored
 * status, which a killed recorder leaves at running. j and k walk the entries that lead somewhere.
 */
export function ActivityRows({ items, now, byPerson, live }: { items: readonly ActivityItem[] | null; now: number; byPerson: boolean; live: readonly LiveRun[] }) {
  const recording = new Set(live.map((l) => l.runId));
  const aboutOf = useAbouts();
  const box = useRef<HTMLDivElement>(null);
  // j and k walk the entries that lead somewhere, by the entry (two can lead to one run).
  const linked = useMemo(() => (items ?? []).filter((a) => activityHref(a)), [items]);
  const inFocus = useListKeys({ rows: linked, keyOf: (a) => a.id, root: box, open: (a) => navigate(activityHref(a)!) });
  return (
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
