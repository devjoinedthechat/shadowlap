import { describe, expect, it } from 'vitest';
import { BLAME_DEFAULTS, fixRecords, gateResult, markFixApplied, PACK_LIMITS, recordBlame, recordRepair, recordVerdict, setFixTitle, SPRT_DEFAULTS, Store, type BlameReport, type SprtGate } from '@shadowlap/engine';
import { FIX_FORMAT, FIX_VERSION, fixDocHash, fixDocOf, fixKey, mergeFixDocs, parseFixDoc, parseStoreUrl, pull, pullRequestLocation, push, storeKey, type FixDoc, type SyncContext } from '@shadowlap/remote';
import { MemoryStore } from './fakes/memory.js';
import { blameReport, EXPECT, makeRun, ORACLE, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';

/**
 * Fixes travel with the team store: a blame, a repair and its verdicts made on one machine show on
 * a teammate's after a pull, a fix worked on from two machines ends up with what both did, and a
 * fix in the bucket is someone else's data, checked as strictly as a run.
 */

const loc = parseStoreUrl('s3://agent-runs/team');
const KEY = storeKey(loc);

function machine(remote: MemoryStore, actor: string): SyncContext & { store: Store } {
  return { store: Store.open(':memory:'), remote, actor, now: () => Date.now() };
}

/** A failed run here, blamed: a fix opened with one blame. */
function blamed(store: Store, labels = ['refund-bug']): { run: string; fixId: string } {
  const run = makeRun(store, { labels });
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: `shadowlap blame ${run}`, title: 'Refunds above the limit issued without approval', checkText: 'issue_refund with {"amount":240} called 0 times', actor: 'dana@northwind.example' });
  return { run, fixId: fix.fixId };
}

/** As if these runs had gone to the store: listed in its index. */
function inStore(store: Store, ...runIds: string[]): void {
  for (const runId of runIds) store.setTeamRun(KEY, { runId, state: 'pushed', at: 1, base: {}, baseHash: 'h', remoteHash: 'h', entry: { runId } });
}

describe('a fix in the team store', () => {
  it('goes with the runs it is about, and a teammate pulls it with its steps', async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run, fixId } = blamed(dana.store);
    // Its run is only here: the fix stays here too.
    expect((await push(dana, { runIds: [] })).fixes).toEqual({ sent: [], failed: [], repairs: [] });
    expect(remote.keysUnder('fixes/')).toEqual([]);
    inStore(dana.store, run);
    expect((await push(dana, { runIds: [] })).fixes).toEqual({ sent: [fixId], failed: [], repairs: [] });
    expect(remote.keysUnder('fixes/')).toEqual([fixKey(fixId)]);

    const maya = machine(remote, 'maya@northwind.example');
    const got = await pull(maya);
    expect(got.fixes).toMatchObject({ pulled: [fixId], merged: [], failed: [] });
    const fix = maya.store.getFix(fixId)!;
    expect(fix).toMatchObject({ title: 'Refunds above the limit issued without approval', labels: ['refund-bug'], status: 'open', check: { expect: EXPECT, oracle: ORACLE }, data: { openedBy: 'dana@northwind.example' } });
    const rec = fixRecords(maya.store, fix);
    expect(rec.failing).toEqual([run]);
    expect(rec.blames.map((b) => [b.runId, b.report.blamed?.callNo])).toEqual([[run, 5]]);
    // Both machines hold the same fix.
    expect(fixDocHash(fixDocOf(maya.store, fixId)!)).toBe(fixDocHash(fixDocOf(dana.store, fixId)!));
  });

  it("marks every blame and verdict a pull brings as pulled, a mark that stays on that machine: never sent, never taken from a document", async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run, fixId } = blamed(dana.store);
    const kept = recordVerdict(dana.store, { report: verifyReport([{ runId: run, role: 'target', pass: true }]), expect: EXPECT, command: `shadowlap verify --fixes ${run}`, rerun: { flags: ['--writes', 'block'], command: ['python', 'agent.py'] } });
    inStore(dana.store, run);
    await push(dana, { runIds: [] });
    // What dana made here is hers: nothing says it came from anywhere, and her flags went with it.
    expect(dana.store.getVerdict(kept.verdict.verifyId)!.pulled).toBeUndefined();
    const sent = JSON.parse(remote.objects.get(fixKey(fixId))!.body.toString('utf8')) as FixDoc;
    expect(sent.verdicts[0]).toMatchObject({ rerun: { flags: ['--writes', 'block'], command: ['python', 'agent.py'] } });
    expect(sent.verdicts[0]).not.toHaveProperty('pulled');

    const maya = machine(remote, 'maya@northwind.example');
    await pull(maya);
    const at = maya.store.getVerdict(kept.verdict.verifyId)!.pulled!;
    expect(at.from).toBe(KEY);
    expect(maya.store.getBlame(fixRecords(maya.store, maya.store.getFix(fixId)!).blames[0].blameId)!.pulled!.from).toBe(KEY);
    // Her copy goes back as it came: the mark is not in it, so the hash both sides agree on holds, and nothing is sent again.
    expect(fixDocOf(maya.store, fixId)!.verdicts[0]).not.toHaveProperty('pulled');
    expect(fixDocHash(fixDocOf(maya.store, fixId)!)).toBe(fixDocHash(fixDocOf(dana.store, fixId)!));
    expect((await push(maya, { runIds: [] })).fixes.sent).toEqual([]);

    // A document that says a record of its own was made here says nothing: the pull marks it all the same.
    const planted = { ...sent, verdicts: sent.verdicts.map((v) => ({ ...v, pulled: null })), blames: sent.blames.map((b) => ({ ...b, pulled: { from: 'here', at: 0 } })) };
    const parsed = parseFixDoc(Buffer.from(JSON.stringify(planted)), fixId);
    expect(parsed.verdicts[0]).not.toHaveProperty('pulled');
    expect(parsed.blames[0]).not.toHaveProperty('pulled');
  });

  it('sends nothing again that the store has, and reads only the fixes that changed there', async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run } = blamed(dana.store);
    inStore(dana.store, run);
    await push(dana, { runIds: [] });
    const maya = machine(remote, 'maya@northwind.example');
    await pull(maya);
    remote.log.length = 0;
    expect((await push(dana, { runIds: [] })).fixes.sent).toEqual([]);
    expect((await pull(maya)).fixes).toMatchObject({ pulled: [], merged: [] });
    expect(remote.log.filter((l) => l.key.startsWith('fixes/') && l.op !== 'list')).toEqual([]);
  });

  it("merges what each machine did: a teammate's repair turns the fix verified here, a title given here reaches them", async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run, fixId } = blamed(dana.store);
    inStore(dana.store, run);
    await push(dana, { runIds: [] });
    const maya = machine(remote, 'maya@northwind.example');
    await pull(maya);

    // Maya repairs it; the verdict counts, and the fix turns verified there.
    const report = repairReport({ targets: [run] });
    const repaired = recordRepair(maya.store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report, expect: EXPECT, command: `shadowlap repair --fixes ${run}` });
    expect(repaired.fixes.map((f) => [f.fix.fixId, f.fix.status])).toEqual([[fixId, 'verified']]);
    // Meanwhile Dana names it, and pushes first.
    setFixTitle(dana.store, fixId, 'Escalate refunds above the policy limit');
    expect((await push(dana, { runIds: [] })).fixes.sent).toEqual([fixId]);
    // Maya's push meets Dana's write: it merges with it rather than losing it.
    expect((await push(maya, { runIds: [] })).fixes.sent).toEqual([fixId]);
    const pulled = await pull(dana);
    expect(pulled.fixes).toMatchObject({ pulled: [], merged: [fixId], repairs: ['repair-munzln2i'] });
    for (const m of [dana, maya]) {
      if (m === maya) await pull(maya);
      const fix = m.store.getFix(fixId)!;
      expect(fix).toMatchObject({ status: 'verified', title: 'Escalate refunds above the policy limit', data: { titleEdited: true } });
      const rec = fixRecords(m.store, fix);
      expect(rec.repairs.map((r) => [r.repairId, r.dir, r.accepted])).toEqual([['repair-munzln2i', '.shadowlap/repairs/repair-munzln2i', true]]);
      expect(rec.verdicts.map((v) => v.verdict)).toEqual(['accepted']);
      expect(rec.blames).toHaveLength(1);
    }
    expect(fixDocHash(fixDocOf(dana.store, fixId)!)).toBe(fixDocHash(fixDocOf(maya.store, fixId)!));
    // A status only moves on: a verdict that rejects, made on one machine, doesn't take the fix back.
    recordVerdict(dana.store, { report: verifyReport([{ runId: run, role: 'target', pass: false }]), expect: EXPECT, command: 'shadowlap verify', fixIds: [fixId] });
    await push(dana, { runIds: [] });
    await pull(maya);
    expect(maya.store.getFix(fixId)!.status).toBe('verified');
    expect(fixRecords(maya.store, maya.store.getFix(fixId)!).verdicts.map((v) => v.verdict)).toEqual(['accepted', 'rejected']);
    // The repair is marked as made elsewhere where it came from the store, never where it was made.
    expect(dana.store.repairPulled('repair-munzln2i')).toMatchObject({ remote: KEY });
    expect(maya.store.repairPulled('repair-munzln2i')).toBeNull();
  });

  it('keeps applied on the machine whose working tree has the patch: the others have it verified, ready to apply', async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run, fixId } = blamed(dana.store);
    inStore(dana.store, run);
    await push(dana, { runIds: [] });
    const maya = machine(remote, 'maya@northwind.example');
    await pull(maya);
    recordRepair(maya.store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [run] }), expect: EXPECT, command: `shadowlap repair --fixes ${run}` });
    await push(maya, { runIds: [] });
    await pull(dana);
    expect(dana.store.getFix(fixId)!.status).toBe('verified');

    // Maya applies it in her working tree: nothing about that goes to the store.
    const applied = { patch: 'applied' as const, repairId: 'repair-munzln2i', goldens: ['goldens/refund-fixed'], tests: 'passed' as const, by: 'maya@northwind.example', via: 'fix apply' as const };
    markFixApplied(maya.store, fixId, applied, 9_000);
    expect((await push(maya, { runIds: [] })).fixes.sent).toEqual([]);
    const there = parseFixDoc(remote.objects.get(fixKey(fixId))!.body, fixId);
    expect(there.fix).toMatchObject({ status: 'verified', appliedAt: null });
    expect(there.fix.data.applied).toBeUndefined();
    expect(fixDocOf(maya.store, fixId)!.fix).toMatchObject({ status: 'verified', appliedAt: null });

    // Dana's tree doesn't have the patch: the fix stays verified there, its patch still to apply.
    await pull(dana);
    expect(dana.store.getFix(fixId)).toMatchObject({ status: 'verified', appliedAt: null });
    expect(dana.store.getFix(fixId)!.data.applied).toBeUndefined();

    // What Dana adds reaches Maya, whose fix stays applied as she applied it.
    setFixTitle(dana.store, fixId, 'Escalate refunds above the policy limit');
    expect((await push(dana, { runIds: [] })).fixes.sent).toEqual([fixId]);
    expect((await pull(maya)).fixes.merged).toEqual([fixId]);
    expect(maya.store.getFix(fixId)).toMatchObject({ title: 'Escalate refunds above the policy limit', status: 'applied', appliedAt: 9_000, data: { applied, titleEdited: true } });

    // A copy that says applied, as an older Shadowlap sent it, is verified on the machine that pulls it.
    const old = JSON.parse(remote.objects.get(fixKey(fixId))!.body.toString('utf8')) as FixDoc;
    old.fix = { ...old.fix, status: 'applied', appliedAt: 8_000, data: { ...old.fix.data, applied } };
    remote.objects.set(fixKey(fixId), { body: Buffer.from(JSON.stringify(old)), version: 'old', contentType: 'application/json' });
    const ravi = machine(remote, 'ravi@northwind.example');
    expect((await pull(ravi)).fixes.pulled).toEqual([fixId]);
    expect(ravi.store.getFix(fixId)).toMatchObject({ status: 'verified', appliedAt: null });
    expect(ravi.store.getFix(fixId)!.data.applied).toBeUndefined();
  });

  it("keeps out a fix it can't read, saying why, and brings the others", async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run, fixId } = blamed(dana.store);
    inStore(dana.store, run);
    await push(dana, { runIds: [] });
    const good = parseFixDoc(remote.objects.get(fixKey(fixId))!.body, fixId);
    const hostile = (id: string, change: (d: FixDoc) => unknown) => {
      const doc = JSON.parse(JSON.stringify({ ...good, fix: { ...good.fix, fixId: id } })) as FixDoc;
      remote.objects.set(fixKey(id), { body: Buffer.from(JSON.stringify(change(doc) ?? doc)), version: `x-${id}`, contentType: 'application/json' });
    };
    const ids = ['fx-01M3RZ0000000000000000000A', 'fx-01M3RZ0000000000000000000B', 'fx-01M3RZ0000000000000000000C', 'fx-01M3RZ0000000000000000000D', 'fx-01M3RZ0000000000000000000E'];
    hostile(ids[0], (d) => void (d.fix.title = 'owned\u001b]0;title\u0007'));
    hostile(ids[1], (d) => {
      const r = repairReport({ targets: [run], dir: '../../.ssh' });
      d.links.push({ kind: 'repair', ref: 'repair-evil', at: 1, data: null });
      d.repairs.push({ repairId: 'repair-evil', at: 1, dir: '../../.ssh', outcome: 'fixed', accepted: true, report: r, expect: null, command: '' });
    });
    hostile(ids[2], (d) => ({ ...d, fix: { ...d.fix, fixId: ids[0] } }));
    hostile(ids[3], (d) => ({ ...d, version: FIX_VERSION + 1 }));
    hostile(ids[4], (d) => void (d.blames[0].report.probes = 'all of them' as never));
    remote.objects.set('fixes/not-a-fix.json', { body: Buffer.from('{}'), version: 'y', contentType: 'application/json' });
    const maya = machine(remote, 'maya@northwind.example');
    const got = await pull(maya);
    expect(got.fixes.pulled).toEqual([fixId]);
    expect(got.fixes.failed.map((f) => [f.fixId, f.reason])).toEqual([
      [ids[0], expect.stringMatching(/fix\.title: must be one line|contains control characters/)],
      [ids[1], expect.stringMatching(/dir: must be \.shadowlap\/repairs\/repair-evil/)],
      [ids[2], expect.stringMatching(/holds another fix/)],
      [ids[3], expect.stringMatching(/is version 2; this Shadowlap reads version 1/)],
      [ids[4], expect.stringMatching(/probes: must be a list/)],
    ]);
    for (const id of ids) expect(maya.store.getFix(id)).toBeNull();
    // Tried again on the next pull, still refused.
    expect((await pull(maya)).fixes.failed).toHaveLength(5);
  });

  it("brings a blame decided by a gate, and keeps out one whose gate, decision or rate is malformed", async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const run = makeRun(dana.store, { labels: ['refund-bug'] });
    // The fixture's probes, decided by blame's gate as a blame now records them.
    const gate: SprtGate = { kind: 'sprt', ...BLAME_DEFAULTS };
    const base = blameReport(run);
    const decided = (p: NonNullable<BlameReport['blamed']>) => {
      const outcomes = p.attempts.map((a) => a.passed);
      const r = gateResult(gate, outcomes);
      return { ...p, decision: r.decision, gate: r };
    };
    const report: BlameReport = { ...base, gate, blamed: decided(base.blamed!), lost: decided(base.lost!), probes: base.probes.map(decided) };
    const { fix } = recordBlame(dana.store, { runId: run, report, expect: EXPECT, scope: null, command: `shadowlap blame ${run}`, title: 'Refunds above the limit issued without approval', checkText: 'issue_refund called 0 times', actor: 'dana@northwind.example' });
    inStore(dana.store, run);
    await push(dana, { runIds: [] });
    const good = parseFixDoc(remote.objects.get(fixKey(fix.fixId))!.body, fix.fixId);
    expect(good.blames[0].report.gate).toEqual(gate);
    expect(good.blames[0].report.probes[0].gate).toMatchObject({ kind: 'sprt', decision: expect.any(String), interval: { confidence: 0.95 } });

    const hostile = (id: string, change: (d: FixDoc) => void) => {
      const doc = JSON.parse(JSON.stringify({ ...good, fix: { ...good.fix, fixId: id } })) as FixDoc;
      change(doc);
      remote.objects.set(fixKey(id), { body: Buffer.from(JSON.stringify(doc)), version: `x-${id}`, contentType: 'application/json' });
    };
    const ids = ['fx-01M3RZ0000000000000000001A', 'fx-01M3RZ0000000000000000001C', 'fx-01M3RZ0000000000000000001D', 'fx-01M3RZ0000000000000000001E', 'fx-01M3RZ0000000000000000001F'];
    hostile(ids[0], (d) => void ((d.blames[0].report.probes[0] as { gate: unknown }).gate = {}));
    hostile(ids[1], (d) => void ((d.blames[0].report as { gate: unknown }).gate = { kind: 'sprt', good: 'most', bad: 0.1, risk: 0.05, max: 20 }));
    hostile(ids[2], (d) => void ((d.blames[0].report.probes[0] as { decision: unknown }).decision = 'probably'));
    hostile(ids[3], (d) => void delete (d.blames[0].report.probes[0].gate as { interval?: unknown }).interval);
    hostile(ids[4], (d) => void ((d.blames[0].report.probes[0].gate as { sentence: unknown }).sentence = 'passed\u001b[2J'));
    const maya = machine(remote, 'maya@northwind.example');
    const got = await pull(maya);
    expect(got.fixes.pulled).toEqual([fix.fixId]);
    expect(Object.fromEntries(got.fixes.failed.map((f) => [f.fixId, f.reason]))).toEqual({
      [ids[0]]: expect.stringMatching(/probes\[0\]\.gate\.kind: must be one of "sprt", "baseline"/),
      [ids[1]]: expect.stringMatching(/report\.gate\.good: must be a number/),
      [ids[2]]: expect.stringMatching(/probes\[0\]\.decision: must be one of "pass", "fail", "continue", "inconclusive"/),
      [ids[3]]: expect.stringMatching(/probes\[0\]\.gate\.interval: must be an object/),
      [ids[4]]: expect.stringMatching(/control characters|must be one line/),
    });
    // What it took reads as the dashboard shows it.
    expect(maya.store.getFix(fix.fixId)).not.toBeNull();
  });

  it("keeps out a fix whose verify ran a malformed gate", async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run, fixId } = blamed(dana.store);
    const gate: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS };
    const v = verifyReport([{ runId: run, role: 'target', pass: true }]);
    const gated = { ...v, gate, runs: v.runs.map((x) => ({ ...x, decision: 'pass' as const, gate: gateResult(gate, Array(12).fill(true)) })) };
    recordVerdict(dana.store, { report: gated, expect: EXPECT, command: `shadowlap verify --fixes ${run}` });
    inStore(dana.store, run);
    await push(dana, { runIds: [] });
    const good = parseFixDoc(remote.objects.get(fixKey(fixId))!.body, fixId);
    expect(good.verdicts[0].report.runs[0].gate).toMatchObject({ decision: 'pass', passes: 12 });
    const doc = JSON.parse(JSON.stringify(good)) as FixDoc;
    (doc.verdicts[0].report.runs[0].gate as { interval: unknown }).interval = { lo: 'low', hi: 1, confidence: 0.95 };
    expect(() => parseFixDoc(Buffer.from(JSON.stringify(doc)), fixId)).toThrow(/runs\[0\]\.gate\.interval\.lo: must be a number/);
  });

  it("keeps out a fix whose repair's patch is more than the change its candidate makes", async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run, fixId } = blamed(dana.store);
    inStore(dana.store, run);
    recordRepair(dana.store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [run] }), expect: EXPECT, command: `shadowlap repair --fixes ${run}` });
    await push(dana, { runIds: [] });
    const good = parseFixDoc(remote.objects.get(fixKey(fixId))!.body, fixId);
    expect(good.repairs).toHaveLength(1);
    const own = good.repairs[0].report.patch!;
    const evil = ['diff --git a/EVIL.txt b/EVIL.txt', 'new file mode 100644', '--- /dev/null', '+++ b/EVIL.txt', '@@ -0,0 +1 @@', '+from the bucket', ''].join('\n');
    const patches: Record<string, string> = {
      'fx-01M3RZ0000000000000000001A': own + evil,
      'fx-01M3RZ0000000000000000001B': own.split('agent.mjs').join('triage.mjs'),
      'fx-01M3RZ0000000000000000001C': own.replace('@@ -1,1 +1,1 @@', '@@ -1,1 +1,2 @@').replace(/^(\+You .*)$/m, "$1\n+require('child_process').execSync('id');"),
    };
    for (const [id, patch] of Object.entries(patches)) {
      const doc = JSON.parse(JSON.stringify({ ...good, fix: { ...good.fix, fixId: id } })) as FixDoc;
      doc.repairs[0].report.patch = patch;
      remote.objects.set(fixKey(id), { body: Buffer.from(JSON.stringify(doc)), version: `x-${id}`, contentType: 'application/json' });
    }
    const maya = machine(remote, 'maya@northwind.example');
    const got = await pull(maya);
    expect(got.fixes.pulled).toEqual([fixId]);
    expect(Object.fromEntries(got.fixes.failed.map((f) => [f.fixId, f.reason]))).toEqual({
      'fx-01M3RZ0000000000000000001A': expect.stringContaining('repairs[0].report.patch: must be the change its accepted candidate makes, but it changes agent.mjs and EVIL.txt, where its accepted candidate changes agent.mjs alone'),
      'fx-01M3RZ0000000000000000001B': expect.stringContaining('but it changes triage.mjs, where its accepted candidate changes agent.mjs alone'),
      'fx-01M3RZ0000000000000000001C': expect.stringContaining("but the lines it changes in agent.mjs are not its accepted candidate's rewrite"),
    });
    for (const id of Object.keys(patches)) expect(maya.store.getFix(id)).toBeNull();
    // Only the repair as it was made came: its patch is the one a pull writes beside the project.
    expect(got.fixes.repairs).toEqual(['repair-munzln2i']);
    expect(maya.store.getRepair('repair-munzln2i')!.report.patch).toBe(own);
  });

  it('keeps one too large to read out of a pull, and never writes one that large', async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run, fixId } = blamed(dana.store);
    inStore(dana.store, run);
    await push(dana, { runIds: [] });
    // Someone's fix in the bucket over what a pull reads (a run's run.json limit, 16 MB).
    const big = 'fx-01M3RZ0000000000000000000F';
    remote.objects.set(fixKey(big), { body: Buffer.alloc(PACK_LIMITS.manifestBytes + 1, 0x20), version: 'big', contentType: 'application/json' });
    const maya = machine(remote, 'maya@northwind.example');
    const got = await pull(maya);
    // The pull goes on: the other fix comes, this one is named with why, and it is tried again next time.
    expect(got.fixes.pulled).toEqual([fixId]);
    expect(got.fixes.failed).toEqual([{ fixId: big, reason: expect.stringMatching(new RegExp(`^fixes/${big}\\.json is over the ${PACK_LIMITS.manifestBytes} bytes a pull reads`)) }]);
    expect(maya.store.getFix(big)).toBeNull();
    expect((await pull(maya)).fixes.failed.map((f) => f.fixId)).toEqual([big]);

    // A fix here that has grown past it stays here, said so, while the others still go.
    const huge = makeRun(dana.store, { labels: ['long-answer'] });
    const report = blameReport(huge);
    report.contrast!.rescued = [{ type: 'text', text: 'x'.repeat(PACK_LIMITS.manifestBytes) }];
    const grown = recordBlame(dana.store, { runId: huge, report, expect: EXPECT, scope: null, command: `shadowlap blame ${huge}`, title: 'A long answer', checkText: 'x' }).fix.fixId;
    const small = blamed(dana.store, ['billing']);
    expect(new Set([fixId, grown, small.fixId]).size).toBe(3);
    inStore(dana.store, huge, small.run);
    const sent = await push(dana, { runIds: [] });
    expect(sent.fixes.sent).toEqual([small.fixId]);
    expect(sent.fixes.failed).toEqual([{ fixId: grown, reason: expect.stringMatching(new RegExp(`^it would be \\d+ bytes, over the ${PACK_LIMITS.manifestBytes} a pull reads, so it stays on this machine$`)) }]);
    expect(remote.keysUnder('fixes/')).not.toContain(fixKey(grown));

    // The store's copy too large to merge with: that fix is reported, the others go.
    setFixTitle(dana.store, fixId, 'Escalate refunds above the policy limit');
    remote.objects.set(fixKey(fixId), { body: Buffer.alloc(PACK_LIMITS.manifestBytes + 1, 0x20), version: 'big2', contentType: 'application/json' });
    setFixTitle(dana.store, small.fixId, 'Billing refunds');
    const again = await push(dana, { runIds: [] });
    expect(again.fixes.sent).toEqual([small.fixId]);
    expect(Object.fromEntries(again.fixes.failed.map((f) => [f.fixId, f.reason.split(' (')[0]]))).toEqual({
      [fixId]: `fixes/${fixId}.json is over the ${PACK_LIMITS.manifestBytes} bytes a pull reads`,
      [grown]: expect.stringMatching(/so it stays on this machine$/),
    });
  });

  it("is never sent from a pull request's job, nor taken from its folder", async () => {
    const remote = new MemoryStore(loc);
    const ci = machine(remote, 'ci');
    const { run, fixId } = blamed(ci.store);
    const pr = new MemoryStore(pullRequestLocation(loc, '42'));
    ci.store.setTeamRun(storeKey(pr.location), { runId: run, state: 'pushed', at: 1, base: {}, baseHash: 'h', remoteHash: 'h', entry: { runId: run } });
    expect((await push({ ...ci, remote: pr, pullRequest: '42' }, { runIds: [] })).fixes.sent).toEqual([]);
    expect(pr.keysUnder('fixes/')).toEqual([]);
    // Even one placed there by hand.
    const doc = fixDocOf(ci.store, fixId)!;
    pr.objects.set(fixKey(fixId), { body: Buffer.from(JSON.stringify(doc)), version: 'p1', contentType: 'application/json' });
    const dana = machine(remote, 'dana@northwind.example');
    expect((await pull({ ...dana, remote: pr, pullRequest: '42' })).fixes.pulled).toEqual([]);
    expect(dana.store.getFix(fixId)).toBeNull();
  });
});

describe('a fix renamed more than once', () => {
  it('keeps the latest rename, made on either machine, through each push and pull', async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const { run, fixId } = blamed(dana.store);
    inStore(dana.store, run);
    await push(dana, { runIds: [] });
    const maya = machine(remote, 'maya@northwind.example');
    await pull(maya);
    let at = Date.now();
    const rename = (m: { store: Store }, title: string) => setFixTitle(m.store, fixId, title, (at += 1000));
    const titles = () => [dana.store.getFix(fixId)!.title, maya.store.getFix(fixId)!.title];

    rename(dana, 'Refunds over 200 need approval');
    await push(dana, { runIds: [] });
    expect(dana.store.getFix(fixId)!.title).toBe('Refunds over 200 need approval');
    await pull(maya);
    expect(titles()).toEqual(['Refunds over 200 need approval', 'Refunds over 200 need approval']);

    // Renamed again: the store's copy already holds a title someone gave it.
    rename(maya, 'Refund agent skips the approval step');
    expect((await push(maya, { runIds: [] })).fixes.sent).toEqual([fixId]);
    expect(maya.store.getFix(fixId)!.title).toBe('Refund agent skips the approval step');
    await pull(dana);
    expect(titles()).toEqual(['Refund agent skips the approval step', 'Refund agent skips the approval step']);
    rename(dana, 'Approval step skipped above the limit');
    await push(dana, { runIds: [] });
    await pull(maya);
    expect(titles()).toEqual(['Approval step skipped above the limit', 'Approval step skipped above the limit']);

    // Renamed on both before either syncs: the later rename wins, on both.
    rename(dana, 'Dana’s name for it');
    rename(maya, 'Maya’s name for it');
    await push(dana, { runIds: [] });
    await push(maya, { runIds: [] });
    await pull(dana);
    expect(titles()).toEqual(['Maya’s name for it', 'Maya’s name for it']);
  });
});

describe('two copies of a fix', () => {
  it('join: links, reports and labels of both, the furthest status at its earliest time, a title given beating the one it opened with', () => {
    const a = Store.open(':memory:');
    const { run, fixId } = blamed(a, ['refund-bug']);
    const here = fixDocOf(a, fixId)!;
    const there: FixDoc = JSON.parse(JSON.stringify(here)) as FixDoc;
    there.fix.labels = ['billing'];
    there.fix.status = 'verified';
    there.fix.verifiedAt = 5_000;
    there.links.push({ kind: 'good', ref: '01M3RZ9999000000000000000Z', at: 9, data: null });
    here.fix.title = 'Named here';
    here.fix.data = { ...here.fix.data, titleEdited: true };
    const merged = mergeFixDocs(here, there);
    expect(merged.fix).toMatchObject({ title: 'Named here', labels: ['billing', 'refund-bug'], status: 'verified', verifiedAt: 5_000, data: { titleEdited: true } });
    expect(merged.links.map((l) => `${l.kind}:${l.ref}`).sort()).toEqual([`blame:${here.links.find((l) => l.kind === 'blame')!.ref}`, `failing:${run}`, 'good:01M3RZ9999000000000000000Z'].sort());
    // The same either way round, as far as what syncs.
    expect(fixDocHash(mergeFixDocs(there, here))).not.toBe('');
    expect(fixDocHash(mergeFixDocs(merged, there))).toBe(fixDocHash(merged));
    expect(fixDocHash(mergeFixDocs(merged, here))).toBe(fixDocHash(merged));
    expect(merged.format).toBe(FIX_FORMAT);
  });

  it("sends a model's stray control characters as U+FFFD, so a teammate's pull takes the report", async () => {
    const remote = new MemoryStore(loc);
    const dana = machine(remote, 'dana@northwind.example');
    const run = makeRun(dana.store, { labels: ['refund-bug'] });
    const report = blameReport(run);
    report.contrast!.rescued = [{ type: 'text', text: 'Above the limit.\r\nEscalating\u001b[1m now' }];
    recordBlame(dana.store, { runId: run, report, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'A refund', checkText: 'x' });
    inStore(dana.store, run);
    await push(dana, { runIds: [] });
    const maya = machine(remote, 'maya@northwind.example');
    const got = await pull(maya);
    expect(got.fixes.failed).toEqual([]);
    const fix = maya.store.listFixes()[0];
    const block = fixRecords(maya.store, fix).blames[0].report.contrast!.rescued[0] as { text: string };
    expect(block.text).toBe('Above the limit.\r\nEscalating�[1m now');
    // And it isn't sent again for that difference.
    expect((await push(dana, { runIds: [] })).fixes.sent).toEqual([]);
  });
});
