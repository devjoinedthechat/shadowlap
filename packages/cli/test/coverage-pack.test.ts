import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { askedTools, rebuildCapture } from '../src/coverage-pack.js';
import { assistant, RunBuilder, text, toolResult, toolUse, user } from '../../engine/test/run-fixtures.js';

/**
 * A capture rebuilt for `coverage --pack`: its tool calls taken from its own conversation, in the
 * shape each tool answers the agent in, so the agent's replay gets what production's run got.
 */

const result = (store: Store, ref: string | null) => (ref ? store.getJson<{ result?: unknown; error?: unknown }>(ref) : null);

describe('a capture rebuilt for --pack', () => {
  it("answers an MCP tool with MCP content, as shadowlap mcp serves one, and an SDK tool with the value it returned", () => {
    const store = Store.open(':memory:');
    // How this store recorded the help center's search: through shadowlap mcp.
    const faq = RunBuilder.start(store, { argv: ['node', 'faq.mjs', 'Where is my order?'] });
    faq.tool('search_kb', { query: 'order' }, { content: [{ type: 'text', text: '[]' }] }, { meta: { mcp: { transport: 'stdio', server: 'node' } } });
    faq.end();
    // Production: the model asks for both, and the next request carries both answers back, one an error.
    const cap = RunBuilder.start(store, { argv: ['<no-recorded-command>'], meta: { covers: ['api'], imported: { at: 1, from: 'prod.har' } } });
    const q1 = [user('Can I return order A-1?')];
    const a1 = [toolUse('search_kb', { query: 'return' }, 't1'), toolUse('lookup_order', { id: 'A-1' }, 't2')];
    cap.model({ messages: q1 }, a1);
    const q2 = [...q1, assistant(a1), user([toolResult('t1', '[{"id":"kb-112","title":"Returns"}]'), toolResult('t2', { amount: 40 })])];
    const a2 = [toolUse('search_kb', { query: 'A-1 refund' }, 't3')];
    cap.model({ messages: q2 }, a2);
    const q3 = [...q2, assistant(a2), user([{ type: 'tool_result', tool_use_id: 't3', content: 'search is down', is_error: true }])];
    cap.model({ messages: q3 }, [text('Yes, within 30 days.')]);
    const id = cap.end();
    expect(askedTools(store, store.getCalls(id)).map((a) => [a.name, a.answer?.content, a.answer?.isError])).toEqual([
      ['search_kb', '[{"id":"kb-112","title":"Returns"}]', false],
      ['lookup_order', '{"amount":40}', false],
      ['search_kb', 'search is down', true],
    ]);

    const target = Store.open(':memory:');
    const rebuilt = rebuildCapture(store, target, store.getRun(id)!, { argv: ['node', 'faq.mjs', 'Can I return order A-1?'], cwd: '/work' }, (t) => (t === 'search_kb' ? 'read' : null));
    expect(rebuilt).toMatchObject({ tools: 3, live: [] });
    expect(rebuilt.run.meta?.covers).toEqual(['api', 'tool:lookup_order', 'tool:search_kb']);
    const calls = target.getCalls(rebuilt.run.runId);
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['api:POST /v1/messages', 'tool:search_kb', 'tool:lookup_order', 'api:POST /v1/messages', 'tool:search_kb', 'api:POST /v1/messages']);
    const [search, lookup, failed] = calls.filter((c) => c.kind === 'tool');
    // The MCP tool: its server's record, and its answer as the content the agent's MCP client reads, a failure as isError.
    expect(search!.meta.mcp).toEqual({ transport: 'stdio', server: 'node' });
    expect(result(target, search!.end!.responseRef)).toEqual({ result: { content: [{ type: 'text', text: '[{"id":"kb-112","title":"Returns"}]' }] } });
    expect(failed!.end).toMatchObject({ outcome: 'ok' });
    expect(result(target, failed!.end!.responseRef)).toEqual({ result: { content: [{ type: 'text', text: 'search is down' }], isError: true } });
    // The SDK tool returns the value the agent turned into that text; its effect is what the store knows.
    expect(lookup!.meta.mcp).toBeUndefined();
    expect(result(target, lookup!.end!.responseRef)).toEqual({ result: { amount: 40 } });
    expect([search!.effect, lookup!.effect]).toEqual(['read', null]);
    store.close();
    target.close();
  });

  it('keeps the tool calls a capture holds of its own, and runs live a tool whose answer never came back', () => {
    const store = Store.open(':memory:');
    // A trace that kept lookup_order's calls: they are served as kept, not made again from the conversation.
    const cap = RunBuilder.start(store, { argv: ['<no-recorded-command>'], meta: { covers: ['api', 'tool:lookup_order'], imported: { at: 1, from: 'langsmith:0192' } } });
    const q1 = [user('Refund A-1.')];
    const a1 = [toolUse('lookup_order', { id: 'A-1' }, 't1')];
    cap.model({ messages: q1 }, a1);
    cap.tool('lookup_order', { id: 'A-1' }, { amount: 40, currency: 'USD' });
    const q2 = [...q1, assistant(a1), user([toolResult('t1', { amount: 40 })])];
    // The capture ends on a refund nothing answered.
    cap.model({ messages: q2 }, [toolUse('issue_refund', { id: 'A-1' }, 't2')]);
    const id = cap.end();
    const target = Store.open(':memory:');
    const rebuilt = rebuildCapture(store, target, store.getRun(id)!, { argv: ['node', 'agent.mjs', 'A-1'], cwd: '/work' }, () => null);
    expect(rebuilt).toMatchObject({ tools: 0, live: ['issue_refund'] });
    expect(rebuilt.run.meta?.covers).toEqual(['api', 'tool:lookup_order']);
    const tools = target.getCalls(rebuilt.run.runId).filter((c) => c.kind === 'tool');
    expect(tools.map((c) => c.name)).toEqual(['lookup_order']);
    expect(result(target, tools[0]!.end!.responseRef)).toEqual({ result: { amount: 40, currency: 'USD' } });
    store.close();
    target.close();
  });
});
