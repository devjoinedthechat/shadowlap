import { describe, expect, it } from 'vitest';
import { displayOrigin, JUDGE_SCOPE, ORIGIN_CODE, Store, storeApiRequest, summarizeRun, type CallKind, type Origin, type Price, type RunMeta, type RunRecord, type RunSummary } from '@shadowlap/engine';
import { modelResolver } from '@shadowlap/tui/data';
import { modelName, runPageFacts } from '../src/run-page.js';
import { blameStep, runWholeFacts } from '../src/run-summary.js';

/**
 * A long run's first page reads only the calls it shows; what it says of the whole run (its
 * summary, the origin strip, its models' names, blame's step) is read in SQL instead
 * (run-summary.ts). It must say exactly what reading every call says: here, on runs of every shape a
 * store holds, seeded and random, the judge's calls among them, retries, answers that never came,
 * flags written as true, 1 or text, usage or none, a model named by the answer, by the call or only
 * in its request, and extra reads (`extraRead`, true or not quite).
 */

const rnd = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const MODELS = ['claude-sonnet-4-5', 'claude-opus-5', 'gpt-5-mini', 'an-unpriced-model'];
const SCOPES = [undefined, undefined, undefined, 'agent', 'agent/sub', 'other', JUDGE_SCOPE];

function buildRun(store: Store, seed: number, meta: RunMeta, mode: 'record' | 'replay' = 'record'): RunRecord {
  const r = rnd(seed);
  const parent = mode === 'replay' ? store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/w' } }) : null;
  if (parent) store.endRun(parent.runId, 'completed', 1);
  const run = store.createRun({ mode, ...(parent ? { parentRunId: parent.runId } : {}), command: { argv: ['node', 'agent.js'], cwd: '/w' }, startedAt: 1000, meta });
  const calls = 40 + Math.floor(r() * 60);
  for (let callNo = 1; callNo <= calls; callNo++) {
    const kind: CallKind = pick(r, ['api', 'api', 'api', 'tool', 'tool', 'clock', 'random'] as const);
    const origin: Origin = pick(r, ['live', 'live', 'replayed', 'replayed', 'blocked', 'stubbed', 'overridden'] as const);
    const scope = pick(r, SCOPES);
    const model = pick(r, MODELS);
    // The model where the call names it: on its start, only in its request, or nowhere.
    const where = pick(r, ['start', 'end', 'request', 'nowhere'] as const);
    const requestRef = kind === 'api' ? storeApiRequest(store, { model: where === 'request' ? model : 'claude-haiku-4-5', messages: [{ role: 'user', content: `q${callNo}` }] }) : null;
    // A replay's plain read answered live while it went on replaying: the flag as written, true or not quite.
    const extraRead = pick(r, [undefined, undefined, undefined, undefined, undefined, true, 1, 'yes']);
    const startMeta: Record<string, unknown> = { ...(scope ? { scope } : {}), ...(where === 'start' ? { model } : {}), ...(extraRead !== undefined ? { extraRead } : {}) };
    const identity = { kind, name: kind === 'api' ? 'POST /v1/messages' : 'lookup', fingerprint: `f${callNo}`, occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin, effect: null, requestRef: where === 'nowhere' && kind === 'api' ? null : requestRef, meta: startMeta, at: 1000 + callNo });
    // No answer yet, one, or a retry or two before the final one.
    const answers = r() < 0.06 ? 0 : 1 + (r() < 0.15 ? Math.floor(r() * 3) : 0);
    for (let attempt = 0; attempt < answers; attempt++) {
      const flag = () => pick(r, [undefined, undefined, undefined, undefined, true, false, 1, 0, 'yes', '']);
      const endMeta: Record<string, unknown> = {};
      for (const name of ['injected', 'refused', 'offline'] as const) {
        const v = flag();
        if (v !== undefined) endMeta[name] = v;
      }
      if (r() < 0.75) endMeta.usage = { inputTokens: Math.floor(r() * 5000), outputTokens: Math.floor(r() * 900), ...(r() < 0.6 ? { cacheReadInputTokens: Math.floor(r() * 9000) } : {}), ...(r() < 0.3 ? { cacheCreationInputTokens: Math.floor(r() * 2000) } : {}) };
      if (where === 'end' || (where === 'start' && r() < 0.2)) endMeta.model = pick(r, MODELS);
      if (r() < 0.3) endMeta.status = pick(r, [200, 429, 529]);
      store.appendCallEnd(identity, { runId: run.runId, callNo, attempt, responseRef: null, outcome: r() < 0.2 ? 'error' : 'ok', meta: endMeta, at: 2000 + callNo });
    }
  }
  store.endRun(run.runId, 'completed', 9000);
  return store.getRun(run.runId)!;
}

/** The costs to the ninth decimal: priced per model rather than per call, they differ only in the last bits of a float. */
function rounded(s: RunSummary): RunSummary {
  const r = (n: number) => Math.round(n * 1e9) / 1e9;
  return { ...s, cost: { ...s.cost, spent: r(s.cost.spent), saved: r(s.cost.saved), captured: r(s.cost.captured) }, ...(s.judge ? { judge: { ...s.judge, spent: r(s.judge.spent), saved: r(s.judge.saved) } } : {}) };
}

const PRICES: Record<string, Price> = { 'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 } };

describe('what a run page says of the whole run, read in SQL', () => {
  const store = Store.open(':memory:');
  const cases: Array<[string, RunMeta, 'record' | 'replay']> = [
    ['a recording', {}, 'record'],
    ['a fork', {}, 'replay'],
    ['an imported capture', { imported: { at: 1, from: '/work/capture.har' }, covers: ['api'] }, 'record'],
    ['a teammate’s recording pulled from the team store', { imported: { at: 1, from: 's3://team/store' } }, 'record'],
  ];
  for (const [what, meta, mode] of cases) {
    for (const seed of [1, 7, 42, 1999, 31337]) {
      for (const prices of [undefined, PRICES]) {
        it(`says what every call says: ${what}, seed ${seed}, ${prices ? 'own prices' : 'the built-in prices'}`, () => {
          const run = buildRun(store, seed, meta, mode);
          const calls = store.getCalls(run.runId);
          const modelOf = modelResolver(store);
          const sql = runWholeFacts(store, run, { ...(prices ? { prices } : {}), modelOf, name: modelName });
          expect(rounded(sql.summary)).toEqual(rounded(summarizeRun(run, calls, [], [], { modelOf, ...(prices ? { prices } : {}) })));
          expect(sql.calls).toBe(calls.length);
          expect(sql.origins).toBe(calls.map((c) => ORIGIN_CODE[displayOrigin(c.origin, c.end ? { outcome: c.end.outcome, injected: c.end.meta.injected } : null)]).join(''));
          expect(sql.models).toEqual(runPageFacts(store, run, calls).models);
        });
      }
    }
  }

  it('places blame’s call among the model calls of its scope as the run page does', () => {
    const r = rnd(5);
    for (let i = 0; i < 12; i++) {
      const scope = pick(r, [null, 'agent', 'other']);
      const run = buildRun(store, 100 + i, {}, 'record');
      const calls = store.getCalls(run.runId);
      const callNo = pick(r, calls).callNo;
      store.updateRunMeta(run.runId, { blame: { at: 1, outcome: 'blamed', callNo, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0, ...(scope ? { scope } : {}) } as NonNullable<RunMeta['blame']> });
      const blamed = store.getRun(run.runId)!;
      const step = runPageFacts(store, blamed, calls).blame?.modelCall ?? null;
      expect(blameStep(store, run.runId, callNo, scope), `run ${i}, call ${callNo}, scope ${scope}`).toEqual(step);
    }
  });
});
