import { execFile } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardEnv } from '../src/run-agent.js';
import { pythonWith } from './python-with.js';

/**
 * A captured call goes to the sidecar naming its host in x-shadowlap-upstream, with x-shadowlap-scope
 * and x-shadowlap-failures beside it: headers for the sidecar alone. httpx and requests copy a
 * request's headers onto a redirect they follow, so an answer that sends the call on to another host
 * must not take them there. The sidecar here is a stand-in that answers every call with a redirect.
 */
const run = promisify(execFile);
const REQUESTS = pythonWith('requests');
const HTTPX = pythonWith('httpx');
const OWN = ['x-shadowlap-upstream', 'x-shadowlap-scope', 'x-shadowlap-failures'];

const seen: { sidecar: IncomingHttpHeaders[]; elsewhere: IncomingHttpHeaders[] } = { sidecar: [], elsewhere: [] };
let sidecar: Server;
let elsewhere: Server;
let sidecarUrl = '';
let elsewhereUrl = '';
const listen = (s: Server) => new Promise<string>((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

beforeAll(async () => {
  elsewhere = createServer((req, res) => {
    seen.elsewhere.push(req.headers);
    req.resume();
    res.writeHead(200, { 'content-type': 'text/plain' }).end('landed');
  });
  elsewhereUrl = await listen(elsewhere);
  sidecar = createServer((req, res) => {
    req.resume();
    // The process says hello as its capture loads; a captured call comes under its provider, http.
    if (!req.url!.includes('/http/')) return res.writeHead(204).end();
    seen.sidecar.push(req.headers);
    res.writeHead(302, { location: `${elsewhereUrl}/landed` }).end();
  });
  sidecarUrl = await listen(sidecar);
});
afterAll(async () => {
  await new Promise<void>((resolve) => sidecar.close(() => resolve()));
  await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
});

/** A process whose calls to svc.internal are captured, made in the scope "planner". */
const env = () => ({ ...process.env, ...guardEnv('off', {}), SHADOWLAP_CAPTURE: JSON.stringify({ routes: [], hosts: {}, http: [['^svc\\.internal$', null]] }), SHADOWLAP_URL: `${sidecarUrl}/t/token`, SHADOWLAP_RUN_ID: 'R1', SHADOWLAP_SCOPE: 'planner' });

async function follows(python: string[], script: string): Promise<void> {
  const before = { sidecar: seen.sidecar.length, elsewhere: seen.elsewhere.length };
  const { stdout } = await run(python[0], [...python.slice(1), '-c', script], { env: env() });
  expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ status: 200, text: 'landed' });
  // The sidecar got the call, naming its host, its scope, and that it can take a failure.
  expect(seen.sidecar.length).toBe(before.sidecar + 1);
  expect(seen.sidecar.at(-1)).toMatchObject({ 'x-shadowlap-upstream': 'http://svc.internal', 'x-shadowlap-scope': 'planner', 'x-shadowlap-failures': 'raise' });
  // The host its answer sent the call on to got none of them.
  expect(seen.elsewhere.length).toBe(before.elsewhere + 1);
  for (const name of OWN) expect(seen.elsewhere.at(-1), name).not.toHaveProperty(name);
}

describe('a captured call its answer redirects to another host', () => {
  it.skipIf(!REQUESTS)('reaches it from requests without the headers only the sidecar reads', async () => {
    await follows(REQUESTS!, 'import json, requests\nr = requests.get("http://svc.internal/start")\nprint(json.dumps({"status": r.status_code, "text": r.text}))\n');
  }, 120_000);

  it.skipIf(!HTTPX)('reaches it from httpx without them too', async () => {
    await follows(HTTPX!, 'import json, httpx\nwith httpx.Client(follow_redirects=True) as c:\n    r = c.get("http://svc.internal/start")\nprint(json.dumps({"status": r.status_code, "text": r.text}))\n');
  }, 120_000);
});
