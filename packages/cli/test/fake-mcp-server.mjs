// A minimal MCP server over stdio for the proxy tests: two tools, one read-only; results carry a
// per-process call counter so a replayed result is distinguishable from a live one.
let buf = '';
let n = 0;
const tools = [
  { name: 'read_note', description: 'reads', inputSchema: { type: 'object', properties: { id: { type: 'number' } } }, annotations: { readOnlyHint: true } },
  { name: 'send_note', description: 'sends', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
];
const reply = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue; // notification
    if (m.method === 'initialize') reply(m.id, { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    else if (m.method === 'tools/list') reply(m.id, { result: { tools } });
    else if (m.method === 'tools/call') {
      n++;
      if (m.params.name === 'boom') reply(m.id, { error: { code: -32001, message: 'boom failed', data: { n } } });
      else reply(m.id, { result: { content: [{ type: 'text', text: `${m.params.name}:${JSON.stringify(m.params.arguments)}:${n}` }] } });
    } else reply(m.id, { error: { code: -32601, message: `unknown method ${m.method}` } });
  }
});
process.stdin.on('end', () => process.exit(0));
