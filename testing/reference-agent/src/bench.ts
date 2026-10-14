#!/usr/bin/env node
import { cpus, loadavg } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { startMockAnthropic, message, text } from '@shadowlap-testing/mock-anthropic';

/**
 * Sidecar overhead: the same non-streaming request direct to the mock vs through a recording
 * sidecar, interleaved to share warm-up and noise. Reports the per-call latency difference.
 *
 * The number this prints is published, so one invocation has to be reproducible. The thing that
 * actually moves it is machine load: on a loaded machine every round is slow together, so a spread
 * across rounds does not reveal it and the median of them is just as wrong. Measured on a busy
 * laptop this reports 4x what it reports on the same laptop idle. So it prints the load average
 * with the result and says when the machine was too busy to believe.
 *
 * `node testing/reference-agent/dist/bench.js [iterations-per-round] [rounds]`
 */
const N = Number(process.argv[2] ?? 200);
const ROUNDS = Number(process.argv[3] ?? 5);
const mock = await startMockAnthropic({ script: () => ({ message: message([text('ok')]) }), eventDelayMs: () => 0 });
const store = Store.open(':memory:');
const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
const run = sidecar.startRun({ mode: 'record', command: { argv: ['bench'], cwd: '.' } });
const direct = new Anthropic({ apiKey: 'k', baseURL: mock.url });
const proxied = new Anthropic({ apiKey: 'k', baseURL: `${sidecar.url}/anthropic`, defaultHeaders: { 'x-shadowlap-run': run.runId } });
const params = { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user' as const, content: 'x'.repeat(2000) }] };

async function time(client: Anthropic): Promise<number> {
  const t0 = process.hrtime.bigint();
  await client.messages.create(params);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
for (let i = 0; i < 20; i++) {
  await time(direct);
  await time(proxied);
}

const q = (xs: number[], f: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * f))]!;
const fmt = (x: number) => x.toFixed(2).padStart(6);

interface Round {
  directP50: number;
  directP95: number;
  sidecarP50: number;
  sidecarP95: number;
  overheadP50: number;
  overheadP95: number;
}

const rounds: Round[] = [];
for (let r = 0; r < ROUNDS; r++) {
  const d: number[] = [];
  const p: number[] = [];
  for (let i = 0; i < N; i++) {
    d.push(await time(direct));
    p.push(await time(proxied));
  }
  rounds.push({
    directP50: q(d, 0.5),
    directP95: q(d, 0.95),
    sidecarP50: q(p, 0.5),
    sidecarP95: q(p, 0.95),
    overheadP50: q(p, 0.5) - q(d, 0.5),
    overheadP95: q(p, 0.95) - q(d, 0.95),
  });
}

const across = (pick: (r: Round) => number) => q(rounds.map(pick), 0.5);
const spread = (pick: (r: Round) => number) => {
  const xs = rounds.map(pick);
  return `${Math.min(...xs).toFixed(2)}–${Math.max(...xs).toFixed(2)}`;
};

process.stdout.write(`${ROUNDS} rounds × ${N} calls each, interleaved  ·  request ≈ ${Buffer.byteLength(JSON.stringify(params))} bytes\n`);
const load = loadavg()[0]!;
const cores = cpus().length;
process.stdout.write(`node ${process.versions.node} on ${process.platform}/${process.arch} · ${cores} cores · load ${load.toFixed(2)}\n\n`);
process.stdout.write(`direct   p50 ${fmt(across((r) => r.directP50))} ms   p95 ${fmt(across((r) => r.directP95))} ms\n`);
process.stdout.write(`sidecar  p50 ${fmt(across((r) => r.sidecarP50))} ms   p95 ${fmt(across((r) => r.sidecarP95))} ms\n`);
process.stdout.write(`overhead p50 ${fmt(across((r) => r.overheadP50))} ms   p95 ${fmt(across((r) => r.overheadP95))} ms   (median of ${ROUNDS} rounds)\n`);
process.stdout.write(`         per-round p50 ${spread((r) => r.overheadP50)} ms · p95 ${spread((r) => r.overheadP95)} ms\n`);
// Load, not variance, is what invalidates this: half the cores busy already inflates it noticeably.
if (load > cores / 2) {
  process.stdout.write(`\nLoad ${load.toFixed(2)} on ${cores} cores: too busy to publish. Re-run on an idle machine.\n`);
}
sidecar.endRun(run.runId, 'completed');
await sidecar.close();
await mock.close();
store.close();
