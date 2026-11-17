#!/usr/bin/env node
// Serves the dashboard with synthetic data for design work: an in-memory store (nothing is written
// anywhere) filled with twelve weeks of plausible, growing usage.
//   node packages/collector/scripts/preview.mjs [--empty] [--port 8788]
import { startCollector } from '../dist/index.js';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 8788);
const empty = args.includes('--empty');
const c = await startCollector({ db: ':memory:', port: args.includes('--port') ? port : 8788, host: '127.0.0.1', statsCacheMs: 0, rateLimitPerMinute: 100_000 });

if (!empty) {
  const DAY = 86_400_000;
  const now = Date.now();
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  // Installs arrive over twelve weeks, faster lately; each replays on some of the days since it arrived.
  for (let i = 0; i < 160; i++) {
    const age = Math.floor(84 * Math.pow(rand(), 1.8)); // days since install; skewed recent
    const installId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const base = {
      version: pick(['0.1.0', '0.1.0', '0.1.0', '0.1.1', '0.2.0']),
      os: pick(['darwin', 'darwin', 'darwin', 'linux', 'linux', 'win32']),
      arch: pick(['arm64', 'x64']),
      node: pick(['22.17.0', '24.2.0']),
      providers: pick([['anthropic'], ['anthropic'], ['openai'], ['anthropic', 'openai'], ['gemini']]),
      sdks: pick([['typescript'], ['typescript'], ['python'], ['typescript', 'mcp']]),
      ...(rand() < 0.12 ? { ci: pick(['github', 'github', 'gitlab', 'buildkite']) } : {}),
    };
    const events = [];
    for (let d = age; d >= 0 && events.length < 48; d--) {
      if (rand() > 0.35) continue;
      const at = now - d * DAY - Math.floor(rand() * 8 * 3600_000);
      if (at > now) continue;
      events.push({ ...base, type: 'run', at, calls: 30, live: 30, durationMs: 4200, exitCode: 0 });
      const forked = rand() < 0.28;
      events.push({ ...base, type: 'replay', at: at + 60_000, calls: 30, replayed: forked ? 16 : 30, live: forked ? 14 : 0, blocked: forked ? 1 : 0, ...(forked ? { divergence: pick(['request_changed', 'request_changed', 'new_call', 'forced', 'beyond_recording']) } : {}), tokensNotRespent: 8000 + Math.floor(rand() * 90_000), durationMs: 900, exitCode: 0 });
    }
    for (let k = 0; k < events.length; k += 50) {
      const r = await fetch(`${c.url}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, installId, sentAt: now, events: events.slice(k, k + 50) }) });
      if (!r.ok) throw new Error(`seed rejected: ${r.status} ${await r.text()}`);
    }
  }
}
console.log(`dashboard preview (${empty ? 'empty' : 'synthetic data'}): ${c.url}/`);
process.on('SIGINT', () => void c.close().then(() => process.exit(0)));
process.on('SIGTERM', () => void c.close().then(() => process.exit(0)));
