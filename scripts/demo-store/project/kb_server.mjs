// The help center's MCP server, over stdio: search_kb reads articles (annotated read-only),
// open_ticket files a ticket for the support team (a write).
//
//   node kb_server.mjs
const ARTICLES = [
  { id: 'kb-112', title: 'Returns', text: 'Unused items can be returned within 30 days of delivery for a full refund.' },
  { id: 'kb-207', title: 'Warranty repairs', text: 'Appliances have a 2-year warranty. A broken appliance is repaired or replaced; open a repair ticket with the order number.' },
  { id: 'kb-318', title: 'Damaged deliveries', text: 'Items that arrive damaged are refunded or replaced once the carrier claim is filed.' },
];
const tools = [
  { name: 'search_kb', description: 'Search the help center.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
  { name: 'open_ticket', description: 'Open a ticket for the support team.', inputSchema: { type: 'object', properties: { order: { type: 'string' }, summary: { type: 'string' } }, required: ['summary'] } },
];
const words = (s) => s.toLowerCase().match(/[a-z]{4,}/g) ?? [];
const call = (name, args) => {
  if (name === 'search_kb') {
    const asked = new Set(words(args.query ?? ''));
    return ARTICLES.filter((a) => words(`${a.title} ${a.text}`).some((w) => asked.has(w)));
  }
  if (name === 'open_ticket') return { ticket: 'T-8851', queue: 'repairs', ...args };
  throw new Error(`no tool ${name}`);
};
const reply = (id, body) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += String(chunk);
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === 'initialize') reply(m.id, { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'helpdesk-kb', version: '1.2.0' } } });
    else if (m.method === 'tools/list') reply(m.id, { result: { tools } });
    else if (m.method === 'tools/call') {
      try {
        reply(m.id, { result: { content: [{ type: 'text', text: JSON.stringify(call(m.params.name, m.params.arguments ?? {})) }] } });
      } catch (err) {
        reply(m.id, { result: { isError: true, content: [{ type: 'text', text: err.message }] } });
      }
    } else reply(m.id, { error: { code: -32601, message: `unknown method ${m.method}` } });
  }
});
process.stdin.on('end', () => process.exit(0));
