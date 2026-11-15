// Answers a customer's question from the help center, and opens a ticket when the article says to.
// The help center is an MCP server, started as .mcp.json says: behind `shadowlap mcp`, so its tool
// calls are recorded, replayed and fenced like any other tool's.
//
//   node faq.mjs "<question>"
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const { command, args } = JSON.parse(readFileSync(new URL('./.mcp.json', import.meta.url), 'utf8')).mcpServers['helpdesk-kb'];
const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
let buf = '';
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id !== undefined && m.method === undefined) waiting.get(m.id)?.(m);
  }
});
let next = 1;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
  });

await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'faq', version: '1' } });
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const { tools } = (await request('tools/list')).result;

const client = new Anthropic({ apiKey: 'demo-key', maxRetries: 0 });
const definitions = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
const messages = [{ role: 'user', content: process.argv[2] ?? 'My blender stopped working after 40 days. Can it be repaired?' }];
for (let turn = 0; turn < 6; turn++) {
  const reply = await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 512, system: 'You answer Northwind customers from the help center. Search it first, and follow what the article says.', tools: definitions, messages });
  messages.push({ role: 'assistant', content: reply.content });
  const uses = reply.content.filter((b) => b.type === 'tool_use');
  if (!uses.length) {
    console.log(reply.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    break;
  }
  const results = [];
  for (const use of uses) {
    const answer = (await request('tools/call', { name: use.name, arguments: use.input })).result;
    results.push({ type: 'tool_result', tool_use_id: use.id, content: answer.content.map((c) => c.text).join(''), ...(answer.isError ? { is_error: true } : {}) });
  }
  messages.push({ role: 'user', content: results });
}
server.stdin.end();
