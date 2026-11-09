import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllRuns, isLink, links, parseRunsQuery, runsFilter } from '../src/links.js';
import type { Client, RunsQuery } from '../ui/api.js';
import { RunsPage } from '../ui/pages/Runs.js';
import { parseRoute, readTokenLink, routeHref } from '../ui/route.js';
import { useRoute } from '../ui/router.js';
import { dayTimes, runsLinkQuery } from '../ui/runspage/query.js';
import { lastRunsHref, lastViewOf, useLastRunsHref } from '../ui/runs-view.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { RunsByDay } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * What Runs shows is its address's (`#/runs?q=&types=&sort=&from=&to=`): the words in its filter,
 * the chip, the sort and the days picked, so a view of Runs can be shared and bookmarked, and Back
 * and Forward go through the views it showed.
 */

describe('the address of a view of Runs', () => {
  it('holds the words, the chip, the sort and the days, one way, and reads back as it was written', () => {
    const link = links.runs({ q: 'refund (A-1042) & more', types: 'failed', sort: 'spent', from: '2026-10-22', to: '2026-10-20' });
    // Every field in its place, the days in order.
    expect(link).toBe('#/runs?q=refund+%28A-1042%29+%26+more&types=failed&sort=spent&from=2026-10-20&to=2026-10-22');
    expect(parseRunsQuery(link.slice('#/runs?'.length))).toEqual({ q: 'refund (A-1042) & more', types: 'failed', sort: 'spent', days: { from: '2026-10-20', to: '2026-10-22' } });
    const route = parseRoute(link);
    expect(route).toEqual({ page: 'runs', filter: { q: 'refund (A-1042) & more', types: 'failed', sort: 'spent', days: { from: '2026-10-20', to: '2026-10-22' } } });
    expect(routeHref(route)).toBe(link);
    expect(runsLinkQuery(link)).toEqual(route.page === 'runs' ? route.filter : null);
    // The runs with a label, as the key's column and a label chip link to them.
    const good = links.runs({ q: 'label:good' });
    expect(good).toBe('#/runs?q=label:good');
    expect(parseRoute(good)).toEqual({ page: 'runs', filter: { q: 'label:good', types: 'all', sort: 'when', days: null } });
    expect(routeHref(parseRoute(good))).toBe(good);
    // Every run is #/runs alone, its route with no filter.
    expect(links.runs({ q: '  ', types: 'all', sort: 'when' })).toBe('#/runs');
    expect(parseRoute('#/runs')).toEqual({ page: 'runs' });
    expect(isAllRuns(runsFilter())).toBe(true);
  });

  it('reads the chip as links named it before, a single day, and leaves out what it doesn’t know', () => {
    expect(runsLinkQuery('#/runs?type=local')).toEqual({ q: '', types: 'local', sort: 'when', days: null });
    expect(runsLinkQuery('#/runs?q=refund&type=fork')).toMatchObject({ q: 'refund', types: 'fork' });
    expect(runsLinkQuery('#/runs?from=2026-10-20')).toMatchObject({ days: { from: '2026-10-20', to: '2026-10-20' } });
    // A chip, a sort or a day it doesn't know: as though not asked for.
    expect(runsLinkQuery('#/runs?types=nightly&sort=cost&from=2026-13-40&to=yesterday&q=x')).toEqual({ q: 'x', types: 'all', sort: 'when', days: null });
    for (const hash of ['#/runs', '#/runs?types=nightly', '#/runs?q=%20', '#/run/01K5CQ4N7G?q=x', '#token=abc&open=/runs']) expect(runsLinkQuery(hash), hash).toBeNull();
    // Words past what the field takes are cut, not refused.
    expect(runsLinkQuery(`#/runs?q=${'a'.repeat(500)}`)?.q).toHaveLength(200);
  });

  it('reads keys and words in any case, a chip by its plural or the type: word, and a + as a space', () => {
    expect(runsLinkQuery('#/runs?Q=status:failed+label:refund&KIND=forks&Types=Recordings&SORT=Calls')).toEqual({ q: 'status:failed label:refund', types: 'recording', sort: 'calls', days: null });
    expect(runsLinkQuery('#/runs?types=replays')?.types).toBe('clean');
    expect(runsLinkQuery('#/runs?types=TESTS')?.types).toBe('test');
    expect(runsLinkQuery('#/runs?type=captures')?.types).toBe('capture');
    expect(runsLinkQuery('#/runs?types=constructor')).toBeNull();
    // What it can't read is left out: a day there isn't, a broken escape.
    expect(runsLinkQuery('#/runs?from=2026-02-30&types=fork')).toEqual({ q: '', types: 'fork', sort: 'when', days: null });
    expect(runsLinkQuery('#/runs?q=100%&types=fork')).toEqual({ q: '', types: 'fork', sort: 'when', days: null });
    expect(runsLinkQuery('#/runs?from=2028-02-29')?.days).toEqual({ from: '2028-02-29', to: '2028-02-29' });
    expect(links.runs({ from: '2026-02-30' })).toBe('#/runs');
    // Written as it reads: a space as +, and : , / @ as typed, whole in a link a command prints.
    const link = links.runs({ q: 'status:failed label:refund tool:a/b @x,y' });
    expect(link).toBe('#/runs?q=status:failed+label:refund+tool:a/b+@x,y');
    expect(isLink(link)).toBe(true);
    expect(readTokenLink(`#token=abc&open=${link.slice(1)}`)?.open).toBe(link);
    expect(runsLinkQuery(link)?.q).toBe('status:failed label:refund tool:a/b @x,y');
    expect(runsLinkQuery(links.runs({ q: 'a+b' }))?.q).toBe('a+b');
  });

  it('asks the table for the days picked as the viewer’s own days: the first one’s start to the start of the day after the last', () => {
    const t = dayTimes({ from: '2026-10-20', to: '2026-10-22' })!;
    expect(t.from).toBe(new Date(2026, 9, 20).getTime());
    expect(t.to).toBe(new Date(2026, 9, 23).getTime());
    expect(dayTimes({ from: 'soon', to: '2026-10-22' })).toBeNull();
  });
});

/**
 * An address bar with a history, as a browser keeps one: a new address is a step (`hash =`), one
 * replaced takes the place of the step it was in, and Back and Forward move between steps, each
 * telling the page its address changed.
 */
function addressBar(start: string) {
  const steps = [start];
  let at = 0;
  const changed = () => (globalThis as unknown as { window: { dispatchEvent(e: { type: string }): void } }).window.dispatchEvent({ type: 'hashchange' });
  const location = {
    search: '',
    pathname: '/',
    get hash() {
      return steps[at];
    },
    set hash(to: string) {
      steps.splice(at + 1, steps.length, to);
      at = steps.length - 1;
      changed();
    },
  };
  const history = {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => void (steps[at] = url.slice(url.indexOf('#'))),
  };
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', history);
  return {
    steps,
    get at() {
      return at;
    },
    back: () => {
      at = Math.max(0, at - 1);
      changed();
    },
    forward: () => {
      at = Math.min(steps.length - 1, at + 1);
      changed();
    },
  };
}

const row = (i: number) => ({ runId: `01M5MXZ4Q3FWR1ND46Y5PGV${String(i).padStart(3, '0')}`, parentRunId: null, depth: 0, mode: 'record', status: 'completed', label: 'recording', divergence: null, command: 'node agent.mjs', about: { text: `ticket ${i}`, from: 'user' }, codeVersion: null, startedAt: 1_760_000_000_000 - i * 60_000, endedAt: 1_760_000_000_000 - i * 60_000 + 5000, calls: 12, spent: 0.01, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], origins: 'llllllllllll' });

/** Twelve weeks with no run in them, as the days row reads them. */
const NO_DAYS: RunsByDay = { tz: 'UTC', weeks: 12, today: '2026-01-05', from: 0, to: 0, days: [], thresholds: null, totals: { runs: 0, failed: 0, all: 0, busiest: null } };

function server() {
  const asked: RunsQuery[] = [];
  const client = {
    exported: false,
    runsPage: (q: RunsQuery) => {
      asked.push(q);
      return Promise.resolve({ runs: [row(1), row(2)], total: 2, next: null, chipCounts: { all: 2, recording: 2, fork: 0, clean: 0, test: 0, capture: 0, failed: 0, local: 0 } });
    },
    runsByDay: () => new Promise(() => undefined),
    teamStore: () => Promise.resolve(null),
    knownRuns: (ids: string[]) => Promise.resolve(ids),
  } as unknown as Client;
  return { client, asked };
}

const app = (client: Client) => ({ client, exported: false, meta: null, tick: 0, runsTick: 0, feeds: {}, actionsOff: null, hasKind: () => false, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined }) as unknown as AppState;

/** Runs as the shell routes to it: the address's filter. */
function Routed() {
  const route = useRoute();
  return route.page === 'runs' ? createElement(RunsPage, { filter: route.filter }) : null;
}

/** The nav's Runs, drawn beside the page as the sidebar's is. */
function NavRuns() {
  return createElement('a', { className: 'navruns', href: useLastRunsHref() }, 'Runs');
}
const navRuns = () => r!.one('a.navruns').getAttribute('href');

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

const pressed = () => r!.all('.tbar .chips button[aria-pressed="true"]').map((b) => b.childNodes[0].textContent);
const chip = (label: string) => r!.all('.tbar .chips button').find((b) => b.childNodes[0].textContent === label)!;

describe('Runs, from its address', () => {
  it('shows what a link asks for, a step in the history for each chip and sort, and Back to what it showed before', async () => {
    const bar = addressBar('#/runs?q=refund&types=failed&sort=spent&from=2026-10-20&to=2026-10-22');
    const { client, asked } = server();
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(Routed)));
    await r.until('the first page', () => asked.length > 0);
    // The table asks for what the link asked for, the days as the viewer's own, before the calendar has come.
    const t = dayTimes({ from: '2026-10-20', to: '2026-10-22' })!;
    expect(asked[0]).toMatchObject({ types: ['failed'], q: 'refund', sort: 'spent', from: t.from, to: t.to });
    expect(pressed()).toEqual(['Failed']);
    expect(r.one('.tbar input[type="search"]').value).toBe('refund');
    expect(r.one('th[aria-sort="descending"]').textContent).toBe('Spent ↓');

    // A chip: a step of its own, the rest kept.
    await r.click(chip('All'));
    expect(bar.steps).toEqual(['#/runs?q=refund&types=failed&sort=spent&from=2026-10-20&to=2026-10-22', '#/runs?q=refund&sort=spent&from=2026-10-20&to=2026-10-22']);
    await r.until('the rows of every kind', () => asked.some((q) => !q.types?.length));
    expect(pressed()).toEqual(['All']);
    // The sort: another step.
    await r.click(r.byText('th button', 'Calls'));
    expect(bar.steps.at(-1)).toBe('#/runs?q=refund&sort=calls&from=2026-10-20&to=2026-10-22');

    // Back, twice: the views it showed, in turn.
    bar.back();
    await r.until('sorted by spend again', () => r!.all('th[aria-sort="descending"]')[0]?.textContent === 'Spent ↓');
    bar.back();
    await r.until('Failed again', () => pressed()[0] === 'Failed');
    expect(asked.at(-1)).toMatchObject({ types: ['failed'], sort: 'spent' });
    // And Forward.
    bar.forward();
    await r.until('All again', () => pressed()[0] === 'All');
  });

  it('puts the words typed in the address once they settle, in place of the step they were typed in', async () => {
    const bar = addressBar('#/runs?types=fork');
    const { client, asked } = server();
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(Routed)));
    await r.until('the first page', () => asked.length > 0);
    await r.type(r.one('.tbar input[type="search"]'), 'refund ');
    await r.until('the words in the address', () => bar.steps[0] !== '#/runs?types=fork');
    expect(bar.steps).toEqual(['#/runs?q=refund&types=fork']);
    expect(asked.at(-1)).toMatchObject({ q: 'refund ', types: ['fork'] });
    // The space typed at the end stays in the field, though the address holds the words alone.
    expect(r.one('.tbar input[type="search"]').value).toBe('refund ');
  });

  it('opens on #/runs alone with every run, and the nav’s Runs on the view it showed last', async () => {
    addressBar('#/runs?types=fork&sort=calls');
    const { client, asked } = server();
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(Routed), createElement(NavRuns)));
    await r.until('the first page', () => asked.length > 0);
    expect(navRuns()).toBe('#/runs?types=fork&sort=calls');
    expect(lastViewOf('#/runs')).toBe('#/runs?types=fork&sort=calls');
    expect(lastViewOf('#/fixes')).toBe('#/fixes');
    // The nav's link follows the view as it changes.
    await r.click(chip('All'));
    await r.until('the link moved', () => navRuns() === '#/runs?sort=calls');
    expect(lastRunsHref()).toBe('#/runs?sort=calls');
    await r.unmount();
    r = null;
    vi.unstubAllGlobals();
    // Later, from the sidebar's all or the Overview: every run, the address as it was.
    const bar = addressBar('#/runs');
    asked.length = 0;
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(Routed)));
    await r.until('the first page', () => asked.length > 0);
    expect(bar.steps).toEqual(['#/runs']);
    expect(asked[0]).toMatchObject({ sort: 'when' });
    expect(asked[0]?.types ?? []).toEqual([]);
    expect(pressed()).toEqual(['All']);
    expect(lastRunsHref()).toBe('#/runs');
  });

  it('writes the address in the one form it reads, in place of its step', async () => {
    const bar = addressBar('#/runs?TYPES=Forks&Sort=SPENT&q=refund%20A&from=2026-02-30');
    const { client, asked } = server();
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(Routed)));
    await r.until('the first page', () => asked.length > 0);
    expect(bar.steps).toEqual(['#/runs?q=refund+A&types=fork&sort=spent']);
    expect(asked[0]).toMatchObject({ types: ['fork'], q: 'refund A', sort: 'spent', from: null, to: null });
    expect(r.one('.tbar input[type="search"]').value).toBe('refund A');
  });

  it('makes Enter a step of its own, Back undoing the words typed and the step together, and a chip keeps the focus', async () => {
    const bar = addressBar('#/runs?types=fork');
    const { client, asked } = server();
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(Routed)));
    await r.until('the first page', () => asked.length > 0);
    const field = () => r!.one('.tbar input[type="search"]');
    await r.type(field(), 'refund');
    await r.until('the words in the address', () => bar.steps[0] !== '#/runs?types=fork');
    expect(bar.steps).toEqual(['#/runs?q=refund&types=fork']);
    await r.press('Enter', {}, field());
    expect(bar.steps).toEqual(['#/runs?types=fork', '#/runs?q=refund&types=fork']);
    // More words, then a chip: one step, the words with it.
    await r.type(field(), 'refund A');
    await r.until('the words in the address', () => bar.steps.at(-1) === '#/runs?q=refund+A&types=fork');
    expect(bar.steps).toHaveLength(2);
    await r.click(chip('All'));
    expect(bar.steps).toEqual(['#/runs?types=fork', '#/runs?q=refund&types=fork', '#/runs?q=refund+A']);
    expect(r.document.activeElement).toBe(chip('All'));
    // Back: the step before the chip as it was committed, its words and its chip.
    bar.back();
    await r.until('Forks again', () => pressed()[0] === 'Forks');
    expect(field().value).toBe('refund');
    bar.back();
    await r.until('no words', () => field().value === '');
    expect(pressed()).toEqual(['Forks']);
  });

  it('gives a view back where its list was left, once its rows and the twelve weeks above them are in', async () => {
    addressBar('#/runs?types=fork');
    const { client } = server();
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(Routed)));
    await r.until('the rows', () => r!.all('table.runst tbody tr').length > 0);
    (window as unknown as { scrollY: number }).scrollY = 640;
    // A row opened: the page goes.
    await r.unmount();
    r = null;
    // Back to it: the rows, then the weeks, come once the spy is in place.
    let rows: () => void = () => undefined;
    let weeks: () => void = () => undefined;
    const rowsIn = new Promise<void>((res) => (rows = res));
    const weeksIn = new Promise<void>((res) => (weeks = res));
    const slow: Client = { ...client, runsPage: (q: RunsQuery) => rowsIn.then(() => client.runsPage(q)), runsByDay: () => weeksIn.then(() => NO_DAYS) };
    r = await render(createElement(AppContext.Provider, { value: app(slow) }, createElement(Routed)));
    const to = vi.fn();
    (window as unknown as { scrollTo: typeof to }).scrollTo = to;
    expect(to).not.toHaveBeenCalled();
    rows();
    await r.until('the rows', () => r!.all('table.runst tbody tr').length > 0);
    // The weeks' sentence can take a second line: given back before it, the list would sit that much higher.
    await r.wait(50);
    expect(to).not.toHaveBeenCalled();
    weeks();
    await r.until('the place given back, and again after a tick', () => to.mock.calls.length >= 2);
    expect(to.mock.calls).toEqual([
      [0, 640],
      [0, 640],
    ]);
  });
});
