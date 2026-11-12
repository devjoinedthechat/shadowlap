import { describe, expect, it } from 'vitest';
import { forkEnd, pairDecisions, pathRows, ROW_TEXT, ROW_TOOLS, type ForkEnd } from '../src/fork-changes.js';
import { storeApiRequest } from '../src/manifest.js';
import { pairVerdict } from '../src/pair-verdict.js';
import { Store } from '../src/store.js';
import type { Effect, Origin, RunStatus } from '../src/types.js';

/**
 * Compare's decisions for any two runs (fork-changes.ts `pairDecisions`): the comparison from the
 * first call after the calls they share, how each side ended, the verdict, and both paths call by
 * call. A fork against its parent is one case of it (shared-words.test.ts pins compareFork).
 */

type ModelCall = { kind: 'api'; text?: string; tools?: Array<{ name: string; args: Record<string, unknown> }>; status?: number; injected?: boolean; offline?: boolean };
type ToolCall = { kind: 'tool'; name: string; args: Record<string, unknown>; effect: Effect | null; origin?: Origin; input?: boolean };
type Call = ModelCall | ToolCall | { kind: 'judge' };

function addModelCall(store: Store, runId: string, callNo: number, c: ModelCall | { kind: 'judge' }): void {
  const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `fp${callNo}`, occurrence: 1 };
  const judge = c.kind === 'judge';
  const meta = { provider: 'anthropic', ...(judge ? { scope: 'shadowlap:judge' } : {}) };
  store.appendCallStart({ runId, callNo, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: `turn ${callNo}` }] }), meta, at: 1 });
  if (!judge && c.status) {
    const error = { name: 'APIError', message: c.offline ? 'refused: the replay is offline' : 'overloaded' };
    store.appendCallEnd(identity, { runId, callNo, attempt: 0, responseRef: null, outcome: 'error', meta: { status: c.status, error, ...(c.injected ? { injected: true } : {}), ...(c.offline ? { offline: true } : {}) }, at: 2 });
    return;
  }
  const uses = judge ? [] : (c.tools ?? []).map((t, i) => ({ type: 'tool_use', id: `tu_${callNo}_${i}`, name: t.name, input: t.args }));
  const text = judge ? 'yes' : (c.text ?? '');
  const response = { id: `msg_${callNo}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [...(text ? [{ type: 'text', text }] : []), ...uses], stop_reason: uses.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  store.appendCallEnd(identity, { runId, callNo, attempt: 0, responseRef: store.putJson(response), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic' }, at: 2 });
}

function addRun(store: Store, calls: Call[], o: { parent?: string; status?: RunStatus } = {}): string {
  const run = store.createRun({ mode: o.parent ? 'replay' : 'record', ...(o.parent ? { parentRunId: o.parent } : {}), command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, startedAt: 1_000 });
  calls.forEach((c, i) => {
    const callNo = i + 1;
    if (c.kind !== 'tool') return addModelCall(store, run.runId, callNo, c);
    const identity = { kind: 'tool' as const, name: c.name, fingerprint: `tfp${callNo}${c.name}`, occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: c.origin ?? 'live', effect: c.effect, requestRef: store.putJson({ args: c.args }), meta: c.input ? { input: true } : {}, at: 1 });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result: { ok: true } }), outcome: c.origin === 'blocked' ? 'error' : 'ok', meta: {}, at: 2 });
  });
  if ((o.status ?? 'completed') !== 'running') store.endRun(run.runId, (o.status ?? 'completed') as Exclude<RunStatus, 'running'>, 5_000);
  return run.runId;
}

const clean: ForkEnd = forkEnd('completed', { kind: 'none' });
const ended = { a: clean, b: clean };
const lookup: ToolCall = { kind: 'tool', name: 'lookup_order', args: { order_id: 'A-1042' }, effect: 'read' };
const ask = (name: string, args: Record<string, unknown>): ModelCall => ({ kind: 'api', tools: [{ name, args }] });

function decide(calls: { a: Call[]; b: Call[] }, prefix: number, o: { a?: { status?: RunStatus; parent?: boolean }; b?: { status?: RunStatus; parent?: boolean }; ended?: { a: ForkEnd; b: ForkEnd }; exitCodes?: { a?: number; b?: number }; rows?: number } = {}) {
  const store = Store.open(':memory:');
  const aId = addRun(store, calls.a, { ...(o.a?.status ? { status: o.a.status } : {}) });
  const bId = addRun(store, calls.b, { ...(o.b?.status ? { status: o.b.status } : {}), ...(o.b?.parent ? { parent: aId } : {}) });
  const options = { ...(o.exitCodes ? { exitCodes: o.exitCodes } : {}), ...(o.rows ? { rows: o.rows } : {}) };
  return pairDecisions(store, store.getRun(aId)!, store.getRun(bId)!, prefix, o.ended ?? ended, options);
}

describe("Compare's verdict on two runs", () => {
  it('ranks a write first for two runs with no parent link between them, after the calls they share', () => {
    const shared: Call[] = [ask('lookup_order', { order_id: 'A-1042' }), lookup];
    const p = decide({ a: [...shared, ask('issue_refund', { amount: 240 }), { kind: 'tool', name: 'issue_refund', args: { amount: 240 }, effect: 'write' }, { kind: 'api', text: 'Refunded.' }], b: [...shared, ask('escalate', { reason: 'over $100' }), { kind: 'tool', name: 'escalate', args: { reason: 'over $100' }, effect: 'write' }, { kind: 'api', text: 'Escalated.' }] }, 2);
    expect(p.from).toEqual({ a: 3, b: 3 });
    expect(p.verdict).toEqual({ words: 'Different writes', where: 'after #2', tone: 'err' });
    expect(p.comparison.changes[0]).toMatchObject({ rank: 1, aCallNo: 4 });
    expect(p.comparison.changes.find((c) => c.kind === 'write-added')).toMatchObject({ tool: 'escalate', bCallNo: 4 });
    expect(p.comparison.writes.a).toEqual([{ callNo: 4, tool: 'issue_refund', args: '{"amount":240}', fate: 'live' }]);
    expect(p.endings.a).toEqual({ failures: null, writes: [{ fate: null, tools: [{ tool: 'issue_refund', count: 1 }] }], end: { kind: 'answered', callNo: 5 }, quit: false });
  });

  it('puts the endings first where a side quit on an HTTP failure, and says the failures', () => {
    const a: Call[] = [ask('lookup_order', { order_id: 'A-1042' }), lookup, ask('issue_refund', { amount: 240 }), { kind: 'tool', name: 'issue_refund', args: { amount: 240 }, effect: 'write' }, { kind: 'api', text: 'Refunded.' }];
    const b: Call[] = [ask('lookup_order', { order_id: 'A-1042' }), lookup, { kind: 'api', status: 529, injected: true }, { kind: 'api', status: 529 }];
    const p = decide({ a, b }, 2);
    expect(p.endings.b).toEqual({ failures: null, writes: [], end: { kind: 'stopped', callNo: 4, status: 529 }, quit: true });
    expect(p.verdict).toEqual({ words: 'Different endings', where: 'after #2', tone: 'warn' });
    // A side that got failures and went on to answer says them, and didn't quit.
    const c = decide({ a, b: [...b, { kind: 'api', text: 'Sorry, try later.' }] }, 2);
    expect(c.endings.b).toMatchObject({ failures: { status: 529, from: 3, to: 4 }, end: { kind: 'answered', callNo: 5 }, quit: false });
    expect(c.verdict?.words).toBe('Different writes');
  });

  it('says each way a turn ends: exited with its code, answered, ended, none, running', () => {
    const tail: Call[] = [{ kind: 'tool', name: 'send_email', args: { to: 'customer@example.com' }, effect: 'write' }];
    const exited = decide({ a: [{ kind: 'api', text: 'Done.' }], b: [ask('send_email', { to: 'customer@example.com' }), ...tail] }, 0, { b: { status: 'failed' }, exitCodes: { b: 1 } });
    expect(exited.endings.b.end).toEqual({ kind: 'exited', callNo: 2, code: 1 });
    // It decided to write before it exited: it didn't quit, so its write comes first.
    expect(exited.endings.b.quit).toBe(false);
    expect(exited.verdict).toEqual({ words: 'Different writes', where: 'from #1', tone: 'err' });
    expect(exited.endings.a.end).toEqual({ kind: 'answered', callNo: 1 });
    // One that exited with no model call answered after the calls they share quit: its ending comes first.
    const quit = decide({ a: [lookup, ask('send_email', {}), ...tail], b: [lookup] }, 1, { b: { status: 'failed' }, exitCodes: { b: 2 } });
    expect(quit.endings.b).toEqual({ failures: null, writes: [], end: { kind: 'exited', callNo: 1, code: 2 }, quit: true });
    expect(quit.verdict).toEqual({ words: 'Different endings', where: 'after #1', tone: 'warn' });
    const noCode = decide({ a: [{ kind: 'api', text: 'Done.' }], b: [{ kind: 'api', text: 'Done.' }] }, 0, { b: { status: 'failed' } });
    expect(noCode.endings.b.end).toEqual({ kind: 'exited', callNo: 1, code: null });
    // A model call that asks for a tool, then nothing: it ended, not answered.
    expect(decide({ a: [ask('lookup_order', {})], b: [] }, 0).endings).toMatchObject({ a: { end: { kind: 'ended', callNo: 1 } }, b: { end: { kind: 'none', callNo: null }, writes: [] } });
    const running = decide({ a: [{ kind: 'api', text: 'Done.' }], b: [ask('send_email', {}), ...tail] }, 0, { b: { status: 'running' } });
    expect(running.endings.b.end).toEqual({ kind: 'running', callNo: 2 });
    // No verdict while a side records: its writes and its end aren't final.
    expect(running.verdict).toBeNull();
  });

  it('groups the writes by what became of them, each tool once with its count, a tool of no known effect among them', () => {
    const w = (name: string, origin?: Origin): ToolCall => ({ kind: 'tool', name, args: { n: Math.random() }, effect: 'write', ...(origin ? { origin } : {}) });
    const b: Call[] = [{ kind: 'api', text: 'go' }, w('issue_refund'), w('send_email', 'blocked'), w('send_email', 'blocked'), w('add_note', 'stubbed'), w('issue_refund'), w('escalate', 'stubbed'), w('add_note', 'stubbed'), w('add_note', 'stubbed'), { kind: 'tool', name: 'mystery', args: {}, effect: null }, { kind: 'tool', name: 'user_input', args: { prompt: 'ok?' }, effect: null, input: true }, lookup];
    const p = decide({ a: [{ kind: 'api', text: 'go' }], b }, 1);
    expect(p.endings.b.writes).toEqual([
      { fate: null, tools: [{ tool: 'issue_refund', count: 2 }, { tool: 'mystery', count: 1 }] },
      { fate: 'blocked', tools: [{ tool: 'send_email', count: 2 }] },
      { fate: 'stubbed', tools: [{ tool: 'add_note', count: 3 }, { tool: 'escalate', count: 1 }] },
    ]);
    expect(p.endings.a.writes).toEqual([]);
  });

  it('says only the words where nothing else differs, and gives no verdict where no call follows the prefix', () => {
    const p = decide({ a: [lookup, { kind: 'api', text: 'Your order shipped.' }], b: [lookup, { kind: 'api', text: 'It shipped on Monday.' }] }, 1);
    expect(p.verdict).toEqual({ words: 'Different words', where: 'after #1', tone: 'done' });
    const same = decide({ a: [lookup, { kind: 'api', text: 'Done.' }], b: [lookup, { kind: 'api', text: 'Done.' }] }, 2);
    expect(same.verdict).toBeNull();
    expect(same.rows).toEqual([]);
    expect(same.from).toEqual({ a: 3, b: 3 });
  });

  it('takes the checks coming out otherwise for an ending, as the ranking does', () => {
    const calls: Call[] = [lookup, { kind: 'api', text: 'Done.' }];
    const p = decide({ a: calls, b: [lookup, { kind: 'api', text: 'Done!' }] }, 1, { ended: { a: forkEnd('completed', { kind: 'passed', checks: 1 }), b: forkEnd('completed', { kind: 'check-failed', check: 'polite' }) } });
    expect(p.verdict?.words).toBe('Different endings');
    expect(p.comparison.changes[0]).toMatchObject({ kind: 'ended', detail: 'it fails, where the other run did not' });
  });

  it('words the verdict from the top rank and the quit rule', () => {
    const v = (rank: 1 | 2 | 3 | 4 | 5 | null, quit = false, endsDiffer = false, identicalPrefix = 18) => pairVerdict({ rank, quit, endsDiffer, identicalPrefix });
    expect(v(1)).toEqual({ words: 'Different writes', where: 'after #18', tone: 'err' });
    expect(v(1, true, true).words).toBe('Different endings');
    // Quitting with the same end (both stopped on a failure) leaves the writes first.
    expect(v(1, true, false).words).toBe('Different writes');
    expect(v(3, false, true).words).toBe('Different endings');
    expect(v(3).words).toBe('Different reads');
    expect(v(4).words).toBe('Different reads');
    expect(v(5).words).toBe('Different words');
    expect(v(null)).toEqual({ words: 'The same decisions', where: 'after #18', tone: 'done' });
    expect(v(1, false, false, 19_976).where).toBe('after #19,976');
    expect(v(1, false, false, 0).where).toBe('from #1');
  });
});

describe("Compare's rows", () => {
  it('pairs both paths by position after the prefix, a model call by its decision and a tool by its arguments', () => {
    const a: Call[] = [lookup, ask('send_email', { to: 'customer@example.com', body: 'Refunded' }), { kind: 'tool', name: 'send_email', args: { to: 'customer@example.com', body: 'Refunded' }, effect: 'write' }, { kind: 'api', text: 'Done.' }];
    const b: Call[] = [lookup, ask('send_email', { to: 'customer@example.com', body: 'Escalated' }), { kind: 'tool', name: 'send_email', args: { to: 'customer@example.com', body: 'Escalated' }, effect: 'write', origin: 'blocked' }, { kind: 'api', text: 'Done.' }, { kind: 'api', status: 503, offline: true }];
    const p = decide({ a, b }, 1);
    expect(p.rows.map((r) => [r.n, r.alike, r.similar])).toEqual([
      [2, false, true],
      [3, false, true],
      [4, true, false],
      [5, false, false],
    ]);
    // A decision as a preview's cell takes it (Decision.tsx), with the words for its stop.
    expect(p.rows[0].a!.decision).toEqual({ stop: 'tools', stopReason: 'tool_use', stops: 'calls tools', tools: [{ name: 'send_email', effect: 'write', args: { to: 'customer@example.com', body: 'Refunded' } }], text: '' });
    expect(p.rows[1].b).toMatchObject({ kind: 'tool', name: 'send_email', effect: 'write', origin: 'blocked', decision: null, failure: null });
    // A tool's row names it: its arguments are the opened row's, read from the call's detail.
    expect(p.rows[1].b).not.toHaveProperty('args');
    expect(p.rows[3]).toMatchObject({ a: null, b: { callNo: 5, failure: { status: 503, by: 'offline' }, decision: null } });
    expect(p.more).toBe(0);
  });

  it("says each tool a decision calls with what it does, its arguments cut to a row's worth of their one-line form", () => {
    const long = 'x'.repeat(500);
    const lines = 'line\n'.repeat(100);
    const p = decide({ a: [{ kind: 'api', tools: [{ name: 'lookup_order', args: { id: 1 } }, { name: 'get_sla', args: { note: long } }] }], b: [{ kind: 'api', tools: [{ name: 'lookup_order', args: { id: 1 } }, { name: 'refund', args: { note: lines } }] }] }, 0);
    expect(p.rows[0].a!.decision!.tools.map((t) => [t.name, t.effect])).toEqual([
      ['lookup_order', 'unknown'],
      ['get_sla', 'unknown'],
    ]);
    const args = p.rows[0].a!.decision!.tools[1].args;
    expect(args).toEqual({ note: `${'x'.repeat(288)}…` });
    expect(JSON.stringify(args)).toHaveLength(ROW_TEXT);
    // Its escapes counted: a line break is two characters of it.
    const refund = p.rows[0].b!.decision!.tools[1].args as { note: string };
    expect(refund.note.endsWith('…')).toBe(true);
    expect(lines.startsWith(refund.note.slice(0, -1))).toBe(true);
    expect(JSON.stringify(refund).length).toBeGreaterThan(ROW_TEXT / 2);
    expect(JSON.stringify(refund).length).toBeLessThanOrEqual(ROW_TEXT);
    // What fits is kept as it is.
    expect(p.rows[0].a!.decision!.tools[0].args).toEqual({ id: 1 });
    expect(p.rows[0].a!.decision).not.toHaveProperty('moreTools');
    // Not the same tools: nothing in the row to mark word by word.
    expect(p.rows[0].similar).toBe(false);
  });

  it("cuts a wide array in a decision's arguments at a row's worth, its shape kept up to a `…` item, and tells the two sides apart by the whole", () => {
    const points = Array.from({ length: 10_000 }, (_, i) => i);
    const plot = (last: number): Call[] => [{ kind: 'api', tools: [{ name: 'plot', args: { points: [...points.slice(0, -1), last] } }] }];
    const p = decide({ a: plot(9_999), b: plot(-1) }, 0);
    const args = p.rows[0].a!.decision!.tools[0].args as { points: unknown[] };
    expect(Object.keys(args)).toEqual(['points']);
    expect(args.points.at(-1)).toBe('…');
    expect(args.points.slice(0, -1)).toEqual(points.slice(0, args.points.length - 1));
    expect(JSON.stringify(args).length).toBeGreaterThan(ROW_TEXT - 8);
    expect(JSON.stringify(args).length).toBeLessThanOrEqual(ROW_TEXT + 8);
    // The row, both sides, in under 2 KB, where each side's arguments alone are 48,890 characters on one line.
    expect(JSON.stringify(p.rows[0]).length).toBeLessThan(2048);
    // Cut alike on both sides, where they differ is past the cut: the whole arguments tell them apart.
    expect(p.rows[0].b!.decision!.tools[0].args).toEqual(args);
    expect(p.rows[0]).toMatchObject({ alike: false, similar: true });
  });

  it("cuts a wide object in a decision's arguments at a row's worth, ending with a `…` key, and each array or object that holds the cut where it holds more", () => {
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    const lines = Array.from({ length: 200 }, (_, i) => ({ sku: `SKU-${i}`, qty: 1 }));
    const p = decide({ a: [{ kind: 'api', tools: [{ name: 'tag', args: wide }, { name: 'order', args: { lines, note: 'gift' } }] }], b: [] }, 0);
    const [tag, order] = p.rows[0].a!.decision!.tools.map((t) => t.args as Record<string, unknown>);
    const keys = Object.keys(tag);
    expect(keys.at(-1)).toBe('…');
    expect(tag['…']).toBe('…');
    expect(keys.slice(0, -1)).toEqual(Object.keys(wide).slice(0, keys.length - 1));
    expect(JSON.stringify(tag).length).toBeGreaterThan(ROW_TEXT - 8);
    expect(JSON.stringify(tag).length).toBeLessThanOrEqual(ROW_TEXT + 8);
    // Cut inside the list: the list ends with a `…` item, and the object holding it, which holds a note after it, with a `…` key.
    expect(Object.keys(order)).toEqual(['lines', '…']);
    const kept = order.lines as unknown[];
    expect(kept.at(-1)).toBe('…');
    expect(kept.slice(0, -2)).toEqual(lines.slice(0, kept.length - 2));
    expect(JSON.stringify(order).length).toBeLessThanOrEqual(ROW_TEXT + 16);
  });

  it('lists at most ROW_TOOLS tool calls in a decision, and counts the rest', () => {
    const many = (n: number): Call[] => [{ kind: 'api', tools: Array.from({ length: n }, (_, i) => ({ name: 'lookup_order', args: { order_id: `A-${i}` } })) }];
    const p = decide({ a: many(ROW_TOOLS + 480), b: many(ROW_TOOLS) }, 0);
    expect(p.rows[0].a!.decision!.tools.map((t) => t.args)).toEqual(Array.from({ length: ROW_TOOLS }, (_, i) => ({ order_id: `A-${i}` })));
    expect(p.rows[0].a!.decision!.moreTools).toBe(480);
    expect(p.rows[0].b!.decision!.tools).toHaveLength(ROW_TOOLS);
    expect(p.rows[0].b!.decision).not.toHaveProperty('moreTools');
    // Told apart by all they call: the same names as far as the row lists them, not the same tools.
    expect(p.rows[0]).toMatchObject({ alike: false, similar: false });
  });

  it('leaves a judge out, numbers a row by its place, and says who refused a failure', () => {
    const p = decide({ a: [lookup, { kind: 'judge' }, { kind: 'api', status: 529, injected: true }], b: [lookup, { kind: 'api', status: 529 }] }, 1);
    expect(p.from).toEqual({ a: 3, b: 2 });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ n: 2, alike: true, similar: false, a: { callNo: 3, origin: 'injected', failure: { status: 529, by: 'injected' } }, b: { callNo: 2, origin: 'live', failure: { status: 529, by: 'provider' } } });
  });

  it('numbers every row once where a judge sits among the first run’s calls, each side keeping its own call numbers', () => {
    const p = decide({ a: [lookup, lookup, { kind: 'judge' }, ask('escalate', {})], b: [lookup, lookup, ask('refund', {}), { kind: 'api', text: 'Done.' }, { kind: 'api', text: 'Bye.' }] }, 2);
    expect(p.rows.map((r) => [r.n, r.a?.callNo ?? null, r.b?.callNo ?? null])).toEqual([
      [3, 4, 3],
      [4, null, 4],
      [5, null, 5],
    ]);
  });

  it('marks nothing in a row both made alike: the same tools called alike are alike, not similar', () => {
    const send = ask('send_email', { to: 'customer@example.com', body: 'Refunded in full.' });
    const p = decide({ a: [send, { kind: 'api', status: 529 }], b: [send, { kind: 'api', status: 529 }] }, 0);
    expect(p.rows.map((r) => [r.n, r.alike, r.similar])).toEqual([
      [1, true, false],
      [2, true, false],
    ]);
    // Asked otherwise, the same tool is similar: its words that differ are marked.
    expect(decide({ a: [send], b: [ask('send_email', { to: 'customer@example.com', body: 'Escalated.' })] }, 0).rows[0]).toMatchObject({ alike: false, similar: true });
  });

  it('draws at most the rows asked for and counts the rest', () => {
    const many: Call[] = Array.from({ length: 12 }, (_, i) => ({ kind: 'tool', name: 'lookup_order', args: { i }, effect: 'read' }));
    const p = decide({ a: many, b: [] }, 0, { rows: 5 });
    expect(p.rows).toHaveLength(5);
    expect(p.more).toBe(7);
    expect(p.rows[0]).toMatchObject({ n: 1, a: { callNo: 1 }, b: null, alike: false });
  });

  it('masks what the normalizers mask before telling two calls alike, from their whole arguments', () => {
    const store = Store.open(':memory:');
    const ticket = (id: string, note: string) => addRun(store, [{ kind: 'tool', name: 'create_ticket', args: { id, note }, effect: 'write' }]);
    const x = ticket('T-1', 'x'.repeat(500));
    const y = ticket('T-2', 'x'.repeat(500));
    // One character apart, far past a row's worth of them.
    const z = ticket('T-3', `${'x'.repeat(499)}y`);
    const calls = (id: string) => store.getCalls(id);
    const effectOf = () => null;
    const masking = { effectOf, normalizers: [{ kind: 'tool' as const, path: '$.args.id', replace: '<id>' }] };
    expect(pathRows(store, calls(x), calls(y), 0, { effectOf }).rows[0]).toMatchObject({ alike: false, similar: true });
    expect(pathRows(store, calls(x), calls(y), 0, masking).rows[0]).toMatchObject({ alike: true, similar: false });
    expect(pathRows(store, calls(x), calls(z), 0, masking).rows[0]).toMatchObject({ alike: false, similar: true });
  });

  it('tells two tool calls alike by their arguments as one JSON value, whatever order their keys come in', () => {
    const read = (args: Record<string, unknown>): ToolCall => ({ kind: 'tool', name: 'lookup_order', args, effect: 'read' });
    const p = decide({ a: [read({ order_id: 'A-1042', fields: ['total', 'items'] })], b: [read({ fields: ['total', 'items'], order_id: 'A-1042' })] }, 0);
    expect(p.rows[0]).toMatchObject({ alike: true, similar: false });
  });
});
