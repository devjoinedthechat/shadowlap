import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRecordings, labelNotes, labelNoteWords, packRun, parseExpect, Store, type RunRecord } from '@shadowlap/engine';
import type { CheckPreview, CheckPreviewJob } from '../src/check-preview.js';
import { runJob } from '../src/read-jobs.js';
import { LocalReads, ReadPool } from '../src/read-pool.js';

/**
 * The check builder's preview read (check-preview.ts): a draft judged on the agent's newest finished
 * recordings, at most the job's limit, as `shadowlap check --expect` judges the same recordings
 * (the engine's checkRecordings): the same outcomes, counts with not applicable apart, and notes,
 * its label notes naming three recordings each, without the run the check is made from. The run
 * it is made from and each golden's recording are judged too: from the store, else from a pack,
 * read into a store in memory. The same answer on a thread beside the server as on its own thread.
 */

/** A run id whose first ten characters, what a note names it by, are its own. */
const id = (n: number) => `01K8RG${String(n).padStart(4, '0')}0000000000000000`;
const AGENT = ['node', 'agent.mjs'];

interface Tool {
  name: string;
  args?: unknown;
  result?: unknown;
}

/** An order over the refund limit, refunded; one held back for a person; a small one, refunded. */
const OVER: Tool[] = [
  { name: 'lookup_order', args: { order: 'A-1131' }, result: { total: 240 } },
  { name: 'issue_refund', args: { order: 'A-1131', amount: 240 }, result: { ok: true } },
];
const HELD: Tool[] = [
  { name: 'lookup_order', args: { order: 'A-1132' }, result: { total: 240 } },
  { name: 'escalate', args: { order: 'A-1132' }, result: { ticket: 'T-9' } },
];
const SMALL: Tool[] = [
  { name: 'lookup_order', args: { order: 'A-1133' }, result: { total: 80 } },
  { name: 'issue_refund', args: { order: 'A-1133', amount: 80 }, result: { ok: true } },
];

/** No refund where the order is over 200: an order of 80 meets no condition, and it applies to nothing. */
const EXPECT = { when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { tools: { issue_refund: 0 } } }] };
/** No refund at all, and a condition on a field no result has, which no recording can settle. */
const TYPO = { tools: { issue_refund: 0 }, when: [{ if: { tool: 'lookup_order', result: { totl: { '>': 200 } } }, then: { tools: { escalate: 0 } } }] };

/** A recording of `argv` by the id given, so two stores hold the same runs. */
function record(store: Store, runId: string, argv: string[], tools: Tool[], o: { at: number; labels?: string[]; status?: 'completed' | 'running'; parent?: string }): string {
  const run = store.createRun({
    runId,
    mode: o.parent ? 'replay' : 'record',
    ...(o.parent ? { parentRunId: o.parent } : {}),
    command: { argv, cwd: '/work' },
    startedAt: o.at,
    ...(o.labels ? { meta: { labels: o.labels } } : {}),
  });
  tools.forEach((t, i) => {
    const callNo = i + 1;
    const identity = { kind: 'tool' as const, name: t.name, fingerprint: createHash('sha256').update(`${t.name} ${callNo}`).digest('hex'), occurrence: 1 };
    store.appendCallStart({ runId, callNo, ...identity, origin: 'live', effect: t.name.startsWith('lookup') ? 'read' : 'write', requestRef: store.putJson({ args: t.args ?? {} }), meta: {}, at: o.at + callNo });
    store.appendCallEnd(identity, { runId, callNo, attempt: 0, responseRef: store.putJson({ result: t.result ?? null }), outcome: 'ok', meta: {}, at: o.at + callNo });
  });
  if (o.status !== 'running') store.endRun(run.runId, o.status ?? 'completed', o.at + 100);
  return run.runId;
}

/** The agent's finished recordings, newest first: three within the limit below, two past it. */
const [R1, R2, R3, R4, R5] = [1, 2, 3, 4, 5].map(id);
/** Recorded only in a pack, never in the stores. */
const PACKED = id(9);

let dir: string;
let file: Store;
let memory: Store;
let pool: ReadPool;
let local: LocalReads;
let pack: string;
let noPack: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-check-preview-'));
  const dbPath = join(dir, 'shadowlap.db');
  file = Store.open(dbPath);
  memory = Store.open(':memory:');
  for (const store of [file, memory]) {
    record(store, R1, AGENT, OVER, { at: 9000, labels: ['good'] });
    record(store, R2, AGENT, HELD, { at: 8000, labels: ['bug'] });
    record(store, R3, AGENT, SMALL, { at: 7000 });
    record(store, R4, AGENT, OVER, { at: 6000, labels: ['good'] });
    record(store, R5, AGENT, HELD, { at: 5000 });
    // None of the agent's finished recordings: one still running, a replay of one, another agent's.
    record(store, id(6), AGENT, OVER, { at: 9500, status: 'running' });
    record(store, id(7), AGENT, OVER, { at: 9600, parent: R1 });
    record(store, id(8), ['python', 'other_agent.py'], OVER, { at: 9700, labels: ['good'] });
  }
  const scratch = Store.open(':memory:');
  record(scratch, PACKED, AGENT, OVER, { at: 4000 });
  pack = join(dir, 'goldens', 'packed');
  packRun(scratch, PACKED, pack);
  scratch.close();
  noPack = join(dir, 'goldens', 'no-pack');
  mkdirSync(noPack, { recursive: true });
  pool = new ReadPool({ dbPath, keep: { stats: (rows) => void file.saveRunStats(rows), asks: (rows) => void file.saveRunAsks(rows) } });
  local = new LocalReads(() => memory);
});

afterAll(async () => {
  await Promise.all([pool.close(), local.close()]);
  file.close();
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

const job = (more: Partial<CheckPreviewJob> = {}): CheckPreviewJob => ({ kind: 'check-preview', expect: EXPECT, agent: 'node agent.mjs', madeFrom: null, goldens: [], limit: 3, ...more });

async function preview(j: CheckPreviewJob): Promise<CheckPreview> {
  const res = await runJob(memory, j);
  expect(res.status, res.body).toBe(200);
  return JSON.parse(res.body) as CheckPreview;
}

/** What `shadowlap check --expect` reports on the same recordings. */
function checked(runIds: string[], raw: Record<string, unknown> = EXPECT) {
  const spec = parseExpect(raw, 'expect');
  const runs = runIds.map((r) => memory.getRun(r)).filter((r): r is RunRecord => !!r);
  return checkRecordings(runs.map((run) => ({ run, store: memory, pack: null, spec, source: '--expect' })), { expect: raw });
}

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

describe('a draft judged on the agent’s recordings', () => {
  it('judges the agent’s newest finished recordings up to the limit, as shadowlap check judges the same recordings', async () => {
    const p = await preview(job());
    // Five of the agent's finished recordings, the newest three judged: none running, replayed or another agent's.
    expect(p.total).toBe(5);
    expect(p.judged.map((r) => r.runId)).toEqual([R1, R2, R3]);
    const report = checked([R1, R2, R3]);
    expect(p.judged.map((r) => [r.runId, r.outcome, r.labels, r.why, r.checks])).toEqual(report.recordings.map((r) => [r.runId, r.outcome, r.labels, r.why, r.checks]));
    // Not applicable apart: the small order meets no condition, and never counts as passed.
    expect(p.counts).toEqual(report.counts);
    expect(p.counts).toEqual({ passed: 1, failed: 1, inconclusive: 0, notApplicable: 1 });
    expect(p.judged.map((r) => r.na)).toEqual([false, false, true]);
    // The label notes in the builder's words, naming three recordings each.
    expect(p.notes).toEqual(labelNotes(report.recordings).map((n) => capitalised(labelNoteWords(n, { first: 3 }))));
    expect(p.notes).toEqual([`Fails 1 recording labelled good: ${R1.slice(0, 10)}`, `Passes 1 recording labelled bug: ${R2.slice(0, 10)}`]);
    // The tools the recordings judged call, first seen first.
    expect(p.tools).toEqual(['lookup_order', 'issue_refund', 'escalate']);
  });

  it('judges past the limit only with a larger one, the counts and notes still the report’s', async () => {
    const p = await preview(job({ limit: 200 }));
    expect(p.judged.map((r) => r.runId)).toEqual([R1, R2, R3, R4, R5]);
    const report = checked([R1, R2, R3, R4, R5]);
    expect(p.counts).toEqual(report.counts);
    expect(p.counts).toEqual({ passed: 2, failed: 2, inconclusive: 0, notApplicable: 1 });
    expect(p.notes[0]).toBe(`Fails 2 recordings labelled good: ${R1.slice(0, 10)} and ${R4.slice(0, 10)}`);
  });

  it('keeps the report’s note on a value no call judged has, after the label notes', async () => {
    const p = await preview(job({ expect: TYPO }));
    const report = checked([R1, R2, R3], TYPO);
    expect(p.counts).toEqual(report.counts);
    expect(p.counts).toEqual({ passed: 0, failed: 2, inconclusive: 1, notApplicable: 0 });
    const label = labelNotes(report.recordings);
    expect(label).toHaveLength(1);
    expect(p.notes).toEqual([capitalised(labelNoteWords(label[0], { first: 3 })), ...report.notes.slice(1)]);
    expect(p.notes).toHaveLength(2);
    expect(p.notes[1]).toBe('expect.when[0].if.result["totl"] reads result.totl from lookup_order, which none of the 3 lookup_order calls judged has: did you mean total?');
  });

  it('leaves the run the check is made from out of the label notes, and judges it past the limit too', async () => {
    const made = await preview(job({ madeFrom: R1 }));
    expect(made.madeFrom).toEqual(made.judged[0]);
    expect(made.counts).toEqual({ passed: 1, failed: 1, inconclusive: 0, notApplicable: 1 });
    expect(made.notes).toEqual([`Passes 1 recording labelled bug: ${R2.slice(0, 10)}`]);
    const past = await preview(job({ madeFrom: R4 }));
    expect(past.judged.map((r) => r.runId)).toEqual([R1, R2, R3]);
    expect(past.madeFrom).toMatchObject({ runId: R4, outcome: 'failed', labels: ['good'], na: false });
  });

  it('judges each golden’s recording, from the store, else from its pack, and says why one can’t be read', async () => {
    const goldens = [
      { path: 'goldens/held', runId: R5, pack: null },
      { path: 'goldens/packed', runId: PACKED, pack },
      { path: 'goldens/gone', runId: id(10), pack: null },
      { path: 'goldens/no-pack', runId: null, pack: noPack },
    ];
    const p = await preview(job({ goldens }));
    expect(p.goldens.map((g) => [g.path, g.runId, g.row?.outcome ?? null, g.tools])).toEqual([
      ['goldens/held', R5, 'passed', ['lookup_order', 'escalate']],
      ['goldens/packed', PACKED, 'failed', ['lookup_order', 'issue_refund']],
      ['goldens/gone', id(10), null, []],
      ['goldens/no-pack', null, null, []],
    ]);
    expect(p.goldens.map((g) => g.error)).toEqual([null, null, 'its recording is in neither the store nor a pack', expect.stringContaining(noPack)]);
    // The pack is read into a store of its own: nothing of it lands in the project's.
    expect(memory.getRun(PACKED)).toBeNull();
  });

  it('answers the same on a thread beside the server as on the server’s own', async () => {
    const j = job({ madeFrom: R4, goldens: [{ path: 'goldens/held', runId: R5, pack: null }, { path: 'goldens/packed', runId: PACKED, pack }] });
    const [there, here] = await Promise.all([pool.run(j), local.run(j)]);
    expect(here.status).toBe(200);
    expect({ status: there.status, body: JSON.parse(there.body) as unknown }).toEqual({ status: here.status, body: JSON.parse(here.body) as unknown });
    expect(file.getRun(PACKED)).toBeNull();
  });
});
