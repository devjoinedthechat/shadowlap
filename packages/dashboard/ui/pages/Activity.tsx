import { useEffect, useState } from 'react';
import { PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { Section } from '../components/Section.js';
import { ErrorState, failedRead, Skeleton } from '../components/States.js';
import { num } from '../format.js';
import { useLoad } from '../hooks.js';
import { ActivityRows } from '../overview/panels.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';
import { useTeamStore } from '../teamstore.js';
import type { ActivityItem } from '../types.js';

/**
 * The activity feed whole (`#/activity`), which the Overview's Activity shows the newest of: its
 * newest entries, then older ones a page at a time (`GET /api/activity?before=`), each row as the
 * Overview draws it. The newest page is read again as the feed moves, a run or an entry stored with
 * no run changed, and what was read before stays, so an entry pushed past the newest page by a later
 * one never drops out from between the pages.
 */

/** How many entries a page brings. */
export const ACTIVITY_PAGE = 50;

/** The entries read so far, newest first, each once: the newest page's, then those read before it. */
export function mergeActivity(newest: readonly ActivityItem[], kept: readonly ActivityItem[]): ActivityItem[] {
  const ids = new Set(newest.map((a) => a.id));
  return [...newest, ...kept.filter((a) => !ids.has(a.id))].sort((x, y) => y.at - x.at);
}

export function ActivityPage() {
  const { client, live, tick, feeds, meta } = useApp();
  const store = useTeamStore();
  const newest = useLoad(() => client.activity(ACTIVITY_PAGE), 'activity:page', `${tick}:${feeds.events ?? 0}`);
  // Every entry read so far, and where the next older page starts: null once the feed's oldest is in.
  const [kept, setKept] = useState<ActivityItem[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [older, setOlder] = useState<{ reading: boolean; error: Error | null }>({ reading: false, error: null });
  const first = newest.data;
  useEffect(() => {
    if (!first) return;
    setKept((k) => mergeActivity(first.items, k));
    // Until an older page is read, the next starts where the newest page ends.
    setNext((n) => (n === undefined ? first.next : n));
  }, [first]);
  const more = () => {
    if (!next || older.reading) return;
    setOlder({ reading: true, error: null });
    client.activity(ACTIVITY_PAGE, next).then(
      (page) => {
        setKept((k) => mergeActivity(page.items, k));
        setNext(page.next);
        setOlder({ reading: false, error: null });
      },
      (err: unknown) => setOlder({ reading: false, error: err instanceof Error ? err : new Error(String(err)) }),
    );
  };
  const name = projectOf(meta)?.name ?? 'this project';
  const items = first ? mergeActivity(first.items, kept) : null;
  return (
    <Page busy={!first && !newest.error}>
      <PageHeader eyebrow={name} title="Activity" text="What was recorded, replayed, tested and fixed here, newest first." />
      {newest.error && !first ? (
        <ErrorState retry={newest.reload}>{failedRead(newest.error)}</ErrorState>
      ) : !items ? (
        <Skeleton what="the activity" lines={8} />
      ) : (
        <Section title="Activity" sub={`${num(items.length)} ${items.length === 1 ? 'entry' : 'entries'}`} className="ovfeed actfeed">
          <ActivityRows items={items} now={Date.now()} byPerson={!!store} live={live} />
          {older.error ? <ErrorState retry={more}>{failedRead(older.error)}</ErrorState> : null}
          {next && !older.error ? (
            <button className="attn-more" type="button" disabled={older.reading} onClick={more}>
              {older.reading ? 'Reading older entries…' : `Show ${ACTIVITY_PAGE} older`}
            </button>
          ) : null}
          {next === null && items.length ? <p className="muted actend">The start of the feed: nothing older.</p> : null}
        </Section>
      )}
    </Page>
  );
}
