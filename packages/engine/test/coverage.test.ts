import { describe, expect, it } from 'vitest';
import { behaviourKey, behaviourSlug, checkCommandTemplate, commandFinder, describeBehaviour, effectsFor, fillCommand, firstMessage, groupCoverage, inferCommand, nearestGolden, requestMessage, runBehaviour, sharedSteps, storeApiRequest, storeEffects, Store, type Behaviour, type CoverageMember } from '../src/index.js';
import { assistant, messageStream, RunBuilder, text, toolResult, toolUse, user } from './run-fixtures.js';

/**
 * Production coverage's engine: what a run did, read from its model's answers, and imported runs
 * grouped by it against the goldens.
 */

const known = (entries: Record<string, 'pure' | 'read' | 'write'>) => new Map(Object.entries(entries));
const of = (b: Partial<Behaviour>): Behaviour => ({ path: [], writes: [], unknown: [], outcome: 'answered', ...b });

/** A refund agent's run, model calls only (as a capture of the network has it), or with its tool calls. */
function refund(store: Store, o: { tools?: boolean; amount?: number; parallel?: boolean; end?: 'answer' | 'tool' | 'limit' | 'error'; stream?: boolean; meta?: Record<string, unknown> } = {}): string {
  const b = RunBuilder.start(store, { meta: o.meta ?? {} });
  const q1 = [user('Order A-1: a refund, please.')];
  const a1 = o.parallel ? [toolUse('lookup_order', { id: 'A-1' }, 't1'), toolUse('get_policy', {}, 't2')] : [toolUse('lookup_order', { id: 'A-1' }, 't1')];
  b.model({ messages: q1 }, o.stream ? null : a1, o.stream ? { raw: { body: messageStream(a1), contentType: 'text/event-stream' } } : {});
  if (o.tools) b.tool('lookup_order', { id: 'A-1' }, { amount: o.amount ?? 40 });
  const q2 = [...q1, assistant(a1), user([toolResult('t1', { amount: o.amount ?? 40 })])];
  const a2 = [toolUse('issue_refund', { amount: o.amount ?? 40 }, 't3'), toolUse('send_email', { to: 'c@example.com' }, 't4')];
  b.model({ messages: q2 }, a2);
  if (o.tools) b.tool('issue_refund', { amount: 40 }, { ok: true }, { effect: 'write' });
  const q3 = [...q2, assistant(a2), user([toolResult('t3', { ok: true }), toolResult('t4', { sent: true })])];
  if (o.end === 'tool') b.model({ messages: q3 }, [toolUse('add_note', {}, 't5')]);
  else if (o.end === 'error') b.model({ messages: q3 }, null);
  else if (o.end === 'limit') b.model({ messages: q3 }, [text('Refunded')], { raw: { body: JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Refunded' }], stop_reason: 'max_tokens' }), contentType: 'application/json' } });
  else b.model({ messages: q3 }, [text('Refunded $40.')]);
  return b.end();
}

describe('a run\'s behaviour', () => {
  it('is the tools its model called, the writes among them, and how it ended', () => {
    const store = Store.open(':memory:');
    const id = refund(store);
    const calls = store.getCalls(id);
    const b = runBehaviour(store, store.getRun(id)!, calls, effectsFor(calls, known({ lookup_order: 'read', issue_refund: 'write' })));
    // A turn's calls are sorted, as --repeat sorts them; send_email declares no effect, so it counts as a write.
    expect(b).toEqual({ path: ['lookup_order', 'issue_refund', 'send_email'], writes: ['issue_refund', 'send_email'], unknown: ['send_email'], outcome: 'answered' });
    expect(describeBehaviour(b)).toBe('lookup_order → issue_refund → send_email · writes issue_refund, send_email · answered');
    store.close();
  });

  it('reads the same from a capture as from a recording with its tool calls, streamed or not', () => {
    const store = Store.open(':memory:');
    const effects = effectsFor([], known({ lookup_order: 'read', issue_refund: 'write', send_email: 'write' }));
    const capture = refund(store);
    const recording = refund(store, { tools: true });
    const streamed = refund(store, { stream: true });
    const read = (id: string) => runBehaviour(store, store.getRun(id)!, store.getCalls(id), effects);
    expect(behaviourKey(read(capture))).toBe(behaviourKey(read(recording)));
    expect(read(streamed)).toEqual(read(capture));
    store.close();
  });

  it('tells the ways a run ends apart, and leaves the judge out', () => {
    const store = Store.open(':memory:');
    const effects = () => null;
    const read = (id: string) => runBehaviour(store, store.getRun(id)!, store.getCalls(id), effects).outcome;
    expect(read(refund(store, { end: 'tool' }))).toBe('tool-call');
    expect(read(refund(store, { end: 'error' }))).toBe('model-error');
    expect(read(refund(store, { end: 'limit' }))).toBe('token-limit');
    const failed = RunBuilder.start(store);
    failed.model({ messages: [user('hi')] }, [text('Hello.')]);
    expect(read(failed.end('failed'))).toBe('agent-error');
    expect(read(RunBuilder.start(store).end())).toBe('no-model-calls');
    // A judge's call (the reserved scope) is no step of the agent's.
    const judged = RunBuilder.start(store);
    judged.model({ messages: [user('hi')] }, [toolUse('lookup_order', {}, 'a')]);
    judged.model({ messages: [user('hi')] }, [text('Done.')]);
    judged.model({ messages: [user('Does the reply explain why?')] }, [toolUse('verdict', { verdict: 'yes' }, 'j')], { scope: 'shadowlap:judge' });
    const j = judged.end();
    expect(runBehaviour(store, store.getRun(j)!, store.getCalls(j), effects)).toEqual(of({ path: ['lookup_order'], writes: ['lookup_order'], unknown: ['lookup_order'] }));
    store.close();
  });

  it('takes each tool\'s effect from its own calls, then the store, a write winning over a read', () => {
    const store = Store.open(':memory:');
    refund(store, { tools: true });
    const b = RunBuilder.start(store);
    b.tool('lookup_order', {}, {}, { effect: 'write' });
    b.end();
    const effects = storeEffects(store, known({ send_email: 'write' }));
    expect(Object.fromEntries(effects)).toEqual({ send_email: 'write', lookup_order: 'write', issue_refund: 'write' });
    const own = effectsFor([{ kind: 'tool', name: 'lookup_order', effect: 'read' } as never], effects);
    expect(own('lookup_order')).toBe('read');
    expect(own('nothing')).toBeNull();
    store.close();
  });
});

describe('coverage groups', () => {
  const member = (runId: string, startedAt: number, behaviour: Behaviour, source = 'prod.har'): CoverageMember => ({ runId, startedAt, source, behaviour });
  const refundPath = of({ path: ['lookup_order', 'issue_refund'], writes: ['issue_refund'] });
  const escalatePath = of({ path: ['lookup_order', 'escalate'], writes: ['escalate'] });
  const answerOnly = of({});

  it('groups runs that behave alike, the uncovered first, each with the goldens that cover it', () => {
    const groups = groupCoverage(
      [member('R1', 1, refundPath), member('R2', 5, refundPath, 'week2.har'), member('R3', 3, escalatePath), member('R4', 2, answerOnly), member('R5', 4, answerOnly)],
      [{ golden: 'goldens/escalate', runId: 'G1', behaviour: escalatePath }],
    );
    expect(groups.map((g) => [g.behaviour.path, g.runs, g.coveredBy])).toEqual([
      [['lookup_order', 'issue_refund'], 2, []],
      [[], 2, []],
      [['lookup_order', 'escalate'], 1, ['goldens/escalate']],
    ]);
    expect(groups[0]).toMatchObject({ runIds: ['R2', 'R1'], sources: ['week2.har', 'prod.har'], firstSeen: 1, lastSeen: 5, nearest: { golden: 'goldens/escalate', shared: 1, differs: { step: 2, seen: 'issue_refund', golden: 'escalate' } } });
    // Nothing shared with any golden: no nearest one.
    expect(groups[1]!.nearest).toBeNull();
    expect(groups[2]!.nearest).toBeNull();
  });

  it('keys a behaviour by its path, writes and ending, not by what the effects left unknown', () => {
    const unknownEffect: Behaviour = { ...refundPath, unknown: ['issue_refund'] };
    expect(behaviourKey(refundPath)).toBe(behaviourKey(unknownEffect));
    expect(behaviourKey(refundPath)).not.toBe(behaviourKey({ ...refundPath, outcome: 'model-error' }));
    expect(behaviourKey(refundPath)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('finds the nearest golden and where the two part', () => {
    expect(sharedSteps(['a', 'b', 'c'], ['a', 'b', 'd'])).toBe(2);
    const g = (golden: string, path: string[]) => ({ golden, runId: null, behaviour: of({ path }) });
    expect(nearestGolden(of({ path: ['a', 'b', 'c'] }), [g('goldens/one', ['a', 'x']), g('goldens/two', ['a', 'b'])])).toEqual({ golden: 'goldens/two', shared: 2, differs: { step: 3, seen: 'c', golden: null } });
    // The same path, another ending: nothing differs on the path.
    expect(nearestGolden(of({ path: ['a'], outcome: 'model-error' }), [g('goldens/one', ['a'])])).toEqual({ golden: 'goldens/one', shared: 1, differs: null });
  });

  it('names the golden it packs after its first tool and its writes', () => {
    expect(behaviourSlug(of({ path: ['list_inbox', 'label_thread', 'label_thread'], writes: ['label_thread'] }), 'd2a5a7d5a3b1d390')).toBe('list-inbox-label-thread-d2a5a7');
    expect(behaviourSlug(of({}), 'abcdef0123456789')).toBe('answer-abcdef');
    expect(behaviourSlug(of({ outcome: 'model-error' }), 'abcdef0123456789')).toBe('model-error-abcdef');
  });
});

describe('the command that reproduces a capture', () => {
  it('is a recording\'s that sent the same first request, never a pack\'s or a capture\'s', () => {
    const store = Store.open(':memory:');
    const capture = refund(store, { meta: { covers: ['api'], imported: { at: 1, from: 'prod.har' } } });
    expect(inferCommand(store, store.getRun(capture)!)).toBeNull();
    // A pack's run sends it too, but its command is someone else's.
    refund(store, { tools: true, meta: { imported: { at: 1, from: 'pack' } } });
    expect(inferCommand(store, store.getRun(capture)!)).toBeNull();
    const own = RunBuilder.start(store, { argv: ['node', 'agent.mjs', 'A-1'] });
    own.model({ messages: [user('Order A-1: a refund, please.')] }, [toolUse('lookup_order', { id: 'A-1' }, 't1')]);
    const ownId = own.end();
    expect(inferCommand(store, store.getRun(capture)!)).toEqual({ argv: ['node', 'agent.mjs', 'A-1'], from: ownId });
    store.close();
  });
});

describe('finding the command by the first request', () => {
  /** A run whose first model call sent `body`, under the fingerprint given (the request as the normalizers left it). */
  const run = (store: Store, o: { argv: string[]; body: unknown; fingerprint: string; startedAt: number; meta?: Record<string, unknown>; status?: 'completed' | 'running' }) => {
    const r = store.createRun({ mode: 'record', command: { argv: o.argv, cwd: '/work' }, startedAt: o.startedAt, ...(o.meta ? { meta: o.meta } : {}) });
    store.appendCallStart({ runId: r.runId, callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: o.fingerprint, occurrence: 1, origin: 'live', effect: null, requestRef: storeApiRequest(store, o.body), meta: { provider: 'anthropic' }, at: o.startedAt });
    if (o.status !== 'running') store.endRun(r.runId, 'completed', o.startedAt + 1);
    return r.runId;
  };
  const capture = (store: Store, body: unknown, fingerprint: string) => run(store, { argv: ['<no-recorded-command>'], body, fingerprint, startedAt: 50, meta: { covers: ['api'], imported: { at: 60, from: 'prod.har' } } });

  it('matches the fingerprint a normalizer left alike, or the bytes, and takes the newest run here', () => {
    const store = Store.open(':memory:');
    // Production sent a per-run id a normalizer masks: other bytes, the same fingerprint.
    const prod = capture(store, { messages: [{ role: 'user', content: 'Order B-7 (request 9f2c).' }] }, 'fp-order-b7');
    const older = run(store, { argv: ['node', 'agent.mjs', 'B-7', '--old'], body: { messages: [{ role: 'user', content: 'Order B-7 (request 11aa).' }] }, fingerprint: 'fp-order-b7', startedAt: 10 });
    const newer = run(store, { argv: ['node', 'agent.mjs', 'B-7'], body: { messages: [{ role: 'user', content: 'Order B-7 (request 22bb).' }] }, fingerprint: 'fp-order-b7', startedAt: 20 });
    // Still recording, a pack's, and another capture: none of them says what starts the agent.
    run(store, { argv: ['node', 'agent.mjs', 'B-7', '--live'], body: {}, fingerprint: 'fp-order-b7', startedAt: 30, status: 'running' });
    run(store, { argv: ['node', 'theirs.mjs'], body: {}, fingerprint: 'fp-order-b7', startedAt: 40, meta: { imported: { at: 41, from: 'pack' } } });
    capture(store, {}, 'fp-order-b7');
    const find = commandFinder(store);
    expect(find(store.getRun(prod)!)).toEqual({ argv: ['node', 'agent.mjs', 'B-7'], from: newer });
    expect(older).not.toBe(newer);
    // The same bytes under another fingerprint (the normalizers changed between): found by the bytes.
    const bytes = capture(store, { messages: [{ role: 'user', content: 'Order C-9.' }] }, 'fp-under-old-rules');
    const same = run(store, { argv: ['node', 'agent.mjs', 'C-9'], body: { messages: [{ role: 'user', content: 'Order C-9.' }] }, fingerprint: 'fp-under-new-rules', startedAt: 25 });
    expect(commandFinder(store)(store.getRun(bytes)!)).toEqual({ argv: ['node', 'agent.mjs', 'C-9'], from: same });
    expect(inferCommand(store, store.getRun(capture(store, { messages: [] }, 'fp-nobody'))!)).toBeNull();
    store.close();
  });

  it("reads a run's first message, where its input shows, whatever the provider's shape", () => {
    expect(requestMessage({ messages: [{ role: 'user', content: 'Order B-7: a refund.' }] })).toBe('Order B-7: a refund.');
    expect(requestMessage({ system: 'Be kind.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'B-7' }] }] })).toBe('Hello\nB-7');
    expect(requestMessage({ model: 'gpt-5-mini', messages: [{ role: 'system', content: 'Triage.' }, { role: 'user', content: 'Triage the unread threads in billing.' }] })).toBe('Triage the unread threads in billing.');
    expect(requestMessage({ contents: [{ role: 'user', parts: [{ text: 'Post the digest to #leads.' }] }] })).toBe('Post the digest to #leads.');
    expect(requestMessage({ messages: [{ role: 'assistant', content: 'Hi.' }] })).toBeNull();
    expect(requestMessage('not a request')).toBeNull();
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ messages: [user('Can I return a kettle I never used?')] }, [text('Yes.')]);
    expect(firstMessage(store, b.end())).toBe('Can I return a kettle I never used?');
    store.close();
  });
});

describe('a command for each capture', () => {
  it("stands {message} for the capture's first message, and {message:/regex/} for the part the regex picks", () => {
    expect(fillCommand(['node', 'faq.mjs', '{message}'], 'Can I return it?')).toEqual({ argv: ['node', 'faq.mjs', 'Can I return it?'] });
    expect(fillCommand(['node', 'agent.mjs', '{message:/[A-Z]-\\d+/}'], 'Order B-7: a refund.')).toEqual({ argv: ['node', 'agent.mjs', 'B-7'] });
    // A group picks its part; a placeholder can sit inside an argument.
    expect(fillCommand(['node', 'triage.mjs', '--folder={message:/threads in (\\w+)/}'], 'Triage the unread threads in billing.')).toEqual({ argv: ['node', 'triage.mjs', '--folder=billing'] });
    expect(fillCommand(['node', 'agent.mjs', '{message:/order (b-\\d+)/i}'], 'Order B-7.')).toEqual({ argv: ['node', 'agent.mjs', 'B-7'] });
    // A regex with braces of its own.
    expect(fillCommand(['node', 'a.mjs', '{message:/\\d{4}/}'], 'ticket 8830')).toEqual({ argv: ['node', 'a.mjs', '8830'] });
    expect(fillCommand(['node', 'agent.mjs', 'B-7'], null)).toEqual({ argv: ['node', 'agent.mjs', 'B-7'] });
    expect(fillCommand(['node', 'agent.mjs', '{message:/[A-Z]-\\d+/}'], 'Where is my parcel?')).toEqual({ why: 'its first message has no match for /[A-Z]-\\d+/' });
    expect(fillCommand(['node', 'faq.mjs', '{message}'], null)).toEqual({ why: 'its first model call holds no user message for {message} to stand for' });
  });

  it('never lets the message be run as code', () => {
    expect(checkCommandTemplate(['node', 'agent.mjs', '{message}'])).toBeNull();
    expect(checkCommandTemplate(['python', 'agent.py', '-m', '{message}'])).toBeNull();
    expect(checkCommandTemplate(['node', 'agent.mjs', 'B-7'])).toBeNull();
    expect(checkCommandTemplate(['bash', '-c', 'node agent.mjs {message}'])).toMatch(/^bash runs its arguments as a script/);
    expect(checkCommandTemplate(['/bin/sh', 'run.sh', '{message}'])).toMatch(/^\/bin\/sh runs its arguments as a script/);
    expect(checkCommandTemplate(['node', '-e', '{message}'])).toBe("{message} after -e would run as code: give the agent's own command, with {message} as one of its arguments");
    expect(checkCommandTemplate(['python', '-m', '{message}'])).toMatch(/^\{message\} after -m would run as code/);
    expect(checkCommandTemplate(['node', '--require', '{message}', 'agent.mjs'])).toMatch(/after --require would run as code/);
    expect(checkCommandTemplate(['node', 'agent.mjs', '{message:/(/}'])).toMatch(/^\{message:\/\(\/\}: Invalid regular expression/);
  });
});

describe('the store', () => {
  it('keeps what --pack last made of each behaviour, across scans', () => {
    const store = Store.open(':memory:');
    const before = store.changeCounts().coverage!;
    store.saveCoveragePack({ key: 'k1', at: 10, golden: null, runId: null, from: 'C1', mode: null, reason: 'not-reproduced', why: 'it forks at call 1', command: { argv: ['node', 'a.mjs'], from: 'R1' } });
    store.saveCoveragePack({ key: 'k2', at: 20, golden: 'goldens/b', runId: 'P2', from: 'C2', mode: 'fork', reason: null, why: null, command: { argv: ['node', 'b.mjs'], from: '--' } });
    store.saveCoveragePack({ key: 'k1', at: 30, golden: 'goldens/a', runId: 'P1', from: 'C1', mode: 'replay', reason: null, why: null, command: { argv: ['node', 'a.mjs'], from: 'R1' } });
    expect(store.coveragePacks().map((p) => [p.key, p.golden, p.mode, p.reason])).toEqual([
      ['k1', 'goldens/a', 'replay', null],
      ['k2', 'goldens/b', 'fork', null],
    ]);
    expect(store.changeCounts().coverage).toBeGreaterThan(before);
    store.close();
  });

  it('keeps each scan, and the last scan\'s groups', () => {
    const store = Store.open(':memory:');
    const before = store.changeCounts().coverage;
    const group = { key: 'k1', behaviour: of({ path: ['a'] }), runs: 1, runIds: ['R1'], sources: ['x'], firstSeen: 1, lastSeen: 2, coveredBy: [], nearest: null, command: { argv: ['node', 'a.mjs'], from: 'R0' }, packed: null };
    store.saveCoverageScan({ scanId: 'S1', at: 10, runs: 1, groups: 1, uncovered: 1, goldens: 0, actor: 'dana', data: { goldens: [] } }, [{ ...group, scanId: 'S1' }]);
    store.saveCoverageScan({ scanId: 'S2', at: 20, runs: 2, groups: 1, uncovered: 0, goldens: 1, actor: null, data: null }, [{ ...group, key: 'k2', scanId: 'S2', coveredBy: ['goldens/a'], command: null, packed: { golden: 'goldens/a', runId: 'P', at: 20 } }]);
    expect(store.listCoverageScans().map((s) => [s.scanId, s.uncovered])).toEqual([
      ['S2', 0],
      ['S1', 1],
    ]);
    expect(store.coverageGroups()).toEqual([{ ...group, key: 'k2', scanId: 'S2', coveredBy: ['goldens/a'], command: null, packed: { golden: 'goldens/a', runId: 'P', at: 20 } }]);
    expect(store.changeCounts().coverage).toBeGreaterThan(before!);
    store.close();
  });
});
