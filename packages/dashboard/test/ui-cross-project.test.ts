import { act, createElement, useMemo, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { Elsewhere } from '../ui/pages/held-elsewhere.js';
import { showProject, type HoldingView } from '../ui/projects-api.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A page that can't find what its address names asks whether another project holds it before it
 * says so (pages/held-elsewhere.tsx, pages/Elsewhere.tsx): its own loading look meanwhile, then the
 * In page with Switch to, or its own not-found. It asks once for each thing and project shown, again
 * only after an ask that failed, never on an exported copy or a dashboard that serves one store; and
 * Switch to holds the page until the page it opens has read again.
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
 * after which the meta names the project switched to. `exported`, `project: null` (one store).
 */
async function open(o: { holding: (n: number) => Promise<HoldingView | null>; select?: () => Promise<unknown>; exported?: boolean; project?: string | null; retry?: boolean }): Promise<World> {
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
            return Promise.resolve();
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
  page = await render(createElement(Harness));
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
    let landed: () => void = () => undefined;
    const w = await open({ holding: (n) => Promise.resolve(n === 1 ? answer(THERE) : answer(null, THERE)), select: () => new Promise((resolve) => (landed = () => resolve({ current: THERE, name: THERE }))) });
    await page!.until('the In page', () => page!.all('h1').length === 1);
    await page!.click(page!.one('.ph .actions button'));
    await page!.until('the switch to be asked', () => w.selected.length === 1);
    w.failAgain();
    await page!.wait(20);
    w.failAgain();
    await page!.wait(20);
    expect(page!.one('.page').attributes.get('aria-busy')).toBe('true');
    expect(page!.one('.ph .actions button').attributes.has('disabled')).toBe(true);
    expect(w.holding).toHaveLength(1);
    landed();
    await page!.until('the switch', () => w.reloads === 1);
    expect(w.retries).toBe(1);
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
