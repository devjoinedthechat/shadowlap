import { act, createElement, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { overviewSummary } from '../src/overview.js';
import type { ActivityItem, Client, NeedsLookRow, OverviewSummary, RunListItem } from '../ui/api.js';
import { handOnAtEnd, headingRef, notingJobFrom } from '../ui/focus-manager.js';
import { OverviewPage } from '../ui/pages/Overview.js';
import { href } from '../ui/route.js';
import { useRoute } from '../ui/router.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { AppContext, type AppState } from '../ui/state.js';
import { addRun, DAY } from './read-model-store.js';
import { addressBar, app, watchThePage } from './ui-route-helpers.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The Overview as the shell draws it: Watch live naming the recording by what it is about, Recent
 * runs' eight newest with a recording first, j and k through its four lists in the order they read,
 * and where the focus goes when a job a Needs a look row started ends and the page draws anew.
 */

const NOW = Date.UTC(2026, 9, 22, 12);
/** A run's id: its first ten characters, the short id, told apart by `n`. */
const rid = (n: number) => `01M5H3${String(n).padStart(4, '0')}QJ8V2W3X4Y5Z6A7B`;
const run = (n: number, over: Record<string, unknown> = {}) =>
  ({ runId: rid(n), parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node refund_agent.mjs', codeVersion: null, startedAt: NOW - n * 60_000, endedAt: NOW - n * 60_000 + 1, calls: 3, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], about: { text: `Ticket T-${8800 + n}`, from: 'user' }, ...over }) as unknown as RunListItem;
const text = (el: { textContent: string }) => el.textContent.replace(/\s+/g, ' ').trim();
const tip = (el: { getAttribute(name: string): string | null }) => JSON.parse(el.getAttribute('data-tip')!) as { t: string; s: string | null };

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

/** The Overview in the shell's place for a page, its keys and the router mounted; `show` swaps what the server says, then moves the shell's tick so the page reads it again. */
async function overview(first: Shown): Promise<{ show: (next: Shown) => Promise<void> }> {
  let now = first;
  const client = {
    summary: () => Promise.resolve(now.summary),
    activity: () => Promise.resolve({ items: now.activity ?? [], next: null }),
    teamStore: () => Promise.resolve(null),
    jobs: async () => [],
    nextStep: async () => ({ next: null }),
  } as unknown as Client;
  let move: (tick: number) => void = () => undefined;
  function Host() {
    useRoute();
    const [tick, setTick] = useState(0);
    move = setTick;
    const state = app({ client, runs: now.runs ?? [], live: now.live ?? [], tick, runsTick: 0, feeds: {}, hasKind: () => true });
    return createElement(AppContext.Provider, { value: state }, createElement('main', { id: 'view', tabIndex: -1 }, createElement('h1', { ref: headingRef }, 'Overview'), createElement(OverviewPage)), createElement(Keyboard));
  }
  r = await render(createElement(Host));
  await r.until('the Overview', () => r!.all('.ovg').length > 0);
  let ticks = 0;
  return {
    show: async (next) => {
      now = next;
      await act(async () => move(++ticks));
    },
  };
}

describe('the Overview’s header and Recent runs', () => {
  it('names the recording on Watch live’s hover by what it is about, never its command, and counts its calls as they come', async () => {
    const recording = { runId: '01M5GRZNA5PJ6DHP9G395YMSJG', command: 'node refund_agent.mjs T-8813', calls: 9, startedAt: NOW - 60_000, about: { text: 'My blender arrived broken', from: 'user' as const } };
    await overview({ summary: { ...week, today: { ...week.today, recording: [recording] } }, live: [{ runId: recording.runId, calls: 12 }] as AppState['live'] });
    const live = r!.one('a.btn.livebtn');
    expect(live.getAttribute('title')).toBe('Recording 01M5GRZNA5 · My blender arrived broken');
    expect(live.getAttribute('href')).toBe(href.run(recording.runId));
    expect(text(live.querySelector('.lc')!)).toBe('12 calls');
  });

  it('lists the eight newest runs, one being recorded first, each with its kind on hover, a fork blame rescued a run with named so', async () => {
    const runs = [
      ...Array.from({ length: 10 }, (_, n) => run(n + 1)),
      // Started before all of them, and still recording.
      run(40, { status: 'running', endedAt: null }),
    ];
    runs[1] = run(2, { mode: 'replay', parentRunId: rid(1), divergence: { callNo: 17 }, rescues: rid(9) });
    runs[2] = run(3, { test: true, mode: 'replay', parentRunId: rid(1) });
    await overview({ summary: week, runs });
    const rows = r!.all('.rrows > a');
    expect(rows.map((a) => a.getAttribute('data-rowkey'))).toEqual([40, 1, 2, 3, 4, 5, 6, 7].map((n) => href.run(rid(n))));
    expect(rows.slice(1, 4).map((a) => tip(a).t)).toEqual([`${rid(1).slice(0, 10)} · recording`, `${rid(2).slice(0, 10)} · rescued fork`, `${rid(3).slice(0, 10)} · test replay`]);
    expect(tip(rows[1]).s).toBe('Ticket T-8801');
    expect(text(r!.one('.ovruns a.more'))).toBe('All runs →');
  });
});

describe('the Overview’s keys', () => {
  it('walk Needs a look’s rows, then Recent runs, Activity’s entries that lead somewhere and, with Usage open, the prompt cache’s misses', async () => {
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
    expect(walked).toEqual(['attn:local', `attn:unblamed:${rid(2)}`, href.run(rid(1)), href.run(rid(2)), href.run(rid(3)), 'e:1', 'e:3', `${rid(1)}#17`, `${rid(3)}#4`, `${rid(3)}#4`, `${rid(3)}#4`]);
    // And back up with k, one list into the one above it.
    await r!.press('k');
    await r!.press('k');
    expect(r!.focused().getAttribute('data-rowkey')).toBe('e:3');
    expect(r!.all('.krow').map((x) => x.getAttribute('data-rowkey'))).toEqual(['e:3']);
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
