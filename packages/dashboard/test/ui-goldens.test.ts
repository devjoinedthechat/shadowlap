import { describe, expect, it } from 'vitest';
import { asksUpdate, checkMark, checkReportLine, checkWords, ciQuery, commandText, dayClock, divergenceButtons, failureHint, failureLines, findCommitButton, foundLine, historyTip, inconclusiveHint, inconclusiveLines, missedLine, reportLines, revisionChoices, revLabel, runningTests, sessionLine, sessionWait, shortDate, sourceText, testsBusy, testsPalette, TESTS_UPDATE_HASH, updatePlan } from '../ui/goldens.js';
import { jobStatus } from '../ui/jobs.js';
import type { DivergenceView, FailureView, GoldenCheck, GoldenRow, InconclusiveView, TestsView, UnjudgedCheck } from '../ui/types.js';

/**
 * The Tests screen's words and choices, without a browser: the verdict's line, a history cell's
 * hover, the reports as the CLI prints them, the buttons a divergence gets, and the Update golden
 * dialog, against the shapes `GET /api/tests` sends.
 */
const T = new Date(2026, 9, 1, 10, 2).getTime();
const UUID = { path: '$.metadata.user_id', looks: 'a UUID', op: 'changed' as const, certain: true, normalizer: { kind: 'api' as const, path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }, args: [], command: '' };

const row = (name: string, over: Partial<GoldenRow> = {}): GoldenRow => ({
  path: `goldens/${name}`,
  name,
  source: { kind: 'run', runId: '01K5CQ3W6H0000000000000000' },
  mode: 'replay',
  modeLabel: 'replay',
  modeHint: 'must send exactly the requests it recorded',
  gate: null,
  checks: ['issue_refund called 1 time', 'send_email called 1 time'],
  checkResults: ['issue_refund called 1 time', 'send_email called 1 time'].map((label) => ({ label, status: 'passed', added: false, detail: null, reason: null, source: null, live: null, attempts: null })),
  injection: false,
  history: [],
  last: { result: 'pass', verdict: 'passed', failure: null, line: '8/8 replayed · checks passed', at: T, updated: false, gate: null },
  runId: null,
  error: null,
  ...over,
});

const divergence = (name: string, over: Partial<DivergenceView> = {}): DivergenceView => ({
  golden: `goldens/${name}`,
  name,
  runId: '01K5CQ4V5K0000000000000000',
  callNo: 1,
  kind: 'api',
  callName: 'POST /v1/messages',
  text: `✗ ${name}: diverged at call 1 (api POST /v1/messages)\n    ✗ Diverged at call 1 (api POST /v1/messages): 0 calls replayed before divergence\n      ~ $.metadata.user_id\n          - "3f1c9a2e-5b7d-4e21-9c0a-8d6f2b1e7a43"\n          + "b84e07d1-2c9f-4a63-8e15-6f0d3a9c2b78"`,
  volatile: UUID,
  normalizerFixes: true,
  maybeReal: false,
  rerun: ['test', `goldens/${name}`],
  update: ['test', `goldens/${name}`, '--update'],
  normalizeAndTest: [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', `goldens/${name}`]],
  rulesAdded: false,
  bisect: { good: 'c91d0f4', bad: 'd2e8a1f', args: [], live: false },
  found: null,
  missed: null,
  revisions: [],
  unreadable: null,
  ...over,
});

function view(over: Partial<TestsView> = {}): TestsView {
  return {
    empty: false,
    goldens: 4,
    verdict: {
      state: 'failing',
      failing: 1,
      inconclusive: 0,
      passing: 3,
      untested: 0,
      title: 'refund-in-limit diverged at call 1',
      first: { golden: 'goldens/refund-in-limit', name: 'refund-in-limit', reason: 'diverged at call 1 (api POST /v1/messages)', runId: null },
      session: { id: 's1', command: 'shadowlap test goldens/*', revision: 'd2e8a1f', startedAt: T - 60_000, endedAt: T, passed: 3, failed: 1, inconclusive: 0, upstreamRequests: 0, actor: 'ci', interrupted: false, live: false },
      since: [],
    },
    revisions: ['c91d0f4', 'd2e8a1f'],
    rows: [row('refund-over-limit'), row('refund-in-limit', { last: { result: 'fail', verdict: 'failed', failure: 'diverged', line: 'diverged at call 1 · $.metadata.user_id looks like a UUID', at: T, updated: false, gate: null } }), row('escalate-over-limit', { checks: [] })],
    divergences: [divergence('refund-in-limit')],
    failures: [],
    inconclusive: [],
    diverged: ['goldens/refund-in-limit'],
    running: null,
    chaosRunning: null,
    commands: { ci: `shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`, pack: 'shadowlap pack <run> goldens/<name>', run: ['test', 'goldens/*'], updateAll: ['test', 'goldens/refund-in-limit', '--update'] },
    note: '',
    ...over,
  };
}

const all = () => true;

describe('the verdict', () => {
  it('names the command, revision, time, the session’s own counts and its upstream requests', () => {
    expect(sessionLine(view())).toEqual({ command: 'shadowlap test goldens/*', rest: 'rev d2e8a1f · Oct 1, 10:02 · 3 passed, 1 failed · 0 upstream requests', since: null, sinceTip: null });
    const v = view();
    // How the goldens stand is the headline's; the line counts what that session ran.
    v.verdict!.untested = 2;
    v.verdict!.session.passed = 2;
    v.verdict!.session.upstreamRequests = 1;
    expect(sessionLine(v)!.rest).toBe('rev d2e8a1f · Oct 1, 10:02 · 2 passed, 1 failed · 1 upstream request');
  });

  it('counts inconclusive goldens apart from passed and failed ones', () => {
    const v = view();
    v.verdict!.session.passed = 2;
    v.verdict!.session.inconclusive = 1;
    expect(sessionLine(v)!.rest).toBe('rev d2e8a1f · Oct 1, 10:02 · 2 passed, 1 failed, 1 inconclusive · 0 upstream requests');
  });

  it('says what ran again since, on its own, and how', () => {
    const v = view();
    v.verdict!.since = [{ golden: 'goldens/refund-in-limit', name: 'refund-in-limit', ok: true, verdict: 'passed', revision: 'd2e8a1f+dirty', at: T + 60_000 }];
    expect(sessionLine(v)).toMatchObject({ since: 'since: refund-in-limit passed', sinceTip: 'refund-in-limit passed at d2e8a1f+dirty, Oct 1, 10:03' });
    v.verdict!.since.push({ golden: 'goldens/refund-flow', name: 'refund-flow', ok: false, verdict: 'failed', revision: null, at: T + 120_000 });
    expect(sessionLine(v)).toMatchObject({ since: 'since: 2 goldens ran again, 1 failed', sinceTip: 'refund-in-limit passed at d2e8a1f+dirty, Oct 1, 10:03\nrefund-flow failed, Oct 1, 10:04' });
    v.verdict!.since[1] = { ...v.verdict!.since[1], ok: true, verdict: 'passed' };
    expect(sessionLine(v)!.since).toBe('since: 2 goldens ran again, all passed');
    // One inconclusive is neither: counted apart, and named so on hover.
    v.verdict!.since[1] = { ...v.verdict!.since[1], ok: false, verdict: 'inconclusive' };
    v.verdict!.since.push({ golden: 'goldens/refund-over-limit', name: 'refund-over-limit', ok: false, verdict: 'failed', revision: null, at: T + 180_000 });
    expect(sessionLine(v)).toMatchObject({ since: 'since: 3 goldens ran again, 1 failed, 1 inconclusive' });
    expect(sessionLine(v)!.sinceTip).toContain('refund-flow inconclusive, Oct 1, 10:04');
  });

  it('says when a session was interrupted, is still running, or never finished', () => {
    const v = view();
    v.verdict!.session.interrupted = true;
    expect(sessionLine(v)!.rest).toMatch(/ · interrupted$/);
    v.verdict!.session.interrupted = false;
    v.verdict!.session.endedAt = null;
    expect(sessionLine(v, true)!.rest).toMatch(/Oct 1, 10:01 · 3 passed, 1 failed so far · .* · running$/);
    expect(sessionLine(v, false)!.rest).toMatch(/ · did not finish$/);
    // Running in a terminal or another tab: the server says its process is there.
    v.verdict!.session.live = true;
    expect(sessionLine(v, false)!.rest).toMatch(/ · running$/);
    expect(sessionLine(view({ verdict: null }))).toBeNull();
  });
});

describe('the goldens table', () => {
  it('names each revision by its short sha, a + when it was tested with changes on top', () => {
    expect(revLabel('d2e8a1f9c0b1')).toBe('d2e8a1f');
    expect(revLabel('d2e8a1f+dirty')).toBe('d2e8a1f+');
    expect(revLabel('v2.4.0')).toBe('v2.4.0');
    expect(revLabel(null)).toBe('—');
  });

  it('says on hover a golden run again on its own with changes on top of that commit', () => {
    expect(historyTip({ revision: 'd2e8a1f', tested: 'd2e8a1f+dirty', result: 'pass', verdict: 'passed', rate: null, dropped: false, note: null, updated: false, runId: null, at: T }, 'x').value).toBe('run again at d2e8a1f+dirty');
    expect(historyTip({ revision: 'd2e8a1f', tested: 'd2e8a1f+dirty', result: 'fail', verdict: 'failed', rate: null, dropped: false, note: 'diverged at call 3', updated: false, runId: null, at: T }, 'x').value).toBe('run again at d2e8a1f+dirty · diverged at call 3');
  });

  it('says on hover how a golden did at each revision, and why it failed', () => {
    expect(historyTip({ revision: 'b7e40c2', tested: 'b7e40c2', result: 'fail', verdict: 'failed', rate: null, dropped: false, note: 'input tokens 71,940, over the 60,000 budget', updated: false, runId: null, at: T }, 'refund-flow-budget')).toEqual({ title: 'b7e40c2 · refund-flow-budget', label: 'failed', value: 'input tokens 71,940, over the 60,000 budget', color: 'var(--err)' });
    expect(historyTip({ revision: 'd2e8a1f', tested: 'd2e8a1f', result: 'pass', verdict: 'passed', rate: null, dropped: false, note: null, updated: true, runId: null, at: T }, 'x')).toMatchObject({ label: 'passed', value: 'updated here: re-recorded, its checks passed', color: 'var(--o-rep)' });
    expect(historyTip({ revision: null, tested: null, result: null, verdict: null, rate: null, dropped: false, note: null, updated: false, runId: null, at: null }, 'x')).toMatchObject({ title: 'no revision · x', label: 'not tested here' });
    // Updated, and its new recording failed the replay after it: both are said.
    expect(historyTip({ revision: 'd2e8a1f', tested: 'd2e8a1f', result: 'fail', verdict: 'failed', rate: null, dropped: false, note: 'diverged at call 8', updated: true, runId: null, at: T }, 'x').value).toBe('updated here, then diverged at call 8');
    // A pass whose replay had a connection blocked says so, after the update when there was one.
    expect(historyTip({ revision: 'd2e8a1f', tested: 'd2e8a1f', result: 'pass', verdict: 'passed', rate: null, dropped: false, note: 'blocked connection to hooks.example.com:443', updated: false, runId: null, at: T }, 'x').value).toBe('blocked connection to hooks.example.com:443');
    expect(historyTip({ revision: 'd2e8a1f', tested: 'd2e8a1f', result: 'pass', verdict: 'passed', rate: null, dropped: false, note: 'blocked connection to hooks.example.com:443', updated: true, runId: null, at: T }, 'x').value).toBe('updated here: re-recorded, its checks passed · blocked connection to hooks.example.com:443');
    // Inconclusive: neither, in amber, with the attempts it ran there.
    expect(historyTip({ revision: 'd2e8a1f', tested: 'd2e8a1f', result: 'fail', verdict: 'inconclusive', rate: { passes: 16, attempts: 20 }, dropped: false, note: 'inconclusive after 20 attempts', updated: false, runId: null, at: T }, 'x')).toEqual({ title: 'd2e8a1f · x', label: 'inconclusive', value: '16 of 20 attempts passed · inconclusive after 20 attempts', color: 'var(--warn)' });
  });

  it('prints an inconclusive golden\'s report with its gate\'s evidence, and what more attempts would take', () => {
    const gate = { tally: '16 of 20 passed · rate 0.58 to 0.92 (95%) · pass^5 0.28', more: { args: ['test', 'goldens/flaky', '--max-attempts', '40', '--continue'], job: { golden: 'goldens/flaky', maxAttempts: 40, continue: true as const }, attempts: 40, most: 20, expected: 17.17, settles: 0.378, cost: 0.34 } };
    const v = { golden: 'goldens/flaky', name: 'flaky', runId: null, reason: 'inconclusive · 16 of 20 · rate 0.58 to 0.92 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts', checks: [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }], details: `${gate.tally}\nattempt 1  ✓ passed`, gate } as unknown as InconclusiveView;
    expect(inconclusiveLines(v).map((l) => l.text)).toEqual([
      '? flaky: inconclusive · 16 of 20 · rate 0.58 to 0.92 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts',
      `    ${gate.tally}`,
      '    ✗ send_email called 0 times: called 1 time',
      '    attempt 1  ✓ passed',
    ]);
    // Its ? line in amber: neither passed nor failed.
    expect(inconclusiveLines(v)[0].tone).toBe('y');
    expect(inconclusiveHint(v)).toBe("Neither verdict holds at the gate's stated risk yet: more attempts settle it, not a change to the agent. Run more attempts continues it to 40: about 17 more on average, about $0.34, settling it 38% of the time.");
    expect(inconclusiveHint({ ...v, gate: null })).toBe('A check could not be decided, as its line above says, so the golden is neither passed nor failed: settle what it lacks and run it again.');
    // An injection gate that showed too little to say: its own hint.
    expect(inconclusiveHint({ ...v, gate: null, failure: 'injection', reason: 'injection inconclusive: 5 of 5 attempts could not be judged' })).toContain('its injection test showed too little to say');
  });

  it('says what settles a judge check with no verdict: Update golden offline, the key for a golden that forks', () => {
    const judge: UnjudgedCheck = { name: 'explains-escalation', label: 'judge "explains-escalation" answers yes', model: 'claude-haiku-4-5', provider: 'anthropic', why: 'not judged: no recorded verdict and the test runs offline', held: 'none', changed: null, update: ['test', 'goldens/judged', '--update'], keys: null };
    const v = { golden: 'goldens/judged', name: 'judged', runId: null, reason: 'check inconclusive', checks: [], details: null, gate: null, judge } as InconclusiveView;
    // Offline, no key settles it: the old hint asked for one.
    expect(inconclusiveHint(v)).toBe('Its pack holds no verdict for the judge check explains-escalation, and the test replays offline, so the judge can’t be asked. Update golden asks it once, live, and keeps its verdict in the pack: every test after judges from the recording, free.');
    expect(inconclusiveHint({ ...v, judge: { ...judge, update: null, keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] } })).toBe('The test runs this golden live, and the judge check explains-escalation had no key to ask claude-haiku-4-5 with: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) where the tests run, in CI as a secret, and run it again.');
    // A verdict the pack holds, given to an older form of the request: no "no verdict", and the update asks again.
    const older = inconclusiveHint({ ...v, judge: { ...judge, held: 'older', why: "not judged: the recording's verdict was given to an older form of the judge's request, and the test runs offline: record it again with shadowlap test --update" } });
    expect(older).toBe('The verdict its pack holds for the judge check explains-escalation was given to an older form of the judge’s request, which a replay no longer sends, and the test replays offline, so the judge can’t be asked. Update golden asks it once, live, and keeps its verdict in the pack: every test after judges from the recording, free.');
    // One given on other material: a value made anew on every run needs its normalizer before the update, which alone would leave the next test where this one is.
    const material = inconclusiveHint({ ...v, judge: { ...judge, held: 'material', changed: 'it read "order 8f3a" where it now reads "order 1b2c"' } });
    expect(material).toBe('The verdict its pack holds for the judge check explains-escalation was given on other material than the replay reads now, as its line above says, and the test replays offline, so the judge can’t be asked. If what changed is a value that changes every run, such as an id the agent prints, a normalizer for it is the lasting fix: add it first, since a verdict on one run’s value answers no other, and the next test would read not judged again. Update golden then asks the judge once, live, and keeps its verdict in the pack.');
    expect(material.indexOf('normalizer')).toBeLessThan(material.indexOf('Update golden'));
    for (const hint of [older, material]) expect(hint).not.toContain('holds no verdict');
  });

  it('marks each check by its last status, as the CLI does, with no mark before a result', () => {
    const c = (over: Partial<GoldenCheck>): GoldenCheck => ({ label: 'issue_refund called 0 times', status: 'passed', added: false, detail: null, reason: null, source: null, live: null, attempts: null, ...over });
    expect(checkMark(c({}), true)).toMatchObject({ mark: '✓', status: 'passed', word: 'passed', text: 'issue_refund never called', sub: null, tip: { title: 'passed · issue_refund called 0 times', color: 'var(--ok)' } });
    // Failed: what it found, and over several attempts how many passed it.
    expect(checkMark(c({ status: 'failed', detail: 'called 1 time (1 blocked or stubbed)' }), true)).toMatchObject({ mark: '✗', sub: 'called 1 time (1 blocked or stubbed)', tip: { label: 'failed', value: 'called 1 time (1 blocked or stubbed)', color: 'var(--err)' } });
    expect(checkMark(c({ status: 'failed', detail: 'called 1 time (1 blocked or stubbed)', attempts: { passed: 8, of: 12 } }), true).sub).toBe('8 of 12 attempts passed · the others: called 1 time (1 blocked or stubbed)');
    // Inconclusive: a ? with why, in amber; not applicable: a dash, and why on hover.
    expect(checkMark(c({ label: 'judge "calm" answers yes', status: 'inconclusive', detail: 'not judged: no recorded verdict and the test runs offline' }), true)).toMatchObject({ mark: '?', status: 'inconclusive', sub: 'not judged: no recorded verdict and the test runs offline', tip: { color: 'var(--warn)' } });
    expect(checkMark(c({ status: 'not-applicable', detail: 'the condition never held' }), true)).toMatchObject({ mark: '–', word: 'not applicable', sub: 'not applicable', tip: { value: 'the condition never held' } });
    // A judge's verdict says where it came from, as the CLI's check line does: free from the recording, and live at what it cost.
    expect(checkMark(c({ source: 'recording', reason: 'It names the limit.' }), true)).toMatchObject({ sub: 'judged from the recording · free', tip: { value: '“It names the limit.”' } });
    expect(checkMark(c({ source: 'live', live: { cost: 0.00043, asked: 1 } }), true).sub).toBe('judged live · ≈$0.0004');
    expect(checkMark(c({ source: 'live', live: { cost: 0.0021, asked: 5 }, attempts: { passed: 5, of: 5 } }), true).sub).toBe('judged live in 5 attempts · ≈$0.0021');
    // A model with no price: where it came from, and no figure.
    expect(checkMark(c({ source: 'live' }), true).sub).toBe('judged live');
    // A pass over attempts that weren't all passes says so.
    expect(checkMark(c({ attempts: { passed: 17, of: 18 } }), true)).toMatchObject({ sub: '17 of 18 attempts passed', tip: { value: 'passed in 17 of 18 attempts' } });
    expect(checkMark(c({ attempts: { passed: 12, of: 12 } }), true)).toMatchObject({ sub: null, tip: { value: 'passed in every attempt, 12 of 12' } });
    // Not tested yet: no mark, never a tick, and the hover says why: no result yet, a golden its last test couldn't run, or a check added since.
    expect(checkMark(c({ status: null }), false)).toMatchObject({ mark: null, word: 'not tested yet', sub: null, tip: { title: 'not tested yet · issue_refund called 0 times', value: 'its golden hasn’t run yet' } });
    expect(checkMark(c({ status: null }), true)).toMatchObject({ mark: null, word: 'not tested yet', sub: null, tip: { value: 'its last test couldn’t run the golden, so no check has a result' } });
    expect(checkMark(c({ status: null, added: true }), true)).toMatchObject({ mark: null, word: 'not tested yet', sub: 'added since its last test', tip: { value: 'Added to shadowlap.config.json since its last test: its next test judges it' } });
    // "not judged" is the CLI's word for a judge check that couldn't be decided, never for one not tested.
    for (const ran of [false, true]) expect(checkMark(c({ status: null }), ran).tip.title).not.toContain('not judged');
  });

  it('says where each golden came from: a run here, or a pack made elsewhere', () => {
    expect(sourceText(row('a'))).toEqual({ runId: '01K5CQ3W6H0000000000000000' });
    expect(sourceText(row('a', { source: { kind: 'pack', packedAt: new Date(2026, 8, 28).getTime() } }))).toEqual({ text: 'packed Sep 28' });
    expect(sourceText(row('a', { source: { kind: 'pack', packedAt: null } }))).toEqual({ text: 'a pack made elsewhere' });
  });
});

describe('the reports', () => {
  it('colours a divergence as the mock does: the golden\'s line, then what was and what is', () => {
    const lines = reportLines(divergence('refund-in-limit').text);
    expect(lines.map((l) => l.tone)).toEqual(['no', '', '', 'del', 'add']);
    expect(lines[0].text).toBe('✗ refund-in-limit: diverged at call 1 (api POST /v1/messages)');
  });

  it('prints a failed check, a non-zero exit or no calls as test --markdown does', () => {
    const f: FailureView = {
      golden: 'goldens/refund-over-limit',
      name: 'refund-over-limit',
      runId: null,
      failure: 'check',
      reason: 'check failed: issue_refund called 0 times, but called 1 time',
      checks: [
        { ok: false, label: 'issue_refund called 0 times', detail: 'called 1 time' },
        { ok: true, label: 'exits 0', detail: null },
      ],
      details: '⑂ Forked at call 5: 4 calls replayed, then 4 live\n',
      output: 'Issuing the refund.\nDone.',
      blocked: null,
      bisect: null,
      found: null,
      missed: null,
      revisions: [],
      unreadable: null,
    };
    expect(failureLines(f)).toEqual([
      { text: '✗ refund-over-limit: check failed: issue_refund called 0 times, but called 1 time', tone: 'no' },
      { text: '    ✗ issue_refund called 0 times: called 1 time', tone: 'no' },
      { text: '    ✓ exits 0', tone: '' },
      { text: '    ⑂ Forked at call 5: 4 calls replayed, then 4 live', tone: '' },
      { text: '    │ Issuing the refund.', tone: 'dim' },
      { text: '    │ Done.', tone: 'dim' },
    ]);
    expect(failureHint(f)).toBe('A failed check means the agent did something its checks in shadowlap.config.json rule out. Fix the agent; the golden is right.');
  });

  it('says each check under a golden as the CLI does: passed, failed, inconclusive or not applicable', () => {
    expect(checkReportLine({ status: 'not-applicable', ok: true, label: 'when lookup_order has result.total > 200: escalate called at least 1 time', detail: 'the condition never held' })).toEqual({ text: '    – when lookup_order has result.total > 200: escalate called at least 1 time: not applicable · the condition never held', tone: '' });
    // Inconclusive in amber, as the CLI's reports and every page colour it.
    expect(checkReportLine({ status: 'inconclusive', ok: false, label: 'judge "explains" answers yes', detail: 'not judged: no recorded verdict' })).toEqual({ text: '    ? judge "explains" answers yes: inconclusive · not judged: no recorded verdict', tone: 'y' });
    expect(checkReportLine({ status: 'failed', ok: false, label: 'judge "explains" answers yes', detail: 'it answered no', reason: 'the reply never says why' })).toEqual({ text: '    ✗ judge "explains" answers yes: it answered no · the reply never says why', tone: 'no' });
    // A result kept before checks had a status reads as its ok says.
    expect(checkReportLine({ ok: true, label: 'exits 0', detail: null })).toEqual({ text: '    ✓ exits 0', tone: '' });
    expect(checkReportLine({ ok: false, label: 'exits 0', detail: 'exited 1' })).toEqual({ text: '    ✗ exits 0: exited 1', tone: 'no' });
  });

  it('says a connection the network guard blocked is what the agent tripped on', () => {
    const f: FailureView = {
      golden: 'goldens/notify-ops',
      name: 'notify-ops',
      runId: null,
      failure: 'exit',
      reason: 'the agent exited with code 1',
      checks: null,
      details: '✓ Replay clean: 1/1 calls replayed',
      output: '[shadowlap] blocked an outbound connection to hooks.example.com:443: it bypasses Shadowlap (SHADOWLAP_GUARD=block).',
      blocked: ['hooks.example.com:443'],
      bisect: null,
      found: null,
      missed: null,
      revisions: [],
      unreadable: null,
    };
    expect(failureHint(f)).toBe('The agent connected to hooks.example.com:443 directly, past Shadowlap, and CI replays offline, so the network guard blocked it. Wrap the call as a tool so it is recorded, or allow it with SHADOWLAP_GUARD_ALLOW=hooks.example.com:443.');
    expect(failureHint({ ...f, blocked: null })).toBe('The agent exited with an error while it replayed: its last lines of output are above.');
  });

  it('names checks in the table as the mock does, and leaves any other label as the CLI wrote it', () => {
    expect(['issue_refund called 0 times', 'escalate called 1 time', 'send_email with {"to":"a@b.c"} called 1 time', 'at most 6000 input tokens', 'at least 1 output token', 'cost at most $0.02', 'issue_refund called 2 times', 'at most 3 model calls', 'cost exactly $0.50', 'final answer includes "refund"'].map(checkWords)).toEqual([
      'issue_refund never called',
      'escalate called once',
      'send_email with {"to":"a@b.c"} called once',
      'input tokens ≤ 6,000',
      'output tokens ≥ 1',
      'cost ≤ $0.02',
      'issue_refund called 2 times',
      'at most 3 model calls',
      'cost exactly $0.50',
      'final answer includes "refund"',
    ]);
  });

  it('names what Find the commit found, with who, when and its cost', () => {
    expect(foundLine({ rev: '4e7b2d1', subject: 'Send the user id with every request', author: 'Ravi', date: '2026-09-30T09:30:00+02:00', why: '', untested: [], replays: 3, tokens: 0, at: T })).toEqual({ rev: '4e7b2d1', subject: 'Send the user id with every request', meta: 'Ravi · Sep 30 · 0 tokens' });
    expect(shortDate('not a date')).toBe('not a date');
    expect(dayClock(T)).toBe('Oct 1, 10:02');
  });
});

describe('the buttons under a divergence', () => {
  it('lead with the normalizer for a value made anew on every run', () => {
    expect(divergenceButtons(divergence('a'), all)).toEqual({ normalize: { label: 'Add normalizer and re-run', lead: true, run: 'normalize' }, update: { lead: false }, bisect: { range: true, live: false }, maybeReal: false, note: null });
  });

  it('lead with neither fix for an id that may be a real change, and say so', () => {
    const b = divergenceButtons(divergence('a', { maybeReal: true, normalizerFixes: false, volatile: { ...UUID, certain: false } }), all);
    expect(b.normalize).toEqual({ label: 'Add normalizer and re-run', lead: false, run: 'normalize' });
    expect(b.note).toBe('maybe-real');
  });

  it('ask before an Add normalizer that updates the golden too, and offer none for another change', () => {
    const updates = divergence('a', { normalizerFixes: false, normalizeAndTest: [['normalize', 'add', '--path', '$.id', '--replace', '<ID>'], ['test', 'goldens/a', '--update']] });
    expect(divergenceButtons(updates, all).normalize).toEqual({ label: 'Add normalizer and update', lead: false, run: 'normalize-update' });
    const prompt = divergence('a', { volatile: null, normalizerFixes: false, normalizeAndTest: null });
    expect(divergenceButtons(prompt, all)).toMatchObject({ normalize: null, update: { lead: false }, note: null });
  });

  it('only re-run once the rule is in the config, and say why', () => {
    expect(divergenceButtons(divergence('a', { rulesAdded: true }), all)).toMatchObject({ normalize: { label: 'Re-run', lead: true, run: 'rerun' }, note: 'rules-added' });
    const updates = divergence('a', { rulesAdded: true, normalizerFixes: false, normalizeAndTest: [['normalize', 'add', '--path', '$.id', '--replace', '<ID>'], ['test', 'goldens/a', '--update']] });
    expect(divergenceButtons(updates, all)).toMatchObject({ normalize: null, note: 'rules-added-update' });
  });

  it('leave out Find the commit once it found the commit, and what the server does not run', () => {
    const found = divergence('a', { found: { rev: '4e7b2d1', subject: 's', author: 'a', date: '', why: '', untested: [], replays: 3, tokens: 0, at: T } });
    expect(divergenceButtons(found, all).bisect).toBeNull();
    expect(divergenceButtons(divergence('a', { bisect: null }), all).bisect).toEqual({ range: false, live: false });
    expect(divergenceButtons(divergence('a'), (k) => k === 'test')).toMatchObject({ normalize: null, update: null, bisect: null });
  });

  it('ask for an older good commit once a search over the known range named none, and offer none for a pack that can’t be read', () => {
    const missed = divergence('a', { missed: { why: 'it already fails at c91d0f4', good: 'c91d0f4', bad: 'd2e8a1f', outcome: 'fails-at-good', at: T } });
    expect(divergenceButtons(missed, all).bisect).toEqual({ range: false, live: false });
    expect(missedLine(missed.missed!)).toBe('No first bad commit between c91d0f4 and d2e8a1f: it already fails at c91d0f4');
    expect(missedLine({ why: 'interrupted', good: null, bad: null, outcome: null, at: T })).toBe('No first bad commit: interrupted');
    const failure = { found: null, missed: null, bisect: null, unreadable: "run.json can't be read" };
    expect(findCommitButton(failure, all)).toBeNull();
    expect(findCommitButton({ ...failure, unreadable: null }, all)).toEqual({ range: false, live: false });
    expect(findCommitButton({ ...failure, unreadable: null }, (k) => k !== 'bisect')).toBeNull();
  });

  it('offer no other good commit once a search found it passing where it fails: the failure is in no commit', () => {
    const passes = { why: 'it passes at dd06624, so there is nothing to find', good: 'bff4146', bad: 'dd06624', outcome: 'passes-at-bad' as const, at: T };
    expect(divergenceButtons(divergence('a', { missed: passes }), all).bisect).toBeNull();
    expect(missedLine(passes)).toBe('No first bad commit: it passes at dd06624 as committed, so the failure is in changes not committed there, or doesn’t happen every time');
  });
});

describe('Find the commit’s dialog', () => {
  const revisions = [
    { rev: 'ddd4444', at: T, result: 'fail' as const, verdict: 'failed' as const, sameChecks: true, subject: 'Send the user id with every request' },
    { rev: 'ccc3333', at: T - 60_000, result: 'pass' as const, verdict: 'passed' as const, sameChecks: true, subject: 'Escalate refunds above the limit' },
    { rev: 'bbb2222', at: T - 120_000, result: 'pass' as const, verdict: 'passed' as const, sameChecks: false, subject: null },
    { rev: 'aaa1111', at: T - 180_000, result: 'pass' as const, verdict: 'passed' as const, sameChecks: true, subject: 'Initial support agent' },
  ];

  it('offers each commit the golden was tested at by its subject, as the mock words it, starting on the newest that passed', () => {
    const c = revisionChoices(revisions);
    expect(c.options).toEqual([
      { value: 'ddd4444', label: 'ddd4444 · Send the user id with every request · failed here' },
      { value: 'ccc3333', label: 'ccc3333 · Escalate refunds above the limit' },
      { value: 'bbb2222', label: 'bbb2222 · Oct 1 · passed under other checks' },
      { value: 'aaa1111', label: 'aaa1111 · Initial support agent' },
    ]);
    expect(c.initial).toBe('ccc3333');
  });

  it('says inconclusive, never failed, at a commit where the golden came out neither passed nor failed', () => {
    // Its gate ran out of attempts between its bounds at bbb2222: no pass to start from there, and no failure either.
    const unsure = [revisions[0], { ...revisions[1], result: 'fail' as const, verdict: 'inconclusive' as const }, revisions[3]];
    const c = revisionChoices(unsure);
    expect(c.options.map((o) => o.label)).toEqual(['ddd4444 · Send the user id with every request · failed here', 'ccc3333 · Escalate refunds above the limit · inconclusive here', 'aaa1111 · Initial support agent']);
    expect(c.initial).toBe('aaa1111');
  });

  it('starts on an older commit than the one a search already failed at', () => {
    expect(revisionChoices(revisions, 'ccc3333').initial).toBe('aaa1111');
    expect(revisionChoices(revisions, 'aaa1111').initial).toBe('');
    expect(revisionChoices([], null)).toEqual({ options: [], initial: '' });
  });

  it('writes the command as a person types it: a placeholder and HEAD~3 unquoted', () => {
    expect(commandText(['bisect', 'goldens/x', '--good', '<commit>'])).toBe('shadowlap bisect goldens/x --good <commit>');
    expect(commandText(['bisect', 'goldens/x', '--good', 'HEAD~3'])).toBe('shadowlap bisect goldens/x --good HEAD~3');
    expect(commandText(['bisect', 'goldens/x', '--good', '~/x', '--good', 'HEAD^'])).toBe("shadowlap bisect goldens/x --good '~/x' --good 'HEAD^'");
  });
});

describe('waiting for a test job', () => {
  it('waits while a job that replays or rewrites the goldens runs in this project, and names it', () => {
    // A search of a run touches no golden; one of a golden does.
    const jobs = [{ kind: 'bisect', args: ['bisect', '01K5CQ4V5K0000000000000002', '--good', 'c91d0f4', '--fork'], done: false }, { kind: 'test', done: true }];
    expect(testsBusy(jobs, 'run the tests')).toBeNull();
    expect(testsBusy([{ kind: 'bisect', args: ['bisect', 'goldens/refund-in-limit', '--good', 'c91d0f4'], done: false }], 'run the tests')).toBe('Find breaking commit is running: run the tests once it is done.');
    expect(testsBusy([...jobs, { kind: 'test-update', done: false }], 'run the tests')).toBe('An update of goldens is running: run the tests once it is done.');
    expect(testsBusy([{ kind: 'normalize-and-test', done: false }], 'update it')).toBe('A normalizer and its re-run is running: update it once it is done.');
    // Another project's job doesn't hold this one's goldens.
    expect(testsBusy([{ kind: 'test', done: false, project: { id: 'other' } }], 'run the tests', 'this')).toBeNull();
    expect(testsBusy([{ kind: 'test', done: false, project: { id: 'this' } }], 'run the tests', 'this')).toBe('A test session is running: run the tests once it is done.');
    expect(runningTests([{ kind: 'test', done: true }, { kind: 'test', done: false }])).toEqual({ kind: 'test', done: false });
  });

  it('waits while a test session started in a terminal runs, naming its command', () => {
    expect(sessionWait(null, 'run the tests')).toBeNull();
    expect(sessionWait({ running: null }, 'run the tests')).toBeNull();
    const running = { id: 's', command: 'shadowlap test goldens/*', revision: 'abc1234', startedAt: T, endedAt: null, passed: 1, failed: 0, inconclusive: 0, upstreamRequests: 0, actor: null, interrupted: false, live: true };
    expect(sessionWait({ running }, 'update it')).toBe('shadowlap test goldens/* is running: update it once it is done.');
    // A long one is cut short.
    expect(sessionWait({ running: { ...running, command: `shadowlap test ${'goldens/very-long-name '.repeat(5)}` } }, 'update it')).toBe('shadowlap test goldens/very-long-name goldens/very-long-nam… is running: update it once it is done.');
    // Error-path presets on goldens replay their packs too: the actions wait for them as the server does.
    const presets = { id: 'c', command: 'shadowlap test goldens/* --chaos', startedAt: T };
    expect(sessionWait({ running: null, chaosRunning: presets }, 'run the tests')).toBe('shadowlap test goldens/* --chaos is running: run the tests once it is done.');
    expect(sessionWait({ running, chaosRunning: presets }, 'update it')).toBe('shadowlap test goldens/* is running: update it once it is done.');
    expect(sessionWait({ running: null, chaosRunning: null }, 'update it')).toBeNull();
  });
});

describe('the Update golden dialog', () => {
  it('asks the judge once for a golden that replays clean and only lacks its verdict, re-recording nothing', () => {
    const judge: UnjudgedCheck = { name: 'explains-escalation', label: 'judge "explains-escalation" answers yes', model: 'claude-haiku-4-5', provider: 'anthropic', why: 'not judged: no recorded verdict and the test runs offline', held: 'none', changed: null, update: ['test', 'goldens/judged', '--update'], keys: null };
    const v = view({ divergences: [], diverged: [], rows: [row('judged')], inconclusive: [{ golden: 'goldens/judged', name: 'judged', runId: null, reason: 'check inconclusive', checks: [], details: null, gate: null, judge }] });
    const plan = updatePlan(v, ['goldens/judged']);
    // As the mock's dialog has it: no card, since nothing diverged and the title names the golden.
    expect(plan).toMatchObject({ title: 'Update judged?', goldens: [], advise: null, instead: null, note: null, command: 'shadowlap test goldens/judged --update', ok: 'Update golden' });
    expect(plan.text).toBe('Its replay is clean: only its judge check has no verdict in the pack. Updating asks the judge once, live, with the Anthropic key in the dashboard’s environment, and keeps the verdict; nothing is re-recorded.');
    // A judge whose model names no provider is asked with whatever key its model needs.
    expect(updatePlan(view({ ...v, inconclusive: [{ ...v.inconclusive[0], judge: { ...judge, provider: null } }] }), ['goldens/judged']).text).toContain('Updating asks the judge once, live, with the key in the dashboard’s environment, and keeps the verdict');
    expect(plan.steps).toEqual([
      ['Replayed offline, as recorded', 'clean'],
      ['Its judge asked once, live', 'claude-haiku-4-5'],
      ['Its verdict kept in the pack', 'the next test judges from it, free'],
      ['You review the change', 'in your pull request'],
    ]);
  });

  it('words the judge\'s update by what its pack holds: an older form of the request, or other material, where a normalizer comes first', () => {
    const judge: UnjudgedCheck = { name: 'explains-escalation', label: 'judge "explains-escalation" answers yes', model: 'claude-haiku-4-5', provider: 'anthropic', why: '', held: 'older', changed: null, update: ['test', 'goldens/judged', '--update'], keys: null };
    const plan = (j: UnjudgedCheck) => updatePlan(view({ divergences: [], diverged: [], rows: [row('judged')], inconclusive: [{ golden: 'goldens/judged', name: 'judged', runId: null, reason: 'check inconclusive', checks: [], details: null, gate: null, judge: j }] }), ['goldens/judged']);
    const older = plan(judge);
    expect(older).toMatchObject({ title: 'Update judged?', goldens: [], advise: null, ok: 'Update golden', command: 'shadowlap test goldens/judged --update' });
    expect(older.text).toBe('Its replay is clean: only its judge check’s verdict in the pack was given to an older form of the judge’s request, which a replay no longer sends. Updating asks the judge once, live, with the Anthropic key in the dashboard’s environment, and keeps its new verdict; nothing is re-recorded.');
    const material = plan({ ...judge, held: 'material', changed: 'it read "order 8f3a" where it now reads "order 1b2c"' });
    expect(material.text).toBe('Its replay is clean, but its judge check’s verdict in the pack was given on other material than the replay reads now. Updating asks the judge once, live, with the Anthropic key in the dashboard’s environment, and keeps its new verdict; nothing is re-recorded.');
    // The amber box names the normalizer as the lasting fix, with what changed, as a divergence's does.
    expect(material.advise).toEqual({ title: 'A value that changes every run needs a normalizer', text: 'What the judge reads changed: it read "order 8f3a" where it now reads "order 1b2c". If that is such a value (an id the agent prints, say), add a normalizer for it first: a verdict given on one run’s value answers no other, and the next test reads not judged again.', path: null });
    expect(material.ok).toBe('Update anyway');
    expect(material.steps[2]).toEqual(['Its verdict kept in the pack', 'for what it reads now']);
    for (const p of [older, material]) expect(p.text).not.toContain('has no verdict');
  });

  it('shows one golden as a card, its checks, the amber note naming the path, and Update anyway', () => {
    const plan = updatePlan(view(), ['goldens/refund-in-limit']);
    expect(plan.title).toBe('Update refund-in-limit?');
    expect(plan.goldens).toEqual([{ path: 'goldens/refund-in-limit', name: 'refund-in-limit', where: 'diverged at call 1' }]);
    expect(plan.steps).toEqual([
      ['Re-recorded live', 'writes stubbed'],
      ['Its checks run', '2 checks'],
      ['Replaced only if they pass', 'in your working tree'],
      ['You review the change', 'in your pull request'],
    ]);
    expect(plan.advise).toEqual({ title: 'A normalizer fixes this for good', path: '$.metadata.user_id', text: 'looks like a UUID, which changes every run. Updating re-records it, and the next run diverges again.' });
    expect(plan.instead).toEqual({ label: 'Add normalizer and re-run', golden: 'goldens/refund-in-limit', run: 'normalize' });
    expect(plan.note).toBeNull();
    expect(plan.command).toBe('shadowlap test goldens/refund-in-limit --update');
    expect(plan.ok).toBe('Update anyway');
  });

  it('lists several goldens, and says which diverged on values that change every run', () => {
    const v = view({ divergences: [divergence('refund-in-limit'), divergence('escalate-over-limit', { volatile: null, normalizerFixes: false, normalizeAndTest: null, callNo: 3 })], diverged: ['goldens/refund-in-limit', 'goldens/escalate-over-limit'] });
    const plan = updatePlan(v, v.diverged);
    expect(plan.title).toBe('Update 2 diverged goldens?');
    expect(plan.goldens.map((g) => g.where)).toEqual(['diverged at call 1', 'diverged at call 3']);
    expect(plan.steps[1]).toEqual(['Each one’s checks run', 'per golden']);
    expect(plan.advise).toEqual({ title: 'A normalizer fixes this for good', path: null, text: 'refund-in-limit diverged on values that change every run. Updating re-records it, and the next run diverges again.' });
    // The amber box's button is for one golden: here each has its own panel.
    expect(plan.instead).toBeNull();
  });

  it('plainly offers Update for a change that was meant, and counts a golden with no checks by its exit status', () => {
    const v = view({ divergences: [divergence('escalate-over-limit', { volatile: null, normalizerFixes: false, normalizeAndTest: null })], diverged: ['goldens/escalate-over-limit'] });
    const plan = updatePlan(v, ['goldens/escalate-over-limit']);
    expect(plan.advise).toBeNull();
    expect(plan.ok).toBe('Update golden');
    expect(plan.steps[1]).toEqual(['Its checks run', 'exit status']);
    // An id that may be a real change gets no amber note: only the person knows.
    const maybe = view({ divergences: [divergence('refund-in-limit', { maybeReal: true, volatile: { ...UUID, certain: false } })] });
    expect(updatePlan(maybe, ['goldens/refund-in-limit']).advise).toBeNull();
  });

  it('offers the rule and the update it still needs, when the rule alone can\'t make the replay match', () => {
    const added = divergence('refund-in-limit', { volatile: { ...UUID, op: 'added' }, normalizerFixes: false, normalizeAndTest: [['normalize', 'add', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/refund-in-limit', '--update']] });
    const plan = updatePlan(view({ divergences: [added] }), ['goldens/refund-in-limit']);
    expect(plan.advise!.text).toBe('is new in every request and looks like a UUID, which changes every run. Updating re-records it, and the next run diverges again.');
    expect(plan.instead).toEqual({ label: 'Add normalizer and update', golden: 'goldens/refund-in-limit', run: 'normalize-update' });
    // A server that doesn't run normalize-and-test gets the note, and no button that would do nothing.
    expect(updatePlan(view({ divergences: [added] }), ['goldens/refund-in-limit'], (k) => k !== 'normalize-and-test').instead).toBeNull();
  });

  it('says a re-run passes once the rule is in the config, and offers that instead of a normalizer', () => {
    // The rule was added for another golden since this one's replay: alone it makes the replay match.
    const plan = updatePlan(view({ divergences: [divergence('refund-in-limit', { rulesAdded: true })] }), ['goldens/refund-in-limit']);
    expect(plan.advise).toEqual({ title: 'Its normalizer is in the config now', path: '$.metadata.user_id', text: 'is masked by a rule added since this replay, so a re-run passes without an update.' });
    expect(plan.instead).toEqual({ label: 'Re-run instead', golden: 'goldens/refund-in-limit', run: 'rerun' });
    expect(plan.ok).toBe('Update anyway');
    expect(updatePlan(view({ divergences: [divergence('refund-in-limit', { rulesAdded: true })] }), ['goldens/refund-in-limit'], (k) => k !== 'test').instead).toBeNull();
  });

  it('says an update is the fix once the rule is in the config and alone can\'t make the replay match', () => {
    // The panel says so too ("update the golden"), and offers no normalizer: the dialog agrees with it.
    const left = divergence('limit-two', { rulesAdded: true, volatile: { ...UUID, op: 'added' }, normalizerFixes: false, normalizeAndTest: [['normalize', 'add', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/limit-two', '--update']] });
    const v = view({ rows: [row('limit-two', { checks: ['issue_refund called 1 time'] })], divergences: [left], diverged: ['goldens/limit-two'] });
    const plan = updatePlan(v, ['goldens/limit-two']);
    expect(divergenceButtons(left, all).normalize).toBeNull();
    expect(plan.advise).toBeNull();
    expect(plan.instead).toBeNull();
    expect(plan.note).toEqual(['The normalizer for ', { code: '$.metadata.user_id' }, ' is in shadowlap.config.json already', ', so the run after this update matches.']);
    expect(plan.ok).toBe('Update golden');
  });

  it('leaves goldens whose rules are in the config out of the amber note for several', () => {
    const fresh = divergence('refund-in-limit');
    const rerun = divergence('refund-flow', { rulesAdded: true });
    const left = divergence('limit-two', { rulesAdded: true, normalizerFixes: false, normalizeAndTest: [['normalize', 'add', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/limit-two', '--update']] });
    const v = view({ divergences: [fresh, rerun, left], diverged: [fresh.golden, rerun.golden, left.golden] });
    const plan = updatePlan(v, v.diverged);
    expect(plan.advise!.text).toBe('refund-in-limit diverged on values that change every run. Updating re-records it, and the next run diverges again.');
    expect(plan.note).toEqual(['The normalizers for refund-flow are in shadowlap.config.json now: a re-run passes without updating it.']);
    expect(plan.ok).toBe('Update anyway');
    // All of them masked already: no amber note, and the update reads plainly, naming how many it updates.
    const masked = view({ divergences: [left, { ...left, golden: 'goldens/limit-three', name: 'limit-three' }], diverged: [left.golden, 'goldens/limit-three'] });
    expect(updatePlan(masked, masked.diverged)).toMatchObject({ advise: null, instead: null, note: null, ok: 'Update 2 goldens' });
  });

  it('quotes what a shell would need quoting in the command', () => {
    expect(commandText(['test', 'goldens/my golden', '--update'])).toBe("shadowlap test 'goldens/my golden' --update");
    expect(commandText(['test', 'goldens/*'])).toBe('shadowlap test goldens/*');
  });
});

describe('the palette', () => {
  it('lists each golden by how it did last, from any page, and Update goldens… when any diverged', () => {
    // A golden whose gate ran out of attempts between its bounds reads as not passing (`result`), and is inconclusive, never failed.
    const unsure = row('refund-flaky', { last: { result: 'fail', verdict: 'inconclusive', failure: 'inconclusive', line: 'inconclusive · 16 of 20 passed', at: T, updated: false, gate: null } });
    const entries = testsPalette(view({ rows: [...view().rows, unsure, row('broken', { last: { result: null, verdict: null, failure: null, line: "can't be read: no run.json", at: null, updated: false, gate: null }, error: 'no run.json' }), row('new-one', { last: { result: null, verdict: null, failure: null, line: 'not run yet', at: null, updated: false, gate: null } })] }), { update: true });
    expect(entries.map((e) => [e.group, e.label, e.hint, e.to])).toEqual([
      ['Actions', 'Update goldens…', 'shadowlap test --update', '#/tests?update'],
      ['Tests', 'refund-over-limit', 'passed', '#/tests'],
      ['Tests', 'refund-in-limit', 'failed', '#/tests'],
      ['Tests', 'escalate-over-limit', 'passed', '#/tests'],
      ['Tests', 'refund-flaky', 'inconclusive', '#/tests'],
      ['Tests', 'broken', 'can’t be read', '#/tests'],
      ['Tests', 'new-one', 'not run yet', '#/tests'],
    ]);
    // Without the job, read-only, or with nothing diverged: the goldens alone.
    expect(testsPalette(view(), { update: false }).some((e) => e.group === 'Actions')).toBe(false);
    expect(testsPalette(view({ diverged: [] }), { update: true }).some((e) => e.group === 'Actions')).toBe(false);
    // Before the first answer, and with no goldens: nothing.
    expect(testsPalette(null, { update: true })).toEqual([]);
    expect(testsPalette(view({ empty: true, rows: [] }), { update: true })).toEqual([]);
  });

  it('asks Tests for Update goldens… by its address, which nothing else matches', () => {
    expect(TESTS_UPDATE_HASH).toBe('#/tests?update');
    expect(['#/tests?update', '#/tests?x=1&update', '#/tests?update=1', '#/tests?update&x'].map(asksUpdate)).toEqual([true, true, true, true]);
    expect(['#/tests', '#/tests?updates', '#/runs?update', '#/tests?q=update', '#/tests/update'].map(asksUpdate)).toEqual([false, false, false, false, false]);
  });
});

describe('the jobs the screen starts', () => {
  it('says whether Find the commit found it', () => {
    expect(jobStatus({ args: ['bisect'], done: true, code: 0 }, ['  replay at 7f20b6a  diverged at call 1', '✓ first bad commit 4e7b2d1 · Send the user id with every request · Ravi · 2026-09-30', '  2 checks passed'])).toEqual({ text: 'found · exit 0', tone: 'ok' });
    expect(jobStatus({ args: ['bisect'], done: true, code: 1 }, ['✗ no first bad commit: every commit in the range passes'])).toEqual({ text: 'not found · exit 1', tone: 'warn' });
  });

  it('ends a test job on its totals, whatever its replays printed before them', () => {
    // An update whose new recording diverged again: its replay forked and the agent died offline.
    const update = ['▸ escalate-over-limit · re-recording live, writes stubbed', '✗ escalate-over-limit: diverged at call 2 (api POST /v1/messages)', '    ⑂ Forked at call 2: 1 calls replayed, then 1 live; 0 upstream requests', '      the agent process exited with an error', '', '0 passed, 1 failed · 4 upstream requests'];
    expect(jobStatus({ args: ['test'], done: true, code: 1 }, update)).toEqual({ text: '1 failed · exit 1', tone: 'err' });
    // Add normalizer and re-run: two commands, the test's totals last.
    expect(jobStatus({ args: ['normalize'], done: true, code: 0 }, ['$ shadowlap test goldens/a', '✓ a: 10/10 replayed, 2 checks passed', '', '1 passed, 0 failed · 0 upstream requests'])).toEqual({ text: '1 passed · exit 0', tone: 'ok' });
    expect(jobStatus({ args: ['test'], done: true, code: 0 }, ['4 passed, 0 failed · 17 upstream requests'])).toEqual({ text: '4 passed · exit 0', tone: 'ok' });
  });

  it('says a stopped session was interrupted, not that it passed or failed', () => {
    const stopped = ['✓ refund-flow: 8/8 replayed', '⏹ refund-in-limit: interrupted, so it has no result this time', '', '1 passed, 0 failed, 3 not run: interrupted · 0 upstream requests'];
    expect(jobStatus({ args: ['test'], done: true, code: 143 }, stopped)).toEqual({ text: 'interrupted · exit 143', tone: 'warn' });
    expect(jobStatus({ args: ['test'], done: true, code: 130 }, ['0 passed, 0 failed · 0 upstream requests'])).toEqual({ text: 'interrupted · exit 130', tone: 'warn' });
  });

  it('asks the CI endpoint for the panels\' options, leaving out what is not set', () => {
    expect(ciQuery()).toBe('');
    expect(ciQuery({ fix: true, budget: '5.00', repairer: 'openai:gpt-5', onlyMain: false, secret: 'TEAM_HOOK' })).toBe('?fix=on&budget=5.00&repairer=openai%3Agpt-5&onlyMain=off&secret=TEAM_HOOK');
    // An inconclusive golden's control, Fails or Warns: the server takes it as it is.
    expect(ciQuery({ inconclusive: 'warn' })).toBe('?inconclusive=warn');
  });
});
