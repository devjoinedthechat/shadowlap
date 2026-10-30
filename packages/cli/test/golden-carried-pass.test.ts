import { describe, expect, it, vi } from 'vitest';

/**
 * A gate continued from an inconclusive session (`test --continue`) whose carried attempts already
 * pass it this session, while every attempt of this session's own fails: testRecording shows one of
 * its own attempts and its result is whole, so filing the attempts under it (fileUnder) and the JSON
 * report (packResult) never meet a result with nothing to show. Its attempts are seeded fakes of
 * testAttempt: a check that fails, and now and then the provider unavailable before the model
 * answered, which is run again and never counted.
 */

type Kind = 'fail' | 'early';
let script: Kind[] = [];
let used = 0;
let made = 0;
const calls = new Map<string, unknown[]>();

/** mulberry32 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The next attempt of the script: its run's calls kept where the provider check reads them. */
function fakeAttempt(): unknown {
  const kind = script[used++] ?? 'fail';
  const runId = `R${String(++made).padStart(4, '0')}`;
  const api = (end: unknown) => ({ kind: 'api', origin: 'live', callNo: 3, meta: { provider: 'anthropic' }, end });
  calls.set(runId, [kind === 'early' ? api({ outcome: 'error', at: 1, meta: { status: 529, provider: 'anthropic', headers: {} } }) : api({ outcome: 'ok', at: 1, meta: {} })]);
  const summary = { runId, divergence: { callNo: 3, type: 'diverged', kind: 'api', name: 'POST /v1/messages' }, total: 3, byOrigin: { replayed: 2, overridden: 0, live: 1, blocked: 0, stubbed: 0 }, status: 'failed', upstreamRequests: 1, cost: { spent: 0, unknownModels: [] }, tokensNotRespent: { inputTokens: 0, outputTokens: 0 }, warnings: [] };
  const failure = kind === 'early' ? { message: 'the agent exited with code 1', details: 'd' } : { message: 'check failed: send_email called 0 times', details: `d-${runId}` };
  const checks = kind === 'early' ? [] : [{ ok: false, label: 'send_email', status: 'failed', detail: '0' }];
  return { ended: { summary }, code: 1, ms: 1, output: '', stdout: '', checks, failure, kind: kind === 'early' ? 'exit' : 'check', interrupted: null };
}

vi.mock('../src/run-agent.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), testAttempt: vi.fn(() => Promise.resolve(fakeAttempt())) }));

const { packResult, testRecording } = await import('../src/golden-test.js');

/** A run with its carried attempts past the gate's pass bound: 20 passed of 20. */
async function continued(seed: number) {
  // Seeded: how many attempts the provider is unavailable for before this session's first that counts.
  const random = seeded(seed);
  const early = Math.floor(random() * 3);
  script = [...Array.from({ length: early }, (): Kind => 'early'), ...Array.from({ length: 10 }, (): Kind => 'fail')];
  used = 0;
  calls.clear();
  const filed: string[] = [];
  const store = { getCalls: (id: string) => calls.get(id) ?? [], updateRunMeta: (id: string, patch: { test?: { of?: string } }) => filed.push(`${id} under ${patch.test?.of ?? '-'}`) };
  const ctx = {
    store,
    config: { normalize: [], prices: undefined, clock: undefined, http: undefined },
    cwd: '/tmp',
    writes: 'stub',
    guard: 'warn',
    online: false,
    test: { golden: 'goldens/g', session: 'S1' },
    argv: ['node', 'agent.js'],
    carry: { sessions: ['S0'], outcomes: Array.from({ length: 20 }, () => true) },
    unavailable: { inARow: 5, firstDelayMs: 0, maxDelayMs: 0 },
    sleep: () => Promise.resolve(),
  };
  const spec = { fork: true, gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 } };
  const outcome = await testRecording({ runId: 'PARENT', meta: {} } as never, spec as never, ctx as never);
  return { outcome, early, filed };
}

describe('a gate its carried attempts pass, every attempt of this session failing', () => {
  it('shows the last attempt this session ran, files the others under it, and reports a whole result', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { outcome, early, filed } = await continued(seed);
      expect(outcome.verdict, `seed ${seed}`).toBe('passed');
      // Passed on the 20 carried over and this session's one failure.
      expect(outcome.gate).toMatchObject({ decision: 'pass', passes: 20, attempts: 21, carried: 20 });
      expect(outcome.attempts).toHaveLength(early + 1);
      // Nothing of this session's passed: it shows the last attempt it ran, which counted.
      expect(outcome.shown, `seed ${seed}`).toBe(outcome.attempts.at(-1));
      // Each attempt filed under the one it shows, that one at the head.
      const head = outcome.shown.ended.summary.runId;
      if (early) expect(filed, `seed ${seed}`).toEqual(outcome.attempts.map((a) => `${a.ended.summary.runId} under ${a.ended.summary.runId === head ? '-' : head}`));
      const golden = { name: 'g', dir: 'goldens/g', golden: 'goldens/g', spec: null, result: outcome, failure: null, kind: null, seconds: 1, notes: [] };
      const reported = packResult(golden as never, { expect: null });
      expect(reported).toMatchObject({ ok: true, verdict: 'passed', runId: outcome.shown.ended.summary.runId });
    }
  });
});
