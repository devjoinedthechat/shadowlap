import { describe, expect, it } from 'vitest';
import { mcpToolName, parseToolTrust, parseUnrecordedConfig, Store, toolNameEffect, unrecordedEffect, unrecordedFix, unrecordedTools } from '../src/index.js';
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
      { name: 'Bash', count: 3, firstCallNo: 1, effect: 'write', why: 'a Claude Code built-in that runs a command', fix: 'fence' },
      { name: 'Write', count: 1, firstCallNo: 3, effect: 'write', why: 'a Claude Code built-in that changes a file', fix: 'fence' },
      { name: 'send_invoice', count: 1, firstCallNo: 5, effect: 'write', why: '"send" changes something', fix: 'wrap' },
      { name: 'search_docs', count: 1, firstCallNo: 6, effect: 'read', why: '"search" only looks', fix: 'wrap' },
      { name: 'computer.click', count: 1, firstCallNo: 6, effect: 'write', why: 'a built-in that writes', fix: 'wrap' },
      { name: 'frobnicate', count: 1, firstCallNo: 7, effect: 'unknown', why: 'its name says nothing of what it does', fix: 'wrap' },
      { name: 'mcp__crm__update_contact', count: 1, firstCallNo: 8, effect: 'write', why: '"update" changes something', fix: 'mcp' },
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
    // Claude Code's built-ins by what they do: a subagent, a skill, the task list and the plan mode keep to the session.
    const sessions = ['Agent', 'Task', 'Workflow', 'Skill', 'AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'EnterPlanMode', 'ExitPlanMode', 'ToolSearch', 'LSP'];
    expect(sessions.map((n) => [n, unrecordedEffect(n).effect, unrecordedFix(n)])).toEqual(sessions.map((n) => [n, 'read', 'none']));
    expect(unrecordedEffect('Agent')).toEqual({ effect: 'read', why: 'a Claude Code built-in that starts a subagent, whose own tool calls are named apart' });
    // Those that run a command or send something out write; the fence records some as it is, others once its effects name them.
    const writes = ['PowerShell', 'Monitor', 'TaskStop', 'EnterWorktree', 'Artifact', 'PushNotification', 'RemoteTrigger', 'SendMessage', 'SendUserFile', 'ShareOnboardingGuide'];
    expect(writes.map((n) => [n, unrecordedEffect(n).effect, unrecordedFix(n)])).toEqual(writes.map((n) => [n, 'write', 'fence-effects']));
    expect(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].map(unrecordedFix)).toEqual(Array(10).fill('fence'));
    expect([unrecordedFix('mcp__kb__search'), unrecordedFix('send_email')]).toEqual(['mcp', 'wrap']);
    expect(unrecordedEffect('sendEmail')).toEqual({ effect: 'write', why: '"send" changes something' });
    expect(unrecordedEffect('get_weather')).toEqual({ effect: 'read', why: '"get" only looks' });
    // A tool that depends only on its input changes nothing outside: it is no write.
    expect(unrecordedEffect('calculate_total')).toEqual({ effect: 'read', why: '"calculate" depends only on its input' });
    expect(unrecordedEffect('frobnicate').effect).toBe('unknown');
    expect(toolNameEffect('lookupOrder')).toEqual({ effect: 'read', word: 'lookup' });
  });

  it('counts a verb where a name puts its verb: first, after and, or or then, or last after a noun', () => {
    const effect = (names: string[]) => names.map((n) => [n, toolNameEffect(n)?.effect ?? null]);
    // Each of these writes, though some lead with a word that only looks.
    const writes = ['get_or_create_user', 'search_and_replace', 'search_and_book', 'fetch_and_store', 'get_and_set', 'lookup_and_order', 'read_and_archive', 'list_and_clear', 'check_then_deploy', 'edit_file', 'replace', 'checkout', 'purchase', 'python_repl', 'open_pull_request', 'browser_click', 'browser_navigate', 'fill_form', 'issue_refund', 'run_query', 'post_message', 'user_create', 'ticket_status_update', 'searchAndBook'];
    expect(effect(writes)).toEqual(writes.map((n) => [n, 'write']));
    expect(toolNameEffect('get_or_create_user')).toEqual({ effect: 'write', word: 'create' });
    expect(toolNameEffect('search_and_book')).toEqual({ effect: 'write', word: 'book' });
    expect(toolNameEffect('python_repl')).toEqual({ effect: 'write', word: 'repl' });
    // A noun after the verb is no write: the merge request, the commit, the refund a read looks at.
    const reads = ['get_merge_request', 'get_commit', 'get_refund_status', 'get_deploy_status', 'get_order_status', 'list_runs', 'read_file', 'lookup_order', 'get_run_status', 'list_posts', 'read_email', 'browser_snapshot', 'get_weather', 'sql_db_schema', 'sql_db_list_tables'];
    expect(effect(reads)).toEqual(reads.map((n) => [n, 'read']));
    // A word that is as often a noun is none at a name's end: no hint, so unknown, which a replay refuses as it may write.
    expect(toolNameEffect('sales_order')).toBeNull();
    // A tool that runs SQL the model writes can change data, whatever its name's verb says.
    for (const n of ['sql_db_query', 'run_sql', 'execute_sql', 'sql_query', 'graphql_query', 'run_cypher']) expect(toolNameEffect(n)?.effect, n).toBe('write');
    expect(unrecordedEffect('sql_db_query')).toEqual({ effect: 'write', why: 'it runs SQL the model writes, which can change data' });
    expect(unrecordedEffect('frobnicate')).toEqual({ effect: 'unknown', why: 'its name says nothing of what it does' });
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
