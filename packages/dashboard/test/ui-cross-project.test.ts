import { act, createElement, useMemo, useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, type Client } from '../ui/api.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import { ChangesPage } from '../ui/pages/Changes.js';
import { ComparePage } from '../ui/pages/Compare.js';
import { Elsewhere } from '../ui/pages/held-elsewhere.js';
import { RunPage } from '../ui/pages/Run.js';
import { showProject, type HoldingView } from '../ui/projects-api.js';
import { useRoute } from '../ui/router.js';
import { unshownKey, useHeldBy, useUnshown } from '../ui/shell/unshown.js';
import { AppContext, type AppState } from '../ui/state.js';
import { docTitle } from '../ui/title.js';
import type { RunDetail, RunListItem } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';
import { withServed } from './ui-served-now.js';

/**
 * A page that can't find what its address names asks whether another project holds it before it
 * says so (pages/held-elsewhere.tsx, pages/Elsewhere.tsx): its own loading look meanwhile, then the
 * In page with Switch to, or its own not-found. It asks once for each thing and project shown, again
 * only after an ask that failed, never on an exported copy or a dashboard that serves one store; and
 * Switch to holds the page until the page it opens has read again. A run's page, a fix's and
 * Compare's each ask so, for what their address names that their store can't.
 */

const RUN = '01M5GRVTKSJ12EE2SE9YZ5W4J3';
const HERE = 'triage-bot';
const THERE = 'support-agent';

let page: Rendered | null = null;
const g = globalThis as Record<string, unknown>;
const saved = { location: g.location, history: g.history };
afterEach(async () => {
  await page?.unmount();
  page = null;
  Object.assign(g, saved);
  showProject(null);
});

/** The address bar, as the router reads it. */
function addressBar(hash: string): { hash: string } {
  const location = { hash, pathname: '/', search: '' };
  Object.assign(g, { location, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => (location.hash = url.slice(url.indexOf('#'))) } });
  return location;
}

const answer = (held: string | null, current = HERE): HoldingView => ({ current: { id: current, name: current }, held: held ? { project: { id: held, name: held }, id: RUN } : null });

interface World {
  holding: Array<[string, readonly string[]]>;
  selected: string[];
  reloads: number;
  retries: number;
  toasts: string[];
  /** The page's read, failing anew. */
  failAgain(): void;
  /** The page's read, finding it: the page draws instead. */
  found(): void;
}

/**
 * A run's page in `HERE` that can't find RUN, asking with `holding`; `select` answers the switch,
 * after which the meta names the project switched to, and the reload ends once `runsLoaded` has.
 * `exported`, `project: null` (one store).
 */
async function open(o: { holding: (n: number) => Promise<HoldingView | null>; select?: () => Promise<unknown>; runsLoaded?: Promise<void>; exported?: boolean; project?: string | null; retry?: boolean }): Promise<World> {
  addressBar(`#/run/${RUN}/3/context`);
  const w: World = { holding: [], selected: [], reloads: 0, retries: 0, toasts: [], failAgain: () => undefined, found: () => undefined };
  const project = o.project === undefined ? HERE : o.project;
  showProject(project);
  function Harness() {
    const [shown, setShown] = useState(project);
    const [error, setError] = useState<Error | null>(new Error(`no run ${RUN}`));
    const [there, setThere] = useState(false);
    w.failAgain = () => act(() => setError(new Error(`no run ${RUN}`)));
    w.found = () => act(() => setThere(true));
    const app = useMemo(
      () =>
        ({
          client: {
            projects: {
              holding: (what: string, ids: readonly string[]) => {
                w.holding.push([what, ids]);
                return o.holding(w.holding.length);
              },
              select: (id: string) => {
                w.selected.push(id);
                return (o.select ?? (() => Promise.resolve({ current: id, name: id })))();
              },
            },
          } as unknown as Client,
          exported: o.exported ?? false,
          meta: shown ? { project: { id: shown, name: shown, path: `/home/${shown}` } } : { static: o.exported ?? false },
          conn: 'ok',
          actionsOff: null,
          tick: 0,
          runsTick: 0,
          feeds: {},
          jobs: [],
          live: [],
          runs: [],
          hasKind: () => true,
          guard: (fn: () => void) => (fn(), true),
          toast: (text: string) => void w.toasts.push(text),
          reload: () => {
            w.reloads++;
            const now = w.selected.at(-1) ?? shown;
            showProject(now);
            setShown(now);
            return o.runsLoaded ?? Promise.resolve();
          },
        }) as unknown as AppState,
      [shown],
    );
    const retry = () => void w.retries++;
    return createElement(
      AppContext.Provider,
      { value: app },
      there
        ? createElement('h1', { className: 'drawn' }, RUN)
        : createElement(Elsewhere, {
            ask: { what: 'run', ids: [RUN] },
            error,
            waiting: createElement('p', { className: 'waiting' }, 'Loading the run…'),
            ...(o.retry === false ? {} : { retry }),
            fallback: createElement('p', { className: 'notfound' }, `No run ${RUN} in this store.`),
          }),
    );
  }
  page = await render(withServed(createElement(Harness)));
  return w;
}

describe('a link another project holds', () => {
  it('waits on the page’s own look while it asks, then says which project holds it, with Switch to that project in lime', async () => {
    let answered: (v: HoldingView) => void = () => undefined;
    const w = await open({ holding: () => new Promise((resolve) => (answered = resolve)) });
    await page!.until('the ask', () => w.holding.length === 1);
    expect(page!.all('.waiting')).toHaveLength(1);
    expect(page!.all('.notfound')).toHaveLength(0);
    answered(answer(THERE));
    await page!.until('the In page', () => page!.all('h1').length > 0);
    expect(w.holding).toEqual([['run', [RUN]]]);
    expect(page!.one('h1').textContent).toBe(`In ${THERE}`);
    expect(page!.one('.ph p').textContent).toBe(`The run ${RUN} is in ${THERE}’s store, not ${HERE}’s.`);
    // The id whole in mono, each name whole.
    expect(page!.one('.ph p code.rnm').textContent).toBe(RUN);
    expect(page!.all('.ph .nw').map((e) => e.textContent)).toEqual([THERE, `${THERE}’s`, `${HERE}’s`]);
    expect(page!.one('.ph .actions button').className).toBe('btn lime');
    expect(page!.one('.ph .actions button').textContent).toBe(`Switch to ${THERE}`);
  });

  it('shows the page’s own not-found when no other project holds it, asking once however often the page’s read fails', async () => {
    const w = await open({ holding: () => Promise.resolve(answer(null)) });
    await page!.until('the not-found', () => page!.all('.notfound').length === 1);
    w.failAgain();
    await page!.wait(20);
    w.failAgain();
    await page!.wait(20);
    expect(w.holding).toHaveLength(1);
    expect(page!.all('.notfound')).toHaveLength(1);
  });

  it('asks again when the page’s read fails anew only after an ask that failed', async () => {
    const w = await open({ holding: (n) => (n === 1 ? Promise.reject(new Error('Failed to fetch')) : Promise.resolve(answer(THERE))) });
    await page!.until('the not-found', () => page!.all('.notfound').length === 1);
    w.failAgain();
    await page!.until('the In page', () => page!.all('h1').length === 1);
    expect(w.holding).toHaveLength(2);
    expect(page!.one('h1').textContent).toBe(`In ${THERE}`);
  });

  it('never asks on an exported copy, nor on a dashboard that serves one store', async () => {
    for (const o of [{ exported: true, project: null }, { project: null }]) {
      const w = await open({ ...o, holding: () => Promise.resolve(answer(THERE)) });
      await page!.wait(20);
      expect(w.holding).toEqual([]);
      expect(page!.all('.notfound')).toHaveLength(1);
      await page!.unmount();
      page = null;
    }
  });

  it('turns to the project the dashboard switched to elsewhere when the answer names it', async () => {
    const w = await open({ holding: () => Promise.resolve(answer(THERE, 'research-agent')) });
    await page!.until('the page to turn', () => w.reloads === 1);
    expect(page!.all('h1')).toHaveLength(0);
  });
});

describe('Switch to', () => {
  it('switches, keeps the address, and holds the page busy until the page it opens has read again', async () => {
    const w = await open({ holding: (n) => Promise.resolve(n === 1 ? answer(THERE) : answer(null, THERE)) });
    await page!.until('the In page', () => page!.all('h1').length === 1);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the switch', () => w.reloads === 1);
    expect(w.selected).toEqual([THERE]);
    expect((g.location as { hash: string }).hash).toBe(`#/run/${RUN}/3/context`);
    expect(w.retries).toBe(1);
    // Still the In page, busy, its button off: no ask for the project switched to yet.
    expect(page!.one('h1').textContent).toBe(`In ${THERE}`);
    expect(page!.one('.page').attributes.get('aria-busy')).toBe('true');
    expect(page!.one('.ph .actions button').attributes.has('disabled')).toBe(true);
    expect(w.holding).toHaveLength(1);
    // The page read it: the page draws.
    w.found();
    await page!.until('the page', () => page!.all('h1.drawn').length === 1);
    expect(w.holding).toHaveLength(1);
  });

  it('holds through the page’s reads that fail before the switch lands, as a recording in the project it showed makes them', async () => {
    let selected: () => void = () => undefined;
    let runsLoaded: () => void = () => undefined;
    const w = await open({
      holding: (n) => Promise.resolve(n === 1 ? answer(THERE) : answer(null, THERE)),
      select: () => new Promise((resolve) => (selected = () => resolve({ current: THERE, name: THERE }))),
      runsLoaded: new Promise((resolve) => (runsLoaded = resolve)),
    });
    await page!.until('the In page', () => page!.all('h1').length === 1);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the switch to be asked', () => w.selected.length === 1);
    w.failAgain();
    await page!.wait(20);
    w.failAgain();
    await page!.wait(20);
    // The meta names the project switched to, its runs still on their way: a read sent before the switch fails now.
    selected();
    await page!.until('the meta', () => w.reloads === 1);
    w.failAgain();
    await page!.wait(20);
    expect(page!.one('.page').attributes.get('aria-busy')).toBe('true');
    expect(page!.one('.ph .actions button').attributes.has('disabled')).toBe(true);
    expect([w.holding.length, w.retries]).toEqual([1, 0]);
    runsLoaded();
    await page!.until('the page to be asked to read again', () => w.retries === 1);
    expect(page!.one('.page').attributes.get('aria-busy')).toBe('true');
    // The page read it there: it draws, never having asked again or said it isn't here.
    w.found();
    await page!.until('the page', () => page!.all('h1.drawn').length === 1);
    expect(w.holding).toHaveLength(1);
  });

  it('asks again once the page it opens can’t find it there either', async () => {
    const w = await open({ holding: (n) => Promise.resolve(n === 1 ? answer(THERE) : answer(null, THERE)) });
    await page!.until('the In page', () => page!.all('h1').length === 1);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the switch', () => w.reloads === 1);
    w.failAgain();
    await page!.until('the not-found', () => page!.all('.notfound').length === 1);
    expect(w.holding).toHaveLength(2);
  });

  it('says why a refused switch was refused, and asks again', async () => {
    const w = await open({ holding: (n) => Promise.resolve(n === 1 ? answer(THERE) : answer(null)), select: () => Promise.reject(new Error(`No project ${THERE}.`)) });
    await page!.until('the In page', () => page!.all('h1').length === 1);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the not-found', () => page!.all('.notfound').length === 1);
    expect(w.toasts).toEqual([`No project ${THERE}.`]);
    expect(w.reloads).toBe(0);
    expect(w.holding).toHaveLength(2);
  });

  it('in the setup’s place, with no read of its own, asks again once the switch has landed', async () => {
    const w = await open({ holding: (n) => Promise.resolve(n === 1 ? answer(THERE) : answer(null, THERE)), retry: false });
    await page!.until('the In page', () => page!.all('h1').length === 1);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the not-found', () => page!.all('.notfound').length === 1);
    expect(w.holding).toEqual([
      ['run', [RUN]],
      ['run', [RUN]],
    ]);
  });
});

// The pages that ask: a run's, a fix's and Compare's, each drawn as the shell draws it.

const FIX = 'fx-01M5GMZKCV0000000000000000';
const SESSION = 'dc-01M5GT0000000000000000000A';
const A = '01M5GRXFM1Y2E2VBPFX0TV2TGA';
const B = '01M5GRYHR0BT1ATQFZP3EQR1MZ';
const ELSE = ['01M5GS00000000000000000001', '01M5GS00000000000000000002'];

/** A run's page as the server sends it, with only what Compare reads: a run with no replay, fork or parent. */
const detail = (runId: string) =>
  ({ run: { runId, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: null, startedAt: 1, endedAt: 2 }, parent: null, children: [], source: null, calls: [], summary: {} }) as unknown as RunDetail;

const listed = (runId: string) => ({ runId, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node agent.mjs', codeVersion: null, startedAt: 1, calls: 3, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [] }) as unknown as RunListItem;

/**
 * What each store holds: `here` the runs triage-bot's lists and reads, `several` ids that start
 * several of its runs' ids (a 409), any other a 404; `there` support-agent's, any other read there
 * waiting, so the page holds. A fix is a 404 here, a comparison a 500 in both.
 */
interface Stores {
  here?: string[];
  several?: string[];
  there?: string[];
}

/** The tab's title, as the shell works it out for the address and what the page notes. */
function TabTitle() {
  const route = useRoute();
  const at = unshownKey(route);
  return createElement('i', { className: 'tabtitle' }, docTitle(route, { unshown: useUnshown(at), heldBy: useHeldBy(at) }));
}

/**
 * `draw` at `hash` in triage-bot, with every read and ask the page makes said in order. The server
 * says support-agent holds the first id asked until it serves support-agent, which `select` makes it
 * do; the reload after it has the meta and the runs follow. `copy`: an exported copy; `oneStore`: a
 * dashboard that serves one store.
 */
async function openPage(hash: string, draw: () => ReactElement, o: Stores & { copy?: boolean; oneStore?: boolean } = {}): Promise<string[]> {
  addressBar(hash);
  const said: string[] = [];
  const asked = <T>(line: string, answer: () => Promise<T>): Promise<T> => (said.push(line), answer());
  let now = HERE;
  const run = (id: string): Promise<RunDetail> => {
    if (now !== HERE) return o.there?.includes(id) ? Promise.resolve(detail(id)) : new Promise(() => undefined);
    if (o.several?.includes(id)) return Promise.reject(new ApiError(409, `run id prefix ${id} matches several runs: use more of the id`));
    return o.here?.includes(id) ? Promise.resolve(detail(id)) : Promise.reject(new ApiError(404, `no run ${id}`));
  };
  const client = {
    exported: !!o.copy,
    jobs: () => Promise.resolve([]),
    run: (id: string) => asked(`run ${id}`, () => run(id)),
    fix: (id: string) => asked(`fix ${id}`, () => (now === HERE ? Promise.reject(new ApiError(404, `no fix ${id}`)) : new Promise(() => undefined))),
    // Previews: none listed, a session by its id a 404 here and waiting there.
    decisionSessions: () => asked('previews', () => Promise.resolve({ sessions: [], goldens: 1 })),
    decisionSession: (id: string) => asked(`preview ${id}`, () => (now === HERE ? Promise.reject(new ApiError(404, `no preview ${id}`)) : new Promise(() => undefined))),
    compare: (a: string, b: string) => asked(`compare ${a} ${b}`, () => Promise.reject(new ApiError(500, 'the comparison failed'))),
    compareHead: (a: string, b: string) => asked(`head ${a} ${b}`, () => Promise.resolve(null)),
    projects: {
      holding: (what: string, ids: readonly string[]) => asked(`holding ${what} ${ids.join(' ')}`, () => Promise.resolve<HoldingView>({ current: { id: now, name: now }, held: now === HERE ? { project: { id: THERE, name: THERE }, id: ids[0] } : null })),
      select: (id: string) => asked(`select ${id}`, () => ((now = id), Promise.resolve({ current: id, name: id }))),
    },
  } as unknown as Client;
  const one = o.copy || o.oneStore;
  showProject(one ? null : HERE);
  function Harness() {
    const [shown, setShown] = useState(HERE);
    const app = useMemo(
      () =>
        ({
          client,
          exported: !!o.copy,
          meta: o.copy ? { static: true } : { project: one ? { name: HERE, path: `/home/${HERE}` } : { id: shown, name: shown, path: `/home/${shown}` } },
          runs: ((shown === HERE ? o.here : o.there) ?? []).map(listed),
          ...{ conn: 'ok', actionsOff: null, tick: 0, runsTick: 0, feeds: {}, jobs: [], live: [] },
          hasKind: () => true,
          guard: (fn: () => void) => (fn(), true),
          watchJob: () => undefined,
          toast: (text: string) => void said.push(`toast ${text}`),
          reload: () => {
            said.push('reload');
            showProject(now);
            setShown(now);
            return Promise.resolve();
          },
        }) as unknown as AppState,
      [shown],
    );
    return createElement(AppContext.Provider, { value: app }, createElement(TabTitle), draw());
  }
  page = await render(withServed(createElement(Harness)));
  return said;
}

/** The In page for what `id` names: its title, its line, Switch in lime, and the tab's title naming the project that holds it. */
async function inPage(id: string, what = 'run'): Promise<void> {
  await page!.until('the In page', () => page!.all('h1').some((h) => h.textContent === `In ${THERE}`));
  expect(page!.one('.ph p').textContent).toBe(`The ${what} ${id} is in ${THERE}’s store, not ${HERE}’s.`);
  const button = page!.one('.ph .actions button');
  expect([button.className, button.textContent]).toEqual(['btn lime', `Switch to ${THERE}`]);
  expect(page!.one('.tabtitle').textContent).toBe(`In ${THERE} — shadowlap`);
}

const busy = () => page!.one('.page').attributes.get('aria-busy') === 'true';

describe('a run’s page and a fix’s', () => {
  it('a run another project holds: In support-agent, and Switch reads it there, holding at the same call until it answers', async () => {
    const said = await openPage(`#/run/${A}/2`, () => createElement(RunPage, { id: A, call: 2, view: null }));
    await inPage(A);
    expect(said).toEqual([`run ${A}`, `holding run ${A}`]);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the run read there', () => said.length === 5);
    expect(said.slice(2)).toEqual([`select ${THERE}`, 'reload', `run ${A}`]);
    expect((g.location as { hash: string }).hash).toBe(`#/run/${A}/2`);
    expect(busy()).toBe(true);
  });

  it('a fix another project holds: the same, at the same step', async () => {
    const said = await openPage(`#/fixes/${FIX}/verify`, () => createElement(FixPage, { id: FIX, step: 'verify', sub: null }));
    await inPage(FIX, 'fix');
    expect(said).toEqual([`fix ${FIX}`, `holding fix ${FIX}`]);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the fix read there', () => said.length === 5);
    expect(said.slice(2)).toEqual([`select ${THERE}`, 'reload', `fix ${FIX}`]);
    expect((g.location as { hash: string }).hash).toBe(`#/fixes/${FIX}/verify`);
    expect(busy()).toBe(true);
  });

  it('asks nothing on an exported copy or a dashboard that serves one store, where each page says it isn’t there', async () => {
    const pages: Array<[string, () => ReactElement, string]> = [
      [`#/run/${A}`, () => createElement(RunPage, { id: A, call: null, view: null }), `No run ${A}`],
      [`#/fixes/${FIX}`, () => createElement(FixPage, { id: FIX, step: null, sub: null }), `No fix ${FIX}`],
      [`#/compare/${A}`, () => createElement(ComparePage, { a: A, b: null }), `No run ${A}`],
      [`#/compare/${A}/${B}`, () => createElement(ComparePage, { a: A, b: B }), `No run ${A}`],
      [`#/changes/decisions/${SESSION}`, () => createElement(ChangesPage, { tab: 'decisions', id: SESSION }), `No preview ${SESSION}`],
    ];
    for (const [hash, draw, words] of pages)
      for (const o of [{ copy: true }, { oneStore: true }]) {
        const said = await openPage(hash, draw, { ...o, here: ELSE });
        await page!.until(`${hash}’s not-found`, () => page!.document.body.textContent.includes(words));
        await page!.wait(20);
        expect(said.filter((l) => l.startsWith('holding')), hash).toEqual([]);
        expect(page!.one('.tabtitle').textContent, hash).not.toMatch(/^In /);
        await page!.unmount();
        page = null;
      }
  });
});

describe('a preview', () => {
  it('another project holds: In support-agent in place of Changes’ head and tabs, and Switch reads it there, at the same cell', async () => {
    const said = await openPage(`#/changes/decisions/${SESSION}/${A}/3`, () => createElement(ChangesPage, { tab: 'decisions', id: SESSION, run: A, call: 3 }));
    await inPage(SESSION, 'preview');
    // The page whole: its one heading, and no tabs of Changes under it.
    expect([page!.all('h1').length, page!.all('nav.stabs').length]).toEqual([1, 0]);
    expect(said).toEqual(['previews', `preview ${SESSION}`, `holding preview ${SESSION}`]);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the preview read there', () => said.includes(`select ${THERE}`) && said.filter((l) => l === `preview ${SESSION}`).length === 2);
    expect(said.slice(3)).toEqual([`select ${THERE}`, 'reload', 'previews', `preview ${SESSION}`]);
    expect((g.location as { hash: string }).hash).toBe(`#/changes/decisions/${SESSION}/${A}/3`);
    // Under the head again, its tabs with it, while the read there comes.
    await page!.until('the head', () => page!.all('nav.stabs').length === 1);
    expect(page!.all('h1').map((h) => h.textContent)).toEqual(['Changes']);
  });
});

describe('Compare', () => {
  it('one run another project holds: asks for it, and Switch reads it there, where it is drawn', async () => {
    const said = await openPage(`#/compare/${A}`, () => createElement(ComparePage, { a: A, b: null }), { here: ELSE, there: [A] });
    await inPage(A);
    expect(said).toEqual([`run ${A}`, `holding run ${A}`]);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the run drawn there', () => page!.all('.stepempty h2').length === 1);
    expect(page!.one('.stepempty h2').textContent).toBe('Nothing to compare yet');
    expect(said.slice(2)).toEqual([`select ${THERE}`, 'reload', `run ${A}`]);
  });

  it('a pair: asks for the side this store doesn’t hold, never one that starts several of its runs’ ids, and Switch reads all four again there', async () => {
    const said = await openPage(`#/compare/${A}/${B}`, () => createElement(ComparePage, { a: A, b: B }), { here: ELSE, several: [A], there: [A, B] });
    await inPage(B);
    expect(said.filter((l) => l.startsWith('holding'))).toEqual([`holding run ${B}`]);
    const asked = said.length;
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the pair compared there', () => page!.all('.loaderr p > span').map((e) => e.textContent).join(' · ') === 'couldn’t load · the comparison failed');
    expect(said.slice(asked, asked + 2)).toEqual([`select ${THERE}`, 'reload']);
    expect(said.slice(asked + 2).sort()).toEqual([`compare ${A} ${B}`, `head ${A} ${B}`, `run ${A}`, `run ${B}`].sort());
    expect(page!.all('h1').map((h) => h.textContent)).not.toContain(`In ${THERE}`);
  });

  it('a pair with neither side here asks for both', async () => {
    const said = await openPage(`#/compare/${A}/${B}`, () => createElement(ComparePage, { a: A, b: B }), { here: ELSE });
    await inPage(A);
    expect(said.filter((l) => l.startsWith('holding'))).toEqual([`holding run ${A} ${B}`]);
  });

  it('a pair in a project with fewer than two runs: asks for both, and Switch compares them there', async () => {
    const said = await openPage(`#/compare/${A}/${B}`, () => createElement(ComparePage, { a: A, b: B }), { here: ELSE.slice(0, 1), there: [A, B] });
    await inPage(A);
    expect(said).toEqual([`holding run ${A} ${B}`]);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the pair compared there', () => page!.all('.loaderr p > span').map((e) => e.textContent).join(' · ') === 'couldn’t load · the comparison failed');
    expect(said.slice(1, 3)).toEqual([`select ${THERE}`, 'reload']);
    expect(said.slice(3).sort()).toEqual([`compare ${A} ${B}`, `head ${A} ${B}`, `run ${A}`, `run ${B}`].sort());
  });
});
