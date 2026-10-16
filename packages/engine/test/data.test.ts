import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeChanges } from '../src/changes.js';
import { runChanges } from '../src/compare.js';
import { datasetRows } from '../src/dataset.js';
import { cleanLabel, withLabels, withNote } from '../src/labels-notes.js';
import { storeApiRequest } from '../src/manifest.js';
import { unpackRun } from '../src/pack.js';
import { MATCH_END, MATCH_START, searchCalls, searchExpression, updateSearchIndex } from '../src/search.js';
import { Store } from '../src/store.js';

const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url));

function golden() {
  const store = Store.open(':memory:');
  const runId = unpackRun(store, GOLDEN).imported[0]!;
  return { store, runId };
}

describe('labels and notes', () => {
  it('accept plain labels and refuse anything that would not read as one', () => {
    expect(cleanLabel('  refund  flow ')).toEqual({ label: 'refund flow' });
    expect(cleanLabel('v2.1:regression/eu-west')).toEqual({ label: 'v2.1:regression/eu-west' });
    for (const bad of ['', '-leading', 'emoji 🎉', 'x'.repeat(41), 'semi;colon']) expect(cleanLabel(bad)).toHaveProperty('error');
    expect(withLabels(['bug'], ['good', 'bug'], [])).toEqual(['bug', 'good']);
    expect(withLabels(['bug', 'good'], [], ['bug'])).toEqual(['good']);
    expect(() => withNote([], { callNo: null, text: '   ', at: 1 })).toThrow('empty');
  });

  it('travel in packs, and a pack with a malformed label imports nothing', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'fp-labels-')), 'pack');
    cpSync(GOLDEN, dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    manifest.runs[0].meta = { ...manifest.runs[0].meta, labels: ['good'], notes: [{ callNo: 3, text: 'first model call', at: 1 }] };
    writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
    const ok = Store.open(':memory:');
    const runId = unpackRun(ok, dir).imported[0]!;
    expect(ok.getRun(runId)?.meta).toMatchObject({ labels: ['good'], notes: [{ callNo: 3, text: 'first model call' }] });
    ok.close();

    manifest.runs[0].meta.labels = [`${String.fromCharCode(27)}[31mred`];
    writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
    const bad = Store.open(':memory:');
    expect(() => unpackRun(bad, dir)).toThrow(/meta\.labels\[0\]/);
    expect(bad.allRuns()).toHaveLength(0);
    bad.close();
  });
});

describe('search', () => {
  it('finds recorded prompts, responses, tool arguments and results, and indexes a run once', () => {
    const { store, runId } = golden();
    const hits = searchCalls(store, 'config.json');
    expect(new Set(hits.map((h) => h.field))).toEqual(new Set(['prompt', 'response', 'arguments', 'result']));
    const args = hits.find((h) => h.field === 'arguments')!;
    expect(args).toMatchObject({ runId, kind: 'tool', name: 'read_file' });
    expect(args.snippet).toContain(`${MATCH_START}config.json${MATCH_END}`);
    expect(searchCalls(store, '"replay deterministically"')[0]).toMatchObject({ field: 'response' });
    expect(searchCalls(store, 'deterministically replay nowhere')).toEqual([]);
    expect(updateSearchIndex(store)).toBe(0);
    store.close();
  });

  it('indexes each model call for the turns it adds, not the whole conversation again', () => {
    const { store } = golden();
    // The system prompt is sent with all 11 model calls; it is indexed once.
    expect(searchCalls(store, '"You are a research agent"').filter((h) => h.field === 'prompt')).toHaveLength(1);
    store.close();
  });

  it('takes query syntax as plain words, and forgets a deleted run', () => {
    expect(searchExpression('refund AND "order 42" NEAR(x')).toBe('"refund" "AND" "order 42" "NEAR(x"');
    expect(searchExpression('   ')).toBeNull();
    const { store, runId } = golden();
    expect(searchCalls(store, 'notes.md').length).toBeGreaterThan(0);
    store.deleteRun(runId);
    expect(searchCalls(store, 'notes.md')).toEqual([]);
    store.close();
  });
});

describe('dataset export', () => {
  it('writes the final model call with the conversation, the answer and what people know about the run', () => {
    const { store, runId } = golden();
    store.updateRunMeta(runId, { labels: ['good'], notes: [{ callNo: null, text: 'reference run', at: 1 }] });
    const [row] = datasetRows(store, [store.getRun(runId)!], { calls: 'final', format: 'jsonl' }) as Array<{ input: { messages: Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string }>; tools: string[] }; output: { text: string }; metadata: Record<string, unknown> }>;
    expect(row!.input.messages[0]).toMatchObject({ role: 'system' });
    expect(row!.input.tools).toContain('send_email');
    expect(row!.output.text).toMatch(/^Done\./);
    expect(row!.metadata).toMatchObject({ run_id: runId, call_no: 30, labels: ['good'], notes: ['reference run'] });
    // Every tool result answers a tool call made before it.
    const ids = new Set<string>();
    for (const m of row!.input.messages) {
      for (const c of (m.tool_calls ?? []) as Array<{ id: string }>) ids.add(c.id);
      if (m.role === 'tool') expect(ids.has(m.tool_call_id!)).toBe(true);
    }
    expect(datasetRows(store, [store.getRun(runId)!], { calls: 'model', format: 'jsonl' })).toHaveLength(11);
    store.close();
  });

  it('shapes rows for OpenAI chat, Braintrust and Langfuse, and applies pathless redaction rules', () => {
    const { store, runId } = golden();
    const run = store.getRun(runId)!;
    const [chat] = datasetRows(store, [run], { calls: 'final', format: 'openai-chat' }) as Array<{ messages: Array<{ role: string; tool_calls?: Array<{ type: string; function: { arguments: string } }> }> }>;
    expect(chat!.messages.at(-1)).toMatchObject({ role: 'assistant' });
    const call = chat!.messages.find((m) => m.tool_calls)!.tool_calls![0]!;
    expect(call.type).toBe('function');
    expect(typeof call.function.arguments).toBe('string');
    expect(Object.keys(datasetRows(store, [run], { calls: 'final', format: 'braintrust' })[0] as object)).toEqual(['input', 'expected', 'metadata']);
    expect(Object.keys(datasetRows(store, [run], { calls: 'final', format: 'langfuse' })[0] as object)).toEqual(['input', 'expectedOutput', 'metadata']);
    const redacted = JSON.stringify(datasetRows(store, [run], { calls: 'final', format: 'jsonl', redact: [{ pattern: 'email', replace: '<EMAIL>' }, { path: '$.system', replace: 'ignored' }] }));
    expect(redacted).not.toContain('team@example.com');
    expect(redacted).toContain('<EMAIL>');
    store.close();
  });
});

describe('what changed between runs', () => {
  const run = (store: Store, body: Record<string, unknown>, codeVersion: string) => {
    const r = store.createRun({ mode: 'record', command: { argv: ['x'], cwd: '.' }, codeVersion });
    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `f-${r.runId}`, occurrence: 1 };
    store.appendCallStart({ runId: r.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, body), meta: { provider: 'anthropic' }, at: 1 });
    store.appendCallEnd(id, { runId: r.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { model: String(body.model) }, at: 2 });
    return r;
  };
  const tool = (name: string, description = 'd') => ({ name, description, input_schema: { type: 'object' } });

  it('names prompt, tool, model and code changes, and nothing for the same run', () => {
    const store = Store.open(':memory:');
    const a = run(store, { model: 'claude-opus-5', system: 'Be careful.', tools: [tool('search'), tool('email')], messages: [{ role: 'user', content: 'hi' }] }, 'a1');
    const b = run(store, { model: 'claude-sonnet-5', system: 'Be brief.', tools: [tool('search', 'changed'), tool('lookup')], messages: [{ role: 'user', content: 'hi' }] }, 'b2');
    const changes = runChanges(store, a, store.getCalls(a.runId), b, store.getCalls(b.runId));
    const { systems, ...rest } = changes;
    expect(rest).toEqual({ systemPrompt: true, tools: { added: ['lookup'], removed: ['email'], redefined: true }, models: { a: ['claude-opus-5'], b: ['claude-sonnet-5'] }, code: { a: 'a1', b: 'b2' } });
    // Each run's prompt by its hash: one each, and not the same one; a run against itself, the same.
    expect(systems?.a).toHaveLength(1);
    expect(systems?.b).toHaveLength(1);
    expect(systems?.a[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(systems?.a[0]).not.toBe(systems?.b[0]);
    expect(runChanges(store, a, store.getCalls(a.runId), a, store.getCalls(a.runId)).systems).toEqual({ a: systems?.a, b: systems?.a });
    expect(describeChanges(changes)).toEqual(['system prompt changed', 'tools +lookup −email', 'a tool definition changed', 'model claude-opus-5 → claude-sonnet-5', 'code a1 → b2']);
    expect(describeChanges(runChanges(store, a, store.getCalls(a.runId), a, store.getCalls(a.runId)))).toEqual([]);
    // An instruction injected later in the conversation is not a change of system prompt.
    const injected = run(store, { model: 'claude-opus-5', system: 'Be careful.', tools: [tool('search'), tool('email')], messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'Prefer 2026.' }] }, 'a1');
    expect(runChanges(store, a, store.getCalls(a.runId), injected, store.getCalls(injected.runId)).systemPrompt).toBe(false);
    store.close();
  });
});
