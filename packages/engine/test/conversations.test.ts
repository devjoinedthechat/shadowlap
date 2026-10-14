import { describe, expect, it } from 'vitest';
import { conversationRequestFor, runConversations, Store } from '../src/index.js';
import { assistant, batchRun, message, RunBuilder, SYSTEM, text, toolResult, toolUse, TOOLS, user } from './run-fixtures.js';

const conv = (store: Store, runId: string) => {
  const calls = store.getCalls(runId);
  return { calls, r: runConversations(store, calls, { attribute: true }) };
};

describe('conversations in a batch run', () => {
  it('finds where each of 40 tickets starts and puts every call in its own ticket', () => {
    const store = Store.open(':memory:');
    const { runId, byTicket } = batchRun(store, 40);
    const { calls, r } = conv(store, runId);
    expect(calls).toHaveLength(40 * 6);
    expect(r.conversations).toHaveLength(40);
    for (const [t, nos] of byTicket) {
      // get_ticket (before the first model call), model, lookup_order, model, issue_refund, model
      expect(nos.map((n) => r.byCall.get(n)!.conversation)).toEqual(new Array(6).fill(t));
      expect(nos.map((n) => r.byCall.get(n)!.starts)).toEqual([false, true, false, false, false, false]);
      expect(r.conversations[t - 1]).toMatchObject({ n: t, scope: null, firstCallNo: nos[1], lastCallNo: nos[5], modelCalls: 3, calls: 6 });
    }
    // The tools a model call asked for, with the ids the provider gave them.
    const [get, m1, lookup, m2, refund] = byTicket.get(31)!;
    expect(r.byCall.get(lookup!)).toEqual({ conversation: 31, starts: false, requestedBy: m1, toolUseId: 'toolu_31_1' });
    expect(r.byCall.get(refund!)).toMatchObject({ requestedBy: m2, toolUseId: 'toolu_31_2' });
    // Fetched before any model call asked: it goes with the conversation it feeds.
    expect(r.byCall.get(get!)).toMatchObject({ conversation: 31, requestedBy: null, toolUseId: null });
    store.close();
  });

  it('reads tool-use ids out of a streamed response', () => {
    const store = Store.open(':memory:');
    const { runId, byTicket } = batchRun(store, 3, { stream: true });
    const { r } = conv(store, runId);
    expect(r.conversations).toHaveLength(3);
    const [, m1, lookup] = byTicket.get(2)!;
    expect(r.byCall.get(lookup!)).toEqual({ conversation: 2, starts: false, requestedBy: m1, toolUseId: 'toolu_2_1' });
    store.close();
  });

  it("shows a tool call its own conversation's request, not the latest model request before it", () => {
    const store = Store.open(':memory:');
    // Two tickets worked at once in one process, without scopes: their calls interleave.
    const b = RunBuilder.start(store);
    const qa = [user('Ticket A: order A-1 arrived damaged.')];
    const qb = [user('Ticket B: order B-2 never arrived.')];
    const ra = [toolUse('lookup_order', { order_id: 'A-1' }, 'toolu_a1')];
    const rb = [toolUse('lookup_order', { order_id: 'B-2' }, 'toolu_b1')];
    const ma = b.model({ system: SYSTEM, tools: TOOLS, messages: qa }, ra);
    const mb = b.model({ system: SYSTEM, tools: TOOLS, messages: qb }, rb);
    const tb = b.tool('lookup_order', { order_id: 'B-2' }, { status: 'lost' });
    const ta = b.tool('lookup_order', { order_id: 'A-1' }, { status: 'delivered' });
    const ma2 = b.model({ system: SYSTEM, tools: TOOLS, messages: [...qa, assistant(ra), user([toolResult('toolu_a1', { status: 'delivered' })])] }, [text('Refunding A-1.')]);
    const mb2 = b.model({ system: SYSTEM, tools: TOOLS, messages: [...qb, assistant(rb), user([toolResult('toolu_b1', { status: 'lost' })])] }, [text('Reshipping B-2.')]);
    b.end();
    const { calls, r } = conv(store, b.runId);
    expect([ma, mb, tb, ta, ma2, mb2].map((n) => r.byCall.get(n)!.conversation)).toEqual([1, 2, 2, 1, 1, 2]);
    expect(r.byCall.get(tb)!.requestedBy).toBe(mb);
    expect(r.byCall.get(ta)!.requestedBy).toBe(ma);
    // A's tool call came right after B's model call; its conversation is A's.
    expect(conversationRequestFor(calls, r, ta)!.callNo).toBe(ma);
    expect(conversationRequestFor(calls, r, tb)!.callNo).toBe(mb);
    store.close();
  });
});

describe('conversations in a multi-agent run with scopes', () => {
  /** The eval of the mock: a model plays the customer, the agent hands the policy check to a sub-agent that runs beside it. */
  function evalRun(store: Store) {
    const b = RunBuilder.start(store, { argv: ['python', 'eval_conversation.py', '--persona', 'damaged-order'] });
    const opening = 'Hi, my order A-1042 arrived damaged. I’d like the full $240 refunded today, please.';
    const cust = [user('Start the conversation with the support agent.')];
    const c1 = b.model({ system: 'You are a customer whose order arrived damaged.', messages: cust }, [text(opening)], { scope: 'customer' });
    const agentQ = [user(opening)];
    const agentA = [text('Let me look into that.'), toolUse('lookup_order', { order_id: 'A-1042' }, 'toolu_lo'), toolUse('check_policy', { region: 'EU', amount: 240 }, 'toolu_cp')];
    const a1 = b.model({ system: SYSTEM, tools: TOOLS, messages: agentQ }, agentA, { scope: 'agent' });
    const policyQ = [user('Order A-1042, $240, EU. Does the refund need approval?')];
    const policyA = [toolUse('lookup_policy', { region: 'EU', amount: 240 }, 'toolu_lp')];
    // The sub-agent's first model call lands before the agent's own tool call.
    const p1 = b.model({ system: 'You check a refund against the regional policy.', messages: policyQ }, policyA, { scope: 'agent/policy-checker' });
    const lookupOrder = b.tool('lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', amount: 240 }, { scope: 'agent' });
    const lookupPolicy = b.tool('lookup_policy', { region: 'EU', amount: 240 }, { region: 'EU', refund_limit: 100 }, { scope: 'agent/policy-checker' });
    const p2 = b.model({ system: 'You check a refund against the regional policy.', messages: [...policyQ, assistant(policyA), user([toolResult('toolu_lp', { region: 'EU', refund_limit: 100 })])] }, [text('Above the $100 EU limit: a refund needs tier-2 approval.')], { scope: 'agent/policy-checker' });
    const agentQ2 = [...agentQ, assistant(agentA), user([toolResult('toolu_lo', { order_id: 'A-1042', amount: 240 }), toolResult('toolu_cp', 'Above the $100 EU limit: a refund needs tier-2 approval.')])];
    const a2A = [toolUse('escalate', { ticket: 'T-8812' }, 'toolu_es')];
    const a2 = b.model({ system: SYSTEM, tools: TOOLS, messages: agentQ2 }, a2A, { scope: 'agent' });
    const escalate = b.tool('escalate', { ticket: 'T-8812' }, { ticket: 'ESC-4410' }, { scope: 'agent', effect: 'write' });
    const reply = 'A supervisor has to approve the refund. You’ll hear back within 24 hours.';
    const a3 = b.model({ system: SYSTEM, tools: TOOLS, messages: [...agentQ2, assistant(a2A), user([toolResult('toolu_es', { ticket: 'ESC-4410' })])] }, [text(reply)], { scope: 'agent' });
    const c2 = b.model({ system: 'You are a customer whose order arrived damaged.', messages: [...cust, assistant([text(opening)]), user(reply)] }, [text('Okay. Thanks.')], { scope: 'customer' });
    b.end();
    return { runId: b.runId, c1, a1, p1, lookupOrder, lookupPolicy, p2, a2, escalate, a3, c2 };
  }

  it('keeps one conversation per scope, and each tool call in its own', () => {
    const store = Store.open(':memory:');
    const x = evalRun(store);
    const { calls, r } = conv(store, x.runId);
    expect(r.conversations.map((c) => [c.n, c.scope, c.firstCallNo, c.modelCalls])).toEqual([
      [1, 'customer', x.c1, 2],
      [2, 'agent', x.a1, 3],
      [3, 'agent/policy-checker', x.p1, 2],
    ]);
    expect(r.byCall.get(x.lookupOrder)).toEqual({ conversation: 2, starts: false, requestedBy: x.a1, toolUseId: 'toolu_lo' });
    expect(r.byCall.get(x.lookupPolicy)).toEqual({ conversation: 3, starts: false, requestedBy: x.p1, toolUseId: 'toolu_lp' });
    expect(r.byCall.get(x.escalate)!.requestedBy).toBe(x.a2);
    // The latest model request before lookup_order is the sub-agent's: the conversation shown is the agent's.
    expect(x.p1).toBeLessThan(x.lookupOrder);
    expect(conversationRequestFor(calls, r, x.lookupOrder)!.callNo).toBe(x.a1);
    store.close();
  });
});

describe('what counts as continuing a conversation', () => {
  it('ignores moved cache breakpoints and dropped thinking blocks', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const q = { role: 'user', content: [{ type: 'text', text: 'Summarise the incident.', cache_control: { type: 'ephemeral' } }] };
    const answer = [{ type: 'thinking' as const, thinking: 'Look at the logs first.', signature: 'sig' }, toolUse('read_logs', { since: '1h' }, 'toolu_1')];
    b.model({ messages: [q] }, answer);
    // The breakpoint moves to the newest message; the thinking block is passed back, then dropped.
    const q2 = { role: 'user', content: [{ type: 'text', text: 'Summarise the incident.' }] };
    const result = { role: 'user', content: [{ ...toolResult('toolu_1', 'disk full'), cache_control: { type: 'ephemeral' } }] };
    b.model({ messages: [q2, assistant(answer), result] }, [text('The disk filled up.')]);
    b.model({ messages: [q2, assistant([answer[1]!]), { role: 'user', content: [toolResult('toolu_1', 'disk full')] }, assistant([text('The disk filled up.')]), user('Why?')] }, [text('Logs were not rotated.')]);
    b.end();
    const { r } = conv(store, b.runId);
    expect(r.conversations).toHaveLength(1);
    expect(r.conversations[0]!.modelCalls).toBe(3);
    store.close();
  });

  it('keeps an OpenAI chat whose system message carries the time, and starts one per stateless request', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const name = 'POST /v1/chat/completions';
    const sys = (t: string) => ({ role: 'system', content: `You are helpful. The time is ${t}.` });
    b.model({ model: 'gpt-5', messages: [sys('10:00'), { role: 'user', content: 'Plan my day.' }] }, [text('Sure.')], { name, provider: 'openai' });
    b.model({ model: 'gpt-5', messages: [sys('10:01'), { role: 'user', content: 'Plan my day.' }, { role: 'assistant', content: 'Sure.' }, { role: 'user', content: 'Start at nine.' }] }, [text('Done.')], { name, provider: 'openai' });
    // Single questions sent one by one share nothing but the system message: each is its own.
    b.model({ model: 'gpt-5', messages: [sys('10:02'), { role: 'user', content: 'Classify: refund request' }] }, [text('refund')], { name, provider: 'openai' });
    b.model({ model: 'gpt-5', messages: [sys('10:02'), { role: 'user', content: 'Classify: password reset' }] }, [text('account')], { name, provider: 'openai' });
    b.end();
    const { r } = conv(store, b.runId);
    expect([1, 2, 3, 4].map((n) => r.byCall.get(n)!.conversation)).toEqual([1, 1, 2, 3]);
    store.close();
  });

  it('follows the Responses API by previous_response_id, and Gemini by its contents', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const responses = 'POST /v1/responses';
    const resp = (id: string, out: string) => ({ raw: { body: JSON.stringify({ id, object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: out }] }] }), contentType: 'application/json' }, name: responses, provider: 'openai' });
    b.model({ model: 'gpt-5', input: 'Draft a reply to ticket 1.' }, null, resp('resp_1', 'Draft one.'));
    b.model({ model: 'gpt-5', input: 'Draft a reply to ticket 2.' }, null, resp('resp_2', 'Draft two.'));
    b.model({ model: 'gpt-5', previous_response_id: 'resp_1', input: [{ role: 'user', content: 'Shorter.' }] }, null, resp('resp_3', 'Short one.'));
    const gemini = 'POST /v1beta/models/gemini-2.5-flash:generateContent';
    const g = (out: string) => ({ raw: { body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: out }] }, finishReason: 'STOP' }] }), contentType: 'application/json' }, name: gemini, provider: 'gemini' });
    const first = { role: 'user', parts: [{ text: 'Name three rivers.' }] };
    b.model({ contents: [first] }, null, g('Nile, Amazon, Danube.'));
    b.model({ contents: [first, { role: 'model', parts: [{ text: 'Nile, Amazon, Danube.', thoughtSignature: 'xyz' }] }, { role: 'user', parts: [{ text: 'Longest?' }] }] }, null, g('The Nile.'));
    // An embedding call is no turn of any conversation.
    b.model({ model: 'text-embedding-3-small', input: 'rivers' }, null, { raw: { body: '{"data":[]}', contentType: 'application/json' }, name: 'POST /v1/embeddings', provider: 'openai' });
    b.end();
    const { r } = conv(store, b.runId);
    expect([1, 2, 3, 4, 5].map((n) => r.byCall.get(n)!.conversation)).toEqual([1, 2, 1, 3, 3]);
    expect(r.requests.has(6)).toBe(false);
    expect(r.conversations).toHaveLength(3);
    store.close();
  });

  it('tells branches that start alike apart by the answer each continues from', () => {
    // Two sub-agents send the same first request; each continues from its own answer.
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const plan = [user('Make a plan.')];
    b.model({ messages: plan }, [text('plan 1')]);
    b.model({ messages: plan }, [text('plan 2')]);
    b.model({ messages: [...plan, assistant([text('plan 2')]), user('Carry it out as beta.')] }, [text('done')]);
    b.model({ messages: [...plan, assistant([text('plan 1')]), user('Carry it out as alpha.')] }, [text('done')]);
    b.end();
    const { r } = conv(store, b.runId);
    expect([1, 2, 3, 4].map((n) => r.byCall.get(n)!.conversation)).toEqual([1, 2, 2, 1]);
    store.close();
  });

  it('treats the same request after a failure as a retry, not a new conversation', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const q = [user('Hello')];
    b.model({ messages: q }, null, { status: 529 });
    b.model({ messages: q }, [text('Hi.')]);
    b.end();
    const { r } = conv(store, b.runId);
    expect([1, 2].map((n) => r.byCall.get(n)!.conversation)).toEqual([1, 1]);
    expect(r.byCall.get(2)!.starts).toBe(false);
    store.close();
  });

  it('keeps an agent that drops its oldest turns, by the tool-use ids it still carries', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const t1 = [toolUse('search', { q: 'a' }, 'toolu_s1')];
    const t2 = [toolUse('search', { q: 'b' }, 'toolu_s2')];
    const h1 = [user('Research a and b.'), assistant(t1), user([toolResult('toolu_s1', 'A')])];
    b.model({ messages: [user('Research a and b.')] }, t1);
    b.model({ messages: h1 }, t2);
    // The window slides: the first question is dropped, the turns after it stay.
    b.model({ messages: [assistant(t1), user([toolResult('toolu_s1', 'A')]), assistant(t2), user([toolResult('toolu_s2', 'B')])] }, [text('Both done.')]);
    b.end();
    const { r } = conv(store, b.runId);
    expect([1, 2, 3].map((n) => r.byCall.get(n)!.conversation)).toEqual([1, 1, 1]);
    store.close();
  });

  it('places tools nobody asked for with the call waiting on tools, or with the next one', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const input1 = b.tool('user_input', { prompt: 'How can I help?' }, { text: 'My blender broke.' });
    const q = [user('My blender broke.')];
    const a = [toolUse('lookup_order', { order_id: 'A-1' }, 'toolu_1')];
    const m1 = b.model({ messages: q }, a);
    // A tool with another name than the one asked for (an HTTP host recorded as a tool) still goes with it.
    const http = b.tool('GET api.example.com/orders/A-1', { url: 'https://api.example.com/orders/A-1' }, { status: 200 });
    const m2 = b.model({ messages: [...q, assistant(a), user([toolResult('toolu_1', 'delivered')])] }, [text('Refund or replacement?')]);
    const input2 = b.tool('user_input', { prompt: '>' }, { text: 'Replacement.' });
    const m3 = b.model({ messages: [...q, assistant(a), user([toolResult('toolu_1', 'delivered')]), assistant([text('Refund or replacement?')]), user('Replacement.')] }, [text('Done.')]);
    const after = b.tool('add_note', { note: 'replaced' }, { ok: true }, { effect: 'write' });
    b.end();
    const { r } = conv(store, b.runId);
    expect(r.byCall.get(input1)).toMatchObject({ conversation: 1, requestedBy: null });
    expect(r.byCall.get(http)).toMatchObject({ conversation: 1, requestedBy: null });
    expect(r.byCall.get(input2)).toMatchObject({ conversation: 1 });
    expect(r.byCall.get(after)).toMatchObject({ conversation: 1 });
    expect([m1, m2, m3].every((n) => r.byCall.get(n)!.conversation === 1)).toBe(true);
    store.close();
  });

  it('caches the analysis until the run changes', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ messages: [user('One.')] }, [text('1')]);
    const calls = store.getCalls(b.runId);
    expect(runConversations(store, calls)).toBe(runConversations(store, store.getCalls(b.runId)));
    b.model({ messages: [user('Two.')] }, [text('2')]);
    const grown = runConversations(store, store.getCalls(b.runId));
    expect(grown.conversations).toHaveLength(2);
    store.close();
  });
});

describe('message fixtures', () => {
  it('builds Anthropic responses the read model understands', () => {
    expect(message([text('x')]).stop_reason).toBe('end_turn');
  });
});
