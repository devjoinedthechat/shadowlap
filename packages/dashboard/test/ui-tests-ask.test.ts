import { createElement, useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { gateResult, Store, type TestResultData } from '@shadowlap/engine';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { Spending } from '../../engine/src/estimates/spending.js';
import { testsView, type DivergenceView, type GoldenSource } from '../src/tests.js';
import { ApiError, type Client, type JobView, type TestsView } from '../ui/api.js';
import { TestsAskHost } from '../ui/fixes/TestsAskHost.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { Banner } from '../ui/run/FindingsBar.js';
import { bannerJobsShown } from '../ui/run/diverged.js';
import { estimatesKey, useTestsEstimates } from '../ui/tests-estimates.js';
import { Palette } from '../ui/shell/Palette.js';
import { AppContext, type AppState } from '../ui/state.js';
import { resetSpending, sentEstimate } from '../ui/spending.js';
import { moreAttemptsAsk, rerunAsk, startTestsJob, testsQuestion } from '../ui/tests-ask.js';
import { keepAsk } from '../ui/pages/Setup.js';
import type { RunDetail, RunOffers } from '../ui/types.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * A Tests job that would run goldens live asks first, wherever it starts. The server answers it with
 * a 409 naming the goldens that go live and why, and the confirm that says yes to it; the shell's
 * dialog then shows those words, the commands the job runs, and the button, opening on it as the
 * other asks before a job that bills do. Only that button sends the job again, with the confirm as
 * its yes. A session that only replays starts on the click. Rendered as the shell renders the
 * dialog, beside the page that started the job.
 */

const T0 = Date.UTC(2026, 9, 20, 10, 0);
const CONFIRM = 'c0ffee'.padEnd(32, '0');
const WORDS = 'goldens/flaky is marked fork, so it runs live from where it forks, writes blocked. Live calls are billed by your provider. Confirm it to run it';
const STEPS = [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/refund-in-limit']];
/** The rule alone can't make the replay match: the golden is updated after it. */
const UPDATE_STEPS = [STEPS[0], [...STEPS[1], '--update']];
const NORMALIZE = "$shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'";

const sprt = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 20 };
const GOLDENS: GoldenSource[] = [
  { path: 'goldens/refund-in-limit', runId: null, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] },
  { path: 'goldens/flaky', runId: null, packedAt: T0, mode: 'fork', repeat: 1, passes: 1, gate: sprt, checks: ['issue_refund called 0 times'] },
];

/** The goldens after a session: one that only replays, passed; one marked fork whose gate ran out of attempts between its bounds. */
function view(): TestsView {
  const s = Store.open(':memory:');
  const session = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', startedAt: T0 });
  // Four passes and a failure, four times: the gate ends at its limit between its bounds.
  const g = gateResult(sprt, Array.from({ length: 4 }, () => [true, true, true, true, false]).flat(), { history: null });
  const flaky: TestResultData = { mode: 'fork', attempts: { total: 20, passed: g.passes, required: null, runs: [] }, verdict: 'inconclusive', gate: g, spent: 0.4 };
  s.addTestResult({ sessionId: session.sessionId, golden: 'goldens/refund-in-limit', ok: true, reason: null, runId: null, revision: 'd2e8a1f', at: T0 + 1, data: { mode: 'replay', calls: { total: 8, replayed: 8, live: 0, blocked: 0, stubbed: 0 } } });
  s.addTestResult({ sessionId: session.sessionId, golden: 'goldens/flaky', ok: false, failure: 'inconclusive', reason: 'inconclusive', runId: null, revision: 'd2e8a1f', at: T0 + 2, data: flaky });
  s.finishTestSession(session.sessionId, { passed: 1, failed: 1, upstreamRequests: 0, endedAt: T0 + 100 });
  const v = testsView(s, GOLDENS);
  s.close();
  return v;
}

/** The same goldens, refund-in-limit having diverged on a value made anew on every run: Tests' buttons for it, as `over` has them. */
function diverged(over: Partial<DivergenceView> = {}): TestsView {
  const golden = 'goldens/refund-in-limit';
  const normalizer = { kind: 'api' as const, path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' };
  const volatile = { path: '$.metadata.user_id', looks: 'a UUID', op: 'changed' as const, certain: true, normalizer, args: STEPS[0], command: NORMALIZE.slice(1) };
  const d: DivergenceView = { golden, name: 'refund-in-limit', runId: null, callNo: 1, kind: 'api', callName: 'POST /v1/messages', text: '✗ Diverged at call 1 (api POST /v1/messages)', volatile, normalizerFixes: true, maybeReal: false, rerun: ['test', golden], update: ['test', golden, '--update'], normalizeAndTest: STEPS, rulesAdded: false, bisect: null, found: null, missed: null, revisions: [], unreadable: null, ...over };
  return { ...view(), divergences: [d] };
}

interface Sent {
  kind: string;
  fields: Record<string, unknown>;
}

/**
 * The app as the shell gives it. Its server asks before a job runs live (`live`) until the request
 * says yes with the confirm, or, `again`, whatever it says: a session that changed since the question.
 * `serverJobs` are the jobs it lists, every tab's.
 */
function app(sent: Sent[], watched: Array<Promise<JobView>>, o: { live: boolean; again?: boolean; tests?: TestsView; serverJobs?: unknown[] } = { live: true }): AppState {
  const client = {
    tests: () => Promise.resolve(o.tests ?? view()),
    jobs: () => Promise.resolve(o.serverJobs ?? []),
    search: () => Promise.resolve({ hits: [] }),
    injectionSecurity: () => Promise.resolve({ goldens: [], none: [], unread: [] }),
    coverage: () => Promise.resolve(null),
    startJob: (kind: string, fields: Record<string, unknown>) => {
      sent.push({ kind, fields });
      if (o.live && (o.again || fields.yes !== CONFIRM)) return Promise.reject(new ApiError(409, WORDS, CONFIRM));
      return Promise.resolve({ id: `j${sent.length}`, kind } as JobView);
    },
  } as unknown as Client;
  return {
    client,
    exported: false,
    meta: null,
    conn: 'ok',
    tick: 0,
    runsTick: 0,
    feeds: {},
    jobs: [],
    live: [],
    runs: [],
    runCommands: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: (p: Promise<JobView>) => void watched.push(p.catch((err: unknown) => ({ id: 'refused', error: err }) as unknown as JobView)),
    toast: () => undefined,
    palette: true,
    setPalette: () => undefined,
    setSideOpen: () => undefined,
    setHelp: () => undefined,
  } as unknown as AppState;
}

const g = globalThis as { location?: unknown };
let r: Rendered | null = null;
afterEach(async () => {
  // A question left open by a test is answered no, so the next starts with none.
  if (r && testsQuestion()) await r.click(r.one('.dialog .dlg-cancel'));
  await r?.unmount();
  r = null;
  delete g.location;
});

/** `page` with the shell's dialog beside it, in the app given. */
async function shown(state: AppState, page: ReactElement): Promise<Rendered> {
  g.location = { hash: '#/tests' };
  r = await render(createElement(AppContext.Provider, { value: state }, createElement('main', { id: 'view', tabIndex: -1 }, page, createElement(TestsAskHost))));
  return r;
}

async function tests(state: AppState): Promise<Rendered> {
  const page = await shown(state, createElement(TestsPage));
  await page.until('the goldens to load', () => page.all('table.gt tbody tr').length === 2);
  return page;
}

/** The dialog the shell shows, when one shows. */
const dialog = (page: Rendered): FakeElement | null => page.all('.scrim .dialog')[0] ?? null;
/** Whether the dialog showing is the one titled so: a job's own dialog comes first, then its question. */
const titled = (page: Rendered, title: string) => () => dialog(page)?.querySelectorAll('h3')[0]?.textContent === title;
const MORE_LEAD = 'Carries its gate on from attempt 21, for this session only.';

const said = (d: FakeElement) => ({
  title: d.querySelectorAll('h3')[0].textContent,
  lead: d.querySelectorAll('header p span')[0].textContent,
  commands: d.querySelectorAll('.cmdline .cstep').length ? d.querySelectorAll('.cmdline .cstep').map((c) => c.textContent) : d.querySelectorAll('.cmdline').map((c) => c.textContent),
  ok: d.querySelectorAll('.dlg-ok')[0].textContent,
});

describe('a Tests job that would run goldens live', () => {
  it('asks first on Run tests, with the server’s words and the command, and runs only from the dialog’s button, with the yes', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await tests(app(sent, watched));
    await page.click(page.byText('button', 'Run tests'));
    await page.until('the question', () => dialog(page) !== null);
    expect(said(dialog(page)!)).toEqual({ title: 'Run tests', lead: 'Replays every golden, as CI does.', commands: ['$shadowlap test goldens/*'], ok: 'Run tests' });
    // It opens on its button, as the other asks before a job that bills do: Cancel takes the focus
    // first only in a dialog that deletes, or runs a command someone else recorded.
    expect(page.focused()).toBe(page.one('.dialog .dlg-ok'));
    expect(watched).toEqual([]);
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => watched.length === 1);
    expect(sent).toEqual([
      { kind: 'test', fields: {} },
      { kind: 'test', fields: { yes: CONFIRM } },
    ]);
    expect(await watched[0]).toMatchObject({ id: 'j2' });
    expect(dialog(page)).toBeNull();
  });

  it('runs nothing when the question is cancelled, and asks again on the next click', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await tests(app(sent, watched));
    await page.click(page.byText('button', 'Run tests'));
    await page.until('the question', () => dialog(page) !== null);
    await page.click(page.one('.dialog .dlg-cancel'));
    expect(dialog(page)).toBeNull();
    expect(testsQuestion()).toBeNull();
    expect(watched).toEqual([]);
    await page.click(page.byText('button', 'Run tests'));
    await page.until('the question again', () => dialog(page) !== null);
    expect(sent.map((s) => s.fields)).toEqual([{}, {}]);
  });

  it('starts a session that only replays on the click, asking nothing', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await tests(app(sent, watched, { live: false }));
    await page.click(page.byText('button', 'Run tests'));
    await page.until('the job', () => watched.length === 1);
    expect(dialog(page)).toBeNull();
    expect(sent).toEqual([{ kind: 'test', fields: {} }]);
  });

  it('asks before more attempts of a golden marked fork, naming it, with the command they run', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await tests(app(sent, watched));
    await page.click(page.byText('button', 'Run more attempts'));
    await page.until('the question', () => dialog(page) !== null);
    expect(said(dialog(page)!)).toEqual({ title: 'Run more attempts on flaky', lead: MORE_LEAD, commands: ['$shadowlap test goldens/flaky --max-attempts 40 --continue'], ok: 'Run more attempts' });
    // Its cost line in the estimate's words: one more is one attempt.
    expect(moreAttemptsAsk('flaky', { args: [], attempts: 8, most: 1, expected: 1, settles: 0.5 }).parts).toEqual(['up to 1 more attempt', 'live from where the golden forks, writes blocked']);
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => watched.length === 1);
    expect(sent.map((s) => s.fields)).toEqual([
      { golden: 'goldens/flaky', maxAttempts: 40, continue: true },
      { golden: 'goldens/flaky', maxAttempts: 40, continue: true, yes: CONFIRM },
    ]);
  });

  it('shows a second question, after its yes, as the job’s refusal, never asking in a loop', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await tests(app(sent, watched, { live: true, again: true }));
    await page.click(page.byText('button', 'Run tests'));
    await page.until('the question', () => dialog(page) !== null);
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the refusal', () => watched.length === 1);
    expect(dialog(page)).toBeNull();
    expect(((await watched[0]) as unknown as { error: ApiError }).error).toMatchObject({ status: 409, message: WORDS });
    expect(sent).toHaveLength(2);
  });
});

describe('the same question from Tests’ other buttons, on a golden that diverged', () => {
  it('asks before Re-run test, once the golden’s normalizer is in the config, with the command it runs', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await tests(app(sent, watched, { live: true, tests: diverged({ rulesAdded: true }) }));
    await page.click(page.byText('button', 'Re-run test'));
    await page.until('the question', () => dialog(page) !== null);
    expect(said(dialog(page)!)).toEqual({ title: 'Re-run refund-in-limit', lead: 'Replays refund-in-limit again, live from where it forks.', commands: ['$shadowlap test goldens/refund-in-limit'], ok: 'Re-run' });
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => watched.length === 1);
    expect(sent).toEqual([
      { kind: 'test', fields: { golden: 'goldens/refund-in-limit' } },
      { kind: 'test', fields: { golden: 'goldens/refund-in-limit', yes: CONFIRM } },
    ]);
  });

  it('asks before Add normalizer and re-run, with both its commands', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await tests(app(sent, watched, { live: true, tests: diverged() }));
    await page.click(page.byText('button', 'Add normalizer and re-run'));
    await page.until('the question', () => dialog(page) !== null);
    expect(said(dialog(page)!)).toEqual({ title: 'Add normalizer and re-run', lead: 'Masks the value, then tests the golden again.', commands: [NORMALIZE, '$shadowlap test goldens/refund-in-limit'], ok: 'Add normalizer and re-run' });
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => watched.length === 1);
    expect(sent.map((x) => x.fields)).toEqual([{ golden: 'goldens/refund-in-limit' }, { golden: 'goldens/refund-in-limit', yes: CONFIRM }]);
  });

  it('asks before Add normalizer and update once its own dialog is answered, naming the update among its commands', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await tests(app(sent, watched, { live: true, tests: diverged({ normalizerFixes: false, normalizeAndTest: UPDATE_STEPS }) }));
    await page.click(page.byText('button', 'Add normalizer and update'));
    await page.until('its own dialog', titled(page, 'Add normalizer and update refund-in-limit?'));
    expect(sent).toEqual([]);
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the question', (() => dialog(page)?.querySelectorAll('.dfacts').length === 1));
    expect(said(dialog(page)!)).toEqual({ title: 'Add normalizer and update refund-in-limit?', lead: 'Masks the value, then re-records refund-in-limit, for a change you meant.', commands: [NORMALIZE, '$shadowlap test goldens/refund-in-limit --update'], ok: 'Add normalizer and update' });
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => watched.length === 1);
    expect(sent).toEqual([
      { kind: 'normalize-and-test', fields: { golden: 'goldens/refund-in-limit' } },
      { kind: 'normalize-and-test', fields: { golden: 'goldens/refund-in-limit', yes: CONFIRM } },
    ]);
  });

  it('asks before what Update golden’s dialog offers instead, the normalizer and a re-run', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await tests(app(sent, watched, { live: true, tests: diverged() }));
    await page.click(page.byText('button', 'Update golden'));
    await page.until('its own dialog', titled(page, 'Update refund-in-limit?'));
    await page.click(page.byText('.dialog button', 'Add normalizer and re-run'));
    await page.until('the question', titled(page, 'Add normalizer and re-run'));
    expect(said(dialog(page)!)).toEqual({ title: 'Add normalizer and re-run', lead: 'Masks the value, then tests the golden again.', commands: [NORMALIZE, '$shadowlap test goldens/refund-in-limit'], ok: 'Add normalizer and re-run' });
    expect(sent).toEqual([{ kind: 'normalize-and-test', fields: { golden: 'goldens/refund-in-limit' } }]);
  });
});

describe('the same question from elsewhere', () => {
  const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
  const GOLDEN_RUN = '01M5GRX8K406H4KHQ7DEKYWT00';

  /** A test replay of refund-in-limit that diverged on a value made anew on every run, its banner offering `steps` to add the rule. */
  function banner(steps: string[][]): ReactElement {
    const run = {
      run: { runId: RUN, parentRunId: GOLDEN_RUN, mode: 'replay', status: 'completed', divergence: { callNo: 1, type: 'request_changed', kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.metadata.user_id', op: 'changed' }] }, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: 'd2e8a1f', startedAt: 1, endedAt: 2, meta: { test: { golden: 'goldens/refund-in-limit', session: 'S1' } } },
      summary: { upstreamRequests: 0, byKind: { api: 1, tool: 0, clock: 0, random: 0 }, cost: { spent: 0, saved: 0, captured: 0, unknownModels: [] }, imported: false },
      calls: [],
      actions: [],
      parent: { runId: GOLDEN_RUN, label: 'recording' },
      source: null,
      fix: null,
      intervention: null,
      interventions: [],
      state: null,
    } as unknown as RunDetail;
    const offers = { blame: null, test: { golden: 'goldens/refund-in-limit', session: 'S1', volatile: null, normalizerFixes: true, maybeReal: false, normalizeAndTest: steps, rulesAdded: false, cause: null } } as unknown as RunOffers;
    return createElement(Banner, { run, blame: null, rescued: null, checks: [], offers, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined });
  }

  it('asks on a test replay’s banner before Add normalizer and re-run runs a golden live, with both its commands', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await shown(app(sent, watched), banner(STEPS));
    // The banner's button is named as its dialog is titled and confirmed: one name for the action.
    await page.click(page.byText('.banner button', 'Add normalizer and re-run'));
    await page.until('the question', () => dialog(page) !== null);
    expect(said(dialog(page)!)).toEqual({ title: 'Add normalizer and re-run', lead: 'Masks the value, then tests the golden again.', commands: ["$shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'", '$shadowlap test goldens/refund-in-limit'], ok: 'Add normalizer and re-run' });
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => watched.length === 1);
    expect(sent).toEqual([
      { kind: 'normalize-and-test', fields: { runId: RUN } },
      { kind: 'normalize-and-test', fields: { runId: RUN, yes: CONFIRM } },
    ]);
  });

  it('asks on a test replay’s banner before Add normalizer and update, once its own dialog is answered', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await shown(app(sent, watched), banner(UPDATE_STEPS));
    await page.click(page.byText('.banner button', 'Add normalizer and update'));
    await page.until('its own dialog', titled(page, 'Add normalizer and update refund-in-limit?'));
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the question', (() => dialog(page)?.querySelectorAll('.dfacts').length === 1));
    expect(said(dialog(page)!)).toEqual({ title: 'Add normalizer and update refund-in-limit?', lead: 'Masks the value, then re-records refund-in-limit, for a change you meant.', commands: [NORMALIZE, '$shadowlap test goldens/refund-in-limit --update'], ok: 'Add normalizer and update' });
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => watched.length === 1);
    expect(sent.map((x) => x.fields)).toEqual([{ runId: RUN }, { runId: RUN, yes: CONFIRM }]);
  });

  it('says each banner job’s estimate on its card, from Tests’ estimates for its golden, and Spending answers its question with it', async () => {
    resetSpending(0.5);
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const state = app(sent, watched);
    const live: Estimate = { kind: 'tests', usd: 0.3, ceiling: false, parts: ['live from where it forks'] };
    const update: Estimate = { kind: 'update', usd: 0.2, ceiling: false, always: 'it replaces goldens', parts: ['as its recording cost'] };
    Object.assign(state.client, { estimates: { testsEstimates: () => Promise.resolve({ run: null, goldens: { 'goldens/refund-in-limit': { rerun: live, update, normalize: live } } }) } });
    const page = await shown(state, banner(STEPS));
    const card = (label: string) => JSON.parse(page.byText('.banner button', label).getAttribute('data-tip') ?? '{}') as { s?: string; cmd?: string; est?: unknown };
    await page.until('the estimates', () => !!card('Add normalizer and re-run').est);
    expect(card('Add normalizer and re-run')).toMatchObject({ s: 'Masks the value at match time, then replays the golden offline', est: { usd: 0.3, ceiling: false } });
    expect(card('Update golden')).toMatchObject({ s: 'It re-records the golden under the change', cmd: 'shadowlap test goldens/refund-in-limit --update', est: { usd: 0.2, always: 'it replaces goldens' } });
    await page.click(page.byText('.banner button', 'Add normalizer and re-run'));
    await page.until('the yes', () => sent.length === 2);
    expect(sent.map((x) => x.fields)).toEqual([{ runId: RUN, estimate: { usd: 0.3, ceiling: false } }, { runId: RUN, estimate: { usd: 0.3, ceiling: false }, yes: CONFIRM }]);
    expect(dialog(page)).toBeNull();
    resetSpending();
  });

  it('reads a banner’s estimates only where one of its job buttons shows, not where the header leads with them', () => {
    const run = { actions: [] } as unknown as RunDetail;
    const test = { golden: 'goldens/refund-in-limit', normalizeAndTest: STEPS } as unknown as RunOffers['test'];
    const all = { hasKind: () => true, actionsOff: null };
    const leads = (key: string) => key === 'normalizer' || key === 'update-golden';
    expect([bannerJobsShown(all, run, test, () => false), bannerJobsShown(all, run, test, (key) => key === 'normalizer'), bannerJobsShown(all, run, test, leads)]).toEqual([true, true, false]);
    expect(bannerJobsShown({ hasKind: (k: string) => k !== 'test-update', actionsOff: null }, run, test, (key) => key === 'normalizer')).toBe(false);
  });

  it('asks over whatever page is open when the palette runs the tests, with the command Tests lists', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await shown(app(sent, watched), createElement(Palette, { route: { page: 'overview' } }));
    await page.click(page.all('.palit').find((el) => el.textContent.startsWith('Run tests'))!);
    await page.until('the question', () => dialog(page) !== null);
    expect(said(dialog(page)!)).toEqual({ title: 'Run tests', lead: 'Replays every golden, as CI does.', commands: ['$shadowlap test goldens/*'], ok: 'Run tests' });
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => watched.length === 1);
    expect(sent.map((s) => s.fields)).toEqual([{}, { yes: CONFIRM }]);
  });

  it('asks nothing from the palette while a job holds the working tree, which would refuse the session after the yes, and says so', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const repair = { id: 'j-repair', kind: 'repair', done: false, worktree: { use: 'writes', doing: 'a repair is verifying candidates made from your working tree', folder: null } };
    const page = await shown(app(sent, watched, { live: true, serverJobs: [repair] }), createElement(Palette, { route: { page: 'overview' } }));
    await page.click(page.all('.palit').find((el) => el.textContent.startsWith('Run tests'))!);
    await page.until('the refusal', () => watched.length === 1);
    expect(dialog(page)).toBeNull();
    expect(testsQuestion()).toBeNull();
    expect(((await watched[0]) as unknown as { error: Error }).error.message).toBe('A repair is verifying candidates made from your working tree: run the tests once it is done.');
    expect(sent.map((s) => s.fields)).toEqual([{}]);
  });
});

describe('a live session’s question, answered by Spending', () => {
  const PRICED: Estimate = { kind: 'tests', usd: 0.3, ceiling: false, parts: ['what the last session spent live'] };
  const FREE: Estimate = { kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] };
  afterEach(() => resetSpending());

  /** Re-run on a golden marked fork, the page knowing its price as `estimate`, at the threshold `v`. */
  async function rerun(v: Spending | undefined, estimate: Estimate | null | undefined, kind = 'test') {
    resetSpending(v);
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const state = app(sent, watched);
    const page = await shown(state, createElement('div'));
    startTestsJob(state, kind, { golden: 'goldens/flaky', ...sentEstimate(estimate) }, { ...rerunAsk('flaky', 'goldens/flaky'), estimate });
    await page.until('the question answered or asked', () => sent.length === 2 || !!dialog(page));
    return { page, sent, watched };
  }
  const yeses = (sent: Sent[]) => sent.filter((s) => s.fields.yes !== undefined);

  it('says yes at once at or under the threshold, the job keeping the estimate its drawer says', async () => {
    const { page, sent, watched } = await rerun(0.5, PRICED);
    expect(dialog(page)).toBeNull();
    expect(sent.map((s) => s.fields)).toEqual([
      { golden: 'goldens/flaky', estimate: { usd: 0.3, ceiling: false } },
      { golden: 'goldens/flaky', estimate: { usd: 0.3, ceiling: false }, yes: CONFIRM },
    ]);
    expect(await watched[0]).toMatchObject({ id: 'j2' });
  });

  it('asks above the threshold, its Cost line the estimate and its footer why it asks', async () => {
    const { page, sent } = await rerun(0.1, PRICED);
    const d = dialog(page)!;
    expect(d.querySelectorAll('.dcost')[0].textContent).toContain('≈$0.30');
    expect(d.querySelectorAll('.dlgcost')[0].textContent).toBe('Asks above $0.10 · Change');
    expect(yeses(sent)).toEqual([]);
    await page.click(page.one('.dialog .dlg-ok'));
    expect(yeses(sent).map((s) => s.fields)).toEqual([{ golden: 'goldens/flaky', estimate: { usd: 0.3, ceiling: false }, yes: CONFIRM }]);
  });

  it('asks on every setting with no estimate, and where the page said Free as the server says it runs live', async () => {
    for (const estimate of [null, undefined, FREE]) {
      const { page, sent } = await rerun(null, estimate);
      expect(dialog(page)?.querySelectorAll('h3')[0].textContent).toBe('Re-run flaky');
      expect(dialog(page)?.querySelectorAll('.dcost')[0].textContent).toContain('Billed by your provider');
      expect(page.all('.dialog .dlgcost')).toHaveLength(0);
      expect(yeses(sent)).toEqual([]);
      await page.click(page.one('.dialog .dlg-cancel'));
      await r?.unmount();
      r = null;
    }
  });

  it('says yes at once on Never ask with an estimate, but never to an injection test’s question, a command someone else recorded', async () => {
    const plain = await rerun(null, PRICED);
    expect(dialog(plain.page)).toBeNull();
    expect(yeses(plain.sent)).toHaveLength(1);
    await r?.unmount();
    r = null;
    const injection = await rerun(null, PRICED, 'injection');
    expect(dialog(injection.page)).not.toBeNull();
    expect(yeses(injection.sent)).toEqual([]);
  });

  it('asks Keep it as a test’s question on every setting, in the step’s words, its yes going through the page that asked', async () => {
    // Nothing prices it: even one that came with a price, at Never ask, waits for its dialog.
    const priced = await rerun(null, PRICED, 'pack-test');
    expect(dialog(priced.page)).not.toBeNull();
    expect(yeses(priced.sent)).toEqual([]);
    await priced.page.click(priced.page.one('.dialog .dlg-cancel'));
    await r?.unmount();
    r = null;
    const sent: Sent[] = [];
    const shell: Array<Promise<JobView>> = [];
    const state = app(sent, shell);
    const page = await shown(state, createElement('div'));
    const setup: Array<Promise<JobView>> = [];
    startTestsJob({ client: state.client, guard: state.guard, watchJob: (p) => void setup.push(p) }, 'pack-test', { project: 'p', golden: 'goldens/first-run' }, keepAsk('Pack as golden', 'goldens/first-run', true));
    await page.until('the question asked', () => !!dialog(page));
    expect(dialog(page)?.querySelectorAll('h3')[0].textContent).toBe('Pack as golden');
    expect(dialog(page)?.textContent).toContain('Packs the run as goldens/first-run, then runs its test.');
    expect(dialog(page)?.textContent).toContain('shadowlap test goldens/first-run');
    expect(yeses(sent)).toEqual([]);
    await page.click(page.one('.dialog .dlg-ok'));
    expect(yeses(sent).map((x) => x.fields)).toEqual([{ project: 'p', golden: 'goldens/first-run', yes: CONFIRM }]);
    // Setup follows the job its yes started, as it follows those it starts itself, not the shell.
    await page.until('the page following its job', () => setup.length === 1);
    expect([await setup[0], shell]).toMatchObject([{ id: 'j2' }, []]);
  });
});

describe('Tests’ buttons, priced from the page’s estimates', () => {
  const RUN: Estimate = { kind: 'tests', usd: 0.3, ceiling: false, parts: ['what the last session spent live'] };
  const UPDATE: Estimate = { kind: 'update', usd: 0.2, ceiling: false, always: 'it replaces goldens', parts: ['as its recording cost'] };
  const RERUN: Estimate = { kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] };
  afterEach(() => resetSpending());

  /** Tests at the threshold `v`, its server pricing Run tests and refund-in-limit's jobs as above. */
  async function priced(v: Spending, tests?: TestsView) {
    resetSpending(v);
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const state = app(sent, watched, { live: true, ...(tests ? { tests } : {}) });
    const reads: string[] = [];
    const goldens = { 'goldens/refund-in-limit': { rerun: RERUN, update: UPDATE, normalize: RERUN } };
    Object.assign(state.client, { estimates: { testsEstimates: () => (reads.push('tests'), Promise.resolve({ run: RUN, goldens })) } });
    const page = await tests_(state);
    await page.until('the estimates', () => reads.length > 0 && !!card(page, 'Run tests').est);
    return { page, sent, watched, reads };
  }
  const tests_ = tests;
  const card = (page: Rendered, label: string) => JSON.parse(page.byText('button', label).getAttribute('data-tip') ?? '{}') as { t?: string; s?: string; cmd?: string; est?: Record<string, unknown> };

  it('reads the estimates again only as what they are worked out from changes, not each time the page loads again', async () => {
    const reads: Array<readonly string[] | undefined> = [];
    const state = app([], []);
    Object.assign(state.client, { estimates: { testsEstimates: (update?: readonly string[]) => (reads.push(update), Promise.resolve({ run: RUN, goldens: {} })) } });
    function Reader() {
      const [loads, setLoads] = useState(0);
      // Each load is a new view and a new list of the same goldens; the third's first golden has a newer result.
      const rows = view().rows.map((row, i) => (loads > 1 && !i ? { ...row, runId: 'R-newer' } : row));
      useTestsEstimates(estimatesKey({ rows }), ['goldens/refund-in-limit']);
      return createElement('button', { type: 'button', onClick: () => setLoads(loads + 1) }, 'Load again');
    }
    const page = await shown(state, createElement(Reader));
    await page.until('the first read', () => reads.length === 1);
    await page.click(page.byText('button', 'Load again'));
    await page.wait(0);
    expect(reads).toHaveLength(1);
    await page.click(page.byText('button', 'Load again'));
    await page.until('a read for the newer result', () => reads.length === 2);
    expect(reads).toEqual([['goldens/refund-in-limit'], ['goldens/refund-in-limit']]);
  });

  it('says Run tests’ estimate on its card, and answers the server’s question with it by Spending, posting first either way', async () => {
    const { page, sent } = await priced(0.5);
    expect(card(page, 'Run tests')).toMatchObject({ s: 'Replays every golden offline; a golden marked fork runs live from where it forks', est: { usd: 0.3, ceiling: false } });
    await page.click(page.byText('button', 'Run tests'));
    await page.until('the yes', () => sent.length === 2);
    expect(sent.map((s) => s.fields)).toEqual([{ estimate: { usd: 0.3, ceiling: false } }, { estimate: { usd: 0.3, ceiling: false }, yes: CONFIRM }]);
    expect(dialog(page)).toBeNull();
  });

  it('asks above the threshold in the server’s question only, once, its Cost line the estimate', async () => {
    const { page, sent } = await priced(0.1);
    await page.click(page.byText('button', 'Run tests'));
    await page.until('the question', () => dialog(page) !== null);
    expect(sent).toHaveLength(1);
    expect(dialog(page)!.querySelectorAll('.dcost')[0].textContent).toContain('≈$0.30');
  });

  it('says Update golden’s estimate and asks first on every setting, its dialog’s Cost line the estimate and its job keeping it', async () => {
    const { page, sent } = await priced(null, diverged());
    expect(card(page, 'Update golden')).toMatchObject({ s: 'It re-records the golden under the change', cmd: 'shadowlap test goldens/refund-in-limit --update', est: { usd: 0.2, always: 'it replaces goldens' } });
    expect(card(page, 'Add normalizer and re-run').est).toEqual({ usd: 0, ceiling: false });
    await page.click(page.byText('button', 'Update golden'));
    await page.until('its dialog', () => dialog(page) !== null);
    // The lime way on, Add normalizer, keeps its own line beside Update anyway's estimate.
    const lines = dialog(page)!.querySelectorAll('.dcost').map((c) => (c.textContent ?? '').replace(/\s+/g, ' '));
    expect(lines[0]).toBe('Free · replays offline');
    expect(lines[1]).toContain('≈$0.20');
    expect(sent).toEqual([]);
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => sent.length === 1);
    expect(sent[0]).toEqual({ kind: 'test-update', fields: { golden: 'goldens/refund-in-limit', estimate: { usd: 0.2, ceiling: false } } });
  });

  it('answers the palette’s Run tests by Spending too, from the estimate it reads once the server asks', async () => {
    resetSpending(0.5);
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const state = app(sent, watched);
    Object.assign(state.client, { estimates: { testsEstimates: () => Promise.resolve({ run: RUN, goldens: {} }) } });
    const page = await shown(state, createElement(Palette, { route: { page: 'overview' } }));
    await page.click(page.all('.palit').find((el) => el.textContent.startsWith('Run tests'))!);
    await page.until('the yes', () => sent.length === 2);
    expect(sent.map((s) => s.fields)).toEqual([{}, { estimate: { usd: 0.3, ceiling: false }, yes: CONFIRM }]);
    expect(dialog(page)).toBeNull();
  });
});
