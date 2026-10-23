import { describe, expect, it } from 'vitest';
import { mcpToolName, parseToolTrust, parseUnrecordedConfig, Store, toolNameEffect, unrecordedEffect, unrecordedTools } from '../src/index.js';
import { messageStream, RunBuilder, text, toolUse, user } from './run-fixtures.js';

/**
 * The tools a run's model called that the run recorded no call of: read from the model's own
 * answers in every wire format, minus the tool calls the run recorded, each with how often, from
 * which model call, and what it does to the world.
 */

const json = (body: unknown) => ({ raw: { body: JSON.stringify(body), contentType: 'application/json' } });

describe('unrecordedTools', () => {
  it('reads the tools every format asks for, leaves out those the run recorded and those the provider runs itself', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    // Anthropic, as JSON: two Bash calls in one answer, and a lookup the agent wraps.
    b.model({ messages: [user('Fix the build.')] }, [text('Looking.'), toolUse('Bash', { command: 'npm test' }, 't1'), toolUse('Bash', { command: 'git status' }, 't2'), toolUse('lookup_order', { id: 'A-1' }, 't3')]);
    b.tool('lookup_order', { id: 'A-1' }, { amount: 40 });
    // Anthropic, streamed: Write, and a server tool Anthropic runs itself (web search), never the agent.
    b.model({ messages: [user('more')] }, null, { raw: { body: messageStream([toolUse('Write', { file_path: 'a.ts' }, 't4')]), contentType: 'text/event-stream' } });
    b.model({ messages: [user('search')] }, null, json({ type: 'message', role: 'assistant', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }, { type: 'text', text: 'Found it.' }], stop_reason: 'end_turn' }));
    // OpenAI Chat Completions.
    b.model({ messages: [user('bill')] }, null, { ...json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_invoice', arguments: '{"to":"a@example.com"}' } }] }, finish_reason: 'tool_calls' }] }), provider: 'openai', name: 'POST /v1/chat/completions' });
    // The Responses API: a function call, a hosted web search (not the agent's), and computer use the client runs.
    b.model({ input: 'go' }, null, { ...json({ status: 'completed', output: [{ type: 'function_call', name: 'search_docs', call_id: 'f1', arguments: '{}' }, { type: 'web_search_call', id: 'ws1', action: { query: 'y' } }, { type: 'computer_call', call_id: 'cu1', action: { type: 'click', x: 1, y: 2 } }] }), provider: 'openai', name: 'POST /v1/responses' });
    // Gemini.
    b.model({ contents: [] }, null, { ...json({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'frobnicate', args: {} } }] } }] }), provider: 'gemini', name: 'POST /v1beta/models/gemini-3-pro:generateContent' });
    // An MCP server's tools as Claude Code names them: one recorded through shadowlap mcp under its own name, one not.
    b.model({ messages: [user('kb')] }, [toolUse('mcp__kb__search_kb', { q: 'refund' }, 't5'), toolUse('mcp__crm__update_contact', { id: 7 }, 't6')]);
    b.tool('search_kb', { q: 'refund' }, [{ id: 'kb-1' }]);
    // A call that failed left no answer to read; a judge's call is none of the agent's.
    b.model({ messages: [user('again')] }, null, { outcome: 'error', status: 529 });
    b.model({ messages: [user('Does the reply explain why?')] }, [toolUse('verdict', { verdict: 'yes' }, 'j')], { scope: 'shadowlap:judge' });
    b.model({ messages: [user('last')] }, [toolUse('Bash', { command: 'ls' }, 't7')]);
    const runId = b.end();

    expect(unrecordedTools(store, runId)).toEqual([
      { name: 'Bash', count: 3, firstCallNo: 1, effect: 'write', why: 'a built-in that writes' },
      { name: 'Write', count: 1, firstCallNo: 3, effect: 'write', why: 'a built-in that writes' },
      { name: 'send_invoice', count: 1, firstCallNo: 5, effect: 'write', why: '"send" changes something' },
      { name: 'search_docs', count: 1, firstCallNo: 6, effect: 'read', why: '"search" only looks' },
      { name: 'computer.click', count: 1, firstCallNo: 6, effect: 'write', why: 'a built-in that writes' },
      { name: 'frobnicate', count: 1, firstCallNo: 7, effect: 'unknown', why: 'its name says nothing of what it does' },
      { name: 'mcp__crm__update_contact', count: 1, firstCallNo: 8, effect: 'write', why: '"update" changes something' },
    ]);
    store.close();
  });

  it('takes the effect the config declares over a built-in’s and a name’s, by the name or the MCP tool’s own', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ messages: [user('go')] }, [toolUse('Bash', {}, 'a'), toolUse('frobnicate', {}, 'b'), toolUse('mcp__crm__update_contact', {}, 'c')]);
    const runId = b.end();
    const declared = { Bash: 'read', frobnicate: 'write', update_contact: 'read' } as const;
    expect(unrecordedTools(store, runId, { declared }).map((t) => [t.name, t.effect, t.why])).toEqual([
      ['Bash', 'read', 'declared read in shadowlap.config.json'],
      ['frobnicate', 'write', 'declared write in shadowlap.config.json'],
      ['mcp__crm__update_contact', 'read', 'declared read in shadowlap.config.json'],
    ]);
    store.close();
  });

  it('finds nothing in a run that recorded every tool its model called', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ messages: [user('go')] }, [toolUse('lookup_order', { id: 'A-1' }, 'a')]);
    b.tool('lookup_order', { id: 'A-1' }, { amount: 40 });
    b.model({ messages: [user('go')] }, [text('Done.')]);
    expect(unrecordedTools(store, b.end())).toEqual([]);
    store.close();
  });
});

describe('an unrecorded tool’s effect', () => {
  it('knows the agent runtimes’ built-ins, and reads a name by the verb it leads with', () => {
    expect(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'computer', 'computer.type', 'str_replace_based_edit_tool', 'local_shell', 'apply_patch'].map((n) => unrecordedEffect(n).effect)).toEqual(Array(10).fill('write'));
    expect(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].map((n) => unrecordedEffect(n).effect)).toEqual(Array(5).fill('read'));
    expect(unrecordedEffect('sendEmail')).toEqual({ effect: 'write', why: '"send" changes something' });
    expect(unrecordedEffect('get_weather')).toEqual({ effect: 'read', why: '"get" only looks' });
    // A tool that depends only on its input changes nothing outside: it is no write.
    expect(unrecordedEffect('calculate_total')).toEqual({ effect: 'read', why: '"calculate" depends only on its input' });
    expect(unrecordedEffect('frobnicate').effect).toBe('unknown');
    expect(toolNameEffect('lookupOrder')).toEqual({ effect: 'read', word: 'lookup' });
    expect(mcpToolName('mcp__my_server__send_email')).toBe('send_email');
    expect(mcpToolName('send_email')).toBeNull();
  });
});

describe('tools.unrecorded in shadowlap.config.json', () => {
  it('maps tool names to read or write, and is no tool’s trust', () => {
    const tools = { unrecorded: { Bash: 'write', lookup_kb: 'read' }, fetch_page: { trust: 'untrusted' } };
    expect(parseUnrecordedConfig(tools)).toEqual({ Bash: 'write', lookup_kb: 'read' });
    expect(parseToolTrust(tools)).toEqual({ fetch_page: { trust: 'untrusted' } });
    expect(parseUnrecordedConfig({ fetch_page: { trust: 'untrusted' } })).toBeNull();
    expect(() => parseUnrecordedConfig({ unrecorded: { Bash: 'pure' } })).toThrow('shadowlap.config.json: tools.unrecorded["Bash"] must be "read" or "write"');
    expect(() => parseUnrecordedConfig({ unrecorded: ['Bash'] })).toThrow('tools.unrecorded must map tool names to "read" or "write"');
  });
});
