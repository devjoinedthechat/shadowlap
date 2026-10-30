import { describe, expect, it } from 'vitest';
import { compareFork, forkEnd } from '../src/fork-changes.js';
import { storeApiRequest } from '../src/manifest.js';
import { markChange, markKey, markToast } from '../src/run-marks.js';
import { attemptVerdict, failureReason, FAILURE_WORDS, keptAttemptVerdict, lostAround, lostWords } from '../src/run-verdicts.js';
import { Store } from '../src/store.js';
import type { Effect, Origin } from '../src/types.js';

/**
 * What the dashboard and the terminal UI both say of a run, worked out once here: why it failed and
 * in which order, where blame found it lost, how a fork ended and what it did differently, how an
 * attempt came out, and the good/bad key.
 */

describe('why a run failed', () => {
  const check = (ok: boolean, status?: string) => ({ ok, label: 'send_email called 0 times', ...(status ? { status } : {}) });
  it('says its own failed check first, then its exit, the check its outcome names, an interruption, blame', () => {
    expect(failureReason({ status: 'failed', checks: [check(false)], outcome: { kind: 'check-failed', check: 'x' }, blame: {} })).toEqual({ kind: 'check', check: check(false) });
    expect(failureReason({ status: 'failed', checks: [check(true)], outcome: { kind: 'check-failed', check: 'x' } })).toEqual({ kind: 'exit' });
    expect(failureReason({ status: 'crashed', checks: [], outcome: { kind: 'check-failed', check: 'x' } })).toEqual({ kind: 'fix-check', check: 'x' });
    expect(failureReason({ status: 'crashed', checks: [], outcome: { kind: 'check-failed', check: null }, blame: {} })).toEqual({ kind: 'interrupted' });
    expect(failureReason({ status: 'completed', checks: [], blame: { outcome: 'blamed' } })).toEqual({ kind: 'blame' });
    expect(failureReason({ status: 'completed', checks: [check(true)], blame: null })).toBeNull();
    expect(FAILURE_WORDS.exit).toBe('the agent exited with an error');
  });
  it('takes a check that could not be decided for no failure', () => {
    expect(failureReason({ status: 'completed', checks: [check(false, 'inconclusive')] })).toBeNull();
  });
});

describe('where blame found a run lost', () => {
  it('says the call it names, or, where no one call lost the run, the two it was lost gradually around', () => {
    expect(lostWords(5)).toBe('lost at #5');
    expect(lostWords(5, null, 'calls')).toBe('lost at model call #5');
    expect(lostWords(5, undefined, 'title')).toBe('Lost at model call #5');
    const gradual = { from: 5, to: 7, fromStep: 3, toStep: 4, gradual: true };
    expect(lostWords(5, gradual)).toBe('lost gradually around #5 and #7');
    expect(lostWords(5, gradual, 'calls')).toBe('lost gradually around model calls #5 and #7');
    expect(lostWords(5, gradual, 'title')).toBe('Lost gradually around model calls #5 and #7');
    // Pinned to one call, or a range the probes left open, it is said at the call blame names.
    expect(lostWords(5, { from: 5, to: 5 })).toBe('lost at #5');
    expect(lostWords(7, { from: 7, to: 9 })).toBe('lost at #7');
  });

  it('reads a range as gradual only when it is two whole calls in order: a run from a pack can carry anything', () => {
    expect(lostAround({ from: 5, to: 7, fromStep: 3, toStep: 4, gradual: true })).toEqual({ from: 5, to: 7, gradual: true });
    for (const odd of [null, undefined, 'x', [], { from: 5, to: 7 }, { from: 5, to: 7, gradual: 'yes' }, { from: 7, to: 5, gradual: true }, { from: 5, to: 5, gradual: true }, { from: 0, to: 2, gradual: true }, { from: 1.5, to: 3, gradual: true }, { from: '5', to: '7', gradual: true }]) {
      expect(lostAround(odd), JSON.stringify(odd)).toBeNull();
    }
    expect(lostWords(5, { from: 7, to: 5, gradual: true })).toBe('lost at #5');
  });
});

describe('how an attempt came out', () => {
  it('keeps blame and verify verdicts, an unavailable provider neither passing nor failing', () => {
    expect(keptAttemptVerdict({ passed: true })).toBe('passed');
    expect(keptAttemptVerdict({ passed: false, verdict: 'failed' })).toBe('failed');
    expect(keptAttemptVerdict({ passed: false, verdict: 'unavailable' })).toBe('inconclusive');
    expect(keptAttemptVerdict({ passed: true, verdict: 'inconclusive' })).toBe('inconclusive');
  });
  it('is interrupted first, then its kept verdict, then its checks, then its exit', () => {
    const unsure = { ok: false, status: 'inconclusive', label: 'judge "polite" answers yes' };
    expect(attemptVerdict({ status: 'crashed', checks: [] }, 'passed')).toEqual({ verdict: 'interrupted', unsure: null });
    expect(attemptVerdict({ status: 'completed', checks: [], interrupted: true })).toEqual({ verdict: 'interrupted', unsure: null });
    expect(attemptVerdict({ status: 'completed', checks: [{ ok: false, status: 'failed' }] }, 'passed')).toEqual({ verdict: 'passed', unsure: null });
    expect(attemptVerdict({ status: 'completed', checks: [unsure] })).toEqual({ verdict: 'inconclusive', unsure });
    expect(attemptVerdict({ status: 'completed', checks: [{ ok: false, status: 'failed' }, unsure] })).toEqual({ verdict: 'failed', unsure: null });
    expect(attemptVerdict({ status: 'failed', checks: [] })).toEqual({ verdict: 'failed', unsure: null });
    expect(attemptVerdict({ status: 'completed', checks: [] })).toEqual({ verdict: 'passed', unsure: null });
  });
});

describe('the good/bad key', () => {
  it('marks a run good or bad, never both, and a second press takes the mark off', () => {
    expect([markKey('+'), markKey('='), markKey('-'), markKey('x')]).toEqual(['good', 'good', 'bad', null]);
    expect(markChange(['bad', 'refunds'], 'good')).toEqual({ add: ['good'], remove: ['bad'] });
    expect(markChange(['good'], 'good')).toEqual({ add: [], remove: ['good'] });
    expect(markToast('01M5GRX8K4ABCDEF', 'good', true)).toBe('01M5GRX8K4 is good: a fix must not make it worse than its own baseline (--keeps label:good)');
    expect(markToast('01M5GRX8K4ABCDEF', 'bad', false)).toBe('01M5GRX8K4 is no longer marked bad');
  });
});

describe('a fork against its parent', () => {
  type Call = { kind: 'api'; text: string } | { kind: 'tool'; name: string; args: Record<string, unknown>; effect: Effect; origin?: Origin };
  function addRun(store: Store, calls: Call[], o: { parent?: string; divergence?: number } = {}): string {
    const run = store.createRun({ mode: o.parent ? 'replay' : 'record', ...(o.parent ? { parentRunId: o.parent } : {}), command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, startedAt: 1_000 });
    calls.forEach((c, i) => {
      const callNo = i + 1;
      const origin = c.kind === 'tool' && c.origin ? c.origin : o.parent && o.divergence && callNo < o.divergence ? 'replayed' : 'live';
      if (c.kind === 'api') {
        const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `fp${callNo}`, occurrence: 1 };
        const response = { id: `msg_${callNo}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: c.text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
        store.appendCallStart({ runId: run.runId, callNo, ...identity, origin, effect: null, requestRef: storeApiRequest(store, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: `turn ${callNo}` }] }), meta: { provider: 'anthropic' }, at: 1 });
        store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson(response), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic' }, at: 2 });
        return;
      }
      const identity = { kind: 'tool' as const, name: c.name, fingerprint: `tfp${callNo}${c.name}`, occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo, ...identity, origin, effect: c.effect, requestRef: store.putJson({ args: c.args }), meta: {}, at: 1 });
      store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result: { ok: true } }), outcome: origin === 'blocked' ? 'error' : 'ok', meta: {}, at: 2 });
    });
    if (o.divergence) store.setDivergence(run.runId, { type: 'request_changed', callNo: o.divergence, kind: 'api', name: 'POST /v1/messages', replayedBefore: o.divergence - 1 });
    store.endRun(run.runId, 'completed', 5_000);
    return run.runId;
  }

  it('ranks a write first, names each call, and says how each run ended', () => {
    const store = Store.open(':memory:');
    const lookup: Call = { kind: 'tool', name: 'lookup_order', args: { order_id: 'A-1042' }, effect: 'read' };
    const parentId = addRun(store, [{ kind: 'api', text: 'Looking it up.' }, lookup, { kind: 'api', text: 'Refunding.' }, { kind: 'tool', name: 'issue_refund', args: { amount: 240 }, effect: 'write' }, { kind: 'api', text: 'Refunded $240.' }]);
    const forkId = addRun(store, [{ kind: 'api', text: 'Looking it up.' }, lookup, { kind: 'api', text: 'Above the limit.' }, { kind: 'tool', name: 'escalate', args: { reason: 'over $100' }, effect: 'write', origin: 'blocked' }, { kind: 'api', text: 'Escalated.' }], { parent: parentId, divergence: 3 });
    const parent = store.getRun(parentId)!;
    const fork = store.getRun(forkId)!;
    const ended = { parent: forkEnd('completed', { kind: 'check-failed', check: 'issue_refund called 0 times' }), fork: forkEnd('completed', { kind: 'passed', checks: 1 }) };
    const c = compareFork(store, fork, parent, ended)!;
    expect(c.from).toBe(3);
    expect(c.changes[0]).toMatchObject({ rank: 1, tool: 'issue_refund', parentCallNo: 4, forkCallNo: null });
    expect(c.changes.map((x) => x.kind)).toContain('ended');
    expect(c.changes.find((x) => x.kind === 'ended')).toMatchObject({ rank: 2, detail: 'it does not fail, where its parent did', before: 'failed: issue_refund called 0 times', after: '1 check passed' });
    expect(c.writes).toEqual([{ callNo: 4, tool: 'escalate', args: '{"reason":"over $100"}', fate: 'blocked' }]);
    expect(c.words).toEqual({ parent: 'Refunded $240.', fork: 'Escalated.' });
    expect(c.toolCalls).toEqual({ parent: 1, fork: 1 });
    // The recording is no fork.
    expect(compareFork(store, parent, parent, ended)).toBeNull();
  });

  it('words how a run ended, a running or interrupted one in no tone', () => {
    expect(forkEnd('running', { kind: 'running' })).toEqual({ status: 'running', failed: false, words: 'still running', tone: null });
    expect(forkEnd('crashed', { kind: 'none' })).toEqual({ status: 'crashed', failed: false, words: 'interrupted', tone: null });
    expect(forkEnd('completed', { kind: 'lost', callNo: 7 })).toEqual({ status: 'completed', failed: true, words: 'failed, lost at #7', tone: 'err' });
    expect(forkEnd('completed', { kind: 'lost', callNo: 7, range: { from: 7, to: 9, gradual: true } }).words).toBe('failed, lost gradually around #7 and #9');
    expect(forkEnd('failed', { kind: 'none' })).toEqual({ status: 'failed', failed: false, words: 'exited with an error', tone: null });
    expect(forkEnd('completed', { kind: 'inconclusive', check: 'polite' })).toMatchObject({ words: 'check inconclusive: polite', tone: 'warn' });
  });
});
