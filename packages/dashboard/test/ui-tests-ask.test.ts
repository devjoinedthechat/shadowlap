import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { gateResult, Store, type TestResultData } from '@shadowlap/engine';
import { testsView, type GoldenSource } from '../src/tests.js';
import { ApiError, type Client, type JobView, type TestsView } from '../ui/api.js';
import { TestsAskHost } from '../ui/fixes/TestsJobButton.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { Banner } from '../ui/run/parts.js';
import { Palette } from '../ui/shell/Palette.js';
import { AppContext, type AppState } from '../ui/state.js';
import { testsQuestion } from '../ui/tests-ask.js';
import type { RunDetail, RunOffers } from '../ui/types.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * A Tests job that would run goldens live asks first, wherever it starts. The server answers it with
 * a 409 naming the goldens that go live and why, and the confirm that says yes to it; the shell's
 * dialog then shows those words, the commands the job runs, and the button, opening on Cancel. Only
 * that button sends the job again, with the confirm as its yes. A session that only replays starts on
 * the click. Rendered as the shell renders the dialog, beside the page that started the job.
 */

const T0 = Date.UTC(2026, 9, 20, 10, 0);
const CONFIRM = 'c0ffee'.padEnd(32, '0');
const WORDS = 'goldens/flaky is marked fork, so it runs live from where it forks. Live calls are billed by your provider. Confirm it to run it';
const STEPS = [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/refund-in-limit']];

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

interface Sent {
  kind: string;
  fields: Record<string, unknown>;
}

/**
 * The app as the shell gives it. Its server asks before a job runs live (`live`) until the request
 * says yes with the confirm, or, `again`, whatever it says: a session that changed since the question.
 */
function app(sent: Sent[], watched: Array<Promise<JobView>>, o: { live: boolean; again?: boolean; tests?: TestsView } = { live: true }): AppState {
  const client = {
    tests: () => Promise.resolve(o.tests ?? view()),
    jobs: () => Promise.resolve([]),
    search: () => Promise.resolve({ hits: [] }),
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
    setHelp: () => undefined,
    closeTopLayer: () => false,
    blockingLayer: () => true,
    registerLayer: () => () => undefined,
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
const said = (d: FakeElement) => ({
  title: d.querySelectorAll('h3')[0].textContent,
  text: d.querySelectorAll('header p')[0].textContent,
  commands: d.querySelectorAll('.cmdline').map((c) => c.textContent),
  ok: d.querySelectorAll('.dlg-ok')[0].textContent,
});

describe('a Tests job that would run goldens live', () => {
  it('asks first on Run tests, with the server’s words and the command, and runs only from the dialog’s button, with the yes', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await tests(app(sent, watched));
    await page.click(page.byText('button', 'Run tests'));
    await page.until('the question', () => dialog(page) !== null);
    expect(said(dialog(page)!)).toEqual({ title: 'Run tests', text: `${WORDS}.`, commands: ['$shadowlap test goldens/*'], ok: 'Run tests' });
    // It opens on Cancel: an Enter pressed once too often runs nothing.
    expect(page.focused()).toBe(page.one('.dialog .dlg-cancel'));
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
    // Enter on the focused button, Cancel, clicks it, as a browser does.
    await page.click(page.focused());
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
    expect(said(dialog(page)!)).toEqual({ title: 'Run more attempts on flaky', text: `${WORDS}.`, commands: ['$shadowlap test goldens/flaky --max-attempts 40 --continue'], ok: 'Run more attempts' });
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

describe('the same question from elsewhere', () => {
  const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
  const GOLDEN_RUN = '01M5GRX8K406H4KHQ7DEKYWT00';

  it('asks on a test replay’s banner before Add normalizer re-runs a golden live, with both its commands', async () => {
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
    const offers = { blame: null, test: { golden: 'goldens/refund-in-limit', session: 'S1', volatile: null, normalizerFixes: true, maybeReal: false, normalizeAndTest: STEPS, rulesAdded: false, cause: null } } as unknown as RunOffers;
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await shown(app(sent, watched), createElement(Banner, { run, blame: null, rescued: null, checks: [], offers, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined }));
    await page.click(page.byText('.banner button', 'Add normalizer'));
    await page.until('the question', () => dialog(page) !== null);
    expect(said(dialog(page)!)).toEqual({ title: 'Add normalizer and re-run', text: `${WORDS}.`, commands: ["$shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'", '$shadowlap test goldens/refund-in-limit'], ok: 'Add normalizer and re-run' });
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => watched.length === 1);
    expect(sent).toEqual([
      { kind: 'normalize-and-test', fields: { runId: RUN } },
      { kind: 'normalize-and-test', fields: { runId: RUN, yes: CONFIRM } },
    ]);
  });

  it('asks over whatever page is open when the palette runs the tests, naming no command it doesn’t know', async () => {
    const sent: Sent[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await shown(app(sent, watched), createElement(Palette, { route: { page: 'overview' } }));
    await page.click(page.all('.palit').find((el) => el.textContent.startsWith('Run the tests'))!);
    await page.until('the question', () => dialog(page) !== null);
    expect(said(dialog(page)!)).toEqual({ title: 'Run tests', text: `${WORDS}.`, commands: [], ok: 'Run tests' });
    await page.click(page.one('.dialog .dlg-ok'));
    await page.until('the job', () => watched.length === 1);
    expect(sent.map((s) => s.fields)).toEqual([{}, { yes: CONFIRM }]);
  });
});
