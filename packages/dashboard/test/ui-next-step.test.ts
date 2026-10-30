import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { fixStatusWords, nextStepOf } from '../ui/run/next-step.js';
import { Banner } from '../ui/run/parts.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { RunDetail, RunOffers } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The run page leads with the run's next step, its one lime button: a failure a fix covers opens the
 * fix, saying how it stands; a failure nobody blamed is blamed; a fork or an attempt is compared with
 * its parent; a test that diverged leads from its banner; and only a run where nothing needs doing
 * leads with Replay. The banner never offers the step again.
 */

const REC = '01M5JEQWA2QMJ3NYD1C687WP08';
const PARENT = '01M5JEQXRGBX1QXGW0X8A3ZB4C';

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

function app(o: Partial<AppState> = {}): AppState {
  return {
    client: { jobs: () => Promise.resolve([]) } as unknown as Client,
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

function detail(o: { parent?: string | null; status?: string; state?: unknown; fix?: unknown; meta?: Record<string, unknown>; divergence?: unknown; blame?: unknown; actions?: unknown[]; source?: string | null } = {}): RunDetail {
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
  } as unknown as RunDetail;
}

const header = (run: RunDetail, offers: RunOffers | null = null) => ({ run, call: null, selected: 5, rescued: false, offers, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined });
const bannerProps = (run: RunDetail, offers: RunOffers | null = null) => ({ run, blame: (run as unknown as { blame: never }).blame ?? null, rescued: null, checks: [], offers, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined });
const lime = (p: Rendered) => p.all('.rhead .actions .lime').map((b) => b.textContent);

describe('the run page’s next step', () => {
  const verified = { id: 'fx-01M5JERA0H', status: 'verified', title: 'Refunds above the limit issued without approval', href: '#/fixes/fx-01M5JERA0H/blame' };
  const lost = { callNo: 5, confidence: 'high', rescuedRunId: null, scope: null, outcome: 'blamed', modelCall: { k: 3, m: 5 }, short: 'asked again, it calls escalate instead' };

  it('opens the fix of a blamed failure, its status on hover and in the banner, where Fix → was', async () => {
    const run = detail({ state: failedState, fix: verified, blame: lost });
    expect(nextStepOf(run, { offers: null, exported: false })).toEqual({ key: 'fix', fix: verified });
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement('div', null, createElement(RunHeader, header(run)), createElement(Banner, bannerProps(run)))));
    expect(lime(page)).toEqual(['Open the fix']);
    const open = page.byText('.rhead .actions a', 'Open the fix');
    expect(open.props.href).toBe(verified.href);
    expect(JSON.parse(String(open.props['data-tip']))).toMatchObject({ t: `“${verified.title}”`, s: 'verified: a change fixed its failing runs, ready to apply' });
    expect(page.byText('.rhead .actions button', 'Replay').className).toBe('btn');
    // The banner says how the fix stands instead of linking it again.
    expect(page.one('.banner .bk').textContent).toBe('lost at');
    expect(page.all('.banner a').some((a) => a.textContent === 'Fix →')).toBe(false);
    expect(page.one('.banner .st').className).toBe('st ok');
    expect(page.one('.banner .st').textContent).toBe('fix verified');
  });

  it('says a run lost gradually around two calls so in its banner, each call one to select, never lost at the first', async () => {
    const selected: number[] = [];
    const run = detail({ state: failedState, fix: verified, blame: { ...lost, range: { from: 5, to: 7, gradual: true } } });
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

  it('blames a failure nobody blamed, and replays only a run where nothing needs doing', async () => {
    const offers = { blame: { from: 'exit', expect: null, failed: [] }, test: null } as unknown as RunOffers;
    const failed = detail({ status: 'failed', state: { ...failedState, outcome: { kind: 'check-failed', check: null } } });
    expect(nextStepOf(failed, { offers, exported: false })).toMatchObject({ key: 'blame' });
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement('div', null, createElement(RunHeader, header(failed, offers)), createElement(Banner, bannerProps(failed, offers)))));
    expect(lime(page)).toEqual(['Run blame']);
    expect(page.one('.banner .bk').textContent).toBe('failed');
    expect(page.all('.banner button').some((b) => b.textContent === 'Run blame')).toBe(false);
    await page.unmount();
    const passed = detail({ state: passedState });
    expect(nextStepOf(passed, { offers: { blame: null }, exported: false })).toEqual({ key: 'replay' });
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(RunHeader, header(passed, { blame: null } as RunOffers))));
    expect(lime(page)).toEqual(['Replay']);
    // A failure blame can't take (no command to run again) leads with nothing it can't start: Replay.
    expect(nextStepOf(detail({ status: 'failed', state: failedState, source: 'cassette.json' }), { offers: null, exported: false })).toEqual({ key: 'replay' });
    // An exported copy runs nothing: no lime button but a comparison.
    expect(nextStepOf(passed, { offers: null, exported: true })).toEqual({ key: 'none' });
  });

  it('compares an attempt with the run it came from, failed or not, and leaves a diverged test to its banner', () => {
    const probe = detail({ parent: PARENT, status: 'completed', state: { ...failedState, kind: 'fork' }, divergence: { callNo: 5, type: 'forced', name: 'POST /v1/messages', replayedBefore: 4 }, meta: { probe: { of: PARENT, callNo: 5 }, repeat: { attempt: 1, of: 20 } }, fix: verified });
    expect(nextStepOf(probe, { offers: null, exported: false })).toEqual({ key: 'compare', parent: PARENT });
    const test = detail({ parent: PARENT, state: { ...failedState, kind: 'test', outcome: { kind: 'diverged', check: null } }, divergence: { callNo: 3, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 2 }, meta: { test: { golden: 'goldens/refund-in-limit' } } });
    expect(nextStepOf(test, { offers: null, exported: false })).toEqual({ key: 'banner' });
    // A replay that left its recording on a value a normalizer masks: its banner's Add normalizer leads.
    const volatile = detail({ parent: PARENT, state: { ...passedState, kind: 'fork' }, divergence: { callNo: 3, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 2, hints: [{ message: 'looks like a UUID', normalizer: { path: '$.metadata.user_id', replace: '<id>' } }] }, actions: [{ key: 'r', label: 'Replay' }, { key: 'n', label: 'Add normalizer' }] });
    expect(nextStepOf(volatile, { offers: null, exported: false })).toEqual({ key: 'banner' });
  });
});
