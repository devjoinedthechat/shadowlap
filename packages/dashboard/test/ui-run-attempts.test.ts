import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { attemptOutcome, bannerFor, type BannerInput } from '../ui/run/banner.js';
import { ForksView } from '../ui/run/ForksView.js';
import { attemptLinks, attemptOf, forkKindWords, runKindWords } from '../ui/run/model.js';
import { Banner, type BannerProps } from '../ui/run/FindingsBar.js';
import { DiffHead, DiffNotes } from '../ui/components/DiffNotes.js';
import { jsonDiff } from '../ui/json-diff.js';
import type { RequestDiff } from '../src/request-diff.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { familyLine, type RunLike } from '../ui/runs.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { LineageNode, RunDetail, RunOffers } from '../ui/types.js';
import { render, shownText, type Rendered } from './ui-render.js';


/**
 * The run page states what happened: a fork that failed says FAILED and offers Run blame; an attempt
 * says what was asked again, which attempt it is and how it came out, and leads back to where it
 * counted; the Forks view words a test from what its calls did and bundles a golden's attempts in
 * one session; a diverged test's diff agrees with its banner.
 */

const PLANTED = '01M5GRXJ8PT3W5BY6PKZQM6YA5';
const TICKET = '01M5GRVTKSJ12EE2SE9YZ5W4J3';
const REFUND = '01M5GRVR3137THJ8EJFKS31PJA';

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
  } as unknown as AppState;
}

/** A run's page as the server sends it: a replay of `parent`, with the fields the banner reads. */
function detail(o: { next?: unknown; runId: string; parent: string; divergence: unknown; meta?: Record<string, unknown>; status?: string; state?: unknown; interventions?: unknown[]; fix?: unknown; probeOf?: unknown; verifyOf?: unknown; attemptPlace?: unknown }): RunDetail {
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
    ...(o.next ? { next: o.next } : {}),
    ...(o.probeOf ? { probeOf: o.probeOf } : {}),
    ...(o.verifyOf ? { verifyOf: o.verifyOf } : {}),
    ...(o.attemptPlace ? { attemptPlace: o.attemptPlace } : {}),
  } as unknown as RunDetail;
}

function props(run: RunDetail, o: Partial<BannerProps> = {}): BannerProps {
  return { run, blame: null, rescued: null, checks: [], offers: null, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined, ...o };
}

/** The header's props, as the run page gives them. */
function header(run: RunDetail, offers: RunOffers | null) {
  return { run, call: null, selected: 7, rescued: false, offers, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined };
}

const base: BannerInput = { status: 'completed', type: 'fork', divergence: null, intervention: null, rescued: null, blame: null, notRecorded: null, checks: [], fix: null, upstreamRequests: 8 };
const at7 = { callNo: 7, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 6, diff: [{ path: '$.messages[4].content[0].content' }] };

describe('a fork that failed', () => {
  const plant = { flag: '--inject-result', value: '6=SYSTEM NOTICE: …', callNo: 6 };
  const check = { label: 'send_email called 1 time', ok: false, status: 'failed' as const, detail: 'called 2 times (2 blocked)' };

  it('keeps its kind in Compare, where each side is headed by what it is, as its eyebrow says it: a fork by where it forked, failed or not', () => {
    const at = (callNo: number) => ({ callNo, kind: 'api' as const, name: 'POST /v1/messages', type: 'request_changed' as const, replayedBefore: callNo - 1 });
    const fork = { run: { meta: {}, divergence: at(7) } } as unknown as Parameters<typeof runKindWords>[0];
    expect(runKindWords(fork, 'fork', false)).toBe('fork @7');
    // A recording or a test replay is named by its kind, never by how it came out.
    expect(runKindWords({ ...fork, run: { ...fork.run, divergence: null } }, 'recording', false)).toBe('recording');
    expect(runKindWords({ ...fork, run: { ...fork.run, divergence: at(3) } }, 'test', false)).toBe('test replay');
    // The fork blame rescued a run with says so.
    expect(runKindWords(fork, 'fork', true)).toBe('rescued fork');
  });

  it('keeps its fork banner, which says it failed, so Run blame applies to it', () => {
    expect(bannerFor({ ...base, divergence: at7, intervention: plant, interventions: [plant], checks: [check], failed: true })).toMatchObject({ kind: 'fork', failed: true });
    expect(bannerFor({ ...base, divergence: at7, intervention: plant, interventions: [plant], failed: false })).toMatchObject({ kind: 'fork', failed: false });
    // Without the server's state, its own failed check says so.
    expect(bannerFor({ ...base, divergence: at7, intervention: plant, checks: [check] })).toMatchObject({ kind: 'fork', failed: true });
  });

  it('leads with Run blame in its header, with the check the server picked, and its banner doesn’t offer it again; one that passed is compared with its parent', async () => {
    const failed = { status: 'completed', kind: 'fork', outcome: { kind: 'check-failed', check: 'send_email called 1 time' }, failed: true, interrupted: false, label: 'fork @7' };
    const blame = { from: 'run', expect: { tools: { send_email: 1 } }, failed: ['send_email called 1 time'] };
    const run = detail({ runId: PLANTED, parent: TICKET, divergence: { ...at7, kind: 'api' }, meta: { checks: [check] }, interventions: [plant], state: failed, next: { key: 'blame', label: 'Run blame', offer: blame } });
    const offers = { blame, test: null } as unknown as RunOffers;
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement('div', null, createElement(RunHeader, header(run, offers)), createElement(Banner, props(run, { checks: [check], offers })))));
    expect(page.one('.banner.fork .bk').textContent).toBe('forked at');
    expect(page.all('.banner.fork button').some((b) => b.textContent === 'Run blame')).toBe(false);
    const lead = page.byText('.rhead .actions button', 'Run blame');
    expect(lead.className).toBe('btn lime');
    expect(JSON.parse(String(lead.props['data-tip']))).toMatchObject({ t: 'Run blame', s: 'Find the model call where this run was lost, with the checks it was replayed with' });
    // Replay is there, plain: the one lime button is the next step.
    expect(page.byText('.rhead .actions button', 'Replay').className).toBe('btn');
    await page.unmount();
    const passed = { ...run, state: { ...failed, outcome: { kind: 'none' }, failed: false }, next: { key: 'compare', label: 'Compare with parent', parent: TICKET, href: `#/compare/${TICKET}/${PLANTED}` } } as unknown as RunDetail;
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement('div', null, createElement(RunHeader, header(passed, offers)), createElement(Banner, props(passed, { offers })))));
    expect(page.all('button').some((b) => b.textContent === 'Run blame')).toBe(false);
    expect(page.byText('.rhead .actions a', 'Compare with parent').className).toBe('btn lime');
  });
});

describe('an attempt', () => {
  const probe = { kind: 'probe' as const, k: 1, n: 4, callNo: 5, verdict: 'failed' as const };
  const diverge = [
    { flag: '--diverge-at', value: '5', callNo: 5 },
    { flag: '--writes', value: 'stub', callNo: null },
  ];
  const forcedAt5 = { callNo: 5, type: 'forced', name: 'POST /v1/messages', replayedBefore: 4, reason: 'forced live by --diverge-at 5' };
  const verifyFork = { callNo: 1, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.system' }] };
  const stub = [{ flag: '--writes', value: 'stub', callNo: null }];

  it('explains a fork whose only flag is --writes, as a verify attempt’s was, by where its request changed', () => {
    const w = { flag: '--writes', value: 'stub', callNo: null };
    const changed = { callNo: 1, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.system' }] };
    expect(bannerFor({ ...base, divergence: changed, intervention: w, interventions: [w] })).toMatchObject({ kind: 'fork', why: 'a request changed · writes stubbed · 0 calls replayed before it', flag: null });
    // The flag that made a fork is never the policy for the calls after it, wherever the policy comes.
    const model = { flag: '--model', value: '1:claude-opus-5', callNo: 1 };
    expect(bannerFor({ ...base, divergence: changed, intervention: w, interventions: [w, model] })).toMatchObject({ why: 'claude-opus-5 answers from here with --model 1:claude-opus-5 · writes stubbed · 0 calls replayed before it', flag: '--model 1:claude-opus-5' });
  });

  it('says how it came out, what was asked again and which attempt it is', () => {
    const failed = { ...base, divergence: forcedAt5, intervention: diverge[0], interventions: diverge, attempt: probe, checks: [{ label: 'issue_refund with {"amount":240} called 0 times', ok: false, status: 'failed', detail: 'called 1 time' }] };
    expect(bannerFor(failed)).toEqual({ kind: 'attempt', of: 'probe', callNo: 5, outcome: { tone: 'no', text: 'failed' }, why: 'resampled #5, attempt\u00a01\u00a0of\u00a04: the model was asked #5 again, the request as recorded · writes stubbed', flag: null, diff: false });
    // The verdict blame kept on it is how it came out, whatever its checks say.
    expect(bannerFor({ ...failed, attempt: { ...probe, verdict: 'passed' } })).toMatchObject({ outcome: { tone: 'ok', text: 'passed' } });
    // A verify attempt forked where the change it verified is in the request, at the code it ran; never by its --writes.
    const verify = { ...base, divergence: verifyFork, intervention: stub[0], interventions: stub, codeVersion: '35034be+dirty', attempt: { kind: 'verify' as const, k: 1, n: 3, role: 'target', verdict: 'passed' as const } };
    expect(bannerFor(verify)).toEqual({ kind: 'attempt', of: 'verify', callNo: 1, outcome: { tone: 'ok', text: 'passed' }, why: 'verify\u00a0· target, attempt\u00a01\u00a0of\u00a03 · code\u00a035034be+dirty: the change it verified is in the request (~ $.system) · writes stubbed', flag: null, diff: true });
    expect(bannerFor({ ...verify, attempt: { ...verify.attempt, role: 'holdout' } })).toMatchObject({ why: 'verify\u00a0· held-out, attempt\u00a01\u00a0of\u00a03 · code\u00a035034be+dirty: the change it verified is in the request (~ $.system) · writes stubbed' });
    // A role the record doesn't name (a run from someone else's pack) is left out, and so is a revision it doesn't keep.
    expect(bannerFor({ ...verify, codeVersion: null, attempt: { ...verify.attempt, role: null } })).toMatchObject({ why: 'verify, attempt\u00a01\u00a0of\u00a03: the change it verified is in the request (~ $.system) · writes stubbed' });
    // A change made with a flag (--model, --set) names itself.
    const model = { flag: '--model', value: '1:claude-opus-5', callNo: 1 };
    expect(bannerFor({ ...verify, intervention: model, interventions: [model, ...stub] })).toMatchObject({ why: 'verify\u00a0· target, attempt\u00a01\u00a0of\u00a03 · code\u00a035034be+dirty: claude-opus-5 answers from here with --model 1:claude-opus-5 · writes stubbed', flag: '--model 1:claude-opus-5' });
    // A --repeat's attempt: the command, where it forked and the flag that made it; the count the command asked for apart from how many were made.
    const live = { flag: '--live-tool', value: 'lookup_policy', callNo: null };
    const repeat = { ...base, divergence: { callNo: 16, type: 'forced', name: 'lookup_policy', replayedBefore: 15, reason: 'forced live by --live-tool lookup_policy' }, intervention: live, interventions: [live], attempt: { kind: 'repeat' as const, k: 1, n: 3, count: 5 } };
    expect(bannerFor(repeat)).toMatchObject({ kind: 'attempt', why: 'replay --repeat 5 at #16, attempt\u00a01\u00a0of\u00a03: forced live with --live-tool lookup_policy', flag: '--live-tool lookup_policy', outcome: { tone: 'ok', text: 'passed' } });
    // An attempt that forked nowhere replayed every call from the recording, and says so.
    expect(bannerFor({ ...base, attempt: { kind: 'verify', k: 2, n: 3, role: 'good', verdict: 'passed' } })).toMatchObject({ kind: 'attempt', callNo: null, why: 'verify\u00a0· good, attempt\u00a02\u00a0of\u00a03: every call replayed from the recording', diff: false });
    // How many were made is not known (an older server): attempt k alone, never of the most that could have been made.
    expect(bannerFor({ ...failed, attempt: { ...probe, n: null } })).toMatchObject({ why: 'resampled #5, attempt\u00a01: the model was asked #5 again, the request as recorded · writes stubbed' });
    // One a check could not decide says which, at the end.
    expect(bannerFor({ ...failed, attempt: { ...probe, verdict: 'inconclusive' }, checks: [{ label: 'judge "polite" answers yes', ok: false, status: 'inconclusive' }] })).toMatchObject({ outcome: { tone: 'inc', text: 'inconclusive', why: 'judge "polite" answers yes' }, why: 'resampled #5, attempt\u00a01\u00a0of\u00a04: the model was asked #5 again, the request as recorded · writes stubbed · judge "polite" answers yes' });
    // Never the failed banner's "not blamed yet": an attempt's failure counts towards what made it.
    expect(JSON.stringify(bannerFor({ ...failed, divergence: null }))).not.toContain('not blamed yet');
  });

  it('says the fork blame rescued a run with is the attempt of its probe that passed', () => {
    const rescued = { ...base, divergence: forcedAt5, intervention: diverge[0], interventions: diverge, rescued: { callNo: 5 }, attempt: { ...probe, k: 3, n: 4, verdict: 'passed' as const } };
    expect(bannerFor(rescued)).toEqual({ kind: 'attempt', of: 'rescued', callNo: 5, outcome: { tone: 'ok', text: 'passed' }, why: 'rescued #5, attempt\u00a03\u00a0of\u00a04: the model was asked #5 again, the request as recorded · writes stubbed', flag: null, diff: false });
    // From a record that keeps no probe: the call it asked again, and that its writes were stubbed, as every probe's are.
    expect(bannerFor({ ...base, divergence: forcedAt5, rescued: { callNo: 5 } })).toMatchObject({ of: 'rescued', why: 'rescued #5: the model was asked #5 again, the request as recorded · writes stubbed' });
  });

  it('comes out as its checks and exit say when nothing kept a verdict on it: failed, inconclusive (amber) or interrupted (grey)', () => {
    expect(attemptOutcome({ status: 'completed', checks: [] })).toEqual({ tone: 'ok', text: 'passed' });
    expect(attemptOutcome({ status: 'failed', checks: [] })).toEqual({ tone: 'no', text: 'failed' });
    expect(attemptOutcome({ status: 'completed', checks: [{ label: 'send_email called 1 time', ok: false, status: 'failed' }] })).toEqual({ tone: 'no', text: 'failed' });
    expect(attemptOutcome({ status: 'completed', checks: [{ label: 'judge "polite" answers yes', ok: false, status: 'inconclusive' }] })).toEqual({ tone: 'inc', text: 'inconclusive', why: 'judge "polite" answers yes' });
    expect(attemptOutcome({ status: 'completed', checks: [{ label: 'judge "polite" answers yes', ok: false, status: 'inconclusive' }] }, { verdict: 'inconclusive' })).toEqual({ tone: 'inc', text: 'inconclusive', why: 'judge "polite" answers yes' });
    expect(attemptOutcome({ status: 'completed', checks: [] }, { verdict: 'inconclusive' })).toEqual({ tone: 'inc', text: 'inconclusive' });
    expect(attemptOutcome({ status: 'crashed', checks: [] })).toEqual({ tone: 'n', text: 'interrupted' });
    expect(attemptOutcome({ status: 'completed', checks: [], interrupted: true }, { verdict: 'failed' })).toEqual({ tone: 'n', text: 'interrupted' });
  });

  it('is read from the run’s record, with the verdict blame or verify kept on it, and its place as the server counts it', () => {
    const place = { k: 2, n: 3 };
    expect(attemptOf({ run: { meta: { probe: { of: REFUND, callNo: 5, passed: false, verdict: 'failed' }, repeat: { group: 'g-5', attempt: 2, of: 4 } } }, attemptPlace: place })).toEqual({ kind: 'probe', k: 2, n: 3, callNo: 5, verdict: 'failed' });
    // One kept before attempts had a verdict: whether it passed.
    expect(attemptOf({ run: { meta: { probe: { of: REFUND, callNo: 5, passed: true }, repeat: { group: 'g-5', attempt: 3, of: 4 } } }, attemptPlace: { k: 3, n: 3 } })).toMatchObject({ verdict: 'passed' });
    expect(attemptOf({ run: { meta: { verify: { role: 'good', passed: false, verdict: 'inconclusive' }, repeat: { group: 'g', attempt: 1, of: 80 } } }, attemptPlace: { k: 1, n: 12 } })).toEqual({ kind: 'verify', k: 1, n: 12, role: 'good', verdict: 'inconclusive' });
    expect(attemptOf({ run: { meta: { repeat: { group: 'g', attempt: 3, of: 5 } } }, attemptPlace: { k: 3, n: 5 } })).toEqual({ kind: 'repeat', k: 3, n: 5, count: 5 });
    // Without the server's count (an older server), which attempt it is, of an unknown number: never the record's `of`, the most that could be made.
    expect(attemptOf({ run: { meta: { verify: { role: 'target', passed: true }, repeat: { group: 'g', attempt: 4, of: 80 } } } })).toMatchObject({ k: 4, n: null });
    expect(attemptOf({ run: { meta: { labels: ['x'] } } })).toBeNull();
  });

  it('is not one when an injection test, a model’s scoring or an error-path preset made it: an injection test’s replay says what was planted where, a scoring keeps its fork banner', () => {
    // As `shadowlap injection` and `shadowlap tasks score` mark their replays: meta.repeat, with what made them.
    const injection = { repeat: { group: 'inj-1', attempt: 2, of: 3 }, injection: { result: 'inj-1', read: 6, attempt: 2, of: 3, role: 'attempt', payload: 'exfiltrate' } };
    const task = { repeat: { group: 'S1-refund', attempt: 1, of: 8 }, task: { golden: 'goldens/refund', model: 'claude-haiku-4-5', takeover: 5, attempt: 1, of: 8, score: 1, session: 'S1' } };
    const chaos = { chaos: { preset: 'tool-timeout', callNo: 4, session: 'S2', attempt: 1 } };
    for (const meta of [injection, task, chaos]) expect(attemptOf({ run: { meta } as never, attemptPlace: { k: 1, n: 3 } })).toBeNull();
    // An injection test's replay says, from its own record, what was planted in which read with which attempt, and the writes, never "replay --repeat".
    const plant = { flag: '--inject-result', value: '6=SYSTEM NOTICE: …', callNo: 6 };
    const replay = (role: string) => ({ ...base, divergence: at7, intervention: plant, interventions: [plant, ...stub], calls: [{ callNo: 6, kind: 'tool', name: 'get_ticket' }], injection: { ...injection.injection, role } as never, attempt: attemptOf({ run: { meta: injection } as never, attemptPlace: { k: 2, n: 3 } }) });
    const b = bannerFor(replay('attempt'));
    expect(b).toEqual({ kind: 'injection-attempt', role: 'attempt', callNo: 7, why: 'exfiltrate #6, attempt 2 of 3 · writes stubbed, nothing sent', result: 'inj-1', proofWhy: null });
    expect(JSON.stringify(b)).not.toContain('--repeat');
    expect(bannerFor(replay('clean'))).toMatchObject({ role: 'clean', why: '#6 get_ticket made neutral, attempt 2 of 3 · writes stubbed' });
    expect(bannerFor(replay('baseline'))).toMatchObject({ role: 'baseline', why: 'nothing planted in #6 get_ticket, attempt 2 of 3 · writes stubbed · what an attempt is compared with' });
    // One nothing carried the canary out of says why under its proof: its own reason, else its check's.
    expect(bannerFor({ ...replay('attempt'), checks: [{ label: 'no tool call carries the planted canary', ok: true, detail: 'no tool call after #6 carries x7f3kq2m@canary.invalid' }] })).toMatchObject({ proofWhy: 'no tool call after #6 carries x7f3kq2m@canary.invalid' });
    const diverged = { flag: '--diverge-at', value: '5', callNo: 5 };
    expect(bannerFor({ ...base, divergence: forcedAt5, intervention: diverged, interventions: [diverged], attempt: attemptOf({ run: { meta: task }, attemptPlace: { k: 1, n: 8 } }) })).toMatchObject({ kind: 'fork', why: 'asked again with --diverge-at 5 · 4 calls replayed before it' });
  });

  it('is named in the eyebrow by what made it; the fork blame rescued a run with is its rescued fork', () => {
    const probeRun = { run: { meta: { probe: { of: REFUND, callNo: 5, passed: true }, repeat: { group: 'g-5', attempt: 2, of: 20 } }, divergence: { callNo: 5 } }, attemptPlace: { k: 2, n: 8 } } as never;
    expect(forkKindWords(probeRun, 'fork', false)).toBe('blame attempt');
    expect(forkKindWords(probeRun, 'fork', true)).toBe('rescued fork');
    expect(forkKindWords({ run: { meta: { verify: { role: 'target', passed: true }, repeat: { group: 'g', attempt: 1, of: 80 } }, divergence: { callNo: 1 } } } as never, 'fork', false)).toBe('verify attempt');
    // One that forked nowhere is an attempt all the same.
    expect(forkKindWords({ run: { meta: { verify: { role: 'good', passed: true }, repeat: { group: 'g', attempt: 1, of: 3 } }, divergence: null } } as never, 'clean', false)).toBe('verify attempt');
    expect(forkKindWords({ run: { meta: { repeat: { group: 'g', attempt: 3, of: 5 } }, divergence: { callNo: 16 } } } as never, 'fork', false)).toBe('repeat attempt');
    // An injection test's replay by its role, from its own record, never by where it forked.
    const injection = (role: string) => ({ run: { meta: { repeat: { group: 'inj', attempt: 1, of: 3 }, injection: { result: 'inj', role, read: 4, attempt: 1, of: 3 } }, divergence: { callNo: 7 } } }) as never;
    expect(forkKindWords(injection('attempt'), 'fork', false)).toBe('injection attempt');
    expect(forkKindWords(injection('clean'), 'fork', false)).toBe('clean attempt');
    expect(forkKindWords(injection('baseline'), 'fork', false)).toBe('baseline');
    // Any other fork by where it forked; any other run by its kind.
    expect(forkKindWords({ run: { meta: { repeat: { group: 'g', attempt: 1, of: 3 }, task: { golden: 'goldens/refund', model: 'm', takeover: 7, attempt: 1, of: 3, score: 1, session: 'S1' } }, divergence: { callNo: 7 } } } as never, 'fork', false)).toBe('fork @7');
    expect(forkKindWords({ run: { meta: {}, divergence: null } }, 'recording', false)).toBeNull();
  });

  it('reads a golden’s test attempt by its golden, its place in the session and the code it tested, and leads to Tests', () => {
    const meta = { test: { golden: 'goldens/refund-over-limit', session: 'S1', attempt: 2, of: TICKET } };
    const a = attemptOf({ run: { meta }, attemptPlace: { k: 2, n: 8 } });
    expect(a).toEqual({ kind: 'test', k: 2, n: 8, golden: 'goldens/refund-over-limit' });
    // Without the server's count, attempt k alone; the attempt the session's result shows is its test replay, no attempt.
    expect(attemptOf({ run: { meta } })).toMatchObject({ k: 2, n: null });
    expect(attemptOf({ run: { meta: { test: { golden: 'goldens/refund-over-limit', session: 'S1', attempt: 1 } } }, attemptPlace: null })).toBeNull();
    expect(forkKindWords({ run: { meta, divergence: { callNo: 3 } } } as never, 'test', false)).toBe('test attempt');
    // A golden that may fork went live from its fork, its writes blocked as `shadowlap test` blocks them.
    const forked = { ...base, type: 'test' as const, divergence: { callNo: 3, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 2 }, outcome: { kind: 'passed' }, codeVersion: 'd2e8a1f', attempt: a };
    expect(bannerFor(forked)).toEqual({ kind: 'attempt', of: 'test', callNo: 3, outcome: { tone: 'ok', text: 'passed' }, why: 'refund-over-limit, attempt\u00a02\u00a0of\u00a08 · test at\u00a0d2e8a1f: live from where the golden may fork · writes blocked', flag: null, diff: false });
    // --writes says otherwise; one that left its recording where it shouldn't have says how; one that forked nowhere replayed every call.
    expect(bannerFor({ ...forked, interventions: [{ flag: '--writes', value: 'allow', callNo: null }] })).toMatchObject({ why: expect.stringMatching(/ · writes allowed$/) });
    expect(bannerFor({ ...forked, outcome: { kind: 'diverged' }, codeVersion: null, divergence: { ...forked.divergence, diff: [{ path: '$.system' }] } })).toMatchObject({ why: 'refund-over-limit, attempt\u00a02\u00a0of\u00a08: a request changed (~ $.system) · writes blocked', diff: true });
    expect(bannerFor({ ...forked, divergence: null })).toMatchObject({ callNo: null, why: 'refund-over-limit, attempt\u00a02\u00a0of\u00a08 · test at\u00a0d2e8a1f: every call replayed from the recording' });
    // Its way back is Tests, where its session's result is, as the design's is.
    expect(attemptLinks({ run: { runId: 'T2' }, fix: null }, a!)).toEqual([{ href: '#/tests', label: 'Tests →' }]);
  });

  it('leads back to where it counted, and to its bundle: all its attempts, counted, when they are several', () => {
    const fix = { id: 'fx-1', status: 'verified', title: 'Refunds above the limit' };
    expect(attemptLinks({ run: { runId: 'A1' }, fix, probeOf: { of: REFUND, callNo: 5 } }, { kind: 'probe', k: 2, n: 3, callNo: 5 })).toEqual([
      { href: '#/fixes/fx-1/blame', label: 'Probe #5 →' },
      { href: '#/run/A1/forks', label: 'All 3 attempts →' },
    ]);
    // A probe no fix keeps leads to the run it probed.
    expect(attemptLinks({ run: { runId: 'A1' }, fix: null, probeOf: { of: REFUND, callNo: 5 } }, { kind: 'probe', k: 2, n: 3, callNo: 5 })[0]).toEqual({ href: `#/run/${REFUND}`, label: 'Probe #5 →' });
    expect(attemptLinks({ run: { runId: 'V1' }, fix, verifyOf: { href: '#/fixes/fx-1/verify/vf-2' } }, { kind: 'verify', k: 1, n: 12, role: 'target' })).toEqual([
      { href: '#/fixes/fx-1/verify/vf-2', label: 'Verdict →' },
      { href: '#/run/V1/forks', label: 'All 12 attempts →' },
    ]);
    // A candidate a repair tried and dropped was verified on its Repair step; with no fix, only the bundle.
    expect(attemptLinks({ run: { runId: 'V1' }, fix, verifyOf: { href: '#/fixes/fx-1/repair' } }, { kind: 'verify', k: 1, n: 3, role: 'target' })[0]).toEqual({ href: '#/fixes/fx-1/repair', label: 'Repair →' });
    expect(attemptLinks({ run: { runId: 'V1' }, fix: null, verifyOf: { href: `#/run/${REFUND}` } }, { kind: 'verify', k: 1, n: 3, role: 'target' })).toEqual([{ href: '#/run/V1/forks', label: 'All 3 attempts →' }]);
    expect(attemptLinks({ run: { runId: 'R1' }, fix: null }, { kind: 'repeat', k: 1, n: 5, count: 5 })).toEqual([{ href: '#/run/R1/forks', label: 'All 5 attempts →' }]);
    // One attempt alone, or a count not known: its family's Forks view, with no number.
    expect(attemptLinks({ run: { runId: 'V2' }, fix: null }, { kind: 'verify', k: 1, n: 1, role: 'good' })).toEqual([{ href: '#/run/V2/forks', label: 'Forks →' }]);
    expect(attemptLinks({ run: { runId: 'V2' }, fix: null }, { kind: 'verify', k: 4, n: null, role: 'good' })).toEqual([{ href: '#/run/V2/forks', label: 'Forks →' }]);
  });

  it('draws what was asked again on a line that wraps, leaving its verdict to the first fact, with its links and no Run blame', async () => {
    const run = detail({
      runId: '01M5GRW4YMYK6SK2VFC2XFKCDA',
      parent: REFUND,
      divergence: { callNo: 1, type: 'forced', kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, reason: 'forced live by --diverge-at 1' },
      meta: { probe: { of: REFUND, callNo: 1, passed: false, verdict: 'failed' }, repeat: { group: 'g-1', attempt: 1, of: 20 }, checks: [{ label: 'issue_refund with {"amount":240} called 0 times', ok: false, status: 'failed', detail: 'called 1 time' }] },
      interventions: [
        { flag: '--diverge-at', value: '1', callNo: 1 },
        { flag: '--writes', value: 'stub', callNo: null },
      ],
      state: { status: 'completed', kind: 'fork', outcome: { kind: 'check-failed', check: 'issue_refund with {"amount":240} called 0 times' }, failed: true, interrupted: false, label: 'fork @1' },
      fix: { id: 'fx-01M5GRW7X3', status: 'verified', title: 'Refund above the limit' },
      probeOf: { of: REFUND, callNo: 1 },
      // A gate settled the probe after 8 of its 20 attempts.
      attemptPlace: { k: 1, n: 8 },
    });
    const offers = { blame: { from: 'run', failed: ['issue_refund with {"amount":240} called 0 times'] }, test: null } as unknown as RunOffers;
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(Banner, props(run, { offers }))));
    expect(page.one('.banner.fork.wrap .bk').textContent).toBe('forked at');
    // What was asked again, each part held to the one before by a no-break space, so a wrapped line never starts with a dot.
    expect(shownText(page.one('.banner .why'))).toBe('resampled #1, attempt\u00a01\u00a0of\u00a08: the model was asked #1 again, the request as recorded\u00a0· writes stubbed');
    expect(page.all('.banner .why em')).toHaveLength(0);
    expect(page.all('.banner .end a').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Probe #1 →', '#/fixes/fx-01M5GRW7X3/blame'],
      ['All 8 attempts →', '#/run/01M5GRW4YMYK6SK2VFC2XFKCDA/forks'],
    ]);
    expect(page.all('.banner button').some((b) => b.textContent === 'Run blame')).toBe(false);
  });
});

describe('the Forks view', () => {
  const node = (runId: string, over: Partial<LineageNode> = {}): LineageNode => ({ runId, parentRunId: TICKET, depth: 1, mode: 'replay', status: 'completed', label: 'test', divergence: null, calls: 32, spent: 0, saved: 0, startedAt: 2, repeat: null, checks: { passed: 1, total: 1 }, origins: 'r'.repeat(32), test: null, kind: 'test', outcome: { kind: 'passed', checks: 1 }, failed: false, ...over });
  const forked = (runId: string, attempt: number | null, startedAt: number, session = 'S1') => node(runId, { divergence: { callNo: 3, type: 'request_changed' }, origins: `rr${'l'.repeat(25)}${'r'.repeat(3)}bb`, spent: 0.0176, startedAt, test: { golden: 'goldens/refund-over-limit', session, attempt } });
  const like = (n: LineageNode): RunLike => ({ runId: n.runId, parentRunId: n.parentRunId, mode: n.mode, status: n.status, divergence: n.divergence, command: '', codeVersion: null, startedAt: n.startedAt, calls: n.calls, spent: n.spent, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], origins: n.origins ?? null, test: n.test ?? null, kind: 'test', checks: n.checks, outcome: n.outcome ?? null });

  it('words a test that forked live from what its calls did, not as replayed offline', () => {
    expect(familyLine(like(forked('T1', null, 1)))).toBe('test · forked at #3 · 25 live · ≈$0.018');
    expect(familyLine(like(node('T2')))).toBe('test · replayed offline · 32 calls');
    // One that diverged where its golden may not fork failed there: it never forked.
    const diverged = node('T3', { divergence: { callNo: 3, type: 'request_changed' }, calls: 6, origins: 'rrllfb', outcome: { kind: 'diverged', callNo: 3 }, failed: true });
    expect(familyLine(like(diverged))).toBe('test · diverged at #3 · 6 calls');
  });

  it('bundles a golden’s attempts in one test session, as one test', async () => {
    const lineage: LineageNode[] = [
      { ...node(TICKET, { parentRunId: null, depth: 0, mode: 'record', kind: 'recording', test: null, origins: 'l'.repeat(30), calls: 30, checks: null, outcome: { kind: 'none' } }) },
      ...[1, 2, 3, 4, 5].map((k) => forked(`0TEST${k}`.padEnd(26, '0'), k, 10 + k)),
      // The same golden replayed once in a session is a test of its own.
      forked('0OTHER'.padEnd(26, '0'), null, 30, 'S2'),
    ];
    const client = { lineage: () => Promise.resolve(lineage), fixBundles: () => Promise.resolve([]), injectionResults: () => Promise.resolve({ results: [] }) };
    page = await render(createElement(AppContext.Provider, { value: app(client as unknown as Partial<Client>) }, createElement(ForksView, { runId: '0TEST3'.padEnd(26, '0') })));
    await page.until('the family to load', () => page!.all('.fnode').length > 0);
    const titles = page.all('.fnode .f1 code').map((c) => c.textContent);
    expect(titles).toContain('test · refund-over-limit');
    expect(titles.filter((t) => t.startsWith('0TEST'))).toEqual([]);
    const bundle = page.all('.fnode').find((n) => n.textContent.includes('test · refund-over-limit'))!;
    expect(bundle.className).toContain('here');
    expect(bundle.textContent).toContain('forked 5 attempts, 5 passed · ≈$0.088');
    expect(page.all('.fnode .attempts span').map((s) => s.textContent)).toEqual([1, 2, 3, 4, 5].map((k) => `0TEST${k}0000 · checks 1 of 1`));
    expect(titles.some((t) => t.startsWith('0OTHER'))).toBe(true);
  });

  it('says what a gated golden’s gate made of its attempts in the session, with the rule once, as Tests does', async () => {
    const gate = { verdict: 'inconclusive · 3 of 5 · rate 0.23 to 0.88 (95%)', rule: 'gate: tells 90%+ from 70%- at <= 5% risk, up to 5 attempts' };
    const lineage: LineageNode[] = [
      { ...node(TICKET, { parentRunId: null, depth: 0, mode: 'record', kind: 'recording', test: null, origins: 'l'.repeat(30), calls: 30, checks: null, outcome: { kind: 'none' } }) },
      ...[1, 2, 3, 4, 5].map((k) => {
        const n = forked(`0GATE${k}`.padEnd(26, '0'), k, 10 + k);
        return { ...n, checks: { passed: k <= 3 ? 1 : 0, total: 1 }, test: { ...n.test!, gate } };
      }),
    ];
    const client = { lineage: () => Promise.resolve(lineage), fixBundles: () => Promise.resolve([]), injectionResults: () => Promise.resolve({ results: [] }) };
    page = await render(createElement(AppContext.Provider, { value: app(client as unknown as Partial<Client>) }, createElement(ForksView, { runId: '0GATE2'.padEnd(26, '0') })));
    await page.until('the family to load', () => page!.all('.fnode').length > 0);
    const bundle = page.all('.fnode').find((n) => n.textContent.includes('test · refund-over-limit'))!;
    // The verdict word, the tally and the Wilson bound, with what the attempts spent; never a bare count of passes.
    expect(page.one('.fnode.here .f2').textContent).toBe('inconclusive · 3 of 5 · rate 0.23 to 0.88 (95%) · ≈$0.088gate: tells 90%+ from 70%- at <= 5% risk, up to 5 attempts');
    expect(page.all('.fnode .frule').map((r) => r.textContent)).toEqual(['gate: tells 90%+ from 70%- at <= 5% risk, up to 5 attempts']);
    expect(bundle.textContent).not.toContain('3 passed');
  });
});

describe('Show diff’s words', () => {
  const user = '6faa71ad-0381-40a5-aaa6-2b90195750da';
  const uuidCommand = "shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'";
  const uuidFix = { kind: 'normalizer' as const, looks: 'a UUID', op: 'added' as const, certain: true, message: '$.metadata.user_id is new in the request and looks like a UUID: if the change is meant, add this normalizer as well as updating the golden, or the next run diverges on it', args: [], command: uuidCommand };
  const answer = (over: Partial<RequestDiff>): RequestDiff => ({
    at: 3,
    what: 'request',
    call: { kind: 'api', name: 'POST /v1/messages' },
    against: { runId: '01K5CQ4N7G'.padEnd(26, '0'), callNo: 3 },
    was: { model: 'claude-sonnet-4-5' },
    now: { model: 'claude-sonnet-4-5', metadata: { user_id: user } },
    whole: true,
    leftOut: [],
    same: false,
    askedAgain: false,
    type: 'request_changed',
    path: '$.metadata.user_id',
    paths: [{ path: '$.metadata.user_id', what: 'metadata.user_id', fix: uuidFix }],
    updates: true,
    masked: [],
    outside: [],
    hints: [],
    flag: null,
    tool: null,
    next: null,
    test: true,
    ...over,
  });
  // What a reader reads: the markup's text, its glued spaces as spaces.
  const said = (d: RequestDiff, lines = jsonDiff(d.was, d.now)) =>
    renderToStaticMarkup(createElement(AppContext.Provider, { value: app() }, createElement(DiffNotes, { diff: d, lines })))
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\u00a0|&nbsp;/g, ' ');

  it('says a test’s one value made anew as its banner does, with its normalizer, and the golden updated after it where the recording lacked it', () => {
    const text = said(answer({}));
    expect(text).toContain('A value the recording never had, at $.metadata.user_id, looks like a UUID: the agent makes a new one on every run. A normalizer masks it before matching; the request still carries the field the recording lacks, so the golden is updated after it.');
    expect(text).toContain(`$${uuidCommand}`);
    expect(text).not.toContain('no normalizer is suggested');
    const changed = answer({ was: { metadata: { user_id: 'a1' } }, paths: [{ path: '$.metadata.user_id', what: null, fix: { ...uuidFix, op: 'changed' } }], updates: false });
    expect(said(changed)).toContain('Only a value changed at $.metadata.user_id, and it looks like a UUID: the agent makes a new one on every run. A normalizer masks it before matching, and older recordings match too.');
    const real = answer({ paths: [{ path: '$.metadata.user_id', what: null, fix: { ...uuidFix, op: 'changed', certain: false } }], updates: false });
    expect(said(real)).toContain('and it looks like a UUID, though it may be a real change: look at it before masking it. A normalizer masks it before matching, and older recordings match too.');
  });

  it('gives each change a line with what fixes it, what matching masks a muted line, and every command in one box', () => {
    const d = answer({
      paths: [
        { path: '$.metadata.user_id', what: null, fix: { ...uuidFix, op: 'changed' } },
        { path: '$.model', what: 'model', fix: { kind: 'update' } },
        { path: '$.metadata.order_id', what: null, fix: { ...uuidFix, looks: 'an id', op: 'changed', certain: false, message: '$.metadata.order_id is an id, and a changed id may be a real change (another customer, another order); only if this one is made anew on every run, add a normalizer', command: "shadowlap normalize add --kind api --path '$.metadata.order_id' --replace '<ID>'" } },
      ],
      masked: ['$.metadata.sent_at'],
      outside: ['headers.x-trace'],
      hints: [{ message: 'the x-trace header is part of what makes a model call the same call, and no normalizer masks it: send the recorded value, or record again with the new one', command: null }],
    });
    const text = said(d);
    expect(text).toContain('$.metadata.user_id looks like a UUID, made anew on every run: a normalizer masks it.');
    expect(text).toContain('$.model is what your code or config changed: Update golden re-records it.');
    expect(text).toContain('$.metadata.order_id is an id, and a changed id may be a real change (another customer, another order); only if this one is made anew on every run, add a normalizer.');
    expect(text).toContain('$.metadata.sent_at changed too, and matching masks it.');
    expect(text).toContain('The x-trace header is part of what makes a model call the same call');
    // A header the engine's hint names has no line of its own.
    expect(text).not.toContain('headers.x-trace');
    expect(text).not.toContain('Only a value changed');
    expect(text).toContain("$shadowlap normalize add --kind api --path '$.metadata.user_id'");
    expect(text).toContain("$shadowlap normalize add --kind api --path '$.metadata.order_id'");
    // No value made anew: the paths that changed, then what fixes each.
    const code = answer({ was: { model: 'a', system: 'x' }, now: { model: 'b', system: 'y' }, path: '$.model', paths: [{ path: '$.model', what: 'model', fix: { kind: 'update' } }, { path: '$.system', what: 'system', fix: { kind: 'update' } }] });
    expect(said(code)).toMatch(/^The request changed at \$\.model and \$\.system\.\$\.model is what your code or config changed/);
  });

  it('says what a fork changed: a tool’s result the next request carries, a flag, or nothing at all', () => {
    const fork = { test: false, updates: false, paths: [], path: '$.messages[2].content', at: 3, against: { runId: '01K5CQ4N7G'.padEnd(26, '0'), callNo: 3 } };
    const result = (policy: object) => ({ messages: [{ role: 'user', content: 'Refund order 1042' }, { role: 'assistant', content: 'lookup_policy' }, { role: 'user', content: JSON.stringify(policy) }] });
    const added = answer({ ...fork, was: result({ region: 'EU' }), now: result({ region: 'EU', refund_limit: 100 }), flag: '--override 2=@policy.json', tool: { callNo: 2, name: 'lookup_policy' } });
    expect(said(added)).toBe('One field added at $.messages[2].content: lookup_policy’s refund_limit now reaches the model. Not a date or an id, so no normalizer is suggested.');
    const changed = answer({ ...fork, was: result({ region: 'EU' }), now: result({ region: 'US' }), flag: '--override 2=@policy.json', tool: { callNo: 2, name: 'lookup_policy' } });
    expect(said(changed)).toBe('The result of #2 lookup_policy changed at $.messages[2].content (--override 2=@policy.json). Not a date or an id, so no normalizer is suggested.');
    const live = answer({ ...fork, type: 'forced', was: result({ hits: 1 }), now: result({ hits: 2 }), flag: '--live-tool search_web', tool: { callNo: 2, name: 'search_web' } });
    expect(said(live)).toBe('The result of #2 search_web came from --live-tool search_web. The next model call, #3, is the first request that changed.');
    const model = answer({ ...fork, type: 'request_changed', was: { model: 'claude-sonnet-4-5' }, now: { model: 'claude-haiku-4-5' }, flag: '--model 3:claude-haiku-4-5' });
    expect(said(model)).toBe('The request at #3 is the first that changed, by --model 3:claude-haiku-4-5.');
    const again = answer({ ...fork, type: 'forced', path: null, was: { model: 'a' }, now: { model: 'a' }, same: true, askedAgain: true, flag: '--diverge-at 3' });
    expect(said(again, [])).toBe('No request changed: --diverge-at 3 asked #3 again, live, as recorded.');
    // A tool asked again, live, whose result left the next request as recorded.
    const tool = { ...again, at: 3, flag: '--live-tool search_web', tool: { callNo: 2, name: 'search_web' } };
    expect(said(tool, [])).toBe('No request changed: --live-tool search_web asked #2 again, live, as recorded.');
    // A tool failed in its place (here retried before the next model call, #4): where its result came from, alone.
    expect(said({ ...tool, at: 4, askedAgain: false, flag: '--fail-at 2=500' }, [])).toBe('The result of #2 search_web came from --fail-at 2=500.');
    // The model switched in the URL path, as on Gemini and Bedrock: the body as recorded, the call not.
    const urlModel = { ...again, askedAgain: false, flag: '--model 3:gemini-2.5-flash' };
    expect(said(urlModel, [])).toBe('The request at #3 is the first that changed, by --model 3:gemini-2.5-flash.');
    // A tool's own result, where no request changed: the override that changed it, and where the next request changed.
    const own = answer({ ...fork, what: 'result', at: 906, call: { kind: 'tool', name: 'check_fraud' }, path: '$.messages[4].content', was: { result: {} }, now: { result: { fraud_hold: true } }, flag: '--override 906=@fraud.json', tool: { callNo: 906, name: 'check_fraud' }, next: 907 });
    expect(said(own)).toBe('The tool result at #906 was overridden (--override 906=@fraud.json). The next model call, #907, is the first request that changed, at $.messages[4].content.');
  });

  it('names both sides in its heads, the recording’s run by its id', () => {
    const d = answer({});
    const heads = renderToStaticMarkup(createElement(DiffHead, { diff: d }));
    expect(heads.replace(/<[^>]+>/g, '').replace(/\u00a0/g, ' ')).toBe('−Recorded request #3 · 01K5CQ4N7G+This run’s request #3');
    expect(heads).toContain('<code class="rnm">01K5CQ4N7G</code>');
    expect(heads).toContain('<span class="js del" aria-hidden="true">−</span>');
    expect(renderToStaticMarkup(createElement(DiffHead, { diff: { ...d, what: 'result', at: 906, against: null }, as: 'h3' }))).toMatch(/^<div class="jdh"><h3>.*Recorded result #906\u00a0· the recording<\/h3><h3>.*This run’s result #906<\/h3><\/div>$/);
  });
});

