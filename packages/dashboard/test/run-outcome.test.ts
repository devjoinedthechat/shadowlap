import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { judgeCapture, parseTests, rulesOnCalls, Store, type RunRecord } from '@shadowlap/engine';
import { RunBuilder, text, toolUse, usage, user } from '../../engine/test/run-fixtures.js';
import { runJob } from '../src/read-jobs.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import { judgedRows, runJudged, type OutcomeWork, type RunJudged } from '../src/run-outcome.js';
import { loadRunIndex } from '../src/run-index.js';
import type { GoldenSource } from '../src/tests.js';
import { recordLoop } from './long-run.js';

/**
 * A run's outcome by checks (run-outcome.ts, A13 and E26): its own checks; a capture's verdict by the
 * rules on calls, kept as it was imported and judged again once they change; and for a finished run
 * that kept no verdict, its family's goldens' checks as the config gives them now, judged from its
 * recording, by today's checks when it was recorded before them. Kept per config version, judged
 * within a budget on a list, whole on a run's page, and always beside the server.
 */

const T0 = 1_760_000_000_000;
const ASK = [user('Order A-1042 arrived damaged. Refund it, please.')];
const WITHIN_TOTAL = { tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } };

/** A refund run: the order looked up (total 240), refunded for `amount`, and an email sent. */
function refund(store: Store, o: { amount: number; parent?: string; startedAt?: number; meta?: RunRecord['meta'] }): string {
  const b = RunBuilder.start(store, { startedAt: o.startedAt ?? T0, ...(o.parent ? { parent: o.parent } : {}), ...(o.meta ? { meta: o.meta } : {}) });
  b.model({ messages: ASK }, [toolUse('lookup_order', { order_id: 'A-1042' }, 'toolu_1')], { usage: usage(120) });
  b.tool('lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', total: 240 });
  b.model({ messages: ASK }, [toolUse('issue_refund', { order_id: 'A-1042', amount: o.amount }, 'toolu_2')], { usage: usage(160) });
  b.tool('issue_refund', { order_id: 'A-1042', amount: o.amount }, { refund_id: 'R-5401' }, { effect: 'write' });
  b.tool('send_email', { to: 'ada@example.com' }, { sent: true }, { effect: 'write' });
  b.model({ messages: ASK }, [text('Refund issued for order A-1042.')], { usage: usage(200) });
  return b.end();
}

/** What the server would read of a project whose golden `goldens/refund` was packed from `runId` at `packedAt`. */
function work(runId: string, o: { tests?: unknown; version?: string; packedAt?: number } = {}): OutcomeWork {
  return {
    version: o.version ?? 'v1',
    tests: o.tests ?? { 'goldens/refund': { expect: { calls: [WITHIN_TOTAL], tools: { send_email: '<= 1' } } } },
    dir: '/work/project',
    changedAt: o.packedAt ?? T0 + 60_000,
    goldens: [{ path: 'goldens/refund', runId, packedAt: o.packedAt ?? T0 + 60_000 }],
  };
}

const judge = (store: Store, id: string, w: OutcomeWork | null, o: Parameters<typeof runJudged>[4] = {}) => runJudged(store, loadRunIndex(store), id, w, o);

describe("a run judged by its family's checks", () => {
  it('judges a run that kept no verdict, at the call it failed, by today’s checks when it was recorded before them', () => {
    const store = Store.open(':memory:');
    const rec = refund(store, { amount: 200 });
    // A fork made after the golden was packed, which refunded more than the order came to.
    const fork = refund(store, { amount: 300, parent: rec, startedAt: T0 + 120_000 });
    const w = work(rec);
    expect(judge(store, fork, w, { checks: true })).toEqual({
      by: 'family',
      verdict: 'failed',
      counts: { passed: 1, failed: 1, inconclusive: 0, notApplicable: 0 },
      callNo: 4,
      first: { label: 'every issue_refund call: after lookup_order, amount <= lookup_order.result.total', detail: 'issue_refund #4: amount 300 > lookup_order.result.total 240 (#2)' },
      today: false,
      goldens: ['goldens/refund'],
      why: null,
      checks: [
        { label: 'send_email called at most 1 time', status: 'passed', detail: null, callNo: null, golden: 'goldens/refund' },
        { label: 'every issue_refund call: after lookup_order, amount <= lookup_order.result.total', status: 'failed', detail: 'issue_refund #4: amount 300 > lookup_order.result.total 240 (#2)', callNo: 4, golden: 'goldens/refund' },
      ],
    } satisfies RunJudged);
    // The recording itself was recorded before the golden was packed from it: by today's checks.
    expect(judge(store, rec, w)).toMatchObject({ by: 'family', verdict: 'passed', today: true, callNo: null });
    // Without the project's config, or a family golden with checks, nothing judges it.
    expect(judge(store, fork, null)).toBeNull();
    expect(judge(store, fork, work('01K8RG00000000000000000099'))).toBeNull();
    store.close();
  });

  it('keeps what it judged per config version, and judges again once the config or the goldens change', () => {
    const store = Store.open(':memory:');
    const rec = refund(store, { amount: 200 });
    const fork = refund(store, { amount: 300, parent: rec, startedAt: T0 + 120_000 });
    let read = 0;
    const calls = () => (read++, store.getCalls(fork));
    expect(judge(store, fork, work(rec), { calls })?.verdict).toBe('failed');
    expect(judge(store, fork, work(rec), { calls })?.verdict).toBe('failed');
    expect(read).toBe(1);
    // A check changed: the config's version moves, and the run is judged by the checks as they are.
    const loose = work(rec, { version: 'v2', tests: { 'goldens/refund': { expect: { tools: { send_email: '<= 1' } } } } });
    expect(judge(store, fork, loose, { calls })?.verdict).toBe('passed');
    expect(read).toBe(2);
    store.close();
  });

  it("takes a run's own checks first, and leaves an attempt, a run still recording and one that failed to their own verdicts", () => {
    const store = Store.open(':memory:');
    const rec = refund(store, { amount: 200 });
    const own = refund(store, { amount: 300, parent: rec, startedAt: T0 + 120_000, meta: { checks: [{ status: 'failed', ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }] } });
    // Its own count failed: the call past what it allows, from its calls on the run's page; from the detail alone on a list.
    expect(judge(store, own, work(rec))).toMatchObject({ by: 'own', verdict: 'failed', callNo: 5, today: false, first: { label: 'send_email called 0 times', detail: 'called 1 time' } });
    expect(judge(store, own, work(rec), { quick: true })).toMatchObject({ by: 'own', callNo: null });
    const probe = refund(store, { amount: 300, parent: rec, startedAt: T0 + 120_000, meta: { probe: { of: rec, callNo: 3, passed: false }, repeat: { group: 'g', attempt: 1, of: 3 } } });
    expect(judge(store, probe, work(rec))).toBeNull();
    store.close();
  });
});

describe("a capture's verdict by the rules on calls", () => {
  it('is the one kept as it was imported while the rules stay, and is judged again by today’s once they change', () => {
    const store = Store.open(':memory:');
    const id = refund(store, { amount: 300, meta: { covers: ['api', 'tool'], imported: { at: T0, from: 'langfuse:7f3a9c2e' } } });
    const lenient = { 'goldens/refund': { expect: { calls: [{ tool: 'issue_refund', after: 'lookup_order' }] } } };
    store.updateRunMeta(id, { judged: judgeCapture(store, store.getCalls(id), rulesOnCalls(parseTests(lenient)), T0)! });
    expect(judge(store, id, work(id, { tests: lenient }))).toMatchObject({ by: 'import', verdict: 'passed', today: false });
    // Without the project, the verdict it kept still says how it came out.
    expect(judge(store, id, null)).toMatchObject({ by: 'import', verdict: 'passed', today: false });
    // The config's rules changed (its version with them): judged again, by today's rules.
    expect(judge(store, id, work(id, { version: 'v2' }))).toMatchObject({ by: 'import', verdict: 'failed', today: true, callNo: 4 });
    store.close();
  });
});

describe('the rows and the run payload', () => {
  it('carry the outcome: every list row within a budget of calls, and the run payload with each check', async () => {
    const store = Store.open(':memory:');
    const rec = refund(store, { amount: 200 });
    const fork = refund(store, { amount: 300, parent: rec, startedAt: T0 + 120_000 });
    const w = work(rec);
    const rows: Array<{ runId: string; judged?: RunJudged | null }> = [{ runId: fork }, { runId: rec }];
    // A budget of none judges what reads no call; the run's page judges the fork whole, and the list has it after.
    expect(judgedRows(store, rows, w, 0)).toEqual(rows);
    expect(judgedRows(store, rows, w, 6).map((r) => r.judged?.verdict)).toEqual(['failed', undefined]);
    const page = await runJob(store, { kind: 'runs-page', options: {}, team: null, outcome: w }, { whole: true });
    const listed = (JSON.parse(page.body) as { runs: Array<{ runId: string; judged: RunJudged | null }> }).runs;
    expect(listed.map((r) => [r.runId, r.judged?.verdict, r.judged?.callNo, r.judged?.today, r.judged?.checks])).toEqual([
      [fork, 'failed', 4, false, undefined],
      [rec, 'passed', null, true, undefined],
    ]);
    const recent = JSON.parse((await runJob(store, { kind: 'recent', read: {}, outcome: w }, { whole: true })).body) as { runs: Array<{ runId: string; judged: RunJudged | null }> };
    expect(recent.runs.find((r) => r.runId === fork)?.judged?.verdict).toBe('failed');
    const detail = JSON.parse((await runJob(store, { kind: 'run', runId: fork, read: {}, outcome: w })).body) as { judged: RunJudged };
    expect(detail.judged.checks?.map((c) => [c.status, c.callNo])).toEqual([
      ['passed', null],
      ['failed', 4],
    ]);
    // Without the work, the run's own verdict, or none.
    expect((JSON.parse((await runJob(store, { kind: 'run', runId: fork, read: {} })).body) as { judged: unknown }).judged).toBeNull();
    store.close();
  });
});

describe('a run of 100,000 calls', () => {
  const dirs: string[] = [];
  let dash: Dashboard | null = null;
  afterAll(async () => {
    await dash?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('is judged beside the server, never on its thread, and its page and outcome say the same', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-run-outcome-'));
    dirs.push(dir);
    const dbPath = join(dir, 'shadowlap.db');
    const store = Store.open(dbPath);
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'report.mjs'], cwd: dir }, startedAt: T0 });
    recordLoop(store, run, 100_000);
    // Its golden allows ten reads: the eleventh, call #22, is where it failed, by today's checks.
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/report': { expect: { tools: { read_file: '<= 10' } } } } }));
    const golden: GoldenSource = { path: 'goldens/report', runId: run.runId, packedAt: Date.now(), mode: 'replay', repeat: 1, passes: 1, checks: ['read_file called at most 10 times'] };
    dash = await startDashboard({ store, dbPath, port: 0, project: { path: dir }, goldens: () => [golden] });
    const read = vi.spyOn(store, 'getCalls');
    try {
      const res = await fetch(`${dash.url}/api/runs/${run.runId}/outcome`, { headers: { 'x-shadowlap-token': dash.token } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { judged: RunJudged };
      expect(body.judged).toMatchObject({ by: 'family', verdict: 'failed', callNo: 22, today: true, goldens: ['goldens/report'] });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  }, 180_000);
});
