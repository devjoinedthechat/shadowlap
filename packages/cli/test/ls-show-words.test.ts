import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRepeats, formatSummary, plain, Store, summarizeRepeats, summarizeRun, type CallRecord, type Usage } from '@shadowlap/engine';

/**
 * `ls` and `show` say what the dashboard says: a run stopped before it ended (status `crashed`, or
 * left marked running by a recorder that went away) reads "interrupted", and what replaying it
 * didn't spend again "not re-spent", as a fork's summary and `--repeat`'s do; `--json` and the
 * recording format keep `crashed`.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

let work = '';
let db = '';
let recording = '';
let replay = '';
let stopped = '';
let left = '';

/** 100 uncached, 200 written to the cache, 700 read from it: 1,000 input tokens. */
const USAGE: Usage = { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 200, cacheReadInputTokens: 700 };

function shadowlap(args: string[]): Promise<{ code: number | null; stdout: string; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd: work, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let out = '';
    child.stdout.on('data', (d: Buffer) => ((stdout += d.toString()), (out += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, out }));
  });
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'sl-ls-show-'));
  db = join(work, 'store.db');
  const store = Store.open(db);
  try {
    const model = (runId: string, origin: 'live' | 'replayed') => {
      const call = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'm1', occurrence: 1 };
      store.appendCallStart({ runId, callNo: 1, ...call, origin, effect: null, requestRef: null, meta: { model: 'claude-opus-5' }, at: 1 });
      store.appendCallEnd(call, { runId, callNo: 1, attempt: 0, responseRef: store.putJson({ ok: true }), outcome: 'ok', meta: { usage: USAGE, model: 'claude-opus-5', latencyMs: 5 }, at: 2 });
    };
    const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: work } });
    model(rec.runId, 'live');
    store.endRun(rec.runId, 'completed');
    recording = rec.runId;
    const rep = store.createRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['node', 'agent.mjs'], cwd: work } });
    model(rep.runId, 'replayed');
    store.endRun(rep.runId, 'completed');
    replay = rep.runId;
    const cut = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs', 'T-2'], cwd: work } });
    model(cut.runId, 'live');
    store.endRun(cut.runId, 'crashed');
    stopped = cut.runId;
    // A recording whose recorder went away while it ran: its owner is a process that has exited.
    const gone = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs', 'T-3'], cwd: work } });
    left = gone.runId;
  } finally {
    store.close();
  }
  const raw = new DatabaseSync(db);
  raw.prepare('UPDATE run_owners SET pid = ? WHERE run_id = ?').run(spawnSync(process.execPath, ['-e', '0']).pid!, left);
  raw.close();
});
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('ls and show, in the dashboard’s words', () => {
  it('lists a run stopped before it ended, or left by its recorder, as interrupted; --json keeps crashed', async () => {
    const ls = await shadowlap(['ls']);
    expect(ls.code, ls.out).toBe(0);
    const line = (id: string) => ls.stdout.split('\n').find((l) => l.startsWith(id.slice(0, 10)))!;
    expect(line(stopped)).toMatch(/\binterrupted\b/);
    expect(line(left)).toMatch(/\binterrupted\b/);
    expect(line(recording)).toMatch(/\bcompleted\b/);
    expect(ls.stdout).not.toContain('crashed');
    const json = JSON.parse((await shadowlap(['ls', '--json'])).stdout) as Array<{ runId: string; status: string }>;
    expect(json.find((r) => r.runId === stopped)!.status).toBe('crashed');
    expect(json.find((r) => r.runId === left)!.status).toBe('running');
  });

  it('shows an interrupted run as interrupted, and keeps crashed in --json', async () => {
    const show = await shadowlap(['show', stopped]);
    expect(show.code, show.out).toBe(0);
    expect(show.stdout.split('\n')[0]).toContain(`${stopped}  recording  interrupted  `);
    expect(show.stdout).not.toContain('crashed');
    expect((await shadowlap(['show', left])).stdout.split('\n')[0]).toContain('  interrupted  ');
    const json = JSON.parse((await shadowlap(['show', stopped, '--json'])).stdout) as { run: { status: string } };
    expect(json.run.status).toBe('crashed');
  });

  it('says what a replay didn’t spend again as not re-spent, with its input tokens counted whole', async () => {
    const show = await shadowlap(['show', replay]);
    expect(show.code, show.out).toBe(0);
    expect(show.stdout).toMatch(/\$[\d.]+ not re-spent \(1k input tokens\)/);
    expect(show.stdout).not.toContain('saved by replay');
    // Each model call's input tokens: uncached, written to the cache and read from it.
    expect(show.stdout).toMatch(/#1\s+api\s+POST \/v1\/messages\s+replayed\s+ok\s+5ms\s+1k→50 tok/);
  });
});

describe('a replay’s receipt, in the dashboard’s words', () => {
  const run = { runId: 'R1', parentRunId: 'P', mode: 'replay' as const, status: 'completed' as const, divergence: null, command: { argv: ['node'], cwd: '' }, codeVersion: null, startedAt: 0, endedAt: 1 };
  const call: CallRecord = {
    runId: 'R1',
    callNo: 1,
    kind: 'api',
    name: 'POST /v1/messages',
    fingerprint: 'f',
    occurrence: 1,
    origin: 'replayed',
    effect: null,
    requestRef: null,
    meta: {},
    at: 0,
    end: { runId: 'R1', callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { usage: USAGE }, at: 0 },
    attempts: [],
  };
  const summary = summarizeRun(run, [call]);

  it('says what a fork, or a --repeat, didn’t spend again as not re-spent, as show and the dashboard do', () => {
    const fork = { ...summary, divergence: { type: 'request_changed' as const, callNo: 2, kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 1 }, cost: { ...summary.cost, spent: 0.004, saved: 0.002 } };
    const line = formatSummary(fork, plain);
    expect(line).toContain('(≈$0.0040 spent, $0.0020 not re-spent)');
    expect(line).not.toContain('saved');
    const repeats = formatRepeats(summarizeRepeats('P', [{ runId: 'A1', exitCode: 0, summary: fork, calls: [call] }]));
    expect(repeats).toContain('1k input tokens not re-spent · ≈$0.0040 spent, $0.0020 not re-spent');
    expect(repeats).not.toContain('saved');
  });
});
