import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store, type Effect, type RunMeta } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';
import type { CheckSuggestions } from '../src/suggested-checks.js';

/**
 * The check builder's suggested checks (POST /api/checks/suggestions, a pooled read): at most three
 * rules that fail a failed recording and pass every good run it is compared with, its fix's and the
 * agent's recordings labelled good, the builder's own left out. Nothing is written.
 */

let project: string;
let store: Store;
let dash: Dashboard;
const env = { ...process.env };

beforeAll(() => {
  process.env.SHADOWLAP_HOME = mkdtempSync(join(tmpdir(), 'sl-suggested-home-'));
});
afterAll(() => {
  rmSync(process.env.SHADOWLAP_HOME!, { recursive: true, force: true });
  process.env = env;
});

async function start(readOnly = false): Promise<void> {
  dash = await startDashboard({ store, dbPath: join(project, '.shadowlap', 'shadowlap.db'), readOnly, project: { path: project }, goldens: () => [] });
}
beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-suggested-')));
  mkdirSync(join(project, '.shadowlap'));
  store = Store.open(join(project, '.shadowlap', 'shadowlap.db'));
  await start();
});
afterEach(async () => {
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const ask = (body: unknown) => fetch(`${dash.url}/api/checks/suggestions`, { method: 'POST', body: JSON.stringify(body), headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' } });
async function suggested(body: unknown): Promise<CheckSuggestions> {
  const res = await ask(body);
  expect(res.status, JSON.stringify(body)).toBe(200);
  return (await res.json()) as CheckSuggestions;
}
const error = async (res: Response) => ((await res.json()) as { error: string }).error;

type Tool = { name: string; effect: Effect; args?: unknown; result?: unknown };

/** A recording of `argv`: tool calls with their arguments and results, then ended (unless `status` is null). */
function recording(argv: string[], tools: Tool[], o: { at?: number; meta?: RunMeta; status?: 'completed' | 'failed' | null; parent?: string } = {}): string {
  const at = o.at ?? 1000;
  const run = store.createRun({ mode: o.parent ? 'replay' : 'record', parentRunId: o.parent ?? null, command: { argv, cwd: project }, startedAt: at, ...(o.meta ? { meta: o.meta } : {}) });
  tools.forEach((t, i) => {
    const callNo = i + 1;
    const identity = { kind: 'tool' as const, name: t.name, fingerprint: createHash('sha256').update(`${t.name} ${callNo}`).digest('hex'), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: 'live', effect: t.effect, requestRef: store.putJson({ args: t.args ?? {} }), meta: {}, at: at + callNo });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result: t.result ?? null }), outcome: 'ok', meta: {}, at: at + callNo });
  });
  if (o.status !== null) store.endRun(run.runId, o.status ?? 'completed', at + 100);
  return run.runId;
}

const AGENT = ['node', 'agent.mjs'];
/** The order looked up, the policy read, the refund issued: `amount` against the policy's limit of 100. */
const refund = (amount: number): Tool[] => [
  { name: 'lookup_order', effect: 'read', args: { order_id: 'A-1042' }, result: { order_id: 'A-1042', amount } },
  { name: 'get_policy', effect: 'pure', result: { limit: 100 } },
  { name: 'issue_refund', effect: 'write', args: { order_id: 'A-1042', amount }, result: { refund_id: 'R-5401' } },
];
const GOOD = { meta: { labels: ['good'] } };
const VALUE = 'every issue_refund call: amount <= get_policy.result.limit';
const WHEN = 'when lookup_order has result.amount > 100: issue_refund called 0 times';
const FIX = 'fx-01K8RG00000000000000000003';

function fixOf(failing: string, good: string[]): void {
  store.insertFix({ fixId: FIX, title: 'Refund over the limit', labels: [], check: { expect: null, key: 'check:exit', oracle: [], text: 'the agent exits 0' }, status: 'open', openedAt: 3_000, verifiedAt: null, appliedAt: null, data: {} });
  store.addFixLink(FIX, 'failing', failing, 3_000);
  good.forEach((id, i) => store.addFixLink(FIX, 'good', id, 3_001 + i));
}

describe('suggested checks', () => {
  it('answers the rules that fail a failed recording and pass its fix’s good run and the agent’s labelled good', async () => {
    const labelled = recording(AGENT, refund(80), { at: 1_000, ...GOOD });
    const kept = recording(AGENT, refund(90), { at: 1_500 });
    recording(['python', 'other.py'], refund(500), { at: 1_600, ...GOOD });
    const bad = recording(AGENT, refund(240), { at: 2_000 });
    fixOf(bad, [kept]);
    const out = await suggested({ run: bad, at: 3, have: [] });
    expect(out.runId).toBe(bad);
    expect(out.goods).toEqual([kept, labelled]);
    expect(out.suggestions.map((s) => s.label)).toEqual([VALUE, WHEN]);
    expect(out.suggestions[0]).toEqual({ shape: 'value', expect: { calls: [{ tool: 'issue_refund', args: { amount: { '<=': '@get_policy.result.limit' } } }] }, label: VALUE });
    // The fix's builder asks with the fix, made from no call.
    expect((await suggested({ run: bad, fix: FIX })).goods).toEqual([kept, labelled]);
  });

  it('leaves out a rule the builder holds', async () => {
    recording(AGENT, refund(80), GOOD);
    const bad = recording(AGENT, refund(240), { at: 2_000 });
    expect((await suggested({ run: bad, at: 3, have: [VALUE, 'send_email called 0 times'] })).suggestions.map((s) => s.label)).toEqual([WHEN]);
  });

  it('answers none for a replay, a capture or a recording still running', async () => {
    recording(AGENT, refund(80), GOOD);
    const bad = recording(AGENT, refund(240), { at: 2_000 });
    const replay = recording(AGENT, refund(240), { at: 2_100, parent: bad });
    const capture = recording([NO_COMMAND], refund(240), { at: 2_200 });
    const running = recording(AGENT, refund(240), { at: 2_300, status: null });
    for (const run of [replay, capture, running]) expect(await suggested({ run })).toEqual({ runId: run, goods: [], suggestions: [] });
  });

  it('refuses a run that isn’t there, a call that isn’t one, labels that aren’t text and a fix the run isn’t failing in', async () => {
    const good = recording(AGENT, refund(80), GOOD);
    const bad = recording(AGENT, refund(240), { at: 2_000 });
    expect(await error(await ask({}))).toBe('name the recording the checks are suggested from (run)');
    const missing = await ask({ run: '01K8RGZZZZZZZZZZZZZZZZZZZZ' });
    expect(missing.status).toBe(404);
    for (const at of [0, 1.5, 'three']) expect(await error(await ask({ run: bad, at }))).toBe('at is the number of the call the check is made from: a whole number, 1 or more');
    for (const have of ['refund', [1], Array.from({ length: 201 }, (_, i) => `rule ${i}`)]) expect(await error(await ask({ run: bad, have }))).toBe('have is the labels of the checks the builder holds: at most 200, as text');
    expect((await ask({ run: bad, fix: 'refund' })).status).toBe(400);
    fixOf(good, []);
    const notFailing = await ask({ run: bad, fix: FIX });
    expect(notFailing.status).toBe(404);
    expect(await error(notFailing)).toBe(`no fix ${FIX} holds this run as failing`);
  });

  it('answers on a read-only dashboard, as it changes nothing', async () => {
    recording(AGENT, refund(80), GOOD);
    const bad = recording(AGENT, refund(240), { at: 2_000 });
    await dash.close();
    await start(true);
    expect((await suggested({ run: bad, at: 3 })).suggestions.map((s) => s.label)).toEqual([VALUE, WHEN]);
  });
});
