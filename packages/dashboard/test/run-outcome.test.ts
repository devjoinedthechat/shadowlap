import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { judgeCapture, parseTests, rulesOnCalls, shadowlapHome, Store, withLockFile } from '@shadowlap/engine';
import { CHECKS_SEEN_FILE } from '../src/checks-seen.js';
import type { RouteContext } from '../src/context.js';
import { runJob } from '../src/read-jobs.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import { exportHtml } from '../src/static.js';
import { nextStepWork, outcomeWork, projectWork } from '../src/outcome-work.js';
import { judgedRows, runJudged, type OutcomeWork, type RunJudged } from '../src/run-outcome.js';
import { normalizeRunDetail } from '../ui/normalize.js';
import { outcomeFact } from '../ui/run/metrics.js';
import { runLikeOf } from '../ui/run/model.js';
import type { RunDetail } from '../ui/types.js';
import { loadRunIndex } from '../src/run-index.js';
import type { GoldenSource } from '../src/tests.js';
import { recordLoop } from './long-run.js';
import { refund, T0, WITHIN_TOTAL, work } from './refund-family.js';

/**
 * A run's outcome by checks (run-outcome.ts, A13 and E26): its own checks; a capture's verdict by the
 * rules on calls, kept as it was imported and judged again once they change; and for a finished run
 * that kept no verdict, its family's goldens' checks as the config gives them now, judged from its
 * recording, by today's checks when it was recorded before them. Kept per config version, judged
 * within a budget on a list, whole on a run's page, and always beside the server.
 */

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
      since: 'packed',
      goldens: ['goldens/refund'],
      why: null,
      checks: [
        { label: 'send_email called at most 1 time', status: 'passed', detail: null, callNo: null, golden: 'goldens/refund' },
        { label: 'every issue_refund call: after lookup_order, amount <= lookup_order.result.total', status: 'failed', detail: 'issue_refund #4: amount 300 > lookup_order.result.total 240 (#2)', callNo: 4, golden: 'goldens/refund' },
      ],
    } satisfies RunJudged);
    // The recording itself was recorded before the golden was packed from it: by today's checks.
    expect(judge(store, rec, w)).toMatchObject({ by: 'family', verdict: 'passed', today: true, callNo: null });
    // Its checks changed after the fork was made: the fork is judged by today's checks too.
    expect(judge(store, fork, work(rec, { version: 'v2', checksAt: T0 + 180_000 }))).toMatchObject({ verdict: 'failed', today: true, since: 'changed' });
    // A write to the config that changed no golden's checks leaves it judged by the checks it was made under.
    expect(judge(store, fork, work(rec, { version: 'v3' }))).toMatchObject({ verdict: 'failed', today: false });
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
    // Its own count failed: the call past what it allows, which only its calls tell, so a list waits for them as for its totals.
    expect(judge(store, own, work(rec), { quick: true })).toBeUndefined();
    expect(judge(store, own, work(rec))).toMatchObject({ by: 'own', verdict: 'failed', callNo: 5, today: false, first: { label: 'send_email called 0 times', detail: 'called 1 time' } });
    expect(judge(store, own, work(rec), { quick: true })).toMatchObject({ by: 'own', callNo: 5 });
    const probe = refund(store, { amount: 300, parent: rec, startedAt: T0 + 120_000, meta: { probe: { of: rec, callNo: 3, passed: false }, repeat: { group: 'g', attempt: 1, of: 3 } } });
    expect(judge(store, probe, work(rec))).toBeNull();
    store.close();
  });

  it("holds a family's check on what the agent printed inconclusive, as shadowlap check does", () => {
    const store = Store.open(':memory:');
    const rec = refund(store, { amount: 200 });
    const printed = work(rec, { tests: { 'goldens/refund': { expect: { tools: { issue_refund: 1 }, output: { includes: 'Refund issued' } } } } });
    expect(judge(store, rec, printed, { checks: true })).toMatchObject({
      by: 'family',
      verdict: 'inconclusive',
      first: { label: 'output includes "Refund issued"', detail: 'a recording keeps no output' },
      checks: [
        { label: 'issue_refund called 1 time', status: 'passed' },
        { label: 'output includes "Refund issued"', status: 'inconclusive', detail: 'a recording keeps no output' },
      ],
    });
    store.close();
  });
});

describe('a list of runs', () => {
  it("judges a run's own count at the call past it within its budget, as its page does", () => {
    const store = Store.open(':memory:');
    const rec = refund(store, { amount: 200 });
    const own = refund(store, { amount: 300, parent: rec, startedAt: T0 + 120_000, meta: { checks: [{ status: 'failed', ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }] } });
    // Past the budget the row waits, as its totals do; within it, the count's call: the email, #5.
    const rows: Array<{ runId: string; judged?: RunJudged | null }> = [{ runId: own }];
    expect(judgedRows(store, rows, null, 0)).toEqual([{ runId: own }]);
    const [row] = judgedRows(store, rows, null, 6, { checks: true });
    expect(row?.judged).toMatchObject({ by: 'own', verdict: 'failed', callNo: 5, checks: [{ status: 'failed', callNo: 5 }] });
    // Once judged, a list has it with no budget at all, and without each check where it shows none.
    expect(judgedRows(store, rows, null, 0)[0]?.judged).toEqual(expect.objectContaining({ callNo: 5 }));
    expect(judgedRows(store, rows, null, 0)[0]?.judged?.checks).toBeUndefined();
    store.close();
  });

  it('reads no call of a capture with no rule on calls to judge it by, and spends none of its budget', () => {
    const store = Store.open(':memory:');
    const cap = refund(store, { amount: 300, meta: { covers: ['api', 'tool'], imported: { at: T0, from: 'langfuse:7f3a9c2e' } } });
    const next = refund(store, { amount: 200, startedAt: T0 + 1000, meta: { checks: [{ status: 'failed', ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }] } });
    const read = vi.spyOn(store, 'getCalls');
    try {
      // A project with goldens and counts, and no rule on calls.
      const counts = work(cap, { tests: { 'goldens/refund': { expect: { tools: { send_email: '<= 1' } } } } });
      const listed: Array<{ runId: string; judged?: RunJudged | null }> = [{ runId: cap }, { runId: next }];
      const rows = judgedRows(store, listed, counts, 6);
      expect(rows[0]?.judged).toBeNull();
      expect(read.mock.calls.map(([id]) => id)).toEqual([next]);
      expect(rows[1]?.judged).toMatchObject({ callNo: 5 });
    } finally {
      read.mockRestore();
    }
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
    // A budget of none judges what reads no call: a run no golden of its family judges says so at once.
    const lone = refund(store, { amount: 1, startedAt: T0 + 180_000 });
    expect(judgedRows(store, [...rows, { runId: lone }], w, 0)).toEqual([...rows, { runId: lone, judged: null }]);
    // Within the budget, newest first: the fork's 6 calls fit, the recording's don't.
    expect(judgedRows(store, rows, w, 6).map((r) => r.judged?.verdict)).toEqual(['failed', undefined]);
    // Once its page has judged the recording, a list has it with no call read, without each check.
    expect(judge(store, rec, w, { checks: true })?.checks).toHaveLength(2);
    const after = judgedRows(store, rows, w, 0);
    expect(after.map((r) => r.judged?.verdict)).toEqual(['failed', 'passed']);
    expect(after.map((r) => r.judged?.checks)).toEqual([undefined, undefined]);
    const page = await runJob(store, { kind: 'runs-page', options: {}, team: null, outcome: w }, { whole: true });
    const listed = (JSON.parse(page.body) as { runs: Array<{ runId: string; judged: RunJudged | null }> }).runs;
    // Runs' rows carry each check, for Status's hover.
    expect(listed.map((r) => [r.runId, r.judged?.verdict, r.judged?.callNo, r.judged?.today, r.judged?.checks?.map((c) => [c.status, c.callNo])])).toEqual([
      [lone, undefined, undefined, undefined, undefined],
      [fork, 'failed', 4, false, [['passed', null], ['failed', 4]]],
      [rec, 'passed', null, true, [['passed', null], ['passed', null]]],
    ]);
    // The sidebar's carry the verdict, and leave each check out: it shows none.
    const recent = JSON.parse((await runJob(store, { kind: 'recent', read: {}, outcome: w }, { whole: true })).body) as { runs: Array<{ runId: string; judged: RunJudged | null }> };
    expect(recent.runs.find((r) => r.runId === fork)?.judged).toMatchObject({ verdict: 'failed', callNo: 4, first: { detail: 'issue_refund #4: amount 300 > lookup_order.result.total 240 (#2)' } });
    expect(recent.runs.find((r) => r.runId === fork)?.judged?.checks).toBeUndefined();
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

describe('what the server reads of the project', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const golden = (packedAt: number): GoldenSource => ({ path: 'goldens/refund', runId: '01K8RG00000000000000000001', packedAt, mode: 'replay', repeat: 1, passes: 1, checks: [] });

  it("lists the goldens once while nothing they were read from changes, and keeps when a golden's checks changed", () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-outcome-work-'));
    dirs.push(dir);
    const config = join(dir, 'shadowlap.config.json');
    const write = (send: string | number, at: number, more: Record<string, unknown> = {}) => {
      writeFileSync(config, JSON.stringify({ ...more, tests: { 'goldens/refund': { expect: { tools: { send_email: send } } } } }));
      utimesSync(config, new Date(at), new Date(at));
    };
    write('<= 1', T0 + 1000);
    let listed = 0;
    const ctx = { project: { path: dir }, options: { goldens: () => (listed++, [golden(T0)]) }, read: {} } as unknown as RouteContext;
    const first = outcomeWork(ctx)!;
    expect(outcomeWork(ctx)).toBe(first);
    expect(listed).toBe(1);
    // First seen, its checks came with it: no time of a change.
    expect(first.goldens).toEqual([{ path: 'goldens/refund', runId: '01K8RG00000000000000000001', packedAt: T0, checksAt: null }]);
    // A write that changes its checks: read again, the change timed by the write.
    write(0, T0 + 5000);
    const changed = outcomeWork(ctx)!;
    expect(listed).toBe(2);
    expect(changed.version).not.toBe(first.version);
    expect(changed.goldens[0]?.checksAt).toBe(T0 + 5000);
    // A write that leaves its checks as they were (a price): read again, the time it changed kept.
    write(0, T0 + 9000, { prices: { 'claude-haiku-4-5': { input: 1, output: 5 } } });
    expect(outcomeWork(ctx)!.goldens[0]?.checksAt).toBe(T0 + 5000);
    expect(listed).toBe(3);
    // Kept for this machine, for a dashboard started later.
    const kept = JSON.parse(readFileSync(join(shadowlapHome(), CHECKS_SEEN_FILE), 'utf8')) as { projects: Record<string, Record<string, { at: number | null }>> };
    expect(kept.projects[dir]?.['goldens/refund']?.at).toBe(T0 + 5000);
  });

  it('answers while another process writes what is kept of the checks, and keeps them on the next request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-outcome-held-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/refund': { expect: { tools: { send_email: '<= 1' } } } } }));
    let listed = 0;
    const ctx = { project: { path: dir }, options: { goldens: () => (listed++, [golden(T0)]) }, read: {} } as unknown as RouteContext;
    const file = join(shadowlapHome(), CHECKS_SEEN_FILE);
    const keptFor = () => (existsSync(file) ? Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { projects: object }).projects) : []);
    // The lock held, as by another dashboard writing the file: the request is answered all the same.
    const first = withLockFile(`${file}.lock`, { wait: 0, busy: () => new Error('held') }, () => outcomeWork(ctx)!);
    expect(first.goldens).toEqual([{ path: 'goldens/refund', runId: '01K8RG00000000000000000001', packedAt: T0, checksAt: null }]);
    expect(keptFor()).not.toContain(dir);
    // The next request reads again, and keeps them; the one after answers from what that one read.
    const next = outcomeWork(ctx)!;
    expect(listed).toBe(2);
    expect(next.goldens).toEqual(first.goldens);
    expect(keptFor()).toContain(dir);
    expect(outcomeWork(ctx)).toBe(next);
    expect(listed).toBe(2);
  });

  it('hands a request that asks for what judges a run and what its next step reads both, from one look at the files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-outcome-both-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tests: {} }));
    const ctx = { project: { path: dir }, options: { goldens: () => [] }, read: {} } as unknown as RouteContext;
    const both = projectWork(ctx);
    expect(both.outcome).toBe(outcomeWork(ctx));
    expect(both.next).toBe(nextStepWork(ctx));
    // Outside a project, only the goldens it was given.
    expect(projectWork({ project: null, options: { goldens: () => [golden(T0)] }, read: {} } as unknown as RouteContext)).toMatchObject({ outcome: null, next: { goldens: [golden(T0)], dir: null } });
  });

  it('picks up a pack whose run.json arrives after its folder, as one copied in by hand or by git checkout does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-outcome-pack-'));
    dirs.push(dir);
    const folder = join(dir, 'goldens', 'refund');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tests: {} }));
    // As the CLI lists them: a pack is a folder with its run.json in it.
    const list = () => (existsSync(join(folder, 'run.json')) ? [golden(T0)] : []);
    const ctx = { project: { path: dir }, options: { goldens: list }, read: {} } as unknown as RouteContext;
    expect(outcomeWork(ctx)!.goldens).toEqual([]);
    // Nothing else moves: the goldens folder's own time doesn't, as the pack's folder is there already.
    const at = statSync(join(dir, 'goldens')).mtimeMs;
    writeFileSync(join(folder, 'run.json'), '{}');
    expect(statSync(join(dir, 'goldens')).mtimeMs).toBe(at);
    expect(outcomeWork(ctx)!.goldens).toEqual([{ path: 'goldens/refund', runId: '01K8RG00000000000000000001', packedAt: T0, checksAt: null }]);
  });
});

describe('an exported copy', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("holds each run's own verdict and a capture's kept from its import, read from the copy its redaction rules make", () => {
    const uiDir = mkdtempSync(join(tmpdir(), 'sl-run-outcome-ui-'));
    dirs.push(uiDir);
    mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
    writeFileSync(join(uiDir, 'assets', 'app.css'), '.app { color: red }\n');
    writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
    writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const store = Store.open(':memory:');
    const cap = refund(store, { amount: 300, meta: { covers: ['api', 'tool'], imported: { at: T0, from: 'langfuse:7f3a9c2e' } } });
    store.updateRunMeta(cap, { judged: judgeCapture(store, store.getCalls(cap), rulesOnCalls(parseTests({ 'goldens/refund': { expect: { calls: [WITHIN_TOTAL] } } })), T0)! });
    const own = refund(store, { amount: 200, startedAt: T0 + 1000, meta: { checks: [{ status: 'failed', ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }] } });
    // With a rule, the file is made from a copy of the runs with their records masked (redact.ts).
    const redact = [{ kind: 'tool' as const, name: '*', path: '$.order_id', pattern: 'A-\\d+', replace: '<ORDER>' }];
    const { html } = exportHtml({ store, runIds: [cap, own], uiDir, now: T0 + 5000, redact });
    const data = JSON.parse(/<script type="application\/json" id="shadowlap-data">(.*?)<\/script>/s.exec(html)![1].split('<\\/').join('</')) as { responses: Record<string, { judged?: RunJudged | null; runs?: Array<{ runId: string; judged?: RunJudged | null }> }> };
    expect(data.responses[`runs/${cap}`]?.judged).toMatchObject({ by: 'import', verdict: 'failed', callNo: 4, first: { detail: 'issue_refund #4: amount 300 > lookup_order.result.total 240 (#2)' } });
    expect(data.responses[`runs/${own}`]?.judged).toMatchObject({ by: 'own', verdict: 'failed', callNo: 5 });
    const rows = data.responses['runs']?.runs ?? [];
    expect(rows.find((r) => r.runId === cap)?.judged).toMatchObject({ by: 'import', verdict: 'failed', checks: [{ status: 'failed' }] });
    expect(rows.find((r) => r.runId === own)?.judged).toMatchObject({ by: 'own', callNo: 5 });
    store.close();
  });
});

describe("a run's page", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('is answered anew once a check that judges it changes, and as it was while none does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-run-outcome-etag-'));
    dirs.push(dir);
    const dbPath = join(dir, 'shadowlap.db');
    const store = Store.open(dbPath);
    const rec = refund(store, { amount: 200 });
    const fork = refund(store, { amount: 300, parent: rec, startedAt: T0 + 120_000 });
    const config = join(dir, 'shadowlap.config.json');
    writeFileSync(config, JSON.stringify({ tests: { 'goldens/refund': { expect: { tools: { send_email: '<= 1' } } } } }));
    const golden: GoldenSource = { path: 'goldens/refund', runId: rec, packedAt: T0 + 60_000, mode: 'replay', repeat: 1, passes: 1, checks: [] };
    const dash = await startDashboard({ store, dbPath, port: 0, project: { path: dir }, goldens: () => [golden] });
    try {
      const get = (etag?: string) => fetch(`${dash.url}/api/runs/${fork}`, { headers: { 'x-shadowlap-token': dash.token, ...(etag ? { 'if-none-match': etag } : {}) } });
      const first = await get();
      expect(first.status).toBe(200);
      expect(((await first.json()) as { judged: RunJudged }).judged).toMatchObject({ by: 'family', verdict: 'passed' });
      const etag = first.headers.get('etag')!;
      expect((await get(etag)).status).toBe(304);
      // A rule the fork breaks, added to its golden: the page it had is stale, and it is answered anew.
      writeFileSync(config, JSON.stringify({ tests: { 'goldens/refund': { expect: { calls: [WITHIN_TOTAL], tools: { send_email: '<= 1' } } } } }));
      const again = await get(etag);
      expect(again.status).toBe(200);
      expect(((await again.json()) as { judged: RunJudged }).judged).toMatchObject({ verdict: 'failed', callNo: 4 });
    } finally {
      await dash.close();
      store.close();
    }
  }, 60_000);
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
    const get = async (path: string) => {
      const res = await fetch(`${dash!.url}/api/runs/${run.runId}${path}`, { headers: { 'x-shadowlap-token': dash!.token } });
      expect(res.status).toBe(200);
      return res.json();
    };
    // What the page's first fact shows of an answer: the payload's verdict, or nothing yet where it has none (RunMetrics).
    const fact = (body: unknown) => {
      const d = normalizeRunDetail(body as RunDetail);
      return outcomeFact({ ...runLikeOf(d), judged: d.judged ?? null }, { tools: d.summary.byKind.tool, pending: d.judged === undefined });
    };
    try {
      // Its first answer comes from its first calls, before its analysis judged it: no verdict yet, never "no checks".
      const first = await get('');
      expect(first).toMatchObject({ warming: { total: 100_000 } });
      expect(first).not.toHaveProperty('judged');
      expect(fact(first)).toMatchObject({ words: '…', callNo: null });
      // The page asks for the outcome alone meanwhile, which the run's thread works out whole.
      const body = (await get('/outcome')) as { judged: RunJudged };
      expect(body.judged).toMatchObject({ by: 'family', verdict: 'failed', callNo: 22, today: true, goldens: ['goldens/report'] });
      // Asked again, its page has it, and says what the outcome does.
      const again = await get('');
      expect(fact(again)).toMatchObject({ tone: 'err', words: 'check failed at', callNo: 22, today: true });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  }, 180_000);
});
