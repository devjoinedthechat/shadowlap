import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { recordBlame, Store } from '@shadowlap/engine';
import { fixKey, parseStoreUrl, pull, push, type SyncContext } from '@shadowlap/remote';
import { MemoryStore } from './fakes/memory.js';
import { blameReport, EXPECT, makeRun, ORACLE } from '../../engine/test/fix-fixtures.js';

/**
 * What a store keeps for its owner alone stays on this machine: the advice they put away in the
 * dashboard (dismissals) never goes up with a push, and a pull never brings anyone's down. And what
 * a pull does bring keeps what the store keeps of it here: a fix starts its checks with its own.
 */

const loc = parseStoreUrl('s3://agent-runs/team');

function machine(remote: MemoryStore, actor: string): SyncContext & { store: Store } {
  return { store: Store.open(':memory:'), remote, actor, now: () => Date.now() };
}

/** A failed run here, blamed: a fix opened with one blame. */
function blamed(store: Store): { run: string; fixId: string } {
  const run = makeRun(store, { labels: ['refund-bug'] });
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: `shadowlap blame ${run}`, title: 'Refunds above the limit issued without approval', checkText: 'issue_refund with {"amount":240} called 0 times', at: 2_000, actor: 'dana@northwind.example' });
  return { run, fixId: fix.fixId };
}

/** Every object in the bucket as text, a gzipped one unzipped. */
function bucketText(remote: MemoryStore): string {
  const text = (body: Buffer) => (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString('utf8');
  return [...remote.objects.entries()].map(([key, o]) => `${key}\n${text(o.body)}`).join('\n');
}

describe('what stays on this machine', () => {
  it('never sends the advice put away here, and a pull leaves what each machine put away as it was', async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run, fixId } = blamed(dana.store);
    dana.store.putDismissal({ key: 'retire claude-sonnet-4-5', facts: ['dana-only-2026-11-30', 'dana-only-goldens/refund-in-limit'], at: 3_000, actor: 'dana@northwind.example' });
    dana.store.putDismissal({ key: 'coverage', facts: ['dana-only-3f9a2c1d5e8b7a60'], at: 3_100, actor: 'dana@northwind.example' });
    // The run goes, and its fix with it, and nothing put away.
    const pushed = await push(dana, { all: true });
    expect(pushed.pushed).toEqual([run]);
    expect(pushed.fixes.sent).toEqual([fixId]);
    expect(remote.objects.has(fixKey(fixId))).toBe(true);
    const sent = bucketText(remote);
    expect(sent).toContain(run);
    for (const word of ['dana-only-', 'retire claude-sonnet-4-5']) expect(sent).not.toContain(word);

    // A teammate with advice of her own put away pulls the run and the fix: hers stays as it was, and no one else's arrives.
    const maya = machine(remote, 'maya@northwind.example');
    const hers = maya.store.putDismissal({ key: 'coverage', facts: ['maya-only-1db3eff9c2a04b17'], at: 4_000, actor: 'maya@northwind.example' });
    const before = maya.store.changeCounts().dismissals;
    const got = await pull(maya);
    expect(got.pulled).toEqual([run]);
    expect(got.fixes.pulled).toEqual([fixId]);
    expect(maya.store.listDismissals()).toEqual([hers]);
    expect(maya.store.changeCounts().dismissals).toBe(before);

    // And dana, pulling what the store has now, keeps hers.
    await pull(dana);
    expect(dana.store.listDismissals().map((d) => [d.key, d.facts])).toEqual([
      ['coverage', ['dana-only-3f9a2c1d5e8b7a60']],
      ['retire claude-sonnet-4-5', ['dana-only-2026-11-30', 'dana-only-goldens/refund-in-limit']],
    ]);
  });

  it('starts a pulled fix with the check it came with as its first, from when it was opened, by whoever opened it', async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { fixId } = blamed(dana.store);
    expect((await push(dana, { all: true })).fixes.sent).toEqual([fixId]);

    const maya = machine(remote, 'maya@northwind.example');
    await pull(maya);
    const fix = maya.store.getFix(fixId)!;
    expect(fix.check).toMatchObject({ expect: EXPECT, oracle: ORACLE });
    expect(maya.store.fixChecks(fixId)).toEqual([{ fixId, position: 0, at: 2_000, actor: 'dana@northwind.example', check: fix.check }]);
    // Pulled again, the fix is merged, not kept anew: still the one check.
    await pull(maya);
    expect(maya.store.fixChecks(fixId)).toHaveLength(1);
  });
});
