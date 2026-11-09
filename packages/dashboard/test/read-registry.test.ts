import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gateResult, Store } from '@shadowlap/engine';
import { readKinds, runJob, type ReadJob } from '../src/read-jobs.js';
import { LocalReads, ReadPool } from '../src/read-pool.js';
import { answer, failed, readRegistry } from '../src/read-registry.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

/**
 * The pooled reads answer each job by the handler its kind is registered with (read-registry.ts):
 * read-jobs.ts's own table, then each feature's from its own module. Every kind registered answers
 * on a read-model thread beside the server (read-pool.ts `ReadPool`, a store with a file) as on the
 * server's own thread for a store in memory (`LocalReads`), given the same runs. `JOBS` holds one job
 * of each kind: one registered without a job there fails the tests' type check. A job of a kind no
 * table registers fails, on a thread as on the server's own, and the thread goes on answering.
 */

const NOW = Date.UTC(2026, 9, 20, 12);
/** The recording, its fork, the fix it fails in and a preview of it, by the same ids in either store. */
const REC = '01K8RG00000000000000000001';
const FORK = '01K8RG00000000000000000002';
const FIX = 'fx-01K8RG00000000000000000003';
const SESSION = 'dc-01K8RG00000000000000000004';

/** A job of every kind the tables register, about the runs and the fix below; the warm-up and an analysis last, as they keep what they work out. */
const JOBS: { [K in ReadJob['kind']]: Extract<ReadJob, { kind: K }> } = {
  summary: { kind: 'summary', work: { tz: 'UTC', now: NOW, goldens: [], team: null, project: null } },
  run: { kind: 'run', runId: FORK, read: {} },
  calls: { kind: 'calls', runId: REC, read: {}, from: 1, limit: 100 },
  call: { kind: 'call', runId: REC, read: {}, callNo: 1 },
  lineage: { kind: 'lineage', runId: FORK, read: {} },
  compare: { kind: 'compare', a: REC, b: FORK, cwd: null },
  'compare-head': { kind: 'compare-head', a: REC, b: FORK },
  'runs-page': { kind: 'runs-page', options: { q: 'refund_agent' }, team: null },
  'runs-days': { kind: 'runs-days', options: { tz: 'UTC', now: NOW }, team: null },
  recent: { kind: 'recent', read: {} },
  differences: { kind: 'differences', runId: FORK, normalizers: [] },
  unrecorded: { kind: 'unrecorded', runId: REC, declared: {} },
  groups: { kind: 'groups', fixId: FIX },
  activity: { kind: 'activity', before: null },
  show: { kind: 'show', runId: REC, read: {} },
  search: { kind: 'search', q: 'refund', limit: 10 },
  provenance: { kind: 'provenance', runId: REC, read: {}, mask: { rules: 0, values: null } },
  'injection-run': { kind: 'injection-run', runId: REC },
  'tool-trust': { kind: 'tool-trust' },
  'tool-reads': { kind: 'tool-reads' },
  'store-facts': { kind: 'store-facts', stores: [{ id: 'here', dbPath: null, keep: null }] },
  training: { kind: 'training', tasks: [], tasksError: null, normalizers: [], redactRules: 0, filter: 'all' },
  fix: { kind: 'fix', fixId: FIX, repairer: null },
  fixes: { kind: 'fixes', status: 'all', project: null, repairer: null, next: null },
  outcome: { kind: 'outcome', runId: FORK, work: null },
  next: { kind: 'next', runId: FORK, outcome: null, next: null },
  'tests-steps': { kind: 'tests-steps', goldens: ['goldens/refund'], next: null },
  'tests-evidence': { kind: 'tests-evidence', golden: 'goldens/refund' },
  'runs-failures': { kind: 'runs-failures', options: { from: 0, to: NOW + 1, q: 'refund_agent' }, outcome: null },
  'run-estimates': { kind: 'run-estimates', runId: FORK, at: 1, model: null },
  'fix-estimates': { kind: 'fix-estimates', fixId: FIX, repairer: null, rule: { keptMax: null, baseline: 'paired' }, model: null },
  'tests-estimates': { kind: 'tests-estimates', goldens: [{ path: 'goldens/refund', runId: REC, packedAt: null, mode: 'fork', repeat: 1, passes: 1, checks: [] }], folder: 'goldens' },
  'bisect-estimate': { kind: 'bisect-estimate', commits: 6, target: { runId: FORK, fork: true } },
  'decision-estimates': { kind: 'decision-estimates', sessionId: SESSION, runId: null, work: null, rule: { keptMax: null, baseline: 'paired' } },
  'held-by': { kind: 'held-by', what: 'run', ids: [REC], stores: [] },
  'gate-preview': { kind: 'gate-preview', gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 }, history: null, risk: 0.05 },
  'request-diff': { kind: 'request-diff', runId: FORK, callNo: null, normalizers: [] },
  warm: { kind: 'warm', budgetMs: 50 },
  analyse: { kind: 'analyse', runId: REC },
};

let dir: string;
let dbPath: string;
/** A store with a file, whose read models are worked out on threads beside the server. */
let file: Store;
/** A store in memory, whose read models are worked out on the server's own thread. */
let memory: Store;
let pool: ReadPool;
let local: LocalReads;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-read-registry-'));
  dbPath = join(dir, 'shadowlap.db');
  file = Store.open(dbPath);
  memory = Store.open(':memory:');
  for (const store of [file, memory]) {
    addRun(store, { runId: REC, startedAt: NOW - DAY, argv: ['node', 'refund_agent.mjs'], calls: [{ code: 'l', request: { messages: [{ role: 'user', content: 'Refund order A-1131.' }] } }, { code: 'l', kind: 'tool' }, { code: 'l' }] });
    addRun(store, { runId: FORK, parent: REC, startedAt: NOW - HOUR, divergence: 3, calls: 'rrl' });
    const check = { expect: { tools: { issue_refund: { count: 0 } } }, key: 'check:x', oracle: ['issue_refund never called'], text: 'issue_refund never called' };
    store.insertFix({ fixId: FIX, title: 'Refunds issued without approval', labels: [], check, status: 'open', openedAt: NOW - HOUR, verifiedAt: null, appliedAt: null, data: {} });
    store.addFixLink(FIX, 'failing', REC, NOW - HOUR);
    // A preview that couldn't clear the recording.
    const decided = { runId: REC, golden: null, steps: 2, asked: 2, rank: 1, majority: 1, counts: {}, cost: { before: 0.004, after: 0.002, spent: 0.001 }, tokens: {}, thinkingStripped: 0, refused: null, decisions: [], warnings: [] };
    store.putDecisionSession({ sessionId: SESSION, kind: 'decisions', at: NOW - HOUR, change: 'the model claude-haiku-4-5', actor: null, revision: null, data: { change: { model: 'claude-haiku-4-5', fields: {}, from: null, fromCode: null, text: 'the model claude-haiku-4-5' }, flagged: [REC], toVerify: [REC], verify: null }, runs: [{ runId: REC, golden: null, rank: 1, changed: 1, data: decided }] });
    // Its event, worded by the feed on whichever thread reads it.
    store.addEvent({ eventId: '01K8RG00000000000000000005', kind: 'decisions.done', ref: SESSION, data: { change: 'the model claude-haiku-4-5', runs: 1, flagged: 1, spent: 0.001 }, at: NOW - HOUR });
    // A gated golden's last result, for its evidence: one session, its attempt the fork.
    const tested = store.startTestSession({ sessionId: 'ts-registry', command: ['shadowlap', 'test', 'goldens/refund'], startedAt: NOW - HOUR }).sessionId;
    store.addTestResult({ sessionId: tested, golden: 'goldens/refund', ok: true, runId: FORK, goldenRunId: REC, revision: null, at: NOW - HOUR, data: { attempts: { total: 1, passed: 1, required: null, runs: [FORK] }, gate: gateResult({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 }, Array<boolean>(12).fill(true)) } });
  }
  pool = new ReadPool({ dbPath, keep: { stats: (rows) => void file.saveRunStats(rows), asks: (rows) => void file.saveRunAsks(rows) } });
  local = new LocalReads(() => memory);
});

afterAll(async () => {
  await Promise.all([pool.close(), local.close()]);
  file.close();
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the pooled reads by kind', () => {
  it('answer every kind registered on a thread beside the server as on a store in memory', async () => {
    expect(Object.keys(JOBS).sort()).toEqual(readKinds());
    // Through every run first: until then a thread answers the Overview and the runs' totals with how
    // far the warm-up has got, where the server's thread works them out.
    for (let i = 0; i < 400 && !pool.warmed; i++) await new Promise((r) => setTimeout(r, 25));
    expect(pool.warmed).toBe(true);
    for (const job of Object.values(JOBS)) {
      const [there, here] = await Promise.all([pool.run(job), local.run(job)]);
      // Each about what the stores hold: an answer, never a run or a fix that isn't there.
      expect(here.status, job.kind).toBe(200);
      expect({ status: there.status, body: JSON.parse(there.body) as unknown }, job.kind).toEqual({ status: here.status, body: JSON.parse(here.body) as unknown });
    }
    // A feature's events read in its own words on a thread too, though the thread loads no route module.
    const feed = JSON.parse((await pool.run(JOBS.activity)).body) as { items: Array<{ text: string }> };
    expect(feed.items.map((i) => i.text)).toContain('Previewed the model claude-haiku-4-5 on 1 run · 1 with a write, stop or judged change');
  });

  it('answer each kind by the handler its table registers it with', () => {
    const estimate = () => answer({ usd: 0.02 }, { tagged: true });
    const outcome = () => failed(404, 'no run 01K8RG');
    const reads = readRegistry([{ estimate }, { outcome }]);
    expect([...reads.keys()]).toEqual(['estimate', 'outcome']);
    expect(reads.get('estimate')).toBe(estimate);
    expect(reads.get('outcome')).toBe(outcome);
  });

  it('refuse a kind two tables register, as the dashboard loads', () => {
    const one = () => answer(null);
    expect(() => readRegistry([{ estimate: one }, { outcome: one, estimate: one }])).toThrow('read job kind "estimate" is registered twice');
  });

  it('fail a job of a kind no table registers, saying the build may be behind, on a thread that goes on answering', async () => {
    const nope = { kind: 'nope' } as unknown as ReadJob;
    const words = 'no read model answers a job of kind "nope": is the dashboard built?';
    await expect(runJob(memory, nope)).rejects.toThrow(words);
    // On a thread, where it happens: one built before a kind was registered, given a job of it by a
    // newer server. The job fails through the thread's 'error', in the same words, and the thread
    // lives on: the only one, it answers the next job, and nothing says it stopped.
    const lines: string[] = [];
    const one = new ReadPool({ dbPath, keep: { stats: (rows) => void file.saveRunStats(rows), asks: (rows) => void file.saveRunAsks(rows) }, size: 1, log: (l) => lines.push(l) });
    try {
      // Warmed first: no slice of the warm-up holds the thread, so no spare starts beside it.
      for (let i = 0; i < 400 && !one.warmed; i++) await new Promise((r) => setTimeout(r, 25));
      expect(one.warmed).toBe(true);
      await expect(one.run(nope)).rejects.toThrow(words);
      expect((await one.run({ kind: 'tool-reads' })).status).toBe(200);
      // Through the thread's 'error', which logs the failure, and never as a thread that stopped.
      const said = lines.join('\n');
      expect(said).toMatch(/^a read model failed: .*no read model answers a job of kind "nope": is the dashboard built\?/m);
      expect(said).not.toContain('a read-model thread stopped');
    } finally {
      await one.close();
    }
  });
});
