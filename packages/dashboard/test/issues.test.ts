import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judgeCapture, NO_COMMAND, parseTests, rulesOnCalls, Store } from '@shadowlap/engine';
import { fixesView } from '../src/fixes-view.js';
import { startDashboard } from '../src/index.js';
import { type Issue, type IssueRunsPage, type IssuesPage, ISSUE_RUNS, ISSUES_READS, issueKeyOf, issueRunsByFix, type RunsIssuesJob } from '../src/issues.js';
import { issueKey } from '../src/issue-keys.js';
import { runJob } from '../src/read-jobs.js';
import { loadRunIndex } from '../src/run-index.js';
import { judgeFor, runJudged } from '../src/run-outcome.js';
import { listRunsPage } from '../src/runs-list.js';
import { FAMILY_ONLY_FAILURES, RUNS_FAILURES_READS } from '../src/runs-failures.js';
import { addRun, DAY, HOUR } from './read-model-store.js';
import { refund, T0, work } from './refund-family.js';

/**
 * Runs › Failed as issues (issues.ts): the failed runs grouped by the fix whose failing runs list them
 * or whose check they failed the same way, by golden, the planted runs apart, and the rest by what
 * failed; each issue's fields; a test replay a later replay fixed leaving its issue; and the days
 * and the filter's words narrowing what each issue counts.
 */

const NOW = Date.UTC(2026, 9, 20, 12);
const MIN = 60_000;
const FIX_A = 'fx-01K8RG0000000000000000000A';
const FIX_B = 'fx-01K8RG0000000000000000000B';
const LIMIT = (n: number) => `issue_refund: amount ${n} > get_policy.result.limit 100`;
const EMAIL = 'send_email called 1 time';
const failing = (label: string, detail: string | null = null) => ({ status: 'failed' as const, ok: false, label, detail });

let store: Store;
const id: Record<string, string> = {};

const read = (job: Partial<RunsIssuesJob> = {}) => {
  const a = ISSUES_READS['runs-issues'](store, { kind: 'runs-issues', options: {}, outcome: null, next: null, ...job }, { whole: true }) as { body: string };
  return JSON.parse(a.body) as IssuesPage & IssueRunsPage;
};
const issueOf = (page: IssuesPage, key: string): Issue => {
  const found = page.issues.find((x) => x.key === key);
  expect(found, `${key} in ${page.issues.map((x) => x.key).join(', ')}`).toBeDefined();
  return found!;
};
const runsOf = (i: Issue) => i.runs.map((r) => r.runId);

beforeAll(() => {
  store = Store.open(':memory:');
  const fix = (fixId: string, title: string, check: string, status: 'open' | 'applied') =>
    store.insertFix({ fixId, title, labels: [], check: { expect: {}, key: `check:${fixId}`, oracle: [check], text: check }, status, openedAt: NOW - 9 * HOUR, verifiedAt: null, appliedAt: status === 'applied' ? NOW - 8 * HOUR : null, data: {} });
  fix(FIX_A, 'Refunds above the limit issued without approval', LIMIT(240), 'open');
  fix(FIX_B, 'Sends the confirmation email twice', EMAIL, 'applied');
  const recording = (at: number, checks: ReturnType<typeof failing>[], meta: Record<string, unknown> = {}) => addRun(store, { startedAt: at, status: 'failed', calls: 'll', meta: { checks, ...meta } });
  // The fix's own failing run, and two that failed its check with other amounts: a recording, and a capture.
  id.a1 = recording(NOW - 6 * HOUR, [failing(LIMIT(240))]);
  store.addFixLink(FIX_A, 'failing', id.a1, NOW - 6 * HOUR);
  id.a2 = recording(NOW - 2 * HOUR, [failing(LIMIT(180))], { labels: ['eu'] });
  id.a3 = addRun(store, { startedAt: NOW - 3 * HOUR, argv: [NO_COMMAND], calls: 'll', meta: { imported: { at: NOW - 3 * HOUR, from: '/work/cap.jsonl' }, covers: ['api'], judged: { rules: 'r', at: NOW - 3 * HOUR, verdict: 'failed', why: null, checks: [failing(LIMIT(310))] } } as never });
  // Failed as the applied fix's check does, by its count; and a fork that failed so after a planted instruction.
  id.b1 = recording(NOW - 4 * HOUR, [failing(EMAIL, 'called 2 times')]);
  id.p1 = addRun(store, { parent: id.b1, startedAt: NOW - 5 * HOUR, calls: 'ro', meta: { interventions: [{ kind: 'plant', at: 2, flag: '--inject-result 2=@payloads/exfil-email.txt' }], checks: [failing(EMAIL, 'called 2 times')] } });
  // A failure no fix holds, twice with other amounts; one that is older than the days picked below.
  id.f1 = recording(NOW - 90 * MIN, [failing('cost at most $0.05', 'cost $0.07')]);
  id.f2 = recording(NOW - 3 * DAY, [failing('cost at most $0.05', 'cost $0.09')]);
  // A golden: a failed replay fixed by a later one that passed, then one that failed again.
  id.pack = addRun(store, { startedAt: NOW - 10 * DAY, calls: 'll', meta: { imported: { at: NOW - 10 * DAY, from: 'goldens/refund-in-limit' } } });
  const test = (at: number, failed: boolean) => addRun(store, { parent: id.pack, startedAt: at, calls: failed ? 'f' : 'rr', ...(failed ? { status: 'failed' as const, divergence: 1 } : {}), meta: { test: { golden: 'goldens/refund-in-limit', session: `s-${at}` } } });
  id.t1 = test(NOW - 8 * HOUR, true);
  id.t2 = test(NOW - 7 * HOUR, false);
  id.t3 = test(NOW - 30 * MIN, true);
  const session = (at: number) => store.startTestSession({ command: ['shadowlap', 'test', 'goldens/refund-in-limit'], startedAt: at }).sessionId;
  const result = (runId: string, at: number, ok: boolean) => store.addTestResult({ sessionId: session(at), golden: 'goldens/refund-in-limit', ok, runId, at: at + MIN, ...(ok ? {} : { failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)' }) });
  result(id.t1, NOW - 8 * HOUR, false);
  result(id.t2, NOW - 7 * HOUR, true);
  result(id.t3, NOW - 30 * MIN, false);
});
afterAll(() => store.close());

describe('the issue a failed run belongs to', () => {
  it('joins a fix by its failing runs, or by what failed without its amounts or call numbers, its captures counted from production', () => {
    const a = issueOf(read(), issueKey.fix(FIX_A));
    expect(a).toMatchObject({ kind: 'fix', title: 'Refunds above the limit issued without approval', count: 3, production: 1, fix: { fixId: FIX_A, rung: 'open', broken: null, status: 'open' } });
    expect(runsOf(a)).toEqual([id.a2, id.a3, id.a1]);
    expect(a.failed).toBe(LIMIT(180));
  });

  it('joins an applied fix by the count its check names, never a run that failed so after a planted instruction', () => {
    const page = read();
    expect(runsOf(issueOf(page, issueKey.fix(FIX_B)))).toEqual([id.b1]);
    const planted = issueOf(page, issueKey.planted());
    expect(planted).toMatchObject({ kind: 'planted', title: 'Failed after a planted instruction', failed: `${EMAIL}, but called 2 times`, planted: 'planted in #2 issue_refund’s result', fix: null });
    expect(runsOf(planted)).toEqual([id.p1]);
  });

  it('keeps a golden and its failed replays, titled by what its newest did as Tests says it', () => {
    const t = issueOf(read(), issueKey.golden('goldens/refund-in-limit'));
    expect(t).toMatchObject({ kind: 'test', title: null, golden: { path: 'goldens/refund-in-limit', name: 'refund-in-limit', did: 'diverged at call 1', passed: false }, fix: null, stepRun: id.t3 });
    // Its step acts on the replay its newest result made.
    // The replay a later one passed is fixed by it: Failed leaves it out, and so does its issue.
    expect(runsOf(t)).toEqual([id.t3]);
  });

  it('groups a failure no fix holds by what failed, without its amounts, and says nobody has blamed it', () => {
    const f = read().issues.find((x) => x.kind === 'failure')!;
    expect(f).toMatchObject({ title: 'cost at most $0.05, but cost $0.07', count: 2, blame: 'not blamed yet', stepRun: id.f1 });
    expect(runsOf(f)).toEqual([id.f1, id.f2]);
    expect(f.key).toBe(issueKey.failure('fail', 'cost at most $N, but cost $N'));
  });

  it('orders the issues by their newest run, and counts every failed run once', () => {
    const page = read();
    expect(page.issues.map((x) => x.newest.runId)).toEqual([id.t3, id.f1, id.a2, id.b1, id.p1]);
    expect(page.total).toBe(8);
    expect(page.issues.reduce((n, x) => n + x.count, 0)).toBe(8);
  });
});

describe('what an issue leads with', () => {
  it('leads a fix with Run blame on its newest run nobody has blamed, its card naming it, else Open fix', () => {
    const a = issueOf(read(), issueKey.fix(FIX_A));
    // The capture joined by its words too: the lists' unblamed rule takes a capture its import judged failed, as Runs counts it.
    expect(a.notBlamed).toBe(2);
    expect(a).toMatchObject({ step: { key: 'blame', label: 'Run blame' }, stepRun: id.a2 });
    expect(a.step?.sub).toBe(`Blames the newest, ${id.a2.slice(0, 10)}: finds the model call that lost it, then joins the fix its failure belongs to`);
    const b = issueOf(read(), issueKey.fix(FIX_B));
    expect(b).toMatchObject({ notBlamed: 1, fix: { rung: 'applied' }, step: { key: 'blame' }, stepRun: id.b1 });
    // On days that keep only the run the fix lists, nothing is left to blame: Open fix.
    const own = issueOf(read({ options: { from: NOW - 6 * HOUR - MIN, to: NOW - 5 * HOUR } }), issueKey.fix(FIX_A));
    expect(own).toMatchObject({ notBlamed: 0, step: { key: 'fix', label: 'Open fix', href: `#/fixes/${FIX_A}` }, stepRun: null });
  });
});

describe('narrowing', () => {
  it('counts only the runs the days and the words keep', () => {
    const days = read({ options: { from: NOW - DAY, to: NOW } });
    expect(days.issues.find((x) => x.kind === 'failure')).toMatchObject({ count: 1, first: NOW - 90 * MIN, last: NOW - 90 * MIN });
    const eu = read({ options: { q: 'label:eu' } });
    expect(eu.issues.map((x) => [x.key, x.count])).toEqual([[issueKey.fix(FIX_A), 1]]);
    expect(eu.total).toBe(1);
    // A golden's replays by its name, as Tests' Failed runs → asks for them.
    expect(read({ options: { q: 'type:test refund-in-limit' } }).issues.map((x) => [x.key, runsOf(x)])).toEqual([[issueKey.golden('goldens/refund-in-limit'), [id.t3]]]);
  });

  it("answers an issue's runs after the one its page ended on", () => {
    const after = read({ issue: issueKey.fix(FIX_A), cursor: id.a2 });
    expect(after.runs.map((r) => r.runId)).toEqual([id.a3, id.a1]);
    expect(after).toMatchObject({ more: null, count: 3 });
    expect(ISSUE_RUNS).toBe(50);
  });
});

describe("a run that fails only its family's checks", () => {
  it('is an issue of its own by what it fails today, which Find breaking commit says it can’t start from', () => {
    const s = Store.open(':memory:');
    try {
      const rec = refund(s, { amount: 200 });
      // A fork made after the golden was packed, which refunded more than the order came to.
      const fork = refund(s, { amount: 300, parent: rec, startedAt: T0 + 120_000 });
      const outcome = work(rec);
      const a = ISSUES_READS['runs-issues'](s, { kind: 'runs-issues', options: {}, outcome, next: null }, { whole: true }) as { body: string };
      const page = JSON.parse(a.body) as IssuesPage;
      const failed = 'every issue_refund call: after lookup_order, amount <= lookup_order.result.total, but issue_refund #4: amount 300 > lookup_order.result.total 240 (#2)';
      expect(page.issues).toHaveLength(1);
      expect(page.issues[0]).toMatchObject({ kind: 'today', title: failed, failed, fix: null, count: 1, step: null, stepRun: fork });
      expect(page.issues.map((i) => i.key.split(':')[0])).toEqual(['today']);
      const days = { from: T0 - DAY, to: T0 + DAY };
      const bisect = RUNS_FAILURES_READS['runs-failures'](s, { kind: 'runs-failures', options: days, outcome }, { whole: true }) as { body: string };
      expect(JSON.parse(bisect.body)).toEqual({ failures: [], familyOnly: true });
      expect(FAMILY_ONLY_FAILURES).toBe('the runs that failed on the days picked failed only their family’s checks: Find breaking commit needs a run that failed on its own');
    } finally {
      s.close();
    }
  });
});

describe('paging and resolution', () => {
  it(`carries an issue's newest ${ISSUE_RUNS} runs and asks for the rest, and a golden's issue goes once its last failed replay is fixed`, () => {
    const s = Store.open(':memory:');
    try {
      const many = Array.from({ length: ISSUE_RUNS + 2 }, (_, i) => addRun(s, { startedAt: NOW - (i + 1) * MIN, status: 'failed', calls: 'll', meta: { checks: [failing('cost at most $0.05', `cost $0.${10 + i}`)] } }));
      const pack = addRun(s, { startedAt: NOW - 10 * DAY, calls: 'll', meta: { imported: { at: NOW - 10 * DAY, from: 'goldens/refund-in-limit' } } });
      const replay = (at: number, ok: boolean) => {
        const runId = addRun(s, { parent: pack, startedAt: at, calls: ok ? 'rr' : 'f', ...(ok ? {} : { status: 'failed' as const, divergence: 1 }), meta: { test: { golden: 'goldens/refund-in-limit', session: `s-${at}` } } });
        const sessionId = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/refund-in-limit'], startedAt: at }).sessionId;
        s.addTestResult({ sessionId, golden: 'goldens/refund-in-limit', ok, runId, at: at + MIN, ...(ok ? {} : { failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)' }) });
      };
      replay(NOW - 2 * DAY, false);
      const job = (o: Partial<RunsIssuesJob> = {}) => JSON.parse((ISSUES_READS['runs-issues'](s, { kind: 'runs-issues', options: {}, outcome: null, next: null, ...o }, { whole: true }) as { body: string }).body) as IssuesPage & IssueRunsPage;
      const [cost, golden] = job().issues;
      expect(cost).toMatchObject({ count: ISSUE_RUNS + 2, more: many[ISSUE_RUNS - 1] });
      expect(runsOf(cost)).toEqual(many.slice(0, ISSUE_RUNS));
      expect(job({ issue: cost.key, cursor: cost.more })).toMatchObject({ runs: many.slice(ISSUE_RUNS).map((runId) => expect.objectContaining({ runId })), more: null, count: ISSUE_RUNS + 2 });
      expect(golden?.key).toBe(issueKey.golden('goldens/refund-in-limit'));
      // A replay that passes again fixes the one that failed: Failed leaves it out, and its issue goes with it.
      replay(NOW - DAY, true);
      expect(job().issues.map((x) => x.key)).toEqual([cost.key]);
    } finally {
      s.close();
    }
  });
});

describe('a fork and what it changed', () => {
  it('joins a fix by what failed with a what-if of your own (--inject), where a run that failed after a planted instruction stays apart', () => {
    const s = Store.open(':memory:');
    try {
      s.insertFix({ fixId: FIX_B, title: 'Sends the confirmation email twice', labels: [], check: { expect: {}, key: 'check:b', oracle: [EMAIL], text: EMAIL }, status: 'open', openedAt: NOW - 9 * HOUR, verifiedAt: null, appliedAt: null, data: {} });
      const twice = [failing(EMAIL, 'called 2 times')];
      const rec = addRun(s, { startedAt: NOW - 4 * HOUR, status: 'failed', calls: 'll', meta: { checks: twice } });
      const own = addRun(s, { parent: rec, startedAt: NOW - 3 * HOUR, calls: 'ro', meta: { interventions: [{ kind: 'inject', at: 2, flag: '--inject 2=@what-if.json' }], checks: twice } });
      const planted = addRun(s, { parent: rec, startedAt: NOW - 2 * HOUR, calls: 'ro', meta: { interventions: [{ kind: 'plant', at: 2, flag: '--inject-result 2=@payloads/exfil-email.txt' }], checks: twice } });
      const a = ISSUES_READS['runs-issues'](s, { kind: 'runs-issues', options: {}, outcome: null, next: null }, { whole: true }) as { body: string };
      const page = JSON.parse(a.body) as IssuesPage;
      expect(page.issues.map((i) => [i.key, runsOf(i)])).toEqual([
        [issueKey.planted(), [planted]],
        [issueKey.fix(FIX_B), [own, rec]],
      ]);
    } finally {
      s.close();
    }
  });
});

describe("a capture its import judged failed", () => {
  it("is an issue of its own, counted under Failed, in its issue and in the chip by the verdict it kept, while its page judges it by today's rules", () => {
    const s = Store.open(':memory:');
    try {
      const cap = refund(s, { amount: 300, meta: { covers: ['api', 'tool'], imported: { at: T0, from: 'langfuse:7f3a9c2e' } } });
      // Imported under rules that failed it; today's, changed since, would pass it.
      s.updateRunMeta(cap, { judged: judgeCapture(s, s.getCalls(cap), rulesOnCalls(parseTests(work(cap).tests)), T0)! });
      const today = work(cap, { version: 'v2', tests: { 'goldens/refund': { expect: { calls: [{ tool: 'issue_refund', after: 'lookup_order' }] } } } });
      expect(runJudged(s, loadRunIndex(s), cap, today)).toMatchObject({ by: 'import', verdict: 'passed', today: true });
      const failed = listRunsPage(s, { types: ['failed'], judge: judgeFor(s, today) });
      expect(failed.runs.map((r) => r.runId)).toEqual([cap]);
      expect(failed.chipCounts.failed).toBe(1);
      const a = ISSUES_READS['runs-issues'](s, { kind: 'runs-issues', options: {}, outcome: today, next: null }, { whole: true }) as { body: string };
      const [issue, ...rest] = (JSON.parse(a.body) as IssuesPage).issues;
      expect(rest).toEqual([]);
      expect(issue).toMatchObject({ kind: 'capture', fix: null, count: 1, production: 1, stepRun: cap });
      expect(issue.key.startsWith('cap:')).toBe(true);
    } finally {
      s.close();
    }
  });
});

describe('lookups for links', () => {
  it("gives each fix's issue runs on every day, and a run's issue", () => {
    const index = loadRunIndex(store);
    expect(issueRunsByFix(store, index).get(FIX_A)).toEqual([id.a2, id.a3, id.a1]);
    expect(issueKeyOf(store, index, id.a3)).toBe(issueKey.fix(FIX_A));
    expect(issueKeyOf(store, index, id.t1)).toBeNull();
  });

  it("counts on a fix's card, on Fixes and on its page, the runs that failed its check, while its link keeps its own; and names the unblamed row's issue", async () => {
    const short = (...runs: string[]) => runs.map((r) => r.slice(0, 10));
    const view = fixesView(store);
    expect(view.fixes.find((f) => f.fixId === FIX_A)).toMatchObject({ failing: 1, failedCheck: { count: 3, ids: short(id.a2, id.a3, id.a1) } });
    // The applied fix holds none of its own, and one failed as its check does.
    expect(view.fixes.find((f) => f.fixId === FIX_B)).toMatchObject({ failing: 0, failedCheck: { count: 1, ids: short(id.b1) } });
    expect(view.totals.failing).toBe(1);
    const page = (await runJob(store, { kind: 'fix', fixId: FIX_A, repairer: null }, { whole: true })) as { body: string };
    expect(JSON.parse(page.body)).toMatchObject({ failing: 1, failedCheck: { count: 3, ids: short(id.a2, id.a3, id.a1) } });
    const u = view.unblamed!;
    expect(u.issue).toBe(issueKeyOf(store, loadRunIndex(store), u.runId));
    expect(u.issue).not.toBeNull();
  });
});

describe('GET /api/runs/issues', () => {
  it('answers behind the session token, the same answer again a 304, and one issue with its runs after a cursor', async () => {
    const dash = await startDashboard({ store, dbPath: ':memory:' });
    try {
      const url = `${dash.url}/api/runs/issues`;
      expect((await fetch(url)).status).toBeGreaterThanOrEqual(400);
      const res = await fetch(`${url}?q=label:eu`, { headers: { 'x-shadowlap-token': dash.token } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as IssuesPage).issues.map((x) => x.key)).toEqual([issueKey.fix(FIX_A)]);
      const etag = res.headers.get('etag');
      expect(etag).toBeTruthy();
      expect((await fetch(`${url}?q=label:eu`, { headers: { 'x-shadowlap-token': dash.token, 'if-none-match': etag! } })).status).toBe(304);
      const more = await fetch(`${url}?issue=${encodeURIComponent(issueKey.fix(FIX_A))}&cursor=${id.a3}`, { headers: { 'x-shadowlap-token': dash.token } });
      expect(((await more.json()) as IssueRunsPage).runs.map((r) => r.runId)).toEqual([id.a1]);
    } finally {
      await dash.close();
    }
  });
});
