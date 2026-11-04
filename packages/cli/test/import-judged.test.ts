import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { keptCaptureVerdict, parseTests, rulesOnCalls, Store } from '@shadowlap/engine';
import { importedBefore, judgeAgain, settleImport } from '../src/import-report.js';
import { parseOtlpFile, readOtel } from '../src/import-otel.js';
import { importTrace } from '../src/import-trace.js';

/**
 * A capture judged as it is imported (E26), by the project's rules on calls: every `calls` check in
 * any golden's expect. The verdict is kept on the run with the rules it was judged by, said in the
 * import's output and in --json, and judged again once the rules change.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const fixture = (name: string) => readFileSync(new URL(`./fixtures/traces/${name}`, import.meta.url), 'utf8');
/** otel-genai.json's support agent looks up order A-1042 and refunds it. */
const TRACE = () => readOtel(parseOtlpFile(fixture('otel-genai.json'))).traces[0];

const rules = (args: Record<string, unknown>) => rulesOnCalls(parseTests({ 'goldens/support': { expect: { calls: [{ tool: 'lookup_order', args }], tools: { send_email: 0 } } } }));
const LOOKED_UP = { order_id: 'A-1042' };
const OTHER_ORDER = { order_id: 'B-7' };

function imported(store: Store, by: ReturnType<typeof rules> | null) {
  const { result } = importTrace(store, TRACE(), { source: 'otel-traces.json', labels: ['otel'] });
  return settleImport(store, { format: 'otel', entries: 1, runs: [{ key: null, result }], rules: by, env: {} }).runs[0];
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a capture judged as it is imported', () => {
  it('keeps its verdict by the rules on calls on the run, with the rules it was judged by', () => {
    const store = Store.open(':memory:');
    const by = rules(LOOKED_UP);
    const run = imported(store, by);
    expect(run.judged).toMatchObject({ rules: by.key, verdict: 'passed', why: null, checks: [{ status: 'passed', label: 'every lookup_order call: order_id = "A-1042"' }] });
    expect(keptCaptureVerdict(store.getRun(run.runId)!)).toEqual(run.judged);
    // A rule it breaks: failed, by the first rule broken and the call.
    const broken = imported(store, rules(OTHER_ORDER)).judged!;
    expect(broken.verdict).toBe('failed');
    expect(broken.checks[0].detail).toMatch(/^lookup_order #\d+: order_id "A-1042" != "B-7"$/);
    // No rule on calls: nothing is judged, and nothing is kept.
    const none = imported(store, null);
    expect(none.judged).toBeNull();
    expect(store.getRun(none.runId)!.meta?.judged).toBeUndefined();
    store.close();
  });

  it('is judged again once the rules change, and stands while they stay', () => {
    const store = Store.open(':memory:');
    const before = rules(LOOKED_UP);
    const run = imported(store, before);
    expect(judgeAgain(store, run.runId, before)).toBeNull();
    expect(importedBefore(store, run.runId, before)).toBe(`imported before, as ${run.runId.slice(0, 10)}`);
    const after = rules(OTHER_ORDER);
    expect(importedBefore(store, run.runId, after)).toMatch(new RegExp(`^imported before, as ${run.runId.slice(0, 10)} · judged again: check failed: every lookup_order call: order_id = "B-7", but lookup_order #\\d+: order_id "A-1042" != "B-7"$`));
    // Kept with the rules it was judged by this time: it stands until they change again.
    expect(keptCaptureVerdict(store.getRun(run.runId)!)).toMatchObject({ rules: after.key, verdict: 'failed' });
    expect(judgeAgain(store, run.runId, after)).toBeNull();
    store.close();
  });
});

function shadowlap(cwd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), ...args], { cwd, env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

/** A project of its own, with the trace in it and, given rules, a config holding them. */
function project(calls?: unknown[]): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-import-judged-')));
  dirs.push(cwd);
  writeFileSync(join(cwd, 'otel-traces.json'), fixture('otel-genai.json'));
  if (calls) writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/support': { expect: { calls } } } }));
  return cwd;
}

describe('shadowlap import, judged by the rules on calls', () => {
  it('prints the verdict after what it imported, and keeps it in --json', async () => {
    const passes = project([{ tool: 'lookup_order', args: LOOKED_UP }]);
    const r = await shadowlap(passes, ['import', 'otel', 'otel-traces.json']);
    expect(r.code, r.err).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toMatch(/^Imported \w{10} from otel-traces\.json: /);
    expect(lines[1]).toBe('✓ judged by the rules on calls in shadowlap.config.json · 1 check passed');

    const fails = project([{ tool: 'lookup_order', args: OTHER_ORDER }]);
    const json = await shadowlap(fails, ['import', 'otel', 'otel-traces.json', '--json']);
    expect(json.code, json.err).toBe(0);
    const run = (JSON.parse(json.out) as { runs: Array<{ judged: { verdict: string; checks: Array<{ status: string }> } }> }).runs[0];
    expect(run.judged.verdict).toBe('failed');
    expect(run.judged.checks.map((c) => c.status)).toEqual(['failed']);

    // A project with no rule on calls says so, and keeps nothing.
    const bare = project();
    const plain = await shadowlap(bare, ['import', 'otel', 'otel-traces.json']);
    expect(plain.out.split('\n')[1]).toBe('  no rule on calls in shadowlap.config.json to judge it by');
  });
});
