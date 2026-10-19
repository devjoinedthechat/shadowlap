import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { tool } from '@shadowlap/sdk';
import { Sidecar } from '../src/index.js';

/**
 * A tool marked untrusted (the reads `shadowlap injection` plants in) is recorded so on each call,
 * from the TypeScript SDK and the Python SDK alike, and the mark never enters a call's
 * fingerprint: a recording made before the tool was marked still replays.
 */

const PY_SDK = fileURLToPath(new URL('../../../sdks/python', import.meta.url));

function python(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      if (/Python 3\.(9|[1-9]\d)/.test(execFileSync(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())) return cmd;
    } catch {
      // the next one
    }
  }
  return null;
}

let store: Store;
let sidecar: Sidecar;

beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
});
afterAll(async () => {
  await sidecar.close();
  store.close();
});

/** Runs `fn` with the SDK pointed at `runId`, as an agent under shadowlap run is. */
async function inRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const saved = { url: process.env.SHADOWLAP_URL, run: process.env.SHADOWLAP_RUN_ID };
  Object.assign(process.env, sidecar.envFor(runId));
  try {
    return await fn();
  } finally {
    for (const [k, v] of [['SHADOWLAP_URL', saved.url], ['SHADOWLAP_RUN_ID', saved.run]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('trust on a tool', () => {
  it('is recorded on each call of a tool the TypeScript SDK marks untrusted, and on no other', async () => {
    const fetchPage = tool('fetch_page', { effect: 'read', trust: 'untrusted' }, async ({ url }: { url: string }) => ({ url, text: 'a page' }));
    const search = tool('search', { effect: 'read' }, async ({ q }: { q: string }) => [q]);
    const lookup = tool('lookup', { effect: 'read', trust: 'trusted' }, async ({ k }: { k: string }) => k);
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    await inRun(run.runId, async () => {
      await fetchPage({ url: 'https://example.com/a' });
      await search({ q: 'x' });
      await lookup({ k: 'y' });
    });
    sidecar.endRun(run.runId, 'completed');
    expect(store.getCalls(run.runId).map((c) => [c.name, c.meta.trust ?? null])).toEqual([
      ['fetch_page', 'untrusted'],
      ['search', null],
      ['lookup', null],
    ]);
  });

  it('refuses a trust it does not know when the tool is made', () => {
    expect(() => tool('x', { effect: 'read', trust: 'maybe' as never }, async () => 1)).toThrow('tool x: trust must be "trusted" or "untrusted"');
  });

  it('never changes how a call matches: a tool marked after its recording still replays', async () => {
    let ran = 0;
    const before = tool('fetch_page', { effect: 'read' }, async ({ url }: { url: string }) => (ran++, { url }));
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    await inRun(run.runId, () => before({ url: 'https://example.com/b' }));
    sidecar.endRun(run.runId, 'completed');
    const after = tool('fetch_page', { effect: 'read', trust: 'untrusted' }, async ({ url }: { url: string }) => (ran++, { url }));
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['agent'], cwd: '.' } });
    expect(await inRun(replay.runId, () => after({ url: 'https://example.com/b' }))).toEqual({ url: 'https://example.com/b' });
    const { summary } = sidecar.endRun(replay.runId, 'completed');
    expect(ran).toBe(1);
    expect(summary.divergence).toBeNull();
    expect(store.getCalls(replay.runId)[0]!.meta.trust).toBe('untrusted');
  });

  it.skipIf(!python())('is recorded on each call of a tool the Python SDK marks untrusted', async () => {
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: '.' } });
    const code = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(PY_SDK)})`,
      'from shadowlap import tool',
      '@tool(effect="read", trust="untrusted")',
      'def fetch_page(url: str) -> dict:',
      '    return {"url": url, "text": "a page"}',
      '@tool(effect="read")',
      'def search(query: str) -> list:',
      '    return [query]',
      'fetch_page("https://example.com/a")',
      'search("x")',
    ].join('\n');
    await promisify(execFile)(python()!, ['-c', code], { env: { ...process.env, ...sidecar.envFor(run.runId) }, encoding: 'utf8' });
    sidecar.endRun(run.runId, 'completed');
    expect(store.getCalls(run.runId).map((c) => [c.name, c.meta.trust ?? null])).toEqual([
      ['fetch_page', 'untrusted'],
      ['search', null],
    ]);
  });
});
