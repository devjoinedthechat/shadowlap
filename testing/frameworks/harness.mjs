// Shared by the framework tests: an in-process sidecar on an in-memory store, and record / replay
// helpers that point the SDK at a run for the duration of a function. The shadowlap packages come
// from the repository's build output (run `npm run build` at the root first).
import { Store } from '../../packages/engine/dist/index.js';
import { Sidecar } from '../../packages/sidecar/dist/index.js';

export async function startHarness(opts = {}) {
  const store = Store.open(':memory:');
  const sidecar = await Sidecar.start({ store, ...(opts.upstreams ? { upstreams: opts.upstreams } : {}), ...(opts.normalizers ? { normalizers: opts.normalizers } : {}) });
  const command = { argv: ['framework-test'], cwd: '/' };

  async function within(run, fn) {
    const saved = { url: process.env.SHADOWLAP_URL, runId: process.env.SHADOWLAP_RUN_ID, env: {} };
    process.env.SHADOWLAP_URL = sidecar.url;
    process.env.SHADOWLAP_RUN_ID = run.runId;
    const env = sidecar.envFor(run.runId);
    for (const [k, v] of Object.entries(env)) {
      saved.env[k] = process.env[k];
      process.env[k] = v;
    }
    let value;
    let error;
    try {
      value = await fn();
    } catch (err) {
      error = err;
    } finally {
      for (const [k, v] of Object.entries(saved.env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (saved.url === undefined) delete process.env.SHADOWLAP_URL;
      else process.env.SHADOWLAP_URL = saved.url;
      if (saved.runId === undefined) delete process.env.SHADOWLAP_RUN_ID;
      else process.env.SHADOWLAP_RUN_ID = saved.runId;
    }
    const { summary } = sidecar.endRun(run.runId, error ? 'failed' : 'completed');
    const calls = store.getCalls(run.runId);
    return { run, summary, calls, value, error };
  }

  return {
    store,
    sidecar,
    record: (fn) => within(sidecar.startRun({ mode: 'record', command }), fn),
    replay: (parent, fn, replay) => within(sidecar.startRun({ mode: 'replay', parentRunId: parent.run.runId, command, ...(replay ? { replay } : {}) }), fn),
    async close() {
      await sidecar.close();
      store.close();
    },
  };
}

/** Call name, effect, origin and outcome per tool call: what each test asserts on. */
export const toolTrace = (calls) => calls.filter((c) => c.kind === 'tool').map((c) => `${c.name}:${c.effect}:${c.origin}:${c.end?.outcome ?? 'pending'}`);
