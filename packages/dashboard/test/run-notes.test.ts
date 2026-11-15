import { afterEach, describe, expect, it } from 'vitest';
import { storeApiRequest, Store, type RunMeta } from '@shadowlap/engine';
import { CLAUDE_CODE_USER, RunBuilder, text, toolUse, user } from '../../engine/test/run-fixtures.js';
import { callDetail, provenance, runDetail } from '../src/api.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import { runUnrecorded, runWebSockets } from '../src/run-unrecorded.js';
import { shortReason } from '../src/tests.js';
import { hintWords } from '../ui/tests/report-words.js';
import { UNGUARDED_FIX } from '../../cli/src/doctor.js';
import { declareSnippet, noteText, notesSaid } from '../ui/run/note-lines.js';
import { runNotes, viaWords } from '../ui/run/notes.js';
import { preloadsOf, preloadWords } from '../ui/run/preloads.js';

/**
 * What a run's page says of what the run did that shadowlap did not record, or answered as it went:
 * the tools the model called that it never recorded (contract 10), a run no preload loaded in, the
 * WebSockets that went live, a replay's extra reads, and the host a model call went through.
 */

const BASH = { name: 'Bash', count: 14, firstCallNo: 3, effect: 'write' as const, why: 'a Claude Code built-in that runs a command', fix: 'fence' as const };
const SEARCH = { name: 'WebSearch', count: 2, firstCallNo: 7, effect: 'read' as const, why: 'a built-in that only reads' };

describe('the notes under a run’s banner', () => {
  it('names the tools the model called that the run never recorded, what a replay does with them, and how to have them recorded', () => {
    const [n] = notesSaid({ unrecorded: { tools: [BASH, SEARCH], partial: false }, mode: 'record' });
    expect(n).toMatchObject({ kind: 'unrecorded', tone: 'err', label: 'not recorded', tools: [BASH, SEARCH] });
    expect(noteText(n.parts)).toBe(
      'The model called 2 tools shadowlap did not record: they ran in your agent unseen, and a replay runs them for real. Bash writes, so every command that replays the run refuses to run it again until it is recorded, declared a read, or allowed with --allow-unrecorded.',
    );
    // A Claude Code built-in is recorded through the Claude Agent SDK's fence, not wrapped.
    expect(noteText(n.hint!.parts)).toBe('To have it recorded and replayed, run the query through withFence from @shadowlap/adapters/claude-agent-sdk (with_fence in Python), which records Bash and fences it on replay. Or declare what each does in shadowlap.config.json: ');
    expect(n.hint!.copy).toBe('"tools": { "unrecorded": { "Bash": "write", "WebSearch": "read" } }');
    // Reads alone: amber, nothing refused; a replay says it ran them itself.
    const [reads] = notesSaid({ unrecorded: { tools: [SEARCH], partial: false }, mode: 'replay' });
    expect(reads.tone).toBe('warn');
    expect(noteText(reads.parts)).toBe('The model called a tool shadowlap did not record: this replay ran it for real.');
    // A built-in that keeps to Claude Code's session needs nothing: no hint; an MCP server's tool goes through shadowlap mcp.
    const AGENT = { name: 'Agent', count: 1, firstCallNo: 2, effect: 'read' as const, why: 'a Claude Code built-in that starts a subagent, whose own tool calls are named apart', fix: 'none' as const };
    expect(notesSaid({ unrecorded: { tools: [AGENT], partial: false }, mode: 'record' })[0].hint).toBeUndefined();
    const MCP = { name: 'mcp__issues__close_issue', count: 1, firstCallNo: 4, effect: 'write' as const, why: '"close" changes something', fix: 'mcp' as const };
    expect(noteText(notesSaid({ unrecorded: { tools: [AGENT, MCP], partial: false }, mode: 'record' })[0].hint!.parts)).toContain('connect your agent to its MCP server through shadowlap mcp');
    // A tool whose effect nothing says is declared a write, the safe guess.
    expect(declareSnippet([{ name: 'frobnicate', effect: 'unknown' }])).toBe('"tools": { "unrecorded": { "frobnicate": "write" } }');
  });

  it('says a tool whose effect nothing tells may write, and is refused as a write is, as the CLI says it', () => {
    const FROB = { name: 'frobnicate', count: 2, firstCallNo: 5, effect: 'unknown' as const, why: 'its name says nothing of what it does' };
    const [one] = notesSaid({ unrecorded: { tools: [FROB, SEARCH], partial: false }, mode: 'record' });
    expect(one.tone).toBe('err');
    expect(noteText(one.parts)).toBe(
      'The model called 2 tools shadowlap did not record: they ran in your agent unseen, and a replay runs them for real. frobnicate may write, so every command that replays the run refuses to run it again until it is recorded, declared a read, or allowed with --allow-unrecorded.',
    );
    // The one to wrap is the one refused.
    expect(noteText(one.hint!.parts)).toContain("tool('frobnicate', { effect: 'write' }, fn)");
    // Beside one that writes: they write, or may; of unknown effect alone, they may write.
    expect(noteText(notesSaid({ unrecorded: { tools: [BASH, FROB], partial: false }, mode: 'record' })[0].parts)).toContain('Bash and frobnicate write, or may, so every command that replays the run refuses to run them again until they are recorded');
    expect(noteText(notesSaid({ unrecorded: { tools: [FROB, { ...FROB, name: 'zap' }], partial: false }, mode: 'record' })[0].parts)).toContain('frobnicate and zap may write, so');
  });

  it('says a run that holds its model calls alone runs the tools they asked for live, refusing nothing', () => {
    const [n] = notesSaid({ unrecorded: { tools: [BASH], partial: true }, mode: 'record' });
    expect(n).toMatchObject({ tone: 'n', label: 'not recorded' });
    expect(n.hint).toBeUndefined();
    expect(noteText(n.parts)).toBe('This run holds its model calls alone, as a capture or a trace does: a replay runs the tool they asked for live, Bash.');
  });

  it('says a run no preload loaded in, in red where --guard block failed it, and nothing when one did', () => {
    const missing = "No Shadowlap preload loaded in the agent's processes, though the run made 3 model calls: under --guard block nothing stopped a connection that bypassed Shadowlap, so the run fails.";
    expect(notesSaid({ unrecorded: null, preloads: { guard: 'block', hellos: {}, missing }, mode: 'record' })).toMatchObject([{ kind: 'preload', which: 'missing', tone: 'err', label: 'no preload', more: false, parts: [missing] }]);
    expect(notesSaid({ unrecorded: null, preloads: { guard: 'warn', hellos: {}, missing: 'No Shadowlap preload loaded …' }, mode: 'record' })[0].tone).toBe('warn');
    expect(notesSaid({ unrecorded: null, preloads: { guard: 'block', hellos: { node: 2 } }, mode: 'record' })).toEqual([]);
  });

  it('says a process the guard could not watch, in the words the run kept, with what doctor says to do', () => {
    const unguarded = 'The network guard could not watch every process of the agent: the Claude Code CLI the Claude Agent SDK runs, which loads no Shadowlap preload, so the connections Claude Code makes itself (WebFetch, an HTTP MCP server) are not watched. A connection one of them made that bypassed Shadowlap went unseen.';
    const [n] = notesSaid({ unrecorded: null, preloads: { guard: 'warn', hellos: { node: 1, 'claude-code': 1 }, unguarded }, mode: 'record' });
    expect(n).toMatchObject({ kind: 'preload', tone: 'warn', label: 'unguarded', parts: [unguarded] });
    // What to do, in doctor's words: the same fix shadowlap doctor gives, with the page's apostrophes.
    expect(noteText(n.hint!.parts).replace(/’/g, "'")).toBe(UNGUARDED_FIX);
    expect(n.hint!.copy).toBeUndefined();
    // Under --guard block the run failed for it: red.
    expect(notesSaid({ unrecorded: null, preloads: { guard: 'block', hellos: { 'claude-code': 1 }, unguarded }, mode: 'record' })[0].tone).toBe('err');
    // Beside a preload that never loaded, each says its own.
    expect(notesSaid({ unrecorded: null, preloads: { guard: 'warn', hellos: {}, missing: 'No Shadowlap preload loaded …', unguarded }, mode: 'record' }).map((x) => x.label)).toEqual(['no preload', 'unguarded']);
    // Kept by the run, read back checked; and the guard's row says it on hover.
    expect(preloadsOf({ preloads: { guard: 'warn', hellos: { 'claude-code': 1 }, unguarded } })).toEqual({ guard: 'warn', hellos: { 'claude-code': 1 }, missing: null, unguarded });
    expect(preloadsOf({ preloads: { guard: 'warn', hellos: {}, unguarded: 7 } })?.unguarded).toBeNull();
    // The Claude Code CLI loads no preload: it is not among those it loaded in.
    expect(preloadWords({ guard: 'warn', hellos: { node: 1, 'claude-code': 1 } })).toBe('warn · loaded in 1 Node process · the Claude Code CLI unwatched');
  });

  it('names the WebSockets that went to a provider live, and those an offline replay refused, as the run’s summary does', () => {
    const notes = notesSaid({ unrecorded: null, websockets: [{ target: 'openai /v1/realtime', count: 2, action: 'tunnelled' }, { target: 'openai /v1/realtime/sessions', count: 1, action: 'refused' }], mode: 'record' });
    expect(notes.map((n) => [n.tone, noteText(n.parts)])).toEqual([
      ['warn', '2 WebSocket connections went to the provider live and were not recorded: openai /v1/realtime (2). A replay connects again for real; an offline replay (shadowlap test) refuses them.'],
      ['n', '1 WebSocket connection was refused: the replay is offline, and a recording holds no WebSocket to answer from: openai /v1/realtime/sessions (1).'],
    ]);
    expect(noteText(notesSaid({ unrecorded: null, websockets: [{ target: 'openai /v1/realtime', count: 1, action: 'tunnelled' }], mode: 'replay' })[0].parts)).toContain('It ran for real during the replay, as it does on every replay');
  });

  it('lists a replay’s extra reads, each opening its call, after what is more pressing', () => {
    const extra = [1, 4, 6, 9].map((callNo) => ({ callNo, kind: 'clock', name: 'now' }));
    const notes = notesSaid({ unrecorded: { tools: [SEARCH], partial: false }, extraReads: extra, preloads: { guard: 'block', hellos: {}, missing: 'No Shadowlap preload loaded.' }, mode: 'replay' });
    expect(notes.map((n) => n.kind)).toEqual(['preload', 'unrecorded', 'extra']);
    const e = notes[2];
    expect(e.parts.filter((p) => typeof p === 'object' && 'call' in p)).toEqual([{ call: 1 }, { call: 4 }, { call: 6 }]);
    expect(noteText(e.parts)).toBe('4 extra reads answered live, with no recorded counterpart: #1 clock now, #4 clock now, #6 clock now, …. The replay went on replaying: a value one of them gave may be what changed a request after it.');
  });

  it('decides a run’s notes, their weight, label and what is under them, apart from their words: what its findings bar sorts and lists them by', () => {
    const i = { unrecorded: { tools: [SEARCH], partial: false }, extraReads: [{ callNo: 1, kind: 'clock', name: 'now' }], preloads: { guard: 'block', hellos: {}, missing: 'No Shadowlap preload loaded.', unguarded: 'The network guard could not watch every process of the agent.' }, websockets: [{ target: 'openai /v1/realtime', count: 1, action: 'refused' as const }], mode: 'replay' };
    const notes = runNotes(i);
    expect(notes.map((n) => [n.kind, n.which ?? null, n.tone, n.label, n.more])).toEqual([
      ['preload', 'missing', 'err', 'no preload', false],
      ['preload', 'unguarded', 'err', 'unguarded', true],
      ['unrecorded', null, 'warn', 'not recorded', true],
      ['websocket', 'refused', 'n', 'websocket', false],
      ['extra', null, 'n', 'extra reads', false],
    ]);
    // Each with what it tells of, for its words to read, and none of them.
    expect(notes.every((n) => n.of === i && !('parts' in n))).toBe(true);
    // What has more under its line is what its words put there.
    expect(notesSaid(i).map((n) => !!(n.tools?.length || n.hint))).toEqual(notes.map((n) => n.more));
    expect(runNotes({ unrecorded: { tools: [], partial: false }, websockets: [], extraReads: [], mode: 'record' })).toEqual([]);
  });

  it('says the host a model call went through, and the preloads that loaded', () => {
    expect(viaWords('openrouter.ai', 'openai')).toBe('openrouter.ai, a host your config declares, in OpenAI’s format');
    expect(viaWords('foundry', 'anthropic')).toBe('Claude on Microsoft Foundry');
    expect(viaWords('bedrock-mantle', 'openai')).toBe('OpenAI’s API on Amazon Bedrock');
    expect(preloadWords({ guard: 'block', hellos: { python: 1, node: 2 } })).toBe('block · loaded in 2 Node processes and 1 Python process');
    expect(preloadWords({ guard: 'warn', hellos: {}, missing: 'x' })).toBe('warn · no preload loaded');
    expect(preloadWords({ guard: 'off', hellos: {} })).toBe('off · no guard');
    // From someone else's pack: only what is well formed.
    expect(preloadsOf({ preloads: { guard: 'block', hellos: { node: 2, 'Bad Name': 3, deno: -1 }, missing: 7 } })).toEqual({ guard: 'block', hellos: { node: 2 }, missing: null, unguarded: null });
    expect(preloadsOf({ preloads: { guard: 'loud' } })).toBeNull();
  });
});

let store: Store | null = null;
let dash: Dashboard | null = null;
afterEach(async () => {
  await dash?.close();
  dash = null;
  store?.close();
  store = null;
});

/** A recording whose model asked for Bash twice and lookup_order once, of which the agent wrapped only lookup_order. */
function recording(s: Store, meta?: RunMeta): string {
  const b = RunBuilder.start(s, meta ? { meta } : {});
  // From Claude Code, whose Bash it is.
  b.model({ messages: [user('Fix the build.')], metadata: { user_id: CLAUDE_CODE_USER } }, [text('Looking.'), toolUse('Bash', { command: 'npm test' }, 't1'), toolUse('lookup_order', { id: 'A-1' }, 't2')]);
  b.tool('lookup_order', { id: 'A-1' }, { amount: 40 });
  b.model({ messages: [user('more')] }, [toolUse('Bash', { command: 'git status' }, 't3')]);
  return b.end();
}

describe('what a run never recorded, from the server', () => {
  it('reads the tools the model called that the run recorded no call of, under the effects the config declares', () => {
    store = Store.open(':memory:');
    const runId = recording(store);
    const run = store.getRun(runId)!;
    expect(runUnrecorded(store, run)).toEqual({ runId, tools: [{ name: 'Bash', count: 2, firstCallNo: 1, effect: 'write', why: 'a Claude Code built-in that runs a command', fix: 'fence' }], partial: false });
    expect(runUnrecorded(store, run, { Bash: 'read' }).tools[0]).toMatchObject({ effect: 'read', why: 'declared read in shadowlap.config.json' });
    // A run that holds its model calls alone says so.
    const partial = recording(store, { covers: ['api'] });
    expect(runUnrecorded(store, store.getRun(partial)!).partial).toBe(true);
  });

  it('answers GET /api/runs/:id/unrecorded beside the server, with what the project’s config declares', async () => {
    store = Store.open(':memory:');
    const runId = recording(store);
    dash = await startDashboard({ store, loadConfig: () => ({ normalize: [], redact: [], unrecorded: { Bash: 'read' } }) });
    const get = (path: string) => fetch(`${dash!.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash!.token } });
    const res = await get(`runs/${runId}/unrecorded`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { unrecorded: unknown }).unrecorded).toEqual({ runId, tools: [{ name: 'Bash', count: 2, firstCallNo: 1, effect: 'read', why: 'declared read in shadowlap.config.json', fix: 'fence' }], partial: false });
    // By a short id too, and a run the store doesn't hold is named.
    expect((await get(`runs/${runId.slice(0, 10)}/unrecorded`)).status).toBe(200);
    expect((await get('runs/01NOPE0000000000000000000Z/unrecorded')).status).toBe(404);
  });

  it('gives a call the host it went through and a replay’s extra read, the run its WebSockets, and Provenance its guard', () => {
    store = Store.open(':memory:');
    const b = RunBuilder.start(store, { meta: { preloads: { guard: 'block', hellos: { node: 2 } }, websockets: [{ target: 'openai /v1/realtime', count: 2, action: 'tunnelled' }, { bogus: true }] } as unknown as RunMeta });
    b.model({ messages: [user('hi')] }, [text('Hello.')]);
    // Through OpenRouter, a host the config declares, in OpenAI's format.
    const s = store;
    s.appendCallStart({ runId: b.runId, callNo: 2, kind: 'api', name: 'POST /api/v1/chat/completions', fingerprint: 'fp-2', occurrence: 1, origin: 'live', effect: null, requestRef: storeApiRequest(s, { messages: [user('again')] }), meta: { provider: 'openai', via: 'openrouter.ai' }, at: b.at + 10 });
    s.appendCallEnd({ kind: 'api', name: 'POST /api/v1/chat/completions', fingerprint: 'fp-2', occurrence: 1 }, { runId: b.runId, callNo: 2, attempt: 0, responseRef: s.putBlob(Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi.' }, finish_reason: 'stop' }] }))), outcome: 'ok', meta: { status: 200, provider: 'openai', model: 'gpt-5' }, at: b.at + 20 });
    b.callNo = 2;
    b.at += 30;
    b.tool('lookup_policy', { region: 'EU' }, { limit: 100 }, { meta: { extraRead: true } });
    const runId = b.end();
    const d = runDetail(store, runId)!;
    expect(d.calls.map((c) => [c.callNo, c.via ?? null, c.extraRead ?? null])).toEqual([
      [1, null, null],
      [2, 'openrouter.ai', null],
      [3, null, true],
    ]);
    expect(d.websockets).toEqual([{ target: 'openai /v1/realtime', count: 2, action: 'tunnelled' }]);
    expect(callDetail(store, runId, 2)!.call).toMatchObject({ provider: 'openai', via: 'openrouter.ai' });
    const p = provenance(store, runId)!;
    expect(p.providers).toEqual([
      { provider: 'anthropic', calls: 1 },
      { provider: 'openai', calls: 1, via: 'openrouter.ai' },
    ]);
    expect(p.preloads).toEqual({ guard: 'block', hellos: { node: 2 }, missing: null, unguarded: null });
    // A run that keeps none, or keeps them malformed: none.
    expect(runWebSockets({ meta: {} })).toBeNull();
    expect(runWebSockets({ meta: { websockets: [{ target: 7, count: 1 }] } as unknown as RunMeta })).toBeNull();
  });
});

describe('a golden the guard never watched, on Tests', () => {
  it('says so in a few words and what to do, never that it couldn’t run', () => {
    const r = { ok: false, failure: 'guard', reason: "No Shadowlap preload loaded in the agent's processes, though the run made 2 model calls: under --guard block nothing stopped a connection that bypassed Shadowlap, so the run fails.", data: {} } as unknown as Parameters<typeof shortReason>[0];
    expect(shortReason(r)).toBe('no preload loaded: the network guard never watched it');
    // Its report's hint (the server keys it no-preload: test/golden-report.test.ts, "the guard").
    const hint = hintWords({ key: 'no-preload' });
    expect(hint).toContain('No Shadowlap preload loaded in the agent’s processes while the golden replayed');
    expect(hint).toContain('--guard warn');
    expect(hint).not.toBe(hintWords({ key: 'error' }));
  });

  it('says a golden failed for a process the guard can’t watch, as that, with doctor’s fix, never as no preload', () => {
    const reason = 'The network guard could not watch every process of the agent: the Claude Code CLI the Claude Agent SDK runs, which loads no Shadowlap preload, so the connections Claude Code makes itself (WebFetch, an HTTP MCP server) are not watched. Under --guard block nothing stops such a connection, so the run fails. Replay it with --guard warn to accept connections the guard can\'t watch.';
    const r = { ok: false, failure: 'guard', reason, data: {} } as unknown as Parameters<typeof shortReason>[0];
    expect(shortReason(r)).toBe('unguarded: a process the network guard can’t watch ran');
    // Its report's hint (keyed unguarded on the server, never no-preload), with doctor's fix in doctor's words.
    const hint = hintWords({ key: 'unguarded' });
    expect(hint.replace(/’/g, "'")).toBe(`A process the network guard can't watch ran while the golden replayed, and under --guard block that fails it: ${UNGUARDED_FIX}`);
  });
});
