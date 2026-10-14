#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { rmSync } from 'node:fs';
import { Store, packRun } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { startMockAnthropic } from '@shadowlap-testing/mock-anthropic';
import { runAgent } from './agent.js';
import { referenceScript } from './scenario.js';

/**
 * Records the reference agent against the mock and packs the recording as the fidelity suite's
 * golden: `node testing/reference-agent/dist/make-golden.js testing/golden/reference-agent`.
 * Re-run it whenever the scenario or the agent changes on purpose.
 */
const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: make-golden <output-dir>\n');
  process.exit(2);
}
const mock = await startMockAnthropic({ script: referenceScript, eventDelayMs: () => 0 });
const store = Store.open(':memory:');
const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
const run = sidecar.startRun({ mode: 'record', command: { argv: ['node', 'testing/reference-agent/dist/main.js'], cwd: '.' }, codeVersion: 'golden' });
process.env.SHADOWLAP_URL = sidecar.url;
process.env.SHADOWLAP_RUN_ID = run.runId;
const client = new Anthropic({ apiKey: 'golden-key', baseURL: `${sidecar.url}/anthropic` });
const result = await runAgent({ client });
const { summary } = sidecar.endRun(run.runId, 'completed');
rmSync(dir, { recursive: true, force: true });
const packed = packRun(store, run.runId, dir);
process.stdout.write(`recorded ${summary.total} calls (${result.modelCalls} model, ${result.toolCalls} tool); packed ${packed.blobs} blobs to ${dir}\n`);
await sidecar.close();
await mock.close();
store.close();
