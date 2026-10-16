import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, storeApiRequest } from '@shadowlap/engine';

/**
 * A run whose recorder was killed (`kill -9`, out of memory) stays marked running with nothing
 * recording it, and every screen reads it interrupted. The copies the dashboard's Share menu makes
 * with these commands say so too: a pack holds it interrupted, ended at its last call (a teammate who
 * unpacks it never sees it recording), an HTML file shows it interrupted with or without redaction
 * rules, and a trace names its status as interrupted, never running. The store is not changed.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

let cwd: string;
let dbPath: string;
let runId: string;
let lastAt: number;

beforeAll(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-copy-left-')));
  mkdirSync(join(cwd, '.shadowlap'));
  dbPath = join(cwd, '.shadowlap', 'shadowlap.db');
  writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
  const store = Store.open(dbPath);
  const t0 = Date.now() - 60_000;
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd }, startedAt: t0 });
  runId = run.runId;
  const api = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
  const answer = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Refunded jane@example.com.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  store.appendCallStart({ runId, callNo: 1, ...api, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'Refund jane@example.com.' }] }), meta: { provider: 'anthropic' }, at: t0 + 10 });
  lastAt = t0 + 20;
  store.appendCallEnd(api, { runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from(JSON.stringify(answer))), outcome: 'ok', meta: { provider: 'anthropic', status: 200, model: 'claude-test' }, at: lastAt });
  store.close();
  // Its recorder was killed: the store still names it, and it is gone.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE run_owners SET pid = ? WHERE run_id = ?').run(dead, runId);
  db.close();
});
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function cli(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', OTEL_EXPORTER_OTLP_ENDPOINT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const status = () => {
  const store = Store.open(dbPath);
  try {
    return store.getRun(runId)!.status;
  } finally {
    store.close();
  }
};

describe('copies of a run whose recorder was killed', () => {
  it('packs it interrupted, ended at its last call', async () => {
    const r = await cli(['pack', runId, 'pack-left']);
    expect(r.code, r.err).toBe(0);
    const manifest = JSON.parse(readFileSync(join(cwd, 'pack-left', 'run.json'), 'utf8')) as { runs: Array<{ runId: string; status: string; endedAt: number | null }> };
    expect(manifest.runs).toEqual([expect.objectContaining({ runId, status: 'crashed', endedAt: lastAt })]);
    expect(readFileSync(join(cwd, 'pack-left', 'calls.jsonl'), 'utf8')).not.toContain('jane@example.com');
    expect(status(), 'the store is not changed').toBe('running');
  });

  it('shows it interrupted in an HTML file, with the redaction rules and without', async () => {
    for (const flags of [[], ['--no-redact']]) {
      const file = `left${flags.length}.html`;
      const r = await cli(['export', 'html', runId, file, ...flags]);
      expect(r.code, r.err).toBe(0);
      const html = readFileSync(join(cwd, file), 'utf8');
      const m = /<script type="application\/json" id="shadowlap-data">(.*?)<\/script>/s.exec(html)!;
      const data = JSON.parse(m[1]!.split('<\\/').join('</')) as { responses: Record<string, { run?: { status: string; endedAt: number | null }; runs?: Array<{ runId: string; status: string }> }> };
      expect(data.responses[`runs/${runId}`]!.run, flags.join(' ') || 'redacted').toMatchObject({ status: 'crashed', endedAt: lastAt });
      expect(data.responses['runs']!.runs!.find((x) => x.runId === runId)).toMatchObject({ status: 'crashed' });
    }
    expect(status()).toBe('running');
  });

  it('traces it as interrupted, never as running', async () => {
    const r = await cli(['export', 'otel', runId, '--out', 'left.otel.json']);
    expect(r.code, r.err).toBe(0);
    const trace = JSON.parse(readFileSync(join(cwd, 'left.otel.json'), 'utf8')) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }>; status: { code: number } }> }> }> };
    const spans = trace.resourceSpans.flatMap((s) => s.scopeSpans.flatMap((x) => x.spans));
    const root = spans.find((s) => s.attributes.some((a) => a.key === 'shadowlap.run.status'))!;
    expect(root.attributes.find((a) => a.key === 'shadowlap.run.status')!.value.stringValue).toBe('crashed');
    expect(status()).toBe('running');
  });
});
