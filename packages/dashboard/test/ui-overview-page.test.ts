import { act, createElement, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { overviewSummary } from '../src/overview.js';
import type { ActivityItem, ActivityPage as FeedPage, Client, NeedsLookRow, OverviewSummary, RunListItem } from '../ui/api.js';
import { handOnAtEnd, headingRef, notingJobFrom } from '../ui/focus-manager.js';
import { dropRowScope, rowScopeNow, takeRowScope } from '../ui/list-keys.js';
import { ISSUE_ASK } from '../ui/page-ask.js';
import { ACTIVITY_PAGE, ActivityPage, mergeActivity } from '../ui/pages/Activity.js';
import { OverviewPage } from '../ui/pages/Overview.js';
import { href, navSection, parseRoute, routeHref } from '../ui/route.js';
import { pageTitle } from '../ui/title.js';
import { useRoute } from '../ui/router.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { AppContext, type AppState } from '../ui/state.js';
import { addRun, DAY } from './read-model-store.js';
import { addressBar, app, watchThePage } from './ui-route-helpers.js';
import { render, type Rendered } from './ui-render.js';
import { withMigrateDialogs } from './ui-served-now.js';

/**
 * The Overview as the shell draws it: Watch live naming the recording by what it is about, Needs a
 * look over Usage with the activity feed beside them, j and k through its three lists in the order
 * they read, where the focus goes when a job a Needs a look row started ends and the page draws
 * anew, and a Dismiss in another tab, which the page reads again without asking a fix step its price
 * again.
 */

const NOW = Date.UTC(2026, 9, 22, 12);
/** A run's id: its first ten characters, the short id, told apart by `n`. */
const rid = (n: number) => `01M5H3${String(n).padStart(4, '0')}QJ8V2W3X4Y5Z6A7B`;
const run = (n: number, over: Record<string, unknown> = {}) =>
  ({ runId: rid(n), parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node refund_agent.mjs', codeVersion: null, startedAt: NOW - n * 60_000, endedAt: NOW - n * 60_000 + 1, calls: 3, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], about: { text: `Ticket T-${8800 + n}`, from: 'user' }, ...over }) as unknown as RunListItem;
const text = (el: { textContent: string }) => el.textContent.replace(/\s+/g, ' ').trim();

/** The week of a store with one run, as the server works it out, with what each test puts in its place. */
let week: OverviewSummary;
beforeAll(() => {
  const store = Store.open(':memory:');
  addRun(store, { startedAt: NOW - DAY, calls: 'lrlrl' });
  week = JSON.parse(JSON.stringify(overviewSummary(store, { tz: 'UTC', now: NOW }))) as OverviewSummary;
  store.close();
});

let r: Rendered | null = null;
beforeEach(() => {
  addressBar('#/');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

interface Shown {
  summary: OverviewSummary;
  runs?: RunListItem[];
  activity?: ActivityItem[];
  live?: AppState['live'];
}

/**
 * The Overview in the shell's place for a page, its keys and the router mounted; `show` swaps what
 * the server says, then moves the shell's tick so the page reads it again, and `feed` swaps it and
 * moves the change feed's counters alone. `reads` counts the summaries read.
 */
async function overview(first: Shown, more: Partial<Client> = {}): Promise<{ show: (next: Shown) => Promise<void>; feed: (next: Shown, counters: Record<string, number>) => Promise<void>; reads: () => number }> {
  let now = first;
  let reads = 0;
  const client = {
    summary: () => (reads++, Promise.resolve(now.summary)),
    activity: () => Promise.resolve({ items: now.activity ?? [], next: null }),
    teamStore: () => Promise.resolve(null),
    jobs: async () => [],
    nextStep: async () => ({ next: null }),
    ...more,
  } as unknown as Client;
  let move: (tick: number) => void = () => undefined;
  let counters: (feeds: Record<string, number>) => void = () => undefined;
  function Host() {
    useRoute();
    const [tick, setTick] = useState(0);
    const [feeds, setFeeds] = useState<Record<string, number>>({});
    move = setTick;
    counters = setFeeds;
    const state = app({ client, runs: now.runs ?? [], live: now.live ?? [], tick, runsTick: 0, feeds, hasKind: () => true });
    return withMigrateDialogs(createElement(AppContext.Provider, { value: state }, createElement('main', { id: 'view', tabIndex: -1 }, createElement('h1', { ref: headingRef }, 'Overview'), createElement(OverviewPage)), createElement(Keyboard)));
  }
  r = await render(createElement(Host));
  await r.until('the Overview', () => r!.all('.ovg').length > 0);
  let ticks = 0;
  return {
    show: async (next) => {
      now = next;
      await act(async () => move(++ticks));
    },
    feed: async (next, to) => {
      now = next;
      await act(async () => counters(to));
    },
    reads: () => reads,
  };
}

describe('the Overview’s header and its layout', () => {
  it('names the recording on Watch live’s hover by what it is about, never its command, and counts its calls as they come', async () => {
    const recording = { runId: '01M5GRZNA5PJ6DHP9G395YMSJG', command: 'node refund_agent.mjs T-8813', calls: 9, startedAt: NOW - 60_000, about: { text: 'My blender arrived broken', from: 'user' as const } };
    await overview({ summary: { ...week, today: { ...week.today, recording: [recording] } }, live: [{ runId: recording.runId, calls: 12 }] as AppState['live'] });
    const live = r!.one('a.btn.livebtn');
    expect(live.getAttribute('title')).toBe('Recording 01M5GRZNA5 · My blender arrived broken');
    expect(live.getAttribute('href')).toBe(href.run(recording.runId));
    expect(text(live.querySelector('.lc')!)).toBe('12 calls');
  });

  it('holds Needs a look and Usage in one column, the activity feed its aside with its eight latest, and lists no runs of its own', async () => {
    const activity = vi.fn((_limit?: number) => Promise.resolve({ items: [{ id: 'e:1', at: NOW - 1000, kind: 'clean', text: 'Replay clean · 30/30 · 0 upstream', runId: rid(1) }] as ActivityItem[], next: null }));
    await overview({ summary: week, runs: Array.from({ length: 10 }, (_, n) => run(n + 1)) }, { activity });
    await r!.until('the activity feed', () => r!.all('.feed > a').length === 1);
    // The sections in the order they are read and tabbed through: the column, then its aside.
    expect(r!.all('.ovg > .ovmain > section > header h2').map(text)).toEqual(['Needs a look', 'Usage']);
    expect(r!.all('.ovg > section > header h2').map(text)).toEqual(['Activity']);
    expect(r!.all('.ovg section > header h2').map(text)).toEqual(['Needs a look', 'Usage', 'Activity']);
    expect(activity.mock.calls.map((c) => c[0])).toEqual([8]);
    // Older entries are the whole feed's, a page at a time.
    const all = r!.one('.ovfeed header a.more');
    expect([text(all), all.getAttribute('href')]).toEqual(['All activity →', '#/activity']);
    // The newest runs are the sidebar's: the page links to none of the ten.
    expect(r!.all('.ovg a').map((a) => a.getAttribute('href')).filter((to) => to?.startsWith('#/run/'))).toEqual([href.run(rid(1))]);
  });
});

describe('the Overview’s keys', () => {
  it('walk Needs a look’s rows, then, with Usage open, the prompt cache’s misses, then Activity’s entries that lead somewhere', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'open', setItem: () => undefined, removeItem: () => undefined });
    const items: NeedsLookRow[] = [
      { kind: 'local', icon: 'rec', title: '12 runs are only on this machine', detail: 'push them so the team can open them', key: 'attn:local', group: 'housekeeping', step: { of: 'push', label: 'Push local runs', command: 'shadowlap push --all' }, href: '#/runs?types=local', runId: null, fixId: null, at: 0 },
      { kind: 'unblamed', icon: 'fail', title: '1 failing run nobody has blamed', detail: `${rid(2).slice(0, 10)} · failed`, key: `attn:unblamed:${rid(2)}`, group: 'failing', step: null, href: '#/runs?types=failed', runId: rid(2), fixId: null, at: 2 },
    ];
    const misses = [
      { runId: rid(1), kind: 'recording', callNo: 17, scope: null, model: 'sonnet-5', tokens: 8200 },
      { runId: rid(3), kind: 'recording', callNo: 4, scope: null, model: 'sonnet-5', tokens: 3100 },
    ];
    const activity = [
      { id: 'e:1', at: NOW - 1000, kind: 'clean', text: 'Replay clean · 30/30 · 0 upstream', runId: rid(1) },
      // Nowhere to go: a plain entry, which the keys pass by.
      { id: 'e:2', at: NOW - 2000, kind: 'test', text: 'Preview settled nothing', ref: 'refund' },
      { id: 'e:3', at: NOW - 3000, kind: 'fixok', text: 'Fix verified', href: '#/fixes/fx-01M5H2DV7N' },
    ] as ActivityItem[];
    const summary = { ...week, needsLook: { items, total: 2 }, cache: { ...week.cache, misses, sentAgain: 11_300 } } as OverviewSummary;
    await overview({ summary, runs: [run(1), run(2), run(3)], activity });
    await r!.until('the activity feed', () => r!.all('.feed > a').length === 2);
    const walked: Array<string | null> = [];
    for (let i = 0; i < 11; i++) {
      await r!.press('j');
      walked.push(r!.focused().getAttribute('data-rowkey'));
    }
    // Down the column, then down its aside, stopping at the last entry.
    expect(walked).toEqual(['attn:local', `attn:unblamed:${rid(2)}`, `${rid(1)}#17`, `${rid(3)}#4`, 'e:1', 'e:3', 'e:3', 'e:3', 'e:3', 'e:3', 'e:3']);
    // And back up with k, one list into the one above it.
    await r!.press('k');
    await r!.press('k');
    expect(r!.focused().getAttribute('data-rowkey')).toBe(`${rid(3)}#4`);
    expect(r!.all('.krow').map((x) => x.getAttribute('data-rowkey'))).toEqual([`${rid(3)}#4`]);
  });
});

describe('Needs a look’s row of failed runs nobody has blamed', () => {
  it('opens its newest’s issue on Runs › Failed from its link, from Enter and from ⌘K’s Open', async () => {
    vi.stubGlobal('CSS', { escape: (x: string) => x });
    const issue = 'fail:the agent exited with an error';
    const unblamed: NeedsLookRow = { kind: 'unblamed', icon: 'fail', title: '1 failing run nobody has blamed', detail: `${rid(2).slice(0, 10)} · the agent exited with an error`, key: `attn:unblamed:${rid(2)}`, group: 'failing', step: { of: 'link', label: 'Run blame', href: href.run(rid(2)) }, href: '#/runs?types=failed', runId: rid(2), fixId: null, at: 2, issue };
    await overview({ summary: { ...week, needsLook: { items: [unblamed], total: 1, dismissals: 0 } } });
    const link = r!.one(`[data-rowkey="${unblamed.key}"] a.at`);
    expect(link.getAttribute('href')).toBe('#/runs?types=failed');
    // Its link asks for the issue as it goes there; Failed opens it as it shows.
    await r!.click(link);
    expect(ISSUE_ASK.take(issue)).toBe(true);
    await r!.press('j');
    expect(r!.focused().getAttribute('data-rowkey')).toBe(unblamed.key);
    await r!.press('Enter');
    expect(location.hash).toBe('#/runs?types=failed');
    expect(ISSUE_ASK.take(issue)).toBe(true);
    addressBar('#/');
    await r!.focus(r!.one(`.arow[data-rowkey="${unblamed.key}"]`));
    takeRowScope();
    try {
      rowScopeNow()!
        .items()
        .find((i) => i.label === 'Open')!
        .run();
    } finally {
      dropRowScope();
    }
    expect(location.hash).toBe('#/runs?types=failed');
    expect(ISSUE_ASK.take(issue)).toBe(true);
  });
});

describe('a Needs a look row’s job’s end', () => {
  const tick = (ms = 80) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
  const push: NeedsLookRow = { kind: 'local', icon: 'rec', title: '12 runs are only on this machine', detail: 'push them so the team can open them', key: 'attn:local', group: 'housekeeping', step: { of: 'push', label: 'Push local runs', command: 'shadowlap push --all' }, href: '#/runs?types=local', runId: null, fixId: null, at: 0 };
  const setup: NeedsLookRow = { kind: 'store-setup', icon: 'setting', title: 'The team store’s setup is partway through', detail: 'its bucket is made, its key isn’t', key: 'attn:store-setup', group: 'housekeeping', step: { of: 'link', label: 'Continue setup', href: '#/settings/store/setup' }, href: '#/settings/store/setup', runId: null, fixId: null, at: 0 };
  const looks = (items: NeedsLookRow[]) => ({ summary: { ...week, needsLook: { items, total: items.length, dismissals: 0 } } });

  it('hands the focus to the row’s own step where the row is drawn anew with another in its place', async () => {
    const changed = watchThePage();
    const page = await overview(looks([push, setup]));
    await r!.focus(r!.byText('.arow .ast .btn', 'Push local runs'));
    await notingJobFrom(Promise.resolve({ id: 'job-push-1' }));
    handOnAtEnd('job-push-1');
    await tick();
    // The job ended; the page has not read the summary again yet, so the step keeps the focus.
    expect(text(r!.focused())).toBe('Push local runs');
    await page.show(looks([{ ...push, title: '2 runs are only on this machine', step: { of: 'link', label: 'Open Settings → Store', href: '#/settings/store' } }, setup]));
    await r!.until('the row drawn anew', () => r!.all('.arow .ast a.btn').length === 2);
    await changed();
    expect(r!.focused().closest('[data-rowkey]')?.getAttribute('data-rowkey')).toBe('attn:local');
    expect(text(r!.focused())).toBe('Open Settings → Store');
  });

  it('never hands the focus to another row’s step where the job’s row went', async () => {
    const changed = watchThePage();
    const page = await overview(looks([push, setup]));
    await r!.focus(r!.byText('.arow .ast .btn', 'Push local runs'));
    await notingJobFrom(Promise.resolve({ id: 'job-push-2' }));
    handOnAtEnd('job-push-2');
    await tick();
    await page.show(looks([setup]));
    await r!.until('the row gone', () => r!.all('.arow').length === 1);
    await changed();
    await tick();
    expect(r!.focused().closest?.('.arow')).toBeFalsy();
  });
});

describe('a Dismiss in another tab', () => {
  it('reads the summary again once the dismissals counter moves, a fix step keeping the price it asked for', async () => {
    const fixId = 'fx-01M5H3D15MQJ8V2W3X4Y5Z6A7B';
    const fix: NeedsLookRow = { kind: 'open', icon: 'blame', title: 'Refunds above the limit issued without approval', detail: 'lost at model call #5', key: `attn:fix:#/fixes/${fixId}`, group: 'failing', step: { of: 'fix', fixId, lead: { key: 'blame-stronger', label: 'Blame with a stronger model', command: `shadowlap blame --fix ${fixId} --model claude-opus-5`, use: 'reads' } }, href: `#/fixes/${fixId}`, runId: null, fixId, at: 0 };
    const local: NeedsLookRow = { kind: 'local', icon: 'rec', title: '1 run is only on this machine', detail: 'push it so the team can open it', key: 'attn:local', group: 'housekeeping', step: null, href: '#/runs?types=local', runId: null, fixId: null, at: 0, advice: { key: 'local', facts: [rid(1)], until: 'Until another run is only on this machine', dismissed: false } };
    const fixEstimates = vi.fn(() => Promise.reject(new Error('no estimate here')));
    const looks = (dismissed: boolean, dismissals: number) => ({ summary: { ...week, needsLook: { items: [fix, { ...local, advice: { ...local.advice!, dismissed } }], total: dismissed ? 1 : 2, dismissals } } });
    const page = await overview(looks(false, 0), { estimates: { fixEstimates } } as unknown as Partial<Client>);
    const step = () => r!.byText('.arow .ast .btn', 'Blame with a stronger model');
    await r!.focus(step());
    await r!.until('its price asked for', () => fixEstimates.mock.calls.length === 1);
    const reads = page.reads();
    await page.feed(looks(true, 1), { dismissals: 1 });
    await r!.until('the summary read again', () => page.reads() === reads + 1 && r!.all('.aoff').length === 1);
    await r!.focus(step());
    await r!.wait(20);
    expect(fixEstimates).toHaveBeenCalledTimes(1);
    // A new answer of the list, as a tick brings, asks for it again.
    await page.show(looks(true, 1));
    await r!.until('the summary read again', () => page.reads() === reads + 2);
    await r!.focus(step());
    await r!.until('its price asked for again', () => fixEstimates.mock.calls.length === 2);
  });
});

describe('a retiring model’s row', () => {
  it('asks before Migrate to in the one ask a preview’s Migrate asks: what it asks again, its command, and that the provider bills it', async () => {
    const step = { of: 'migrate' as const, label: 'Migrate to claude-sonnet-5-5', from: ['claude-sonnet-4-5'], to: 'claude-sonnet-5-5', goldens: ['goldens/refund'], command: 'shadowlap migrate --to claude-sonnet-5-5 goldens/refund --from claude-sonnet-4-5' };
    const retire: NeedsLookRow = { key: 'attn:retire:claude-sonnet-4-5', group: 'housekeeping', kind: 'retire', icon: 'retire', title: 'claude-sonnet-4-5, used by 1 golden, retires on Nov 30, 2026', detail: 'in 19 days · Anthropic recommends claude-sonnet-5-5', step, href: '#/tests', runId: null, fixId: null, at: NOW };
    await overview({ summary: { ...week, needsLook: { items: [retire], total: 1, dismissals: 0 } } });
    await r!.click(r!.byText('.arow .ast .btn', 'Migrate to claude-sonnet-5-5'));
    await r!.until('the ask', () => r!.all('.dialog').length === 1);
    expect([text(r!.one('.dialog h3')), text(r!.one('.dialog header p > span:not([hidden])')), text(r!.one('.dialog .dcost'))]).toEqual([
      'Migrate claude-sonnet-4-5 to claude-sonnet-5-5',
      'Asks claude-sonnet-4-5’s calls again under claude-sonnet-5-5, then verifies end to end the runs the preview can’t clear. Migrate in the docs →',
      'Billed by your provider',
    ]);
    expect(text(r!.one('.dialog .cmdline'))).toContain(step.command);
  });
});

/** An entry of the whole feed as it stores it, `n` minutes old. */
const entry = (n: number): ActivityItem => ({ id: `e:${n}`, at: NOW - n * 60_000, kind: 'clean', text: `Replay clean · ${n}/30 · 0 upstream`, runId: `01M5H3${String(n).padStart(4, '0')}QJ8V2W3X4Y5Z6A7B` });

describe('the activity page’s address', () => {
  it('is #/activity, under the Overview in the nav, titled as a page of it', () => {
    expect(parseRoute('#/activity')).toEqual({ page: 'activity' });
    expect(parseRoute('#/activity/more')).toEqual({ page: 'notfound', path: 'activity/more' });
    expect(routeHref({ page: 'activity' })).toBe('#/activity');
    expect(navSection({ page: 'activity' })).toBe('overview');
    expect(pageTitle({ page: 'activity' })).toBe('Activity · Overview');
  });
});

describe('the activity page', () => {
  /** The page over a feed of `pages` (the newest first), counting each read by the cursor it asked from. */
  async function shown(pages: FeedPage[]): Promise<{ asked: Array<string | null> }> {
    const asked: Array<string | null> = [];
    const byCursor = new Map<string | null, FeedPage>(pages.map((p, i) => [i ? pages[i - 1].next : null, p]));
    const client = { activity: (limit: number, before?: string | null) => (expect(limit).toBe(ACTIVITY_PAGE), asked.push(before ?? null), Promise.resolve(byCursor.get(before ?? null) ?? { items: [], next: null })), teamStore: () => Promise.resolve(null) } as unknown as Client;
    r = await render(createElement(AppContext.Provider, { value: { client, live: [], tick: 0, feeds: {}, meta: null, exported: false, runs: [], runsTick: 0 } as unknown as AppState }, createElement(ActivityPage)));
    return { asked };
  }

  it('lists the newest entries as the Overview draws them, then brings older ones a page at a time from where the last page ended, and says where the feed starts', async () => {
    const one: FeedPage = { items: [entry(1), entry(2)], next: 'c1' };
    const two: FeedPage = { items: [entry(3)], next: 'c2' };
    const three: FeedPage = { items: [entry(4)], next: null };
    const { asked } = await shown([one, two, three]);
    await r!.until('the newest page', () => r!.all('.feed > a').length === 2);
    expect(r!.one('.ph h1').textContent).toBe('Activity');
    expect(r!.all('.feed > a').map((a) => a.getAttribute('href'))).toEqual([`#/run/${entry(1).runId!}`, `#/run/${entry(2).runId!}`]);
    const older = () => r!.one('.actfeed button.attn-more');
    expect(older().textContent).toBe(`Show ${ACTIVITY_PAGE} older`);
    await r!.click(older());
    await r!.until('the second page', () => r!.all('.feed > a').length === 3);
    await r!.click(older());
    await r!.until('the third page', () => r!.all('.feed > a').length === 4);
    expect(asked).toEqual([null, 'c1', 'c2']);
    // The oldest is in: no more to show, and it says so.
    expect(r!.all('.actfeed button.attn-more')).toHaveLength(0);
    expect(r!.one('.actfeed .actend').textContent).toBe('The start of the feed: nothing older.');
  });

  it('reads its newest page again as the feed moves, keeping what it read before, so an entry pushed past the newest page stays', async () => {
    let newest: FeedPage = { items: [entry(2), entry(3)], next: 'c1' };
    const asked: Array<string | null> = [];
    const client = { activity: (_limit: number, before?: string | null) => (asked.push(before ?? null), Promise.resolve(before ? { items: [entry(4)], next: null } : newest)), teamStore: () => Promise.resolve(null) } as unknown as Client;
    let move: (n: number) => void = () => undefined;
    function Host() {
      const [events, setEvents] = useState(0);
      move = setEvents;
      return createElement(AppContext.Provider, { value: { client, live: [], tick: 0, feeds: { events }, meta: null, exported: false } as unknown as AppState }, createElement(ActivityPage));
    }
    r = await render(createElement(Host));
    await r.until('the newest page', () => r!.all('.feed > a').length === 2);
    // A newer entry lands: the newest page now ends on #2, and #3 would fall between it and the next page.
    newest = { items: [entry(1), entry(2)], next: 'c0' };
    await act(async () => move(1));
    await r.until('read again', () => r!.all('.feed > a').length === 3);
    expect(r.all('.feed > a').map((a) => a.getAttribute('data-rowkey'))).toEqual(['e:1', 'e:2', 'e:3']);
    expect(asked).toEqual([null, null]);
  });

  it('keeps each entry once, newest first, whichever page brought it', () => {
    expect(mergeActivity([entry(1), entry(2)], [entry(2), entry(3)]).map((a) => a.id)).toEqual(['e:1', 'e:2', 'e:3']);
  });
});
