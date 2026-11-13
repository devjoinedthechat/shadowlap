import { act, createElement, useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRoute, routeHref } from '../ui/route.js';
import { onAddressMove, useRoute } from '../ui/router.js';
import { commitRuns, replaceRuns, useRunsAddress } from '../ui/runspage/history.js';
import { ALL_RUNS, runsHref, runsLinkQuery } from '../ui/runspage/query.js';
import { forgetScroll, useKeptScroll } from '../ui/runspage/scroll.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Runs' place in its list, kept for the view the address leaves and given back to that view alone.
 * The router tells of a move before it draws the route the move brings, the page still as it was: in
 * a browser React draws a hashchange's route before the event's later listeners run. The address bar
 * here tells of a move as a browser does, in a task of its own, naming the address it had. The fake
 * page has no layout: the page is given a height to scroll.
 */

const g = globalThis as Record<string, unknown>;
const recordings = runsLinkQuery('#/runs?types=recording')!;
const REC = runsHref(recordings);
const TYPED = runsHref({ ...recordings, q: 'ticket' });
const ALL = runsHref(ALL_RUNS);

let r: Rendered | null = null;

/** The address bar as a browser has it: set, it says so in a task of its own (`told`), naming the address it had; a replace says nothing. */
function addressBar(start: string) {
  let hash = start;
  let had = start;
  const bar = {
    pathname: '/',
    search: '',
    get hash() {
      return hash;
    },
    set hash(to: string) {
      had = hash;
      hash = to;
    },
  };
  Object.assign(g, { location: bar, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (hash = url.slice(url.indexOf('#'))) } });
  const told = () => act(async () => void window.dispatchEvent(Object.assign(new Event('hashchange'), { oldURL: `http://127.0.0.1:4100/${had}`, newURL: `http://127.0.0.1:4100/${hash}` })));
  return {
    told,
    async went(to: string): Promise<void> {
      bar.hash = to;
      await told();
    },
  };
}

interface Api {
  ready?: (ready: boolean) => void;
}

/** Runs as far as its place goes: the route followed, the address kept in Runs' one form, its rows in (`ready`) or still to come. */
function Runs({ api }: { api: Api }) {
  const route = useRoute();
  const f = useMemo(() => (route.page === 'runs' ? (route.filter ?? ALL_RUNS) : ALL_RUNS), [route]);
  useRunsAddress(f);
  const [ready, setReady] = useState(true);
  api.ready = setReady;
  useKeptScroll(runsHref(f), ready);
  return createElement('main', { id: 'view' }, createElement('div', { className: 'page' }));
}

/** The page as a browser lays it out with rows in: 480px of a list 1,500px tall, so it scrolls. */
function laidOut(page: Rendered): FakeElement {
  const pg = page.one('#view .page');
  Object.defineProperty(pg, 'clientHeight', { value: 480 });
  Object.defineProperty(pg, 'scrollHeight', { value: 1500 });
  return pg;
}

describe("Runs' place in its list", () => {
  beforeEach(() => vi.stubGlobal('getComputedStyle', () => ({ overflowY: 'auto' })));
  afterEach(async () => {
    await r?.unmount();
    r = null;
    delete g.location;
    delete g.history;
    vi.unstubAllGlobals();
    for (const href of [REC, TYPED, ALL]) forgetScroll(href);
  });

  it('is told of an address move by the router before the route the move brings is drawn', async () => {
    const bar = addressBar(ALL);
    const Shown = () => createElement('p', null, routeHref(useRoute()));
    r = await render(createElement(Shown));
    const shown = r.one('p');
    const heard: string[] = [];
    const off = onAddressMove((e) => heard.push(`${new URL(e.oldURL).hash} ${shown.textContent}`));
    await bar.went(REC);
    expect(heard).toEqual([`${ALL} ${routeHref(parseRoute(ALL))}`]);
    expect(shown.textContent).toBe(routeHref(parseRoute(REC)));
    off();
    await bar.went(ALL);
    expect(heard).toHaveLength(1);
  });

  it('keeps the place of the view a commit leaves, though the words typed in its place already show the view it lands on', async () => {
    const bar = addressBar(REC);
    const api: Api = {};
    r = await render(createElement(Runs, { api }));
    const page = laidOut(r);
    // The words take the place of the step they were typed in as they settle; Enter makes them a step of their own.
    await act(async () => replaceRuns({ ...recordings, q: 'ticket' }));
    page.scrollTop = 60;
    await act(async () => commitRuns({ ...recordings, q: 'ticket' }));
    await bar.told();
    page.scrollTop = 150;
    // Its rows read again, as a refresh reads them: nothing is given back over the reader's place.
    await act(async () => api.ready!(false));
    await act(async () => api.ready!(true));
    await r.wait(10);
    expect(page.scrollTop).toBe(150);
  });

  it('keeps the place of the view Back leaves, and gives the view it goes back to where that one was left', async () => {
    const bar = addressBar(REC);
    r = await render(createElement(Runs, { api: {} }));
    const page = laidOut(r);
    page.scrollTop = 300;
    // A chip: every run, a step of its own, starting where the page is.
    await act(async () => commitRuns(ALL_RUNS));
    await bar.told();
    await r.wait(10);
    expect(page.scrollTop).toBe(300);
    page.scrollTop = 100;
    await bar.went(REC);
    await r.wait(10);
    expect(page.scrollTop).toBe(300);
    await bar.went(ALL);
    await r.wait(10);
    expect(page.scrollTop).toBe(100);
  });

  it('keeps the view still drawn for an address move the page tells of itself, with no old address', async () => {
    addressBar(REC);
    r = await render(createElement(Runs, { api: {} }));
    const page = laidOut(r);
    page.scrollTop = 250;
    location.hash = ALL;
    await act(async () => void window.dispatchEvent(new Event('hashchange')));
    page.scrollTop = 0;
    location.hash = REC;
    await act(async () => void window.dispatchEvent(new Event('hashchange')));
    await r.wait(10);
    expect(page.scrollTop).toBe(250);
  });
});
