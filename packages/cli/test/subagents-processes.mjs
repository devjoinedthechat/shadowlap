// Two sub-agents that start with the same request, then continue from their answers, run either as
// separate processes the orchestrator spawns with SHADOWLAP_SCOPE set (the default), or inside
// scope() sending through http.request, as node-fetch and axios do (VIA=http-request).
// ORDER=reverse swaps which one asks first.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { scope } from '@shadowlap/sdk';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Messages API call through http.request, to the base URL shadowlap run sets. */
function create(messages) {
  const url = new URL(`${process.env.ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/messages`);
  const body = JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages });
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(text).content[0].text) : reject(new Error(`${res.statusCode} ${text}`))));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function worker(name, wait) {
  await delay(wait);
  const plan = await create([{ role: 'user', content: 'Make a plan.' }]);
  const done = await create([{ role: 'user', content: 'Make a plan.' }, { role: 'assistant', content: plan }, { role: 'user', content: `Carry it out as ${name}.` }]);
  return `${name}: ${plan} / ${done}`;
}

const [a, b] = process.env.ORDER === 'reverse' ? [80, 0] : [0, 80];
if (process.env.WORKER) {
  process.stdout.write(await worker(process.env.WORKER, Number(process.env.WAIT)));
} else if (process.env.VIA === 'http-request') {
  console.log(JSON.stringify(await Promise.all([scope('alpha', () => worker('alpha', a)), scope('beta', () => worker('beta', b))])));
} else {
  const child = (name, wait) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, WORKER: name, WAIT: String(wait), SHADOWLAP_SCOPE: name }, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${name} exited ${code}`))));
    });
  console.log(JSON.stringify(await Promise.all([child('alpha', a), child('beta', b)])));
}
