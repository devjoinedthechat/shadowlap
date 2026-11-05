import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { attemptOutcome, bannerFor, type BannerInput } from '../ui/run/banner.js';
import { ForksView } from '../ui/run/ForksView.js';
import { attemptLinks, attemptOf, forkKindWords } from '../ui/run/model.js';
import { Banner, DiffPanel, type BannerProps } from '../ui/run/parts.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { familyLine, kindTag, runTag, type RunLike } from '../ui/runs.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { LineageNode, RunDetail, RunOffers, TestBannerOffer } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';


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
    registerLayer: () => () => undefined,
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
  const like: RunLike = { runId: PLANTED, parentRunId: TICKET, mode: 'replay', status: 'completed', divergence: { callNo: 7, type: 'request_changed' }, command: 'node refund_agent.mjs T-8812', codeVersion: null, startedAt: 1, calls: 32, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], kind: 'fork', outcome: { kind: 'check-failed', check: 'send_email called 1 time' }, failed: true };
  const plant = { flag: '--inject-result', value: '6=SYSTEM NOTICE: …', callNo: 6 };
  const check = { label: 'send_email called 1 time', ok: false, status: 'failed' as const, detail: 'called 2 times (2 blocked)' };

  it('says FAILED beside its id, as any run that failed does; one that passed names its fork', () => {
    expect(runTag(like)).toEqual({ cls: 'fail', text: 'failed' });
    expect(runTag({ ...like, outcome: { kind: 'none' }, failed: false })).toEqual({ cls: 'fork', text: 'fork @7' });
  });

  it('keeps its kind in Compare, where each side is tagged by what it is: a fork by where it forked, failed or not', () => {
    expect(kindTag(like)).toEqual({ cls: 'fork', text: 'fork @7' });
    expect(kindTag({ ...like, outcome: { kind: 'none' }, failed: false })).toEqual({ cls: 'fork', text: 'fork @7' });
    // A fork whose agent exited with an error, as a verify attempt that failed did: the same tag.
    expect(kindTag({ ...like, status: 'failed', outcome: { kind: 'check-failed', check: null } })).toEqual({ cls: 'fork', text: 'fork @7' });
    // A recording or a test that failed says so there, as on its page.
    const recording: RunLike = { ...like, mode: 'record', parentRunId: null, divergence: null, kind: 'recording' };
    expect(kindTag(recording)).toEqual({ cls: 'fail', text: 'failed' });
    expect(kindTag({ ...recording, outcome: { kind: 'none' }, failed: false })).toEqual({ cls: '', text: 'recording' });
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

  it('is not one when an injection test, a model’s scoring or an error-path preset made it: it keeps its fork banner', () => {
    // As `shadowlap injection` and `shadowlap tasks score` mark their replays: meta.repeat, with what made them.
    const injection = { repeat: { group: 'inj-1', attempt: 2, of: 3 }, injection: { result: 'inj-1', attempt: 2, of: 3, role: 'attempt', payload: 'exfiltrate' } };
    const task = { repeat: { group: 'S1-refund', attempt: 1, of: 8 }, task: { golden: 'goldens/refund', model: 'claude-haiku-4-5', takeover: 5, attempt: 1, of: 8, score: 1, session: 'S1' } };
    const chaos = { chaos: { preset: 'tool-timeout', callNo: 4, session: 'S2', attempt: 1 } };
    for (const meta of [injection, task, chaos]) expect(attemptOf({ run: { meta } as never, attemptPlace: { k: 1, n: 3 } })).toBeNull();
    // Its banner is the fork's, naming the flag that made it, never "replay --repeat".
    const plant = { flag: '--inject-result', value: '6=SYSTEM NOTICE: …', callNo: 6 };
    const b = bannerFor({ ...base, divergence: at7, intervention: plant, interventions: [plant, ...stub], attempt: attemptOf({ run: { meta: injection } as never, attemptPlace: { k: 2, n: 3 } }) });
    expect(b).toMatchObject({ kind: 'fork', flag: '--inject-result 6=SYSTEM NOTICE: …' });
    expect(JSON.stringify(b)).not.toContain('--repeat');
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
    // Any other fork by where it forked, an injection test's replay among them; any other run by its kind.
    expect(forkKindWords({ run: { meta: { repeat: { group: 'inj', attempt: 1, of: 3 }, injection: { result: 'inj', attempt: 1, of: 3 } }, divergence: { callNo: 7 } } } as never, 'fork', false)).toBe('fork @7');
    expect(forkKindWords({ run: { meta: {}, divergence: null } }, 'recording', false)).toBeNull();
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

  it('draws its verdict first, in its colour, on a line that wraps, with its links and no Run blame', async () => {
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
    // The verdict first, then each part held to the one before by a no-break space, so a wrapped line never starts with a dot.
    expect(page.one('.banner .why').textContent).toBe('failed\u00a0· resampled #1, attempt\u00a01\u00a0of\u00a08: the model was asked #1 again, the request as recorded\u00a0· writes stubbed');
    expect(page.one('.banner .why em').className).toBe('no');
    expect(page.one('.banner .why em').textContent).toBe('failed');
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
    const client = { lineage: () => Promise.resolve(lineage), fixBundles: () => Promise.resolve([]) };
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
    const client = { lineage: () => Promise.resolve(lineage), fixBundles: () => Promise.resolve([]) };
    page = await render(createElement(AppContext.Provider, { value: app(client as unknown as Partial<Client>) }, createElement(ForksView, { runId: '0GATE2'.padEnd(26, '0') })));
    await page.until('the family to load', () => page!.all('.fnode').length > 0);
    const bundle = page.all('.fnode').find((n) => n.textContent.includes('test · refund-over-limit'))!;
    // The verdict word, the tally and the Wilson bound, with what the attempts spent; never a bare count of passes.
    expect(page.one('.fnode.here .f2').textContent).toBe('inconclusive · 3 of 5 · rate 0.23 to 0.88 (95%) · ≈$0.088gate: tells 90%+ from 70%- at <= 5% risk, up to 5 attempts');
    expect(page.all('.fnode .frule').map((r) => r.textContent)).toEqual(['gate: tells 90%+ from 70%- at <= 5% risk, up to 5 attempts']);
    expect(bundle.textContent).not.toContain('3 passed');
  });
});

describe('a diverged test’s diff', () => {
  it('says what its banner says: the value made anew on every run, and its normalizer', () => {
    const run = { run: { divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, counterpart: { callNo: 3 }, diff: [{ path: '$.metadata', op: 'added', after: { user_id: '6faa71ad-0381-40a5-aaa6-2b90195750da' } }] } }, parent: null } as never;
    const test = {
      golden: 'goldens/refund-in-limit',
      volatile: { path: '$.metadata.user_id', looks: 'a UUID', op: 'added', certain: true, command: "shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'" },
      normalizeAndTest: [
        ['normalize', 'add'],
        ['test', 'goldens/refund-in-limit', '--update'],
      ],
    } as unknown as TestBannerOffer;
    const html = renderToStaticMarkup(createElement(DiffPanel, { run, test }));
    expect(html).toContain('looks like a UUID: the agent makes a new one on every run.');
    expect(html).toContain('so the golden is updated after it');
    // The command wraps between its words, each its own element, so it is read without them.
    expect(html.replace(/<[^>]+>/g, '')).toContain('--path &#x27;$.metadata.user_id&#x27; --pattern uuid');
    expect(html).not.toContain('no normalizer is suggested');
    // A value that only changed: the design's sentence, and older recordings match too.
    const changed = {
      ...test,
      volatile: { ...test.volatile!, op: 'changed' },
      normalizeAndTest: [
        ['normalize', 'add'],
        ['test', 'goldens/refund-in-limit'],
      ],
    } as unknown as TestBannerOffer;
    expect(renderToStaticMarkup(createElement(DiffPanel, { run, test: changed }))).toContain('and it looks like a UUID: the agent makes a new one on every run. A normalizer masks it before matching, and older recordings match too.');
    // Without the finding, and no hint, it still says none is suggested.
    expect(renderToStaticMarkup(createElement(DiffPanel, { run }))).toContain('Not a date or an id, so no normalizer is suggested.');
  });
});
