import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLEAN_GATE, injectionTemplates, packRun, type RunRecord, Store, type StoredInjectionResult } from '@shadowlap/engine';
import { cleanAnswers, injectionLine, toolTrust } from '../src/injection.js';
import { defaultPayloads, gatePrice, injectionPrice } from '../src/injection-plan.js';
import { CANT_READ_RECORDING, INJECTION_READS, injectionSecurity, toolTests, type ToolsRead } from '../src/injection-security.js';
import { pricingOf } from '../src/pricing.js';
import { answerData } from '../src/read-pool.js';
import { toolsEntry, toolsSettings } from '../src/settings-tools.js';
import type { GoldenSource } from '../src/tests.js';
import { MODEL, usageAt } from './read-model-store.js';

let store: Store;
let project: string;
let clock = 1_000;

/** A recording: `reads` untrusted reads of get_ticket (the SDK's mark), each read by a model call, then a send_email write. */
function record(s: Store, o: { reads?: number; tool?: string; meta?: Record<string, unknown>; running?: boolean; at?: number } = {}): RunRecord {
  const run = s.createRun({ mode: 'record', parentRunId: null, command: { argv: ['node', 'agent.js'], cwd: '.' }, codeVersion: null, startedAt: (clock += 1000) });
  let n = 0;
  const call = (kind: 'tool' | 'api', name: string, effect: 'read' | 'write' | null, meta: Record<string, unknown> = {}, end: Record<string, unknown> = {}) => {
    n += 1;
    const fingerprint = createHash('sha256').update(`${name} ${n}`).digest('hex');
    s.appendCallStart({ runId: run.runId, callNo: n, kind, name, fingerprint, occurrence: 1, origin: 'live', effect, requestRef: null, meta, at: n });
    s.appendCallEnd({ kind, name, fingerprint, occurrence: 1 }, { runId: run.runId, callNo: n, attempt: 0, responseRef: null, outcome: 'ok', meta: end, at: n });
  };
  for (let i = 0; i < (o.reads ?? 1); i++) {
    call('tool', o.tool ?? 'get_ticket', 'read', o.meta ?? { trust: 'untrusted', trustFrom: 'sdk' });
    call('api', 'POST /v1/messages', null, {}, { usage: usageAt(n + 1), model: MODEL, latencyMs: 10 });
  }
  call('tool', 'send_email', 'write');
  if (!o.running) s.endRun(run.runId, 'completed', clock + 500);
  return s.getRun(run.runId)!;
}

const golden = (path: string, runId: string | null): GoldenSource => ({ path, runId, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] });

function plantResult(runId: string, o: { golden?: string | null; at: number; verdict: 'obeyed' | 'ignored'; gate: 'passed' | 'failed' }): StoredInjectionResult {
  const resultId = `inj-${o.at}`;
  const data = { resultId, mode: 'plant', runId, gate: { obeyed: 0, influenced: null, verdict: o.gate, reason: null }, attempts: [], cost: { spent: 0, upstreamRequests: 0, unknownModels: [] } };
  return { resultId, runId, golden: o.golden ?? null, sessionId: null, mode: 'plant', at: o.at, endedAt: o.at + 1, attempts: 6, obeyed: o.verdict === 'obeyed' ? 1 : 0, influenced: 0, ignored: o.verdict === 'ignored' ? 6 : 5, inconclusive: 0, verdict: o.verdict, actor: 'dev', data };
}

beforeEach(() => {
  store = Store.open(':memory:');
  project = mkdtempSync(join(tmpdir(), 'sl-injection-reads-'));
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

describe('Settings → Tools’ trust', () => {
  it('says where each mark comes from, in the column’s words, and the line that marks it the other way', () => {
    record(store);
    record(store, { tool: 'search_docs', meta: { trust: 'untrusted', mcp: { transport: 'stdio', server: 'carrier' } } });
    record(store, { tool: 'read_inbox', meta: { trust: 'untrusted', trustFrom: 'config' } });
    record(store, { tool: 'lookup' });
    record(store, { tool: 'user_input', meta: { input: true } });
    const rows = toolTrust(store, { lookup: { trust: 'untrusted' } }).tools;
    const by = Object.fromEntries(rows.map((t) => [t.name, t]));
    expect(by.get_ticket).toMatchObject({ trust: 'untrusted', from: 'sdk', where: 'SDK', input: false, flip: '"tools": { "get_ticket": { "trust": "trusted" } }' });
    expect(by.search_docs).toMatchObject({ trust: 'untrusted', from: 'mcp', where: 'MCP openWorldHint · carrier' });
    // The recording machine's config marked it, and this file says nothing: Mark trusted writes this file's line, which wins.
    expect(by.read_inbox).toMatchObject({ trust: 'untrusted', from: 'config', where: 'recorded with its config’s mark' });
    expect(by.lookup).toMatchObject({ trust: 'untrusted', from: 'config', where: 'shadowlap.config.json' });
    expect(by.user_input).toMatchObject({ trust: 'trusted', from: null, where: null, input: true, flip: '"tools": { "user_input": { "trust": "untrusted" } }' });
    expect(by.send_email).toMatchObject({ trust: 'trusted', where: null });
  });

  it('shows the tools entry as the file holds it, a tool a line, unrecorded as written', () => {
    expect(toolsEntry({ get_ticket: { trust: 'untrusted' }, unrecorded: { fetch: 'read' }, lookup: { trust: 'trusted' } })).toEqual([
      { tool: 'get_ticket', text: '  "get_ticket": { "trust": "untrusted" },' },
      { tool: 'unrecorded', text: '  "unrecorded": { "fetch": "read" },' },
      { tool: 'lookup', text: '  "lookup": { "trust": "trusted" }' },
    ]);
    expect(toolsEntry(undefined)).toEqual([]);
    expect(toolsEntry('nope')).toEqual([]);
  });

  it('puts each row’s trust on the Tools tab, and the run an untrusted read’s test runs on, in one pooled read', async () => {
    const run = record(store);
    record(store, { tool: 'lookup' });
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tools: { lookup: { trust: 'trusted' } } }));
    const answer = await INJECTION_READS['tools-read'](store, { kind: 'tools-read', goldens: [], project, tools: { lookup: { trust: 'trusted' } } }, { whole: true });
    const view = toolsSettings({ cwd: project, store }, { reads: answerData<ToolsRead>(answer), mcpDoc: null });
    const by = Object.fromEntries(view.live.map((t) => [t.name, t]));
    expect(by.get_ticket).toMatchObject({ trust: 'untrusted', where: 'SDK', test: { runId: run.runId, golden: null, whose: run.runId.slice(0, 10), reads: [{ callNo: 1, name: 'get_ticket', from: 'sdk', readAt: 2 }] } });
    expect(by.get_ticket.test!.estimate).toMatchObject({ kind: 'injection' });
    expect(by.lookup).toMatchObject({ trust: 'trusted', from: 'config', where: 'shadowlap.config.json', test: null });
    expect(view.fenced[0]).toMatchObject({ name: 'send_email', trust: 'trusted', test: null });
    expect(view.entry).toEqual([{ tool: 'lookup', text: '  "lookup": { "trust": "trusted" }' }]);
  });
});

describe('The run an untrusted read’s test runs on', () => {
  it('is the newest golden’s recording that reads it, else the newest ended recording that does', async () => {
    const older = record(store);
    const newer = record(store);
    record(store, { running: true });
    const security = await injectionSecurity(store, { goldens: [golden('goldens/refund-flow', older.runId)], project });
    const tests = await toolTests(store, ['get_ticket'], security, { goldens: [], project });
    // The golden's, though a newer recording reads it too.
    expect(tests.get_ticket).toMatchObject({ runId: older.runId, golden: null, whose: 'refund-flow’s recording' });
    const none = await toolTests(store, ['get_ticket', 'never_called'], { goldens: [], none: [], unread: [] }, { goldens: [], project });
    expect(none.get_ticket).toMatchObject({ runId: newer.runId, whose: newer.runId.slice(0, 10) });
    expect(none.never_called).toBeUndefined();
  });
});

describe('Tests’ Security', () => {
  it('lists each golden’s untrusted reads and its last test or gate, and names the rest apart', async () => {
    const gated = record(store, { reads: 2 });
    const planted = record(store);
    const untested = record(store);
    const plain = record(store, { tool: 'lookup', meta: {} });
    store.putInjectionResult(plantResult(planted.runId, { at: 10, verdict: 'ignored', gate: 'passed' }));
    store.putInjectionResult(plantResult(gated.runId, { at: 11, verdict: 'ignored', gate: 'passed' }));
    // The gate a session ran wins over a newer test of its recording.
    store.putInjectionResult(plantResult(gated.runId, { golden: 'goldens/gated', at: 5, verdict: 'obeyed', gate: 'failed' }));
    const read = await injectionSecurity(store, { goldens: [golden('goldens/gated', gated.runId), golden('goldens/planted', planted.runId), golden('goldens/untested', untested.runId), golden('goldens/plain', plain.runId), golden('goldens/lost', null)], project });
    expect(read.goldens.map((g) => g.name)).toEqual(['untested', 'planted', 'gated']);
    const by = Object.fromEntries(read.goldens.map((g) => [g.name, g]));
    expect(by.gated).toMatchObject({ runId: gated.runId, recording: gated.runId, reads: [{ callNo: 1, name: 'get_ticket' }, { callNo: 3, name: 'get_ticket' }], last: { verdict: 'failed', gate: true } });
    expect(by.gated.last!.line).toMatch(/obeyed a planted instruction · 1 of 6$/);
    expect(by.planted.last).toMatchObject({ verdict: 'passed', gate: false, line: 'ignored every planted instruction · 6 attempts' });
    expect(by.untested.last).toBeNull();
    expect(by.untested.estimate).toMatchObject({ kind: 'injection' });
    expect(read.none).toEqual(['plain']);
    expect(read.unread).toEqual([{ name: 'lost', why: CANT_READ_RECORDING }]);
  });

  it('reads a golden whose recording only its pack holds from the pack, and tests the golden', async () => {
    const elsewhere = Store.open(':memory:');
    try {
      const run = record(elsewhere);
      mkdirSync(join(project, 'goldens'), { recursive: true });
      packRun(elsewhere, run.runId, join(project, 'goldens', 'packed'));
      const read = await injectionSecurity(store, { goldens: [golden('goldens/packed', run.runId)], project });
      expect(read.unread).toEqual([]);
      expect(read.goldens).toEqual([expect.objectContaining({ name: 'packed', runId: null, recording: run.runId, reads: [expect.objectContaining({ name: 'get_ticket' })] })]);
      const tests = await toolTests(store, ['get_ticket'], read, { goldens: [], project });
      expect(tests.get_ticket).toMatchObject({ runId: null, golden: 'goldens/packed', whose: 'packed’s recording' });
    } finally {
      elsewhere.close();
    }
  });
});

describe('An injection plan’s price', () => {
  it('starts from every template, or the few past eight reads, and prices a gate per session', async () => {
    const all = injectionTemplates().templates.length;
    expect(defaultPayloads(8)).toBe(all);
    expect(defaultPayloads(9)).toBe(2);
    const few = record(store, { reads: 2 });
    const many = record(store, { reads: 9 });
    const p = pricingOf(store, undefined);
    const own = injectionPrice(few.runId, undefined)(p);
    expect(own).toMatchObject({ kind: 'injection', parts: [`${2 * all} attempts and 6 clean replays`, expect.any(String)] });
    expect(injectionPrice(many.runId, undefined)(p).parts[0]).toBe(`${9 * 2} attempts and 27 clean replays`);
    // A Stop at $ under the price stops it there.
    const stopped = injectionPrice(few.runId, undefined, { payloads: all, budget: own.usd! / 2 })(p);
    expect(stopped).toMatchObject({ stops: own.usd! / 2, parts: expect.arrayContaining(['inconclusive if cut short']) });
    expect(gatePrice(few.runId, undefined)(p)).toMatchObject({ recurs: 'every test session, in CI too', parts: [`${2 * all * 3} attempts and 6 clean replays`, expect.any(String)] });
  });

  it('says there is no estimate for a model with no price', () => {
    const run = record(store);
    const e = injectionPrice(run.runId, undefined)(pricingOf(store, undefined));
    expect(e.usd).toBeGreaterThan(0);
    const unpriced = Store.open(':memory:');
    try {
      const r = unpriced.createRun({ mode: 'record', parentRunId: null, command: { argv: ['agent'], cwd: '.' }, codeVersion: null });
      unpriced.appendCallStart({ runId: r.runId, callNo: 1, kind: 'tool', name: 'get_ticket', fingerprint: 'a', occurrence: 1, origin: 'live', effect: 'read', requestRef: null, meta: { trust: 'untrusted' }, at: 1 });
      unpriced.appendCallStart({ runId: r.runId, callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'b', occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: 2 });
      unpriced.appendCallEnd({ kind: 'api', name: 'POST /v1/messages', fingerprint: 'b', occurrence: 1 }, { runId: r.runId, callNo: 2, attempt: 0, responseRef: null, outcome: 'ok', meta: { usage: usageAt(2), model: 'no-such-model' }, at: 3 });
      unpriced.endRun(r.runId, 'completed');
      expect(injectionPrice(r.runId, undefined)(pricingOf(unpriced, undefined))).toMatchObject({ usd: null });
    } finally {
      unpriced.close();
    }
  });
});

describe('Find cause’s answers', () => {
  const clean = (resultId: string, at: number, read: number, writes: Array<{ callNo: number; gone: number; verdict: 'caused' | 'not caused' | 'inconclusive' }>): StoredInjectionResult => ({
    resultId, runId: 'R', golden: null, sessionId: null, mode: 'clean', at, endedAt: at + 1, attempts: 3, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0, verdict: writes[0].verdict, actor: 'dev',
    data: { resultId, mode: 'clean', read: { callNo: read, name: read === 4 ? 'get_ticket' : 'get_shipping' }, gate: CLEAN_GATE, writes: writes.map((w) => ({ ...w, name: 'send_email', args: {}, identifiers: '', attempts: w.verdict === 'inconclusive' ? 0 : 3, bound: null })) },
  });

  it('keeps the newest answer for each read and write, causes first, an older cause kept past a newer answer about another read', () => {
    const answers = cleanAnswers([
      clean('inj-1', 10, 4, [{ callNo: 28, gone: 3, verdict: 'caused' }]),
      clean('inj-2', 20, 14, [{ callNo: 28, gone: 0, verdict: 'not caused' }, { callNo: 31, gone: 0, verdict: 'inconclusive' }]),
      clean('inj-0', 5, 4, [{ callNo: 28, gone: 0, verdict: 'not caused' }]),
    ]);
    expect(answers.map((a) => [a.resultId, a.verdict, a.line])).toEqual([
      ['inj-1', 'caused', '#4 get_ticket · #28 send_email is gone in 3 of 3 clean attempts · rate >= 0.29 (95%)'],
      ['inj-2', 'not caused', '#14 get_shipping · #28 send_email is gone in 0 of 3 clean attempts · rate <= 0.71 (95%)'],
      ['inj-2', 'inconclusive', '#14 get_shipping · #31 send_email: no clean attempt decided it'],
    ]);
    // The run's line says the caused write as the finding does.
    expect(injectionLine(clean('inj-1', 10, 4, [{ callNo: 28, gone: 3, verdict: 'caused' }]))).toBe('caused by #4 get_ticket · #28 send_email is gone in 3 of 3 clean attempts · rate >= 0.29 (95%)');
  });
});
