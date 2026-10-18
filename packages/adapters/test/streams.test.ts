import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { withEffects } from '../src/ai-sdk.js';

/**
 * An AI SDK streaming tool (`async *execute`) wrapped by withEffects still streams, in production
 * and under Shadowlap, which records its final value.
 */

let store: Store;
let sidecar: Sidecar;

function activate(runId: string) {
  process.env.SHADOWLAP_URL = sidecar.url;
  process.env.SHADOWLAP_RUN_ID = runId;
}
function deactivate() {
  delete process.env.SHADOWLAP_URL;
  delete process.env.SHADOWLAP_RUN_ID;
}

beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
});
afterAll(async () => {
  deactivate();
  await sidecar.close();
  store.close();
});

const sha = (fn: unknown) => createHash('sha256').update(String(fn)).digest('hex');

describe('an AI SDK streaming tool (async *execute)', () => {
  /** What the AI SDK does with execute (executeTool in @ai-sdk/provider-utils): iterate a stream, else await. */
  async function execute(def: { execute?: (input: unknown, options: unknown) => unknown }, input: unknown) {
    const result = def.execute!(input, { toolCallId: 'c1' });
    const seen: unknown[] = [];
    if (result != null && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
      let last: unknown;
      for await (const output of result as AsyncIterable<unknown>) {
        last = output;
        seen.push(output);
      }
      return { streamed: true, seen, final: last };
    }
    return { streamed: false, seen, final: await result };
  }

  let ran = 0;
  const weather = {
    async *execute(input: unknown, _options: unknown) {
      const { city } = input as { city: string };
      ran++;
      yield { status: 'loading' };
      yield { status: 'done', city, tempC: 7 };
    },
  };

  it('streams as it does bare when Shadowlap is inactive', async () => {
    deactivate();
    const bare = await execute(weather, { city: 'Oslo' });
    const wrapped = await execute(withEffects({ weather }, { weather: 'read' }).weather, { city: 'Oslo' });
    expect(bare).toEqual({ streamed: true, seen: [{ status: 'loading' }, { status: 'done', city: 'Oslo', tempC: 7 }], final: { status: 'done', city: 'Oslo', tempC: 7 } });
    expect(wrapped).toEqual(bare);
  });

  it('streams while recording, records the final value, and replays it without running', async () => {
    const tools = withEffects({ weather }, { weather: 'read' });
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    activate(rec.runId);
    ran = 0;
    const live = await execute(tools.weather, { city: 'Oslo' });
    sidecar.endRun(rec.runId, 'completed');
    expect(live).toEqual({ streamed: true, seen: [{ status: 'loading' }, { status: 'done', city: 'Oslo', tempC: 7 }], final: { status: 'done', city: 'Oslo', tempC: 7 } });
    expect(ran).toBe(1);
    const [call] = store.getCalls(rec.runId);
    expect(call!.end?.outcome).toBe('ok');
    expect(store.getJson(call!.end!.responseRef!)).toEqual({ result: { status: 'done', city: 'Oslo', tempC: 7 } });
    expect(call!.meta.implHash).toBe(sha(weather.execute));

    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
    activate(rep.runId);
    const replayed = await execute(tools.weather, { city: 'Oslo' });
    const { summary } = sidecar.endRun(rep.runId, 'completed');
    expect(summary.divergence).toBeNull();
    expect(ran).toBe(1);
    // The model is shown the same final value; the progress updates were the live run's.
    expect(replayed).toEqual({ streamed: true, seen: [{ status: 'done', city: 'Oslo', tempC: 7 }], final: { status: 'done', city: 'Oslo', tempC: 7 } });
    deactivate();
  });

  it('records a stream that fails as an error, after what it yielded', async () => {
    const failing = {
      async *execute(_input: unknown, _options: unknown) {
        yield { status: 'loading' };
        throw new Error('weather service down');
      },
    };
    const tools = withEffects({ failing }, { failing: 'read' });
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    activate(rec.runId);
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const v of tools.failing.execute!({}, {}) as AsyncIterable<unknown>) seen.push(v);
      })(),
    ).rejects.toThrow('weather service down');
    sidecar.endRun(rec.runId, 'completed');
    expect(seen).toEqual([{ status: 'loading' }]);
    expect(store.getCalls(rec.runId)[0]!.end?.outcome).toBe('error');
    deactivate();
  });
});
