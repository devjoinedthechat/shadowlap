import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLAME_DEFAULTS, decideVerify, findPairs, fixRecords, gateResult, markFixApplied, recordBlame, recordRepair, recordVerdict, Store, type BlameReport, type Block, type SprtGate } from '@shadowlap/engine';
import { AFTER, BEFORE, blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { DONE, ESCALATE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { runDetail } from '../src/api.js';
import { fixBundles, fixDetail, fixesSummary, fixForRun, fixList, needsLookFixes, repairArgv } from '../src/fixes.js';

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const EXIT_ORACLE = ['the agent exits 0'];

function blame(runId: string, o: { outcome?: BlameReport['outcome']; at?: number; expect?: unknown; title?: string; scope?: string } = {}) {
  return recordBlame(store, {
    runId,
    report: blameReport(runId, o.outcome),
    expect: o.expect === undefined ? EXPECT : o.expect,
    scope: o.scope ?? null,
    command: `shadowlap blame ${runId.slice(0, 10)} --expect '${JSON.stringify(EXPECT)}'`,
    title: o.title ?? 'issue_refund called with amount 240',
    checkText: 'issue_refund never called with {"amount":240}',
    at: o.at ?? NOW - DAY,
  });
}

/** The refund story: a failing run blamed, a held-out run and a good one, a rejected verify, then an accepted repair. */
function story() {
  const failing = makeRun(store, { labels: ['refund-bug'], calls: ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] });
  const held = makeRun(store, { labels: ['refund-bug'] });
  const good = makeRun(store, { labels: ['good'], status: 'completed' });
  const { fix } = blame(failing, { at: NOW - 2 * DAY });
  recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: true }, { runId: held, role: 'holdout', pass: true }, { runId: good, role: 'good', pass: false }]), expect: EXPECT, command: 'shadowlap verify --fixes 01M3RXQ4VB', at: NOW - 2 * DAY + 1 });
  recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [failing], holdout: [held], good: [good] }), expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug --keeps label:good', at: NOW - DAY });
  return { failing, held, good, fixId: fix.fixId };
}

describe('the Fixes list', () => {
  it('shows each failure with its status, label, failing runs, check and how far each step got', () => {
    const { fixId } = story();
    const open = makeRun(store, { labels: ['double-email'] });
    const { fix: openFix } = blame(open, { expect: { tools: { send_email: 1 } }, title: 'send_email called twice, not once', at: NOW });

    const list = fixList(store);
    expect(list.counts).toEqual({ all: 2, open: 1, verified: 1 });
    expect(list.fixes.map((f) => f.fixId)).toEqual([openFix.fixId, fixId]);
    expect(list.fixes[0]).toMatchObject({ status: 'open', title: 'send_email called twice, not once', label: 'double-email', labels: ['double-email'], failing: 1, good: 0, href: `#/fixes/${openFix.fixId}`, broken: null });
    expect(list.fixes[0]!.steps.map((s) => [s.state, s.short])).toEqual([
      ['done', 'lost at #5'],
      ['todo', 'no fix yet'],
      ['todo', 'not verified'],
    ]);
    expect(list.fixes[1]).toMatchObject({ status: 'verified', label: 'refund-bug', failing: 2, good: 1, check: 'issue_refund never called with {"amount":240}', verifiedAt: NOW - DAY });
    expect(list.fixes[1]!.steps.map((s) => [s.state, s.short])).toEqual([
      ['done', 'lost at #5'],
      ['done', 'prompt fix'],
      ['done', '3 of 3 held'],
    ]);
    expect(list.fixes[1]!.attempts).toBeGreaterThan(0);
    expect(fixList(store, { status: 'open' }).fixes.map((f) => f.fixId)).toEqual([openFix.fixId]);
    expect(fixList(store, { status: 'verified' }).fixes.map((f) => f.fixId)).toEqual([fixId]);
  });

  it('says how far a blame got that rescued nothing or stopped, and a verify that only rejected', () => {
    const a = makeRun(store, { labels: ['a'] });
    const b = makeRun(store, { labels: ['b'] });
    blame(a, { outcome: 'unrescuable' });
    const stopped = blame(b, { outcome: 'stopped', at: NOW });
    recordVerdict(store, { report: verifyReport([{ runId: b, role: 'target', pass: false }]), expect: EXPECT, command: 'v' });
    const [x, y] = fixList(store).fixes;
    expect(x!.fixId).toBe(stopped.fix.fixId);
    expect(x!.steps.map((s) => [s.state, s.short, s.title])).toEqual([
      ['todo', 'blame stopped', 'Stopped before the search finished'],
      ['todo', 'no fix yet', 'No fix yet'],
      ['no', 'rejected', 'Rejected'],
    ]);
    expect(x!.steps[0]!.meta).toBe('the budget of $0.05 is spent');
    // It ran to the end, but no model call rescued the run: no call is blamed yet, so it is still to do.
    expect(y!.steps[0]).toMatchObject({ state: 'todo', short: 'not rescued', title: 'Not rescued from any model call' });
    expect(fixDetail(store, y!.fixId)!.defaultStep).toBe('blame');
    expect(fixDetail(store, y!.fixId)!.blame).toMatchObject({ boundary: 'Resampling from the first model call, #1, passed 1 of 4 attempts, fewer than the 2 a rescue needs.', look: null });
  });

  it('says what asking the blamed call again did only as far as it differs, and why a blame blamed no call', () => {
    const keep = (report: BlameReport, labels: string[]) => {
      const runId = makeRun(store, { labels });
      return recordBlame(store, { runId, report: { ...report, runId }, expect: null, scope: null, command: 'shadowlap blame x', title: 'The agent exited with code 1', checkText: 'the agent exits 0', at: NOW });
    };
    const post = (text: string) => [{ type: 'tool_call' as const, name: 'post_digest', input: { channel: '#refunds', text } }];
    const said = (text: string) => [{ type: 'text' as const, text }];
    const asked = (recorded: Block[], rescued: Block[], label: string) => {
      const base = blameReport('X');
      const { blame } = keep({ ...base, contrast: { callNo: 5, recorded, rescued, rescuedRunId: base.blamed!.attempts[0]!.runId } }, [label]);
      return fixForRun(store, blame.runId)!.blame!.short;
    };
    expect(asked(post('3 refunds this week.'), post('Three refunds this week.'), 'a')).toBe('asked again, it calls post_digest with other arguments');
    expect(asked(post('3 refunds this week.'), [...said('Checking the channel first.'), { type: 'tool_call', name: 'list_channels', input: {} }], 'b')).toBe('asked again, it calls list_channels instead');
    expect(asked(post('3 refunds this week.'), said('#refunds is not a channel I can post to.'), 'c')).toBe('asked again, it answers without a tool call');
    expect(asked(said('Done.'), said('I could not post it.'), 'd')).toBe('asked again, it answers differently');
    expect(asked([...said('Posting.'), ...post('3 refunds this week.')], [...said('Posting the digest now.'), ...post('3 refunds this week.')], 'g')).toBe('asked again, it answers differently');
    const both = (a: string, b: string): Block[] => [{ type: 'tool_call', name: a, input: {} }, { type: 'tool_call', name: b, input: {} }];
    expect(asked(both('lookup_order', 'read_policy'), both('read_policy', 'lookup_order'), 'h')).toBe('asked again, it answers differently');

    // The attempts that passed answered as the recording did, or every attempt met a write's recorded error.
    const why = "Every attempt that passed at #7 answered it as the recording did. They passed because post_digest was stubbed after the fork, and the recording failed on post_digest's error: channel_not_found: #refunds.";
    const same = keep({ ...blameReport('X', 'unrescuable'), sameAnswer: { callNo: 7, runId: 'R', why } }, ['e']);
    expect(fixDetail(store, same.fix.fixId)!.blame).toMatchObject({ outcome: 'unrescuable', lostAt: null, boundary: why, look: "No answer of the model's lost this run: look at the tools, the harness or the command." });
    expect(fixForRun(store, same.blame.runId)!.blame!.short).toBe('not rescued from any model call');
    const met = keep({ ...blameReport('X', 'unrescuable'), failedWrite: { name: 'post_digest', message: 'channel_not_found: #refunds', callNo: 1 } }, ['f']);
    expect(fixDetail(store, met.fix.fixId)!.blame).toMatchObject({ boundary: "Every attempt from the first model call, #1, made post_digest's recorded call again and failed on its error, as the recording did: channel_not_found: #refunds.", look: "No answer of the model's lost this run: look at the tools, the harness or the command." });
  });

  it('reads a blame whose first probe could not tell apart, and one whose gate it can\'t read without breaking the page', () => {
    const gate: SprtGate = { kind: 'sprt', ...BLAME_DEFAULTS };
    const runId = makeRun(store, { labels: ['flaky'], calls: ['api', 'tool', 'api'] });
    // Seven passes in twenty from the first model call: between 10% and 60%, so not settled.
    const outcomes = [...Array(6).fill([true, false, false]).flat(), true, false] as boolean[];
    const base = blameReport(runId, 'unrescuable');
    const first = { ...base.probes[0]!, passes: 7, rescued: false, decision: 'inconclusive' as const, gate: gateResult(gate, outcomes), attempts: outcomes.map((passed, i) => ({ ...base.probes[0]!.attempts[0]!, runId: `${runId.slice(0, 20)}${String(i).padStart(6, '0')}`, passed })) };
    const unsettled = recordBlame(store, { runId, report: { ...base, gate, confidence: 'low', probes: [first], lost: first }, expect: EXPECT, scope: null, command: 'shadowlap blame x', title: 'Flaky refunds', checkText: 'x', at: NOW });
    const b = fixDetail(store, unsettled.fix.fixId)!.blame!;
    expect(b).toMatchObject({ title: 'Not settled from the first model call', confidence: 'low', confidenceWhy: '#1 was inconclusive: whether resampling rescues the run is not settled', boundary: 'Resampled from the first model call, #1: inconclusive · 7 of 20 · rate 0.18 to 0.57 (95%).', rule: 'gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts' });
    expect(b.look).toContain('Not settled: resampled from #1');
    expect(b.probes[0]).toMatchObject({ verdict: 'inconclusive', bound: 'rate 0.18 to 0.57 (95%)' });
    expect(b.callRow.find((c) => c.callNo === 1)).toMatchObject({ verdict: 'inconclusive' });

    // A report a store holds with its gate malformed reads as a fixed count's, and a run's rate as none.
    const odd = makeRun(store, { labels: ['odd'] });
    const report = { ...blameReport(odd), gate: { kind: 'sprt', good: 'most' } } as unknown as BlameReport;
    const kept = recordBlame(store, { runId: odd, report: { ...report, probes: report.probes.map((p) => ({ ...p, gate: {} as never })) }, expect: EXPECT, scope: null, command: 'c', title: 'Odd', checkText: 'x', at: NOW });
    const detail = fixDetail(store, kept.fix.fixId)!;
    expect(detail.blame).toMatchObject({ rule: 'a rescue needs 2 of 5 attempts to pass' });
    expect(JSON.stringify(detail)).not.toContain('NaN');
    const v = verifyReport([{ runId: odd, role: 'target', pass: true }]);
    recordVerdict(store, { report: { ...v, gate: { kind: 'sprt' } as never, runs: v.runs.map((x) => ({ ...x, gate: { decision: 'pass', interval: null } as never })) }, expect: EXPECT, command: `shadowlap verify --fixes ${odd}`, at: NOW + 1 });
    const verified = fixDetail(store, kept.fix.fixId)!;
    expect(verified.verify[0]!.rows[0]).toMatchObject({ rate: null });
    expect(verified.verify[0]!.oracle).toContain('a run passes when 4 of 5 attempts meet the check');
  });

  it('says where a fix came from', () => {
    const a = makeRun(store, { labels: ['refund-bug'] });
    recordBlame(store, { runId: a, report: blameReport(a), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x', ci: 'github' });
    recordRepair(store, { repairId: 'repair-ci', dir: '.shadowlap/repairs/repair-ci', report: repairReport({ targets: [a], pr: 'https://github.com/example/agent/pull/138' }), expect: EXPECT, command: 'r' });
    expect(fixList(store).fixes[0]!.source).toBe('from CI · PR #138');
    // Opened here, its merge request opened by a repair; once known to be merged, it says so.
    const b = makeRun(store, { labels: ['double-email'] });
    const { fix } = blame(b, { expect: { tools: { send_email: 1 } } });
    recordRepair(store, { repairId: 'repair-mr', dir: '.shadowlap/repairs/repair-mr', report: repairReport({ targets: [b], pr: 'https://gitlab.com/example/agent/-/merge_requests/42' }), expect: { tools: { send_email: 1 } }, command: 'r' });
    expect(fixDetail(store, fix.fixId)!.source).toBe('PR #42');
    store.mergeFixData(fix.fixId, { source: { pr: { state: 'merged' } } });
    expect(fixDetail(store, fix.fixId)!.source).toBe('PR #42 merged');
  });
});

describe('a fix', () => {
  it('opens on its last finished step, with its runs, actions and commands', () => {
    const { failing, held, good, fixId } = story();
    const d = fixDetail(store, fixId.slice(0, 10).toLowerCase())!;
    expect(d).toMatchObject({ fixId, status: 'verified', defaultStep: 'verify', expect: EXPECT, failing: 2, good: 1 });
    expect(d.failingRuns.map((r) => [r.runId, r.exists, r.href])).toEqual([
      [failing, true, `#/run/${failing}`],
      [held, true, `#/run/${held}`],
    ]);
    expect(d.goodRuns.map((r) => r.runId)).toEqual([good]);
    expect(d.steps[1]).toMatchObject({ title: 'Escalate refunds above the policy limit', meta: 'candidate 3 of 3 · proposed by claude-code' });
    expect(d.steps[2]).toMatchObject({ title: '3 of 3 runs held', meta: '1 earlier change rejected' });
    const diff = store.getRepair('repair-munzln2i')!.report.patch;
    expect(diff).toContain('diff --git a/agent.mjs b/agent.mjs');
    expect(d.actions).toEqual({ repair: null, apply: { kind: 'patch', argv: ['fix', 'apply', fixId], gitApply: 'git -c core.autocrlf=false apply .shadowlap/repairs/repair-munzln2i/fix.patch', pending: null, pulled: false, files: ['agent.mjs'], diff, refused: null }, applied: false });
    expect(d.commands.blame).toBe(`shadowlap blame ${failing.slice(0, 10)} --expect '${JSON.stringify(EXPECT)}'`);
    expect(d.commands.repair).toBe(`shadowlap repair --fixes label:refund-bug --keeps label:good --expect '${JSON.stringify(EXPECT)}' --repairer claude-code`);
    expect(fixDetail(store, 'fx-NOPE')).toBeNull();
    expect(fixDetail(store, 'fx-')).toBeNull();
  });

  it('shows the Blame step: the lost call, the boundary, both answers, probes, attempts per probe and cost', () => {
    const { failing, fixId } = story();
    const b = fixDetail(store, fixId)!.blame!;
    expect(b).toMatchObject({ runId: failing, runExists: true, outcome: 'blamed', title: 'Lost at model call #5', lostAt: 5, step: 3, steps: 4, confidence: 'high', confidenceWhy: 'rescue stops cleanly at the boundary', needed: 2, attemptsPerProbe: 5, rescue: 'resample the probed call', pairs: 0 });
    expect(b.boundary).toBe('Resampling #5 rescued 2 of 4 attempts; resampling #7, the next model call, rescued 0 of 4.');
    expect(b.next).toEqual({ callNo: 7, step: 4, passes: 0, attempts: 4 });
    expect(b.answers).toEqual({ callNo: 5, recorded: 'issue_refund({"order_id":"A-1042","amount":240})', rescued: '"Above the limit.", escalate({"reason":"refund of $240 is above $100"})' });
    expect(b.hrefs).toEqual({ run: `#/run/${failing}`, lostAt: `#/run/${failing}/5`, rescued: `#/run/${b.rescuedRunId}` });
    expect(b.probes.map((p) => [p.callNo, p.verdict, `${p.passes} of ${p.attempts}`])).toEqual([
      [1, 'rescued', '2 of 3'],
      [5, 'rescued · blamed', '2 of 4'],
      [7, 'lost', '0 of 4'],
    ]);
    expect(b.bundles[1]).toMatchObject({ title: 'blame · probe #5', blamed: true, passes: 2 });
    // The rescued fork says what asking again did.
    expect(b.bundles[1]!.attempts.map((a) => a.note)).toEqual(['passed · called escalate', 'issue_refund called', 'passed', 'issue_refund called']);
    expect(b.callRow.map((c) => [c.callNo, c.kind, c.verdict, c.inScope])).toEqual([
      [1, 'api', 'rescued', true],
      [2, 'tool', null, true],
      [3, 'api', null, true],
      [4, 'tool', null, true],
      [5, 'api', 'blamed', true],
      [6, 'tool', null, true],
      [7, 'api', 'lost', true],
    ]);
    expect(b.cost).toEqual({ attempts: 11, upstreamRequests: 22, spent: expect.closeTo(0.11, 10), unknownModels: [] });
  });

  it('shows a probe that an attempt it could not judge stopped as inconclusive, never lost, and marks that attempt apart', () => {
    const failing = makeRun(store, { labels: ['refund-bug'], calls: ['api', 'tool', 'api'] });
    const why = 'judge "issued" answers yes, but it is inconclusive: not judged: the judge\'s call failed: HTTP 400';
    const report = blameReport(failing, 'unrescuable');
    const [first] = report.probes;
    const attempt = { ...first!.attempts[0]!, passed: false, verdict: 'inconclusive' as const, failures: [why] };
    report.probes = [{ ...first!, attempts: [attempt], passes: 0, rescued: false, decision: 'inconclusive', undecided: why }];
    report.lost = report.probes[0]!;
    report.confidence = 'low';
    const { fix } = recordBlame(store, { runId: failing, report, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: NOW });
    const b = fixDetail(store, fix.fixId)!.blame!;
    expect(b).toMatchObject({ title: 'Not settled from the first model call', boundary: `Resampled from the first model call, #1: an attempt could not be judged: ${why}.` });
    expect(b.look).toContain('Not settled: a check could not be decided on an attempt');
    expect(b.probes).toEqual([expect.objectContaining({ callNo: 1, verdict: 'inconclusive', passes: 0, attempts: 1, inconclusive: 1, bound: null })]);
    expect(b.callRow[0]).toMatchObject({ callNo: 1, verdict: 'inconclusive', passes: 0, attempts: 1, inconclusive: 1 });
    expect(b.bundles[0]!.attempts).toEqual([expect.objectContaining({ passed: false, verdict: 'inconclusive', note: 'inconclusive: judge "issued" answers yes' })]);
    // Wherever the blame is summed up, it is not settled, never "not rescued".
    expect(fixList(store).fixes[0]!.steps[0]).toMatchObject({ state: 'todo', short: 'not settled', title: 'Not settled from the first model call' });
    expect(needsLookFixes(store).find((x) => x.fixId === fix.fixId)?.detail).toBe('not settled from the first model call · no fix yet');
    expect(fixForRun(store, failing)?.blame).toMatchObject({ outcome: 'unrescuable', unsettled: true, short: 'not settled from the first model call' });
    expect(fixDetail(store, fix.fixId)!.blames).toEqual([expect.objectContaining({ outcome: 'unrescuable', unsettled: true })]);
  });

  it('still says a blame whose first probe lost the run was not rescued from any model call', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = blame(failing, { outcome: 'unrescuable' });
    expect(fixList(store).fixes[0]!.steps[0]).toMatchObject({ short: 'not rescued', title: 'Not rescued from any model call' });
    expect(needsLookFixes(store).find((x) => x.fixId === fix.fixId)?.detail).toBe('not rescued from any model call · no fix yet');
    expect(fixForRun(store, failing)?.blame).toMatchObject({ outcome: 'unrescuable', short: 'not rescued from any model call' });
    expect(fixForRun(store, failing)?.blame).not.toHaveProperty('unsettled');
  });

  it('says a blame that stopped reached an inconclusive probe, never that the run was lost there', () => {
    const failing = makeRun(store, { labels: ['refund-bug'], calls: ['api', 'tool', 'api', 'tool', 'api'] });
    const report = blameReport(failing, 'stopped');
    const [rescued] = report.probes;
    const unsure = { ...rescued!, callNo: 5, step: 3, passes: 1, rescued: false, decision: 'inconclusive' as const };
    report.probes = [rescued!, unsure];
    report.lost = unsure;
    const { fix } = recordBlame(store, { runId: failing, report, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: NOW });
    const b = fixDetail(store, fix.fixId)!.blame!;
    expect(b.boundary).toBe('Stopped: the budget of $0.05 is spent. So far: rescued up to #1, inconclusive at #5.');
    expect(b.probes.map((x) => [x.callNo, x.verdict])).toEqual([
      [1, 'rescued · blamed'],
      [5, 'inconclusive'],
    ]);
  });

  it("dims the calls outside a blame's scope, tool calls included, and keeps those in it", () => {
    const run = makeRun(store, { calls: [{ kind: 'api', scope: 'agent' }, { kind: 'tool', scope: 'agent' }, { kind: 'api', scope: 'customer' }, { kind: 'tool', scope: 'agent/refunds' }, { kind: 'api', scope: 'agent' }] });
    const { fix } = blame(run, { scope: 'agent' });
    expect(fixDetail(store, fix.fixId)!.blame!.callRow.map((c) => [c.callNo, c.kind, c.inScope])).toEqual([
      [1, 'api', true],
      [2, 'tool', true],
      [3, 'api', false],
      [4, 'tool', true],
      [5, 'api', true],
    ]);
  });

  it('shows the Repair step: the change and what was added, the result per role, why, candidates, files and the pull request body', () => {
    const { failing, fixId } = story();
    const r = fixDetail(store, fixId)!.repair!;
    expect(r).toMatchObject({ repairId: 'repair-munzln2i', accepted: true, title: 'Escalate refunds above the policy limit', repairer: 'claude-code', served: 'claude-opus-5-5', dir: '.shadowlap/repairs/repair-munzln2i', needed: 4, attemptsPerRun: 5 });
    expect(r.change).toEqual({ file: 'agent.mjs', anchor: 'system prompt', before: BEFORE, after: AFTER, added: { at: BEFORE.length - 1, text: ': escalate every refund above the limit it sets' }, removed: '' });
    expect(r.roles).toEqual([
      { role: 'target', held: 1, of: 1 },
      { role: 'held-out', held: 1, of: 1 },
      { role: 'good', held: 1, of: 1 },
    ]);
    expect(r.lost).toEqual([{ runId: failing, at: 'model call #5 (3 of 4)', href: `#/fixes/${fixId}/blame` }]);
    expect(r.candidates.map((c) => [c.id, c.verdict, c.why])).toEqual([
      [1, 'set aside', 'it mentions A-1042, which only the failing runs contain: a fix has to hold for cases it has not seen'],
      [2, 'rejected', 'target run 01M3RZ4XKN not fixed: 0 of 2 passed'],
      [3, 'accepted', 'the smallest rewrite the gate accepts'],
    ]);
    expect(r.files).toEqual([
      { name: 'fix.patch', note: '1 file · +1 −1' },
      { name: 'report.md', note: 'the pull request body' },
      { name: 'report.json', note: 'for agents and CI' },
      { name: 'goldens/', note: '1 recording made by the fixed code' },
    ]);
    expect(r.prBody).toContain('## Escalate refunds above the policy limit');
    expect(r.verify).toMatchObject({ verifyId: expect.stringMatching(/^vf-/), counts: true });
  });

  it('says why no repairer proposed candidates, in the step and its header, and that none was needed only for a fix that needed none', () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = blame(run);
    const keep = (repairId: string, report: ReturnType<typeof repairReport>, at: number) => recordRepair(store, { repairId, dir: `.shadowlap/repairs/${repairId}`, report, expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug --repairer claude-code', at });
    const nothing = (o: Partial<ReturnType<typeof repairReport>>) => ({ ...repairReport({ targets: [run], accepted: false }), repairer: null, candidates: [], diagnosis: null, cost: { blame: 0.1, repairer: null, verify: 0 }, ...o });
    const warning = 'the repairer could not be asked: claude was not found: install Claude Code, or set SHADOWLAP_CLAUDE to its path';

    // claude wasn't found: the step says so, never "no repairer needed", and its header has the warning that says what to do.
    keep('repair-claudegone', nothing({ why: 'the repairer could not be asked: claude was not found', noRepairer: 'the repairer could not be asked: claude was not found', warnings: [warning] }), NOW);
    let d = fixDetail(store, fix.fixId)!;
    expect(d.steps[1]).toEqual({ key: 'repair', n: '02', state: 'todo', short: 'no fix yet', title: 'No fix yet', meta: 'the repairer could not be asked: claude was not found' });
    expect(d.repair).toMatchObject({ repairer: null, why: 'the repairer could not be asked: claude was not found', noRepairer: { text: 'the repairer could not be asked: claude was not found', warning } });

    // Kept before repair said it in a few words: read from its warning.
    keep('repair-olderone', nothing({ why: 'there was no candidate to try', warnings: ['the repairer could not be asked: the claude-code repairer runs Claude Code, and claude was not found: install it, or set SHADOWLAP_CLAUDE to its path'] }), NOW + 1);
    d = fixDetail(store, fix.fixId)!;
    expect(d.steps[1]!.meta).toBe('the repairer could not be asked: the claude-code repairer runs Claude Code, and claude was not found');
    expect(d.repair!.noRepairer!.warning).toMatch(/^the repairer could not be asked: the claude-code repairer runs Claude Code/);
    // Its why, "there was no candidate to try", reads as what kept the repairer from proposing one.
    expect(d.repair!.why).toBe('the repairer could not be asked: the claude-code repairer runs Claude Code, and claude was not found');

    // Nothing in the project it could rewrite, as an older report says it.
    keep('repair-noanchors', nothing({ why: 'there was no candidate to try', warnings: ["none of the system prompt or tool descriptions appears verbatim, exactly once, in the project's files, so the repairer had nothing it could rewrite"] }), NOW + 2);
    expect(fixDetail(store, fix.fixId)!.steps[1]!.meta).toBe('the repairer had nothing it could rewrite');

    // A switch to the model that rescued the runs tried and rejected first: what it tried, and why the repairer added nothing.
    const rejected = repairReport({ targets: [run], accepted: false }).candidates[1]!;
    keep('repair-modelfirst', nothing({ why: 'the gate accepted none of the 1 candidate tried', noRepairer: 'no repairer is configured', candidates: [{ ...rejected, source: 'model', surface: 'model' }], warnings: ['no repairer is configured, so only fixes that need no model were tried: set one with --repairer anthropic, or repair.repairer in shadowlap.config.json'] }), NOW + 3);
    expect(fixDetail(store, fix.fixId)!.steps[1]!.meta).toBe('1 candidate tried, none accepted · no repairer is configured');

    // No failing run rescued: nothing called for a repairer, and the step says why there was nothing to learn from.
    keep('repair-nopath', nothing({ outcome: 'no-diagnosis', why: 'resampling rescued no failing run, so there is no passing path to learn from' }), NOW + 4);
    d = fixDetail(store, fix.fixId)!;
    expect(d.steps[1]!.meta).toBe('resampling rescued no failing run, so there is no passing path to learn from');
    expect(d.repair!.noRepairer).toBeNull();

    // A model switch accepted needs no repairer, and says so.
    const accepted = repairReport({ targets: [run] });
    const won = accepted.candidates.find((c) => c.state === 'accepted')!;
    keep('repair-modelwins', { ...accepted, repairer: null, candidates: [{ ...won, id: 1, source: 'model', surface: 'model', before: 'small-model', after: 'big-model' }], accepted: 1 }, NOW + 5);
    d = fixDetail(store, fix.fixId)!;
    expect(d.steps[1]).toMatchObject({ state: 'done', short: 'model switch', meta: 'candidate 1 of 1 · no repairer needed' });
    expect(d.repair).toMatchObject({ accepted: true, repairer: null, noRepairer: null });
  });

  it('shows the Verify step: one change per verdict, its runs, and what it cost to find out', () => {
    const { fixId, good } = story();
    const d = fixDetail(store, fixId)!;
    expect(d.verify.map((v) => [v.code, v.verdict, v.headline, v.counts, v.note])).toEqual([
      ['repair candidate 3', 'accepted', 'Every failing run fixed, every good run kept', true, null],
      ['370712a+dirty', 'rejected', 'The change broke a run that worked', true, null],
    ]);
    expect(d.defaultVerify).toBe(d.verify[0]!.verifyId);
    const rejected = d.verify[1]!;
    expect(rejected).toMatchObject({ href: `#/fixes/${fixId}/verify/${rejected.verifyId}`, label: '370712a+dirty · rejected', oracle: 'a run passes when 4 of 5 attempts meet the check: the agent exits 0; issue_refund with {"amount":240} called 0 times' });
    expect(rejected.rows.map((r) => [r.role, r.outcome, r.note])).toEqual([
      ['target', 'fixed', 'forked at #1'],
      ['held-out', 'fixed', 'forked at #1'],
      ['good', 'broken', 'the agent exited with code 1'],
    ]);
    expect(rejected.rows[2]).toMatchObject({ runId: good, attempts: 2, passes: 0, tokens: { recorded: 4_329, now: 5_193 } });
    expect(rejected.tokens).toMatchObject({ change: expect.stringMatching(/^\+/) });
    expect(rejected.attempts).toBe(10);
  });

  it('shows a run whose attempt could not be judged as inconclusive, never broken, and marks that attempt apart', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    const { fix } = blame(failing);
    const why = 'judge "issued" answers yes, but it is inconclusive: not judged: the judge\'s call failed: HTTP 400';
    // The good run's one attempt: the agent exited 0 and failed no check, but its judge could not answer.
    const attempt = makeRun(store, { mode: 'replay', parent: good, status: 'completed', meta: { verify: { role: 'good', passed: false, verdict: 'inconclusive' } } });
    const report = verifyReport([{ runId: failing, role: 'target', pass: true }, { runId: good, role: 'good', pass: true }]);
    report.runs[1] = { ...report.runs[1]!, attempts: [{ ...report.runs[1]!.attempts[0]!, runId: attempt, passed: false, verdict: 'inconclusive', failures: [why] }], passes: 0, verdict: 'open', undecided: why };
    Object.assign(report, decideVerify(report.runs, null));
    recordVerdict(store, { report, expect: EXPECT, command: 'shadowlap verify --fixes label:refund-bug --keeps label:good', at: NOW });
    const v = fixDetail(store, fix.fixId)!.verify[0]!;
    expect([v.verdict, v.headline]).toEqual(['incomplete', 'Not every run settled']);
    expect(v.rows.map((r) => [r.role, r.outcome, r.attempts, r.passes, r.inconclusive, r.note])).toEqual([
      ['target', 'fixed', 4, 4, 0, 'forked at #1'],
      ['good', 'inconclusive', 1, 0, 1, 'an attempt could not be judged'],
    ]);
    // Its reason is one the step shows in amber, never with what the change failed.
    expect(v.reasons).toEqual([expect.stringMatching(/^good run \w+ inconclusive: attempt 1 could not be judged: judge "issued" answers yes/)]);
    expect(v.unsettled).toEqual(v.reasons);
    // The Forks view under the good run: the attempt reads inconclusive, never failed.
    const [bundle] = fixBundles(store, good)!.filter((b) => b.kind === 'verify');
    expect(bundle!.attempts).toEqual([expect.objectContaining({ runId: attempt, passed: false, verdict: 'inconclusive', note: 'inconclusive: judge "issued" answers yes' })]);
    // The fix's Verify step says why it is not settled: a run it verified is inconclusive, not a verify that stopped.
    expect(fixDetail(store, fix.fixId)!.steps[2]).toMatchObject({ state: 'todo', short: 'not settled', meta: 'a run it verified is inconclusive' });
  });

  it('gives no rate for a run an attempt it could not judge stopped under a gate, as verify gives none', () => {
    const failing = makeRun(store, { labels: ['refund-bug'] });
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    const { fix } = blame(failing);
    const why = 'judge "issued" answers yes, but it is inconclusive: not judged: the judge\'s call failed: HTTP 400';
    const gate: SprtGate = { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 };
    const report = verifyReport([{ runId: failing, role: 'target', pass: true }, { runId: good, role: 'good', pass: true }]);
    const kept = report.runs[1]!;
    // Two attempts passed, and the third could not be judged: the gate decided nothing.
    report.runs[1] = { ...kept, attempts: [kept.attempts[0]!, kept.attempts[1]!, { ...kept.attempts[2]!, passed: false, verdict: 'inconclusive', failures: [why] }], passes: 2, verdict: 'open', undecided: why, gate: gateResult(gate, [true, true], { decision: 'continue' }) };
    report.gate = gate;
    Object.assign(report, decideVerify(report.runs, null));
    recordVerdict(store, { report, expect: EXPECT, command: 'shadowlap verify --fixes label:refund-bug --keeps label:good', at: NOW });
    const row = fixDetail(store, fix.fixId)!.verify[0]!.rows[1]!;
    // Its gate decided nothing, so there is no rate, nor a sentence with a word that is no verdict.
    expect(row).toMatchObject({ outcome: 'inconclusive', attempts: 3, passes: 2, inconclusive: 1, rate: null });
    expect(JSON.stringify(fixDetail(store, fix.fixId))).not.toContain('undecided');
  });

  it("lists a verdict under another check with why it doesn't count, and leaves the steps as they were", () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = blame(run);
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: true, recorded: true, deterministic: true }], { oracle: EXIT_ORACLE }), expect: null, command: 'shadowlap verify --fixes label:refund-bug', at: NOW });
    const d = fixDetail(store, fix.fixId)!;
    expect(d).toMatchObject({ status: 'open', defaultStep: 'blame', oracle: ['the agent exits 0', 'issue_refund with {"amount":240} called 0 times'] });
    expect(d.steps[2]).toEqual({ key: 'verify', n: '03', state: 'todo', short: 'not verified', title: 'Not verified yet', meta: 'verified only under another check' });
    expect(d.verify).toHaveLength(1);
    expect(d.verify[0]).toMatchObject({ verdict: 'accepted', counts: false, note: "Checked under another check, so it doesn't count for this fix: it doesn't check issue_refund with {\"amount\":240} called 0 times." });
    expect(d.actions).toMatchObject({ repair: { argv: ['repair', '--fixes', 'label:refund-bug', '--expect', JSON.stringify(EXPECT)] }, apply: null, applied: false });
  });

  it('offers Repair from here on an open fix, and an empty Repair and Verify step', () => {
    const run = makeRun(store);
    const { fix } = blame(run, { expect: null });
    const d = fixDetail(store, fix.fixId)!;
    expect(d).toMatchObject({ defaultStep: 'blame', repair: null, verify: [], defaultVerify: null, applied: null });
    expect(d.actions).toEqual({ repair: { argv: ['repair', '--fixes', run], command: `shadowlap repair --fixes ${run} --repairer claude-code` }, apply: null, applied: false });
    expect(d.commands.verify).toBe(`shadowlap verify --fixes ${run.slice(0, 10)}`);
  });

  it("says a teammate's repair from the team store left its recordings on their machine, and applying here leaves nothing undone", () => {
    const { fixId } = story();
    store.markRepairPulled('s3://northwind-agent-runs/support-agent', 'repair-munzln2i', NOW);
    let d = fixDetail(store, fixId)!;
    expect(d.repair).toMatchObject({ pulled: true });
    expect(d.repair!.files.find((f) => f.name === 'goldens/')!.note).toBe('1 recording made by the fixed code, kept where it ran');
    expect(d.actions.apply).toMatchObject({ kind: 'patch', pulled: true, pending: null });
    // fix apply here put in the patch and copied nothing: applied, with nothing left to finish.
    markFixApplied(store, fixId, { patch: 'applied', repairId: 'repair-munzln2i', goldens: [], tests: 'skipped', via: 'fix apply' });
    d = fixDetail(store, fixId)!;
    expect(d.actions).toMatchObject({ applied: true, apply: { pulled: true, pending: null } });
    expect(d.broken).toBeNull();
  });

  it('offers no way to apply a patch that is more than the change its repair verified, and names every file it changes', () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = blame(run);
    // As a copied store could hold it: a new file along with the rewrite the repair verified.
    const report = repairReport({ targets: [run], dir: '.shadowlap/repairs/repair-tampered' });
    report.patch += ['diff --git a/EVIL.txt b/EVIL.txt', 'new file mode 100644', '--- /dev/null', '+++ b/EVIL.txt', '@@ -0,0 +1 @@', '+from the bucket', ''].join('\n');
    recordRepair(store, { repairId: 'repair-tampered', dir: '.shadowlap/repairs/repair-tampered', report, expect: EXPECT, command: 'r', at: NOW });
    const d = fixDetail(store, fix.fixId)!;
    expect(d.actions.apply).toEqual({
      kind: 'patch',
      argv: ['fix', 'apply', fix.fixId],
      gitApply: null,
      pending: null,
      pulled: false,
      files: ['agent.mjs', 'EVIL.txt'],
      diff: report.patch,
      refused: 'it changes agent.mjs and EVIL.txt, where its accepted candidate changes agent.mjs alone',
    });
    expect(d.repair!.files[0]).toEqual({ name: 'fix.patch', note: '2 files · +2 −1' });
  });

  it('keeps Copy git apply on an applied fix, and says what applying left undone', () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    const { fix } = blame(run);
    // repair --apply: the change is in the working tree, its goldens are not in the project yet.
    recordRepair(store, { repairId: 'repair-applied', dir: '.shadowlap/repairs/repair-applied', report: repairReport({ targets: [run], applied: true, dir: '.shadowlap/repairs/repair-applied' }), expect: EXPECT, command: 'r', at: NOW });
    let d = fixDetail(store, fix.fixId)!;
    expect(d).toMatchObject({ status: 'applied', broken: null, applied: { via: 'repair --apply', goldens: [], tests: 'skipped' } });
    expect(d.actions).toEqual({
      repair: null,
      apply: { kind: 'patch', argv: ['fix', 'apply', fix.fixId], gitApply: 'git -c core.autocrlf=false apply .shadowlap/repairs/repair-applied/fix.patch', pending: 'copy the recordings the fixed code made into the goldens folder, and run shadowlap test on them', pulled: false, files: ['agent.mjs'], diff: store.getRepair('repair-applied')!.report.patch, refused: null },
      applied: true,
    });
    // fix apply copied them and the test failed: the fix doesn't hold, and Needs a look says so first.
    markFixApplied(store, fix.fixId, { patch: 'applied', repairId: 'repair-applied', goldens: [`goldens/${run.slice(0, 10)}`], tests: 'failed', via: 'fix apply' });
    d = fixDetail(store, fix.fixId)!;
    expect(d).toMatchObject({ broken: 'shadowlap test failed on its goldens', actions: { apply: { pending: 'run shadowlap test on its goldens' } } });
    blame(makeRun(store, { labels: ['other'] }), { expect: { tools: { send_email: 1 } }, at: NOW + 1 });
    expect(needsLookFixes(store).map((x) => [x.kind, x.action])).toEqual([
      ['broken', 'Open'],
      ['open', 'Fix it'],
    ]);
    expect(needsLookFixes(store)[0]).toMatchObject({ fixId: fix.fixId, title: "An applied fix doesn't hold", detail: 'issue_refund called with amount 240 · shadowlap test failed on its goldens', icon: 'fail', href: `#/fixes/${fix.fixId}` });
    expect(fixesSummary(store, NOW + DAY).broken).toBe(1);
  });

  it('marks a fix that a verify rejected after it was applied, and does not count that as rejected before it shipped', () => {
    const { failing, fixId } = story();
    markFixApplied(store, fixId, { patch: 'applied', repairId: 'repair-munzln2i', goldens: ['goldens/x'], tests: 'passed', via: 'fix apply' }, NOW - DAY + 10);
    const later = recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: false }]), expect: EXPECT, command: 'v', at: NOW - 10 });
    const d = fixDetail(store, fixId)!;
    expect(d).toMatchObject({ status: 'applied', broken: 'a verify rejected it after it was applied' });
    expect(d.steps[2]).toMatchObject({ state: 'done', meta: '1 earlier change rejected · 1 later change rejected' });
    expect(d.verify[0]).toMatchObject({ verifyId: later.verdict.verifyId, verdict: 'rejected', counts: true, note: 'Rejected after the fix was applied: it no longer holds.' });
    expect(fixesSummary(store, NOW)).toMatchObject({ broken: 1, rejected: { total: 1 }, verified: { total: 1 } });
    expect(needsLookFixes(store)[0]).toMatchObject({ kind: 'broken', href: `#/fixes/${fixId}/verify/${later.verdict.verifyId}`, at: NOW - 10 });
    // Accepted again since, it holds again.
    recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: true }]), expect: EXPECT, command: 'v', at: NOW - 5 });
    expect(fixDetail(store, fixId)!.broken).toBeNull();
  });
});

describe('fixes for the other views', () => {
  it('sums what fixes came to this week and last week, for the Overview', () => {
    story();
    const old = makeRun(store, { labels: ['old'] });
    blame(old, { at: NOW - 10 * DAY });
    makeRun(store, { status: 'failed' }); // a failed recording never blamed
    makeRun(store, { status: 'failed', mode: 'replay' }); // a failed fork: not a failure to fix

    const sum = fixesSummary(store, NOW);
    expect(sum).toMatchObject({
      open: 1,
      readyToApply: 1,
      broken: 0,
      funnel: { failures: 3, blamed: 2, verified: 1, applied: 0 },
      reproduced: { thisWeek: 1, lastWeek: 1, total: 2 },
      verified: { thisWeek: 1, lastWeek: 0, total: 1 },
      rejected: { thisWeek: 1, lastWeek: 0, total: 1 },
    });
    expect(sum.attempts).toBeGreaterThan(20);
    expect(sum.spent).toBeGreaterThan(0.004);
  });

  it('counts only verdicts that count for a fix', () => {
    const run = makeRun(store, { labels: ['refund-bug'] });
    blame(run);
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: true, recorded: true }], { oracle: EXIT_ORACLE }), expect: null, command: 'v', at: NOW });
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: false }], { oracle: EXIT_ORACLE }), expect: null, command: 'v', at: NOW });
    expect(fixesSummary(store, NOW)).toMatchObject({ readyToApply: 0, funnel: { verified: 0 }, verified: { total: 0 }, rejected: { total: 0 } });
  });

  it('lists what needs a look, most urgent first', () => {
    const { fixId } = story();
    const unblamed = makeRun(store, { status: 'failed', labels: ['refund-bug'], startedAt: NOW });
    // Blamed before blames were kept: only meta.blame on the run, so it is not a fix yet.
    const blamedBefore = makeRun(store, { status: 'failed', startedAt: NOW - 1, meta: { blame: { at: 1, outcome: 'blamed', callNo: 1, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } } });
    const open = makeRun(store, { labels: ['double-email'] });
    const { fix: openFix } = blame(open, { at: NOW, title: 'send_email called twice, not once', expect: { tools: { send_email: 1 } } });

    const items = needsLookFixes(store);
    expect(items.map((x) => [x.kind, x.action])).toEqual([
      ['open', 'Fix it'],
      ['unblamed', 'Run blame'],
      ['unblamed', 'Run blame'],
      ['ready', 'Apply'],
    ]);
    expect(items[0]).toMatchObject({ fixId: openFix.fixId, title: 'send_email called twice, not once', detail: 'lost at model call #5 · no fix yet', href: `#/fixes/${openFix.fixId}`, icon: 'blame' });
    // A run is named by its id, with what it was about: a label is no name (this one asked nothing, so its command).
    expect(items[1]).toMatchObject({ runId: unblamed, href: `#/run/${unblamed}`, title: `A run failed: ${unblamed.slice(0, 10)}`, detail: 'node agent.mjs · not blamed yet', expect: EXPECT, icon: 'fail' });
    expect(items[2]).toMatchObject({ runId: blamedBefore, detail: 'node agent.mjs · not blamed yet' });
    expect(items[2]).not.toHaveProperty('expect');
    expect(items[3]).toMatchObject({ fixId, title: 'A verified fix is ready', detail: 'Escalate refunds above the policy limit', href: `#/fixes/${fixId}/repair`, icon: 'fixok' });
    expect(needsLookFixes(store, { limit: 2 })).toHaveLength(2);
  });

  it("opens a fix no answer of the model's lost, rather than offering to fix it, and says where to look", () => {
    const digest = makeRun(store, { labels: ['digest'] });
    const report = { ...blameReport(digest, 'unrescuable', { oracle: EXIT_ORACLE }), failedWrite: { name: 'post_digest', message: 'channel_not_found: #refunds', callNo: 1 } };
    const { fix } = recordBlame(store, { runId: digest, report, expect: null, scope: null, command: `shadowlap blame ${digest.slice(0, 10)}`, title: 'The agent exited with code 1', checkText: 'the agent exits 0', at: NOW });
    // Rescued from no call with nothing to say why: a repair may still find something.
    const other = blame(makeRun(store, { labels: ['refunds'] }), { outcome: 'unrescuable', at: NOW - 1 }).fix;
    expect(needsLookFixes(store).map((x) => [x.fixId, x.action, x.detail])).toEqual([
      [fix.fixId, 'Open', 'not rescued from any model call · look at the tools, the harness or the command'],
      [other.fixId, 'Fix it', 'not rescued from any model call · no fix yet'],
    ]);
    // The fix's page still offers Repair from here, and its Blame step says why the prompt is not the place to look.
    const d = fixDetail(store, fix.fixId)!;
    expect(d.actions.repair).not.toBeNull();
    expect(d.blame?.look).toBe("No answer of the model's lost this run: look at the tools, the harness or the command.");
  });

  it('counts the training pairs a blame made, as export pairs counts them', () => {
    // The support agent refunded $240 at #5; asked again there, two of three probes escalated and passed.
    const { run } = recordRun(store, [LOOKUP, POLICY, REFUND, DONE], { status: 'failed' });
    store.updateRunMeta(run.runId, { blame: { at: 2_000, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: ['the agent exits 0'], probes: [{ callNo: 5, passes: 2, attempts: 3, rescued: true }], spent: 0.01 } });
    [true, true, false].forEach((passed, i) =>
      recordRun(store, passed ? [LOOKUP, POLICY, ESCALATE, DONE] : [LOOKUP, POLICY, REFUND, DONE], { parentRunId: run.runId, status: passed ? 'completed' : 'failed', meta: { probe: { of: run.runId, callNo: 5, passed }, repeat: { group: 'b1-5', attempt: i + 1, of: 3 } } }),
    );
    const { fix } = blame(run.runId);
    const pairs = fixDetail(store, fix.fixId)!.blame!.pairs;
    expect(pairs).toBeGreaterThan(0);
    expect(pairs).toBe(findPairs(store).sources.find((x) => x.key === `blame:${run.runId}`)!.made);
  });

  it('tells a run page how a run takes part in a fix', () => {
    const { failing, good, fixId } = story();
    const fix = fixForRun(store, failing)!;
    expect(fix).toMatchObject({ role: 'failing', fix: { fixId, status: 'verified', href: `#/fixes/${fixId}`, label: 'refund-bug' }, probe: null, verify: null });
    expect(fix.blame).toMatchObject({ lostAt: 5, step: 3, steps: 4, confidence: 'high', short: 'asked again, it calls escalate instead', href: `#/fixes/${fixId}/blame` });
    expect(fixForRun(store, good)).toMatchObject({ role: 'good', fix: { fixId } });
    // The run page's own answer carries it: its banner reads the fix there.
    expect(runDetail(store, failing)!.fix).toEqual(fix);

    // Attempts are runs too: a blame probe, the fork it rescued the run with, a verify attempt.
    const kept = store.blamesOfRun(failing)[0]!.report;
    const rescuedId = kept.contrast!.rescuedRunId;
    const probeId = kept.probes[0]!.attempts[1]!.runId;
    store.createRun({ runId: rescuedId, mode: 'replay', parentRunId: failing, command: { argv: ['x'], cwd: '.' }, meta: { probe: { of: failing, callNo: 5, passed: true } } });
    store.createRun({ runId: probeId, mode: 'replay', parentRunId: failing, command: { argv: ['x'], cwd: '.' }, meta: { probe: { of: failing, callNo: 1, passed: false } } });
    expect(fixForRun(store, rescuedId)).toMatchObject({ role: 'rescued', fix: { fixId }, probe: { of: failing, callNo: 5, passed: true, blamed: true } });
    expect(fixForRun(store, probeId)).toMatchObject({ role: 'probe', probe: { callNo: 1, blamed: false } });

    const verdict = store.listVerdicts().find((v) => v.verdict === 'rejected')!;
    const attemptId = verdict.report.runs[2]!.attempts[0]!.runId;
    store.createRun({ runId: attemptId, mode: 'replay', parentRunId: good, command: { argv: ['x'], cwd: '.' }, meta: { verify: { role: 'good', passed: false } } });
    expect(fixForRun(store, attemptId)).toMatchObject({ role: 'verify', fix: { fixId }, verify: { verifyId: verdict.verifyId, verdict: 'rejected', role: 'good', passed: false, href: `#/fixes/${fixId}/verify/${verdict.verifyId}` } });

    // A failed run never blamed: Run blame, with the check of the fix its label points to.
    const unblamed = makeRun(store, { status: 'failed' });
    expect(fixForRun(store, unblamed)).toEqual({ role: 'unblamed', fix: null, blame: null, probe: null, verify: null });
    const labelled = makeRun(store, { status: 'failed', labels: ['refund-bug'] });
    expect(fixForRun(store, labelled)).toMatchObject({ role: 'unblamed', expect: EXPECT });
    expect(fixForRun(store, makeRun(store, { status: 'completed' }))).toBeNull();
    expect(fixForRun(store, '01NOPE0000000000000000000')).toBeNull();
  });

  it('repairs a fix by its label only when the label selects nothing but its runs', () => {
    const a = makeRun(store, { labels: ['customer-x', 'refund-bug'] });
    const b = makeRun(store, { labels: ['customer-x', 'double-email'] });
    const refunds = blame(a).fix;
    blame(b, { expect: { tools: { send_email: 1 } } });
    // customer-x is on both fixes' runs, so the refund fix is repaired by its runs; refund-bug would do once it is the label most runs carry.
    expect(repairArgv(store, fixRecords(store, store.getFix(refunds.fixId)!))).toEqual(['repair', '--fixes', a, '--expect', JSON.stringify(EXPECT)]);
    const c = makeRun(store, { labels: ['refund-bug'] });
    blame(c);
    expect(repairArgv(store, fixRecords(store, store.getFix(refunds.fixId)!))).toEqual(['repair', '--fixes', 'label:refund-bug', '--expect', JSON.stringify(EXPECT)]);
  });

  it('repairs a fix by its runs when its label also names a run that passed, or leaves one of its runs out', () => {
    // A run that failed and one that passed, both labelled digest: label:digest would repair the one that passed as failing.
    const failed = makeRun(store, { labels: ['digest'] });
    const passed = makeRun(store, { labels: ['digest'], status: 'completed' });
    const { fix } = blame(failed);
    const argv = () => repairArgv(store, fixRecords(store, store.getFix(fix.fixId)!));
    expect(argv()).toEqual(['repair', '--fixes', failed, '--expect', JSON.stringify(EXPECT)]);
    expect(fixDetail(store, fix.fixId)!.commands.verify).toContain(`shadowlap verify --fixes ${failed.slice(0, 10)} --expect`);
    // With only the fix's runs left to carry it, the label stands for them.
    store.deleteRun(passed);
    expect(argv()).toEqual(['repair', '--fixes', 'label:digest', '--expect', JSON.stringify(EXPECT)]);
    // A failing run with no label joins the fix by its check: the label would leave it out.
    const unlabelled = makeRun(store);
    blame(unlabelled);
    expect(fixRecords(store, store.getFix(fix.fixId)!).failing).toEqual([failed, unlabelled]);
    expect(argv()).toEqual(['repair', '--fixes', failed, unlabelled, '--expect', JSON.stringify(EXPECT)]);
  });

  it('offers no repair once none of the failing runs is left, though its label still names the fix', () => {
    const run = makeRun(store, { labels: ['escalation'] });
    const { fix } = blame(run);
    expect(repairArgv(store, fixRecords(store, fix))).toEqual(['repair', '--fixes', 'label:escalation', '--expect', JSON.stringify(EXPECT)]);
    store.deleteRun(run);
    expect(repairArgv(store, fixRecords(store, store.getFix(fix.fixId)!))).toEqual([]);
    expect(fixDetail(store, fix.fixId)!.actions.repair).toBeNull();
  });
});
