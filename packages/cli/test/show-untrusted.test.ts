import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type CallMeta, type Effect } from '@shadowlap/engine';
import { runInjection, showRunJson } from '@shadowlap/dashboard';
import { departures } from './json-shapes.js';

/**
 * `shadowlap show` tags a run's untrusted reads as the dashboard does: the reads of a tool its SDK,
 * its MCP server's openWorldHint or the config's `tools` mark untrusted, which is where `shadowlap
 * injection` plants. A write, a read the config trusts again and an unmarked read are not tagged.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const TOOLS = { read_inbox: { trust: 'untrusted' as const }, get_doc: { trust: 'trusted' as const } };

let work = '';
let db = '';
let runId = '';
let plainRun = '';

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
  work = mkdtempSync(join(tmpdir(), 'sl-show-untrusted-'));
  db = join(work, 'store.db');
  writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tools: TOOLS }));
  const store = Store.open(db);
  try {
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: work } });
    const tool = (callNo: number, name: string, effect: Effect, meta: CallMeta = {}) => {
      store.appendCallStart({ runId: run.runId, callNo, kind: 'tool', name, fingerprint: `f${callNo}`, occurrence: 1, origin: 'live', effect, requestRef: store.putJson({ args: { n: callNo } }), meta, at: callNo });
      store.appendCallEnd({ kind: 'tool', name, fingerprint: `f${callNo}`, occurrence: 1 }, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result: 'ok' }), outcome: 'ok', meta: {}, at: callNo });
    };
    tool(1, 'fetch_page', 'read', { trust: 'untrusted', trustFrom: 'sdk' });
    tool(2, 'web_search', 'read', { mcp: { transport: 'stdio', server: 'search' }, trust: 'untrusted', trustFrom: 'mcp' });
    tool(3, 'read_inbox', 'read');
    tool(4, 'lookup_order', 'read');
    tool(5, 'get_doc', 'read', { trust: 'untrusted', trustFrom: 'sdk' });
    tool(6, 'send_email', 'write', { trust: 'untrusted', trustFrom: 'sdk' });
    store.endRun(run.runId, 'completed');
    runId = run.runId;
    // A run with no untrusted read: its timeline is as it always was.
    const plain = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: work } });
    store.appendCallStart({ runId: plain.runId, callNo: 1, kind: 'tool', name: 'lookup_order', fingerprint: 'g', occurrence: 1, origin: 'live', effect: 'read', requestRef: null, meta: {}, at: 1 });
    store.endRun(plain.runId, 'completed');
    plainRun = plain.runId;
  } finally {
    store.close();
  }
});
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('shadowlap show and untrusted reads', () => {
  it('lists them with where each mark came from and tags their rows, leaving a write, a read trusted again and an unmarked one alone', async () => {
    const r = await shadowlap(['show', runId]);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('  untrusted reads: #1 fetch_page (SDK), #2 web_search (MCP openWorldHint), #3 read_inbox (config) · shadowlap injection plants in them\n');
    const row = (callNo: number) => r.stdout.split('\n').find((l) => l.startsWith(`  #${callNo} `))!;
    for (const n of [1, 2, 3]) expect(row(n)).toMatch(/^ {2}#\d+\s+tool\s+\w+\s+untrusted\s+live\s+ok/);
    for (const n of [4, 5, 6]) expect(row(n)).not.toContain('untrusted');
    // The tag is a column of its own: every row's origin starts where the others' does.
    expect(new Set([1, 2, 3, 4, 5, 6].map((n) => row(n).indexOf(' live ')))).toHaveProperty('size', 1);
    // A run with none has no such column and no such line.
    const plain = await shadowlap(['show', plainRun]);
    expect(plain.stdout).not.toContain('untrusted');
    expect(plain.stdout).toMatch(/\n {2}#1 {2}tool {2}lookup_order {2}live {2}pending/);
  });

  it('prints them in the JSON as the dashboard lists them, and the dashboard serves the same object', async () => {
    const r = await shadowlap(['show', runId, '--json']);
    expect(r.code, r.out).toBe(0);
    const shown = JSON.parse(r.stdout) as { untrusted: Array<{ callNo: number; name: string; from: string }> };
    expect(shown.untrusted).toEqual([
      { callNo: 1, name: 'fetch_page', from: 'sdk' },
      { callNo: 2, name: 'web_search', from: 'mcp' },
      { callNo: 3, name: 'read_inbox', from: 'config' },
    ]);
    for (const u of shown.untrusted) expect(departures('showUntrusted', u)).toEqual({ missing: [], extra: [] });
    const store = Store.open(db);
    try {
      // GET /api/injection/runs/:id's list, with the same config.
      expect(shown.untrusted).toEqual(runInjection(store, runId, TOOLS).untrusted);
      // GET /api/runs/:id/show, which Provenance copies, with the config's tools as the CLI reads them.
      expect(JSON.parse(JSON.stringify(showRunJson(store, runId, { tools: TOOLS })))).toEqual(shown);
    } finally {
      store.close();
    }
    expect((JSON.parse((await shadowlap(['show', plainRun, '--json'])).stdout) as { untrusted: unknown[] }).untrusted).toEqual([]);
  });
});
