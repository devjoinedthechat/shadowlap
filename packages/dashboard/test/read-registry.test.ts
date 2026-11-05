import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
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
/** The recording, its fork and the fix it fails in, by the same ids in either store. */
const REC = '01K8RG00000000000000000001';
const FORK = '01K8RG00000000000000000002';
const FIX = 'fx-01K8RG00000000000000000003';

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
  training: { kind: 'training', tasks: [], tasksError: null, normalizers: [], filter: 'all' },
  fix: { kind: 'fix', fixId: FIX, repairer: null },
  outcome: { kind: 'outcome', runId: FORK, work: null },
  next: { kind: 'next', runId: FORK, outcome: null, next: null },
  'run-estimates': { kind: 'run-estimates', runId: FORK, at: 1, model: null },
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
