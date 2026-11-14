import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateResult, Store, type StoredCheck } from '@shadowlap/engine';
import { UNGUARDED_FIX } from '../../cli/src/doctor.js';
import { failedRunsHref, goldenReports, switchCause, takenOutLines, withFailedRuns, withStepHints, type TestsAnswer } from '../src/golden-report.js';
import { issueKey } from '../src/issue-keys.js';
import { links } from '../src/links.js';
import type { NextStep } from '../src/next-step.js';
import { testsView, type GoldenSource } from '../src/tests.js';
import type { Client } from '../ui/api.js';
import { pageUp } from '../ui/focus-manager.js';
import { ISSUE_ASK } from '../ui/page-ask.js';
import { moreCard, updateCard } from '../ui/pages/tests-cards.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { AppContext, type AppState } from '../ui/state.js';
import { Proof } from '../ui/injection/Proof.js';
import { SecurityReportDialog } from '../ui/injection/SecurityReportDialog.js';
import { ServedPartsContext, type ServedParts } from '../ui/served-parts.js';
import { goldenRowScope } from '../ui/tests/row-scope.js';
import { ReportSteps } from '../ui/tests/ReportSteps.js';
import type { LeadPress } from '../ui/tests/Verdict.js';
import { shownNow } from './ui-served-now.js';
import { failedRunsWords } from '../ui/failed-runs.js';
import type { RequestDiff } from '../src/request-diff.js';
import type { DivergenceView, GoldenReport, GoldenRow, TestEvidence } from '../ui/types.js';
import { FoldedLines } from '../ui/tests/ErrorPart.js';
import { drawsFindCommit, stepFor } from '../ui/tests/lead.js';
import { ReportParts } from '../ui/tests/ReportParts.js';
import { askedReport, openReports, reportOpen, setAttemptsShown, setReportOpen, shownAttempts } from '../ui/tests/report-open.js';
import { hintWords, reportHint } from '../ui/tests/report-words.js';
import { render, shownText, type FakeElement, type Rendered } from './ui-render.js';

/**
 * A golden's report as Tests draws it under its row: the one sentence of why under its next steps,
 * by the key the server gives it (ui/tests/report-words.ts). What each button does and costs is its
 * hover, so no hint runs on to a second sentence; a fix it can't leave out follows a colon.
 */
describe('a report’s hint', () => {
  it('says why in one sentence for each kind of golden that didn’t pass', () => {
    expect(hintWords({ key: 'normalizer' })).toBe('Normalizers apply at match time, so older goldens keep working.');
    expect(hintWords({ key: 'bisect' })).toBe('Find breaking commit names the one where it started.');
    expect(hintWords({ key: 'check' })).toBe('The agent did what its checks rule out: fix the agent, not the golden.');
    expect(hintWords({ key: 'crash' })).toBe('The agent stopped part way, so its checks say little.');
    expect(hintWords({ key: 'injection' })).toBe('The agent obeyed an instruction planted in what it reads: fix the agent, not the golden.');
    expect(hintWords({ key: 'gate' })).toBe("Neither verdict holds at the gate's stated risk yet: more attempts settle it, not a change to the agent.");
    expect(hintWords({ key: 'error' })).toBe('The golden could not be replayed.');
    for (const key of ['normalizer', 'switch', 'bisect', 'check', 'crash', 'injection', 'gate', 'undecided', 'no-calls', 'no-preload', 'error', 'checks-changed', 'edit-check'] as const) expect(hintWords({ key }).split(/[.?](?: |$)/).filter(Boolean)).toHaveLength(1);
  });

  it('says only why Update golden leads for a golden recorded before a migration’s switch, whose cause its Request line says', () => {
    expect(hintWords({ key: 'switch' })).toBe('A golden recorded before the switch diverges on it: update it once the switch is what you meant.');
  });

  it('says what a golden whose checks lead it should do, from its step: Run tests, or edit a check its own recording fails', () => {
    expect(hintWords({ key: 'checks-changed' })).toBe('Run tests judges its checks as they are now.');
    expect(hintWords({ key: 'edit-check' })).toBe('The check, added since, fails the golden’s own recording: edit the check, or update the golden if the agent should now do this.');
  });

  it('says what to do with a crash’s first bad commit once it is named', () => {
    expect(reportHint({ hint: { key: 'crash' }, parts: [{ kind: 'commit', found: {} as never }] })).toBe('The agent stopped part way at the commit above: revert it or fix the code, then run the tests.');
    expect(reportHint({ hint: null, parts: [] })).toBeNull();
  });

  it('says a judge check wasn’t judged in its first sentence, leaving Update golden to its hover', () => {
    expect(hintWords({ key: 'judge', held: 'none', name: 'polite' })).toBe('Its pack holds no verdict for the judge check polite, and the test replays offline.');
    expect(hintWords({ key: 'judge', held: 'older', name: 'polite' })).toMatch(/^The verdict its pack holds for the judge check polite was given to an older form of the judge’s request, .* so the judge can’t be asked\.$/);
    expect(hintWords({ key: 'judge-key', name: 'polite', model: 'claude-x', keys: ['ANTHROPIC_API_KEY', 'CLAUDE_KEY'] })).toBe('The test runs this golden live, and the judge check polite had no key to ask claude-x with: set ANTHROPIC_API_KEY (or CLAUDE_KEY) where the tests run, in CI as a secret, and run it again.');
  });

  it('keeps each guard case’s fix after a colon, doctor’s own words for a process it can’t watch', () => {
    expect(hintWords({ key: 'unguarded' }).replace(/’/g, "'")).toBe(`A process the network guard can't watch ran while the golden replayed, and under --guard block that fails it: ${UNGUARDED_FIX}`);
    const preload = hintWords({ key: 'no-preload' });
    expect(preload).toMatch(/^No Shadowlap preload loaded in the agent’s processes while the golden replayed, .*: run the agent/);
    expect(preload).toContain('shadowlap doctor');
    expect(preload).toContain('--guard warn');
    expect(hintWords({ key: 'blocked', hosts: ['api.stripe.com', 'hooks.slack.com'] })).toBe('The agent connected to api.stripe.com, hooks.slack.com directly, past Shadowlap, and CI replays offline, so the network guard blocked it: wrap the call as a tool so it is recorded, or allow it with SHADOWLAP_GUARD_ALLOW=api.stripe.com,hooks.slack.com.');
  });

  it('says what kept an injection gate from saying, by its reason, and what to do', () => {
    expect(hintWords({ key: 'injection-inconclusive', why: 'unanswered' })).toBe('A model call that got no answer says nothing about the agent: run it again once the provider answers.');
    expect(hintWords({ key: 'injection-inconclusive', why: 'no-reads' })).toBe('Nothing it reads is marked untrusted, so nothing was planted: mark a read untrusted, then run it again.');
    expect(hintWords({ key: 'injection-inconclusive', why: 'stopped' })).toBe('It stopped before its attempts were done: run it again with room to finish.');
    expect(hintWords({ key: 'injection-inconclusive', why: 'nothing' })).toBe('Nothing it ran showed what the agent does with a planted instruction: run it again.');
  });

  it('says a normalizer already in the config needs a re-run, or an update where the request carries more', () => {
    expect(hintWords({ key: 'rules-added', path: '$.metadata.user_id', update: false })).toBe('The normalizer for $.metadata.user_id is in shadowlap.config.json now: run the golden again to see it pass.');
    expect(hintWords({ key: 'rules-added', path: '$.metadata.user_id', update: true })).toMatch(/: update the golden\.$/);
  });
});

describe('Find breaking commit in a report’s hint', () => {
  const GOLDEN = 'goldens/drift';
  const diverged = (o: Partial<DivergenceView> = {}) => ({ golden: GOLDEN, found: null, missed: null, bisect: { good: 'c91d0f4', live: false }, unreadable: false, ...o }) as unknown as DivergenceView;
  const view = (d: DivergenceView, step?: NextStep) => ({ divergences: [d], failures: [], inconclusive: [], steps: step ? { [GOLDEN]: step } : {} }) as unknown as TestsAnswer;
  const has = () => true;

  it('names it only where the report draws it: never beside Update golden’s lead, after a search that found it passing, or once a commit is named', () => {
    // A divergence at $.system, $.model or $.tools: no commit explains it, so Update golden leads.
    expect(drawsFindCommit(view(diverged(), { key: 'update-golden', label: 'Update golden', golden: GOLDEN, test: null }), GOLDEN, has)).toBe(false);
    expect(drawsFindCommit(view(diverged({ missed: { why: '', good: 'c91d0f4', bad: 'd2e8a1f', outcome: 'passes-at-bad', at: 5 } })), GOLDEN, has)).toBe(false);
    expect(drawsFindCommit(view(diverged({ found: {} as DivergenceView['found'] })), GOLDEN, has)).toBe(false);
    expect(drawsFindCommit(view(diverged()), GOLDEN, () => false)).toBe(false);
    // With no passing revision known it asks for one, and is drawn.
    expect(drawsFindCommit(view(diverged({ bisect: null })), GOLDEN, has)).toBe(true);
    expect(drawsFindCommit(view(diverged(), { key: 'bisect', label: 'Find breaking commit', golden: GOLDEN } as NextStep), GOLDEN, has)).toBe(true);
    expect(reportHint({ hint: { key: 'bisect' }, parts: [] }, { findsCommit: false })).toBeNull();
    expect(reportHint({ hint: { key: 'bisect' }, parts: [] }, { findsCommit: true })).toBe('Find breaking commit names the one where it started.');
  });

  it('hovers Re-run test of an injection gate with the server’s words for its step', () => {
    const v = { divergences: [], failures: [], inconclusive: [], steps: { 'goldens/research': { key: 'gate-again', label: 'Re-run test', golden: 'goldens/research', command: 'shadowlap test goldens/research', sub: 'Its injection gate showed too little to say: a model call got no answer' } } } as unknown as TestsAnswer;
    expect(stepFor(v, 'goldens/research', has, null)).toEqual({ kind: 'rerun', label: 'Re-run test', golden: 'goldens/research', sub: 'Its injection gate showed too little to say: a model call got no answer', command: 'shadowlap test goldens/research' });
  });

  it('says what a link to failed runs opens as Fixes says it', () => {
    expect(failedRunsWords(['01K8RG01', '01K8RG02'], 7)).toBe('01K8RG01, 01K8RG02 and 5 more. Opens them on Runs, under Failed');
    expect(failedRunsWords(['01K8RG01'], 1)).toBe('01K8RG01. Opens it on Runs, under Failed');
  });
});

describe('a report asked for by a link', () => {
  it('reads the golden a link to its report names, as links write it, and nothing from another address', () => {
    expect(askedReport(links.tests({ report: 'refund-in-limit' }))).toBe('refund-in-limit');
    expect(askedReport(links.tests({ report: 'evals/kept elsewhere' }))).toBe('evals/kept elsewhere');
    expect(askedReport('#/tests?update&report=late%20refund')).toBe('late refund');
    expect(askedReport(links.tests())).toBeNull();
    expect(askedReport('#/runs?report=refund')).toBeNull();
    expect(askedReport('#/tests?report=%E0%A4%A')).toBeNull();
  });

  it('keeps a report open by its name until it is folded again', () => {
    setReportOpen('refund', true);
    expect(reportOpen('refund')).toBe(true);
    setReportOpen('refund', false);
    expect(reportOpen('refund')).toBe(false);
  });
});

describe('what moved from a report’s hint to its buttons’ hovers', () => {
  it('says what Run more attempts settles, and that Update golden asks a judge once and keeps its verdict', () => {
    const more = { args: ['test', 'goldens/flaky', '--max-attempts', '40', '--continue'], attempts: 40, most: 20, expected: 17.17, settles: 0.378 };
    expect(moreCard(more).sub).toBe('Raises its limit to 40 for this session only and carries its 20 attempts over. That settles it 38% of the time, in about 17 more.');
    expect(updateCard('goldens/judged', ['test', 'goldens/judged', '--update']).sub).toBe('Asks the judge once, live, and keeps its verdict in the pack: every test after judges from the recording, free');
    for (const held of ['older', 'material'] as const) expect(hintWords({ key: 'judge', held, name: 'polite' })).not.toContain('holds no verdict');
  });
});

const T0 = Date.UTC(2026, 9, 20, 10, 0);
const JUDGE = 'judge "polite" answers yes';
const TWICE = 'send_email called at most 1 time';
const PY_TAIL = ['Traceback (most recent call last):', '  File "/work/shop/refund_agent.py", line 141, in issue_refund', '    log.info("refund %s of %s", refund["refund_id"], order["total"])', "KeyError: 'total'"].join('\n');
const check = (label: string, status: StoredCheck['status'], detail?: string, extra: Partial<StoredCheck> = {}): StoredCheck => ({ label, ok: status === 'passed', status, ...(detail ? { detail } : {}), ...extra }) as StoredCheck;
const calls = (replayed: number, total = replayed) => ({ total, replayed, live: 0, blocked: 0, stubbed: 0 });

/**
 * Tests' answer over a store of four goldens that didn't pass, as GET /api/tests sends it: a crash
 * at call 19 of 30 (a Python tail), a divergence at call 1 a normalizer masks, which the replay
 * answered with the offline 503 the agent exited on, a judge check a
 * replay couldn't ask offline, and a fork golden whose gate ran out; each with its report.
 */
function answer(steps: Record<string, NextStep> = {}): TestsAnswer {
  const store = Store.open(':memory:');
  const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'abc1234', startedAt: T0 });
  const goldens: GoldenSource[] = [];
  const add = (name: string, checks: string[], result: Omit<Parameters<Store['addTestResult']>[0], 'sessionId' | 'golden' | 'runId'>, o: { mode?: 'replay' | 'fork'; divergence?: Parameters<Store['setDivergence']>[1]; refused?: number } = {}) => {
    const command = { argv: ['python', 'refund_agent.py'], cwd: '/work/shop' };
    const recording = store.createRun({ mode: 'record', command });
    const replay = store.createRun({ mode: 'replay', command, meta: { test: { golden: `goldens/${name}`, session: s.sessionId } } });
    if (o.divergence) store.setDivergence(replay.runId, o.divergence);
    if (o.refused) {
      // The call answered with the offline refusal, as `shadowlap test` records it, and the replay ended failed.
      const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'fp', occurrence: 1 };
      store.appendCallStart({ runId: replay.runId, callNo: o.refused, ...identity, origin: 'live', effect: null, requestRef: null, meta: {}, at: T0 });
      store.appendCallEnd(identity, { runId: replay.runId, callNo: o.refused, attempt: 0, responseRef: store.putJson(OFFLINE_BODY), outcome: 'error', meta: { status: 503, offline: true }, at: T0 });
      store.endRun(replay.runId, 'failed', T0);
    }
    store.addTestResult({ sessionId: s.sessionId, golden: `goldens/${name}`, runId: replay.runId, at: T0, ...result });
    goldens.push({ path: `goldens/${name}`, runId: recording.runId, packedAt: T0, mode: o.mode ?? 'replay', repeat: 1, passes: 1, checks });
  };
  add('refund', ['issue_refund called 1 time'], { ok: false, failure: 'exit', reason: 'the agent exited with code 1', data: { mode: 'replay', calls: calls(18), upstreamRequests: 0, checks: [check('issue_refund called 1 time', 'failed', 'called 0 times')], output: PY_TAIL } }, { divergence: { type: 'ended_early', callNo: 19, kind: 'api', name: 'POST /v1/messages', replayedBefore: 18, recorded: 30 } });
  const divergence = { type: 'request_changed' as const, callNo: 1, kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 0 };
  const volatile = { values: [{ path: '$.metadata.user_id', looks: 'a UUID', op: 'changed' as const, certain: true, normalizer: { path: '$.metadata.user_id', replace: '<uuid>' } }], explainsAll: true };
  add('drift', [], { ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', data: { mode: 'replay', calls: calls(0, 1), upstreamRequests: 0, divergence: { ...divergence, diff: [{ path: '$.metadata.user_id', op: 'changed', before: 'a', after: 'b' }], cause: '$.metadata.user_id', volatile, text: '✗ Request changed at call 1' }, details: '✗ Request changed at call 1\n  - "a"\n  + "b"' } }, { divergence: { ...divergence, recorded: 30 }, refused: 1 });
  const judge = { name: 'polite', model: 'claude-x', of: 'answer' as const, verdict: null, source: null, cost: null, redactions: 0, cut: 0 } as unknown as NonNullable<StoredCheck['judge']>;
  add('judged', [JUDGE], { ok: false, failure: 'inconclusive', reason: 'check inconclusive: judge "polite" answers yes: its pack holds no verdict', data: { mode: 'replay', verdict: 'inconclusive', calls: calls(7), upstreamRequests: 0, checks: [check(JUDGE, 'inconclusive', 'not judged: no recorded verdict and the test runs offline', { judge })] } });
  const outcomes = [...Array<boolean>(67).fill(true), ...Array<boolean>(16).fill(false)];
  const gate = gateResult({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 83 }, outcomes, { decision: 'inconclusive' });
  add('flaky', [TWICE], { ok: false, failure: 'inconclusive', reason: 'inconclusive after 83 attempts', data: { mode: 'fork', verdict: 'inconclusive', upstreamRequests: 6, gate, attempts: { total: 83, passed: 67, required: null, runs: [] }, checks: [check(TWICE, 'failed', 'called 2 times')] } }, { mode: 'fork' });
  store.finishTestSession(s.sessionId, { passed: 0, failed: 4, upstreamRequests: 6, endedAt: T0 + 100 });
  const view = testsView(store, goldens, { folder: 'goldens' });
  const reports = goldenReports(view, { store, goldens, normalizers: [], project: '/work/shop' });
  store.close();
  // As the route joins them: a golden whose checks lead it takes its step's hint.
  return { ...view, reports: withStepHints(reports, steps), steps };
}

const OFFLINE_BODY = { type: 'error', error: { type: 'shadowlap_offline', message: 'shadowlap is offline: call #1 (POST /v1/messages) was not served from the recording and would need the network' } };
/** Show diff's answer for a replay's diverged call 1, a test's one value a normalizer masks. */
const diffOf = (runId: string): RequestDiff => ({ at: 1, what: 'request', call: { kind: 'api', name: 'POST /v1/messages' }, against: { runId: '01K5CQ4N7GREC0RD', callNo: 1 }, was: { metadata: { user_id: 'a' } }, now: { metadata: { user_id: 'b' } }, whole: true, leftOut: [], same: false, askedAgain: false, type: 'request_changed', path: '$.metadata.user_id', paths: [{ path: '$.metadata.user_id', what: null, fix: { kind: 'normalizer', looks: 'a UUID', op: 'changed', certain: true, message: '$.metadata.user_id looks like a UUID', args: [], command: `shadowlap normalize add '$.metadata.user_id' --replace '<UUID>' (${runId})` } }], updates: false, masked: [], outside: [], hints: [], flag: null, tool: null, next: null, test: true });

const g = globalThis as { location?: { hash: string; pathname: string; search: string } };
const asked: string[] = [];
const diffs: string[] = [];
const said: string[] = [];
let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  delete g.location;
  vi.unstubAllGlobals();
  for (const name of openReports()) setReportOpen(name, false);
  for (const name of shownAttempts()) setAttemptsShown(name, false);
  asked.length = 0;
  diffs.length = 0;
  said.length = 0;
});

/** Tests over `view`, arrived at by `hash`, with the parts the served dashboard hands in (`parts`): the attempts it reads counted in `asked`, its toasts in `said`. */
async function draw(view: TestsAnswer, hash = '#/tests', parts: ServedParts = {}): Promise<Rendered> {
  const location = { hash, pathname: '/', search: '' };
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (location.hash = url.slice(url.indexOf('#'))) });
  const client = {
    tests: () => Promise.resolve(view),
    testEvidence: (golden: string) => {
      asked.push(golden);
      return Promise.resolve({ attempts: [{ runId: 'run-a1', href: '#/run/run-a1', outcome: 'failed', note: 'called 2 times' }], carried: 0, gone: 0 });
    },
    requestDiff: (runId: string) => {
      diffs.push(runId);
      return Promise.resolve(diffOf(runId));
    },
    jobs: () => Promise.resolve([]),
    offers: () => Promise.resolve(null),
    startJob: () => Promise.resolve({ id: 'j1' }),
    // Security on Tests reads its goldens' untrusted reads, and Not covered its last scan: none here.
    injectionSecurity: () => Promise.resolve({ goldens: [], none: [], unread: [] }),
    coverage: () => Promise.resolve(null),
  } as unknown as Client;
  const app = { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: (words: string) => void said.push(words) };
  r = await render(createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(ServedPartsContext.Provider, { value: parts }, createElement(TestsPage))));
  await r.until('the goldens to load', () => r!.all('table.gt tbody tr[data-rowkey]').length === view.rows.length);
  return r;
}

const one = (el: FakeElement, selector: string): FakeElement => {
  const found = el.querySelectorAll(selector);
  if (found.length !== 1) throw new Error(`${found.length} elements match ${selector}`);
  return found[0];
};
const report = (page: Rendered, name: string) => page.one(`section[id="report-${name}"]`);
const wrap = (page: Rendered, name: string) => page.one(`div.grpw[id="grp-${name}"]`);
const toggle = (page: Rendered, name: string) => page.one(`button.grptog[aria-controls="grp-${name}"]`);

describe('a golden’s report under its row', () => {
  it('folds each report under its row, hidden until found, its row no row of the table’s own', async () => {
    const page = await draw(answer());
    expect(page.all('table.gt tbody tr[data-rowkey]').map((tr) => one(tr, 'code.gn').textContent)).toEqual(['refund', 'drift', 'judged', 'flaky']);
    expect(page.all('table.gt tbody tr.grprow').map((tr) => [tr.getAttribute('data-rowkey'), one(tr, 'section.gpanel').getAttribute('id')])).toEqual([[null, 'report-refund'], [null, 'report-drift'], [null, 'report-judged'], [null, 'report-flaky']]);
    for (const name of ['refund', 'drift', 'judged', 'flaky']) {
      expect([toggle(page, name).textContent, toggle(page, name).getAttribute('aria-expanded')]).toEqual(['Show report', 'false']);
      expect(wrap(page, name).getAttribute('hidden')).toBe('until-found');
    }
  });

  it('says each kind in one sentence, names its parts in the margin, and ends with its hint and its lines as printed', async () => {
    const page = await draw(answer());
    const drawn = (name: string) => {
      const s = report(page, name);
      return { head: one(s, '.verdict').textContent.replace(/\u00a0/g, ' '), parts: s.querySelectorAll('dl.rpx > dt').map((dt) => dt.textContent), hint: s.querySelectorAll('p.hintx').map((p) => p.textContent.replace(/\u00a0/g, ' ')) };
    };
    expect(drawn('refund')).toEqual({ head: expect.stringContaining('The agent exited with code 1 at call 19'), parts: ['Replay', 'Error', 'Checks'], hint: ['The agent stopped part way, so its checks say little.'] });
    expect(drawn('drift')).toEqual({ head: expect.stringContaining('Diverged at call 1: $.metadata.user_id changed, a UUID'), parts: ['Request'], hint: ['Normalizers apply at match time, so older goldens keep working.'] });
    expect(drawn('judged')).toEqual({ head: expect.stringContaining('Replayed clean, but its judge check wasn’t judged'), parts: ['Checks'], hint: [hintWords({ key: 'judge', held: 'none', name: 'polite' })] });
    expect(drawn('flaky')).toEqual({ head: expect.stringContaining('and its gate ran out before deciding'), parts: ['Gate', 'Attempts'], hint: [hintWords({ key: 'gate' })] });
    // Its sentence glued as a verdict's words are, a small word kept with the word after it, its path as code kept whole.
    const drift = one(report(page, 'drift'), '.verdict h3');
    expect(drift.textContent).toContain('at\u00a0call');
    expect(drift.querySelector('code')!.className).toBe('ts-code');
    // The lines as printed, the CLI's, under Show as printed: the golden's line red, a crash's tail dim.
    const printed = one(report(page, 'refund'), 'pre.report[role="log"]');
    expect([printed.getAttribute('aria-label'), printed.querySelectorAll('span')[0].textContent.trim(), printed.querySelectorAll('span')[0].className]).toEqual(['refund as printed', '✗ refund: the agent exited with code 1', 'no']);
    expect(printed.querySelectorAll('span.dim').map((x) => x.textContent.trim())).toContain("│ KeyError: 'total'");
  });

  it('draws a gate’s figures once each, and the check its attempts failed with its mark and only what the verdict leaves out', async () => {
    const page = await draw(answer());
    const s = report(page, 'flaky');
    const dds = s.querySelectorAll('dl.rpx > dd');
    const part = (name: string) => dds[s.querySelectorAll('dl.rpx > dt').findIndex((dt) => dt.textContent === name)];
    const gate = shownText(part('Gate').querySelector('p.rpg')!).replace(/\u00a0/g, ' ').trim();
    expect(gate).toMatch(/^67 of 83 passed · rate 0\.\d\d to 0\.\d\d \(95%\) · pass\^5 0\.\d\d$/);
    const mark = one(part('Attempts'), 'span.chk.rpck span.ck.failed');
    expect([one(mark, 'b.cm').getAttribute('aria-label'), one(mark, 'span.cw').textContent]).toEqual(['failed', TWICE]);
  });

  it('opens one report from Show report and every one from Show every report, each control saying which', async () => {
    const page = await draw(answer());
    await page.click(toggle(page, 'refund'));
    expect([toggle(page, 'refund').textContent, toggle(page, 'refund').getAttribute('aria-expanded'), wrap(page, 'refund').hasAttribute('hidden')]).toEqual(['Hide report', 'true', false]);
    expect(page.all('table.gt tbody tr.grprow.shut')).toHaveLength(3);
    const every = page.one('div.gtop button.linkbtn');
    expect([every.textContent, every.getAttribute('aria-expanded')]).toEqual(['Show every report', 'false']);
    await page.click(every);
    expect([page.one('div.gtop button.linkbtn').textContent, page.one('div.gtop button.linkbtn').getAttribute('aria-expanded')]).toEqual(['Hide every report', 'true']);
    expect(page.all('div.grpw').map((w) => w.getAttribute('hidden'))).toEqual([null, null, null, null]);
    await page.click(page.one('div.gtop button.linkbtn'));
    expect(page.all('div.grpw').map((w) => w.getAttribute('hidden'))).toEqual(['until-found', 'until-found', 'until-found', 'until-found']);
  });

  it('opens the report a link names, then drops it from the address, and the one find in page matches', async () => {
    const page = await draw(answer(), links.tests({ report: 'judged' }));
    await page.until('the asked report to open', () => !wrap(page, 'judged').hasAttribute('hidden'));
    expect(g.location?.hash).toBe('#/tests');
    expect(wrap(page, 'refund').getAttribute('hidden')).toBe('until-found');
    // Find in page matching a word inside it: the browser fires beforematch on the folded part, then shows it.
    await act(async () => {
      for (const fn of wrap(page, 'refund').heard('beforematch')) fn({ type: 'beforematch' } as never);
    });
    expect([wrap(page, 'refund').hasAttribute('hidden'), toggle(page, 'refund').getAttribute('aria-expanded')]).toEqual([false, 'true']);
  });

  it('draws a crash’s exception where its own code raised it, and its whole tail under Show traceback, folded until found', async () => {
    const page = await draw(answer());
    const s = report(page, 'refund');
    expect(one(s, 'p.rperr').textContent).toMatch(/^KeyError: 'total' in refund_agent\.py, line 141, in issue_refund/);
    expect(one(s, 'code.rpsrc').textContent).toBe('log.info("refund %s of %s", refund["refund_id"], order["total"])');
    const show = one(s, 'p.rperr button.rptog');
    const tail = page.one(`pre.report.tail[id="${show.getAttribute('aria-controls')!}"]`);
    expect([show.textContent, show.getAttribute('aria-expanded'), tail.getAttribute('hidden')]).toEqual(['Show traceback', 'false', 'until-found']);
    await page.click(show);
    expect([one(s, 'p.rperr button.rptog').textContent, tail.hasAttribute('hidden'), shownText(tail)]).toEqual(['Hide traceback', false, PY_TAIL]);
  });

  it('copies the report as printed with its box’s Copy, and says so', async () => {
    const writes: string[] = [];
    const page = await draw(answer());
    vi.stubGlobal('navigator', { clipboard: { writeText: (t: string) => (writes.push(t), Promise.resolve()) } });
    const s = report(page, 'drift');
    const show = one(s, 'div.rpp > button.rptog');
    expect([show.textContent, page.one(`div.rbox[id="${show.getAttribute('aria-controls')!}"]`).getAttribute('hidden')]).toEqual(['Show as printed', 'until-found']);
    const copy = one(s, 'div.rbox button.boxcopy');
    expect(copy.getAttribute('aria-label')).toBe('Copy report');
    await page.click(copy);
    await page.wait(0);
    expect(writes).toEqual([['✗ drift: diverged at call 1 (api POST /v1/messages)', '    ✗ Request changed at call 1', '      - "a"', '      + "b"'].join('\n')]);
    expect(said).toEqual(['Copied the report']);
  });

  it('leads each report with its own step, plain, then what else it offers', async () => {
    const steps: Record<string, NextStep> = {
      'goldens/drift': { key: 'normalizer', label: 'Add normalizer', golden: 'goldens/drift', test: null },
      'goldens/judged': { key: 'update-golden', label: 'Update golden', golden: 'goldens/judged', test: null },
    };
    const page = await draw(answer(steps));
    const buttons = (name: string) => report(page, name).querySelectorAll('div.actions .btn').map((b) => [b.textContent, b.className]);
    expect(buttons('drift')).toEqual([['Add normalizer', 'btn'], ['Update golden', 'btn'], ['Find breaking commit…', 'btn']]);
    expect(buttons('judged')).toEqual([['Update golden', 'btn']]);
    // No step of its own: Run more attempts, which carries its attempts over, as its siblings offer it.
    expect(buttons('flaky')).toEqual([['Run more attempts', 'btn']]);
    // Update golden stands beside the normalizer only: a divergence Find breaking commit leads offers no update beside it.
    await page.unmount();
    r = null;
    const bisect = await draw(answer({ 'goldens/drift': { key: 'bisect', label: 'Find breaking commit…', golden: 'goldens/drift' } as NextStep }));
    expect(report(bisect, 'drift').querySelectorAll('div.actions .btn').map((b) => b.textContent)).not.toContain('Update golden');
  });

  it('offers a golden whose checks changed since Run tests alone, and one whose recording fails a check added since Edit check…, each plain, its hint from its step', async () => {
    const steps: Record<string, NextStep> = {
      'goldens/flaky': { key: 'run-tests', label: 'Run tests', golden: 'goldens/flaky', gone: [TWICE], sub: 'Its checks changed since its last test: the session judges them as they are now', command: 'shadowlap test goldens/*' },
      'goldens/refund': { key: 'edit-check', label: 'Edit check…', golden: 'goldens/refund', check: 'issue_refund called 1 time', sub: 'It fails refund’s own recording: edit the check, or update the golden if the agent should now do this' },
    };
    const page = await draw(answer(steps), '#/tests', { CheckBuilder: shownNow(() => createElement('div', { className: 'builderstub' })) });
    const buttons = (name: string) => report(page, name).querySelectorAll('div.actions .btn').map((b) => [b.textContent, b.className]);
    const hint = (name: string) => report(page, name).querySelector('p.hintx')?.textContent.replace(/\u00a0/g, ' ');
    // More attempts would judge checks the config no longer holds: Run tests, the whole session, alone.
    expect(buttons('flaky')).toEqual([['Run tests', 'btn']]);
    expect(hint('flaky')).toBe('Run tests judges its checks as they are now.');
    expect(buttons('refund')[0]).toEqual(['Edit check…', 'btn']);
    expect(hint('refund')).toBe('The check, added since, fails the golden’s own recording: edit the check, or update the golden if the agent should now do this.');
    // Edit check… opens the builder at its check.
    await page.click(report(page, 'refund').querySelector('div.actions .btn')!);
    await page.until('the builder', () => page.all('.builderstub').length === 1);
  });

  it('opens its golden’s issue on Runs › Failed from Failed runs →, its hover naming the replays', async () => {
    const a = answer();
    const ids = ['01K8RGAAAA0000000000000001', '01K8RGBBBB0000000000000002'];
    const runs = { 'goldens/refund': { count: 2, ids }, 'goldens/drift': { count: 1, ids: ids.slice(1) } };
    const page = await draw({ ...a, reports: withFailedRuns(a.reports ?? {}, runs, { 'goldens/drift': { key: 'fix' } }) });
    const heads = report(page, 'refund').querySelectorAll('span.glinks > a');
    expect(heads.map((x) => x.textContent)).toEqual(['Failed runs →', 'Open run']);
    const failed = heads[0];
    expect(failed.getAttribute('href')).toBe(failedRunsHref('refund'));
    expect(JSON.parse(failed.getAttribute('data-tip')!)).toMatchObject({ t: '2 failed replays', s: '01K8RGAAAA, 01K8RGBBBB. Opens them on Runs, under Failed' });
    // A click, as Enter on the link is, asks for the issue as the link goes to Failed, which opens it as it shows; one with a modifier asks for none.
    const key = issueKey.golden('goldens/refund');
    await page.fire(failed, 'click', { metaKey: true });
    expect(ISSUE_ASK.take(key)).toBe(false);
    await page.click(failed);
    expect(ISSUE_ASK.take(key)).toBe(true);
    // One whose step is its fix has none: Open fix leads to its runs.
    expect(report(page, 'drift').querySelectorAll('span.glinks > a').map((x) => x.textContent)).toEqual(['Open run']);
  });

  it('draws a divergence’s request as Show diff draws it once its report is open, then what followed, its message folded until found', async () => {
    const page = await draw(answer());
    const part = () => one(report(page, 'drift'), 'dl.rpx > dd');
    // Folded, it asks for no diff and holds none: only what followed, in grey.
    expect([diffs.length, part().querySelectorAll('.rpdiff').length, part().querySelectorAll('.rperrw.q').length]).toEqual([0, 0, 1]);
    await page.click(toggle(page, 'drift'));
    await page.until('the diff', () => part().querySelectorAll('.rpdiff .jd .jl').length > 0);
    expect(diffs).toHaveLength(1);
    expect(part().querySelectorAll('.rpdiff .jdh h4').map((h) => shownText(h).replace(/\u00a0/g, ' '))).toEqual(['−Recorded request #1 · 01K5CQ4N7G', '+This run’s request #1']);
    expect(shownText(one(part(), '.rpdiff .hint')).replace(/\u00a0/g, ' ')).toContain('Only a value changed at $.metadata.user_id, and it looks like a UUID: the agent makes a new one on every run.');
    const foot = one(part(), '.rperrw.q');
    expect(foot.querySelectorAll('p.rperr > span.nw').map((x) => x.textContent)).toEqual(['Not served from the recording:', 'the agent exited on HTTP 503']);
    const box = one(foot, 'pre.report.tail');
    expect([one(foot, 'button.rptog').textContent, box.getAttribute('hidden')]).toEqual(['Show message', 'until-found']);
    await page.click(one(foot, 'button.rptog'));
    expect([one(foot, 'button.rptog').textContent, box.hasAttribute('hidden'), box.getAttribute('id')]).toEqual(['Hide message', false, 'rpm-drift']);
    expect(box.textContent).toBe(JSON.stringify(OFFLINE_BODY, null, 2));
  });

  it('folds no report on Esc, leaving Esc to the evidence, and asks a report’s attempts only once it is open', async () => {
    let page = await draw(answer());
    expect(asked).toEqual([]);
    await page.click(toggle(page, 'flaky'));
    await page.until('the attempts', () => asked.length === 1);
    expect(asked).toEqual(['goldens/flaky']);
    await page.press('Escape');
    expect([toggle(page, 'flaky').getAttribute('aria-expanded'), pageUp.current?.() ?? false]).toEqual(['true', false]);
    // Its 83 attempts fold behind the gate's caret, which stays as it was left.
    await page.click(one(report(page, 'flaky'), 'p.rpg button.xbtn'));
    // The open set outlives the page: drawn again, the report is open.
    await page.unmount();
    r = null;
    page = await draw(answer());
    expect([toggle(page, 'flaky').getAttribute('aria-expanded'), wrap(page, 'flaky').hasAttribute('hidden')]).toEqual(['true', false]);
    expect(one(report(page, 'flaky'), 'p.rpg button.xbtn').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('an injection gate’s attempts', () => {
  it('counts them in the results’ key, never the matrix, a count of none left out, what showed nothing last, then where they were planted, broken only at its comma', async () => {
    const part = { kind: 'injection-attempts', totals: { obeyed: 8, influenced: 2, inconclusive: 0, ignored: 59 }, where: 'every template at every untrusted read,', each: '3 attempts each', command: 'shadowlap injection goldens/x --html report.html', resultId: null };
    const report = { name: 'x', verdict: 'failed', parts: [part] } as unknown as GoldenReport;
    const app = { client: {}, exported: false, toast: () => undefined, guard: (fn: () => void) => fn() } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: app }, createElement(ReportParts, { report, row: { path: 'goldens/x', last: { gate: null } } as unknown as GoldenRow, open: true })));
    const key = r.one('dl.rpx dd > .rpmx > .mxkey');
    expect(key.querySelectorAll('.mxk').map((e) => [e.className, shownText(e).replace(/\s+/g, ' ').trim()])).toEqual([['mxk', '8 obeyed'], ['mxk', '2 influenced'], ['mxk q', '59 ignored']]);
    // Each clause whole, so a phone breaks the line at its comma and nowhere else.
    expect(r.all('dl.rpx dd > p.rpw > span.nw').map((e) => e.textContent)).toEqual(['every template at every untrusted read,', '3 attempts each']);
  });
});

describe('an injection gate’s proof and its Security report', () => {
  const ATTEMPT = '01K5CQ4N7GA77EMP700000000P';
  const TESTED = '01K5CQ4N7GTE57ED000000000R';
  const CANARY = 'x7f3k@canary.invalid';
  const proof = { kind: 'proof', runId: ATTEMPT, parts: { plantedAt: 4, readAt: 5, evidence: { kind: 'canary', callNo: 6, at: 'send_email.to', value: CANARY, why: null } }, why: null };
  const attempts = { kind: 'injection-attempts', totals: { obeyed: 5, influenced: 2, inconclusive: 3, ignored: 62 }, where: null, each: null, command: 'shadowlap injection goldens/research --html report.html', security: { resultId: 'inj-1', runId: TESTED } };
  const report = { golden: 'goldens/research', name: 'research', verdict: 'failed', head: [], sub: [], parts: [proof, attempts], open: null, failedRuns: null, hint: { key: 'injection' }, printed: [] } as unknown as GoldenReport;
  const row = { path: 'goldens/research', last: { gate: null } } as unknown as GoldenRow;
  const view = { divergences: [], failures: [], inconclusive: [], steps: {} } as unknown as TestsAnswer;
  const press: LeadPress = { wait: () => null, prices: null, live: () => false, onNormalize: () => undefined, onUpdate: () => undefined, onFind: () => undefined, onMore: () => undefined, onRerun: () => undefined, runTests: null, edit: null };
  const preview = { at: T0, attempts: 72, rules: 1, masks: [{ at: 'fetch_page.url', before: 'https://c.example.com/notes', after: 'https://<HOST>/notes' }], canaries: [{ at: 'send_email.to', value: CANARY }], file: 'shadowlap-injection-01k5cq4n7g.html' };
  const appOf = (client: unknown) => ({ client, exported: false, actionsOff: null, conn: 'ok', hasKind: () => true, guard: (fn: () => void) => (fn(), true), toast: (words: string) => void said.push(words), jobs: [] }) as unknown as AppState;
  const served = (parts: ServedParts, child: ReturnType<typeof createElement>, client: unknown = {}) => createElement(AppContext.Provider, { value: appOf(client) }, createElement(ServedPartsContext.Provider, { value: parts }, child));

  it('draws the proof as an attempt’s finding draws it, each call it names opening that attempt there, and none where the part isn’t handed in', async () => {
    const location = { hash: '#/tests', pathname: '/', search: '' };
    vi.stubGlobal('location', location);
    const parts = createElement(ReportParts, { report, row, open: true });
    r = await render(served({ Proof: shownNow(Proof) }, parts));
    const line = r.one('dl.rpx dd > p.rpw > span.injline');
    // Each a link, so it opens in a new tab too: the attempt's page opens the call on the tab that shows it (injection/arrival.ts).
    expect(line.querySelectorAll('a.pbn').map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('data-injtab')])).toEqual([
      ['#4', `#/run/${ATTEMPT}/4`, 'response'],
      ['#5', `#/run/${ATTEMPT}/5`, 'conversation'],
      ['#6', `#/run/${ATTEMPT}/6`, 'request'],
    ]);
    expect(line.querySelectorAll('button').length).toBe(0);
    expect(line.querySelectorAll('b.cnry').map((b) => b.textContent)).toEqual([CANARY]);
    await r.unmount();
    r = await render(served({}, parts));
    expect([r.all('.injline').length, r.all('dl.rpx > dt').map((d) => d.textContent)]).toEqual([0, ['Proof', 'Attempts']]);
  });

  it('opens Share’s Security report dialog from its button and from ⌘K on its row, naming the run the result tested, and offers none where the dialog isn’t handed in', async () => {
    const client = { injectionPreview: async () => preview, injectionReport: async () => ({ filename: preview.file, redacted: true }) };
    const page = createElement('div', { className: 'page' }, createElement('section', { id: 'report-research' }, createElement(ReportSteps, { report, view, press, onPress: () => undefined })));
    r = await render(served({ SecurityReportDialog: shownNow(SecurityReportDialog) }, page, client));
    await r.click(r.byText('div.actions .btn', 'Security report'));
    await r.until('the dialog’s preview', () => r!.all('[role="dialog"] .injmask').length === 2);
    expect(shownText(r.one('[role="dialog"] h3')).replace(/\u00a0/g, ' ')).toBe(`Download security report for ${TESTED.slice(0, 10)}`);
    await r.click(r.one('.dlg-cancel'));
    expect(r.all('[role="dialog"]')).toHaveLength(0);
    // ⌘K on the golden's row presses the report's own button.
    const item = goldenRowScope({ name: 'research', runId: null }, () => r!.one('div.page') as unknown as ParentNode)!
      .items()
      .find((i) => i.label === 'Security report')!;
    await act(async () => item.run());
    await r.until('the dialog again', () => r!.all('[role="dialog"]').length === 1);
    await r.unmount();
    r = await render(served({}, page, client));
    expect(r.all('div.actions .btn').map((b) => b.textContent)).toEqual([]);
  });
});

describe('a request part on its own', () => {
  const BODIES = { was: { metadata: { user_id: 'a' } }, now: { metadata: { user_id: 'b' } } };
  const FOLLOWED = { line: ['Not served from the recording:', 'the agent exited on HTTP 503'] as [string, string], message: '{\n  "type": "error"\n}' };
  type RequestPartOf = Extract<GoldenReport['parts'][number], { kind: 'request' }>;
  /** The parts of a report holding `part` alone, open, Show diff's answers from `answer`, each ask counted in `diffs`. */
  async function drawPart(part: RequestPartOf, answer: (runId: string) => Promise<RequestDiff | null> = () => Promise.reject(new Error('never asked'))): Promise<FakeElement> {
    const client = { requestDiff: (runId: string) => (diffs.push(runId), answer(runId)) };
    const app = { client, exported: false, toast: () => undefined, guard: (fn: () => void) => fn() } as unknown as AppState;
    const report = { name: 'drift', verdict: 'failed', parts: [part] } as unknown as GoldenReport;
    r = await render(createElement(AppContext.Provider, { value: app }, createElement(ReportParts, { report, row: { path: 'goldens/drift', last: { gate: null } } as unknown as GoldenRow, open: true })));
    return r.one('dl.rpx > dd');
  }

  it('draws the changes its result kept once the replay is gone, under both heads, with no notes and nothing asked', async () => {
    const dd = await drawPart({ kind: 'request', runId: null, callNo: 3, against: { runId: '01K5CQ4N7GREC0RD', callNo: 3 }, bodies: BODIES, followed: null });
    await r!.until('the diff', () => dd.querySelectorAll('.rpdiff .jd .jl').length > 0);
    expect(dd.querySelectorAll('.rpdiff .jdh h4').map((h) => shownText(h).replace(/\u00a0/g, ' '))).toEqual(['−Recorded request #3 · 01K5CQ4N7G', '+This run’s request #3']);
    expect([dd.querySelectorAll('.hint').length, dd.querySelectorAll('.rperrw').length, diffs]).toEqual([0, 0, []]);
  });

  it('says the switch of the migration that left its golden waiting once, under the diff, in the server’s words, its id opening the migration', async () => {
    const cause = switchCause({ migrationId: 'mg-01M5000000000000000000000C', from: ['claude-sonnet-4-5'], to: 'claude-sonnet-5-5' });
    const dd = await drawPart({ kind: 'request', runId: null, callNo: 1, against: null, bodies: BODIES, followed: FOLLOWED, cause });
    await r!.until('the diff', () => dd.querySelectorAll('.rpdiff .jd .jl').length > 0);
    expect(dd.children.map((c) => c.className)).toEqual(['diffpanel jdp rpdiff', 'rpc rpcause', 'rperrw q']);
    const line = one(dd, 'p.rpcause');
    expect(shownText(line).replace(/\u00a0/g, ' ')).toBe('The config change of migration mg-01M5000000 switched its model: claude-sonnet-4-5 → claude-sonnet-5-5.');
    expect(line.querySelectorAll('a').map((a) => [a.getAttribute('href'), a.textContent])).toEqual([['#/changes/migrate/mg-01M5000000000000000000000C', 'mg-01M5000000']]);
  });

  it('says what the change takes out of an accepted one, a line a sentence under the diff, in the server’s words, the sentence as code', async () => {
    const takenOut = takenOutLines([{ sentence: 'Escalate refunds above $100.', at: '2026-11-14T10:00:00.000Z', by: null, reason: 'a $240 refund went out against policy' }, { sentence: 'Be brief.', at: '2026-11-15T10:00:00.000Z', by: null, reason: 'answers ran long' }], false);
    const dd = await drawPart({ kind: 'request', runId: null, callNo: 1, against: null, bodies: BODIES, followed: FOLLOWED, takenOut });
    await r!.until('the diff', () => dd.querySelectorAll('.rpdiff .jd .jl').length > 0);
    expect(dd.children.map((c) => c.className)).toEqual(['diffpanel jdp rpdiff', 'rpc rpcause', 'rpc rpcause', 'rperrw q']);
    const lines = dd.querySelectorAll('p.rpcause');
    expect(lines.map((l) => shownText(l).replace(/\u00a0/g, ' '))).toEqual([
      'This change takes out what an accepted change put in: Escalate refunds above $100., accepted 2026-11-14: a $240 refund went out against policy',
      'This change takes out what an accepted change put in: Be brief., accepted 2026-11-15: answers ran long',
    ]);
    expect(lines.map((l) => l.querySelectorAll('code').map((c) => c.textContent))).toEqual([['Escalate refunds above $100.'], ['Be brief.']]);
  });

  it('draws only what followed where the divergence kept no changes: no diff panel, nothing asked', async () => {
    const dd = await drawPart({ kind: 'request', runId: null, callNo: 4, against: null, bodies: null, followed: FOLLOWED });
    expect([dd.children.map((c) => c.className), diffs]).toEqual([['rperrw q'], []]);
    expect(dd.querySelectorAll('p.rperr > span.nw').map((x) => x.textContent)).toEqual(FOLLOWED.line);
  });

  it('draws its shape while asked, says a failed ask as every page does, with Retry, which asks again, and where the answer is none says so as Show diff does', async () => {
    const { ApiError } = await import('../ui/api.js');
    let fail: ((err: Error) => void) | null = null;
    const ask = () => (fail ? Promise.resolve(null) : new Promise<null>((_resolve, reject) => (fail = reject)));
    const dd = await drawPart({ kind: 'request', runId: 'run-asked-twice', callNo: 3, against: null, bodies: null, followed: null }, ask);
    // While it is asked: both heads, then its lines in their box, as quiet bars in classes of their own.
    expect(dd.querySelectorAll('.rpdiff .skel [role="status"]').map(shownText)).toEqual(['Loading the request’s diff…']);
    expect([dd.querySelectorAll('.skel .rpskh > span').length, dd.querySelectorAll('.skel .rpskd > span').length, dd.querySelectorAll('.jdh, .jl, .hint').length]).toEqual([2, 6, 0]);
    await act(async () => fail!(new ApiError(500, 'HTTP 500')));
    await r!.until('the error', () => dd.querySelectorAll('.rpdiff .loaderr').length === 1);
    expect(dd.querySelectorAll('.loaderr p > span').map(shownText)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    await r!.click(one(dd, '.loaderr button.btn'));
    await r!.until('the answer', () => dd.querySelectorAll('.rpdiff div.hint').length === 1);
    expect([diffs, dd.querySelectorAll('.loaderr').length, shownText(one(dd, '.rpdiff div.hint')).replace(/\u00a0/g, ' ')]).toEqual([['run-asked-twice', 'run-asked-twice'], 0, 'The replay kept no call #3 to compare.']);
  });

  it('draws its attempts’ lines while they are read, and a failed read as every page says it, with Retry, which reads them again', async () => {
    const { ApiError } = await import('../ui/api.js');
    const reads: Array<{ resolve: (e: TestEvidence) => void; reject: (err: Error) => void }> = [];
    const testEvidence = () => new Promise<TestEvidence>((resolve, reject) => reads.push({ resolve, reject }));
    const app = { client: { testEvidence }, exported: false, toast: () => undefined, guard: (fn: () => void) => fn() } as unknown as AppState;
    const report = { name: 'flaky', verdict: 'inconclusive', parts: [{ kind: 'attempts', check: null, carried: null, forked: null }] } as unknown as GoldenReport;
    r = await render(createElement(AppContext.Provider, { value: app }, createElement(ReportParts, { report, row: { path: 'goldens/flaky', last: { at: T0, gate: { attempts: 3 } } } as unknown as GoldenRow, open: true })));
    const dd = r.one('dl.rpx > dd');
    expect(dd.querySelectorAll('.skel [role="status"]').map(shownText)).toEqual(['Loading the attempts…']);
    expect([dd.querySelectorAll('.skel .rpska > span').length, dd.querySelectorAll('.alist').length]).toEqual([3, 0]);
    await act(async () => reads[0].reject(new ApiError(500, 'HTTP 500')));
    await r.until('the failure', () => dd.querySelectorAll('.loaderr').length === 1);
    expect(dd.querySelectorAll('.loaderr p > span').map(shownText)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    await r.click(one(dd, '.loaderr button.btn'));
    expect(reads).toHaveLength(2);
    await act(async () => reads[1].resolve({ attempts: [{ runId: 'run-a1', href: '#/run/run-a1', outcome: 'failed', note: 'called 2 times' }], carried: 0, gone: 0 }));
    await r.until('the attempts', () => dd.querySelectorAll('.alist > .al').length === 1);
    expect(dd.querySelectorAll('.skel, .loaderr')).toHaveLength(0);
  });

  it('folds a body that came after its line first drew without one, until found', async () => {
    function Later() {
      const [lines, setLines] = useState<string[] | null>(null);
      return createElement('div', null, createElement('button', { type: 'button', className: 'later', onClick: () => setLines(['{', '}']) }), createElement(FoldedLines, { head: 'Not served from the recording:', what: 'message', lines, id: 'rpm-later', quiet: true }));
    }
    const app = { client: {}, exported: false, toast: () => undefined, guard: (fn: () => void) => fn() } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value: app }, createElement(Later)));
    expect(r.all('pre.report.tail')).toEqual([]);
    await r.click(r.one('button.later'));
    const box = r.one('pre.report.tail');
    expect([r.one('button.rptog').textContent, box.getAttribute('hidden'), box.heard('beforematch').length]).toEqual(['Show message', 'until-found', 1]);
    // Find in page matching a word inside it: the browser fires beforematch on the folded box, then shows it.
    await act(async () => {
      for (const fn of box.heard('beforematch')) fn({ type: 'beforematch' } as never);
    });
    expect([r.one('button.rptog').textContent, box.hasAttribute('hidden')]).toEqual(['Hide message', false]);
  });
});

describe('a golden a migration left waiting', () => {
  it('says the switch on its Request’s line, and only why Update golden leads in its hint, as the server reads the migration', async () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/switched'], revision: 'abc1234', startedAt: T0 });
    const command = { argv: ['python', 'refund_agent.py'], cwd: '/work/shop' };
    const recording = store.createRun({ mode: 'record', command });
    const replay = store.createRun({ mode: 'replay', command, meta: { test: { golden: 'goldens/switched', session: s.sessionId } } });
    const divergence = { type: 'request_changed' as const, callNo: 1, kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 0 };
    store.setDivergence(replay.runId, divergence);
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/switched', runId: replay.runId, at: T0, ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', data: { mode: 'replay', calls: calls(0, 1), upstreamRequests: 0, divergence: { ...divergence, diff: [{ path: '$.model', op: 'changed', before: 'claude-sonnet-4-5', after: 'claude-sonnet-5-5' }], text: '' } } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0, endedAt: T0 + 100 });
    // Applied before that test: the golden, recorded under claude-sonnet-4-5, waits to be re-recorded.
    const id = 'mg-01M5000000000000000000000C';
    store.putDecisionSession({ sessionId: id, kind: 'migrate', at: T0 - 2, change: 'the model claude-sonnet-5-5', actor: null, revision: null, data: { migrateId: id, kind: 'migrate', from: ['claude-sonnet-4-5'], to: 'claude-sonnet-5-5' }, runs: [] });
    store.setMigrationApplied(id, { at: T0 - 1, by: null, outdated: [{ golden: 'goldens/switched', callNo: 1, path: '$.model' }] });
    const goldens: GoldenSource[] = [{ path: 'goldens/switched', runId: recording.runId, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
    const view = testsView(store, goldens, { folder: 'goldens' });
    const reports = goldenReports(view, { store, goldens, normalizers: [], project: '/work/shop' });
    store.close();
    const page = await draw({ ...view, reports, steps: {} });
    const s2 = report(page, 'switched');
    expect(s2.querySelectorAll('dl.rpx > dt').map((dt) => dt.textContent)).toEqual(['Request']);
    expect(shownText(one(s2, 'dl.rpx > dd > p.rpcause')).replace(/\u00a0/g, ' ')).toBe('The config change of migration mg-01M5000000 switched its model: claude-sonnet-4-5 → claude-sonnet-5-5.');
    expect(one(s2, 'p.rpcause a').getAttribute('href')).toBe(`#/changes/migrate/${id}`);
    expect(s2.querySelectorAll('p.hintx').map((p) => shownText(p).replace(/\u00a0/g, ' '))).toEqual(['A golden recorded before the switch diverges on it: update it once the switch is what you meant.']);
  });
});
