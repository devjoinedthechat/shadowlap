import { describe, expect, it } from 'vitest';
import { changeFixCheck, checkKey, fixRecords, recordBlame, recordVerdict, Store, type StoredFix } from '@shadowlap/engine';
import { fixDocHash, fixDocOf, mergeFixDocs, parseFixDoc, parseStoreUrl, pull, push, storeKey, type SyncContext } from '@shadowlap/remote';
import { MemoryStore } from './fakes/memory.js';
import { blameReport, EXPECT, makeRun, verifyReport } from '../../engine/test/fix-fixtures.js';

/**
 * A fix's check, changed on one machine (`shadowlap fix check`), reaches every teammate with the
 * checks it had before: the latest change wins on every machine, each keeps the whole history, and
 * the runs the new check judged otherwise leave the fix on each alike.
 */

const loc = parseStoreUrl('s3://agent-runs/team');
const KEY = storeKey(loc);
const EMAIL = { tools: { send_email: 1 } };
const emailCheck: StoredFix['check'] = { expect: EMAIL, key: checkKey(EMAIL), oracle: ['the agent exits 0', 'send_email called 1 time'], text: 'send_email called 1 time' };
const LOG = { tools: { refund_log: 1 } };
const logCheck: StoredFix['check'] = { expect: LOG, key: checkKey(LOG), oracle: ['the agent exits 0', 'refund_log called 1 time'], text: 'refund_log called 1 time' };

function machine(remote: MemoryStore, actor: string): SyncContext & { store: Store } {
  return { store: Store.open(':memory:'), remote, actor, now: () => Date.now() };
}

/** Two failed runs here, blamed into one fix, and listed in the store's index as pushed. */
function blamed(store: Store): { runs: string[]; fixId: string } {
  const runs = [makeRun(store, { labels: ['refund-bug'] }), makeRun(store, { labels: ['refund-bug'] })];
  let fixId = '';
  for (const [i, run] of runs.entries()) {
    fixId = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: `shadowlap blame ${run}`, title: 'Refunds above the limit issued without approval', checkText: 'issue_refund with {"amount":240} called 0 times', at: 2_000 + i, actor: 'dana@northwind.example', ci: null }).fix.fixId;
    store.setTeamRun(KEY, { runId: run, state: 'pushed', at: 1, base: {}, baseHash: 'h', remoteHash: 'h', entry: { runId: run } });
  }
  return { runs, fixId };
}

const history = (store: Store, fixId: string) => store.fixChecks(fixId).map((c) => [c.position, c.at, c.actor, c.check.key]);

describe("a fix's check in the team store", () => {
  it('sends a change, and a teammate pulls the check with the ones before it and the runs it left out', async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { runs, fixId } = blamed(dana.store);
    await push(dana, { runIds: [] });
    const maya = machine(remote, 'maya@northwind.example');
    await pull(maya);
    expect(history(maya.store, fixId)).toEqual([[0, 2_000, 'dana@northwind.example', checkKey(EXPECT)]]);

    changeFixCheck(dana.store, fixId, { check: emailCheck, judged: { failing: { [runs[0]]: 'failed', [runs[1]]: 'passed' }, good: {} }, at: 5_000, actor: 'dana@northwind.example' });
    expect((await push(dana, { runIds: [] })).fixes.sent).toEqual([fixId]);
    await pull(maya);
    expect(maya.store.getFix(fixId)!.check).toEqual(emailCheck);
    expect(history(maya.store, fixId)).toEqual([
      [0, 2_000, 'dana@northwind.example', checkKey(EXPECT)],
      [1, 5_000, 'dana@northwind.example', emailCheck.key],
    ]);
    // How it judged the runs travels: the run it passes left the fix on maya's machine too.
    const rec = fixRecords(maya.store, maya.store.getFix(fixId)!);
    expect([rec.failing, rec.left.failing]).toEqual([[runs[0]], [runs[1]]]);
    expect(fixDocHash(fixDocOf(maya.store, fixId)!)).toBe(fixDocHash(fixDocOf(dana.store, fixId)!));

    // Pulled again, nothing grows.
    await pull(maya);
    await push(maya, { runIds: [] });
    await pull(dana);
    expect(history(maya.store, fixId)).toHaveLength(2);
    expect(history(dana.store, fixId)).toHaveLength(2);
  });

  it('keeps the latest change, made on either machine, on both, with every check either gave', async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { runs, fixId } = blamed(dana.store);
    await push(dana, { runIds: [] });
    const maya = machine(remote, 'maya@northwind.example');
    await pull(maya);
    const judged = { failing: Object.fromEntries(runs.map((r) => [r, 'failed' as const])), good: {} };
    // Both change it before either syncs: maya's is the later.
    changeFixCheck(dana.store, fixId, { check: emailCheck, judged, at: 5_000, actor: 'dana@northwind.example' });
    changeFixCheck(maya.store, fixId, { check: logCheck, judged, at: 6_000, actor: 'maya@northwind.example' });
    await push(dana, { runIds: [] });
    await push(maya, { runIds: [] });
    await pull(dana);
    for (const m of [dana, maya]) {
      expect(m.store.getFix(fixId)!.check).toEqual(logCheck);
      expect(history(m.store, fixId).map((h) => h.slice(1))).toEqual([
        [2_000, 'dana@northwind.example', checkKey(EXPECT)],
        [5_000, 'dana@northwind.example', emailCheck.key],
        [6_000, 'maya@northwind.example', logCheck.key],
      ]);
    }
  });

  it('merges a copy from before checks synced as one with the check it holds, from when it was opened', () => {
    const store = Store.open(':memory:');
    const { fixId } = blamed(store);
    const doc = fixDocOf(store, fixId)!;
    const { checks: _none, ...old } = doc;
    const parsed = parseFixDoc(Buffer.from(JSON.stringify(old)), fixId);
    expect(parsed.checks).toBeUndefined();
    expect(fixDocHash(parsed)).toBe(fixDocHash(doc));
    expect(mergeFixDocs(doc, parsed).checks).toEqual([{ at: 2_000, actor: 'dana@northwind.example', check: doc.fix.check, judged: null }]);
    // A history that doesn't read is refused whole, as any field of a fix is.
    expect(() => parseFixDoc(Buffer.from(JSON.stringify({ ...doc, checks: [{ ...doc.checks![0], judged: { failing: { 'not-a-run': 'passed' }, good: {} } }] })), fixId)).toThrow(/checks/);
    expect(() => parseFixDoc(Buffer.from(JSON.stringify({ ...doc, checks: [{ ...doc.checks![0], judged: { failing: {}, good: { [doc.links[0].ref]: 'fixed' } } }] })), fixId)).toThrow(/checks/);
    store.close();
  });

  // A teammate changes an open fix's check while this machine verifies it under the one before.
  for (const order of ['changed before the verdict', 'changed after the verdict'] as const) {
    it(`keeps the check a verified fix's verdict counted under, ${order}, on both machines`, async () => {
      const remote = new MemoryStore(loc);
      const dana = machine(remote, 'dana@northwind.example');
      const { runs, fixId } = blamed(dana.store);
      await push(dana, { runIds: [] });
      const maya = machine(remote, 'maya@northwind.example');
      await pull(maya);
      const verifiedAt = order === 'changed before the verdict' ? 6_000 : 4_000;
      changeFixCheck(maya.store, fixId, { check: emailCheck, judged: { failing: { [runs[0]]: 'passed', [runs[1]]: 'failed' }, good: {} }, at: 5_000, actor: 'maya@northwind.example' });
      const v = recordVerdict(dana.store, { report: verifyReport(runs.map((runId) => ({ runId, role: 'target' as const, pass: true }))), expect: EXPECT, command: 'shadowlap verify', at: verifiedAt });
      expect(v.fixes[0]).toMatchObject({ standing: { counts: true }, fix: { status: 'verified' } });
      await push(maya, { runIds: [] });
      await push(dana, { runIds: [] });
      await pull(maya);
      for (const m of [dana, maya]) {
        const fix = m.store.getFix(fixId)!;
        expect(fix).toMatchObject({ status: 'verified', check: { key: checkKey(EXPECT) } });
        const rec = fixRecords(m.store, fix);
        // Every check is kept, the verdict's last; no run left the fix, and the verdict counts.
        expect(rec.checks.map((c) => c.check.key)).toEqual([emailCheck.key, checkKey(EXPECT)]);
        expect(rec.failing).toEqual(runs);
        expect(rec.standing.get(v.verdict.verifyId)).toEqual({ counts: true, why: null });
      }
      expect(fixDocHash(fixDocOf(maya.store, fixId)!)).toBe(fixDocHash(fixDocOf(dana.store, fixId)!));
    });
  }
});
