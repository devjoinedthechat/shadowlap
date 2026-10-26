import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { AttemptRunner } from '../src/attempts.js';

/**
 * Blame's probes and verify's attempts when the provider can't answer: an attempt the agent failed
 * while its model call ended on 529 is no evidence about the agent. It is retried after the pause the
 * provider asked for, never tallied, and three in a row end the run inconclusive with the provider
 * named, never failed. The mock plays the provider, overloaded for as many requests as a test says.
 */
const dir = mkdtempSync(join(tmpdir(), 'sl-attempt-unavailable-'));
let mock: MockServer;
/** Requests the mock answers 529 before it answers again, and the status it answers then. */
let overloaded = 0;
let then = 200;
/** Second requests of an attempt (after the model answered its first) the mock answers 529. */
let lateOverloaded = 0;
const OVERLOADED = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

beforeAll(async () => {
  mock = await startMockAnthropic({
    script: (ctx) => {
      if (lateOverloaded > 0 && JSON.stringify(ctx.request.messages ?? '').includes('again')) {
        lateOverloaded--;
        return { status: 529, body: OVERLOADED, headers: { 'retry-after': '0' } };
      }
      if (overloaded > 0) {
        overloaded--;
        return { status: 529, body: OVERLOADED, headers: { 'retry-after': '0' } };
      }
      if (then !== 200) return { status: then, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } } };
      return { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
    },
  });
});
afterAll(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** An agent that asks the model once and exits 0 when it answered, else 1 (or 0 when told to recover). */
const agent = (recover = false) =>
  `fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }) }).then((r) => process.exit(r.ok || ${recover} ? 0 : 1), () => process.exit(${recover} ? 0 : 1))`;

/** An agent that asks the model twice, the second time once the first was answered: exits 0 when both were. */
const twice = `const ask = (content) => fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 10, messages: [{ role: 'user', content }] }) });
ask('hi').then((r) => (r.ok ? ask('again').then((s) => process.exit(s.ok ? 0 : 1)) : process.exit(1)), () => process.exit(1));`;

async function runner(name: string) {
  const db = join(dir, `${name}.db`);
  const setup = Store.open(db);
  // A recording with no calls: every call of a replay is live, against the mock.
  const parent = setup.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: dir } });
  setup.endRun(parent.runId, 'failed');
  const recorded = setup.getRun(parent.runId)!;
  setup.close();
  const r = await AttemptRunner.start({ db }, { writes: 'block', reads: 'replay', liveTools: [], spec: null, budget: null, timeoutMs: 30_000, guard: 'off', upstreams: { anthropic: mock.url } });
  const waits: number[] = [];
  r.sleep = async (ms) => {
    waits.push(ms);
  };
  return { r, recorded, waits };
}

describe('an attempt of blame or verify while the provider is unavailable', () => {
  it('is retried after the pause the provider asked for, and only the attempt that got an answer is tallied', async () => {
    const { r, recorded, waits } = await runner('retried');
    overloaded = 2;
    then = 200;
    try {
      const a = await r.attempt({ parent: recorded, argv: [process.execPath, '-e', agent()], commandFromImport: false }, { meta: { verify: { role: 'target', passed: false } } });
      expect(a.passed, a.failures.join('; ')).toBe(true);
      expect(a.verdict).toBe('passed');
      expect(a.unavailable).toBeUndefined();
      expect(r.attempts).toBe(1);
      expect(r.unavailable).toBe(2);
      // The attempt says how many it was run in place of, so a run's or a probe's report can count them.
      expect(a.unavailableBefore).toBe(2);
      // retry-after: 0, honoured.
      expect(waits).toEqual([0, 0]);
      expect(r.stopReason).toBeNull();
      // The two runs the provider was unavailable for say so, and never read as attempts that failed.
      const unavailable = r.store.listRuns(10).filter((x) => x.meta?.verify?.verdict === 'unavailable');
      expect(unavailable).toHaveLength(2);
      // And `show` says so of each, never that it failed.
      const shown = execFileSync(process.execPath, [CLI, '--db', join(dir, 'retried.db'), 'show', unavailable[0].runId], { env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0' } }).toString();
      expect(shown).toContain('an attempt of shadowlap verify, replaying a failing run: not counted, the provider was unavailable');
    } finally {
      await r.close();
    }
  }, 60_000);

  it('is inconclusive after three in a row, with the provider named, and nothing more starts', async () => {
    const { r, recorded, waits } = await runner('gave-up');
    overloaded = 100;
    try {
      const a = await r.attempt({ parent: recorded, argv: [process.execPath, '-e', agent()], commandFromImport: false });
      expect(a.passed).toBe(false);
      expect(a.verdict).toBe('inconclusive');
      expect(a.unavailable).toMatchObject({ status: 529, provider: 'anthropic' });
      expect(a.failures[0]).toMatch(/^provider unavailable: 3 attempts in a row ended on HTTP 529 from anthropic at call #1, so none of them says anything about the agent/);
      expect(r.attempts).toBe(0);
      expect(r.unavailable).toBe(3);
      // Two before it, and itself: three for the report to count.
      expect(a.unavailableBefore).toBe(2);
      expect(waits).toHaveLength(2);
      expect(r.stopReason).toBe(a.failures[0]);
      expect(r.canStart()).toBe(false);
    } finally {
      overloaded = 0;
      await r.close();
    }
  }, 60_000);

  it('counts a failure of the agent\'s own, and a request the provider refused, as failures', async () => {
    const { r, recorded, waits } = await runner('own');
    try {
      // The provider answered 400: the agent sent something it refuses, which is the agent's to fix.
      then = 400;
      const refused = await r.attempt({ parent: recorded, argv: [process.execPath, '-e', agent()], commandFromImport: false });
      expect(refused.verdict).toBe('failed');
      expect(refused.unavailable).toBeUndefined();
      then = 200;
      const own = await r.attempt({ parent: recorded, argv: [process.execPath, '-e', 'process.exit(3)'], commandFromImport: false });
      expect(own.verdict).toBe('failed');
      expect(own.unavailableBefore).toBeUndefined();
      expect(r.attempts).toBe(2);
      expect(r.unavailable).toBe(0);
      expect(waits).toEqual([]);
    } finally {
      then = 200;
      await r.close();
    }
  }, 60_000);

  it('returns an attempt the provider cut short after the model answered to a gate that counts it, and runs it again for one that does not', async () => {
    const { r, recorded, waits } = await runner('cut-short');
    const target = { parent: recorded, argv: [process.execPath, '-e', twice], commandFromImport: false };
    try {
      // Counted: returned cut short after the pause, tallied, never run again.
      lateOverloaded = 1;
      const counted = await r.attempt(target, {}, true, { late: 'count' });
      expect(counted).toMatchObject({ passed: false, verdict: 'inconclusive', cutShort: true, unavailable: { status: 529, early: false } });
      expect(counted.unavailableBefore).toBeUndefined();
      expect([r.attempts, r.cutShort, r.unavailable]).toEqual([1, 1, 0]);
      expect(waits).toEqual([0]);
      // Not counted (a fixed count): run again, never tallied, as one the provider failed before the model answered.
      lateOverloaded = 1;
      const retried = await r.attempt(target, {}, true, { late: 'retry' });
      expect(retried).toMatchObject({ passed: true, unavailableBefore: 1 });
      expect(retried.cutShort).toBeUndefined();
      expect([r.attempts, r.cutShort, r.unavailable]).toEqual([2, 1, 1]);
      // An error before the model answered is run again even for a gate that counts the rest.
      overloaded = 1;
      const early = await r.attempt(target, {}, true, { late: 'count' });
      expect(early).toMatchObject({ passed: true, unavailableBefore: 1 });
      expect([r.attempts, r.cutShort, r.unavailable]).toEqual([3, 1, 2]);
    } finally {
      overloaded = 0;
      lateOverloaded = 0;
      await r.close();
    }
  }, 60_000);

  it('counts three unavailable in a row across attempts, a counted one included, and keeps one a caller says to keep', async () => {
    const { r, recorded } = await runner('in-a-row');
    const target = { parent: recorded, argv: [process.execPath, '-e', twice], commandFromImport: false };
    try {
      lateOverloaded = 1;
      expect((await r.attempt(target, {}, true, { late: 'count' })).cutShort).toBe(true);
      // Two more in a row, the first before the model answered: the third stops the runner.
      overloaded = 1;
      lateOverloaded = 1;
      const stopped = await r.attempt(target, {}, true, { late: 'count' });
      expect(stopped.cutShort).toBeUndefined();
      expect(stopped.failures[0]).toMatch(/^provider unavailable: 3 attempts in a row ended on HTTP 529/);
      expect(r.canStart()).toBe(false);
    } finally {
      overloaded = 0;
      lateOverloaded = 0;
      await r.close();
    }
    const kept = await runner('kept');
    try {
      lateOverloaded = 1;
      const a = await kept.r.attempt({ parent: kept.recorded, argv: [process.execPath, '-e', twice], commandFromImport: false }, {}, true, { keep: (x) => x.unavailable?.early === false });
      // Returned as it is, after the pause, for its caller to judge: never run again, and not counted cut short.
      expect(a).toMatchObject({ passed: false, unavailable: { early: false } });
      expect(a.cutShort).toBeUndefined();
      expect([kept.r.attempts, kept.r.cutShort, kept.r.unavailable]).toEqual([0, 0, 1]);
    } finally {
      lateOverloaded = 0;
      await kept.r.close();
    }
  }, 60_000);

  it('passes an agent that got a 529 and recovered from it', async () => {
    const { r, recorded } = await runner('recovered');
    overloaded = 1;
    try {
      const a = await r.attempt({ parent: recorded, argv: [process.execPath, '-e', agent(true)], commandFromImport: false });
      expect(a.verdict).toBe('passed');
      expect(r.unavailable).toBe(0);
      expect(r.attempts).toBe(1);
    } finally {
      overloaded = 0;
      await r.close();
    }
  }, 60_000);
});
