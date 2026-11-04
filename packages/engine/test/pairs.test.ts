import { describe, expect, it, vi } from 'vitest';
import { contextLine, countPairs, findPairs, pairRows } from '../src/pairs.js';
import { normalizeConversation } from '../src/conversation.js';
import { sha256 } from '../src/ids.js';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { Store } from '../src/store.js';
import type { RunMeta, RunRecord, RunStatus } from '../src/types.js';
import { cpuOnce, times, timesOf } from './timing.js';
import { DONE, ESCALATE, ESCALATE_2, LOOKUP, POLICY, REFUND, recordRun, testRunId, type Step } from './training-fixtures.js';

/**
 * Preference pairs from attempts already in the store. The support agent's run turns on its third
 * model call (#5): refunding $240 loses it, escalating passes. Blame, verify and --repeat each leave
 * attempts that answered #5 one way or the other.
 */

const LOST = [LOOKUP, POLICY, REFUND, DONE];
const SAVED = [LOOKUP, POLICY, ESCALATE, DONE];

function blamed(store: Store) {
  const { run } = recordRun(store, LOST, { status: 'failed', meta: { labels: ['refund-bug'] } });
  store.updateRunMeta(run.runId, { blame: { at: 2_000, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: ['the agent exits 0', 'issue_refund called 0 times'], probes: [{ callNo: 5, passes: 4, attempts: 5, rescued: true }], spent: 0.02 } });
  const probe = (steps: Step[], passed: boolean) => recordRun(store, steps, { parentRunId: run.runId, status: 'completed', meta: { probe: { of: run.runId, callNo: 5, passed }, repeat: { group: 'b1-5', attempt: 1, of: 5 } } }).run;
  const attempts = [probe(SAVED, true), probe(SAVED, true), probe(LOST, true), probe([LOOKUP, POLICY, ESCALATE_2, DONE], true), probe(LOST, false)];
  return { run, attempts };
}

describe('pairs from blame', () => {
  it('pairs each passing answer at the blamed call with the recorded one, counting identical answers once', () => {
    const store = Store.open(':memory:');
    const { run, attempts } = blamed(store);
    const { pairs, sources } = findPairs(store);
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.confidence === 'high' && p.callNo === 5 && p.aboutCallNo === 5 && p.runId === run.runId && p.sourceKind === 'blame')).toBe(true);
    expect(pairs[0]).toMatchObject({
      rejected: { runId: run.runId, callNo: 5, what: 'the recording', text: '"Issuing the refund.", issue_refund({"order_id":"A-1042","amount":240})' },
      chosen: { runId: attempts[0].runId, callNo: 5, what: 'blame attempt, passed', text: '"Above the limit.", escalate({"reason":"refund of $240 is above $100"})' },
      model: 'claude-sonnet-5',
    });
    expect(pairs[1].chosen.text).toContain('above the refund limit');
    expect(pairs[0].id).toMatch(/^pr-[0-9a-f]{12}$/);
    expect(pairs[0].context).toBe('The customer asks for a refund on order A-1042. · read_policy returned text: Refunds above $100 need a manager: escalate them.');
    expect(sources).toEqual([
      expect.objectContaining({ key: `blame:${run.runId}`, kind: 'blame', label: 'blame · refund-bug', made: 2, attempts: 5, callNo: 5, confidence: 'high' }),
    ]);
    expect(sources[0].why).toBe('Probe #5 rescued the run: 3 attempts passed after a different answer at #5. One answered like another, so it counts once. 1 attempt that passed answered as the recording did.');
    // The same store read twice makes the same pairs.
    expect(findPairs(store).pairs.map((p) => p.id)).toEqual(pairs.map((p) => p.id));
    store.close();
  });

  it('lists a blame that made no pairs, and why', () => {
    const store = Store.open(':memory:');
    const { run } = recordRun(store, LOST, { status: 'failed' });
    store.updateRunMeta(run.runId, { blame: { at: 1, outcome: 'unrescuable', callNo: null, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
    const other = recordRun(store, LOST, { status: 'failed' }).run;
    store.updateRunMeta(other.runId, { blame: { at: 2, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
    const { pairs, sources } = findPairs(store);
    expect(pairs).toEqual([]);
    expect(sources.map((s) => [s.label.startsWith('blame · '), s.made, s.why])).toEqual([
      [true, 0, 'No attempt that passed at #5 is in the store any more.'],
      [true, 0, 'Not rescued from any model call: no other answer made the run pass, so there is none to prefer.'],
    ]);
    // One whose first probe couldn't tell is inconclusive, never a finding that no answer passes.
    store.updateRunMeta(run.runId, { blame: { at: 1, outcome: 'unrescuable', unsettled: true, callNo: null, confidence: 'low', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
    expect(findPairs(store).sources.find((s) => s.runId === run.runId)?.why).toBe('Inconclusive at the first model call: blame could not tell whether another answer makes the run pass, so there is none to prefer yet.');
    store.close();
  });

  it('tells apart blames of runs labelled alike by their ids', () => {
    const store = Store.open(':memory:');
    const first = blamed(store).run;
    const second = blamed(store).run;
    const labels = findPairs(store)
      .sources.filter((s) => s.kind === 'blame')
      .map((s) => [s.runId, s.label]);
    expect(new Map(labels as Array<[string, string]>)).toEqual(
      new Map([
        [first.runId, `blame · refund-bug · ${first.runId.slice(0, 10)}`],
        [second.runId, `blame · refund-bug · ${second.runId.slice(0, 10)}`],
      ]),
    );
    store.close();
  });
});

describe('pairs from verify and --repeat', () => {
  it('pairs a failing attempt with a passing one at the first model call where their answers differ', () => {
    const store = Store.open(':memory:');
    const target = recordRun(store, LOST, { status: 'failed' }).run;
    const attempt = (steps: Step[], passed: boolean, n: number) => recordRun(store, steps, { parentRunId: target.runId, status: passed ? 'completed' : 'failed', codeVersion: '370712a+dirty', meta: { verify: { role: 'target', passed }, repeat: { group: `v1-${target.runId}`, attempt: n, of: 3 } } }).run;
    const failed = attempt(LOST, false, 1);
    const passed = attempt(SAVED, true, 2);
    // Parts from the failing attempt at its first call, where another attempt answered as the failing one did and passed.
    attempt([{ text: 'Let me check.', tools: LOOKUP.tools! }, POLICY, ESCALATE, DONE], true, 3);
    // A second verify where every attempt passed makes nothing.
    const good = recordRun(store, SAVED).run;
    recordRun(store, SAVED, { parentRunId: good.runId, codeVersion: 'b7e40c2', meta: { verify: { role: 'good', passed: true }, repeat: { group: `v2-${good.runId}`, attempt: 1, of: 1 } } });

    const { pairs, sources } = findPairs(store);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ confidence: 'medium', sourceKind: 'verify', runId: target.runId, callNo: 5, aboutCallNo: 5, rejected: { runId: failed.runId, what: 'verify attempt, failed' }, chosen: { runId: passed.runId, what: 'verify attempt, passed' } });
    const verify = sources.filter((s) => s.kind === 'verify');
    expect(verify.map((s) => [s.label, s.made])).toEqual([
      ['verify · b7e40c2', 0],
      ['verify · 370712a+dirty', 1],
    ]);
    expect(verify[0].why).toBe('No run both passed and failed: each passed every attempt or none.');
    expect(verify[1].why).toContain(`Target ${target.runId.slice(0, 10)} failed 1 of 3.`);
    expect(verify[1].why).toContain('1 answer left out: the same answer, from the same point, also passed (or failed) elsewhere.');
    expect(countPairs(pairs)).toEqual({ all: 1, high: 0, medium: 1 });
    store.close();
  });

  it('never takes an attempt verify could not judge for a failing one: it pairs nothing, and is counted apart', () => {
    const store = Store.open(':memory:');
    const target = recordRun(store, LOST, { status: 'failed' }).run;
    const attempt = (steps: Step[], verify: NonNullable<RunMeta['verify']>, n: number) => recordRun(store, steps, { parentRunId: target.runId, codeVersion: '370712a+dirty', meta: { verify, repeat: { group: `v1-${target.runId}`, attempt: n, of: 3 } } }).run;
    const passed = attempt(SAVED, { role: 'target', passed: true, verdict: 'passed' }, 1);
    // All it fell short on is a judge that could not answer: it answered as a failing attempt does, but failed nothing.
    attempt(LOST, { role: 'target', passed: false, verdict: 'inconclusive' }, 2);
    const unjudged = findPairs(store);
    expect(unjudged.pairs).toEqual([]);
    expect(unjudged.sources.find((s) => s.kind === 'verify')!.why).toBe('No run both passed and failed: each passed every attempt it was judged in or none, and 1 attempt could not be judged.');
    // An attempt that did fail makes the pair, and the source line counts the other apart.
    const failed = attempt(LOST, { role: 'target', passed: false, verdict: 'failed' }, 3);
    const { pairs, sources } = findPairs(store);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ rejected: { runId: failed.runId, what: 'verify attempt, failed' }, chosen: { runId: passed.runId, what: 'verify attempt, passed' } });
    expect(sources.find((s) => s.kind === 'verify')!.why).toContain(`Target ${target.runId.slice(0, 10)} failed 1 of 3, 1 inconclusive.`);
    store.close();
  });

  it('never takes an attempt its provider was unavailable for as a failing one: the agent failed nothing there', () => {
    const store = Store.open(':memory:');
    const target = recordRun(store, LOST, { status: 'failed' }).run;
    const attempt = (steps: Step[], verify: NonNullable<RunMeta['verify']>, n: number) => recordRun(store, steps, { parentRunId: target.runId, codeVersion: '370712a+dirty', meta: { verify, repeat: { group: `v1-${target.runId}`, attempt: n, of: 2 } } }).run;
    attempt(SAVED, { role: 'target', passed: true, verdict: 'passed' }, 1);
    // A 529 stopped it: as the run records it, it went the way a failing attempt goes.
    attempt(LOST, { role: 'target', passed: false, verdict: 'unavailable' }, 2);
    const { pairs, sources } = findPairs(store);
    expect(pairs).toEqual([]);
    expect(sources.find((s) => s.kind === 'verify')!.why).toBe('No run both passed and failed: each passed every attempt it was judged in or none, and 1 attempt could not be judged.');
    store.close();
  });

  it('finds the call a verify pair is about in the run it replayed, at the same point of the same path, and none when that run never got there', () => {
    const store = Store.open(':memory:');
    // Each recording is its own order, so no pair is another's; its verify's attempts are asked about that order too.
    const verify = (target: RunRecord, user: string, group: string, steps: Step[], passed: boolean, n: number, o: { system?: string } = {}) =>
      recordRun(store, steps, { parentRunId: target.runId, status: passed ? 'completed' : 'failed', codeVersion: group, user, ...o, meta: { verify: { role: 'target', passed }, repeat: { group: `${group}-${target.runId}`, attempt: n, of: 2 } } }).run;
    // The change verified is the prompt: no request is the recording's, but the attempts decide where it did, at #5.
    const prompt = recordRun(store, LOST, { status: 'failed', user: 'Refund order A-2000.' }).run;
    const system = 'You are a support agent. Escalate every refund above the limit the policy sets.';
    verify(prompt, 'Refund order A-2000.', 'v1', LOST, false, 1, { system });
    verify(prompt, 'Refund order A-2000.', 'v1', SAVED, true, 2, { system });
    // Recorded with a model list first, which the change verified dropped: the same decision is #6 there and #5 in the attempts.
    const listed = recordRun(store, LOST, { status: 'failed', user: 'Refund order A-2001.', before: [{ name: 'GET /v1/models', kind: 'api', result: { data: [] } }] }).run;
    verify(listed, 'Refund order A-2001.', 'v2', LOST, false, 1);
    verify(listed, 'Refund order A-2001.', 'v2', SAVED, true, 2);
    // The change verified reads a template before deciding: the attempts decide at #7, after a call the recording never made.
    const TEMPLATE: Step = { tools: [{ name: 'get_template', input: { kind: 'refund' } }] };
    const plain = recordRun(store, LOST, { status: 'failed', user: 'Refund order A-2002.' }).run;
    const failing = verify(plain, 'Refund order A-2002.', 'v3', [LOOKUP, POLICY, TEMPLATE, REFUND, DONE], false, 1);
    verify(plain, 'Refund order A-2002.', 'v3', [LOOKUP, POLICY, TEMPLATE, ESCALATE, DONE], true, 2);

    const { pairs } = findPairs(store);
    const about = (runId: string) => pairs.find((p) => p.runId === runId);
    expect(pairs).toHaveLength(3);
    expect(about(prompt.runId)).toMatchObject({ callNo: 5, aboutCallNo: 5 });
    expect(about(listed.runId)).toMatchObject({ callNo: 5, aboutCallNo: 6 });
    // The pair is still the attempts' own: their conversation at #7, with the template it read.
    expect(about(plain.runId)).toMatchObject({ callNo: 7, aboutCallNo: null, rejected: { runId: failing.runId, callNo: 7 }, context: expect.stringContaining('get_template returned') });
    store.close();
  });

  it('names verify sources by the code they verified, and tells apart two of the same code', () => {
    const store = Store.open(':memory:');
    const target = recordRun(store, LOST, { status: 'failed' }).run;
    const verify = (group: string, codeVersion: string | null, startedAt: number) =>
      recordRun(store, SAVED, { parentRunId: target.runId, codeVersion, startedAt, meta: { verify: { role: 'target', passed: true }, repeat: { group: `${group}-${target.runId}`, attempt: 1, of: 1 } } });
    const at = new Date(2026, 9, 15, 13, 7, 5).getTime();
    verify('v1', '370712a+dirty', at);
    verify('v2', '370712a+dirty', at + 42_000);
    verify('v3', 'b7e40c2', at + 60_000);
    // No code version: named by when it ran, on this machine's clock, and told apart by the second.
    verify('v4', null, at + 120_000);
    verify('v5', null, at + 125_000);
    verify('v6', null, at + 125_000);
    const labels = findPairs(store).sources.filter((s) => s.kind === 'verify').map((s) => s.label).sort();
    expect(labels).toEqual([
      'verify · 2026-10-15 13:09:05',
      'verify · 2026-10-15 13:09:10',
      'verify · 2026-10-15 13:09:10 (2)',
      'verify · 370712a+dirty · 13:07:05',
      'verify · 370712a+dirty · 13:07:47',
      'verify · b7e40c2',
    ]);
    store.close();
  });

  it('names a repair\'s verifies by the candidate each checked, from its verdict or the repair\'s report', () => {
    const store = Store.open(':memory:');
    const target = recordRun(store, LOST, { status: 'failed' }).run;
    const at = new Date(2026, 9, 15, 14, 28, 31).getTime();
    // A repair verifies each candidate in the working tree: one revision, a second apart.
    const verify = (group: string, startedAt: number, passed: boolean) =>
      recordRun(store, passed ? SAVED : LOST, { parentRunId: target.runId, status: passed ? 'completed' : 'failed', codeVersion: '3d26a2f+dirty', startedAt, meta: { verify: { role: 'target', passed }, repeat: { group: `${group}-${target.runId}`, attempt: 1, of: 1 } } }).run;
    const turnedDown = verify('c2', at, false);
    const accepted = verify('c3', at + 1_000, true);
    const report = (runId: string, passed: boolean) => ({ verdict: passed ? 'accepted' : 'rejected', runs: [{ runId: target.runId, role: 'target', attempts: [{ runId, passed }] }] });
    // Candidate 2 was turned down (only the repair's report names it); candidate 3 was kept, with a verdict of its own.
    store.putRepair({ repairId: 'repair-1', at: at + 5_000, dir: '.shadowlap/repairs/repair-1', outcome: 'fixed', accepted: true, report: { candidates: [{ id: 2, verify: report(turnedDown.runId, false) }, { id: 3, verify: report(accepted.runId, true) }] } as never, expect: null, command: 'shadowlap repair' });
    store.putVerdict({ verifyId: 'vf-1', at: at + 5_000, verdict: 'accepted', repairId: 'repair-1', candidate: 3, report: report(accepted.runId, true) as never, expect: null, command: 'shadowlap repair' });
    // A verify of the working tree at the same revision keeps its name.
    verify('v9', at + 60_000, true);
    const labels = findPairs(store).sources.filter((s) => s.kind === 'verify').map((s) => [s.label, s.candidate ?? null]);
    expect(labels.sort()).toEqual([
      ['verify · 3d26a2f+dirty', null],
      ['verify · repair candidate 2', 2],
      ['verify · repair candidate 3', 3],
    ]);
    // Candidate 2 of a second repair is told apart by when it ran.
    const again = verify('c2b', at + 120_000, false);
    store.putRepair({ repairId: 'repair-2', at: at + 125_000, dir: '.shadowlap/repairs/repair-2', outcome: 'not-fixed', accepted: false, report: { candidates: [{ id: 2, verify: report(again.runId, false) }] } as never, expect: null, command: 'shadowlap repair' });
    expect(findPairs(store).sources.filter((s) => s.candidate === 2).map((s) => s.label).sort()).toEqual(['verify · repair candidate 2 · 14:28:31', 'verify · repair candidate 2 · 14:30:31']);
    store.close();
  });

  it('pairs --repeat attempts by exit status, and leaves out those whose paths parted before their answers', () => {
    const store = Store.open(':memory:');
    const rec = recordRun(store, SAVED).run;
    const repeat = (group: string, steps: Step[], status: 'completed' | 'failed' | 'crashed', n: number, results?: (name: string, input: Record<string, unknown>) => unknown) =>
      recordRun(store, steps, { parentRunId: rec.runId, status, meta: { repeat: { group, attempt: n, of: 3 } }, ...(results ? { results } : {}) }).run;
    repeat('r1', SAVED, 'completed', 1);
    const lost = repeat('r1', LOST, 'failed', 2);
    repeat('r1', LOST, 'crashed', 3);
    repeat('r2', SAVED, 'completed', 1);
    repeat('r2', SAVED, 'completed', 2);
    repeat('r3', SAVED, 'completed', 1);
    repeat('r3', LOST, 'failed', 2, (name, input) => (name === 'lookup_order' ? { order_id: input.order_id, amount: 80 } : { text: 'Refunds above $100 need a manager: escalate them.' }));

    const { pairs, sources } = findPairs(store);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ confidence: 'medium', sourceKind: 'repeat', callNo: 5, rejected: { runId: lost.runId, what: 'attempt, exited with an error' }, chosen: { what: 'attempt, exited 0' } });
    const bySource = Object.fromEntries(sources.map((s) => [s.key, s]));
    expect(bySource['repeat:r1']).toMatchObject({ made: 1, label: `replay --repeat 3 · ${rec.runId.slice(0, 10)}`, attempts: 3 });
    expect(bySource['repeat:r2']).toMatchObject({ made: 0, why: 'All 2 attempts exited 0, so there is nothing to contrast.' });
    expect(bySource['repeat:r3'].made).toBe(0);
    expect(bySource['repeat:r3'].why).toContain('saw different conversations before their answers differed');
    store.close();
  });

  it('counts a pair once when blame and verify both found it, and keeps it high', () => {
    const store = Store.open(':memory:');
    const { run, attempts } = blamed(store);
    // Verifying a fix replays the blamed run: one attempt refunds as the recording did, one escalates as a probe did.
    const attempt = (steps: Step[], passed: boolean, n: number) => recordRun(store, steps, { parentRunId: run.runId, status: passed ? 'completed' : 'failed', codeVersion: 'c91d0f4', meta: { verify: { role: 'target', passed }, repeat: { group: `v9-${run.runId}`, attempt: n, of: 3 } } }).run;
    attempt(LOST, false, 1);
    attempt(SAVED, true, 2);
    const novel = attempt([LOOKUP, POLICY, { text: 'This needs a manager.', tools: [{ name: 'escalate', input: { reason: 'over the limit' } }] }, DONE], true, 3);

    const { pairs, sources } = findPairs(store);
    expect(pairs.map((p) => [p.confidence, p.chosen.runId])).toEqual([
      ['high', attempts[0].runId],
      ['high', attempts[3].runId],
      ['medium', novel.runId],
    ]);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(3);
    const verify = sources.find((s) => s.kind === 'verify')!;
    expect(verify.made).toBe(1);
    expect(verify.why).toContain('One pair was already made by another source, so it counts once.');
    store.close();
  });

  it('never takes blame, verify, test or scoring attempts for --repeat ones', () => {
    const store = Store.open(':memory:');
    const rec = recordRun(store, SAVED).run;
    const task = (attempt: number, score: number | null, stopped?: string): NonNullable<RunMeta['task']> => ({ golden: 'goldens/a', model: 'm', takeover: 5, attempt, of: 2, score, session: 'score-1', ...(stopped ? { stopped } : {}) });
    // Every kind of attempt carries a repeat group of its own, failing and passing alike.
    const marks: Array<[string, (passed: boolean) => RunMeta]> = [
      ['probe', (passed) => ({ probe: { of: 'elsewhere', callNo: 5, passed } })],
      ['verify', (passed) => ({ verify: { role: 'target', passed } })],
      ['test', () => ({ test: { golden: 'goldens/a', session: 't-1' } })],
      ['task', (passed) => ({ task: task(passed ? 2 : 1, passed ? 1 : 0) })],
    ];
    for (const [group, mark] of marks) {
      recordRun(store, LOST, { parentRunId: rec.runId, status: 'failed', meta: { repeat: { group, attempt: 1, of: 2 }, ...mark(false) } });
      recordRun(store, SAVED, { parentRunId: rec.runId, meta: { repeat: { group, attempt: 2, of: 2 }, ...mark(true) } });
    }
    // A scoring attempt that stopped (the endpoint was down, the golden forked first) has no score, and is a scoring attempt all the same.
    recordRun(store, LOST, { parentRunId: rec.runId, status: 'failed', meta: { repeat: { group: 'score-1-a', attempt: 1, of: 2 }, task: task(1, null, "my-finetune didn't answer #5") } });
    recordRun(store, SAVED, { parentRunId: rec.runId, meta: { repeat: { group: 'score-1-a', attempt: 2, of: 2 }, task: task(2, 1) } });
    const { pairs, sources } = findPairs(store);
    // Verify's attempts make verify's pairs; none of them, and nothing else, is read as a --repeat.
    expect(sources.map((s) => s.kind)).toEqual(['verify']);
    expect(pairs.map((p) => p.sourceKind)).toEqual(['verify']);
    store.close();
  });
});

describe('context lines', () => {
  it('say what was asked and the last thing the model saw', () => {
    const turns = normalizeConversation({ system: 's', messages: [{ role: 'user', content: 'Summarize the Q3 filing.' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'F-2291, 10-Q, filed 2026-09-29' }] }] })!.turns;
    expect(contextLine(turns)).toBe('Summarize the Q3 filing. · search returned F-2291, 10-Q, filed 2026-09-29');
    const chat = normalizeConversation({ system: 's', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Refund my order, please' }] })!.turns;
    expect(contextLine(chat)).toBe('Hi · then: Refund my order, please');
    expect(contextLine(normalizeConversation({ system: 's', messages: [{ role: 'user', content: 'x'.repeat(300) }] })!.turns)).toHaveLength(140);
  });

  it('read a JSON object a tool returned field by field, as a person would say it', () => {
    const result = (content: string) => normalizeConversation({ system: 's', messages: [{ role: 'user', content: 'Refund A-1150.' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send_email', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] }] })!.turns;
    expect(contextLine(result('{"sent":true,"to":"customer@example.com"}'))).toBe('Refund A-1150. · send_email returned sent: true, to: customer@example.com');
    // Nested values stay JSON; a string loses its quotes and extra spaces.
    expect(contextLine(result('{"policy":"refunds-v3","limit":100,"tiers":[1,2],"rule":{"above":100},"note":"  needs   approval "}'))).toBe('Refund A-1150. · send_email returned policy: refunds-v3, limit: 100, tiers: [1,2], rule: {"above":100}, note: needs approval');
    // Anything that isn't a JSON object reads as it came.
    expect(contextLine(result('[1,2,3]'))).toBe('Refund A-1150. · send_email returned [1,2,3]');
    expect(contextLine(result('{not json'))).toBe('Refund A-1150. · send_email returned {not json');
    expect(contextLine(result('{}'))).toBe('Refund A-1150. · send_email returned {}');
  });
});

describe('pairs as training rows', () => {
  it('writes OpenAI preference and TRL rows with the conversation as the model saw it and the two answers', () => {
    const store = Store.open(':memory:');
    const { run } = blamed(store);
    const { pairs } = findPairs(store);
    const [row] = pairRows(store, pairs.slice(0, 1), { format: 'openai-preference' }) as Array<{ input: { messages: Array<Record<string, unknown>>; tools: unknown[] }; preferred_output: Array<Record<string, unknown>>; non_preferred_output: Array<Record<string, unknown>> }>;
    expect(row.input.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(row.input.messages[2]).toMatchObject({ role: 'assistant', content: 'Looking the order up.', tool_calls: [{ type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"A-1042"}' } }] });
    expect(row.input.tools).toHaveLength(4);
    expect(row.input.tools[0]).toEqual({ type: 'function', function: { name: 'lookup_order', description: 'Look an order up.', parameters: { type: 'object', properties: { order_id: { type: 'string' } } } } });
    expect(row.preferred_output).toEqual([{ role: 'assistant', content: 'Above the limit.', tool_calls: [{ id: expect.stringMatching(/^toolu_/), type: 'function', function: { name: 'escalate', arguments: '{"reason":"refund of $240 is above $100"}' } }] }]);
    expect(row.non_preferred_output[0]).toMatchObject({ role: 'assistant', content: 'Issuing the refund.' });

    const [trl] = pairRows(store, pairs.slice(0, 1), { format: 'trl' }) as Array<{ prompt: Array<Record<string, unknown>>; chosen: Array<Record<string, unknown>>; rejected: unknown[]; tools: unknown[] }>;
    expect(Object.keys(trl)).toEqual(['prompt', 'chosen', 'rejected', 'tools']);
    expect(trl.prompt[3]).toMatchObject({ role: 'tool', name: 'lookup_order' });
    expect(trl.chosen[0]).toMatchObject({ tool_calls: [{ function: { name: 'escalate', arguments: { reason: 'refund of $240 is above $100' } } }] });
    expect(run.runId).toBeTruthy();
    store.close();
  });

  it('applies redaction: rules without a path everywhere, path rules to the message fields kept', () => {
    const store = Store.open(':memory:');
    blamed(store);
    const { pairs } = findPairs(store);
    const rules = [
      { pattern: 'email', replace: '<EMAIL>' },
      { kind: 'api' as const, path: '$.system', replace: '<SYSTEM>' },
      { kind: 'tool' as const, name: 'issue_refund', path: '$.args.order_id', replace: '<ORDER>' },
      { kind: 'tool' as const, name: 'lookup_order', path: '$.result.amount', replace: '<AMOUNT>' },
    ];
    const [row] = pairRows(store, pairs.slice(0, 1), { format: 'openai-preference', redact: rules }) as Array<{ input: { messages: Array<{ role: string; content: string; tool_calls?: Array<{ function: { arguments: string } }> }> }; non_preferred_output: Array<{ tool_calls: Array<{ function: { arguments: string } }> }> }>;
    const text = JSON.stringify(row);
    expect(text).not.toContain('dana@example.com');
    expect(text).toContain('<EMAIL>');
    expect(row.input.messages[0]).toEqual({ role: 'system', content: '<SYSTEM>' });
    expect(row.input.messages[3].content).toContain('"amount":"<AMOUNT>"');
    // The order id is masked where issue_refund is called, not where lookup_order is.
    expect(row.non_preferred_output[0].tool_calls[0].function.arguments).toBe('{"order_id":"<ORDER>","amount":240}');
    expect(row.input.messages[2].tool_calls![0].function.arguments).toBe('{"order_id":"A-1042"}');
    // The store is unchanged.
    const call = store.getCalls(pairs[0].rejected.runId).find((c) => c.callNo === 5)!;
    expect(JSON.stringify(loadApiRequest(store, call.requestRef!))).toContain('dana@example.com');
    store.close();
  });

  it('masks tool calls\' arguments before writing them as JSON text, so they still parse', () => {
    const store = Store.open(':memory:');
    blamed(store);
    const { pairs } = findPairs(store);
    type Message = { tool_calls?: Array<{ function: { arguments: string } }> };
    const [row] = pairRows(store, pairs.slice(0, 1), { format: 'openai-preference', redact: [{ pattern: 'number', replace: '<N>' }] }) as Array<{ input: { messages: Message[] }; preferred_output: Message[]; non_preferred_output: Message[] }>;
    const args = [...row.input.messages, ...row.preferred_output, ...row.non_preferred_output].flatMap((m) => (m.tool_calls ?? []).map((c) => c.function.arguments));
    expect(args.length).toBeGreaterThan(2);
    for (const a of args) expect(() => JSON.parse(a), a).not.toThrow();
    // Strings masked, numbers kept, as export dataset writes them.
    expect(row.non_preferred_output[0].tool_calls![0].function.arguments).toBe('{"order_id":"A<N>","amount":240}');
    expect(JSON.stringify(row)).not.toContain('1042');
    store.close();
  });
});

// ---- reading them ----

/** A copy of a run whose model requests are stored whole, as requests that aren't messages-shaped are. */
function wholeCopy(store: Store, run: RunRecord, o: { status: Exclude<RunStatus, 'running'>; meta: RunMeta }): RunRecord {
  const copy = store.createRun({ runId: testRunId(), parentRunId: run.parentRunId, mode: 'replay', command: run.command, codeVersion: null, startedAt: run.startedAt + 1, meta: o.meta });
  for (const c of store.getCalls(run.runId)) {
    const requestRef = c.kind === 'api' && c.requestRef ? store.putJson({ v: 1, kind: 'whole', blob: store.putJson(loadApiRequest(store, c.requestRef)), encoding: 'json' }) : c.requestRef;
    store.appendCallStart({ runId: copy.runId, callNo: c.callNo, kind: c.kind, name: c.name, fingerprint: c.fingerprint, occurrence: c.occurrence, origin: c.origin, effect: c.effect, requestRef, meta: c.meta, at: c.at });
    if (c.end) store.appendCallEnd(c, { ...c.end, runId: copy.runId });
  }
  store.endRun(copy.runId, o.status);
  return store.getRun(copy.runId)!;
}

/** A one-call OpenAI chat run: the policy read with a tool call, then the model's answer. */
function recordChat(store: Store, answer: string, o: { parentRunId: string; status: Exclude<RunStatus, 'running'>; meta: RunMeta; ids: string; whole?: boolean; policy?: string }): RunRecord {
  const run = store.createRun({ runId: testRunId(), parentRunId: o.parentRunId, mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, meta: o.meta });
  const body = {
    model: 'gpt-5-mini',
    messages: [
      { role: 'system', content: 'You are a support agent.' },
      { role: 'user', content: 'Refund A-1042: $240.' },
      { role: 'assistant', content: null, tool_calls: [{ id: `call_${o.ids}`, type: 'function', function: { name: 'read_policy', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `call_${o.ids}`, content: o.policy ?? 'Refunds above $100 need a manager.' },
    ],
    tools: [{ type: 'function', function: { name: 'escalate', parameters: { type: 'object', properties: {} } } }],
  };
  const requestRef = o.whole ? store.putJson({ v: 1, kind: 'whole', blob: store.putJson(body), encoding: 'json' }) : storeApiRequest(store, body);
  const response = { id: `chatcmpl-${o.ids}`, object: 'chat.completion', model: 'gpt-5-mini', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] };
  const identity = { kind: 'api' as const, name: 'POST /v1/chat/completions', fingerprint: sha256(o.ids), occurrence: 1 };
  store.appendCallStart({ runId: run.runId, callNo: 1, ...identity, origin: 'live', effect: null, requestRef, meta: { provider: 'openai' }, at: 1 });
  store.appendCallEnd(identity, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putJson(response), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'openai', model: 'gpt-5-mini' }, at: 2 });
  store.endRun(run.runId, o.status);
  return store.getRun(run.runId)!;
}

describe('reading pairs', () => {
  it('knows a conversation whether its request was stored message by message or whole, in either shape', () => {
    const store = Store.open(':memory:');
    const rec = recordRun(store, SAVED).run;
    const repeat = (group: string, n: number): RunMeta => ({ repeat: { group, attempt: n, of: 2 } });
    // Anthropic's shape: a failing attempt stored as messages, a passing one stored whole.
    recordRun(store, LOST, { parentRunId: rec.runId, status: 'failed', meta: repeat('anthropic', 1) });
    wholeCopy(store, recordRun(store, SAVED, { parentRunId: rec.runId }).run, { status: 'completed', meta: repeat('anthropic', 2) });
    // OpenAI's chat shape, with its tool messages, the same way round; and once with another tool result, which is another conversation.
    recordChat(store, 'Refunded $240.', { parentRunId: rec.runId, status: 'failed', meta: repeat('openai', 1), ids: 'a' });
    recordChat(store, 'Escalated: $240 is over the limit.', { parentRunId: rec.runId, status: 'completed', meta: repeat('openai', 2), ids: 'b', whole: true });
    recordChat(store, 'Refunded $240.', { parentRunId: rec.runId, status: 'failed', meta: repeat('parted', 1), ids: 'c' });
    recordChat(store, 'Escalated: $240 is over the limit.', { parentRunId: rec.runId, status: 'completed', meta: repeat('parted', 2), ids: 'd', whole: true, policy: 'Refunds need a manager.' });

    const { pairs, sources } = findPairs(store);
    const made = Object.fromEntries(sources.map((s) => [s.key, s.made]));
    expect(made).toEqual({ 'repeat:anthropic': 1, 'repeat:openai': 1, 'repeat:parted': 0 });
    expect(pairs.find((p) => p.source === 'repeat:openai')).toMatchObject({ callNo: 1, rejected: { text: '"Refunded $240."' }, chosen: { text: '"Escalated: $240 is over the limit."' }, context: 'Refund A-1042: $240. · read_policy returned Refunds above $100 need a manager.' });
    expect(pairs.find((p) => p.source === 'repeat:anthropic')).toMatchObject({ callNo: 5, rejected: { text: expect.stringContaining('issue_refund') }, chosen: { text: expect.stringContaining('escalate') } });
    store.close();
  });

  it('reads a long run at a handful of its calls, so a screen that shows pairs stays quick', () => {
    const store = Store.open(':memory:');
    const N = 400;
    // A run of 400 model calls, then verify attempts whose first prompt changed, so every request differs
    // from the recording's; they answer alike until the last call, where some give up and some finish.
    const record = (system: string, last: string, o: { parentRunId?: string; status: Exclude<RunStatus, 'running'>; meta?: RunMeta; ids: string }) => {
      const run = store.createRun({ runId: testRunId(), parentRunId: o.parentRunId ?? null, mode: o.parentRunId ? 'replay' : 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: 'c1', ...(o.meta ? { meta: o.meta } : {}) });
      const messages: unknown[] = [{ role: 'user', content: 'Work through the backlog.' }];
      for (let i = 0; i < N; i++) {
        const final = i === N - 1;
        const content = [{ type: 'text', text: final ? last : `Step ${i}: on to the next item.` }, ...(final ? [] : [{ type: 'tool_use', id: `toolu_${o.ids}_${i}`, name: 'step', input: { n: i } }])];
        const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: sha256(`${o.ids}${i}`), occurrence: 1 };
        store.appendCallStart({ runId: run.runId, callNo: i + 1, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'claude-sonnet-5', system, messages }), meta: { provider: 'anthropic' }, at: i });
        store.appendCallEnd(identity, { runId: run.runId, callNo: i + 1, attempt: 0, responseRef: store.putJson({ type: 'message', role: 'assistant', model: 'claude-sonnet-5', content, stop_reason: final ? 'end_turn' : 'tool_use' }), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic' }, at: i });
        messages.push({ role: 'assistant', content });
        if (!final) messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${o.ids}_${i}`, content: `item ${i} done` }] });
      }
      store.endRun(run.runId, o.status);
      return run;
    };
    const target = record('You are an agent.', 'Gave up.', { status: 'failed', ids: 't' });
    for (let a = 0; a < 4; a++) {
      const passed = a % 2 === 0;
      record('You are an agent. Finish every item.', passed ? 'All done.' : 'Gave up.', { parentRunId: target.runId, status: passed ? 'completed' : 'failed', ids: `a${a}`, meta: { verify: { role: 'target', passed }, repeat: { group: `v1-${target.runId}`, attempt: a + 1, of: 4 } } });
    }
    const read = vi.spyOn(store, 'getJson');
    const found = cpuOnce(() => findPairs(store));
    const { pairs } = found.out;
    const manifests = read.mock.results.filter((x) => (x.value as { kind?: unknown } | null)?.kind === 'chunked').length;
    expect(pairs).toHaveLength(1);
    // The attempts' prompt changed, not their path: the pair is about the recording's last call too.
    expect(pairs[0]).toMatchObject({ callNo: N, aboutCallNo: N, rejected: { text: '"Gave up."' }, chosen: { text: '"All done."' } });
    // Reading every call of five 400-call runs would read 2,000 requests, each the whole conversation so far:
    // halving reads each attempt's first and last call, the context line one more, and the recording's call it is about one more.
    expect(manifests).toBeLessThanOrEqual(10);
    // Read again, nothing changed: nothing is read.
    read.mockClear();
    expect(findPairs(store).pairs.map((p) => p.id)).toEqual(pairs.map((p) => p.id));
    expect(read).not.toHaveBeenCalled();
    // Held against this machine, not a number of milliseconds: what reading each run's last request
    // whole takes, the longest it sent, 5 to 8 times over on Node 22 and 24 (the first look also lists
    // the runs and their calls). Reading every request of every run would take a hundred times that:
    // under 40 times leaves room for other machines and fails it.
    const runs = store.listRuns();
    const { lasts } = timesOf({ lasts: () => runs.forEach((r) => loadApiRequest(store, store.getCalls(r.runId, { only: [N] })[0].requestRef!)) });
    expect(found.ms, `finding the pairs took ${times(found.ms, lasts)} reading each run's last request`).toBeLessThan(40 * lasts);
    store.close();
  });

  it('finds where two long attempts part by halving: at an answer, or at a read that returned something else', () => {
    const store = Store.open(':memory:');
    // 100 model calls, past the length compared call by call: each answer, then the tool's result.
    const record = (o: { parentRunId?: string; status: Exclude<RunStatus, 'running'>; meta?: RunMeta; ids: string; answer?: (i: number) => string; result?: (i: number) => string }) => {
      const run = store.createRun({ runId: testRunId(), parentRunId: o.parentRunId ?? null, mode: o.parentRunId ? 'replay' : 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: 'c2', ...(o.meta ? { meta: o.meta } : {}) });
      const messages: unknown[] = [{ role: 'user', content: 'Sort the tickets.' }];
      for (let i = 0; i < 100; i++) {
        const content = [{ type: 'text', text: o.answer?.(i) ?? `Ticket ${i}: filed.` }, { type: 'tool_use', id: `toolu_${o.ids}_${i}`, name: 'file', input: { n: i } }];
        const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: sha256(`${o.ids}${i}`), occurrence: 1 };
        store.appendCallStart({ runId: run.runId, callNo: i + 1, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'claude-sonnet-5', system: 'Sort them.', messages }), meta: { provider: 'anthropic' }, at: i });
        store.appendCallEnd(identity, { runId: run.runId, callNo: i + 1, attempt: 0, responseRef: store.putJson({ type: 'message', role: 'assistant', model: 'claude-sonnet-5', content, stop_reason: 'tool_use' }), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic' }, at: i });
        messages.push({ role: 'assistant', content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${o.ids}_${i}`, content: o.result?.(i) ?? `filed ${i}` }] });
      }
      store.endRun(run.runId, o.status);
      return run;
    };
    const target = record({ status: 'failed', ids: 't' });
    const repeat = (group: string, n: number): RunMeta => ({ repeat: { group, attempt: n, of: 2 } });
    // One answers ticket 30 otherwise and fails; the other passes.
    const lost = record({ parentRunId: target.runId, status: 'failed', meta: repeat('answer', 1), ids: 'a', answer: (i) => (i === 30 ? 'Ticket 30: closed as spam.' : `Ticket ${i}: filed.`) });
    record({ parentRunId: target.runId, status: 'completed', meta: repeat('answer', 2), ids: 'b' });
    // Here the answers agree, but the 40th read came back different: their paths parted there.
    record({ parentRunId: target.runId, status: 'failed', meta: repeat('read', 1), ids: 'c', result: (i) => (i === 40 ? 'the queue is down' : `filed ${i}`) });
    record({ parentRunId: target.runId, status: 'completed', meta: repeat('read', 2), ids: 'd' });

    const read = vi.spyOn(store, 'getJson');
    const { pairs, sources } = findPairs(store);
    expect(pairs).toEqual([expect.objectContaining({ source: 'repeat:answer', callNo: 31, rejected: expect.objectContaining({ runId: lost.runId, text: '"Ticket 30: closed as spam.", file({"n":30})' }), chosen: expect.objectContaining({ text: '"Ticket 30: filed.", file({"n":30})' }) })]);
    // Two comparisons of 100 calls, each halved: a handful of requests read in each attempt, not a hundred.
    expect(read.mock.results.filter((x) => (x.value as { kind?: unknown } | null)?.kind === 'chunked').length).toBeLessThan(45);
    expect(sources.find((x) => x.key === 'repeat:read')!.why).toContain('Once the attempts saw different conversations before their answers differed');
    store.close();
  });

  it('keeps what it read while another run records, and keys only what is new once a run ends', () => {
    const store = Store.open(':memory:');
    const N = 120;
    // A long run, verified three times: the attempts answer alike until the last call.
    const record = (last: string, o: { parentRunId?: string; status: Exclude<RunStatus, 'running'>; meta?: RunMeta; ids: string }) => {
      const run = store.createRun({ runId: testRunId(), parentRunId: o.parentRunId ?? null, mode: o.parentRunId ? 'replay' : 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: 'c5', ...(o.meta ? { meta: o.meta } : {}) });
      const messages: unknown[] = [{ role: 'user', content: 'Work through the backlog.' }];
      for (let i = 0; i < N; i++) {
        const final = i === N - 1;
        const content = [{ type: 'text', text: final ? last : `Step ${i}.` }, ...(final ? [] : [{ type: 'tool_use', id: `toolu_${o.ids}_${i}`, name: 'step', input: { n: i } }])];
        const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: sha256(`${o.ids}${i}`), occurrence: 1 };
        store.appendCallStart({ runId: run.runId, callNo: i + 1, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'claude-sonnet-5', system: 'You are an agent.', messages }), meta: { provider: 'anthropic' }, at: i });
        store.appendCallEnd(identity, { runId: run.runId, callNo: i + 1, attempt: 0, responseRef: store.putJson({ type: 'message', role: 'assistant', model: 'claude-sonnet-5', content, stop_reason: final ? 'end_turn' : 'tool_use' }), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic' }, at: i });
        messages.push({ role: 'assistant', content });
        if (!final) messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${o.ids}_${i}`, content: `item ${i} done` }] });
      }
      store.endRun(run.runId, o.status);
      return run;
    };
    const target = record('Gave up.', { status: 'failed', ids: 't' });
    const attempt = (n: number, passed: boolean) => record(passed ? 'All done.' : 'Gave up.', { parentRunId: target.runId, status: passed ? 'completed' : 'failed', ids: `a${n}`, meta: { verify: { role: 'target', passed }, repeat: { group: `v1-${target.runId}`, attempt: n, of: 3 } } });
    attempt(1, false);
    attempt(2, true);
    const read = vi.spyOn(store, 'getJson');
    expect(findPairs(store).pairs).toHaveLength(1);
    const first = new Set(read.mock.calls.map((c) => c[0]));
    const isManifest = (v: unknown) => (v as { kind?: unknown } | null)?.kind === 'chunked';

    // Another run starts: the runs are listed again, but every key is kept for the store, so no request or message is read.
    const live = store.createRun({ runId: testRunId(), mode: 'record', command: { argv: ['node', 'other.mjs'], cwd: '/work' }, codeVersion: 'c5' });
    const liveCall = (i: number) => {
      const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: sha256(`live${i}`), occurrence: 1 };
      store.appendCallStart({ runId: live.runId, callNo: i, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: `hi ${i}` }] }), meta: { provider: 'anthropic' }, at: i });
    };
    liveCall(1);
    read.mockClear();
    expect(findPairs(store).pairs).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    // While it records, nothing pairs are read from changes, so nothing is read at all.
    read.mockClear();
    for (let i = 2; i <= 4; i++) {
      liveCall(i);
      expect(findPairs(store).pairs).toHaveLength(1);
    }
    expect(read).not.toHaveBeenCalled();

    // A third attempt ends: the store is read again, but no message keyed before is read twice.
    attempt(3, true);
    read.mockClear();
    expect(findPairs(store).pairs).toHaveLength(1);
    const again = read.mock.calls.map((c, i) => ({ hash: c[0], manifest: isManifest(read.mock.results[i].value) }));
    expect(again.length).toBeGreaterThan(0);
    expect(again.filter((x) => !x.manifest && first.has(x.hash))).toEqual([]);
    store.close();
  });

  it('halves a long run only while its calls are one growing conversation, and compares a run with side conversations call by call', () => {
    const store = Store.open(':memory:');
    // 110 model calls: a ticket queue, and after every ninth ticket a side conversation that summarizes it, which never comes back.
    const record = (o: { parentRunId?: string; status: Exclude<RunStatus, 'running'>; meta?: RunMeta; ids: string; answer?: (i: number) => string; summary?: (i: number) => string }) => {
      const run = store.createRun({ runId: testRunId(), parentRunId: o.parentRunId ?? null, mode: o.parentRunId ? 'replay' : 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: 'c6', ...(o.meta ? { meta: o.meta } : {}) });
      const messages: unknown[] = [{ role: 'user', content: 'Sort the tickets.' }];
      let callNo = 0;
      const call = (body: unknown, content: unknown[]) => {
        callNo++;
        const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: sha256(`${o.ids}${callNo}`), occurrence: 1 };
        store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, body), meta: { provider: 'anthropic' }, at: callNo });
        store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ type: 'message', role: 'assistant', model: 'claude-sonnet-5', content, stop_reason: 'end_turn' }), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic' }, at: callNo });
      };
      for (let i = 0; i < 100; i++) {
        const content = [{ type: 'text', text: o.answer?.(i) ?? `Ticket ${i}: filed.` }, { type: 'tool_use', id: `toolu_${o.ids}_${i}`, name: 'file', input: { n: i } }];
        call({ model: 'claude-sonnet-5', system: 'Sort them.', messages }, content);
        messages.push({ role: 'assistant', content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${o.ids}_${i}`, content: `filed ${i}` }] });
        if (i % 9 === 8 || i === 99) call({ model: 'claude-sonnet-5', system: 'Summarize a ticket.', messages: [{ role: 'user', content: `Summarize ticket ${i}.` }] }, [{ type: 'text', text: o.summary?.(i) ?? `Ticket ${i} is routine.` }]);
      }
      store.endRun(run.runId, o.status);
      return run;
    };
    const target = record({ status: 'failed', ids: 't' });
    const repeat = (n: number): RunMeta => ({ repeat: { group: 'side', attempt: n, of: 2 } });
    // The failing attempt closes ticket 30 as spam; the last summaries differ in their wording too, which decides nothing.
    const lost = record({ parentRunId: target.runId, status: 'failed', meta: repeat(1), ids: 'a', answer: (i) => (i === 30 ? 'Ticket 30: closed as spam.' : `Ticket ${i}: filed.`), summary: (i) => (i === 99 ? 'Routine.' : `Ticket ${i} is routine.`) });
    record({ parentRunId: target.runId, status: 'completed', meta: repeat(2), ids: 'b' });

    const { pairs } = findPairs(store);
    // Halving would have read the first call and the last, a summary both attempts were asked alike, and paired its wording.
    expect(pairs).toEqual([expect.objectContaining({ source: 'repeat:side', callNo: 34, rejected: expect.objectContaining({ runId: lost.runId, text: '"Ticket 30: closed as spam.", file({"n":30})' }), chosen: expect.objectContaining({ text: '"Ticket 30: filed.", file({"n":30})' }) })]);
    store.close();
  });

  it('reads the store again once a run changes', () => {
    const store = Store.open(':memory:');
    const { run } = blamed(store);
    expect(findPairs(store).pairs).toHaveLength(2);
    store.updateRunMeta(run.runId, { blame: { ...run.meta!.blame!, outcome: 'unrescuable', callNo: null } });
    expect(findPairs(store)).toMatchObject({ pairs: [], sources: [{ made: 0, why: expect.stringContaining('Not rescued') }] });
    store.close();
  });
});

// ---- scopes ----

/**
 * A conversation between an agent and a simulated customer, each a model in its own scope: the agent
 * answers in scope "agent", the customer in scope "user", turn about. Each side's requests hold the
 * dialogue as that side sees it.
 */
function recordDialogue(store: Store, lines: string[], o: { parentRunId?: string; status?: Exclude<RunStatus, 'running'>; meta?: RunMeta }): RunRecord {
  const run = store.createRun({ runId: testRunId(), parentRunId: o.parentRunId ?? null, mode: o.parentRunId ? 'replay' : 'record', command: { argv: ['python', 'run_task.py'], cwd: '/work' }, codeVersion: 'c7', ...(o.meta ? { meta: o.meta } : {}) });
  const said: Array<{ by: 'agent' | 'user'; text: string }> = [{ by: 'user', text: 'Hi, I want a refund for order A-1042.' }];
  lines.forEach((text, i) => {
    const scope = i % 2 === 0 ? 'agent' : 'user';
    // Each side sees its own lines as the assistant's and the other side's as the user's.
    const messages = said.map((x) => ({ role: x.by === scope ? 'assistant' : 'user', content: x.text }));
    const body = { model: 'claude-sonnet-5', max_tokens: 256, system: scope === 'agent' ? 'You are a support agent.' : 'You are a customer who wants a refund.', messages: scope === 'user' ? [{ role: 'user', content: '(start)' }, ...messages] : messages };
    const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: sha256(`${run.runId}${i}`), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: i + 1, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, body), meta: { provider: 'anthropic', scope }, at: i });
    store.appendCallEnd(identity, { runId: run.runId, callNo: i + 1, attempt: 0, responseRef: store.putJson({ type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' }), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic', scope }, at: i });
    said.push({ by: scope, text });
  });
  store.endRun(run.runId, o.status ?? 'completed');
  return store.getRun(run.runId)!;
}

describe('pairs in a run with a simulated user', () => {
  const A1 = 'Let me look order A-1042 up.';
  const U1 = 'Sure, it was $240.';
  const verifyOf = (store: Store, target: RunRecord) => (lines: string[], passed: boolean, n: number) => recordDialogue(store, lines, { parentRunId: target.runId, status: passed ? 'completed' : 'failed', meta: { verify: { role: 'target', passed }, repeat: { group: `v3-${target.runId}`, attempt: n, of: 3 } } });

  it('pairs the agent\'s answers in the scope blame named, never the simulated user\'s lines', () => {
    const store = Store.open(':memory:');
    const target = recordDialogue(store, [A1, U1, 'Refunded $240.', 'Thanks!'], { status: 'failed' });
    store.updateRunMeta(target.runId, { blame: { at: 1, outcome: 'blamed', callNo: 3, confidence: 'high', rescuedRunId: null, fields: {}, scope: 'agent', oracle: [], probes: [], spent: 0 } });
    const attempt = verifyOf(store, target);
    const failing = attempt([A1, U1, 'Refunded $240.', 'Thanks!'], false, 1);
    const passing = attempt([A1, U1, 'That is over $100: a manager will call you.', 'Okay.'], true, 2);
    // The simulated customer said something else first: the agent's next conversation is another one, so nothing pairs there.
    attempt([A1, 'Actually, it was $80.', 'Refunded $80.', 'Thanks!'], true, 3);

    const { pairs, sources } = findPairs(store);
    const verify = sources.find((s) => s.kind === 'verify')!;
    expect(pairs.filter((p) => p.sourceKind === 'verify')).toEqual([expect.objectContaining({ callNo: 3, rejected: expect.objectContaining({ runId: failing.runId, text: '"Refunded $240."' }), chosen: expect.objectContaining({ runId: passing.runId, text: '"That is over $100: a manager will call you."' }) })]);
    expect(verify.made).toBe(1);
    expect(verify.why).toContain('Once the attempts saw different conversations before their answers differed');
    store.close();
  });

  it('makes no verify or --repeat pairs from runs in several scopes when nothing says which is the agent\'s, and says why', () => {
    const store = Store.open(':memory:');
    const target = recordDialogue(store, [A1, U1, 'Refunded $240.', 'Thanks!'], { status: 'failed' });
    const attempt = verifyOf(store, target);
    attempt([A1, U1, 'Refunded $240.', 'Thanks!'], false, 1);
    attempt([A1, 'Actually, it was $80.', 'Refunded $80.', 'Thanks!'], true, 2);
    recordDialogue(store, [A1, U1, 'Refunded $240.', 'Thanks!'], { parentRunId: target.runId, status: 'failed', meta: { repeat: { group: 'r9', attempt: 1, of: 2 } } });
    recordDialogue(store, [A1, 'Actually, it was $80.', 'Refunded $80.', 'Thanks!'], { parentRunId: target.runId, status: 'completed', meta: { repeat: { group: 'r9', attempt: 2, of: 2 } } });

    const { pairs, sources } = findPairs(store);
    expect(pairs).toEqual([]);
    for (const s of sources) {
      expect(s.made).toBe(0);
      expect(s.why).toContain("model calls are made in more than one scope (agent, user), and no blame says which is the agent's");
    }
    expect(sources.map((s) => s.kind).sort()).toEqual(['repeat', 'verify']);
    store.close();
  });
});
