import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { runJob, type ReadJob } from '../src/read-jobs.js';
import type { OutcomeWork } from '../src/run-outcome.js';
import { ROW_CALLS_BUDGET } from '../src/runs-list.js';
import { recordLoop } from './long-run.js';
import { addRun, HOUR } from './read-model-store.js';

/**
 * `status:` on a run with more calls than a read judges, as Runs asks while the table says it is
 * warming: a run its outcome decides matches at once, and one only its family's checks decide is
 * judged beside the server once the read is answered, so the page's next ask has it, and stops
 * warming. The table and the days above it read it alike.
 */

const LONG = ROW_CALLS_BUDGET + 1;

let store: Store | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

/** What a dashboard works out ahead as it starts: every run's totals, so a row's are known. */
async function warmUp(s: Store): Promise<void> {
  while (!(await runJob(s, { kind: 'warm', budgetMs: 10_000 })).warm?.done);
}

/** Runs' table and the days above it for `q`, as the pool answers them, with the job each hands on. */
async function read(s: Store, q: string, outcome: OutcomeWork | null) {
  const page = await runJob(s, { kind: 'runs-page', options: { limit: 50, q }, team: null, outcome, next: null });
  const days = await runJob(s, { kind: 'runs-days', options: { tz: 'UTC', q }, team: null, outcome });
  const body = JSON.parse(page.body) as { runs: Array<{ runId: string }>; warming?: unknown; judgeAfter?: unknown };
  const counted = JSON.parse(days.body) as { totals: { runs: number }; warming?: unknown; judgeAfter?: unknown };
  return { runs: body.runs.map((r) => r.runId), warming: body.warming ?? null, sent: [body.judgeAfter, counted.judgeAfter], days: counted.totals.runs, daysWarming: counted.warming ?? null, then: [page.then ?? null, days.then ?? null] };
}

describe('status: on a run with more calls than a read judges', () => {
  it('matches a run its own failed check decides at once, with nothing to wait for', async () => {
    store = Store.open(':memory:');
    const failedCount = { status: 'failed' as const, ok: false, label: 'send_email called at most 1 time', detail: null };
    const long = addRun(store, { startedAt: Date.now() - 2 * HOUR, calls: 'l'.repeat(LONG + 9), status: 'failed', meta: { checks: [failedCount] } });
    addRun(store, { startedAt: Date.now() - HOUR, calls: 'll' });
    await warmUp(store);
    for (let i = 0; i < 3; i++) {
      const r = await read(store, 'status:failed', null);
      expect(r).toMatchObject({ runs: [long], warming: null, days: 1, daysWarming: null, then: [null, null] });
    }
  }, 60_000);

  it('judges one only its family’s checks decide beside the server, after the read, and the next read has it', async () => {
    store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'report.mjs'], cwd: '/work/project' }, startedAt: Date.now() - HOUR });
    recordLoop(store, run, LONG);
    await warmUp(store);
    // Its golden allows ten reads: the eleventh is where it failed, by today's checks.
    const outcome: OutcomeWork = { version: 'v1', tests: { 'goldens/report': { expect: { tools: { read_file: '<= 10' } } } }, dir: '/work/project', goldens: [{ path: 'goldens/report', runId: run.runId, packedAt: Date.now(), checksAt: null }] };
    const judge: ReadJob = { kind: 'outcome', runId: run.runId, work: outcome };
    // However often it is asked, a read alone never judges it: it waits, and hands it on, never in what it sends.
    for (let i = 0; i < 2; i++) {
      const r = await read(store, 'status:failed', outcome);
      expect(r).toMatchObject({ runs: [], warming: { done: 0, total: 1, what: 'verdicts' }, days: 0, daysWarming: { done: 0, total: 1, what: 'verdicts' }, sent: [undefined, undefined], then: [judge, judge] });
    }
    await runJob(store, judge);
    const after = await read(store, 'status:failed', outcome);
    expect(after).toMatchObject({ runs: [run.runId], warming: null, days: 1, daysWarming: null, then: [null, null] });
  }, 120_000);
});
