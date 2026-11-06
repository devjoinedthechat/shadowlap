import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeApiRequest, Store, type CallKind, type DivergenceReport, type Origin, type RunMeta } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';
import { requestDiff, type RequestDiff } from '../src/request-diff.js';
import { testOffer } from '../src/run-offers.js';
import { findingPath } from '../ui/run/banner.js';

/**
 * Show diff's read, `GET /api/runs/:id/diff[?call=<n>]`: the request a fork or a diverged test
 * changed, as recorded and as sent, both whole; the path the finding names; each changed path with
 * what fixes it; what no line of the bodies shows; and the forks no pair of bodies says, in the
 * facts their words need. Every value here is made up.
 */

const T0 = Date.UTC(2026, 10, 2, 9);
const MODEL = 'claude-sonnet-4-5';
const UUID_A = '3f1c9a2e-5b7d-4e8a-9c1f-2a6b8d0e4f13';
const UUID_B = '9b2e4d6f-1a3c-4b5d-8e7f-0c2a4e6b8d10';
const SYSTEM = 'You are a refund agent. Refund only within the policy limit.';
const POLICY = { policy: 'standard', max: 50 };
const POLICY_FIX = { ...POLICY, refund_limit: 100 };

/** A model request: the user's ask, the tool's call and its result, as the third call sends it. */
function request(o: { model?: string; system?: string; policy?: object; user?: string } = {}) {
  return {
    model: o.model ?? MODEL,
    max_tokens: 1024,
    system: o.system ?? SYSTEM,
    metadata: { user_id: o.user ?? UUID_A },
    messages: [
      { role: 'user', content: 'Refund order 1042' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'lookup_policy', input: { order: 1042 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: JSON.stringify(o.policy ?? POLICY) }] },
    ],
  };
}

interface CallSpec {
  kind?: CallKind;
  origin?: Origin;
  request?: unknown;
  result?: unknown;
  meta?: Record<string, unknown>;
}

let store: Store;
let dash: Dashboard;
const at = { now: T0 };

/** A run of a model call, a lookup_policy tool call and a model call, each with what it sent and got. */
function addRun(o: { parent?: string; meta?: RunMeta; calls: [CallSpec, CallSpec, CallSpec]; divergence?: Omit<DivergenceReport, 'replayedBefore' | 'kind' | 'name'> & { kind?: CallKind; name?: string } }): string {
  const run = store.createRun({ mode: o.parent ? 'replay' : 'record', ...(o.parent ? { parentRunId: o.parent } : {}), command: { argv: ['python', 'refund_agent.py'], cwd: '/work' }, startedAt: (at.now += 1000), ...(o.meta ? { meta: o.meta } : {}) });
  o.calls.forEach((c, i) => {
    const callNo = i + 1;
    const kind = c.kind ?? (callNo === 2 ? 'tool' : 'api');
    const identity = { kind, name: kind === 'api' ? 'POST /v1/messages' : 'lookup_policy', fingerprint: `fp${callNo}-${run.runId}`, occurrence: 1 };
    const requestRef = c.request === undefined ? null : kind === 'api' ? storeApiRequest(store, c.request) : store.putJson(c.request);
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: c.origin ?? (o.parent ? 'replayed' : 'live'), effect: kind === 'tool' ? 'read' : null, requestRef, meta: {}, at: (at.now += 10) });
    const responseRef = c.result === undefined ? null : store.putJson(c.result);
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef, outcome: 'ok', meta: { latencyMs: 10, ...(c.meta ?? {}) }, at: (at.now += 10) });
  });
  if (o.divergence) {
    const callNo = o.divergence.callNo;
    const kind = o.divergence.kind ?? (callNo === 2 ? 'tool' : 'api');
    store.setDivergence(run.runId, { ...o.divergence, kind, name: o.divergence.name ?? (kind === 'api' ? 'POST /v1/messages' : 'lookup_policy'), replayedBefore: callNo - 1 });
  }
  store.endRun(run.runId, 'completed', (at.now += 10));
  return run.runId;
}

const replayed = (n: number): CallSpec => ({ origin: 'replayed', meta: { replayedFrom: n } });
const lookup = (policy: object = POLICY): CallSpec => ({ request: { args: { order: 1042 } }, result: { result: policy } });

let rec = '';
let override = '';
let modelFork = '';
let diverge = '';
let liveTool = '';
let promptFrom = '';
let urlModel = '';
let orphan = '';
let uuidTest = '';
let modelTest = '';

beforeAll(async () => {
  store = Store.open(':memory:');
  rec = addRun({ calls: [{ request: { model: MODEL, messages: [] } }, lookup(), { request: request() }] });
  const changedPolicy = { path: '$.messages[2].content[0].content', op: 'changed' as const, before: JSON.stringify(POLICY), after: JSON.stringify(POLICY_FIX) };
  override = addRun({
    parent: rec,
    meta: { interventions: [{ kind: 'override', at: 2, flag: '--override 2=@policy.json' }] },
    calls: [replayed(1), { ...lookup(POLICY_FIX), origin: 'overridden', meta: { overriddenFrom: 2 } }, { origin: 'live', request: request({ policy: POLICY_FIX }) }],
    divergence: { type: 'request_changed', callNo: 3, counterpart: { runId: rec, callNo: 3 }, diff: [changedPolicy] },
  });
  modelFork = addRun({
    parent: rec,
    meta: { interventions: [{ kind: 'model', at: 3, flag: '--model 3:claude-haiku-4-5' }] },
    calls: [replayed(1), replayed(2), { origin: 'live', request: request({ model: 'claude-haiku-4-5' }) }],
    divergence: { type: 'request_changed', callNo: 3, counterpart: { runId: rec, callNo: 3 }, diff: [{ path: '$.model', op: 'changed', before: MODEL, after: 'claude-haiku-4-5' }] },
  });
  diverge = addRun({ parent: rec, calls: [replayed(1), replayed(2), { origin: 'live', request: request() }], divergence: { type: 'forced', callNo: 3, reason: 'forced live by --diverge-at 3', counterpart: { runId: rec, callNo: 3 } } });
  liveTool = addRun({ parent: rec, calls: [replayed(1), { ...lookup(POLICY_FIX), origin: 'live' }, { origin: 'live', request: request({ policy: POLICY_FIX }) }], divergence: { type: 'forced', callNo: 2, reason: 'forced live by --live-tool lookup_policy', counterpart: { runId: rec, callNo: 2 } } });
  promptFrom = addRun({
    parent: rec,
    calls: [replayed(1), replayed(2), { origin: 'live', request: request({ system: 'You are a careful refund agent.' }) }],
    divergence: { type: 'forced', callNo: 3, reason: 'forced live by --prompt-from 3: calls before it matched without their system prompt and tool definitions', counterpart: { runId: rec, callNo: 3 } },
  });
  // The model named in the URL path, as Gemini's and Bedrock's are: the body is as recorded.
  urlModel = addRun({
    parent: rec,
    meta: { interventions: [{ kind: 'model', at: 3, flag: '--model 3:gemini-2.5-flash' }] },
    calls: [replayed(1), replayed(2), { origin: 'live', request: request() }],
    divergence: { type: 'forced', callNo: 3, reason: 'forced live by an intervention', counterpart: { runId: rec, callNo: 3 } },
  });
  // Compared with a run the store no longer holds.
  orphan = addRun({ parent: rec, calls: [replayed(1), replayed(2), { origin: 'live', request: request({ model: 'claude-haiku-4-5' }) }], divergence: { type: 'request_changed', callNo: 3, counterpart: { runId: '01K8ZZ00000000000000000099', callNo: 3 }, diff: [{ path: '$.model', op: 'changed', before: MODEL, after: 'claude-haiku-4-5' }] } });

  const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'a7b3c2e', actor: 'ci', startedAt: T0 });
  const test = (golden: string) => ({ test: { golden, session: s.sessionId } }) as RunMeta;
  uuidTest = addRun({
    parent: rec,
    meta: test('goldens/refund'),
    calls: [replayed(1), replayed(2), { origin: 'live', request: request({ user: UUID_B }) }],
    divergence: { type: 'request_changed', callNo: 3, counterpart: { runId: rec, callNo: 3 }, diff: [{ path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B }] },
  });
  modelTest = addRun({
    parent: rec,
    meta: test('goldens/refund-model'),
    calls: [replayed(1), replayed(2), { origin: 'live', request: request({ model: 'claude-haiku-4-5', user: UUID_B }) }],
    divergence: {
      type: 'request_changed',
      callNo: 3,
      counterpart: { runId: rec, callNo: 3 },
      diff: [
        { path: '$.model', op: 'changed', before: MODEL, after: 'claude-haiku-4-5' },
        { path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B },
        { path: 'headers.anthropic-beta', op: 'changed', before: 'tools-2024-04-04', after: 'tools-2025-01-01' },
      ],
      hints: [{ message: 'the anthropic-beta header is part of what makes a model call the same call, and no normalizer masks it: send the recorded value, or record again with the new one' }],
    },
  });
  const data = { mode: 'replay', calls: { total: 3, replayed: 2, live: 1, blocked: 0, stubbed: 0 } } as const;
  for (const [golden, runId] of [
    ['goldens/refund', uuidTest],
    ['goldens/refund-model', modelTest],
  ] as const)
    store.addTestResult({ sessionId: s.sessionId, golden, ok: false, failure: 'diverged', reason: null, runId, revision: 'a7b3c2e', at: (at.now += 10), data });
  store.finishTestSession(s.sessionId, { passed: 0, failed: 2, upstreamRequests: 2, endedAt: (at.now += 10) });
  dash = await startDashboard({ store });
});

afterAll(async () => {
  await dash?.close();
  store?.close();
});

const diffOf = (runId: string, callNo: number | null = null, normalizers: Parameters<typeof requestDiff>[3] = []) => requestDiff(store, store.getRun(runId)!, callNo, normalizers)!;
const api = (path: string, token = dash.token) => fetch(`${dash.url}/api/${path}`, { headers: token ? { 'x-shadowlap-token': token } : {} });

describe('the request a fork changed', () => {
  it('holds both bodies whole, the tool result as the JSON in its string, at the path the finding names', () => {
    const d = diffOf(override);
    expect(d).toMatchObject({ at: 3, what: 'request', against: { runId: rec, callNo: 3 }, whole: true, type: 'request_changed', path: '$.messages[2].content[0].content', test: false });
    expect(d.was).toEqual(request());
    expect(d.now).toEqual(request({ policy: POLICY_FIX }));
    // A fork's change is the point of the fork: nothing to fix it with.
    expect(d.paths).toEqual([{ path: '$.messages[2].content[0].content', what: 'tool_result lookup_policy', fix: null }]);
    expect(d).toMatchObject({ flag: '--override 2=@policy.json', tool: { callNo: 2, name: 'lookup_policy' }, masked: [], outside: [], hints: [] });
  });

  it('says a --model fork’s change at $.model, by its flag, with no fix', () => {
    const d = diffOf(modelFork);
    expect(d).toMatchObject({ path: '$.model', flag: '--model 3:claude-haiku-4-5', paths: [{ path: '$.model', fix: null }] });
    expect((d.was as { model: string }).model).toBe(MODEL);
    expect((d.now as { model: string }).model).toBe('claude-haiku-4-5');
  });

  it('keeps the request in the order the store keeps it', () => {
    const keys = Object.keys(diffOf(override).now as object);
    expect(keys).toContain('messages');
    expect(keys.indexOf('metadata')).toBeLessThan(keys.indexOf('messages'));
  });

  it('answers each call it is asked for: a model call’s request, and a tool’s result where its request is as recorded', () => {
    expect(diffOf(override, 1)).toMatchObject({ at: 1, what: 'request', against: { runId: rec, callNo: 1 }, paths: [], next: null });
    const tool = diffOf(override, 2);
    expect(tool).toMatchObject({ at: 2, what: 'result', against: { runId: rec, callNo: 2 }, was: { result: POLICY }, now: { result: POLICY_FIX }, next: 3, flag: '--override 2=@policy.json' });
  });

  it('builds both sides from the divergence’s changes where the run it is compared with is gone', () => {
    expect(diffOf(orphan)).toMatchObject({ whole: false, was: { model: MODEL }, now: { model: 'claude-haiku-4-5' }, paths: [{ path: '$.model' }] });
  });
});

describe('a forced fork', () => {
  it('Run live from here: both bodies, the same, and the flag that forced it', () => {
    const d = diffOf(diverge);
    expect(d).toMatchObject({ type: 'forced', flag: '--diverge-at 3', path: null, paths: [], whole: true });
    expect(d.was).toEqual(d.now);
  });

  it('a tool run live: the next model call against the recording’s, the tool’s result inside it; the tool’s own view on asking', () => {
    const d = diffOf(liveTool);
    expect(d).toMatchObject({ at: 3, what: 'request', against: { runId: rec, callNo: 3 }, type: 'forced', flag: '--live-tool lookup_policy', tool: { callNo: 2, name: 'lookup_policy' }, path: null });
    expect(d.now).toEqual(request({ policy: POLICY_FIX }));
    expect(diffOf(liveTool, 2)).toMatchObject({ at: 2, what: 'result', was: { result: POLICY }, now: { result: POLICY_FIX }, next: 3 });
  });

  it('--prompt-from: bodies that differ where matching didn’t look', () => {
    const d = diffOf(promptFrom);
    expect(d).toMatchObject({ type: 'forced', flag: '--prompt-from 3' });
    expect((d.was as { system: string }).system).toBe(SYSTEM);
    expect((d.now as { system: string }).system).toBe('You are a careful refund agent.');
  });

  it('names the flag the run keeps, a model named in the URL path among them', () => {
    expect(diffOf(urlModel)).toMatchObject({ type: 'forced', flag: '--model 3:gemini-2.5-flash' });
  });
});

describe('a test that diverged', () => {
  it('fixes a UUID made anew on every run with its normalizer, at the path its finding names', () => {
    const d = diffOf(uuidTest);
    expect(d).toMatchObject({ test: true, path: '$.metadata.user_id', updates: false, flag: null });
    expect(d.paths).toEqual([
      {
        path: '$.metadata.user_id',
        what: 'metadata.user_id',
        fix: { kind: 'normalizer', looks: 'a UUID', op: 'changed', certain: true, message: '$.metadata.user_id looks like a UUID, made anew on every run; to ignore it in matching, add a normalizer', args: expect.arrayContaining(['normalize', 'add']) as string[], command: "shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'" },
      },
    ]);
  });

  it('re-records what code or config changed, and says the headers and the rest apart', () => {
    const d = diffOf(modelTest);
    expect(d.paths.map((p) => [p.path, p.fix?.kind ?? null])).toEqual([
      ['$.model', 'update'],
      ['$.metadata.user_id', 'normalizer'],
    ]);
    // Its rule alone leaves the model's change: the golden is updated after it.
    expect(d.updates).toBe(true);
    expect(d.outside).toEqual(['headers.anthropic-beta']);
    expect(d.hints).toEqual([{ message: expect.stringContaining('the anthropic-beta header') as string, command: null }]);
  });

  it('says a change the rules in force mask apart from those that made it diverge', () => {
    const rule = { kind: 'api' as const, path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' };
    const d = diffOf(modelTest, null, [rule]);
    expect(d.masked).toEqual(['$.metadata.user_id']);
    expect(d.paths.map((p) => p.path)).toEqual(['$.model']);
  });

  it('names the path the finding names, by the finding’s own rule', () => {
    for (const runId of [uuidTest, modelTest, override, modelFork, diverge]) {
      const run = store.getRun(runId)!;
      const offer = testOffer(store, run, []);
      expect(diffOf(runId).path, runId).toBe(findingPath({ path: run.divergence?.diff?.[0]?.path ?? null }, offer));
    }
  });
});

describe('GET /api/runs/:id/diff', () => {
  it('answers the run’s diff, a call’s on asking, and null for a run that never diverged', async () => {
    const res = await api(`runs/${override}/diff`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { diff: RequestDiff }).diff).toMatchObject({ at: 3, path: '$.messages[2].content[0].content' });
    expect((((await (await api(`runs/${override}/diff?call=2`)).json()) as { diff: RequestDiff }).diff)).toMatchObject({ at: 2, what: 'result' });
    expect(await (await api(`runs/${rec}/diff`)).json()).toEqual({ diff: null });
  });

  it('refuses a call that is no whole number, and says what it can’t find', async () => {
    const bad = await api(`runs/${override}/diff?call=two`);
    expect([bad.status, (await bad.json())]).toEqual([400, { error: 'call is a call number: a whole number, 0 or more' }]);
    const past = await api(`runs/${override}/diff?call=99`);
    expect([past.status, (await past.json())]).toEqual([404, { error: `no call #99 in run ${override}` }]);
    expect((await api('runs/01K8ZZ00000000000000000098/diff')).status).toBe(404);
  });

  it('serves nothing without the session token', async () => {
    expect((await api(`runs/${override}/diff`, '')).status).toBe(401);
  });
});
