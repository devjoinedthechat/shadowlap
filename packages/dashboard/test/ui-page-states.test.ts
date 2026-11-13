/**
 * Each page's quiet states, as the setup-states port draws them: while its data loads, the page's
 * header over its final layout in quiet bars (inert, one status, the page busy, none of the classes
 * the tests and the browser suite read as the page drawn); a read that failed, the header kept over
 * the error line with Retry, which reads again; and a link that names nothing, one page per kind.
 * A project with no runs shows its setup on the Overview alone: every other page says what it will
 * hold, with Set up <project>, and the setup draws its own loading, failure and steps.
 */
import { createElement, Fragment } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, deriveSetup, emptySetup, emptyStoreFacts, type ProjectEntry, type RunFact, type SetupFindings, type StoreFacts } from '@shadowlap/engine';
import { fixesView } from '../src/fixes-view.js';
import { setupView, type SetupInput, type SetupView } from '../src/projects.js';
import { readTraining, trainingView } from '../src/training.js';
import { ApiError, type Client } from '../ui/api.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import type { NotFoundKind } from '../ui/not-found-words.js';
import { ComparePage } from '../ui/pages/Compare.js';
import { FixesPage } from '../ui/pages/Fixes.js';
import { DashboardPages } from '../ui/pages/lazy.js';
import { NotFoundPage } from '../ui/pages/NotFound.js';
import { OverviewPage } from '../ui/pages/Overview.js';
import { RunPage } from '../ui/pages/Run.js';
import { RunsPage } from '../ui/pages/Runs.js';
import { SetupPage } from '../ui/pages/Setup.js';
import { LoadProblem } from '../ui/pages/settings/common.js';
import { StoreSetupPage } from '../ui/pages/settings/StoreSetup.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { TrainingPage } from '../ui/pages/Training.js';
import { parseRoute } from '../ui/route.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { SetupUrlCheck, StoreSetupView } from '../ui/store-api.js';
import { FakeElement, render, type Rendered } from './ui-render.js';
import { addressBar } from './ui-route-helpers.js';

let r: Rendered | null = null;

afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

const text = (el: FakeElement) => el.textContent.replace(/\u00a0/g, ' ');
const META = { project: { name: 'support-agent', path: '/work/support-agent' } };
/** A read the dashboard server answered 500 to, with no words of its own. */
const failed = () => Promise.reject(new ApiError(500, 'HTTP 500'));

/** The app as the shell gives it, its server answering as `client` says; a copy when `exported`. */
function app(client: Partial<Record<'run' | 'fix', (id: string) => Promise<unknown>>>, o: { exported?: boolean } = {}): AppState {
  return {
    client: { jobs: () => Promise.resolve([]), exported: !!o.exported, ...client } as unknown as Client,
    exported: !!o.exported,
    meta: META,
    tick: 0,
    runsTick: 0,
    live: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
  } as unknown as AppState;
}

/** What a page waiting for its data must be: busy, saying so once, its bars inert and hidden. A region there before its words (Compare's rest) says nothing yet. */
function waiting(page: Rendered, what: string): void {
  expect(page.one('.page').getAttribute('aria-busy')).toBe('true');
  expect(page.all('[role="status"]').map(text).filter(Boolean)).toEqual([`Loading ${what}…`]);
  const skin = page.one('.skel .skin');
  expect(skin.getAttribute('aria-hidden')).toBe('true');
  expect(skin.hasAttribute('inert')).toBe(true);
}

describe('a run page whose run hasn’t come', () => {
  const RUN = 'run_8f3a2c1d9e7b6a5f';

  it('draws its header, the project then the id, over the strip and the first calls in quiet bars of their own', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({ run: () => new Promise(() => undefined) }) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    waiting(r, 'the run');
    expect(text(r.one('.ph.rerr .eyebrow'))).toBe('support-agent · run');
    expect(text(r.one('.ph.rerr h1'))).toBe('run_8f3a2c');
    expect(r.all('.skin .rskstrip')).toHaveLength(1);
    expect(r.all('.skin .rskcall')).toHaveLength(8);
    // None of what the tests and the browser suite read as the run drawn.
    for (const drawn of ['.rhead', '.rnm', 'table', '[data-wi]', '.strip']) expect(r.all(drawn), drawn).toEqual([]);
  });

  it('keeps that header when the read fails, over the error line, and Retry reads the run again', async () => {
    const asked: string[] = [];
    let answer = failed;
    r = await render(createElement(AppContext.Provider, { value: app({ run: (id) => (asked.push(id), answer()) }) }, createElement(RunPage, { id: RUN, call: null, view: null })));
    await r.until('the failure', () => r!.all('.loaderr').length === 1);
    expect(r.one('.page').hasAttribute('aria-busy')).toBe(false);
    expect(text(r.one('.ph.rerr h1'))).toBe('run_8f3a2c');
    expect(r.all('.loaderr p > span').map(text)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    expect(r.all('.skel')).toEqual([]);
    answer = () => new Promise(() => undefined);
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the run read again', () => asked.length === 2);
    expect(asked).toEqual([RUN, RUN]);
  });
});

describe('a fix page whose fix hasn’t come', () => {
  it('draws fix and its id over the three steps in the stepper’s look as quiet bars, never the fix’s own classes', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({ fix: () => new Promise(() => undefined) }) }, createElement(FixPage, { id: 'fx-0123456789abcdef', step: null, sub: null })));
    waiting(r, 'the fix');
    expect(text(r.one('.ph .eyebrow'))).toBe('fix · fx-0123456789');
    expect(text(r.one('.ph h1'))).toBe('fx-0123456789');
    expect(r.all('.skin .fxsks > div').map((d) => text(d.querySelector('.k')!))).toEqual(['Blame', 'Repair', 'Verify']);
    // The fix's tests wait for `.ph.fxh h1`, and the browser suite for `.stepper`.
    for (const drawn of ['.fxh', '.stepper']) expect(r.all(drawn), drawn).toEqual([]);
  });

  it('keeps that header when the read fails, over the error line, and Retry reads the fix again', async () => {
    const asked: string[] = [];
    let answer = failed;
    r = await render(createElement(AppContext.Provider, { value: app({ fix: (id) => (asked.push(id), answer()) }) }, createElement(FixPage, { id: 'fx-fedcba9876543210', step: null, sub: null })));
    await r.until('the failure', () => r!.all('.loaderr').length === 1);
    expect(r.one('.page').hasAttribute('aria-busy')).toBe(false);
    expect(text(r.one('.ph h1'))).toBe('fx-fedcba9876');
    expect(r.all('.loaderr p > span').map(text)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    answer = () => new Promise(() => undefined);
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the fix read again', () => asked.length === 2);
  });
});

describe('Runs while its runs haven’t come', () => {
  const EMPTY = { runs: [], total: 0, next: null, chipCounts: { all: 0, recording: 0, fork: 0, clean: 0, test: 0, capture: 0, failed: 0, local: 0 } };
  const runs = (runsPage: () => Promise<unknown>) => {
    const client = { exported: false, runsPage, runsByDay: () => new Promise(() => undefined), teamStore: () => Promise.resolve(null), knownRuns: (ids: string[]) => Promise.resolve(ids) } as unknown as Client;
    const state = { ...app({}), client, hasKind: () => false, refresh: () => undefined } as unknown as AppState;
    return createElement(AppContext.Provider, { value: state }, createElement(RunsPage, {}));
  };

  it('draws the rows as quiet bars in the table’s place, under its head, with no table row', async () => {
    r = await render(runs(() => new Promise(() => undefined)));
    expect(r.all('.runsec [role="status"]').map(text)).toEqual(['Loading the runs…']);
    expect(r.all('.runsec .skin .rskrun')).toHaveLength(8);
    expect(r.all('table.runst tbody tr')).toEqual([]);
    expect(text(r.one('.ph h1'))).toBe('Runs');
  });

  it('says why the runs couldn’t be read in the table’s place, and Retry reads the first page again', async () => {
    let asked = 0;
    let answer: () => Promise<unknown> = failed;
    r = await render(runs(() => (asked++, answer())));
    await r.until('the failure', () => r!.all('.runsec .loaderr').length === 1);
    expect(r.all('.loaderr p > span').map(text)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    expect(text(r.one('.ph h1'))).toBe('Runs');
    answer = () => Promise.resolve(EMPTY);
    const before = asked;
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the runs read again', () => r!.all('.loaderr').length === 0);
    expect(asked).toBe(before + 1);
    expect(text(r.one('.runsec .emptyline'))).toBe('No runs yet.');
  });
});

describe('the Overview while it works the week out', () => {
  const overview = (summary: () => Promise<unknown>) => {
    const client = { exported: false, summary, activity: () => new Promise(() => undefined), teamStore: () => Promise.resolve(null), jobs: () => Promise.resolve([]) } as unknown as Client;
    addressBar('#/');
    return createElement(AppContext.Provider, { value: { ...app({}), client, runs: null } as unknown as AppState }, createElement(OverviewPage));
  };

  it('draws Needs a look and its aside in quiet bars under the header, in a grid of their own', async () => {
    r = await render(overview(() => new Promise(() => undefined)));
    waiting(r, 'the Overview');
    expect(text(r.one('.ph .eyebrow'))).toBe('support-agent · this week');
    expect(text(r.one('.ph h1'))).toBe('Overview');
    expect(r.all('.skin .ovgs section h2').map(text)).toEqual(['Needs a look', 'Recent runs', 'Activity']);
    // In the final layout, so nothing moves when the week lands: the header's four facts, and Needs a look's rows in their own markup.
    expect(r.all('.skin .metrics.pfacts > .metric').map((m) => text(m.querySelector('span')!))).toEqual(['failures reproduced', 'fixes verified', 'goldens passing', 'spent live']);
    expect(r.all('.skin .ovgs .attn > .arow').map((row) => row.querySelectorAll('.at .t, .at .d, .ast .btn').length)).toEqual([3, 3, 3]);
    // `.ovg` is what the tests read as the Overview drawn.
    expect(r.all('.ovg')).toEqual([]);
  });

  it('keeps the header when the week can’t be worked out, over the error line, and Retry asks again', async () => {
    let asked = 0;
    let answer = failed;
    r = await render(overview(() => (asked++, answer())));
    await r.until('the failure', () => r!.all('.loaderr').length === 1);
    expect(r.one('.page').hasAttribute('aria-busy')).toBe(false);
    expect(text(r.one('.ph h1'))).toBe('Overview');
    expect(r.all('.skel')).toEqual([]);
    answer = () => new Promise(() => undefined);
    const before = asked;
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the week asked again', () => asked === before + 1);
  });
});

describe('a page of a project with no runs', () => {
  const step = (page: Rendered) => page.all('.stepempty a.btn.lime').map((a) => [text(a), a.getAttribute('href')]);

  it('says on Runs what it will hold, with Set up <project> to the Overview, where the setup is', async () => {
    const state = { ...app({}), runs: [], client: { exported: false, teamStore: () => Promise.resolve(null) } } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(RunsPage, {})));
    expect(text(r.one('.stepempty h2'))).toBe('No runs yet');
    expect(step(r)).toEqual([['Set up support-agent', '#/']]);
    expect(r.all('ol.setup')).toEqual([]);
  });

  it('offers Import capture… alone in Runs’ header, a team store’s Pull and Push waiting for the list', async () => {
    const store = { url: 's3://northwind-agent-runs/support-agent', name: 'northwind-agent-runs/support-agent', onlyLocal: 2 };
    const state = { ...app({}), runs: [], client: { exported: false, teamStore: () => Promise.resolve(store) } } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(RunsPage, {})));
    await r.until('the team store', () => text(r!.one('.ph .eyebrow')) === 'support-agent · team store');
    expect(r.all('.ph .actions .btn').map(text)).toEqual(['Import capture…']);
  });

  it('says on Fixes what it will hold, with Set up <project>, and no blame command, which needs a run', async () => {
    const store = Store.open(':memory:');
    try {
      const state = { ...app({}), runs: [], client: { exported: false, fixes: () => Promise.resolve(fixesView(store)), jobs: () => Promise.resolve([]) } } as unknown as AppState;
      r = await render(createElement(AppContext.Provider, { value: state }, createElement(FixesPage, { id: null, step: null, sub: null })));
      await r.until('the empty list', () => r!.all('.stepempty').length === 1);
      expect(text(r.one('.stepempty h2'))).toBe('No fixes yet');
      expect(step(r)).toEqual([['Set up support-agent', '#/']]);
      expect(text(r.document.body)).not.toContain('shadowlap blame');
    } finally {
      await r?.unmount();
      r = null;
      store.close();
    }
  });

  it('says on Tests what it will hold, with Set up <project>, and no pack command, which needs a run', async () => {
    const tests = { empty: true, rows: [], diverged: [], commands: { pack: 'shadowlap pack <run> goldens/<name>' } };
    const state = { ...app({}), runs: [], client: { exported: false, tests: () => Promise.resolve(tests), jobs: () => Promise.resolve([]) } } as unknown as AppState;
    addressBar('#/tests');
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(TestsPage)));
    await r.until('the empty page', () => r!.all('.stepempty').length === 1);
    expect(text(r.one('.stepempty h2'))).toBe('No goldens yet');
    expect(step(r)).toEqual([['Set up support-agent', '#/']]);
    expect(text(r.document.body)).not.toContain('shadowlap pack');
  });

  it('says on Training’s Pairs and Tasks what each will hold, with Set up <project>, and neither of the server’s commands, which name a run', async () => {
    const store = Store.open(':memory:');
    const training = trainingView(readTraining(store, { tasks: [], redactRules: 0 }));
    store.close();
    const client = { exported: false, training: () => Promise.resolve(training), models: () => new Promise(() => undefined), jobs: () => Promise.resolve([]) } as unknown as Client;
    for (const [tab, title] of [
      ['pairs', 'No pairs yet'],
      ['tasks', 'No tasks yet'],
    ] as const) {
      r = await render(createElement(AppContext.Provider, { value: { ...app({}), client, runs: [] } as unknown as AppState }, createElement(TrainingPage, { tab })));
      await r.until('the empty tab', () => r!.all('.stepempty').length === 1);
      expect(text(r.one('.stepempty h2')), tab).toBe(title);
      expect(step(r), tab).toEqual([['Set up support-agent', '#/']]);
      expect(text(r.document.body), tab).not.toMatch(/shadowlap (blame|pack)/);
      await r.unmount();
      r = null;
    }
  });

  it('keeps Set up <project> a link on a read-only dashboard, since opening the Overview asks the server nothing', async () => {
    const off = 'This dashboard is read-only: it was started with --read-only.';
    const state = { ...app({}), meta: { ...META, readOnly: true, actions: false }, actionsOff: off, runs: [], client: { exported: false, teamStore: () => Promise.resolve(null) } } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(RunsPage, {})));
    const link = r.one('.stepempty a.btn.lime');
    expect([text(link), link.getAttribute('href'), link.getAttribute('aria-disabled'), link.getAttribute('data-why')]).toEqual(['Set up support-agent', '#/', null, null]);
  });
});

describe('Compare in a project with fewer than two runs', () => {
  const compare = (runs: unknown[]) => {
    addressBar('#/compare');
    const client = { exported: false, jobs: () => Promise.resolve([]), compareHead: () => Promise.resolve(null) };
    return createElement(AppContext.Provider, { value: { ...app({}), runs, client } as unknown as AppState }, createElement(ComparePage, { a: null, b: null }));
  };

  it('asks for a run first with none at all, and offers no command or run, as each would need one', async () => {
    r = await render(compare([]));
    expect(text(r.one('.stepempty h2'))).toBe('Compare needs two runs');
    expect(text(r.one('.stepempty p'))).toBe('Record a run, then replay or fork it, and compare the two call by call.');
    expect(r.all('.stepempty .cmdline')).toEqual([]);
    expect(r.all('.stepempty a')).toEqual([]);
    expect(text(r.document.body)).not.toContain('shadowlap replay');
  });

  it('offers to replay the one run there is, and to open it', async () => {
    r = await render(compare([{ runId: '01K5CQ7A3M00000000000000AB', parentRunId: null, mode: 'record', status: 'completed', startedAt: 1, calls: 3 }]));
    expect(text(r.one('.stepempty h2'))).toBe('Compare needs two runs');
    expect(text(r.one('.stepempty p'))).toBe('Replay or fork the run you have, and compare the two call by call.');
    expect(text(r.one('.stepempty .cmdline'))).toContain('shadowlap replay 01K5CQ7A3M');
    expect(r.all('.stepempty a').map((a) => [text(a), a.getAttribute('href')])).toEqual([['Open run', '#/run/01K5CQ7A3M00000000000000AB']]);
  });
});

describe('Compare while it reads, and when a read fails', () => {
  const A = '01M5GRVTKSJ12EE2SE9YZ5W4J3';
  const B = '01M5GRXFM1Y2E2VBPFX0TV2TGA';
  const listed = (runId: string) => ({ runId, parentRunId: null, mode: 'record', status: 'completed', startedAt: 1, calls: 3 });
  const detail = (runId: string) => ({ run: { runId, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'refund_agent.mjs'], cwd: '.' }, codeVersion: null, startedAt: 1, endedAt: 2 }, parent: null, children: [], source: null, calls: [], summary: {} });
  /** Compare at `#/compare/<a>[/<b>]` in a project of two runs, its server answering as `client` says. */
  const compare = (client: Record<string, unknown>, a: string, b: string | null = null) => {
    addressBar(b ? `#/compare/${a}/${b}` : `#/compare/${a}`);
    const server = { exported: false, jobs: () => Promise.resolve([]), compareHead: () => Promise.resolve(null), run: (id: string) => Promise.resolve(detail(id)), ...client };
    return createElement(AppContext.Provider, { value: { ...app({}), runs: [listed(A), listed(B)], client: server } as unknown as AppState }, createElement(ComparePage, { a, b }));
  };
  const failure = (page: Rendered) => page.all('.loaderr p > span').map(text);

  it('draws the comparison’s shape under the pickers while it reads, in classes of its own, none of the comparison’s parts', async () => {
    r = await render(compare({ compare: () => new Promise(() => undefined) }, A, B));
    await r.until('the pickers', () => r!.all('.pickers .rpick').length === 2);
    waiting(r, 'the comparison');
    expect(r.all('.skel .cskrow')).toHaveLength(5);
    expect(r.all('.skel .rpick')).toEqual([]);
    for (const part of ['.verdict.cmpv', '.prefix', '.cmpfacts', '.paths2', '.cprow', '.empty']) expect(r.all(part), part).toEqual([]);
  });

  it('says why the comparison couldn’t be read under the pickers, with Retry, which asks again', async () => {
    let asked = 0;
    r = await render(compare({ compare: () => (asked++, failed()) }, A, B));
    await r.until('the failure', () => r!.all('.loaderr').length === 1);
    expect(failure(r)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    expect(r.all('.pickers .rpick')).toHaveLength(2);
    expect([r.all('.skel').length, r.one('.page').getAttribute('aria-busy')]).toEqual([0, null]);
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the comparison asked again', () => asked === 2);
  });

  it('one run named: its shape while the run is read, then why it couldn’t be, with Retry, which reads it again', async () => {
    r = await render(compare({ run: () => new Promise(() => undefined) }, A));
    await r.until('the shape', () => r!.all('.skel').length === 1);
    waiting(r, 'the comparison');
    await r.unmount();
    let reads = 0;
    r = await render(compare({ run: () => (reads++, failed()) }, A));
    await r.until('the failure', () => r!.all('.loaderr').length === 1);
    expect(failure(r)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    expect(r.all('.stepempty')).toEqual([]);
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the run read again', () => reads === 2);
  });
});

describe('Runs before the meta says which project it is, and in a project that can’t be opened', () => {
  const GONE = { project: { id: 'support-agent', name: 'support-agent', path: '/work/support-agent', problem: 'Its folder is gone: /work/support-agent.', missing: true } };
  let asked = 0;
  /** The shell's pages at #/runs, the meta as given; `asked` counts the reads of the runs' table. */
  const routed = (meta: unknown) => {
    asked = 0;
    const read = () => (asked++, new Promise(() => undefined));
    const client = { exported: false, jobs: () => Promise.resolve([]), runsPage: read, runsByDay: read, teamStore: () => Promise.resolve(null), knownRuns: (ids: string[]) => Promise.resolve(ids), projects: { setup: () => new Promise(() => undefined) } } as unknown as Client;
    const state = { ...app({}), client, meta, runs: meta ? [] : null, refresh: () => undefined } as unknown as AppState;
    return createElement(AppContext.Provider, { value: state }, createElement(DashboardPages, { route: parseRoute('#/runs') }));
  };

  it('waits with the page empty, reading no runs, as the meta is what says a project can’t be opened', async () => {
    r = await render(routed(null));
    expect(r.all('.page').map(text)).toEqual(['']);
    expect(r.all('h1')).toEqual([]);
    expect(asked).toBe(0);
  });

  it('says in Runs’ place why the project can’t be opened, with Remove project…, and reads no runs', async () => {
    r = await render(routed(GONE));
    await r.until('the project’s page', () => r!.all('.ph h1').length === 1);
    expect(text(r.one('.ph .eyebrow'))).toBe('support-agent');
    expect(text(r.one('.ph h1'))).toBe('Can’t open support-agent');
    expect(text(r.one('.ph'))).toContain('Its folder is gone: /work/support-agent.');
    expect(r.all('.ph .actions button').map(text)).toEqual(['Remove project…']);
    for (const drawn of ['.stepempty', '.runsec', 'ol.setup']) expect(r.all(drawn), drawn).toEqual([]);
    expect(asked).toBe(0);
  });
});

describe('the setup while its read comes, fails or answers', () => {
  const HOME = '/home/dana';
  const RUN = '01K5CQ7A3M00000000000000AB';
  const SETTING_UP = { project: { id: 'support-agent', name: 'support-agent', path: `${HOME}/support-agent`, display: '~/support-agent', settingUp: true } };
  const TOOLS: SetupFindings['tools'] = [
    { name: 'search_orders', effect: 'read', wrapped: true, why: 'declared', file: 'agent/tools.py', line: 12 },
    { name: 'refund_order', effect: 'write', wrapped: false, why: '"refund" changes something', file: 'agent/tools.py', line: 41 },
  ];
  /** What Inspect found: the write tool not wrapped yet, or (`wrapped`) found wrapped by a later look. */
  const found = (wrapped: boolean): SetupFindings => ({
    at: wrapped ? 50 : 1,
    language: 'Python 3.12 · uv',
    files: ['pyproject.toml'],
    sdk: 'anthropic 0.69.0',
    framework: 'Anthropic tool runner',
    command: ['uv', 'run', 'support-agent'],
    commandFrom: '[project.scripts] in pyproject.toml',
    config: { file: 'shadowlap.config.json', created: true, existed: false },
    tools: TOOLS.map((t) => ({ ...t, wrapped: wrapped || t.wrapped })),
    wrap: wrapped ? [] : [{ language: 'python', tools: ['refund_order'], code: 'from shadowlap import tool' }],
  });
  const RECORDING: RunFact = { runId: RUN, status: 'completed', startedAt: 10, endedAt: 20, live: false, calls: 12, replayedClean: false };
  /** The server's read model of support-agent's setup (src/projects.ts), the project at `over` and its store holding `store`. */
  const setupAt = (over: Partial<ProjectEntry['setup']>, store: Partial<StoreFacts> = {}, extra: Partial<SetupInput> = {}) => {
    const project: ProjectEntry = { id: 'support-agent', name: 'support-agent', path: `${HOME}/support-agent`, addedAt: 1, setup: { ...emptySetup(1), ...over }, confirmed: [] };
    return setupView({ project, setup: deriveSetup(project.setup, { ...emptyStoreFacts(), ...store }, { packs: [] }), redactRules: 0, home: HOME, ...extra });
  };
  const FRESH = setupAt({});
  const UNWRAPPED = setupAt({ stage: 'inspected', findings: found(false) });
  // Recorded before the write tool was wrapped, and found wrapped since: Pack waits for a recording made since.
  const WRAPPED_SINCE = setupAt({ stage: 'recorded', findings: found(true), inspections: [{ at: 1, unwrapped: ['refund_order'] }, { at: 50, unwrapped: [] }], runId: RUN, command: ['uv', 'run', 'support-agent'] }, { runs: 1, recordings: [RECORDING] });
  const SET_UP = setupAt({ stage: 'tested', findings: found(true), runId: RUN, golden: 'goldens/support-agent' }, { runs: 2, recordings: [RECORDING] });
  // Recorded in a terminal before the folder was inspected: Inspect folder leads until it is, then Calibrate.
  const TERMINAL = setupAt({ stage: 'recorded', runId: RUN }, { runs: 1, recordings: [RECORDING] });
  const INSPECTED = setupAt({ stage: 'recorded', findings: found(true), runId: RUN }, { runs: 1, recordings: [RECORDING] });
  // Recorded while a read and the write weren't wrapped, the write alone wrapped since: Pack waits for a recording made since.
  const MIXED = setupAt(
    { stage: 'recorded', findings: { ...found(true), tools: [{ ...TOOLS[0], wrapped: false }, { ...TOOLS[1], wrapped: true }] }, inspections: [{ at: 1, unwrapped: ['search_orders', 'refund_order'] }, { at: 50, unwrapped: ['search_orders'] }], runId: RUN, command: ['uv', 'run', 'support-agent'] },
    { runs: 1, recordings: [RECORDING] },
  );
  // Recorded with every tool wrapped, and calibrate proposed a normalizer.
  const PROPOSED = setupAt({ stage: 'recorded', findings: found(true), runId: RUN }, { runs: 1, recordings: [RECORDING] }, { calibration: { done: false, added: [], proposed: [{ path: '$.metadata.user_id', why: 'this looks like a UUID' }], stopped: null } });

  /** The setup page, its server answering the setup's read with `setup`; what it toasts goes in `toasts`. */
  const setupPage = (setup: () => Promise<unknown>, toasts: string[] = []) => {
    const client = { exported: false, jobs: () => Promise.resolve([]), projects: { setup } } as unknown as Client;
    const state = { ...app({}), client, meta: SETTING_UP, runs: [], toast: (t: string) => void toasts.push(t) } as unknown as AppState;
    return createElement(AppContext.Provider, { value: state }, createElement(SetupPage, {}));
  };
  const drawn = async (setup: () => Promise<unknown>, toasts?: string[]) => {
    r = await render(setupPage(setup, toasts));
    await r.until('the steps', () => r!.all('section#setup').length === 1);
    return r;
  };
  /** The lime buttons that can be pressed: one at a time, the step at hand's. */
  const limes = (page: Rendered) => page.all('section#setup .btn.lime').filter((b) => !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true').map(text);

  it('draws its header over the four steps in quiet bars while the setup is read, with no step to press', async () => {
    r = await render(setupPage(() => new Promise(() => undefined)));
    waiting(r, 'the setup');
    expect(text(r.one('.ph .eyebrow'))).toBe('support-agent · ~/support-agent');
    expect(text(r.one('.ph h1'))).toBe('Set up support-agent');
    expect(r.all('.skin ol.setup > li h2').map(text)).toEqual(['Inspect', 'Record', 'Calibrate', 'Pack']);
    for (const none of ['section#setup', '[data-step]', 'button']) expect(r.all(none), none).toEqual([]);
  });

  it('keeps that header when the read fails, over the error line, and Retry reads it again, each step then a section of its own', async () => {
    let asked = 0;
    let answer: () => Promise<unknown> = failed;
    r = await render(setupPage(() => (asked++, answer())));
    await r.until('the failure', () => r!.all('.loaderr').length === 1);
    expect(r.one('.page').hasAttribute('aria-busy')).toBe(false);
    expect(text(r.one('.ph h1'))).toBe('Set up support-agent');
    expect(r.all('.loaderr p > span').map(text)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    expect(r.all('.skel')).toEqual([]);
    answer = () => Promise.resolve(FRESH);
    const before = asked;
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the steps', () => r!.all('section#setup').length === 1);
    expect(asked).toBe(before + 1);
    expect(r.all('section#setup ol.setup > li').map((li) => [li.getAttribute('data-step'), text(li.querySelector('h2')!)])).toEqual([
      ['inspect', 'Inspect'],
      ['record', 'Record'],
      ['calibrate', 'Calibrate'],
      ['test', 'Pack'],
    ]);
  });

  it('gives the step at hand the one lime button to press, as the read model says', async () => {
    for (const [view, lime] of [
      [FRESH, 'Inspect folder'],
      [UNWRAPPED, 'Check again'],
      [WRAPPED_SINCE, 'Record again'],
      [MIXED, 'Record again'],
      [TERMINAL, 'Inspect folder'],
      [INSPECTED, 'Calibrate'],
      [SET_UP, 'Go to Overview'],
    ] as const) {
      expect(limes(await drawn(() => Promise.resolve(view))), lime).toEqual([lime]);
      await r!.unmount();
      r = null;
    }
  });

  it('draws Pack plain while it waits, not disabled, saying why under it and on a press, before the replay is clean too', async () => {
    for (const view of [UNWRAPPED, WRAPPED_SINCE]) {
      const toasts: string[] = [];
      const page = await drawn(() => Promise.resolve(view), toasts);
      const why = view.wait!.text;
      const pack = page.byText('li[data-step="test"] button', 'Pack as golden');
      expect([pack.className, pack.getAttribute('aria-disabled'), pack.hasAttribute('disabled'), pack.getAttribute('data-why')]).toEqual(['btn', 'true', false, why]);
      expect(page.all('li[data-step="test"] p.fieldnote.warn').map(text)).toEqual([why]);
      await page.click(pack);
      expect(toasts).toEqual([why]);
      await page.unmount();
      r = null;
    }
  });

  describe('as it moves on', () => {
    let scrolled: FakeElement[] = [];
    /**
     * The setup drawn as `first`, a button outside the page beside it; `then` answers its next read,
     * its poll's 4 s on, and lets the page's follow run, 60 ms after that read is drawn.
     */
    const moving = async (first: SetupView, focus: (page: Rendered) => FakeElement | null) => {
      vi.useFakeTimers();
      scrolled = [];
      vi.spyOn(FakeElement.prototype, 'scrollIntoView').mockImplementation(function (this: FakeElement) {
        scrolled.push(this);
      });
      let answer = first;
      r = await render(createElement(Fragment, null, createElement('button', { type: 'button', id: 'elsewhere' }, 'Elsewhere'), setupPage(() => Promise.resolve(answer))));
      await r.until('the steps', () => r!.all('section#setup').length === 1);
      const at = focus(r);
      if (at) await r.focus(at);
      return async (next: SetupView) => {
        answer = next;
        await r!.wait(4000);
        await r!.wait(100);
      };
    };
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
    const step = (el: FakeElement | undefined) => el?.getAttribute('data-step') ?? null;

    it('goes on to the next step’s button, scrolling to its step, the focus with it from the step that ended', async () => {
      const then = await moving(UNWRAPPED, (page) => page.byText('li[data-step="inspect"] .warnline button', 'Check again'));
      await then(WRAPPED_SINCE);
      expect(text(r!.focused())).toBe('Record again');
      expect(scrolled.map(step)).toEqual(['record']);
    });

    it('goes on to Calibrate once the folder a recording came before is inspected', async () => {
      const then = await moving(TERMINAL, (page) => page.byText('li[data-step="inspect"] button', 'Inspect folder'));
      await then(INSPECTED);
      expect(text(r!.focused())).toBe('Calibrate');
      expect(scrolled.map(step)).toEqual(['calibrate']);
    });

    it('leaves the focus where it was moved to, outside the step, and moves nothing on the first draw', async () => {
      const then = await moving(UNWRAPPED, (page) => page.one('#elsewhere'));
      await r!.wait(100);
      expect(scrolled).toEqual([]);
      await then(WRAPPED_SINCE);
      expect(r!.focused().id).toBe('elsewhere');
      // The page still scrolls to the step at hand.
      expect(scrolled.map(step)).toEqual(['record']);
    });

    it('moves nothing when the setup read is another project’s', async () => {
      const then = await moving(UNWRAPPED, (page) => page.byText('li[data-step="inspect"] .warnline button', 'Check again'));
      await then({ ...WRAPPED_SINCE, project: { ...WRAPPED_SINCE.project, id: 'triage-bot', name: 'triage-bot' } });
      expect(r!.focused()).toBe(r!.document.body);
      expect(scrolled).toEqual([]);
    });
  });

  it('says on Add normalizer’s hover what it writes and its command, Calibrate again plain beside it', async () => {
    const page = await drawn(() => Promise.resolve(PROPOSED));
    expect(limes(page)).toEqual(['Add normalizer']);
    const [add, again] = page.all('li[data-step="calibrate"] .actions .btn');
    expect([text(add), text(again), again.className]).toEqual(['Add normalizer', 'Calibrate again', 'btn']);
    expect(JSON.parse(add.getAttribute('data-tip')!)).toMatchObject({ t: 'Add normalizer', s: 'Writes the rule calibrate proposed to shadowlap.config.json', cmd: '$ shadowlap calibrate 01K5CQ7A3M --write' });
  });

  it('says a finished setup in a verdict line under the steps, set up first, with Go to Overview at its right', async () => {
    const page = await drawn(() => Promise.resolve(SET_UP));
    const done = page.one('section#setup .verdict.sdone');
    expect(text(done.querySelector('.vw')!)).toBe('set up');
    expect(text(done.querySelector('h2')!)).toBe('set up support-agent replays exactly.');
    expect(text(done.querySelector('p')!)).toBe(SET_UP.done!.text);
    expect(done.querySelectorAll('.actions .btn').map(text)).toEqual(['Go to Overview']);
    // Nothing left to skip.
    expect(page.all('.ph .actions')).toEqual([]);
  });
});

describe('the team store’s setup while its read comes, fails or answers', () => {
  const URL = 's3://acme-runs/support-agent';
  const POLICY: SetupUrlCheck['policy'] = {
    writer: { for: 'people, and CI on protected branches', kind: 'an IAM policy', text: '{ "Statement": ["write"] }', notes: [] },
    pullRequest: { for: 'pull requests’ CI jobs', kind: 'an IAM policy', text: '{ "Statement": ["read"] }', notes: [] },
    notes: [],
    command: 'shadowlap store policy --provider s3',
  };
  /** The server's view of the setup: the bucket connected, the runs pushed and CI skipped, so Bring your team is at hand. */
  const viewAt = (over: Partial<StoreSetupView> = {}): StoreSetupView => ({
    store: { url: URL, configured: URL, key: 'team', name: 'acme-runs', provider: 's3', providerName: 'Amazon S3' },
    active: true,
    next: { step: 4, title: 'Bring your team' },
    setup: { startedAt: 1, ci: 'skipped', ciProvider: 'github', finishedAt: null },
    connected: true,
    pushed: true,
    check: null,
    runs: { onlyLocal: 0, pushedHere: 3 },
    providers: [{ provider: 's3', name: 'Amazon S3', scheme: 's3://', example: 's3://<bucket>/<project>', credentials: null, hint: { uses: 'AWS credentials', from: 'the default chain' } }],
    ci: [],
    commit: { file: 'shadowlap.config.json', line: `"store": "${URL}"`, command: 'git add shadowlap.config.json && git commit -m "Use the team store"' },
    ...over,
  });
  /** The page, its server answering the setup's read with `view` and a typed URL's check with `check`; what it saves goes in `saved`, what it toasts in `toasts`. */
  const storePage = (view: () => Promise<StoreSetupView>, o: { saved?: unknown[]; toasts?: string[]; check?: () => Promise<SetupUrlCheck> } = {}) => {
    const storeSetup = { view, check: o.check ?? (() => new Promise(() => undefined)), save: (step: unknown) => (o.saved?.push(step), Promise.resolve({})) };
    const client = { exported: false, jobs: () => Promise.resolve([]), storeSetup } as unknown as Client;
    const state = { ...app({}), client, toast: (t: string) => void o.toasts?.push(t) } as unknown as AppState;
    return createElement(AppContext.Provider, { value: state }, createElement(StoreSetupPage, {}));
  };
  const steps = (page: Rendered) => page.all('ol.setup.storesetup').length === 1 && page.all('.skel').length === 0;

  it('draws its header, the project in its eyebrow, over the four steps in quiet bars while the setup is read, with nothing to press', async () => {
    r = await render(storePage(() => new Promise(() => undefined)));
    waiting(r, 'the team store’s setup');
    expect(text(r.one('.ph .eyebrow'))).toBe('support-agent · team store setup');
    expect(text(r.one('.ph h1'))).toBe('Set up team store');
    expect(r.all('.skin ol.setup.storesetup > li h2').map(text)).toEqual(['Connect your bucket', 'Push your runs', 'Push from CI', 'Bring your team']);
    // No heading over the bars that the page's own layout doesn't have, and nothing to press.
    expect(r.all('.skel > header')).toEqual([]);
    expect(r.all('button')).toEqual([]);
  });

  it('keeps that header when the read fails, over the error line, and Retry reads the setup again', async () => {
    let asked = 0;
    let answer: () => Promise<StoreSetupView> = failed;
    r = await render(storePage(() => (asked++, answer())));
    await r.until('the failure', () => r!.all('.loaderr').length === 1);
    expect(r.one('.page').hasAttribute('aria-busy')).toBe(false);
    expect(text(r.one('.ph h1'))).toBe('Set up team store');
    expect(r.all('.loaderr p > span').map(text)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    answer = () => Promise.resolve(viewAt());
    const before = asked;
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the steps', () => steps(r!));
    expect(asked).toBe(before + 1);
  });

  it('gives each access policy a box of its own, its Copy named for whom it is, in Settings → Store’s noun, and Check access and connect its command on hover', async () => {
    const check = (): Promise<SetupUrlCheck> => Promise.resolve({ ok: false, provider: 's3', error: 'Type the bucket and folder.', policy: POLICY });
    const fresh = viewAt({ store: null, connected: false, pushed: false, setup: { startedAt: null, ci: null, ciProvider: null, finishedAt: null }, next: { step: 1, title: 'Connect your bucket' }, commit: null });
    r = await render(storePage(() => Promise.resolve(fresh), { check }));
    await r.until('the access to ask for', () => r!.all('details.foundsum .policypart').length === 2);
    expect(r.all('.policypart .boxwrap > pre.codebox').map(text)).toEqual([POLICY.writer.text, POLICY.pullRequest.text]);
    expect(r.all('.policypart .boxcopy').map((b) => b.getAttribute('aria-label'))).toEqual(['Copy access policy for people, and CI on protected branches', 'Copy access policy for pull requests’ CI jobs']);
    // Check access and connect says on its hover what it checks and its command, the step's own terminal line.
    const connect = r.byText('ol.setup.storesetup .btn.lime', 'Check access and connect');
    expect(JSON.parse(connect.getAttribute('data-tip')!)).toMatchObject({ t: 'Check access and connect', s: 'Lists, writes, reads and deletes a test object with the credentials on this machine', cmd: '$ shadowlap store set s3://<bucket>/<project> --check' });
  });

  it('says a setup just finished in a verdict line under the steps, set up first, with Go to Overview at its right', async () => {
    const saved: unknown[] = [];
    const toasts: string[] = [];
    r = await render(storePage(() => Promise.resolve(viewAt()), { saved, toasts }));
    await r.until('the steps', () => steps(r!));
    expect(r.all('ol.setup.storesetup > li.cur .actions .btn').map(text)).toEqual(['Copy commit command', 'Finish setup']);
    await r.click(r.byText('ol.setup.storesetup .btn.lime', 'Finish setup'));
    await r.until('the verdict line', () => r!.all('.verdict.sdone').length === 1);
    expect(saved).toEqual([{ finished: true }]);
    expect(toasts).toContain('The store is set up');
    const done = r.one('.verdict.sdone');
    expect(done.getAttribute('class')).toBe('verdict sdone');
    expect(text(done.querySelector('.vw')!)).toBe('set up');
    expect(text(done.querySelector('h2')!)).toBe('set up Your runs are in the bucket.');
    expect(text(done.querySelector('p')!)).toBe('Teammates’ runs show up here as they pull the config and push.');
    expect(done.querySelectorAll('.actions a').map((a) => [text(a), a.getAttribute('class'), a.getAttribute('href')])).toEqual([['Go to Overview', 'btn lime', '#/']]);
  });

  it('says a setup finished before in a verdict line alone, where the steps would be, with the store’s settings and Go to Overview', async () => {
    r = await render(storePage(() => Promise.resolve(viewAt({ active: false, next: null, setup: { startedAt: 1, ci: 'skipped', ciProvider: 'github', finishedAt: 5 }, runs: { onlyLocal: 2, pushedHere: 3 } }))));
    await r.until('the verdict line', () => r!.all('.verdict.sdone').length === 1);
    const done = r.one('.verdict.sdone');
    expect(done.getAttribute('class')).toBe('verdict sdone alone');
    expect(text(done.querySelector('h2')!)).toBe(`set up Runs go to ${URL}`);
    expect(text(done.querySelector('h2 code')!)).toBe(URL);
    expect(text(done.querySelector('p')!)).toBe('2 runs only on this machine. Its settings are in Settings → Store.');
    expect(done.querySelectorAll('.actions a').map((a) => [text(a), a.getAttribute('class'), a.getAttribute('href')])).toEqual([
      ['Open store settings', 'btn', '#/settings/store'],
      ['Go to Overview', 'btn lime', '#/'],
    ]);
    expect(r.all('ol.setup')).toEqual([]);
  });
});

describe('a Settings tab whose read failed', () => {
  it('says so in the sentence every page uses: the status the server answered, where it sent no words of its own', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({}) }, createElement(LoadProblem, { error: new ApiError(500, 'HTTP 500'), retry: () => undefined })));
    expect(r.all('.loaderr p > span').map(text)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    await r.unmount();
    r = await render(createElement(AppContext.Provider, { value: app({}) }, createElement(LoadProblem, { error: new ApiError(409, 'The config changed on disk.'), retry: () => undefined })));
    expect(r.all('.loaderr p > span').map(text)).toEqual(['couldn’t load', 'The config changed on disk.']);
  });
});

describe('a link that names nothing', () => {
  const page = async (kind: NotFoundKind, id: string, o: { exported?: boolean } = {}) => {
    r = await render(createElement(AppContext.Provider, { value: app({}, o) }, createElement(NotFoundPage, { kind, id })));
    const link = r.one('.ph p a.more');
    const out = { eyebrow: text(r.one('.ph .eyebrow')), title: text(r.one('.ph h1')), line: text(r.one('.ph p')), back: [link.getAttribute('href'), text(link)] };
    await r.unmount();
    r = null;
    return out;
  };

  it('says so under the page’s header, the project in its eyebrow, with the way back to the list that holds its kind', async () => {
    expect(await page('page', '#/nowhere')).toEqual({ eyebrow: 'support-agent · not found', title: 'Nothing here', line: 'No page at #/nowhere. Back to Overview', back: ['#/', 'Back to Overview'] });
    expect(await page('run', '01ZZZZZZZZ')).toEqual({ eyebrow: 'support-agent · not found', title: 'Nothing here', line: 'No run 01ZZZZZZZZ. Open Runs', back: ['#/runs', 'Open Runs'] });
    expect((await page('runs', '01M5')).line).toBe('01M5 matches several runs; use more of the id. Open Runs');
    expect(await page('fix', 'fx-nope')).toEqual({ eyebrow: 'support-agent · not found', title: 'Nothing here', line: 'No fix fx-nope. Open Fixes', back: ['#/fixes', 'Open Fixes'] });
    expect(await page('setup', '')).toMatchObject({ line: 'Nothing to set up here. Back to Overview', back: ['#/', 'Back to Overview'] });
    // A copy names no project.
    expect((await page('run', '01ZZZZZZZZ', { exported: true })).eyebrow).toBe('not found');
  });

  it('sets a page’s address in the code face', async () => {
    r = await render(createElement(AppContext.Provider, { value: app({}) }, createElement(NotFoundPage, { kind: 'page', id: '#/nowhere' })));
    expect(r.all('.ph p code').map(text)).toEqual(['#/nowhere']);
  });
});
