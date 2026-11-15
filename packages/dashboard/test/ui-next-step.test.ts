import { createElement } from 'react';
import { PAUSED } from '../ui/connection.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Client } from '../ui/api.js';
import { fixStatusWords, nextStepOf, stepCard, stepCostLine } from '../ui/run/next-step.js';
import { Banner } from '../ui/run/FindingsBar.js';
import { useWholeStep } from '../ui/run/NextStepButton.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { ScopeBar } from '../ui/run/parts.js';
import { scopeBlame } from '../ui/fixes/RunBlame.js';
import { SERVED_PARTS } from '../ui/pages/served.js';
import { ServedPartsContext } from '../ui/served-parts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { TestsAskHost } from '../ui/fixes/TestsAskHost.js';
import type { BlameOffer, NextStep, RunDetail, RunOffers, TestBannerOffer } from '../ui/types.js';
import { render, shownText, type Rendered } from './ui-render.js';
import { STEP_PARTS } from './ui-served-now.js';
import { resetSpending } from '../ui/spending.js';

/**
 * The run page leads with the run's next step, as the server works it out (src/next-step.ts), its one
 * lime button: each kind draws what it opens or the job it runs, says on hover what it does, bills and
 * runs, and the banner never offers it again.
 */

const REC = '01M5JEQWA2QMJ3NYD1C687WP08';
const PARENT = '01M5JEQXRGBX1QXGW0X8A3ZB4C';
const GOLDEN = 'goldens/refund-in-limit';

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  resetSpending();
});

/** What Run injection test's dialog reads where its step hands it no reads: two templates, one untrusted read, and no price yet. */
const INJECTION_READS = {
  injectionTemplates: () => Promise.resolve({ version: 1, updated: '2026-01-01', templates: [{ id: 'system-notice', shape: 'notice', title: 'A system notice', text: 'SYSTEM: {{canary}}' }, { id: 'user-urgent', shape: 'user', title: 'An urgent user', text: 'URGENT {{canary}}' }] }),
  injectionRun: () => Promise.resolve({ untrusted: [{ callNo: 4, name: 'get_ticket', from: 'config', readAt: 5 }], results: [], rule: null, answers: [], cause: [], attempt: null }),
  injectionEstimate: () => new Promise(() => undefined),
  checks: { goldens: () => Promise.resolve({ version: 'v1', read: { keys: {}, tests: {} } }) },
};

function app(o: Partial<AppState> = {}, client: Partial<Client> = {}): AppState {
  return {
    client: { jobs: () => Promise.resolve([]), ...INJECTION_READS, ...client } as unknown as Client,
    exported: false,
    meta: null,
    tick: 0,
    runsTick: 0,
    feeds: {},
    jobs: [],
    live: [],
    runs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    ...o,
  } as unknown as AppState;
}

const failedState = { status: 'completed', kind: 'recording', outcome: { kind: 'lost', check: null }, failed: true, interrupted: false, label: 'recording' };
const passedState = { status: 'completed', kind: 'recording', outcome: { kind: 'none' }, failed: false, interrupted: false, label: 'recording' };
const REPLAY: NextStep = { key: 'replay', label: 'Replay', runId: REC, command: `shadowlap replay ${REC.slice(0, 10)}` };

function detail(o: { next?: NextStep | null; replay?: NextStep | null; parent?: string | null; status?: string; state?: unknown; fix?: unknown; meta?: Record<string, unknown>; divergence?: unknown; blame?: unknown; actions?: unknown[]; source?: string | null } = {}): RunDetail {
  return {
    run: { runId: REC, parentRunId: o.parent ?? null, mode: o.parent ? 'replay' : 'record', status: o.status ?? 'completed', divergence: o.divergence ?? null, command: { argv: ['node', 'agent.mjs', 'A-1103'], cwd: '.' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: o.meta ?? {} },
    summary: { upstreamRequests: 5, byKind: { api: 5, tool: 4, clock: 0, random: 0 }, cost: { spent: 0.0037, saved: 0, captured: 0, unknownModels: [] }, imported: false },
    calls: [],
    actions: o.actions ?? [{ key: 'r', label: 'Replay' }],
    children: [],
    parent: o.parent ? { runId: o.parent, label: 'recording' } : null,
    source: o.source ?? null,
    fix: o.fix ?? null,
    blame: o.blame ?? null,
    state: o.state ?? null,
    ...(o.next ? { next: o.next } : {}),
    replay: o.replay ?? REPLAY,
  } as unknown as RunDetail;
}

const header = (run: RunDetail, offers: RunOffers | null = null, more: { onAction?: (p: unknown) => void; onFindCommit?: () => void } = {}) => ({ run, judged: run.judged ?? null, call: null, selected: 5, rescued: false, offers, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: more.onAction ?? (() => undefined), onFindCommit: more.onFindCommit ?? (() => undefined) });
const bannerProps = (run: RunDetail, offers: RunOffers | null = null) => ({ run, blame: (run as unknown as { blame: never }).blame ?? null, rescued: null, checks: [], offers, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined });
const lime = (p: Rendered) => p.all('.rhead .actions .lime').map((b) => b.textContent);
const tip = (el: { props: Record<string, unknown> }) => JSON.parse(String(el.props['data-tip'])) as { t: string; s?: string; rows?: string[][]; cmd?: string };

/** The header and the banner, as the page draws them, with the question a Tests job waits on. */
/** The header and the banner on the served dashboard, which hands in what only it draws, such as Run blame's dialogs, the step dialogs' script already in. */
const both = (run: RunDetail, offers: RunOffers | null = null, a: AppState = app(), more: Parameters<typeof header>[2] = {}) =>
  createElement(AppContext.Provider, { value: a }, createElement(ServedPartsContext.Provider, { value: { ...SERVED_PARTS, ...STEP_PARTS } }, createElement('div', null, createElement(RunHeader, header(run, offers, more)), createElement(Banner, bannerProps(run, offers)), createElement(TestsAskHost))));

/** An app that records the jobs it is asked to start. */
function jobs(o: Partial<AppState> = {}) {
  const started: Array<[string, Record<string, unknown>]> = [];
  const a = app(o, {
    startJob: (kind: string, fields: Record<string, unknown>) => {
      started.push([kind, fields]);
      return Promise.resolve({ id: 'j1' }) as never;
    },
  });
  return { a, started };
}

const OFFER = { key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] } } as const satisfies NextStep;
const TEST_OFFER = { golden: GOLDEN, session: 's1', volatile: null, normalizerFixes: true, maybeReal: false, values: { values: [{ path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', certain: true, normalizer: { path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' } }], explainsAll: true, coversAll: true }, rerun: ['test', GOLDEN], update: ['test', GOLDEN, '--update'], normalizeAndTest: [['normalize', 'add'], ['test', GOLDEN]], rulesAdded: false, cause: null, normalized: false, passingRun: null, checks: [] } as unknown as TestBannerOffer;
const DIVERGED = { parent: PARENT, state: { ...failedState, kind: 'test', outcome: { kind: 'diverged', check: null } }, divergence: { callNo: 3, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 2 }, meta: { test: { golden: GOLDEN, session: 's1' } } };

describe('the run page’s next step', () => {
  const verified = { id: 'fx-01M5JERA0H', status: 'verified', title: 'Refunds above the limit issued without approval', href: '#/fixes/fx-01M5JERA0H/blame' };
  const FIX: NextStep = { key: 'fix', label: 'Open fix', fixId: verified.id, status: 'verified', check: 'exit code 0', href: verified.href, title: `“${verified.title}”` };
  const lost = { callNo: 5, confidence: 'high', rescuedRunId: null, scope: null, outcome: 'blamed', modelCall: { k: 3, m: 5 }, short: 'asked again, it calls escalate instead' };

  it('opens the fix of a blamed failure, its status on hover and in the banner, where Fix → was', async () => {
    const run = detail({ state: failedState, fix: verified, blame: lost, next: FIX });
    expect(nextStepOf(run)).toEqual(FIX);
    page = await render(both(run));
    expect(lime(page)).toEqual(['Open fix']);
    const open = page.byText('.rhead .actions a', 'Open fix');
    expect(open.props.href).toBe(verified.href);
    // Verified and not applied: never "ready to apply", which a patch merged or in the working tree already isn't.
    expect(tip(open)).toMatchObject({ t: `“${verified.title}”`, s: 'verified: a change fixed its failing runs, not applied yet' });
    expect(page.byText('.rhead .actions button', 'Replay').className).toBe('btn');
    // The banner says how the fix stands instead of linking it again.
    expect(shownText(page.one('.banner .bk'))).toBe('lost at');
    expect(page.all('.banner a').some((a) => a.textContent === 'Fix →')).toBe(false);
    expect(page.one('.banner .st').className).toBe('st ok');
    expect(page.one('.banner .st').textContent).toBe('fix verified');
  });

  it('says on the run page a fix applied whose goldens failed since is broken, in red, never applied in lime', async () => {
    // As the server says it (fix-for-run.ts `fixSaid`), on the run's fix and its Open fix alike.
    const said = { tone: 'err', text: 'fix broken', why: 'applied, but it doesn’t hold: shadowlap test failed on its goldens' } as const;
    const broken = { ...verified, status: 'applied', said };
    const run = detail({ state: failedState, fix: broken, blame: lost, next: { ...FIX, status: 'applied', said } });
    page = await render(both(run));
    expect(tip(page.byText('.rhead .actions a', 'Open fix'))).toMatchObject({ s: 'applied, but it doesn’t hold: shadowlap test failed on its goldens' });
    expect(page.one('.banner .st').className).toBe('st err');
    expect(page.one('.banner .st').textContent).toBe('fix broken');
  });

  it('says a run lost gradually around two calls so in its banner, each call one to select, never lost at the first', async () => {
    const selected: number[] = [];
    const run = detail({ state: failedState, fix: verified, blame: { ...lost, range: { from: 5, to: 7, gradual: true } }, next: FIX });
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(Banner, { ...bannerProps(run), onSelect: (n: number) => selected.push(n) })));
    expect(shownText(page.one('.banner .bk'))).toBe('lost gradually around');
    expect(page.all('.banner .bn').map((b) => b.textContent)).toEqual(['#5', '#7']);
    expect(page.one('.banner').textContent).toContain('#5 and #7');
    // Its tally kept whole where the line wraps, as every finding keeps one.
    expect(page.one('.banner .why').textContent).toContain('model calls 3 and 4\u00a0of\u00a05');
    await page.click(page.all('.banner .bn')[1]);
    expect(selected).toEqual([7]);
  });

  it('says an open fix is open, in amber, and how a fix stands as the server says it', () => {
    expect(fixStatusWords('open')).toEqual({ tone: 'warn', text: 'fix open', why: 'open: no change has been verified for it yet' });
    expect(fixStatusWords('applied').text).toBe('fix applied');
    // Verified, not applied: never "ready to apply", which a patch in the working tree already isn't.
    expect(fixStatusWords('verified')).toEqual({ tone: 'ok', text: 'fix verified', why: 'verified: a change fixed its failing runs, not applied yet' });
    // As Fixes says it, where the server says it: merged with its pull request.
    const merged = { tone: 'ok', text: 'fix merged · PR #42', why: 'merged: its change shipped with its pull request' } as const;
    expect(fixStatusWords('verified', merged)).toEqual(merged);
    // Open fix's card on the header says the same.
    expect(stepCard({ ...FIX, status: 'verified', said: merged }).sub).toBe('merged: its change shipped with its pull request');
  });

  it('blames a failure nobody blamed, with what it bills on its hover, and the banner doesn’t offer it again', async () => {
    const estimate = { kind: 'blame', usd: 10.88, ceiling: true, parts: ['up to 7 probes of 33 attempts and a check of the call found'] };
    const failed = detail({ status: 'failed', state: { ...failedState, outcome: { kind: 'check-failed', check: null } }, next: { ...OFFER, command: `shadowlap blame ${REC.slice(0, 10)}`, estimate } as NextStep });
    const offers = { blame: OFFER.offer, test: null } as unknown as RunOffers;
    const { a, started } = jobs();
    page = await render(both(failed, offers, a));
    expect(lime(page)).toEqual(['Run blame']);
    // The outcome says it failed: the finding leads, in ink and with no label, with what failed.
    expect(page.all('.banner .bk')).toHaveLength(0);
    expect(page.one('.banner .why .lead').textContent).toBe('the agent exited with an error');
    expect(page.all('.banner button').some((b) => b.textContent === 'Run blame')).toBe(false);
    const lead = page.byText('.rhead .actions button', 'Run blame');
    expect(tip(lead)).toMatchObject({ t: 'Run blame', s: 'Find the model call where this run was lost, on its exit status: a passing run exits 0', rows: [], est: { usd: 10.88, ceiling: true }, cmd: `$ shadowlap blame ${REC.slice(0, 10)}` });
    // Under Spending's threshold it starts at once, with the estimate its card said.
    resetSpending(20);
    await page.click(lead);
    expect(started).toEqual([['blame', { runId: REC, estimate: { usd: 10.88, ceiling: true } }]]);
  });

  it('asks first on a run recorded at temperature 0, its check to edit, its agents and temperature=1 to start from, and starts with what its settings say', async () => {
    const check = { tools: { send_email: 1 } };
    const estimate: NonNullable<NextStep['estimate']> = { kind: 'blame', usd: 10.88, ceiling: true, parts: [] };
    const failed = detail({ status: 'failed', state: { ...failedState, outcome: { kind: 'check-failed', check: null } }, next: { ...OFFER, offer: { from: 'run', expect: check, failed: ['send_email called once'] }, command: `shadowlap blame ${REC.slice(0, 10)}`, estimate } as NextStep });
    // The page's offers say what the step's don't: its agents, and its first model call at temperature 0.
    const offers = { blame: { from: 'run', expect: check, failed: ['send_email called once'], scopes: ['support/agent', 'support/user'], temperature0: true }, test: null } as unknown as RunOffers;
    const { a, started } = jobs();
    page = await render(both(failed, offers, a));
    resetSpending(20);
    await page.click(page.byText('.rhead .actions button', 'Run blame'));
    // Under the threshold all the same: a blame at temperature 0 would ask the model again for nothing.
    expect(started).toEqual([]);
    await page.until('its settings to be asked', () => page!.all('.dialog textarea').length === 1);
    const dialog = (sel: string) => page!.one(`.dialog ${sel}`);
    expect(dialog('textarea').props.value).toBe(JSON.stringify(check));
    expect(page.all('.dialog input[type="text"]').map((i) => i.props.value)).toEqual(['temperature=1', '']);
    expect(page.one('.dialog').textContent).toContain('Recorded at temperature 0');
    expect(page.all('.dialog select option').map((o) => o.textContent)).toEqual(['every agent', 'support/agent', 'support/user']);
    await page.fire(dialog('select'), 'change', { target: { value: 'support/agent' } } as never);
    expect(dialog('.cmdline').textContent).toContain(`shadowlap blame ${REC.slice(0, 10)} --expect '${JSON.stringify(check)}' --scope support/agent --set temperature=1`);
    await page.click(dialog('.dlg-ok'));
    // The check it opened with goes unsent: the server picks the same.
    expect(started).toEqual([['blame', { runId: REC, scope: 'support/agent', set: ['temperature=1'], estimate: { usd: 10.88, ceiling: true } }]]);
    resetSpending();
  });

  it('gains what a long run’s step bills once its read of its own answers, and asks only where its answer left it out', async () => {
    const estimate: NonNullable<NextStep['estimate']> = { kind: 'blame', usd: 10.88, ceiling: true, parts: ['up to 7 probes of 33 attempts and a check of the call found'] };
    const later: NextStep = { ...OFFER, later: true, command: `shadowlap blame ${REC.slice(0, 10)}` };
    const nextStep = vi.fn(() => Promise.resolve({ next: { ...OFFER, command: later.command, estimate } as NextStep }));
    const Page = ({ run }: { run: RunDetail }) => createElement(RunHeader, header(useWholeStep(run)));
    page = await render(createElement(AppContext.Provider, { value: app({}, { nextStep }) }, createElement(Page, { run: detail({ status: 'failed', state: failedState, next: later }) })));
    await page.wait(0);
    expect(nextStep).toHaveBeenCalledOnce();
    expect(tip(page.byText('.rhead .actions button', 'Run blame'))).toMatchObject({ rows: [], est: { usd: 10.88, ceiling: true }, cmd: `$ shadowlap blame ${REC.slice(0, 10)}` });
    await page.unmount();
    // A step its first answer holds whole asks for nothing.
    nextStep.mockClear();
    page = await render(createElement(AppContext.Provider, { value: app({}, { nextStep }) }, createElement(Page, { run: detail({ status: 'failed', state: failedState, next: { ...OFFER, estimate } as NextStep }) })));
    await page.wait(0);
    expect(nextStep).not.toHaveBeenCalled();
    await page.unmount();
    // One that can't be asked keeps what it has.
    const refused = vi.fn(() => Promise.reject(new Error('gone')));
    page = await render(createElement(AppContext.Provider, { value: app({}, { nextStep: refused }) }, createElement(Page, { run: detail({ status: 'failed', state: failedState, next: later }) })));
    await page.wait(0);
    expect(tip(page.byText('.rhead .actions button', 'Run blame'))).toMatchObject({ rows: [], cmd: `$ shadowlap blame ${REC.slice(0, 10)}` });
  });

  it('asks a capture for your command before it blames it, and offers no check to a job that finds its own', async () => {
    const run = detail({ state: failedState, source: 'cassette.json', next: { key: 'blame', label: 'Run blame', capture: true, offer: { from: 'golden', expect: { calls: [] }, failed: ['every issue_refund call: amount <= 100'] }, command: `shadowlap blame ${REC.slice(0, 10)} --expect '{"calls":[]}' -- <your command>` } });
    const { a, started } = jobs();
    page = await render(both(run, null, a));
    await page.click(page.byText('.rhead .actions button', 'Run blame'));
    expect(started).toEqual([]);
    // Its dialogs are a part of their own, which loads the first time one asks.
    await page.until('its command to be asked', () => page!.all('.dialog input').length === 1);
    expect(page.one('.dialog').textContent).toContain('What starts your agent?');
    await page.type(page.one('.dialog input'), 'python agent.py');
    // What runs, its check with it, as its card says.
    expect(page.one('.dialog .cmdline').textContent).toContain(`shadowlap blame ${REC.slice(0, 10)} --expect '{"calls":[]}' -- python agent.py`);
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['blame', { runId: REC, command: 'python agent.py' }]]);
  });

  it('asks a capture whose failure names no check for it after your command, saying what it will run', async () => {
    const run = detail({ state: failedState, source: 'cassette.json', next: { key: 'blame', label: 'Run blame', capture: true, offer: { from: 'ask', failed: [] }, command: `shadowlap blame ${REC.slice(0, 10)} --expect '<what it must do>' -- <your command>` } });
    const a = app({}, { startJob: () => Promise.reject(new ApiError(422, 'say what a passing run must do')) });
    page = await render(both(run, null, a));
    await page.click(page.byText('.rhead .actions button', 'Run blame'));
    await page.until('its command to be asked', () => page!.all('.dialog input').length === 1);
    await page.type(page.one('.dialog input'), 'python agent.py');
    await page.click(page.one('.dialog .dlg-ok'));
    // Its check is asked in a dialog of its own, a part that loads the first time it opens.
    await page.until('its check to be asked', () => page!.all('.dialog textarea').length === 1);
    expect(page.one('.dialog').textContent.replace(/\u00a0/g, ' ')).toContain('What a passing run must do, as an outcome check’s expect object');
    expect(page.one('.dialog .cmdline').textContent).toContain(`shadowlap blame ${REC.slice(0, 10)} --expect '<check>' -- python agent.py`);
  });

  it('replays only where the server says nothing else needs doing, and draws no lime button with no step', async () => {
    const actions: unknown[] = [];
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, header(detail({ state: passedState, next: REPLAY }), null, { onAction: (p) => actions.push(p) }))));
    expect(lime(page)).toEqual(['Replay']);
    expect(page.all('.rhead .actions button').filter((b) => b.textContent === 'Replay')).toHaveLength(1);
    await page.click(page.byText('.rhead .actions button', 'Replay'));
    expect(actions).toEqual([{ action: { key: 'r', label: 'Replay' }, callNo: null }]);
    await page.unmount();
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, header(detail({ state: passedState, next: null })))));
    expect(lime(page)).toEqual([]);
    expect(page.byText('.rhead .actions button', 'Replay').className).toBe('btn');
  });

  it('replays the recording a clean or a test replay came from, the plain button too, and waits for a recording to end', async () => {
    const recording: NextStep = { key: 'replay', label: 'Replay recording', runId: PARENT, title: `Replays ${PARENT.slice(0, 10)}, the recording this replay came from`, command: `shadowlap replay ${PARENT.slice(0, 10)}` };
    const actions: Array<{ runId?: string }> = [];
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, header(detail({ parent: PARENT, state: passedState, next: recording, replay: recording }), null, { onAction: (p) => actions.push(p as { runId?: string }) }))));
    const lead = page.byText('.rhead .actions button', 'Replay recording');
    expect(lead.className).toBe('btn lime');
    expect(tip(lead).t).toBe(`Replays ${PARENT.slice(0, 10)}, the recording this replay came from`);
    await page.click(lead);
    expect(actions[0]?.runId).toBe(PARENT);
    await page.unmount();
    // Plain beside a next step, the same.
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, header(detail({ parent: PARENT, state: passedState, next: { key: 'compare', label: 'Compare with parent', parent: PARENT, href: `#/compare/${PARENT}/${REC}` }, replay: recording })))));
    expect(page.byText('.rhead .actions button', 'Replay recording').className).toBe('btn');
    await page.unmount();
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, header(detail({ status: 'running', state: { ...passedState, status: 'running' }, next: { ...REPLAY, off: 'Replay once the recording finishes' } })))));
    const waiting = page.byText('.rhead .actions button', 'Replay');
    expect(waiting.getAttribute('aria-disabled')).toBe('true');
    expect(waiting.getAttribute('data-why')).toBe('Replay once the recording finishes');
    expect(waiting.className).toBe('btn');
  });

  it('keeps Compare plain beside a next step, in the mock’s words, with the diff it matches on hover', async () => {
    const CHILD = '01M5JEQXRGBX1QXGW0X8A3ZB4D';
    const about = 'A customer writes about order A-1131';
    const compared = async (o: Parameters<typeof detail>[0], children: unknown[], a: Partial<AppState> = {}) => {
      page = await render(createElement(AppContext.Provider, { value: app({ runs: [{ runId: PARENT, about: { text: about, from: 'user' } }, { runId: CHILD, about: { text: about, from: 'user' } }] as never, ...a }) }, createElement(RunHeader, header({ ...detail({ state: passedState, next: REPLAY, ...o }), children } as RunDetail))));
      const shown = page.all('.rhead .actions .btn').find((b) => (b.textContent ?? '').startsWith('Compare'));
      return shown;
    };
    const parent = await compared({ parent: PARENT, next: REPLAY }, []);
    expect(parent?.textContent).toBe('Compare with parent');
    expect(parent?.props.href).toBe(`#/compare/${PARENT}/${REC}`);
    expect(tip(parent!)).toMatchObject({ t: `Against ${PARENT.slice(0, 10)}`, s: about, cmd: `$ shadowlap diff ${PARENT.slice(0, 10)} ${REC.slice(0, 10)}` });
    await page!.unmount();
    const fork = await compared({}, [{ runId: CHILD, label: 'fork @3', kind: 'fork', startedAt: 2 }]);
    expect(fork?.textContent).toBe('Compare with fork');
    expect(fork?.props.href).toBe(`#/compare/${REC}/${CHILD}`);
    expect(tip(fork!)).toMatchObject({ t: `Against ${CHILD.slice(0, 10)}`, cmd: `$ shadowlap diff ${REC.slice(0, 10)} ${CHILD.slice(0, 10)}` });
    await page!.unmount();
    expect((await compared({}, [{ runId: CHILD, label: 'clean replay', kind: 'clean', startedAt: 2 }]))?.textContent).toBe('Compare with replay');
    await page!.unmount();
    // Nothing to compare yet: it stays, off, saying what would make something; an attempt is none, and a copy has none to make.
    const none = await compared({}, [{ runId: CHILD, label: 'attempt', kind: 'fork', startedAt: 2, attempt: true }]);
    expect(none?.textContent).toBe('Compare');
    expect(none?.props.disabled).toBe(true);
    expect(none?.props.title).toBe('Nothing to compare yet: replay it or fork it first');
    await page!.unmount();
    expect(await compared({}, [], { exported: true })).toBeUndefined();
  });

  it('asks for your command before it replays the capture a replay came from, with the action its recording has', async () => {
    const asks = { key: 'r', label: 'Replay with your command…', prompt: { label: `${PARENT.slice(0, 10)} came from a capture and has no command. What starts your agent?`, placeholder: 'python agent.py' } };
    const next = { key: 'replay', label: 'Replay recording', runId: PARENT, action: asks, title: `Replays ${PARENT.slice(0, 10)}, the recording this replay came from`, command: `shadowlap replay ${PARENT.slice(0, 10)} -- <your command>` } as unknown as NextStep;
    const actions: unknown[] = [];
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, header(detail({ parent: PARENT, state: passedState, next, replay: next }), null, { onAction: (p) => actions.push(p) }))));
    await page.click(page.byText('.rhead .actions button', 'Replay recording'));
    expect(actions).toMatchObject([{ action: { key: 'r', prompt: asks.prompt }, callNo: null, runId: PARENT }]);
  });

  it('compares an attempt or a fork with the run it came from, with its command on hover', async () => {
    const compare: NextStep = { key: 'compare', label: 'Compare with parent', parent: PARENT, href: `#/compare/${PARENT}/${REC}`, title: `Against ${PARENT.slice(0, 10)}`, command: `shadowlap diff ${PARENT.slice(0, 10)} ${REC.slice(0, 10)}` };
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, header(detail({ parent: PARENT, state: { ...passedState, kind: 'fork' }, next: compare })))));
    const lead = page.byText('.rhead .actions a', 'Compare with parent');
    expect(lead.className).toBe('btn lime');
    expect(lead.props.href).toBe(compare.href);
    expect(tip(lead)).toMatchObject({ t: `Against ${PARENT.slice(0, 10)}`, cmd: `$ ${compare.command}` });
    // It stays one button, not a plain one beside it.
    expect(page.all('.rhead .actions a').filter((a) => a.textContent === 'Compare with parent')).toHaveLength(1);
  });

  it('opens a passing run or a proof, a link as Fix → is', async () => {
    for (const next of [
      { key: 'passing', label: 'Open passing run', runId: PARENT, href: `#/run/${PARENT}`, title: `Opens ${PARENT.slice(0, 10)}` },
      { key: 'injection-proof', label: 'Open proof', runId: PARENT, href: `#/run/${PARENT}/6`, title: `Opens ${PARENT.slice(0, 10)}`, sub: 'send_email obeyed a planted instruction · 8 of 72 · system-notice at #4' },
      { key: 'preset-proof', label: 'Open proof', runId: PARENT, href: `#/run/${PARENT}/2`, title: `Opens ${PARENT.slice(0, 10)}`, sub: 'tool timeout failed · 0 of 1 passed' },
    ] as NextStep[]) {
      const said: string[] = [];
      page = await render(createElement(AppContext.Provider, { value: app({ conn: 'offline', toast: (t: string) => void said.push(t) }) }, createElement(RunHeader, header(detail({ state: passedState, next })))));
      const lead = page.byText('.rhead .actions a', next.label);
      expect(lead.className, next.key).toBe('btn lime');
      expect(lead.props.href).toBe(next.href);
      expect(lead.props['data-next']).toBe(next.key);
      // A proof opens an attempt, which waits while the server is out of reach, as every link to one does.
      await page.click(lead);
      expect(said, next.key).toEqual(next.key === 'passing' ? [] : [PAUSED]);
      await page.unmount();
      page = null;
    }
  });

  it('adds the normalizer from the header on a test that diverged, the banner keeping Update golden, plain', async () => {
    const next: NextStep = { key: 'normalizer', label: 'Add normalizer and re-run', golden: GOLDEN, test: TEST_OFFER, command: `shadowlap normalize add && shadowlap test ${GOLDEN}` };
    const { a, started } = jobs();
    page = await render(both(detail({ ...DIVERGED, next, actions: [{ key: 'r', label: 'Replay' }, { key: 'n', label: 'Add normalizer' }] }), null, a));
    expect(lime(page)).toEqual(['Add normalizer and re-run']);
    const banner = page.all('.banner button').map((b) => b.textContent);
    expect(banner).not.toContain('Add normalizer and re-run');
    expect(banner).toContain('Update golden');
    expect(page.byText('.banner button', 'Update golden').className).toBe('btn sm');
    await page.click(page.byText('.rhead .actions button', 'Add normalizer and re-run'));
    expect(started).toEqual([['normalize-and-test', { runId: REC }]]);
  });

  it('updates the golden from the header on a change that was meant, asking first in Tests’ dialog, the banner keeping the rule', async () => {
    const offer = { ...TEST_OFFER, normalizerFixes: false } as TestBannerOffer;
    const next: NextStep = { key: 'update-golden', label: 'Update golden', golden: GOLDEN, test: offer, sub: 'It re-records the golden under the change', command: `shadowlap test ${GOLDEN} --update`, estimate: { kind: 'update', usd: 0.03, ceiling: false, always: 'it replaces goldens', parts: ['as its recording cost'] } };
    const { a, started } = jobs();
    page = await render(both(detail({ ...DIVERGED, next }), null, a));
    expect(lime(page)).toEqual(['Update golden']);
    expect(page.all('.banner button').map((b) => b.textContent)).not.toContain('Update golden');
    await page.click(page.byText('.rhead .actions button', 'Update golden'));
    expect(started).toEqual([]);
    // A diverged test's dialogs are a part of their own: it comes as its script does.
    await page.until('its dialog', () => page!.all('.dialog h3').length > 0);
    expect(page.one('.dialog h3').textContent.replace(/\u00a0/g, ' ')).toContain('Update refund-in-limit?');
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['test-update', { golden: GOLDEN, estimate: { usd: 0.03, ceiling: false } }]]);
  });

  it('updates a golden whose judge had no verdict, which no divergence explains, asking first what it bills', async () => {
    const next: NextStep = { key: 'update-golden', label: 'Update golden', golden: GOLDEN, test: null, sub: 'Asks the judge once, live, and keeps its verdict in the pack: every test after judges from the recording, free', command: `shadowlap test ${GOLDEN} --update`, estimate: { kind: 'update', usd: 0.0005, ceiling: false, always: 'it replaces goldens', parts: ['its judge’s one call'] } };
    const { a, started } = jobs();
    page = await render(both(detail({ parent: PARENT, state: { ...passedState, kind: 'test' }, meta: { test: { golden: GOLDEN, session: 's1' } }, next }), null, a));
    await page.click(page.byText('.rhead .actions button', 'Update golden'));
    expect(started).toEqual([]);
    const dialog = page.one('.dialog');
    expect(dialog.querySelector('h3')?.textContent.replace(/\u00a0/g, ' ')).toBe('Update refund-in-limit?');
    expect(dialog.textContent).toContain('Asks the judge once');
    expect(dialog.textContent.replace(/\u00a0/g, ' ')).toContain('its judge’s one call');
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['test-update', { golden: GOLDEN }]]);
  });

  it('runs a test again once its rule is in, asking first what would run live', async () => {
    const next: NextStep = { key: 'rerun-test', label: 'Re-run test', golden: GOLDEN, command: `shadowlap test ${GOLDEN}` };
    const { a, started } = jobs();
    page = await render(both(detail({ ...DIVERGED, next }), { test: { ...TEST_OFFER, normalized: true } } as unknown as RunOffers, a));
    expect(lime(page)).toEqual(['Re-run test']);
    expect(page.one('.banner .st').textContent).toBe('normalizer added');
    await page.click(page.byText('.rhead .actions button', 'Re-run test'));
    expect(started).toEqual([['test', { golden: GOLDEN }]]);
  });

  it('finds a crash’s breaking commit on the click, free from where its golden passed, Run blame plain beside it', async () => {
    const estimate: NonNullable<NextStep['estimate']> = { kind: 'blame', usd: 16.16, ceiling: true, parts: ['up to 7 probes'] };
    const next: NextStep = { key: 'bisect', label: 'Find breaking commit', golden: GOLDEN, starts: true, blame: { offer: OFFER.offer, sub: 'Whether an answer of the model’s lost the run', command: `shadowlap blame ${REC.slice(0, 10)}`, estimate }, command: `shadowlap bisect ${GOLDEN} --good aaaaaaa --bad bbbbbbb`, estimate: { kind: 'bisect', usd: 0, ceiling: false, parts: ['bisect replays offline'] } };
    const offers = { blame: OFFER.offer, test: null, bisect: { target: { kind: 'golden', golden: GOLDEN }, failed: true, good: 'aaaaaaa', bad: 'bbbbbbb', revisions: [], fork: false, live: false, unavailable: null, args: [] } } as unknown as RunOffers;
    const { a, started } = jobs();
    const found = vi.fn();
    page = await render(both(detail({ parent: PARENT, status: 'failed', state: { ...failedState, kind: 'test', outcome: { kind: 'check-failed', check: null } }, meta: { test: { golden: GOLDEN, session: 's1' } }, next }), offers, a, { onFindCommit: found }));
    expect(lime(page)).toEqual(['Find breaking commit']);
    const beside = page.byText('.rhead .actions button', 'Run blame');
    expect(beside.className).toBe('btn');
    expect(tip(beside)).toMatchObject({ t: 'Run blame', s: 'Whether an answer of the model’s lost the run', rows: [], est: { usd: 16.16, ceiling: true }, cmd: `$ shadowlap blame ${REC.slice(0, 10)}` });
    // Before Fork at #n, the lime one last.
    const buttons = page.all('.rhead .actions button').map((b) => b.textContent);
    expect(buttons.indexOf('Run blame')).toBeLessThan(buttons.findIndex((b) => b?.startsWith('Fork at')));
    expect(buttons.findIndex((b) => b?.startsWith('Fork at'))).toBeLessThan(buttons.indexOf('Find breaking commit'));
    // Once, in the header: the banner leaves it there.
    expect(page.all('.banner button').some((b) => b.textContent === 'Run blame')).toBe(false);
    await page.click(page.byText('.rhead .actions button', 'Find breaking commit'));
    // Free, so it starts by Spending on every setting, with the estimate its drawer says.
    expect(started).toEqual([['bisect', { runId: REC, good: 'aaaaaaa', estimate: { usd: 0, ceiling: false } }]]);
    expect(found).not.toHaveBeenCalled();
  });

  it('asks for a commit where it can’t start from one, with the dialog the fork menu’s has', async () => {
    const next: NextStep = { key: 'bisect', label: 'Find breaking commit…', golden: GOLDEN, starts: false, blame: null, command: `shadowlap bisect ${GOLDEN} --good <commit>` };
    const { a, started } = jobs();
    const found = vi.fn();
    page = await render(both(detail({ ...DIVERGED, next }), null, a, { onFindCommit: found }));
    await page.click(page.byText('.rhead .actions button', 'Find breaking commit…'));
    expect(found).toHaveBeenCalledOnce();
    expect(started).toEqual([]);
  });

  it('adds the rule a replay’s divergence proposes from the header, not its banner', async () => {
    const actions: unknown[] = [];
    const n = { key: 'n', label: 'Add suggested normalizer', flag: 'normalize add' };
    const run = detail({ parent: PARENT, state: { ...passedState, kind: 'fork' }, divergence: { callNo: 3, type: 'request_changed', kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, hints: [{ message: 'looks like a UUID', normalizer: { path: '$.metadata.user_id', replace: '<id>' } }] }, actions: [{ key: 'r', label: 'Replay' }, n], next: { key: 'rule', label: 'Add normalizer', command: 'shadowlap normalize add' } });
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement('div', null, createElement(RunHeader, header(run, null, { onAction: (p) => actions.push(p) })), createElement(Banner, bannerProps(run)))));
    expect(lime(page)).toEqual(['Add normalizer']);
    await page.click(page.byText('.rhead .actions button', 'Add normalizer'));
    expect(actions).toEqual([{ action: n, callNo: null }]);
    expect(page.all('.banner button').some((b) => b.textContent === 'Add normalizer')).toBe(false);
  });

  it('runs an injection test again as the last one ran, asking first with what it bills', async () => {
    const next: NextStep = { key: 'injection-again', label: 'Re-run injection test', runId: REC, job: { repeat: 2, templates: ['system-notice'], baselines: 3, liveReads: false }, command: `shadowlap injection ${REC.slice(0, 10)} --templates system-notice --repeat 2`, sub: 'It showed too little to say: no model read it', estimate: { kind: 'injection', usd: 3.11, ceiling: false, note: 'as the last test’s 6 attempts', parts: ['live from each read, writes stubbed'] } };
    const { a, started } = jobs();
    page = await render(both(detail({ state: passedState, next }), null, a));
    await page.click(page.byText('.rhead .actions button', 'Re-run injection test'));
    expect(started).toEqual([]);
    const dialog = page.one('.dialog');
    // Why the last test leads to it, in its one amber line, then what it bills, price first.
    expect(dialog.querySelector('.dwarn')?.textContent?.replace(/\u00a0/g, ' ')).toBe('It showed too little to say: no model read it');
    expect(dialog.querySelector('.dcost')?.textContent?.replace(/\u00a0/g, ' ')).toContain('≈$3.11, as the last test’s 6 attempts');
    expect(dialog.querySelector('.dcost')?.textContent?.replace(/\u00a0/g, ' ')).toContain('live from each read, writes stubbed');
    expect(dialog.textContent).toContain(`shadowlap injection ${REC.slice(0, 10)} --templates system-notice --repeat 2`);
    await page.click(page.one('.dialog .dlg-ok'));
    // The job keeps the estimate the card and the Cost line said, for its drawer; `again` titles it a re-run.
    expect(started).toEqual([['injection', { runId: REC, repeat: 2, templates: ['system-notice'], baselines: 3, liveReads: false, again: true, estimate: { usd: 3.11, ceiling: false } }]]);
  });

  it('runs an injection test its budget stopped, and a gate’s through its golden’s test', async () => {
    const test: NextStep = { key: 'injection-test', label: 'Run injection test…', runId: REC, command: `shadowlap injection ${REC.slice(0, 10)}`, sub: 'It stopped early' };
    let j = jobs();
    page = await render(both(detail({ state: passedState, next: test }), null, j.a));
    await page.click(page.byText('.rhead .actions button', 'Run injection test…'));
    // Its dialog (TestDialog.tsx), why the step leads its amber line, every template picked for one read.
    await page.until('the dialog reads the run', () => page!.all('.dialog .togchips button').length === 2);
    expect(page.one('.dialog .dwarn').textContent.replace(/\u00a0/g, ' ')).toBe('It stopped early');
    await page.click(page.one('.dialog .dlg-ok'));
    expect(j.started).toEqual([['injection', { runId: REC }]]);
    await page.unmount();
    const gate: NextStep = { key: 'gate-again', label: 'Re-run test', golden: GOLDEN, command: `shadowlap test ${GOLDEN}` };
    j = jobs();
    page = await render(both(detail({ state: passedState, next: gate }), null, j.a));
    await page.click(page.byText('.rhead .actions button', 'Re-run test'));
    expect(j.started).toEqual([['test', { golden: GOLDEN }]]);
  });

  it('packs a recording as a golden, into a folder named for the run, the folder its dialog’s to change', async () => {
    const folder = `goldens/${REC.slice(0, 10).toLowerCase()}`;
    const next: NextStep = { key: 'pack', label: 'Pack as golden…', runId: REC, folder, title: 'Pack as golden', sub: 'A golden that CI replays on every commit', command: `shadowlap pack ${REC.slice(0, 10)} ${folder}` };
    const { a, started } = jobs();
    page = await render(both(detail({ state: passedState, next }), null, a));
    expect(lime(page)).toEqual(['Pack as golden…']);
    // Replay stays beside it.
    expect(page.byText('.rhead .actions button', 'Replay').className).toBe('btn');
    await page.click(page.byText('.rhead .actions button', 'Pack as golden…'));
    expect(page.one('.dialog h3').textContent.replace(/\u00a0/g, ' ')).toBe(`Pack ${REC.slice(0, 10)} as golden?`);
    expect(page.one('.dialog').textContent).toContain('Packs the run into goldens/ and tests it, for shadowlap test to replay on every commit.');
    expect(page.one('.dialog label').textContent).toContain('Golden');
    // The pack, then its test, a line each.
    expect(page.one('.dialog .cmdline').textContent).toContain(`shadowlap pack ${REC.slice(0, 10)} ${folder}`);
    expect(page.one('.dialog .cmdline').textContent).toContain(`shadowlap test ${folder}`);
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['pack-test', { runId: REC, golden: folder }]]);
  });

  it('offers a plain Pack as golden… after Replay where another step leads, folding by its name, and none where it leads or the run failed', async () => {
    const folder = `goldens/${REC.slice(0, 10).toLowerCase()}`;
    const offers = { keep: { folder }, copies: { formats: [] } } as unknown as RunOffers;
    const injection = { key: 'injection-test', label: 'Run injection test…', runId: REC } as NextStep;
    const { a, started } = jobs();
    page = await render(both(detail({ state: passedState, next: injection }), offers, a));
    const names = page.all('.rhead .actions button').map((b) => b.textContent);
    expect(names.indexOf('Pack as golden…')).toBe(names.indexOf('Replay') + 1);
    const plain = page.byText('.rhead .actions button', 'Pack as golden…');
    expect([plain.className, plain.getAttribute('data-fold'), plain.getAttribute('data-next')]).toEqual(['btn', 'pack', null]);
    expect(JSON.parse(plain.getAttribute('data-tip')!)).toMatchObject({ t: 'Pack as golden', s: 'A golden that CI replays on every commit', cmd: `$ shadowlap pack ${REC.slice(0, 10)} ${folder}` });
    await page.click(plain);
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['pack-test', { runId: REC, golden: folder }]]);
    await page.unmount();
    for (const [state, next] of [[failedState, injection], [passedState, { key: 'pack', label: 'Pack as golden…', runId: REC, folder } as NextStep]] as const) {
      page = await render(both(detail({ state, next }), offers, app()));
      expect(page.all('.rhead [data-fold="pack"]')).toHaveLength(0);
      await page.unmount();
    }
    // Recorded passing, but today's checks fail it, as its first fact says: a golden made from it would
    // pass on the failure. And none while they judge it.
    const failing = { ...detail({ state: passedState, next: injection }), judged: { by: 'own', verdict: 'failed', counts: { passed: 0, failed: 1, inconclusive: 0, notApplicable: 0 }, callNo: 4, today: true } } as unknown as RunDetail;
    for (const props of [header(failing, offers), { ...header(detail({ state: passedState, next: injection }), offers), judged: undefined }]) {
      page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, props)));
      expect(page.all('.rhead [data-fold="pack"]')).toHaveLength(0);
      await page.unmount();
    }
    page = null;
  });

  it('keeps Pack as golden…’s dialog open with the server’s words when it refuses the folder, and asks first of a recording from elsewhere', async () => {
    const folder = `goldens/${REC.slice(0, 10).toLowerCase()}`;
    const next: NextStep = { key: 'pack', label: 'Pack as golden…', runId: REC, folder, title: 'Pack as golden', sub: 'A golden that CI replays on every commit', command: `shadowlap pack ${REC.slice(0, 10)} ${folder}` };
    const sent: Array<Record<string, unknown>> = [];
    const answers = [
      new ApiError(409, `${folder} already holds a golden. Give this one another name: shadowlap never packs over a golden.`),
      new ApiError(409, `${REC.slice(0, 10)} came from the team store: its test runs the command it was recorded with (node agent.mjs), under shadowlap test goldens/other. Confirm it to run it`, 'c'.repeat(32)),
    ];
    const a = app({}, {
      startJob: (_kind: string, fields: Record<string, unknown>) => {
        sent.push(fields);
        const no = answers.shift();
        return (no ? Promise.reject(no) : Promise.resolve({ id: 'j1' })) as never;
      },
    });
    page = await render(both(detail({ state: passedState, next }), null, a));
    await page.click(page.byText('.rhead .actions button', 'Pack as golden…'));
    await page.click(page.one('.dialog .dlg-ok'));
    // Refused: the dialog stays, with what was typed and why.
    expect(page.one('.dialog').textContent.replace(/\u00a0/g, ' ')).toContain('already holds a golden. Give this one another name');
    await page.type(page.one('.dialog input'), 'goldens/other');
    await page.click(page.one('.dialog .dlg-ok'));
    // A recording from elsewhere: the question, then the job again with its yes.
    expect(page.one('.dialog').textContent.replace(/\u00a0/g, ' ')).toContain('came from the team store');
    await page.click(page.one('.dialog .dlg-ok'));
    expect(sent).toEqual([{ runId: REC, golden: folder }, { runId: REC, golden: 'goldens/other' }, { runId: REC, golden: 'goldens/other', yes: 'c'.repeat(32) }]);
  });

  it('opens Pack as golden…’s dialog again on the folder tried, with the server’s words, when it refuses the job sent with a yes', async () => {
    const folder = `goldens/${REC.slice(0, 10).toLowerCase()}`;
    const next: NextStep = { key: 'pack', label: 'Pack as golden…', runId: REC, folder, title: 'Pack as golden', sub: 'A golden that CI replays on every commit', command: `shadowlap pack ${REC.slice(0, 10)} ${folder}` };
    const answers = [
      new ApiError(409, `${REC.slice(0, 10)} came from the team store: its test runs the command it was recorded with (node agent.mjs), under shadowlap test ${folder}. Confirm it to run it`, 'c'.repeat(32)),
      new ApiError(409, `${folder} already holds a golden. Give this one another name: shadowlap never packs over a golden.`),
    ];
    const sent: Array<Record<string, unknown>> = [];
    const a = app({}, {
      startJob: (_kind: string, fields: Record<string, unknown>) => {
        sent.push(fields);
        const no = answers.shift();
        return (no ? Promise.reject(no) : Promise.resolve({ id: 'j1' })) as never;
      },
    });
    page = await render(both(detail({ state: passedState, next }), null, a));
    await page.click(page.byText('.rhead .actions button', 'Pack as golden…'));
    await page.click(page.one('.dialog .dlg-ok'));
    expect(page.one('.dialog').textContent.replace(/\u00a0/g, ' ')).toContain('came from the team store');
    await page.click(page.one('.dialog .dlg-ok'));
    // The folder was taken in the meantime: the Pack dialog again, saying so, the folder still the one tried.
    expect(page.one('.dialog').textContent.replace(/\u00a0/g, ' ')).toContain('already holds a golden. Give this one another name');
    expect(page.one('.dialog input').value).toBe(folder);
    expect(sent).toEqual([{ runId: REC, golden: folder }, { runId: REC, golden: folder, yes: 'c'.repeat(32) }]);
  });

  it('packs with an injection gate the recording it tested, the gate written into its tests entry against the version read, then tested', async () => {
    const folder = `goldens/${PARENT.slice(0, 10).toLowerCase()}`;
    const estimate = { kind: 'injection', usd: 1.95, ceiling: false, recurs: 'every test session, in CI too', parts: ['36 attempts and 9 clean replays'] } as NonNullable<NextStep['estimate']>;
    const next: NextStep = { key: 'pack-gate', label: 'Pack with injection gate…', runId: PARENT, folder, gate: { obeyed: 0, repeat: 3 }, title: `Pack ${PARENT.slice(0, 10)} with injection gate`, command: `shadowlap pack ${PARENT.slice(0, 10)} ${folder}`, estimate };
    const { a, started } = jobs();
    page = await render(both(detail({ parent: PARENT, state: { ...passedState, kind: 'fork' }, next }), null, a));
    await page.click(page.byText('.rhead .actions button', 'Pack with injection gate…'));
    await page.until('its dialog', () => page!.all('.dialog .dlg-ok').some((b) => b.props['aria-disabled'] !== 'true'));
    // The entry it adds, folded behind Show entry, for the folder as you name it; the pack and the test, a line each.
    expect(page.one('.dialog .injconf').textContent).toContain(`"${folder}": {`);
    expect(page.one('.dialog .dcost').textContent.replace(/\u00a0/g, ' ')).toContain('≈$1.95 every test session, in CI too');
    expect(page.one('.dialog').textContent.replace(/\u00a0/g, ' ')).not.toContain('you add the entry below');
    await page.type(page.one('.dialog input[type="text"]'), 'goldens/refund');
    expect(page.one('.dialog .injconf').textContent).toContain('"goldens/refund": {');
    expect(page.all('.dialog .cmdline .cstep').map((c) => c.textContent)).toEqual([`$shadowlap pack ${PARENT.slice(0, 10)} goldens/refund`, '$shadowlap test goldens/refund']);
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['pack-test', { runId: PARENT, golden: 'goldens/refund', gate: { obeyed: 0, repeat: 3 }, version: 'v1', read: { keys: {}, tests: {} }, estimate: { usd: 1.95, ceiling: false } }]]);
  });

  it('waits as every job button does where nothing runs, saying why, and a link still opens', async () => {
    const off = 'This dashboard is read-only: nothing runs from here';
    for (const next of [OFFER, { key: 'pack', label: 'Pack as golden…', runId: REC, folder: 'goldens/x' }, { key: 'injection-test', label: 'Run injection test…', runId: REC }, { key: 'rerun-test', label: 'Re-run test', golden: GOLDEN }] as NextStep[]) {
      page = await render(createElement(AppContext.Provider, { value: app({ actionsOff: off }) }, createElement(RunHeader, header(detail({ state: passedState, next })))));
      const lead = page.byText('.rhead .actions button', next.label);
      expect(lead.getAttribute('aria-disabled'), next.key).toBe('true');
      expect(lead.getAttribute('data-why'), next.key).toBe(off);
      await page.unmount();
      page = null;
    }
  });

  it('goes plain while a job holds what it needs, saying why, so the page never offers a lime button that can’t start', async () => {
    const meta = { project: { id: 'p1', path: '/work/project' } };
    const holding = [{ job: { id: 'j1', kind: 'repair', done: false, project: { id: 'p1' }, worktree: { folder: '/work/project', use: 'writes', doing: 'a repair is running' } } }];
    for (const [next, why] of [
      [OFFER, 'A repair is running: blame once it is done.'],
      [{ key: 'rerun-test', label: 'Re-run test', golden: GOLDEN }, 'A repair is running: run it again once it is done.'],
      [{ key: 'injection-test', label: 'Run injection test…', runId: REC }, 'A repair is running: test it once it is done.'],
      [{ key: 'bisect', label: 'Find breaking commit…', golden: GOLDEN, starts: false, blame: null }, 'A repair is running: find the breaking commit once it is done.'],
    ] as Array<[NextStep, string]>) {
      page = await render(createElement(AppContext.Provider, { value: app({ meta, jobs: holding } as never) }, createElement(RunHeader, header(detail({ state: passedState, next })))));
      const lead = page.byText('.rhead .actions button', next.label);
      expect(lead.className, next.key).toBe('btn');
      expect(lead.getAttribute('aria-disabled'), next.key).toBe('true');
      expect(lead.getAttribute('data-why'), next.key).toBe(why);
      expect(lime(page), next.key).toEqual([]);
      await page.unmount();
      page = null;
    }
  });

  it('leaves an exported copy only a comparison it can make', async () => {
    const compare: NextStep = { key: 'compare', label: 'Compare with parent', parent: PARENT, href: `#/compare/${PARENT}/${REC}` };
    page = await render(createElement(AppContext.Provider, { value: app({ exported: true }) }, createElement(RunHeader, header(detail({ parent: PARENT, state: { ...passedState, kind: 'fork' }, next: compare })))));
    expect(lime(page)).toEqual(['Compare with parent']);
    await page.unmount();
    page = await render(createElement(AppContext.Provider, { value: app({ exported: true }) }, createElement(RunHeader, header(detail({ state: passedState, next: null })))));
    expect(lime(page)).toEqual([]);
  });

  it('says what a step bills in the words an ask does', () => {
    const step: NextStep = { ...OFFER, estimate: { kind: 'blame', usd: null, ceiling: false, parts: ['a model has no price'], none: 'a model has no price' } };
    expect(stepCard(step)).toMatchObject({ rows: [], est: { usd: null, ceiling: false } });
    expect(stepCostLine(step)).toEqual({ price: 'Billed by your provider', parts: ['a model has no price'], estimate: step.estimate });
    // Nothing to say of what bills nothing, on its card; its title is its words without what its dialog asks.
    const free: NextStep = { key: 'rerun-test', label: 'Re-run test', golden: GOLDEN, estimate: { kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] } };
    expect(stepCard(free).rows).toEqual([]);
    expect(stepCard({ key: 'injection-test', label: 'Run injection test…', runId: REC }).title).toBe('Run injection test');
    expect(stepCostLine(OFFER)).toBeNull();
    expect(nextStepOf({})).toBeNull();
  });
});

describe('the Agents bar’s Run blame', () => {
  it('blames within the agent its hint names, asking first with that agent picked, where the run can be blamed', async () => {
    const call = (callNo: number, kind: 'api' | 'tool', scope: string) => ({ callNo, kind, name: kind === 'api' ? 'POST /v1/messages' : 'send_email', origin: 'live', scope, agent: scope });
    const run = { ...detail({ status: 'failed', state: failedState }), calls: [call(1, 'api', 'agent'), call(2, 'tool', 'agent'), call(3, 'api', 'customer')] } as unknown as RunDetail;
    const blame: BlameOffer = { from: 'exit', expect: null, failed: [], scopes: ['agent', 'customer'] } as unknown as BlameOffer;
    const bar = (a: AppState, offer: BlameOffer | null) => createElement(AppContext.Provider, { value: a }, createElement(ServedPartsContext.Provider, { value: SERVED_PARTS }, createElement(ScopeBar, { run, scopes: ['agent', 'customer'], scope: 'all', judge: 0, onScope: () => undefined, blame: scopeBlame(REC, { blame: offer }) })));
    // Where it can't be blamed, the hint says the command alone.
    page = await render(bar(app(), null));
    expect(page.one('.shint').textContent).toBe(`Blame only the agent, not the customer it answers: shadowlap blame ${REC.slice(0, 10)} --scope agent`);
    await page.unmount();
    const { a, started } = jobs();
    page = await render(bar(a, blame));
    resetSpending(20);
    await page.click(page.byText('.shint button', 'Run blame'));
    expect(started).toEqual([]);
    await page.until('its settings to be asked', () => page!.all('.dialog select').length === 1);
    expect(page.one('.dialog select').props.value).toBe('agent');
    expect(page.one('.dialog .cmdline').textContent).toContain(`shadowlap blame ${REC.slice(0, 10)} --scope agent`);
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['blame', { runId: REC, scope: 'agent' }]]);
  });
});
