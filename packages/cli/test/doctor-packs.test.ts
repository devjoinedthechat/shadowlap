import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { packRun, Store } from '@shadowlap/engine';
import { runDoctor } from '../src/doctor.js';

/**
 * doctor holds the checks under `tests` against the goldens twice over: the tools and values their
 * rules name, and the verdicts their judge checks need. Reading a pack unpacks it into a store of its
 * own and checks every blob's hash, so each is read once for both, and closed after.
 */
const { reads } = vi.hoisted(() => ({ reads: [] as Array<{ dir: string; closed: boolean }> }));
vi.mock('../src/check-recordings.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/check-recordings.js')>();
  return {
    ...real,
    packRecording: (dir: string) => {
      const read = real.packRecording(dir);
      const seen = { dir, closed: false };
      reads.push(seen);
      const close = read.store.close.bind(read.store);
      read.store.close = () => {
        seen.closed = true;
        close();
      };
      return read;
    },
  };
});

const guardDir = fileURLToPath(new URL('../guard/', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'fp-doctor-packs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A golden that looked an order up, packed at goldens/<name>. */
function pack(name: string): void {
  const store = Store.open(':memory:');
  try {
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: dir } });
    const id = { kind: 'tool' as const, name: 'lookup_order', fingerprint: '1'.padStart(64, '0'), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: 1, ...id, origin: 'live', effect: 'read', requestRef: store.putJson({ args: { order_id: name } }), meta: {}, at: 1 });
    store.appendCallEnd(id, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putJson({ result: { total: 240 } }), outcome: 'ok', meta: {}, at: 1 });
    store.endRun(run.runId, 'completed');
    packRun(store, run.runId, join(dir, 'goldens', name));
  } finally {
    store.close();
  }
}

describe('doctor and the goldens', () => {
  it('reads each pack once, for the check rules and the judge checks alike, and closes it', () => {
    pack('refund');
    pack('small');
    const judge = { name: 'explains', question: 'Does the reply say why?', model: 'gpt-4.1-mini' };
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/*': { expect: { tools: { lookup_ordr: 1 }, judge: [judge] } } } }));
    const checks = runDoctor({ cwd: dir, env: {}, version: '0.1.0', guardDir, python: () => 'Python 3.12.1' });
    // Both held the packs: the rule's misspelt tool, and the verdict neither golden holds.
    expect(checks.filter((c) => c.name === 'check rules')).toEqual([expect.objectContaining({ detail: expect.stringMatching(/names lookup_ordr, which no recording called or offered to its model \(2 packs\)/), fix: expect.stringMatching(/^Did you mean lookup_order\?/) })]);
    expect(checks.filter((c) => c.name === 'judge verdicts').map((c) => c.detail.split(' holds ')[0])).toEqual(['goldens/refund', 'goldens/small']);
    expect(reads.map((r) => r.dir).sort()).toEqual([join(dir, 'goldens', 'refund'), join(dir, 'goldens', 'small')]);
    expect(reads.every((r) => r.closed)).toBe(true);
  });
});
