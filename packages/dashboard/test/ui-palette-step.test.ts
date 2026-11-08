import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Client } from '../ui/api.js';
import { BLAME_ENTRIES, blameAsksOnItsPage, blameEntries, matchPalette } from '../ui/palette.js';
import { stepEntry } from '../ui/run/next-step.js';
import { useRunCommands } from '../ui/run/run-commands.js';
import type { Route } from '../ui/route.js';
import { Palette } from '../ui/shell/Palette.js';
import { AppContext, type AppState, type PaletteCommand } from '../ui/state.js';
import type { BlameOffer, NextStep, RunDetail, RunListItem, RunOffers } from '../ui/types.js';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import { resetSpending } from '../ui/spending.js';
import { answerTestsQuestion, askQuestion, testsQuestion } from '../ui/tests-ask.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The palette says what a run's page leads with: This run's first entry is its next step, then what
 * else the page offers with none said twice, and Run blame for the newest failures nobody blamed is
 * found once something is typed, from what a list's rows say of them.
 */

const RUN = '01M5JEQWA2QMJ3NYD1C687WP08';
const PARENT = '01M5JEQXRGBX1QXGW0X8A3ZB4C';

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

function detail(next: NextStep | null, o: { actions?: unknown[]; replay?: NextStep; parent?: string; status?: string } = {}): RunDetail {
  return {
    run: { runId: RUN, parentRunId: o.parent ?? null, mode: 'record', status: o.status ?? 'completed', command: { argv: ['node', 'agent.mjs'], cwd: '.' }, meta: {} },
    actions: o.actions ?? [{ key: 'r', label: 'Replay' }],
    parent: o.parent ? { runId: o.parent, label: 'recording' } : null,
    source: null,
    ...(next ? { next } : {}),
    ...(o.replay ? { replay: o.replay } : {}),
  } as unknown as RunDetail;
}

/** What This run lists for a run's page, as the page's hook hands it to the palette. */
async function thisRun(run: RunDetail, app: Partial<AppState> = {}, offers: RunOffers | null = null): Promise<PaletteCommand[]> {
  let items: PaletteCommand[] = [];
  const Page = () => {
    useRunCommands({ run, selected: 3, canFork: true, canMark: false, labels: [], mark: () => undefined, offers, judged: run.judged ?? null, actions: { run: () => undefined, findCommit: () => undefined }, forkMenu: { openAt: () => undefined }, setView: () => undefined });
    return null;
  };
  const value = { client: { jobs: () => Promise.resolve([]) }, feeds: {}, jobs: [], meta: null, exported: false, actionsOff: null, hasKind: () => true, toast: () => undefined, setRunCommands: (x: PaletteCommand[]) => (x.length ? (items = x) : undefined), ...app } as unknown as AppState;
  r = await render(createElement(AppContext.Provider, { value }, createElement(Page)));
  await r.unmount();
  r = null;
  return items;
}

describe('This run', () => {
  it('offers Pack as golden… before Share… where another step leads, the pack as its hint, found by golden, keep and test', async () => {
    const folder = `goldens/${RUN.slice(0, 10).toLowerCase()}`;
    const offers = { keep: { folder } } as unknown as RunOffers;
    const blame: NextStep = { key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] }, command: `shadowlap blame ${RUN.slice(0, 10)}` };
    // A run's page has its calls and its summary, which say whether it failed.
    const page = (next: NextStep) => ({ ...detail(next), calls: [], summary: { cost: { spent: 0, saved: 0, captured: 0 }, imported: null } }) as unknown as RunDetail;
    const items = await thisRun(page(blame), {}, offers);
    const labels = items.map((x) => x.label);
    expect(labels.indexOf('Pack as golden…')).toBe(labels.indexOf('Share…') - 1);
    expect(items.find((x) => x.label === 'Pack as golden…')).toMatchObject({ group: 'This run', hint: `shadowlap pack ${RUN.slice(0, 10)} ${folder}`, job: true });
    for (const word of ['keep', 'test', 'golden']) expect(matchPalette(items, word).map((x) => x.label)).toContain('Pack as golden…');
    // Where it leads, its row is the step's; a copy, or a dashboard that can't start jobs, has none.
    const lead: NextStep = { key: 'pack', label: 'Pack as golden…', runId: RUN, folder, command: `shadowlap pack ${RUN.slice(0, 10)} ${folder}` };
    expect((await thisRun(page(lead), {}, offers)).filter((x) => x.label === 'Pack as golden…')).toHaveLength(1);
    expect((await thisRun(page(blame), { exported: true }, offers)).map((x) => x.label)).not.toContain('Pack as golden…');
    expect((await thisRun(page(blame), { actionsOff: 'Read-only' }, offers)).map((x) => x.label)).not.toContain('Pack as golden…');
    // A recording today's checks fail has none, as its first fact says: a golden made from it would pass on the failure.
    const failing = { ...page(blame), judged: { by: 'own', verdict: 'failed', counts: { passed: 0, failed: 1, inconclusive: 0, notApplicable: 0 }, callNo: 4, today: true } } as unknown as RunDetail;
    expect((await thisRun(failing, {}, offers)).map((x) => x.label)).not.toContain('Pack as golden…');
  });

  it('sets the next step’s key by what it presses, never by what it says', () => {
    const blame: NextStep = { key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] } };
    expect(stepEntry(blame).key).toBe('b');
    expect(stepEntry({ key: 'replay', label: 'Replay recording', runId: PARENT }).key).toBe('r');
    expect(stepEntry({ key: 'replay', label: 'Replay with your command…', runId: RUN }).key).toBe('r');
    expect(stepEntry({ key: 'compare', label: 'Compare with parent', parent: PARENT, href: `#/compare/${PARENT}/${RUN}` }).key).toBe('c');
    // A step no key presses has none: its own button, or a link the header has no key for.
    expect(stepEntry({ key: 'fix', label: 'Open fix', fixId: 'F1', status: 'open', check: 'exit code 0', href: '#/fixes/F1' })).not.toHaveProperty('key');
    expect(stepEntry({ key: 'pack', label: 'Pack as golden…', runId: RUN, folder: 'goldens/x' })).not.toHaveProperty('key');
  });

  it('leads with the run’s next step, its command as its hint, and offers it once', async () => {
    const blame: NextStep = { key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] }, command: `shadowlap blame ${RUN.slice(0, 10)}` };
    const items = await thisRun(detail(blame, { replay: { key: 'replay', label: 'Replay', runId: RUN, command: `shadowlap replay ${RUN.slice(0, 10)}` } }));
    expect(items.map((x) => x.label).slice(0, 3)).toEqual(['Run blame', 'Replay', 'Fork at #3…']);
    expect(items[0]).toMatchObject({ group: 'This run', hint: `shadowlap blame ${RUN.slice(0, 10)}`, job: true });
    expect(matchPalette(items, '')[0]?.label).toBe('Run blame');
  });

  it('says Replay once where it is the step, and the recording’s where a replay came from one', async () => {
    const replay: NextStep = { key: 'replay', label: 'Replay', runId: RUN, command: `shadowlap replay ${RUN.slice(0, 10)}` };
    expect((await thisRun(detail(replay))).filter((x) => x.label === 'Replay')).toHaveLength(1);
    const recording: NextStep = { key: 'replay', label: 'Replay recording', runId: PARENT, command: `shadowlap replay ${PARENT.slice(0, 10)}` };
    const compare: NextStep = { key: 'compare', label: 'Compare with parent', parent: PARENT, href: `#/compare/${PARENT}/${RUN}`, title: 'Against it', command: 'shadowlap diff a b' };
    const items = await thisRun(detail(compare, { replay: recording, parent: PARENT }));
    expect(items.map((x) => x.label).slice(0, 2)).toEqual(['Compare with parent', 'Replay']);
    expect(items[1]?.hint).toBe(`shadowlap replay ${PARENT.slice(0, 10)}`);
    expect(items.filter((x) => x.label === 'Compare with parent')).toHaveLength(1);
    // A link is no job: it goes on while the server can't be reached, and on a read-only dashboard.
    expect(items[0]?.job).toBeUndefined();
    expect((await thisRun(detail(compare, { parent: PARENT }), { actionsOff: 'read-only' }))[0]?.label).toBe('Compare with parent');
    expect((await thisRun(detail({ key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] } }), { actionsOff: 'read-only' })).map((x) => x.label)).not.toContain('Run blame');
  });

  it('leaves out a step that can’t start, and its own Find breaking commit… where that is the step', async () => {
    const recording: NextStep = { key: 'replay', label: 'Replay', runId: RUN, off: 'Replay once the recording finishes' };
    const live = await thisRun(detail(recording, { status: 'running' }));
    expect(live.map((x) => x.label)).not.toContain('Replay');
    const bisect: NextStep = { key: 'bisect', label: 'Find breaking commit', golden: 'goldens/x', starts: true, blame: null, command: 'shadowlap bisect goldens/x --good a' };
    const items = await thisRun(detail(bisect));
    expect(items.filter((x) => x.label.startsWith('Find breaking commit')).map((x) => x.label)).toEqual(['Find breaking commit']);
  });

  describe('while a job holds what the step needs', () => {
    const PROJECT = { project: { id: 'p1', path: '/work/project' } };
    const holding = (over: Record<string, unknown> = {}) => [{ job: { id: 'j1', kind: 'repair', done: false, project: { id: 'p1' }, worktree: { folder: '/work/project', use: 'writes', doing: 'a repair is running' }, ...over } }];
    const WAITS = 'A repair is running: blame once it is done.';
    const blame: NextStep = { key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] }, command: `shadowlap blame ${RUN.slice(0, 10)}` };

    it('says why as its hint, and on a pick, and presses nothing', async () => {
      const items = await thisRun(detail(blame), { meta: PROJECT, jobs: holding() } as unknown as Partial<AppState>);
      expect(items[0]).toMatchObject({ label: 'Run blame', hint: WAITS, wait: WAITS, job: true });
      const toast = vi.fn();
      const value = {
        client: { search: async () => ({ hits: [] }), runsPage: async () => ({ runs: [], total: 0, next: null, chipCounts: {} }) },
        exported: false,
        meta: null,
        conn: 'ok',
        runs: [],
        runCommands: items,
        actionsOff: null,
        hasKind: () => false,
        jobs: [],
        guard: (fn: () => void) => fn(),
        watchJob: () => undefined,
        toast,
        palette: true,
        setPalette: () => undefined,
        setHelp: () => undefined,
        setSideOpen: () => undefined,
      } as unknown as AppState;
      r = await render(createElement(AppContext.Provider, { value }, createElement(Palette, { route: { page: 'overview' } })));
      const querySelector = vi.spyOn(r.document, 'querySelector');
      const option = r.all('.palit').find((el) => el.querySelector('.pl')!.textContent === 'Run blame')!;
      expect(option.className).toContain('waits');
      expect(option.props['aria-disabled']).toBe(true);
      expect(option.textContent).toContain(WAITS);
      await r.click(option);
      await r.wait(0);
      expect(toast).toHaveBeenCalledWith(WAITS);
      expect(querySelector).not.toHaveBeenCalled();
    });

    it('waits by what the step runs: a Tests job for a job on the goldens too, a link for nothing, and what bills nothing as its own action says', async () => {
      const rerun: NextStep = { key: 'rerun-test', label: 'Re-run test', golden: 'goldens/x', command: 'shadowlap test goldens/x' };
      expect((await thisRun(detail(rerun), { meta: PROJECT, jobs: [{ job: { id: 'j2', kind: 'test', done: false, project: { id: 'p1' } } }] } as unknown as Partial<AppState>))[0]?.wait).toMatch(/run it again once it is done/);
      // The same job waits nothing for blame, which only a job holding the tree stops.
      expect((await thisRun(detail(blame), { meta: PROJECT, jobs: [{ job: { id: 'j2', kind: 'test', done: false, project: { id: 'p1' } } }] } as unknown as Partial<AppState>))[0]?.wait).toBeUndefined();
      const link: NextStep = { key: 'fix', label: 'Open fix', fixId: 'fx-1', status: 'open', check: 'exit code 0', href: '#/fixes/fx-1', title: '“Refunds”' };
      expect((await thisRun(detail(link), { meta: PROJECT, jobs: holding() } as unknown as Partial<AppState>))[0]).not.toHaveProperty('wait');
      const replay: NextStep = { key: 'replay', label: 'Replay', runId: RUN, command: 'shadowlap replay x' };
      expect((await thisRun(detail(replay, { actions: [{ key: 'r', label: 'Replay', disabled: 'no agent to run' }] })))[0]).toMatchObject({ hint: 'no agent to run', wait: 'no agent to run' });
    });

    it('says why, where a job started after the palette opened', async () => {
      const toast = vi.fn();
      const items = await thisRun(detail(blame), { toast });
      const click = vi.fn();
      vi.stubGlobal('document', { querySelector: () => ({ disabled: true, title: WAITS, click }) });
      items[0].run();
      await new Promise((done) => setTimeout(done, 0));
      vi.unstubAllGlobals();
      expect(click).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(WAITS);
    });
  });

  it('words an entry from the step alone', () => {
    expect(stepEntry({ key: 'fix', label: 'Open fix', fixId: 'fx-1', status: 'open', check: 'exit code 0', href: '#/fixes/fx-1', title: '“Refunds”' })).toEqual({ group: 'This run', label: 'Open fix', hint: '“Refunds”' });
    expect(stepEntry({ key: 'rule', label: 'Add normalizer' })).toEqual({ group: 'This run', label: 'Add normalizer', hint: '', job: true });
  });
});

const row = (runId: string, startedAt: number, key: string, about = 'Order A-1042 arrived damaged', next: Record<string, unknown> = {}): RunListItem => ({ runId, startedAt, labels: [], mode: 'record', status: 'failed', calls: 3, command: 'node agent.mjs', parentRunId: null, next: { key, label: key === 'blame' ? 'Run blame' : 'Replay', command: `shadowlap blame ${runId} --expect '{"tools":{"send_email":1}}'`, ...next }, about: { text: about, from: 'user' } }) as unknown as RunListItem;

describe('Run blame in the palette', () => {
  const OVERVIEW: Route = { page: 'overview' };
  const app = (over: Partial<AppState>, client: Partial<Client> = {}): AppState =>
    ({
      client: { search: async () => ({ hits: [] }), runsPage: async () => ({ runs: [], total: 0, next: null, chipCounts: {} }), ...client },
      exported: false,
      meta: null,
      conn: 'ok',
      runs: [],
      runCommands: [],
      actionsOff: null,
      hasKind: () => true,
      jobs: [],
      guard: (fn: () => void) => (fn(), true),
      watchJob: () => undefined,
      toast: () => undefined,
      palette: true,
      setPalette: () => undefined,
      setHelp: () => undefined,
      setSideOpen: () => undefined,
      ...over,
    }) as unknown as AppState;
  const shown = (p: Rendered) => p.all('.palit').map((el) => el.querySelector('.pl')!.textContent);
  const type = async (p: Rendered, q: string) => {
    await p.type(p.one('.palin input'), q);
  };

  it('finds the newest failures whose next step it is, but the run open', () => {
    const runs = [row('A', 1, 'blame'), row('B', 4, 'blame'), row('C', 3, 'replay'), row('D', 2, 'blame'), row('E', 5, 'blame'), row('F', 6, 'blame')];
    expect(blameEntries(runs, 'F').map((x) => x.run.runId)).toEqual(['E', 'B', 'D']);
    expect(blameEntries(runs, null)).toHaveLength(BLAME_ENTRIES);
    // Its hint is what its page's card says it runs, from the row.
    expect(blameEntries(runs, null)[0]?.entry).toEqual({ group: 'Actions', label: 'Run blame', hint: `shadowlap blame F --expect '{"tools":{"send_email":1}}'`, job: true, typed: true, match: 'failed Order A-1042 arrived damaged' });
  });

  const PRICE: Estimate = { kind: 'blame', usd: 0.3, ceiling: true, parts: [] };
  const blameStep = (estimate?: Estimate, offer: Partial<BlameOffer> = {}) => async (): Promise<{ next: NextStep | null }> => ({ next: { key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [], ...offer }, command: `shadowlap blame ${RUN.slice(0, 10)}`, ...(estimate ? { estimate } : {}) } });
  const pick = async (client: Partial<Client>, over: Partial<AppState> = {}) => {
    r = await render(createElement(AppContext.Provider, { value: app({ runs: [row(RUN, 1, 'blame')], ...over }, client) }, createElement(Palette, { route: OVERVIEW })));
    await type(r, 'blame');
    await r.click(r.byText('.palit .pl', 'Run blame'));
    await r.wait(0);
  };
  afterEach(() => {
    askQuestion(null);
    resetSpending();
  });

  it('shows them only once something is typed, by what they did too, and starts the job at or under the threshold, with its estimate', async () => {
    resetSpending(0.5);
    const started: Array<[string, unknown]> = [];
    const watched = vi.fn();
    r = await render(createElement(AppContext.Provider, { value: app({ runs: [row(RUN, 1, 'blame')], watchJob: watched }, { nextStep: blameStep(PRICE), startJob: (kind: string, fields: unknown) => (started.push([kind, fields]), Promise.resolve({ id: 'j' })) } as never) }, createElement(Palette, { route: OVERVIEW })));
    expect(shown(r)).not.toContain('Run blame');
    await type(r, 'damaged');
    expect(shown(r)).toContain('Run blame');
    await r.click(r.byText('.palit .pl', 'Run blame'));
    await r.wait(0);
    expect(started).toEqual([['blame', { runId: RUN, estimate: { usd: 0.3, ceiling: true } }]]);
    expect(watched).toHaveBeenCalledOnce();
    expect(testsQuestion()).toBeNull();
  });

  it('asks over the page above the threshold, in its page’s words, and its yes starts the job with the estimate it said', async () => {
    resetSpending(0.1);
    const startJob = vi.fn((_kind: string, _fields: unknown) => Promise.resolve({ id: 'j' }));
    await pick({ nextStep: blameStep(PRICE), startJob } as never);
    expect(startJob).not.toHaveBeenCalled();
    expect(testsQuestion()).toMatchObject({ title: `Run blame on ${RUN.slice(0, 10)}`, name: RUN.slice(0, 10), lead: 'Finds the model call that lost the run.', ok: 'Run blame', commands: [`shadowlap blame ${RUN.slice(0, 10)}`], facts: [], estimate: PRICE });
    expect(answerTestsQuestion(app({}), true)).toBe(true);
    expect(startJob.mock.calls).toEqual([['blame', { runId: RUN, estimate: { usd: 0.3, ceiling: true } }]]);
    expect(testsQuestion()).toBeNull();
  });

  it('asks with no estimate where the step can’t be read, even on Never ask, and Cancel starts nothing', async () => {
    resetSpending(null);
    const startJob = vi.fn(() => Promise.resolve({ id: 'j' }));
    await pick({ nextStep: () => Promise.reject(new Error('offline')), startJob } as never);
    expect(testsQuestion()).toMatchObject({ title: `Run blame on ${RUN.slice(0, 10)}`, estimate: null });
    // The row's command, as the read gave none.
    expect(testsQuestion()?.commands).toEqual([`shadowlap blame ${RUN} --expect '{"tools":{"send_email":1}}'`]);
    expect(answerTestsQuestion(app({}), false)).toBe(true);
    expect(startJob).not.toHaveBeenCalled();
  });

  it('opens the run’s page where the step says its check must be asked for, and starts nothing', async () => {
    const location = { hash: '#/', search: '', pathname: '/' };
    vi.stubGlobal('location', location);
    try {
      resetSpending(null);
      const startJob = vi.fn(() => Promise.resolve({ id: 'j' }));
      await pick({ nextStep: blameStep(PRICE, { from: 'ask' }), startJob } as never);
      expect(startJob).not.toHaveBeenCalled();
      expect(testsQuestion()).toBeNull();
      expect(location.hash).toBe(`#/run/${RUN}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves to the run’s page the check and the yes it asks first, and nothing else', () => {
    expect(blameAsksOnItsPage(new ApiError(422, 'say what a passing run must do'))).toBe(true);
    expect(blameAsksOnItsPage(new ApiError(409, 'This run came from an imported pack: node agent.mjs', 'node agent.mjs'))).toBe(true);
    expect(blameAsksOnItsPage(new ApiError(409, 'A job is already running'))).toBe(false);
    expect(blameAsksOnItsPage(new ApiError(500, 'broke'))).toBe(false);
    expect(blameAsksOnItsPage(null)).toBe(false);
  });

  it('sends a capture to its page, which asks for your command, and says so in its hint, and starts nothing', async () => {
    const location = { hash: '#/', search: '', pathname: '/' };
    vi.stubGlobal('location', location);
    try {
      const command = `shadowlap blame ${RUN.slice(0, 10)} --expect '{"calls":[]}' -- <your command>`;
      const startJob = vi.fn(() => Promise.reject(new ApiError(409, 'no command')));
      r = await render(createElement(AppContext.Provider, { value: app({ runs: [row(RUN, 1, 'blame', 'Imported', { capture: true, command })] }, { startJob }) }, createElement(Palette, { route: OVERVIEW })));
      await type(r, 'blame');
      expect(r.all('.palit').find((el) => el.querySelector('.pl')!.textContent === 'Run blame')!.textContent).toContain('your command');
      await r.click(r.byText('.palit .pl', 'Run blame'));
      await r.wait(0);
      expect(startJob).not.toHaveBeenCalled();
      expect(location.hash).toBe(`#/run/${RUN}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the run where what it asks first is its page’s to ask, and offers none where nothing runs', async () => {
    const location = { hash: '#/', search: '', pathname: '/' };
    vi.stubGlobal('location', location);
    try {
      // Priced under the threshold, it starts, and the server asks for the check after all.
      resetSpending(0.5);
      await pick({ nextStep: blameStep(PRICE), startJob: () => Promise.reject(new ApiError(422, 'say what a passing run must do')) });
      expect(location.hash).toBe(`#/run/${RUN}`);
      await r?.unmount();
      r = await render(createElement(AppContext.Provider, { value: app({ runs: [row(RUN, 1, 'blame')], actionsOff: 'read-only' }) }, createElement(Palette, { route: OVERVIEW })));
      await type(r, 'blame');
      expect(shown(r)).not.toContain('Run blame');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
