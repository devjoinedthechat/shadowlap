import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { attemptOutcome, bannerFor, type BannerInput } from '../ui/run/banner.js';
import { ForksView } from '../ui/run/ForksView.js';
import { attemptLinks, attemptOf } from '../ui/run/model.js';
import { Banner, DiffPanel, type BannerProps } from '../ui/run/parts.js';
import { familyLine, runTag, type RunLike } from '../ui/runs.js';
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

  it('says what was asked again, which attempt it is, and how it came out', () => {
    const failed = { ...base, divergence: forcedAt5, intervention: diverge[0]!, interventions: diverge, attempt: probe, checks: [{ label: 'issue_refund with {"amount":240} called 0 times', ok: false, status: 'failed', detail: 'called 1 time' }] };
    expect(bannerFor(failed)).toEqual({ kind: 'attempt', of: 'probe', callNo: 5, why: 'resampled #5, attempt 1 of 4: the model was asked #5 again, the request as recorded · writes stubbed', flag: null, path: null, outcome: { tone: 'no', text: 'failed' }, diff: false });
    // The verdict blame kept on it is how it came out, whatever its checks say.
    expect(bannerFor({ ...failed, attempt: { ...probe, verdict: 'passed' } })).toMatchObject({ outcome: { tone: 'ok', text: 'passed' } });
    // A verify attempt forked where the change it verified is in the request; never by its --writes.
    const verify = { ...base, divergence: verifyFork, intervention: stub[0]!, interventions: stub, attempt: { kind: 'verify' as const, k: 1, n: 3, role: 'target', verdict: 'passed' as const } };
    expect(bannerFor(verify)).toEqual({ kind: 'attempt', of: 'verify', callNo: 1, why: 'verify\u00a0· target, attempt 1 of 3: the change it verified is in the request · writes stubbed', flag: null, path: '$.system', outcome: { tone: 'ok', text: 'passed' }, diff: true });
    expect(bannerFor({ ...verify, attempt: { ...verify.attempt, role: 'holdout' } })).toMatchObject({ why: 'verify\u00a0· held-out, attempt 1 of 3: the change it verified is in the request · writes stubbed' });
    // A change made with a flag (--model, --set) names itself.
    const model = { flag: '--model', value: '1:claude-opus-5', callNo: 1 };
    expect(bannerFor({ ...verify, intervention: model, interventions: [model, ...stub] })).toMatchObject({ why: 'verify\u00a0· target, attempt 1 of 3: claude-opus-5 answers from here with --model 1:claude-opus-5 · writes stubbed', flag: '--model 1:claude-opus-5' });
    // A --repeat's attempt: the replay made again, with the flag that made it.
    const live = { flag: '--live-tool', value: 'lookup_policy', callNo: null };
    const repeat = { ...base, divergence: { callNo: 16, type: 'forced', name: 'lookup_policy', replayedBefore: 15, reason: 'forced live by --live-tool lookup_policy' }, intervention: live, interventions: [live], attempt: { kind: 'repeat' as const, k: 1, n: 5 } };
    expect(bannerFor(repeat)).toMatchObject({ kind: 'attempt', why: 'replay --repeat 5, attempt 1 of 5: forced live with --live-tool lookup_policy', flag: '--live-tool lookup_policy', outcome: { tone: 'ok', text: 'passed' } });
    // An attempt that forked nowhere replayed every call from the recording, and says so.
    expect(bannerFor({ ...base, attempt: { kind: 'verify', k: 2, n: 3, role: 'good', verdict: 'passed' } })).toMatchObject({ kind: 'attempt', callNo: null, why: 'verify\u00a0· good, attempt 2 of 3: every call replayed from the recording', path: null, diff: false });
    // Never the failed banner's "not blamed yet": an attempt's failure counts towards what made it.
    expect(JSON.stringify(bannerFor({ ...failed, divergence: null }))).not.toContain('not blamed yet');
  });

  it('comes out as its checks and exit say when nothing kept a verdict on it: failed, inconclusive (amber) or interrupted (grey)', () => {
    expect(attemptOutcome({ status: 'completed', checks: [] })).toEqual({ tone: 'ok', text: 'passed' });
    expect(attemptOutcome({ status: 'failed', checks: [] })).toEqual({ tone: 'no', text: 'failed' });
    expect(attemptOutcome({ status: 'completed', checks: [{ label: 'send_email called 1 time', ok: false, status: 'failed' }] })).toEqual({ tone: 'no', text: 'failed' });
    expect(attemptOutcome({ status: 'completed', checks: [{ label: 'judge "polite" answers yes', ok: false, status: 'inconclusive' }] })).toEqual({ tone: 'inc', text: 'inconclusive: judge "polite" answers yes' });
    expect(attemptOutcome({ status: 'completed', checks: [{ label: 'judge "polite" answers yes', ok: false, status: 'inconclusive' }] }, { verdict: 'inconclusive' })).toEqual({ tone: 'inc', text: 'inconclusive: judge "polite" answers yes' });
    expect(attemptOutcome({ status: 'crashed', checks: [] })).toEqual({ tone: 'n', text: 'interrupted' });
    expect(attemptOutcome({ status: 'completed', checks: [], interrupted: true }, { verdict: 'failed' })).toEqual({ tone: 'n', text: 'interrupted' });
  });

  it('is read from the run’s record, with the verdict blame or verify kept on it', () => {
    expect(attemptOf({ meta: { probe: { of: REFUND, callNo: 5, passed: false, verdict: 'failed' }, repeat: { group: 'g-5', attempt: 2, of: 4 } } })).toEqual({ kind: 'probe', k: 2, n: 4, callNo: 5, verdict: 'failed' });
    // One kept before attempts had a verdict: whether it passed.
    expect(attemptOf({ meta: { probe: { of: REFUND, callNo: 5, passed: true }, repeat: { group: 'g-5', attempt: 3, of: 4 } } })).toMatchObject({ verdict: 'passed' });
    expect(attemptOf({ meta: { verify: { role: 'good', passed: false, verdict: 'inconclusive' }, repeat: { group: 'g', attempt: 1, of: 3 } } })).toEqual({ kind: 'verify', k: 1, n: 3, role: 'good', verdict: 'inconclusive' });
    expect(attemptOf({ meta: { repeat: { group: 'g', attempt: 3, of: 5 } } })).toEqual({ kind: 'repeat', k: 3, n: 5 });
    expect(attemptOf({ meta: { labels: ['x'] } })).toBeNull();
  });

  it('leads back to where it counted, and to its bundle', () => {
    const fix = { id: 'fx-1', status: 'verified', title: 'Refunds above the limit' };
    expect(attemptLinks({ run: { runId: 'A1' }, fix, probeOf: { of: REFUND, callNo: 5 } }, { kind: 'probe', k: 2, n: 4, callNo: 5 })).toEqual([
      { href: '#/fixes/fx-1/blame', label: 'Probe #5 →' },
      { href: '#/run/A1/forks', label: 'All 4 attempts →' },
    ]);
    // A probe no fix keeps leads to the run it probed.
    expect(attemptLinks({ run: { runId: 'A1' }, fix: null, probeOf: { of: REFUND, callNo: 5 } }, { kind: 'probe', k: 2, n: 4, callNo: 5 })[0]).toEqual({ href: `#/run/${REFUND}`, label: 'Probe #5 →' });
    expect(attemptLinks({ run: { runId: 'V1' }, fix, verifyOf: { href: '#/fixes/fx-1/verify/vf-2' } }, { kind: 'verify', k: 1, n: 3, role: 'target' })).toEqual([
      { href: '#/fixes/fx-1/verify/vf-2', label: 'Verdict →' },
      { href: '#/run/V1/forks', label: 'All 3 attempts →' },
    ]);
    // A candidate a repair tried and dropped was verified on its Repair step; with no fix, only the bundle.
    expect(attemptLinks({ run: { runId: 'V1' }, fix, verifyOf: { href: '#/fixes/fx-1/repair' } }, { kind: 'verify', k: 1, n: 3, role: 'target' })[0]).toEqual({ href: '#/fixes/fx-1/repair', label: 'Repair →' });
    expect(attemptLinks({ run: { runId: 'V1' }, fix: null, verifyOf: { href: `#/run/${REFUND}` } }, { kind: 'verify', k: 1, n: 3, role: 'target' })).toEqual([{ href: '#/run/V1/forks', label: 'All 3 attempts →' }]);
    expect(attemptLinks({ run: { runId: 'R1' }, fix: null }, { kind: 'repeat', k: 1, n: 5 })).toEqual([{ href: '#/run/R1/forks', label: 'All 5 attempts →' }]);
  });

  it('draws its outcome at the end of its line, in its colour, with its links and no Run blame', async () => {
    const run = detail({
      runId: '01M5GRW4YMYK6SK2VFC2XFKCDA',
      parent: REFUND,
      divergence: { callNo: 1, type: 'forced', kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, reason: 'forced live by --diverge-at 1' },
      meta: { probe: { of: REFUND, callNo: 1, passed: false, verdict: 'failed' }, repeat: { group: 'g-1', attempt: 1, of: 4 }, checks: [{ label: 'issue_refund with {"amount":240} called 0 times', ok: false, status: 'failed', detail: 'called 1 time' }] },
      interventions: [
        { flag: '--diverge-at', value: '1', callNo: 1 },
        { flag: '--writes', value: 'stub', callNo: null },
      ],
      state: { status: 'completed', kind: 'fork', outcome: { kind: 'check-failed', check: 'issue_refund with {"amount":240} called 0 times' }, failed: true, interrupted: false, label: 'fork @1' },
      fix: { id: 'fx-01M5GRW7X3', status: 'verified', title: 'Refund above the limit' },
      probeOf: { of: REFUND, callNo: 1 },
    });
    const offers = { blame: { from: 'run', failed: ['issue_refund with {"amount":240} called 0 times'] }, test: null } as unknown as RunOffers;
    page = await render(createElement(AppContext.Provider, { value: app() }, createElement(Banner, props(run, { offers }))));
    expect(page.one('.banner.fork .bk').textContent).toBe('forked at');
    // Each part held to the one before by a no-break space, the outcome too, so a wrapped line never starts with a dot.
    expect(page.one('.banner .why').textContent).toBe('resampled #1, attempt 1 of 4: the model was asked #1 again, the request as recorded\u00a0· writes stubbed\u00a0· failed');
    expect(page.one('.banner .why em').className).toBe('no');
    expect(page.all('.banner .end a').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Probe #1 →', '#/fixes/fx-01M5GRW7X3/blame'],
      ['All 4 attempts →', '#/run/01M5GRW4YMYK6SK2VFC2XFKCDA/forks'],
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
    expect(html).toContain('--path &#x27;$.metadata.user_id&#x27; --pattern uuid');
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
