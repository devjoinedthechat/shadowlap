import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { withEffects } from '../src/ai-sdk.js';

/**
 * An AI SDK streaming tool (`async *execute`) wrapped by withEffects still streams, in production
 * and under Shadowlap, which records every value it yields, and replays them in order: the AI SDK
 * takes the last for the tool's output, as it did live.
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

  it('streams while recording, records every value, and replays them without running', async () => {
    const tools = withEffects({ weather }, { weather: 'read' });
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    activate(rec.runId);
    ran = 0;
    const live = await execute(tools.weather, { city: 'Oslo' });
    sidecar.endRun(rec.runId, 'completed');
    expect(live).toEqual({ streamed: true, seen: [{ status: 'loading' }, { status: 'done', city: 'Oslo', tempC: 7 }], final: { status: 'done', city: 'Oslo', tempC: 7 } });
    expect(ran).toBe(1);
    const [call] = store.getCalls(rec.runId);
    expect(call.end?.outcome).toBe('ok');
    expect(store.getJson(call.end!.responseRef!)).toEqual({ result: { shadowlap_stream: [{ status: 'loading' }, { status: 'done', city: 'Oslo', tempC: 7 }] } });
    expect(call.meta.implHash).toBe(sha(weather.execute));

    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
    activate(rep.runId);
    const replayed = await execute(tools.weather, { city: 'Oslo' });
    const { summary } = sidecar.endRun(rep.runId, 'completed');
    expect(summary.divergence).toBeNull();
    expect(ran).toBe(1);
    // The model is shown the same final value, after the same progress updates.
    expect(replayed).toEqual(live);
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
        for await (const v of tools.failing.execute({}, {}) as AsyncIterable<unknown>) seen.push(v);
      })(),
    ).rejects.toThrow('weather service down');
    sidecar.endRun(rec.runId, 'completed');
    expect(seen).toEqual([{ status: 'loading' }]);
    const [failed] = store.getCalls(rec.runId);
    expect(failed.end?.outcome).toBe('error');
    // The value it yielded first is kept with its error, and a replay yields it before raising it.
    expect(store.getJson(failed.end!.responseRef!)).toMatchObject({ error: { message: 'weather service down', streamed: [{ status: 'loading' }] } });
    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
    activate(rep.runId);
    const again: unknown[] = [];
    await expect(
      (async () => {
        for await (const v of tools.failing.execute({}, {}) as AsyncIterable<unknown>) again.push(v);
      })(),
    ).rejects.toThrow('weather service down');
    sidecar.endRun(rep.runId, 'completed');
    expect(again).toEqual(seen);
    deactivate();
  });

  it('stops the tool when its caller stops reading, as it stops bare, and records what the caller saw', async () => {
    const log: string[] = [];
    const steps = {
      async *execute(_input: unknown, _options: unknown) {
        try {
          for (let n = 1; n <= 5; n++) {
            log.push(`produced ${n}`);
            yield { step: n };
          }
        } finally {
          log.push('finally');
        }
      },
    };
    /** A caller that takes the first value and breaks, as an aborted stream does. */
    async function first(execute: (input: unknown, options: unknown) => unknown) {
      for await (const v of execute({}, {}) as AsyncIterable<unknown>) return v;
      return undefined;
    }

    deactivate();
    expect(await first(steps.execute)).toEqual({ step: 1 });
    const bare = log.splice(0);
    expect(bare).toEqual(['produced 1', 'finally']);

    const tools = withEffects({ steps }, { steps: 'read' });
    expect(await first(tools.steps.execute)).toEqual({ step: 1 });
    expect(log.splice(0)).toEqual(bare);

    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    activate(rec.runId);
    expect(await first(tools.steps.execute)).toEqual({ step: 1 });
    sidecar.endRun(rec.runId, 'completed');
    // The tool ran as far as the caller read, not on to step 5 behind its back.
    expect(log.splice(0)).toEqual(bare);
    const [call] = store.getCalls(rec.runId);
    expect(call.end?.outcome).toBe('ok');
    // Closed: the caller stopped reading there, and the stream had more.
    expect(store.getJson(call.end!.responseRef!)).toEqual({ result: { shadowlap_stream: [{ step: 1 }], closed: true } });

    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
    activate(rep.runId);
    expect(await first(tools.steps.execute)).toEqual({ step: 1 });
    expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();
    expect(log).toEqual([]);

    // A replay that reads past what the caller read when recording forks there: the rest is a call of
    // its own, which runs live from the start, past the value the recording gave, never a stream that
    // ends early and reads as clean.
    const past = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' } });
    activate(past.runId);
    const all: unknown[] = [];
    for await (const v of tools.steps.execute({}, {}) as AsyncIterable<unknown>) all.push(v);
    const { summary } = sidecar.endRun(past.runId, 'completed');
    expect(all).toEqual([1, 2, 3, 4, 5].map((step) => ({ step })));
    expect(summary.divergence).toMatchObject({ callNo: 2, kind: 'tool', name: 'steps' });
    const [, rest] = store.getCalls(past.runId);
    expect(store.getJson(rest.requestRef!)).toEqual({ args: { shadowlap_stream_after: 1 } });
    expect(store.getJson(rest.end!.responseRef!)).toEqual({ result: { shadowlap_stream: [2, 3, 4, 5].map((step) => ({ step })) } });
    deactivate();
  });

  it('runs at the pace of its caller while recording', async () => {
    const log: string[] = [];
    const ticks = {
      async *execute(_input: unknown, _options: unknown) {
        for (let n = 1; n <= 3; n++) {
          log.push(`produced ${n}`);
          yield n;
        }
      },
    };
    const tools = withEffects({ ticks }, { ticks: 'read' });
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    activate(rec.runId);
    const it = (tools.ticks.execute({}, {}) as AsyncIterable<number>)[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ done: false, value: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log).toEqual(['produced 1']);
    expect(await it.next()).toEqual({ done: false, value: 2 });
    expect(await it.next()).toEqual({ done: false, value: 3 });
    expect((await it.next()).done).toBe(true);
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getJson(store.getCalls(rec.runId)[0].end!.responseRef!)).toEqual({ result: { shadowlap_stream: [1, 2, 3] } });
    deactivate();
  });
});
