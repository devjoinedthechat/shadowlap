// HTTP hosts recorded as tools, from Python: retrieval calls with requests, a urllib3 PoolManager (as
// Pinecone's client makes them) and a urllib3 connection pool (as Elasticsearch's does), and a webhook
// post with httpx, all made directly, recorded by shadowlap run and replayed without touching either
// service. requests runs on urllib3, so its calls must be recorded once, not twice.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { findPython } from './python.mjs';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const PYTHON = findPython('requests, httpx, urllib3');

describe('HTTP hosts recorded as tools, from Python (requests, urllib3 and httpx)', { skip: PYTHON ? false : 'no Python with requests, httpx and urllib3 (set SHADOWLAP_PYTHON)' }, () => {
  const hits = { search: 0, webhook: 0 };
  const servers = [];
  let cwd;
  let env;
  const serve = (name, reply) =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          if (name in hits) hits[name]++;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply(JSON.parse(body || '{}'))));
        });
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });

  before(async () => {
    const search = await serve('search', (b) => ({ hits: [`about ${b.query}`] }));
    const webhook = await serve('webhook', () => ({ ok: true }));
    cwd = mkdtempSync(join(tmpdir(), 'fp-http-py-'));
    writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ http: { [new URL(search).host]: 'read', [new URL(webhook).host]: 'write' } }));
    writeFileSync(
      join(cwd, 'agent.py'),
      `import json, os
import httpx, requests, urllib3

query = os.environ.get("QUERY", "refund policy")
search = os.environ["SEARCH_URL"]
hits = requests.post(search + "/query", json={"query": query}).json()["hits"]
headers = {"content-type": "application/json"}
pooled = urllib3.PoolManager().request("POST", search + "/query", body=json.dumps({"query": query + " (pool manager)"}), headers=headers)
hits += json.loads(pooled.data)["hits"]
direct = urllib3.connection_from_url(search).urlopen("POST", "/query", body=json.dumps({"query": query + " (pool)"}), headers=headers)
hits += json.loads(direct.data)["hits"]
status = httpx.post(os.environ["WEBHOOK_URL"] + "/notify", json={"text": hits[0]}).status_code
print(json.dumps({"hits": hits, "notify": status}))
`,
    );
    env = { ...process.env, SEARCH_URL: search, WEBHOOK_URL: webhook, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' };
  });
  after(() => {
    for (const s of servers) s.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  const shadowlap = async (args, extra = {}) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 });
      return { code: 0, out: stdout + stderr, stdout };
    } catch (err) {
      return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, stdout: err.stdout ?? '' };
    }
  };
  const line = (stdout) => JSON.parse(stdout.split('\n').find((l) => l.startsWith('{')));

  it('records, replays without the services, and blocks the webhook after a fork', async () => {
    const recorded = await shadowlap(['run', '--', PYTHON, 'agent.py']);
    assert.equal(recorded.code, 0, recorded.out);
    assert.doesNotMatch(recorded.out, /bypassed Shadowlap/);
    assert.deepEqual(line(recorded.stdout), { hits: ['about refund policy', 'about refund policy (pool manager)', 'about refund policy (pool)'], notify: 200 });
    assert.deepEqual(hits, { search: 3, webhook: 1 });
    const runId = /recording run (\w{26})/.exec(recorded.out)[1];

    const replay = await shadowlap(['replay', runId, '--strict']);
    assert.equal(replay.code, 0, replay.out);
    assert.match(replay.out, /Replay clean: 4\/4 calls replayed/);
    assert.deepEqual(hits, { search: 3, webhook: 1 });

    const fork = await shadowlap(['replay', runId], { QUERY: 'shipping' });
    assert.equal(fork.code, 0, fork.out);
    assert.deepEqual(line(fork.stdout), { hits: ['about shipping', 'about shipping (pool manager)', 'about shipping (pool)'], notify: 409 });
    assert.deepEqual(hits, { search: 6, webhook: 1 });
  });

  // Behind a proxy, requests and httpx pick the proxy by the host the agent asked for (api.openai.com),
  // before the call is sent to the sidecar. The sidecar is on this machine's loopback: the call, its
  // key and the session token must never reach the proxy.
  it('sends captured calls to the sidecar directly when the agent is behind a proxy', async () => {
    const proxied = [];
    const proxy = createServer((req, res) => {
      proxied.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      req.resume();
      res.writeHead(502).end('proxy: cannot reach upstream');
    });
    proxy.on('connect', (req, socket) => {
      proxied.push(`CONNECT ${req.url}`);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    servers.push(proxy);
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    let n = 0;
    const openai = await serve('openai', () => ({ id: `chatcmpl-${++n}`, object: 'chat.completion', created: 1, model: 'gpt-5', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
    writeFileSync(
      join(cwd, 'proxied.py'),
      `import asyncio, httpx, requests
url = "https://api.openai.com/v1/chat/completions"
body = {"model": "gpt-5", "messages": [{"role": "user", "content": "PRIVATE"}]}
auth = {"authorization": "Bearer sk-proj-SECRET"}
codes = [requests.post(url, json=body, headers=auth).status_code, httpx.post(url, json=body, headers=auth).status_code]
async def main():
    async with httpx.AsyncClient() as client:
        return (await client.post(url, json=body, headers=auth)).status_code
codes.append(asyncio.run(main()))
print(codes)
`,
    );
    const at = `http://127.0.0.1:${proxy.address().port}`;
    const recorded = await shadowlap(['run', '--', PYTHON, 'proxied.py'], { SHADOWLAP_UPSTREAM_OPENAI: openai, HTTP_PROXY: at, HTTPS_PROXY: at, http_proxy: at, https_proxy: at });
    assert.equal(recorded.code, 0, recorded.out);
    assert.match(recorded.stdout, /\[200, 200, 200\]/, recorded.out);
    assert.match(recorded.out, /Recorded \w+: 3 calls \(3 api, 0 tool\)/);
    assert.deepEqual(proxied, []);
  });
});
