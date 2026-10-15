import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { userInput } from '../src/index.js';

/**
 * userInput() records an answer that arrives some other way than the terminal (a chat window, a
 * queue) as the same `user_input` call the readline preload records, so it replays the same way.
 */
describe('userInput', () => {
  let store: Store;
  let sidecar: Sidecar;
  const saved = { url: process.env.SHADOWLAP_URL, run: process.env.SHADOWLAP_RUN_ID };
  const use = (runId: string) => {
    const env = sidecar.envFor(runId);
    process.env.SHADOWLAP_URL = env.SHADOWLAP_URL;
    process.env.SHADOWLAP_RUN_ID = env.SHADOWLAP_RUN_ID;
  };

  beforeAll(async () => {
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store });
  });
  afterEach(() => {
    for (const [key, value] of [['SHADOWLAP_URL', saved.url], ['SHADOWLAP_RUN_ID', saved.run]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  afterAll(async () => {
    await sidecar.close();
    store.close();
  });

  it('is the read function itself outside Shadowlap', async () => {
    delete process.env.SHADOWLAP_URL;
    expect(await userInput('Order? ', (prompt) => `asked ${prompt}`)).toBe('asked Order? ');
  });

  it('records the answer as user_input, and a replay serves it without asking', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    use(rec.runId);
    expect(await userInput('Order? ', async () => 'A-1042')).toBe('A-1042');
    expect(await userInput('Anything else? ', () => 'No, thanks')).toBe('No, thanks');
    sidecar.endRun(rec.runId, 'completed');
    const calls = store.getCalls(rec.runId);
    expect(calls.map((c) => [c.name, c.effect, c.meta.input, store.getJson(c.requestRef!), store.getJson(c.end!.responseRef!)])).toEqual([
      ['user_input', 'read', true, { args: { prompt: 'Order? ' } }, { result: { text: 'A-1042' } }],
      ['user_input', 'read', true, { args: { prompt: 'Anything else? ' } }, { result: { text: 'No, thanks' } }],
    ]);

    const replay = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    use(replay.runId);
    const nobody = () => {
      throw new Error('no one is there to answer');
    };
    expect(await userInput('Order? ', nobody)).toBe('A-1042');
    expect(await userInput('Anything else? ', nobody)).toBe('No, thanks');
    expect(sidecar.endRun(replay.runId, 'completed').summary.byOrigin.replayed).toBe(2);
  });

  it('serves an answer given differently as plain text, and records a failed read as an error', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    use(rec.runId);
    await userInput('Order? ', () => 'A-1042');
    await expect(
      userInput('Again? ', () => {
        throw new Error('the window was closed');
      }),
    ).rejects.toThrow('the window was closed');
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getCalls(rec.runId)[1]!.end!.outcome).toBe('error');

    const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' }, replay: { overrides: new Map([[1, 'B-7']]) } });
    use(fork.runId);
    expect(await userInput('Order? ', () => 'unused')).toBe('B-7');
    sidecar.endRun(fork.runId, 'completed');
  });
});
