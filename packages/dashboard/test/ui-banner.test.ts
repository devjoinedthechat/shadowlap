import { describe, expect, it } from 'vitest';
import { receiptDuration } from '../ui/format.js';
import { countOrigins, type Origin7 } from '../ui/origins.js';
import { bannerFor, flagText, type BannerInput } from '../ui/run/banner.js';
import { metricItems, type MetricInput } from '../ui/run/metrics.js';
import { blameOf, checksOf } from '../ui/run/model.js';

// The run page's numbers and its one banner, from the run as the server sends it: today's fields, or
// the newer ones (blame counted in its scope, checks with their counts, what was not recorded).

describe('the run’s numbers', () => {
  const counts = (s: string) => countOrigins([...s].map((ch) => ({ r: 'rep', l: 'live', b: 'block', s: 'stub', i: 'inject', o: 'over', f: 'fail' })[ch] as Origin7));
  const input = (over: Partial<MetricInput> = {}): MetricInput => ({
    total: 30,
    byKind: { api: 15, tool: 15 },
    upstreamRequests: 15,
    cost: { spent: 0.042, saved: 0, captured: 0, unknownModels: [] },
    tokensNotRespent: 0,
    counts: counts('l'.repeat(30)),
    capture: false,
    live: false,
    notWaitedMs: null,
    ...over,
  });

  it('leads a recording with its counts, then upstream requests and what it spent', () => {
    expect(metricItems(input())).toEqual([
      [30, 'calls'],
      [15, 'model calls'],
      [15, 'tool calls'],
      [15, 'upstream requests'],
      ['≈$0.042', 'spent'],
    ]);
    expect(metricItems(input({ live: true, total: 9 }))[0]).toEqual([9, 'calls so far']);
    expect(metricItems(input({ capture: true, cost: { spent: 0, saved: 0, captured: 0.12, unknownModels: [] } })).at(-1)).toEqual(['$0.12', 'as captured']);
    expect(metricItems(input({ cost: { spent: 0, saved: 0, captured: 0, unknownModels: ['local-llama'] } })).at(-1)).toEqual(['—', 'spent · no price for local-llama']);
  });

  it('ends a fork on what replaying saved, as a quiet receipt, with short times that never read 0s', () => {
    const items = metricItems(input({ counts: counts(`${'r'.repeat(16)}${'l'.repeat(13)}b`), upstreamRequests: 7, cost: { spent: 0.03, saved: 0.021, captured: 0, unknownModels: [] }, tokensNotRespent: 41_200, notWaitedMs: 340 }));
    expect(items).toEqual([
      [30, 'calls'],
      [16, 'replayed', 'lime'],
      [13, 'live'],
      [1, 'blocked'],
      [7, 'upstream requests'],
      ['≈$0.030', 'spent'],
      ['$0.021', 'not re-spent · 41.2k tokens', 'q'],
      ['340 ms', 'not waited', 'q'],
    ]);
    expect(receiptDuration(2_900)).toBe('2.9 s');
    expect(receiptDuration(28 * 60_000)).toBe('28m');
    expect(receiptDuration(65 * 60_000)).toBe('1h 5m');
  });
});

describe('the run’s banner', () => {
  const base: BannerInput = { status: 'completed', type: 'recording', divergence: null, intervention: null, rescued: null, blame: null, notRecorded: null, checks: [], fix: null, upstreamRequests: 15 };
  const fork = { callNo: 17, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 16, diff: [{ path: '$.messages[16].content' }] };

  it('says a run is recording before anything else', () => {
    expect(bannerFor({ ...base, status: 'running', divergence: fork, blame: { callNo: 3 } })).toEqual({ kind: 'recording' });
  });

  it('names the flag that made a fork, or what changed, with the calls replayed before it', () => {
    expect(bannerFor({ ...base, type: 'fork', divergence: fork })).toEqual({ kind: 'fork', callNo: 17, name: 'POST /v1/messages', why: 'a request changed · 16 calls replayed before it', path: '$.messages[16].content', normalizer: false, diff: true });
    expect(bannerFor({ ...base, type: 'fork', divergence: { ...fork, callNo: 19, replayedBefore: 18 }, intervention: { flag: '--fail-at', value: '19=529' } })).toMatchObject({ kind: 'fork', why: '--fail-at 19=529 · a request changed · 18 calls replayed before it' });
    expect(bannerFor({ ...base, type: 'fork', divergence: { ...fork, type: 'forced', reason: 'forced live by --diverge-at 17', replayedBefore: 1, diff: [] } })).toMatchObject({ why: '--diverge-at 17 · 1 call replayed before it', diff: false });
    expect(flagText({ flag: '--prompt-from', value: null })).toBe('--prompt-from');
  });

  it('puts a rescued fork before its fork banner, and a diverged test before both kinds of fork', () => {
    expect(bannerFor({ ...base, type: 'fork', divergence: fork, rescued: { callNo: 5 } })).toEqual({ kind: 'rescued', callNo: 5, why: 'a blame attempt that passed: the model was asked #5 again · writes stubbed' });
    expect(bannerFor({ ...base, type: 'fork', divergence: fork, rescued: { callNo: null } })).toMatchObject({ kind: 'rescued', callNo: null, why: 'a blame attempt that passed: the model was asked the call again · writes stubbed' });
    expect(bannerFor({ ...base, type: 'test', divergence: { ...fork, callNo: 1, replayedBefore: 0, hints: [{ message: 'this looks like a per-run id', normalizer: {} }] } })).toMatchObject({ kind: 'diverged', callNo: 1, why: '0 calls replayed before it · this looks like a per-run id', normalizer: true });
  });

  it('says where blame lost a run, as model call k of m in its scope', () => {
    expect(bannerFor({ ...base, status: 'failed', blame: { callNo: 17, modelCall: { k: 9, m: 15 }, confidence: 'high', rescuedRunId: '01K5CQ4R1T', scope: null } })).toEqual({ kind: 'lost', callNo: 17, why: 'model call 9 of 15 · confidence high', rescuedRunId: '01K5CQ4R1T' });
    expect(bannerFor({ ...base, blame: { callNo: 4, scope: 'agent' } })).toMatchObject({ why: 'call #4 · scope agent' });
    // What asking again did ends the line, as the fixes read model words it.
    expect(bannerFor({ ...base, status: 'failed', blame: { callNo: 9, modelCall: { k: 3, m: 7 }, confidence: 'high', short: 'asked again, it calls escalate instead' } })).toMatchObject({ kind: 'lost', why: 'model call 3 of 7 · confidence high · asked again, it calls escalate instead' });
  });

  it('says what was not recorded: tools that weren’t wrapped, and hosts reached around Shadowlap', () => {
    expect(bannerFor({ ...base, notRecorded: { tools: ['send_sms', 'charge_card'], hosts: [] } })).toEqual({ kind: 'not-recorded', why: '2 tools weren’t wrapped, so their calls aren’t in this recording: send_sms, charge_card. A replay would run them for real.' });
    expect(bannerFor({ ...base, notRecorded: { tools: [], hosts: [{ target: 'api.stripe.com:443', count: 3, action: 'blocked' }] } })).toMatchObject({ why: '1 host was reached without Shadowlap: api.stripe.com:443 (3×, blocked). A replay would reach it for real.' });
  });

  it('lists the checks a run passed with their counts, offline for a test', () => {
    expect(bannerFor({ ...base, type: 'test', upstreamRequests: 0, checks: [{ label: 'issue_refund never called', ok: true, count: 5, of: 5 }, { label: 'exits 0', ok: true }] })).toEqual({
      kind: 'checks',
      checks: [
        { label: 'issue_refund never called', text: 'issue_refund never called · 5 of 5' },
        { label: 'exits 0', text: 'exits 0' },
      ],
      why: 'replayed offline · 0 upstream',
    });
  });

  it('says a run failed: with its fix, not blamed yet, or blamed without a call to name', () => {
    expect(bannerFor({ ...base, checks: [{ label: 'send_email called once', ok: false }] })).toEqual({ kind: 'failed', why: 'check failed: send_email called once · not blamed yet', fix: null, blamed: false });
    const fix = { id: 'fx-2', status: 'open', title: 'Confirmation email sent twice' };
    expect(bannerFor({ ...base, status: 'failed', fix })).toMatchObject({ why: 'the agent exited with an error · no fix yet for “Confirmation email sent twice”', fix });
    expect(bannerFor({ ...base, status: 'failed', fix: { ...fix, status: 'verified' } })).toMatchObject({ why: 'the agent exited with an error · fixed: “Confirmation email sent twice”, verified' });
    expect(bannerFor({ ...base, status: 'crashed', blame: { callNo: null, outcome: 'unrescuable' } })).toEqual({ kind: 'failed', why: 'the run was interrupted · blame found no call whose answer, asked again, saves the run', fix: null, blamed: true });
    expect(bannerFor({ ...base, blame: { callNo: null, outcome: 'stopped' } })).toMatchObject({ why: 'blame confirmed it fails · blame stopped before it found the call', blamed: true });
  });

  it('shows nothing for a run with nothing to say', () => {
    expect(bannerFor(base)).toBeNull();
    expect(bannerFor({ ...base, type: 'clean', checks: [{ label: 'exits 0', ok: true }], status: 'crashed' })).toMatchObject({ kind: 'failed' });
  });
});

describe('blame and checks on a run', () => {
  const calls = [
    { callNo: 1, kind: 'api', scope: 'agent' },
    { callNo: 2, kind: 'tool', scope: 'agent' },
    { callNo: 3, kind: 'api', scope: 'customer' },
    { callNo: 4, kind: 'api', scope: 'agent' },
  ];
  const run = (meta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ run: { meta }, calls, ...extra }) as never;

  it('reads the stored blame, counting the call among the model calls of its scope', () => {
    expect(blameOf(run({ blame: { outcome: 'blamed', callNo: 4, confidence: 'high', rescuedRunId: '01R', scope: 'agent' } }))).toEqual({ callNo: 4, confidence: 'high', rescuedRunId: '01R', scope: 'agent', outcome: 'blamed', modelCall: { k: 2, m: 2 } });
    expect(blameOf(run({ blame: { outcome: 'blamed', callNo: 3, confidence: 'low', rescuedRunId: null } }))?.modelCall).toEqual({ k: 2, m: 3 });
  });

  it('keeps a blame that placed the failure nowhere, prefers the server’s, and is null for a run never blamed', () => {
    expect(blameOf(run({ blame: { outcome: 'unrescuable', callNo: null, confidence: 'low', rescuedRunId: null } }))).toMatchObject({ callNo: null, outcome: 'unrescuable' });
    expect(blameOf(run({}, { blame: { callNo: 1, modelCall: { k: 1, m: 9 } } }))).toEqual({ callNo: 1, modelCall: { k: 1, m: 9 } });
    expect(blameOf(run({}))).toBeNull();
  });

  it('takes the server’s checks with their counts, else the stored ones', () => {
    expect(checksOf(run({ checks: [{ label: 'exits 0', ok: true, detail: null }] }))).toEqual([{ label: 'exits 0', ok: true }]);
    expect(checksOf(run({ checks: [{ label: 'exits 0', ok: true }] }, { checks: [{ label: 'exits 0', ok: true, count: 4, of: 5 }] }))).toEqual([{ label: 'exits 0', ok: true, count: 4, of: 5 }]);
  });
});
