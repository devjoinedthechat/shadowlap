import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../ui/api.js';
import { fixStatusWords, nextStepOf, stepCard, stepCost } from '../ui/run/next-step.js';
import { Banner } from '../ui/run/parts.js';
import { useWholeStep } from '../ui/run/NextStepButton.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { AppContext, type AppState } from '../ui/state.js';
import { TestsAskHost } from '../ui/fixes/TestsJobButton.js';
import type { NextStep, RunDetail, RunOffers, TestBannerOffer } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

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
});

function app(o: Partial<AppState> = {}, client: Partial<Client> = {}): AppState {
  return {
    client: { jobs: () => Promise.resolve([]), ...client } as unknown as Client,
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
    registerLayer: () => () => undefined,
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

const header = (run: RunDetail, offers: RunOffers | null = null, more: { onAction?: (p: unknown) => void; onFindCommit?: () => void } = {}) => ({ run, call: null, selected: 5, rescued: false, offers, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: more.onAction ?? (() => undefined), onFindCommit: more.onFindCommit ?? (() => undefined) });
const bannerProps = (run: RunDetail, offers: RunOffers | null = null) => ({ run, blame: (run as unknown as { blame: never }).blame ?? null, rescued: null, checks: [], offers, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined });
const lime = (p: Rendered) => p.all('.rhead .actions .lime').map((b) => b.textContent);
const tip = (el: { props: Record<string, unknown> }) => JSON.parse(String(el.props['data-tip'])) as { t: string; s?: string; rows?: string[][] };

/** The header and the banner, as the page draws them, with the question a Tests job waits on. */
const both = (run: RunDetail, offers: RunOffers | null = null, a: AppState = app(), more: Parameters<typeof header>[2] = {}) => createElement(AppContext.Provider, { value: a }, createElement('div', null, createElement(RunHeader, header(run, offers, more)), createElement(Banner, bannerProps(run, offers)), createElement(TestsAskHost)));

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
  const FIX: NextStep = { key: 'fix', label: 'Open fix', fixId: verified.id, status: 'verified', href: verified.href, title: `“${verified.title}”` };
  const lost = { callNo: 5, confidence: 'high', rescuedRunId: null, scope: null, outcome: 'blamed', modelCall: { k: 3, m: 5 }, short: 'asked again, it calls escalate instead' };

  it('opens the fix of a blamed failure, its status on hover and in the banner, where Fix → was', async () => {
    const run = detail({ state: failedState, fix: verified, blame: lost, next: FIX });
    expect(nextStepOf(run)).toEqual(FIX);
    page = await render(both(run));
    expect(lime(page)).toEqual(['Open fix']);
    const open = page.byText('.rhead .actions a', 'Open fix');
    expect(open.props.href).toBe(verified.href);
    expect(tip(open)).toMatchObject({ t: `“${verified.title}”`, s: 'verified: a change fixed its failing runs, ready to apply' });
    expect(page.byText('.rhead .actions button', 'Replay').className).toBe('btn');
    // The banner says how the fix stands instead of linking it again.
    expect(page.one('.banner .bk').textContent).toBe('lost at');
    expect(page.all('.banner a').some((a) => a.textContent === 'Fix →')).toBe(false);
    expect(page.one('.banner .st').className).toBe('st ok');
    expect(page.one('.banner .st').textContent).toBe('fix verified');
  });

  it('says a run lost gradually around two calls so in its banner, each call one to select, never lost at the first', async () => {
    const selected: number[] = [];
    const run = detail({ state: failedState, fix: verified, blame: { ...lost, range: { from: 5, to: 7, gradual: true } }, next: FIX });
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(Banner, { ...bannerProps(run), onSelect: (n: number) => selected.push(n) })));
    expect(page.one('.banner .bk').textContent).toBe('lost gradually around');
    expect(page.all('.banner .bn').map((b) => b.textContent)).toEqual(['#5', '#7']);
    expect(page.one('.banner').textContent).toContain('#5 and #7');
    expect(page.one('.banner .why').textContent).toContain('model calls 3 and 4 of 5');
    await page.click(page.all('.banner .bn')[1]);
    expect(selected).toEqual([7]);
  });

  it('says an open fix is open, in amber', () => {
    expect(fixStatusWords('open')).toEqual({ tone: 'warn', text: 'fix open', why: 'open: no change has been verified for it yet' });
    expect(fixStatusWords('applied').text).toBe('fix applied');
  });

  it('blames a failure nobody blamed, with what it bills on its hover, and the banner doesn’t offer it again', async () => {
    const estimate = { kind: 'blame', usd: 10.88, ceiling: true, parts: ['up to 7 probes of 33 attempts and a check of the call found'] };
    const failed = detail({ status: 'failed', state: { ...failedState, outcome: { kind: 'check-failed', check: null } }, next: { ...OFFER, command: `shadowlap blame ${REC.slice(0, 10)}`, estimate } as NextStep });
    const offers = { blame: OFFER.offer, test: null } as unknown as RunOffers;
    const { a, started } = jobs();
    page = await render(both(failed, offers, a));
    expect(lime(page)).toEqual(['Run blame']);
    expect(page.one('.banner .bk').textContent).toBe('failed');
    expect(page.all('.banner button').some((b) => b.textContent === 'Run blame')).toBe(false);
    const lead = page.byText('.rhead .actions button', 'Run blame');
    expect(tip(lead)).toMatchObject({ t: 'Run blame', s: 'Find the model call where this run was lost, on its exit status: a passing run exits 0', rows: [['Costs', 'At most ≈$10.88', ''], ['$', `shadowlap blame ${REC.slice(0, 10)}`, '']] });
    await page.click(lead);
    expect(started).toEqual([['blame', { runId: REC }]]);
  });

  it('gains what a long run’s step bills once its read of its own answers, and asks only where its answer left it out', async () => {
    const estimate = { kind: 'blame', usd: 10.88, ceiling: true, parts: ['up to 7 probes of 33 attempts and a check of the call found'] };
    const later: NextStep = { ...OFFER, later: true, command: `shadowlap blame ${REC.slice(0, 10)}` };
    const nextStep = vi.fn(() => Promise.resolve({ next: { ...later, later: undefined, estimate } as NextStep }));
    const Page = ({ run }: { run: RunDetail }) => createElement(RunHeader, header(useWholeStep(run)));
    page = await render(createElement(AppContext.Provider, { value: app({}, { nextStep } as never) }, createElement(Page, { run: detail({ status: 'failed', state: failedState, next: later }) })));
    await page.wait(0);
    expect(nextStep).toHaveBeenCalledOnce();
    expect(tip(page.byText('.rhead .actions button', 'Run blame')).rows).toEqual([['Costs', 'At most ≈$10.88', ''], ['$', `shadowlap blame ${REC.slice(0, 10)}`, '']]);
    await page.unmount();
    // A step its first answer holds whole asks for nothing.
    nextStep.mockClear();
    page = await render(createElement(AppContext.Provider, { value: app({}, { nextStep } as never) }, createElement(Page, { run: detail({ status: 'failed', state: failedState, next: { ...OFFER, estimate } as NextStep }) })));
    await page.wait(0);
    expect(nextStep).not.toHaveBeenCalled();
    await page.unmount();
    // One that can't be asked keeps what it has.
    const refused = vi.fn(() => Promise.reject(new Error('gone')));
    page = await render(createElement(AppContext.Provider, { value: app({}, { nextStep: refused } as never) }, createElement(Page, { run: detail({ status: 'failed', state: failedState, next: later }) })));
    await page.wait(0);
    expect(tip(page.byText('.rhead .actions button', 'Run blame')).rows).toEqual([['$', `shadowlap blame ${REC.slice(0, 10)}`, '']]);
  });

  it('asks a capture for your command before it blames it, and offers no check to a job that finds its own', async () => {
    const run = detail({ state: failedState, source: 'cassette.json', next: { key: 'blame', label: 'Run blame', capture: true, offer: { from: 'golden', expect: { calls: [] }, failed: ['every issue_refund call: amount <= 100'] }, command: `shadowlap blame ${REC.slice(0, 10)} --expect '{"calls":[]}' -- <your command>` } });
    const { a, started } = jobs();
    page = await render(both(run, null, a));
    await page.click(page.byText('.rhead .actions button', 'Run blame'));
    expect(started).toEqual([]);
    expect(page.one('.dialog').textContent).toContain('What starts your agent?');
    await page.type(page.one('.dialog input'), 'python agent.py');
    // What runs, its check with it, as its card says.
    expect(page.one('.dialog .cmdline').textContent).toContain(`shadowlap blame ${REC.slice(0, 10)} --expect '{"calls":[]}' -- python agent.py`);
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['blame', { runId: REC, command: 'python agent.py' }]]);
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
    expect(waiting.props.disabled).toBe(true);
    expect(waiting.props.title).toBe('Replay once the recording finishes');
  });

  it('compares an attempt or a fork with the run it came from, with its command on hover', async () => {
    const compare: NextStep = { key: 'compare', label: 'Compare with parent', parent: PARENT, href: `#/compare/${PARENT}/${REC}`, title: `Against ${PARENT.slice(0, 10)}`, command: `shadowlap diff ${PARENT.slice(0, 10)} ${REC.slice(0, 10)}` };
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, header(detail({ parent: PARENT, state: { ...passedState, kind: 'fork' }, next: compare })))));
    const lead = page.byText('.rhead .actions a', 'Compare with parent');
    expect(lead.className).toBe('btn lime');
    expect(lead.props.href).toBe(compare.href);
    expect(tip(lead)).toMatchObject({ t: `Against ${PARENT.slice(0, 10)}`, rows: [['$', compare.command, '']] });
    // It stays one button, not a plain one beside it.
    expect(page.all('.rhead .actions a').filter((a) => a.textContent === 'Compare with parent')).toHaveLength(1);
  });

  it('opens a passing run or a proof, a link as Fix → is', async () => {
    for (const next of [
      { key: 'passing', label: 'Open passing run', runId: PARENT, href: `#/run/${PARENT}`, title: `Opens ${PARENT.slice(0, 10)}` },
      { key: 'injection-proof', label: 'Open proof', runId: PARENT, href: `#/run/${PARENT}/6`, title: `Opens ${PARENT.slice(0, 10)}`, sub: 'send_email obeyed a planted instruction (8 of 72) · system-notice at #4' },
      { key: 'preset-proof', label: 'Open proof', runId: PARENT, href: `#/run/${PARENT}/2`, title: `Opens ${PARENT.slice(0, 10)}`, sub: 'tool timeout failed · 0 of 1 passed' },
    ] as NextStep[]) {
      page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, header(detail({ state: passedState, next })))));
      const lead = page.byText('.rhead .actions a', next.label);
      expect(lead.className, next.key).toBe('btn lime');
      expect(lead.props.href).toBe(next.href);
      expect(lead.props['data-next']).toBe(next.key);
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
    expect(page.one('.dialog h3').textContent).toContain('Update refund-in-limit?');
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['test-update', { golden: GOLDEN }]]);
  });

  it('updates a golden whose judge had no verdict, which no divergence explains, asking first what it bills', async () => {
    const next: NextStep = { key: 'update-golden', label: 'Update golden', golden: GOLDEN, test: null, sub: 'Asks the judge once, live, and keeps its verdict in the pack: every test after judges from the recording, free', command: `shadowlap test ${GOLDEN} --update`, estimate: { kind: 'update', usd: 0.0005, ceiling: false, always: 'it replaces goldens', parts: ['its judge’s one call'] } };
    const { a, started } = jobs();
    page = await render(both(detail({ parent: PARENT, state: { ...passedState, kind: 'test' }, meta: { test: { golden: GOLDEN, session: 's1' } }, next }), null, a));
    await page.click(page.byText('.rhead .actions button', 'Update golden'));
    expect(started).toEqual([]);
    const dialog = page.one('.dialog');
    expect(dialog.querySelector('h3')?.textContent).toBe('Update refund-in-limit?');
    expect(dialog.textContent).toContain('Asks the judge once');
    expect(dialog.textContent).toContain('its judge’s one call');
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
    const next: NextStep = { key: 'bisect', label: 'Find breaking commit', golden: GOLDEN, starts: true, blame: OFFER.offer, command: `shadowlap bisect ${GOLDEN} --good aaaaaaa --bad bbbbbbb` };
    const offers = { blame: OFFER.offer, test: null, bisect: { target: { kind: 'golden', golden: GOLDEN }, failed: true, good: 'aaaaaaa', bad: 'bbbbbbb', revisions: [], fork: false, live: false, unavailable: null, args: [] } } as unknown as RunOffers;
    const { a, started } = jobs();
    const found = vi.fn();
    page = await render(both(detail({ parent: PARENT, status: 'failed', state: { ...failedState, kind: 'test', outcome: { kind: 'check-failed', check: null } }, meta: { test: { golden: GOLDEN, session: 's1' } }, next }), offers, a, { onFindCommit: found }));
    expect(lime(page)).toEqual(['Find breaking commit']);
    expect(page.byText('.rhead .actions button', 'Run blame').className).toBe('btn');
    // Once, in the header: the banner leaves it there.
    expect(page.all('.banner button').some((b) => b.textContent === 'Run blame')).toBe(false);
    await page.click(page.byText('.rhead .actions button', 'Find breaking commit'));
    expect(started).toEqual([['bisect', { runId: REC, good: 'aaaaaaa' }]]);
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
    expect(dialog.textContent).toContain('It showed too little to say: no model read it');
    expect(dialog.textContent).toContain('≈$3.11, as the last test’s 6 attempts · live from each read, writes stubbed');
    expect(dialog.textContent).toContain(`shadowlap injection ${REC.slice(0, 10)} --templates system-notice --repeat 2`);
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['injection', { runId: REC, repeat: 2, templates: ['system-notice'], baselines: 3, liveReads: false }]]);
  });

  it('runs an injection test its budget stopped, and a gate’s through its golden’s test', async () => {
    const test: NextStep = { key: 'injection-test', label: 'Run injection test…', runId: REC, command: `shadowlap injection ${REC.slice(0, 10)}`, sub: 'It stopped early' };
    let j = jobs();
    page = await render(both(detail({ state: passedState, next: test }), null, j.a));
    await page.click(page.byText('.rhead .actions button', 'Run injection test…'));
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
    expect(page.one('.dialog h3').textContent).toBe(`Pack ${REC.slice(0, 10)} as golden?`);
    expect(page.one('.dialog .cmdline').textContent).toContain(`shadowlap pack ${REC.slice(0, 10)} ${folder}`);
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['pack', { runId: REC, dir: folder }]]);
  });

  it('packs with an injection gate the recording it tested, naming the entry that gates it', async () => {
    const folder = `goldens/${PARENT.slice(0, 10).toLowerCase()}`;
    const next: NextStep = { key: 'pack-gate', label: 'Pack with injection gate…', runId: PARENT, folder, title: `Pack ${PARENT.slice(0, 10)} with injection gate`, command: `shadowlap pack ${PARENT.slice(0, 10)} ${folder}`, estimate: { kind: 'injection', usd: 1.95, ceiling: false, recurs: 'every test session, in CI too', parts: ['36 attempts and 9 clean replays'] } };
    const { a, started } = jobs();
    page = await render(both(detail({ parent: PARENT, state: { ...passedState, kind: 'fork' }, next }), null, a));
    await page.click(page.byText('.rhead .actions button', 'Pack with injection gate…'));
    const dialog = page.one('.dialog');
    expect(dialog.textContent).toContain(`"${folder}": { "injection": { "obeyed": 0, "repeat": 3 } }`);
    expect(dialog.textContent).toContain('≈$1.95 every test session, in CI too');
    await page.click(page.one('.dialog .dlg-ok'));
    expect(started).toEqual([['pack', { runId: PARENT, dir: folder }]]);
  });

  it('waits as every job button does where nothing runs, saying why, and a link still opens', async () => {
    const off = 'This dashboard is read-only: nothing runs from here';
    for (const next of [OFFER, { key: 'pack', label: 'Pack as golden…', runId: REC, folder: 'goldens/x' }, { key: 'injection-test', label: 'Run injection test…', runId: REC }, { key: 'rerun-test', label: 'Re-run test', golden: GOLDEN }] as NextStep[]) {
      page = await render(createElement(AppContext.Provider, { value: app({ actionsOff: off }) }, createElement(RunHeader, header(detail({ state: passedState, next })))));
      const lead = page.byText('.rhead .actions button', next.label);
      expect(lead.props.disabled, next.key).toBe(true);
      expect(lead.props.title, next.key).toBe(off);
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
    expect(stepCard(step).rows).toEqual([{ label: 'Costs', value: 'no estimate' }]);
    expect(stepCost(step)).toBe('Billed by your provider · a model has no price');
    // Nothing to say of what bills nothing, on its card; its title is its words without what its dialog asks.
    const free: NextStep = { key: 'rerun-test', label: 'Re-run test', golden: GOLDEN, estimate: { kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] } };
    expect(stepCard(free).rows).toEqual([]);
    expect(stepCard({ key: 'injection-test', label: 'Run injection test…', runId: REC }).title).toBe('Run injection test');
    expect(stepCost(OFFER)).toBeNull();
    expect(nextStepOf({})).toBeNull();
  });
});
