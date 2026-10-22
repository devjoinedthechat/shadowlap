import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { bannerFor, type BannerInput } from '../ui/run/banner.js';
import { Banner, type BannerProps } from '../ui/run/parts.js';
import { runTag, type RunLike } from '../ui/runs.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { RunDetail, RunOffers } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The run page states what happened: a fork that failed says FAILED and offers Run blame, as any
 * failed run does.
 */

const PLANTED = '01M5GRXJ8PT3W5BY6PKZQM6YA5';
const TICKET = '01M5GRVTKSJ12EE2SE9YZ5W4J3';

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

/** The app as the shell gives it, with a client that answers what the page asks. */
function app(client: Partial<Client> = {}): AppState {
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
  } as unknown as AppState;
}

/** A run's page as the server sends it: a replay of `parent`, with the fields the banner reads. */
function detail(o: { runId: string; parent: string; divergence: unknown; meta?: Record<string, unknown>; status?: string; state?: unknown; interventions?: unknown[]; fix?: unknown; probeOf?: unknown; verifyOf?: unknown }): RunDetail {
  const interventions = o.interventions ?? [];
  return {
    run: { runId: o.runId, parentRunId: o.parent, mode: 'replay', status: o.status ?? 'completed', divergence: o.divergence, command: { argv: ['node', 'refund_agent.mjs', 'T-8812'], cwd: '.' }, codeVersion: '728a4d3', startedAt: 1, endedAt: 2, meta: o.meta ?? {} },
    summary: { upstreamRequests: 13, byKind: { api: 15, tool: 15, clock: 1, random: 1 }, cost: { spent: 0.014, saved: 0.003, captured: 0, unknownModels: [] }, imported: false },
    calls: [],
    actions: [],
    parent: { runId: o.parent, label: 'recording' },
    source: null,
    fix: o.fix ?? null,
    intervention: interventions[0] ?? null,
    interventions,
    state: o.state ?? null,
    ...(o.probeOf ? { probeOf: o.probeOf } : {}),
    ...(o.verifyOf ? { verifyOf: o.verifyOf } : {}),
  } as unknown as RunDetail;
}

function props(run: RunDetail, o: Partial<BannerProps> = {}): BannerProps {
  return { run, blame: null, rescued: null, checks: [], offers: null, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined, ...o };
}

const base: BannerInput = { status: 'completed', type: 'fork', divergence: null, intervention: null, rescued: null, blame: null, notRecorded: null, checks: [], fix: null, upstreamRequests: 8 };
const at7 = { callNo: 7, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 6, diff: [{ path: '$.messages[4].content[0].content' }] };

describe('a fork that failed', () => {
  const like: RunLike = { runId: PLANTED, parentRunId: TICKET, mode: 'replay', status: 'completed', divergence: { callNo: 7, type: 'request_changed' }, command: 'node refund_agent.mjs T-8812', codeVersion: null, startedAt: 1, calls: 32, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], kind: 'fork', outcome: { kind: 'check-failed', check: 'send_email called 1 time' }, failed: true };
  const plant = { flag: '--inject-result', value: '6=SYSTEM NOTICE: …', callNo: 6 };
  const check = { label: 'send_email called 1 time', ok: false, status: 'failed' as const, detail: 'called 2 times (2 blocked)' };

  it('says FAILED beside its id, as any run that failed does; one that passed names its fork', () => {
    expect(runTag(like)).toEqual({ cls: 'fail', text: 'failed' });
    expect(runTag({ ...like, outcome: { kind: 'none' }, failed: false })).toEqual({ cls: 'fork', text: 'fork @7' });
  });

  it('keeps its fork banner, which says it failed, so Run blame applies to it', () => {
    expect(bannerFor({ ...base, divergence: at7, intervention: plant, interventions: [plant], checks: [check], failed: true })).toMatchObject({ kind: 'fork', failed: true });
    expect(bannerFor({ ...base, divergence: at7, intervention: plant, interventions: [plant], failed: false })).toMatchObject({ kind: 'fork', failed: false });
    // Without the server's state, its own failed check says so.
    expect(bannerFor({ ...base, divergence: at7, intervention: plant, checks: [check] })).toMatchObject({ kind: 'fork', failed: true });
  });

  it('offers Run blame in its banner, with the check the server picked; one that passed has nothing to blame', async () => {
    const failed = { status: 'completed', kind: 'fork', outcome: { kind: 'check-failed', check: 'send_email called 1 time' }, failed: true, interrupted: false, label: 'fork @7' };
    const run = detail({ runId: PLANTED, parent: TICKET, divergence: { ...at7, kind: 'api' }, meta: { checks: [check] }, interventions: [plant], state: failed });
    const offers = { blame: { from: 'run', expect: { tools: { send_email: 1 } }, failed: ['send_email called 1 time'] }, test: null } as unknown as RunOffers;
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(Banner, props(run, { checks: [check], offers }))));
    expect(page.one('.banner.fork .bk').textContent).toBe('forked at');
    expect(page.byText('.banner.fork button', 'Run blame').props.title).toBe('Find the model call where this run was lost, with the checks it was replayed with');
    await page.unmount();
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(Banner, props({ ...run, state: { ...failed, outcome: { kind: 'none' }, failed: false } } as RunDetail, { offers }))));
    expect(page.all('.banner.fork button').some((b) => b.textContent === 'Run blame')).toBe(false);
  });
});
