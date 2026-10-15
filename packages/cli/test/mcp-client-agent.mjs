// An agent whose MCP client starts `shadowlap mcp --url <server>` the way the official SDKs' stdio
// clients start a server: with a minimal environment, so SHADOWLAP_URL and SHADOWLAP_RUN_ID never
// reach the proxy. It reads a note, then sends one (a write), and prints what the tools answered.
//
//   node mcp-client-agent.mjs <shadowlap bin> <server url> [proxy home folder]
import { spawn } from 'node:child_process';

// The variables the SDKs pass on (their getDefaultEnvironment), and nothing else. On Windows they
// keep what the system needs: without SYSTEMROOT, for one, a process can't open a socket.
const INHERITED =
  process.platform === 'win32'
    ? ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES']
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
const env = Object.fromEntries(INHERITED.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));

const [cli, url, proxyHome] = process.argv.slice(2);
// Another home folder for the proxy: HOME, or on Windows USERPROFILE, where Node looks for it there.
if (proxyHome) env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = proxyHome;
const proxy = spawn(process.execPath, [cli, 'mcp', '--url', url], {
  env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

const waiters = new Map();
let buf = '';
proxy.stdout.setEncoding('utf8');
proxy.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method === undefined) waiters.get(m.id)?.(m);
  }
});
let nextId = 1;
const request = (method, params) => {
  const id = nextId++;
  const answered = new Promise((resolve) => waiters.set(id, resolve));
  proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  return answered;
};
const said = (m) => (m.error ? `error: ${m.error.message}` : `${m.result.isError ? 'refused: ' : ''}${m.result.content[0].text}`);

await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '1' } });
proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
await request('tools/list');
console.log(`read_note -> ${said(await request('tools/call', { name: 'read_note', arguments: { id: 1 } }))}`);
console.log(`send_note -> ${said(await request('tools/call', { name: 'send_note', arguments: { to: 'billing' } }))}`);
proxy.stdin.end();
await new Promise((resolve) => proxy.on('exit', resolve));
