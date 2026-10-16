import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packRun, Store, storeApiRequest, unpackRun, type CallKind, type Normalizer, type Origin, type RunMeta } from '@shadowlap/engine';
import { activity } from '../src/activity.js';
import { lineage, runDetail } from '../src/api.js';
import { runOffers } from '../src/run-offers.js';
import { listRunsPage, recentRuns, runState } from '../src/runs-list.js';
import { exportHtml, type StaticPayload } from '../src/static.js';

/**
 * A run whose recorder was killed (`kill -9`, out of memory) is left marked running with nothing
 * recording it. It reads interrupted, ended at its last call, the same way everywhere: Runs, its
 * page, its family (Forks, Provenance), the activity feed, Find the commit, and every copy made of it
 * (an HTML file, with or without redaction rules, and a pack, which a teammate unpacks).
 */

const EMAIL: Normalizer = { pattern: 'email', replace: '<EMAIL>' };
const T0 = Date.now() - 10 * 60_000;

let dir: string;
let dbPath: string;
let store: Store;
let uiDir: string;
/** A process id that was alive and is no more: the killed recorder's. */
let dead: number;
const id: Record<string, string> = {};
/** Each run's last call, where it is ended. */
const lastAt: Record<string, number> = {};

let n = 0;
function call(runId: string, callNo: number, kind: CallKind, name: string, origin: Origin, at: number) {
  const identity = { kind, name, fingerprint: `f${n++}`.padEnd(64, '0'), occurrence: 1 };
  const requestRef = kind === 'api' ? storeApiRequest(store, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'Refund for jane@example.com' }] }) : store.putJson({ args: { email: 'jane@example.com' } });
  store.appendCallStart({ runId, callNo, ...identity, origin, effect: kind === 'tool' ? 'read' : null, requestRef, meta: {}, at });
  store.appendCallEnd(identity, { runId, callNo, attempt: 0, responseRef: store.putJson({ result: 'ok' }), outcome: 'ok', meta: {}, at: at + 1 });
}

/**
 * A run with `calls` (one letter each: r replayed, l live): ended as `end` says, still recorded by this
 * process (`live`), or else left by its recorder, which was killed.
 */
function run(name: string, o: { startedAt: number; parent?: string; forkAt?: number; meta?: RunMeta; calls: string; end?: 'completed' | 'crashed'; live?: boolean }) {
  const r = store.createRun({ mode: o.parent ? 'replay' : 'record', ...(o.parent ? { parentRunId: o.parent } : {}), command: { argv: ['node', 'refund_agent.mjs', 'T-8813'], cwd: dir }, codeVersion: 'a7b3c2e', startedAt: o.startedAt, ...(o.meta ? { meta: o.meta } : {}) });
  id[name] = r.runId;
  [...o.calls].forEach((c, i) => call(r.runId, i + 1, i % 2 ? 'tool' : 'api', i % 2 ? 'lookup_order' : 'POST /v1/messages', c === 'r' ? 'replayed' : 'live', o.startedAt + 10 * (i + 1)));
  lastAt[name] = o.startedAt + 10 * o.calls.length + 1;
  if (o.forkAt) store.setDivergence(r.runId, { type: 'request_changed', callNo: o.forkAt, kind: 'api', name: 'POST /v1/messages', replayedBefore: o.forkAt - 1 });
  if (o.end) store.endRun(r.runId, o.end, lastAt[name]);
  else if (!o.live) {
    // Its recorder was killed: the store still names it, and it is gone.
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE run_owners SET pid = ? WHERE run_id = ?').run(dead, r.runId);
    db.close();
  }
  return r.runId;
}

function embedded(html: string): StaticPayload {
  const m = /<script type="application\/json" id="shadowlap-data">(.*?)<\/script>/s.exec(html);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!.split('<\\/').join('</')) as StaticPayload;
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sl-run-left-')));
  mkdirSync(join(dir, '.shadowlap'));
  dbPath = join(dir, '.shadowlap', 'shadowlap.db');
  store = Store.open(dbPath);
  dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  const base = run('base', { startedAt: T0, calls: 'llll', end: 'completed' });
  run('rec', { startedAt: T0 + 1000, calls: 'lll' });
  run('fork', { startedAt: T0 + 2000, parent: base, forkAt: 2, calls: 'rll' });
  run('attempt', { startedAt: T0 + 3000, parent: base, forkAt: 3, meta: { repeat: { group: 'g1', attempt: 1, of: 2 } }, calls: 'rrl' });
  run('attempt2', { startedAt: T0 + 3100, parent: base, forkAt: 3, meta: { repeat: { group: 'g1', attempt: 2, of: 2 } }, calls: 'rrll', end: 'completed' });
  run('stopped', { startedAt: T0 + 4000, parent: base, forkAt: 2, calls: 'rl', end: 'crashed' });
  // Recording right now, in this process.
  run('live', { startedAt: Date.now() - 5000, calls: 'l', live: true });
  // A stand-in for the built UI, as static.test.ts has it.
  uiDir = join(dir, 'ui');
  mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app { color: red }\n');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a run whose recorder was killed', () => {
  it('reads interrupted, ended at its last call, in Runs and on its page', () => {
    expect(store.getRun(id.rec!)!.status, 'the store still marks it running').toBe('running');
    expect(runState(store, id.rec!)).toMatchObject({ status: 'crashed', endedAt: lastAt.rec, outcome: { kind: 'none' }, failed: false, interrupted: true });
    const row = listRunsPage(store, { limit: 500 }).runs.find((r) => r.runId === id.rec)!;
    expect(row).toMatchObject({ status: 'crashed', endedAt: lastAt.rec, outcome: { kind: 'none' }, failed: false });
    const page = runDetail(store, id.rec!)!;
    expect(page.run).toMatchObject({ status: 'crashed', endedAt: lastAt.rec });
    expect(page.summary.durationMs).toBe(lastAt.rec! - (T0 + 1000));
    // A run recording now is left as it is.
    expect(runDetail(store, id.live!)!.run).toMatchObject({ status: 'running', endedAt: null });
  });

  it('reads interrupted in its family, an attempt the lists leave out included', () => {
    const nodes = lineage(store, id.base!)!;
    const node = (name: string) => nodes.find((x) => x.runId === id[name])!;
    for (const name of ['fork', 'attempt']) expect(node(name), name).toMatchObject({ status: 'crashed', outcome: { kind: 'none' }, failed: false });
    expect(node('stopped')).toMatchObject({ status: 'crashed', outcome: { kind: 'none' }, failed: false });
    expect(node('attempt2')).toMatchObject({ status: 'completed' });
    expect(node('base')).toMatchObject({ status: 'completed', kind: 'recording' });
    // The family and the lists agree on every run they both show.
    for (const r of recentRuns(store, { includeAttempts: true })) {
      const x = nodes.find((y) => y.runId === r.runId);
      if (x) expect({ status: x.status, outcome: x.outcome, failed: x.failed }, r.runId).toEqual({ status: r.status, outcome: r.outcome, failed: r.failed });
    }
  });

  it('reads interrupted in the activity feed, and no longer as recording', () => {
    const items = activity(store, { limit: 200 }).items;
    const item = (key: string) => items.find((i) => i.id === key);
    const start = item(`r:${id.rec}:start`)!;
    expect(start).toMatchObject({ kind: 'live', text: 'Recording started · node refund_agent.mjs T-8813' });
    expect(start.live, 'nothing records it').toBeUndefined();
    expect(item(`r:${id.rec}:end`)).toMatchObject({ kind: 'rec', at: lastAt.rec, text: 'Recording interrupted · 3 calls · node refund_agent.mjs T-8813' });
    expect(item(`r:${id.fork}:end`)).toMatchObject({ kind: 'fork', at: lastAt.fork, text: 'Forked at #2 · 2 live · interrupted' });
    // Stopped with Ctrl-C, it reads the same.
    expect(item(`r:${id.stopped}:end`)).toMatchObject({ kind: 'fork', text: 'Forked at #2 · 1 live · interrupted' });
    // Its --repeat is done: no attempt of it records any more.
    expect(item('g:g1')!.live).toBeUndefined();
    // The recording in progress still is.
    expect(item(`r:${id.live}:start`)).toMatchObject({ live: true });
    expect(item(`r:${id.live}:end`)).toBeUndefined();
  });

  it('is offered Find the commit as a run stopped with Ctrl-C is, never as one still recording', () => {
    const offer = runOffers(store, id.fork!, { redact: [], config: null })!.bisect!;
    expect(offer.unavailable ?? '').not.toMatch(/still recording/);
    // A fork stopped with Ctrl-C gets the same offer.
    const stopped = runOffers(store, id.stopped!, { redact: [], config: null })!.bisect!;
    expect({ failed: offer.failed, fork: offer.fork, good: offer.good, unavailable: offer.unavailable }).toEqual({ failed: stopped.failed, fork: stopped.fork, good: stopped.good, unavailable: stopped.unavailable });
    // The store is read, never changed.
    expect(store.getRun(id.fork!)!.status).toBe('running');
  });

  it('is copied as interrupted into an HTML file, with redaction rules and without', () => {
    for (const redact of [[EMAIL], []]) {
      const out = exportHtml({ store, runIds: [id.base!, id.rec!], uiDir, version: null, redact, now: Date.now() });
      expect(out.redacted).toBe(redact.length > 0);
      const data = embedded(out.html);
      const page = data.responses[`runs/${id.rec}`] as { run: { status: string; endedAt: number | null }; state: { interrupted: boolean } };
      expect(page.run, `${redact.length} rules`).toMatchObject({ status: 'crashed', endedAt: lastAt.rec });
      expect(page.state).toMatchObject({ interrupted: true });
      const runs = (data.responses['runs'] as { runs: Array<{ runId: string; status: string }> }).runs;
      expect(runs.find((r) => r.runId === id.rec)).toMatchObject({ status: 'crashed' });
      // Nothing in the file says it records.
      expect((data.responses['meta'] as { live: unknown[] }).live).toEqual([]);
      const family = (data.responses[`runs/${id.rec}/lineage`] as { nodes: Array<{ runId: string; status: string }> }).nodes;
      expect(family.find((x) => x.runId === id.rec)).toMatchObject({ status: 'crashed' });
      if (redact.length) expect(out.html).not.toContain('jane@example.com');
    }
    // The store it came from is not changed.
    expect(store.getRun(id.rec!)!.status).toBe('running');
  });

  it('is packed as interrupted, and a teammate who unpacks it reads it so', () => {
    const pack = join(dir, 'pack-left');
    packRun(store, id.fork!, pack, { lineage: true, redact: [EMAIL] });
    const manifest = JSON.parse(readFileSync(join(pack, 'run.json'), 'utf8')) as { runs: Array<{ runId: string; status: string; endedAt: number | null }> };
    expect(manifest.runs.map((r) => [r.runId, r.status, r.endedAt])).toEqual([
      [id.base, 'completed', lastAt.base],
      [id.fork, 'crashed', lastAt.fork],
    ]);
    const theirs = Store.open(':memory:');
    try {
      expect(unpackRun(theirs, pack).imported).toEqual([id.base, id.fork]);
      expect(theirs.getRun(id.fork!)).toMatchObject({ status: 'crashed', endedAt: lastAt.fork });
      expect(runState(theirs, id.fork!)).toMatchObject({ status: 'crashed', interrupted: true });
    } finally {
      theirs.close();
    }
    expect(store.getRun(id.fork!)!.status).toBe('running');
  });
});

describe('a run imported as running, that nothing has added to for a day', () => {
  it('reads interrupted in the feed, as in the lists', () => {
    const mem = Store.open(':memory:');
    try {
      const runId = '01K4ZZ00000000000000LEFT00';
      const at = Date.now() - 3 * 24 * 3_600_000;
      mem.importRun({ runId, parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: null, startedAt: at, endedAt: null });
      const items = activity(mem).items;
      expect(items.find((i) => i.id === `r:${runId}:start`)!.live).toBeUndefined();
      expect(items.find((i) => i.id === `r:${runId}:end`)).toMatchObject({ kind: 'rec', at, text: 'Recording interrupted · 0 calls · node agent.mjs' });
      expect(runState(mem, runId)).toMatchObject({ status: 'crashed', endedAt: at, interrupted: true });
    } finally {
      mem.close();
    }
  });
});
