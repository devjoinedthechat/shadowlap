import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/** Decision sessions in the store: kept whole, each run's part a row of its own, counted for the change feed. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const run = (runId: string, rank: number | null) => ({ runId, golden: rank === 1 ? 'goldens/refund' : null, rank, changed: rank === null ? 0 : 1, data: { runId, rank, decisions: [] } });

describe('decision sessions', () => {
  it('keeps a session and its runs, lists them newest first, and finds a run\'s', () => {
    const store = Store.open(':memory:');
    const before = store.changeCounts().decisions;
    store.putDecisionSession({ sessionId: 'dc-01M50000000000000000000001', kind: 'decisions', at: 1_000, change: 'the model m', actor: 'dev', revision: 'abc', data: { command: 'shadowlap decisions a --model m' }, runs: [run('01RUNA', 1), run('01RUNB', null)] });
    store.putDecisionSession({ sessionId: 'mg-01M50000000000000000000002', kind: 'migrate', at: 2_000, change: 'the model n', actor: null, revision: null, data: { to: 'n' }, runs: [run('01RUNA', 3)] });
    expect(store.changeCounts().decisions).toBe(before + 2);
    expect(store.listDecisionSessions().map((s) => [s.sessionId, s.kind, s.runs, s.flagged])).toEqual([
      ['mg-01M50000000000000000000002', 'migrate', 1, 0],
      ['dc-01M50000000000000000000001', 'decisions', 2, 1],
    ]);
    expect(store.listDecisionSessions({ kind: 'decisions' }).map((s) => s.sessionId)).toEqual(['dc-01M50000000000000000000001']);
    const one = store.getDecisionSession('dc-01M50000000000000000000001')!;
    expect(one).toMatchObject({ change: 'the model m', actor: 'dev', revision: 'abc', data: { command: 'shadowlap decisions a --model m' } });
    expect(one.runRows.map((r) => [r.runId, r.golden, r.rank, r.changed])).toEqual([
      ['01RUNA', 'goldens/refund', 1, 1],
      ['01RUNB', null, null, 0],
    ]);
    expect(store.decisionsOfRun('01RUNA').map((r) => [r.sessionId, r.kind, r.change, r.rank])).toEqual([
      ['mg-01M50000000000000000000002', 'migrate', 'the model n', 3],
      ['dc-01M50000000000000000000001', 'decisions', 'the model m', 1],
    ]);
    // Kept again under its id, it is replaced; deleted, its runs go with it.
    store.putDecisionSession({ sessionId: 'dc-01M50000000000000000000001', kind: 'decisions', at: 1_000, change: 'the model m', actor: 'dev', revision: 'abc', data: {}, runs: [run('01RUNB', 2)] });
    expect(store.getDecisionSession('dc-01M50000000000000000000001')!.runRows.map((r) => r.runId)).toEqual(['01RUNB']);
    store.deleteDecisionSession('dc-01M50000000000000000000001');
    expect(store.getDecisionSession('dc-01M50000000000000000000001')).toBeNull();
    expect(store.decisionsOfRun('01RUNB')).toEqual([]);
    store.close();
  });

  it("finds the judge verdicts every session of a run kept, the newest first, however many sessions there are", () => {
    const store = Store.open(':memory:');
    const side = (verdict: 'yes' | 'no' | null, request: string | null, reason: string) => ({ status: verdict === null ? 'inconclusive' : verdict === 'yes' ? 'passed' : 'failed', verdict, reason, source: verdict === null ? null : 'live', cost: 0, request });
    const judged = (recorded: ReturnType<typeof side>, now: ReturnType<typeof side>) => ({ runId: '01RUNA', rank: 2, decisions: [{ callNo: 1, judge: null }, { callNo: 2 }, { callNo: 30, judge: [{ name: 'fences', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes', recorded, now, changed: null }] }] });
    const keep = (n: number, data: Record<string, unknown>) => store.putDecisionSession({ sessionId: `dc-01M5000000000000000000${String(n).padStart(4, '0')}`, kind: 'decisions', at: n, change: 'the model m', actor: null, revision: null, data: {}, runs: [{ runId: '01RUNA', golden: null, rank: 2, changed: 1, data }] });
    // The oldest session holds the only verdict for request d-old; 30 later sessions hold others, or none.
    keep(1, judged(side('yes', 'd-recorded', 'it says so, as first asked'), side('no', 'd-old', 'it no longer says so')));
    for (let n = 2; n <= 31; n++) keep(n, judged(side('yes', 'd-recorded', `it says so, asked ${n}`), side(null, `d-${n}`, 'not judged: the budget of $0.01 is spent')));
    keep(32, { runId: '01RUNA', decisions: 'not a list' });
    const found = store.decisionJudgeVerdicts('01RUNA');
    // A side not judged is no verdict; every session's is read, the newest first, past the 20 decisionsOfRun reads.
    expect(found.filter((v) => v.request === 'd-recorded').map((v) => v.reason).slice(0, 2)).toEqual(['it says so, asked 31', 'it says so, asked 30']);
    expect(found.filter((v) => v.request === 'd-recorded')).toHaveLength(31);
    expect(found.find((v) => v.request === 'd-old')).toEqual({ request: 'd-old', verdict: 'no', reason: 'it no longer says so' });
    expect(found.some((v) => v.request.startsWith('d-2'))).toBe(false);
    expect(store.decisionJudgeVerdicts('01RUNB')).toEqual([]);
    store.close();
  });

  it('adds its tables to a store made before them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-decisions-store-'));
    dirs.push(dir);
    const path = join(dir, 'shadowlap.db');
    Store.open(path).close();
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TABLE decision_runs; DROP TABLE decision_sessions; DELETE FROM change_counts WHERE name = 'decisions'`);
    raw.close();
    const store = Store.open(path);
    expect(store.listDecisionSessions()).toEqual([]);
    expect(store.changeCounts().decisions).toBe(0);
    store.close();
  });
});
