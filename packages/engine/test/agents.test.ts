import { describe, expect, it } from 'vitest';
import { handoverTarget, LiveConversations, roleName, RunAgents, runAgents, runConversations, spawnedName, Store, type CallRecord } from '../src/index.js';
import { assistant, batchRun, RunBuilder, subagentRun, SYSTEM, text, toolResult, toolUse, TOOLS, user } from './run-fixtures.js';

const agentsOf = (store: Store, runId: string) => {
  const calls = store.getCalls(runId);
  const conversations = runConversations(store, calls, { attribute: true });
  return { calls, conversations, agents: runAgents(store, calls, conversations) };
};

const CLAUDE_CODE = "You are Claude Code, Anthropic's official CLI for Claude.";
const EXPLORE = 'You are a file search specialist for Claude Code. Find files fast.';

describe('agents of a run without scopes', () => {
  it("names a subagent the Task tool started under its caller, and says which call started it", () => {
    const store = Store.open(':memory:');
    const r = subagentRun(store);
    const { agents } = agentsOf(store, r.runId);
    expect(agents.of(r.main1)).toEqual({ agent: 'claude-code', spawnedBy: null });
    for (const n of [r.sub1, r.grep, r.sub2]) expect(agents.of(n)).toEqual({ agent: 'claude-code/Explore', spawnedBy: r.main1 });
    // The Task tool's own call is the main session's: it asked for it.
    expect(agents.of(r.task)).toEqual({ agent: 'claude-code', spawnedBy: null });
    expect(agents.of(r.main2)).toEqual({ agent: 'claude-code', spawnedBy: null });
    store.close();
  });

  it('keeps a batch of one agent one agent, with no sub-agents', () => {
    const store = Store.open(':memory:');
    const { runId } = batchRun(store, 40);
    const { calls, conversations, agents } = agentsOf(store, runId);
    expect(conversations.conversations).toHaveLength(40);
    expect(new Set(calls.map((c) => agents.of(c.callNo).agent))).toEqual(new Set(['support-agent']));
    expect(calls.every((c) => agents.of(c.callNo).spawnedBy === null)).toBe(true);
    // Each conversation's first user message, for the item's input.
    expect(agents.input(31)).toMatch(/^Ticket T-9131:/);
    store.close();
  });

  it('tells agents apart by their system prompts, a date in one aside', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const plan = b.model({ system: 'You are a planner. Today is 2026-11-08.', messages: [user('Refund order A-1.')] }, [text('1. Look up A-1. 2. Refund it.')]);
    const run = b.model({ system: 'You are an executor that carries out plans.', messages: [user('Carry out: 1. Look up A-1. 2. Refund it.')] }, [text('Done.')]);
    const plan2 = b.model({ system: 'You are a planner. Today is 2026-11-09.', messages: [user('Refund order B-2.')] }, [text('1. Look up B-2.')]);
    const odd = b.model({ system: 'Summarize the ticket in five words.', messages: [user('Refund order A-1.')] }, [text('Customer wants a refund.')]);
    b.end();
    const { agents } = agentsOf(store, b.runId);
    expect([plan, run, plan2, odd].map((n) => agents.of(n).agent)).toEqual(['planner', 'executor', 'planner', 'agent-3']);
    // The plan's words open the executor's request, but a plan is an answer, not a tool that started it.
    expect(agents.of(run).spawnedBy).toBeNull();
    store.close();
  });

  it('moves a conversation to the agent a handoff names, and back', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const q = [user('I was charged twice for order A-7.')];
    const hand = [toolUse('transfer_to_billing_agent', {}, 'toolu_h1')];
    const t1 = b.model({ system: 'You are a triage agent.', messages: q }, hand);
    const tool = b.tool('transfer_to_billing_agent', {}, { assistant: 'Billing Agent' });
    const h1 = [...q, assistant(hand), user([toolResult('toolu_h1', { assistant: 'Billing Agent' })])];
    const back = [toolUse('transfer_to_triage_agent', {}, 'toolu_h2')];
    const b1 = b.model({ system: 'You handle billing. Refund double charges.', messages: h1 }, back);
    const t2 = b.model({ system: 'You are a triage agent.', messages: [...h1, assistant(back), user([toolResult('toolu_h2', { assistant: 'Triage Agent' })])] }, [text('Anything else?')]);
    b.end();
    const { conversations, agents } = agentsOf(store, b.runId);
    expect(conversations.conversations).toHaveLength(1);
    expect([t1, tool, b1, t2].map((n) => agents.of(n).agent)).toEqual(['triage-agent', 'triage-agent', 'billing_agent', 'triage-agent']);
    store.close();
  });

  it("links no conversation to a short argument, nor to an answer that came after it started", () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ system: CLAUDE_CODE, messages: [user('Look up the weather.')] }, [toolUse('Task', { subagent_type: 'Explore', prompt: 'weather in Paris' }, 'toolu_1')]);
    const sub = b.model({ system: EXPLORE, messages: [user('weather in Paris')] }, [text('Sunny.')]);
    b.end();
    expect(agentsOf(store, b.runId).agents.of(sub)).toEqual({ agent: 'file-search-specialist', spawnedBy: null });
    store.close();
  });
});

describe('agents of a run with scopes or a trace', () => {
  it("keeps the author's scopes as the agents' names", () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const c1 = b.model({ system: 'You are a customer whose order arrived damaged.', messages: [user('Start.')] }, [text('My order A-1042 arrived damaged.')], { scope: 'customer' });
    const ask = [toolUse('check_policy', { question: 'Does a $240 EU refund for a damaged order need approval?' }, 'toolu_cp')];
    const a1 = b.model({ system: SYSTEM, tools: TOOLS, messages: [user('My order A-1042 arrived damaged.')] }, ask, { scope: 'agent' });
    const p1 = b.model({ system: 'You check refunds against policy.', messages: [user('Does a $240 EU refund for a damaged order need approval?')] }, [text('Yes, tier 2.')], { scope: 'agent/policy-checker' });
    const j = b.model({ system: 'You are a judge.', messages: [user('Does a $240 EU refund for a damaged order need approval? The agent said yes.')] }, [text('yes')], { scope: 'shadowlap:judge' });
    b.end();
    const { agents } = agentsOf(store, b.runId);
    expect(agents.of(c1)).toEqual({ agent: 'customer', spawnedBy: null });
    expect(agents.of(a1)).toEqual({ agent: 'agent', spawnedBy: null });
    // Its scope names it; the tool that started it is still found.
    expect(agents.of(p1)).toEqual({ agent: 'agent/policy-checker', spawnedBy: a1 });
    // The judge's calls are Shadowlap's: never anyone's sub-agent.
    expect(agents.of(j)).toEqual({ agent: 'shadowlap:judge', spawnedBy: null });
    store.close();
  });

  it("names a second agent in an author's scope under it", () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const a = b.model({ system: SYSTEM, messages: [user('Refund A-1.')] }, [text('Done.')], { scope: 'support' });
    const s = b.model({ system: 'You are a summarizer.', messages: [user('Refund A-1. Done.')] }, [text('Refunded.')], { scope: 'support' });
    b.end();
    const { agents } = agentsOf(store, b.runId);
    expect([a, s].map((n) => agents.of(n).agent)).toEqual(['support', 'support/summarizer']);
    store.close();
  });

  it("takes an imported trace's agent for each model call", () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const s1 = b.model({ messages: [user('Research the EU refund rules.')] }, [text('Handing to the researcher.')], { meta: { agent: 'supervisor' } });
    const r1 = b.model({ messages: [user('Find the EU refund rules.')] }, [text('Fourteen days.')], { meta: { agent: 'supervisor/researcher' } });
    b.end();
    const { agents } = agentsOf(store, b.runId);
    expect([s1, r1].map((n) => agents.of(n).agent)).toEqual(['supervisor', 'supervisor/researcher']);
    store.close();
  });
});

describe('a recording names its agents as the finished run does', () => {
  it('gives every call the name it was first given, whatever came after', () => {
    const store = Store.open(':memory:');
    const r = subagentRun(store);
    const all = store.getCalls(r.runId);
    const live = new LiveConversations(store, { attribute: true });
    const following = new RunAgents(store);
    const first = new Map<number, unknown>();
    for (let k = 1; k <= all.length; k++) {
      const part: CallRecord[] = all.slice(0, k);
      following.update(part, live.update(part)!);
      for (const c of part) if (!first.has(c.callNo) && c.end) first.set(c.callNo, following.of(c.callNo));
    }
    const { agents } = agentsOf(store, r.runId);
    for (const c of all) expect(first.get(c.callNo)).toEqual(agents.of(c.callNo));
    store.close();
  });
});

describe('names', () => {
  it('reads who a system prompt says the agent is', () => {
    expect(roleName(CLAUDE_CODE)).toBe('claude-code');
    expect(roleName('You are a helpful assistant.')).toBe('helpful-assistant');
    expect(roleName('You are Senior Research Analyst. You dig.')).toBe('senior-research-analyst');
    expect(roleName('You are a research agent that finds sources.')).toBe('research-agent');
    expect(roleName('Answer in French.')).toBeNull();
    expect(roleName('You are now in charge.')).toBeNull();
  });

  it("names what a tool started, and whom a handoff hands to", () => {
    expect(spawnedName({ name: 'Task', input: { subagent_type: 'Explore', description: 'Find it' } })).toBe('Explore');
    expect(spawnedName({ name: 'Delegate work to coworker', input: { coworker: 'Senior Researcher', task: 'x' } })).toBe('Senior Researcher');
    expect(spawnedName({ name: 'translate_to_spanish', input: { input: 'Hello' } })).toBe('translate_to_spanish');
    expect(spawnedName({ name: 'run/agent', input: {} })).toBe('run-agent');
    expect(handoverTarget({ name: 'transfer_to_billing', input: {} })).toBe('billing');
    expect(handoverTarget({ name: 'handoff', input: { agent: 'refunds' } })).toBe('refunds');
  });
});
