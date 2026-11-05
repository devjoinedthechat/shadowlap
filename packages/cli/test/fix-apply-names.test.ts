import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markFixApplied, recordBlame, recordRepair, Store, type StoredFix } from '@shadowlap/engine';
import { AFTER, BEFORE, blameReport, EXPECT, makeRun, repairReport } from '../../engine/test/fix-fixtures.js';
import { ApplyError, applyFix, type ApplyOptions } from '../src/fix-apply.js';
import { parseNameFlag, type GivenName } from '../src/fix-apply-names.js';

/**
 * `fix apply <fix> --name <run>=<name>`: each recording of the fixed runs goes into the goldens
 * folder under the name it is given, else the one the fix's label makes, and a name that won't do
 * is refused before anything changes.
 */

let project: string;
let store: Store;
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-fix-apply-names-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  writeFileSync(join(project, 'agent.mjs'), `${BEFORE}\n`);
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\nshadowlap.db*\n');
  git('init', '-q', '-b', 'main');
  git('add', 'agent.mjs', '.gitignore');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'agent');
  store = Store.open(join(project, 'shadowlap.db'));
});
afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const REPAIR = 'repair-mv9gxsdm';
const DIR = `.shadowlap/repairs/${REPAIR}`;

/**
 * A fix a repair verified, having fixed `runs` failing runs labelled `label` (none for null): its
 * patch in fix.patch, a recording of each fixed run in its goldens/. `runs` by their short ids, `ids` whole.
 */
function verified(o: { label?: string | null; runs?: number } = {}): { fix: StoredFix; runs: string[]; ids: string[] } {
  const labels = o.label === null ? [] : [o.label ?? 'refund-over-limit'];
  const runs = Array.from({ length: o.runs ?? 1 }, () => makeRun(store, { labels }));
  recordBlame(store, { runId: runs[0], report: blameReport(runs[0]), expect: EXPECT, scope: null, command: 'c', title: 'Refunds over the limit', checkText: 'x' });
  const report = repairReport({ targets: runs, dir: DIR });
  mkdirSync(join(project, DIR), { recursive: true });
  writeFileSync(join(project, DIR, 'fix.patch'), report.patch!);
  for (const g of report.output.goldens) {
    mkdirSync(join(project, g), { recursive: true });
    writeFileSync(join(project, g, 'run.json'), `{"recording":"${g}"}\n`);
  }
  const fix = recordRepair(store, { repairId: REPAIR, dir: DIR, report, expect: EXPECT, command: 'r' }).fixes[0].fix;
  return { fix, runs: runs.map((r) => r.slice(0, 10)), ids: runs };
}

const options = (lines: string[], names: GivenName[] = []): ApplyOptions => ({ cwd: project, goldens: 'goldens', names, test: false, build: null, db: join(project, 'shadowlap.db'), log: (l) => lines.push(l) });
const agentText = () => readFileSync(join(project, 'agent.mjs'), 'utf8');

/** Why apply refused the names, having changed nothing: the patch out, no golden copied. */
async function refused(fix: StoredFix, names: GivenName[]): Promise<string> {
  const err = await applyFix(store, fix, options([], names)).catch((e: unknown) => e);
  if (!(err instanceof ApplyError)) throw new Error(`not refused: ${JSON.stringify(err)}`);
  expect(err.exitCode).toBe(2);
  expect(agentText()).toBe(`${BEFORE}\n`);
  expect(store.getFix(fix.fixId)!.status).toBe('verified');
  return err.message;
}

describe('fix apply --name', () => {
  it('copies each recording under the name it is given, the fix’s label naming the rest, numbered', async () => {
    const { fix, runs } = verified({ runs: 2 });
    const lines: string[] = [];
    const result = await applyFix(store, fix, options(lines, [{ run: runs[0], name: 'refund-in-limit' }]));
    expect(result.goldens).toEqual([
      { run: runs[0], from: `${DIR}/goldens/${runs[0]}`, to: 'goldens/refund-in-limit', copied: true },
      { run: runs[1], from: `${DIR}/goldens/${runs[1]}`, to: 'goldens/refund-over-limit-2', copied: true },
    ]);
    expect(lines).toContain(`  copied goldens/refund-in-limit from ${runs[0]}`);
    expect(lines).toContain(`  copied goldens/refund-over-limit-2 from ${runs[1]}`);
    expect(readFileSync(join(project, 'goldens', 'refund-in-limit', 'run.json'), 'utf8')).toContain(runs[0]);
    // Each kept with the run it holds a recording of, so a later apply finds it under its name.
    expect(store.getFix(fix.fixId)!.data.applied).toMatchObject({ goldens: ['goldens/refund-in-limit', 'goldens/refund-over-limit-2'], from: { 'goldens/refund-in-limit': runs[0], 'goldens/refund-over-limit-2': runs[1] } });
  });

  it('names the golden after the fix’s title when its runs carry no label', async () => {
    const { fix } = verified({ label: null });
    expect((await applyFix(store, fix, options([]))).goldens.map((g) => g.to)).toEqual(['goldens/refunds-over-the-limit']);
  });

  it('takes a run by its whole id', async () => {
    const { fix, ids } = verified();
    expect((await applyFix(store, fix, options([], [{ run: ids[0], name: 'refund-twice' }]))).goldens.map((g) => g.to)).toEqual(['goldens/refund-twice']);
  });

  it('takes a run by the start of its id', async () => {
    const { fix, ids } = verified({ label: 'double-email' });
    expect((await applyFix(store, fix, options([], [{ run: ids[0].slice(0, 8), name: 'email-twice' }]))).goldens.map((g) => g.to)).toEqual(['goldens/email-twice']);
  });

  it('refuses a name that won’t do before anything changes, saying how to name it', async () => {
    const { fix, runs } = verified({ runs: 2 });
    const [a, b] = runs as [string, string];
    const how = (run: string) => `Nothing was changed: name the recording of ${run} with --name ${run}=<name>`;
    expect(await refused(fix, [{ run: a, name: 'Refund_Bug' }])).toBe(`A golden’s name takes lower-case letters, digits and hyphens. ${how(a)}`);
    expect(await refused(fix, [{ run: b, name: '' }])).toBe(`Give each golden a name. ${how(b)}`);
    expect(await refused(fix, [{ run: b, name: 'refund-over-limit-1' }])).toBe(`Each golden needs a name of its own. ${how(b)}`);
    // Taken in the goldens folder, read without case, as macOS and Windows read it: the label's own names too.
    mkdirSync(join(project, 'goldens', 'Refund-Over-Limit-1'), { recursive: true });
    expect(await refused(fix, [])).toBe(`goldens/refund-over-limit-1 is taken: pick another name. ${how(a)}`);
    expect(await refused(fix, [{ run: b, name: 'refund-over-limit-1' }, { run: a, name: 'refund-in-limit' }])).toBe(`goldens/refund-over-limit-1 is taken: pick another name. ${how(b)}`);
    // A run whose recording apply doesn't copy, one named twice, and the start of both.
    expect(await refused(fix, [{ run: '01ZZZZ', name: 'x' }])).toBe(`--name 01ZZZZ=x: 01ZZZZ is not a run apply copies the recording of: it copies those of ${a}, ${b}`);
    expect(await refused(fix, [{ run: a, name: 'x' }, { run: a, name: 'y' }])).toBe(`the recording of ${a} is named twice: give it one --name`);
    expect(await refused(fix, [{ run: '01M3RZ', name: 'x' }])).toBe(`--name 01M3RZ=x: 01M3RZ is the start of more than one run apply copies the recording of (${a}, ${b}): give more of its id`);
    expect(existsSync(join(project, 'goldens', 'x'))).toBe(false);
    // Once the names will do, it goes in.
    const result = await applyFix(store, fix, options([], [{ run: a, name: 'refund-in-limit' }]));
    expect(result.goldens.map((g) => g.to)).toEqual(['goldens/refund-in-limit', 'goldens/refund-over-limit-2']);
  });

  it('finds the goldens an earlier apply named, copies the rest, and names none of them again', async () => {
    const { fix, runs } = verified({ runs: 2 });
    const [a, b] = runs as [string, string];
    // Applied before: the patch is in, and the first golden was copied under a name of its own.
    mkdirSync(join(project, 'goldens', 'refund-in-limit'), { recursive: true });
    writeFileSync(join(project, 'agent.mjs'), `${AFTER}\n`);
    const applied = markFixApplied(store, fix.fixId, { patch: 'applied', repairId: REPAIR, goldens: ['goldens/refund-in-limit'], tests: 'failed', via: 'fix apply', from: { 'goldens/refund-in-limit': a } });
    expect(await applyFix(store, applied, options([], [{ run: a, name: 'another' }])).catch((e: unknown) => (e as Error).message)).toBe(`the recording of ${a} was copied before, to goldens/refund-in-limit, and keeps that name: --name names one apply copies now`);
    const lines: string[] = [];
    const result = await applyFix(store, applied, options(lines));
    expect(result).toMatchObject({ again: true, goldens: [{ run: a, to: 'goldens/refund-in-limit', copied: false }, { run: b, to: 'goldens/refund-over-limit-2', copied: true }] });
    expect(lines).toContain('  already there: goldens/refund-in-limit');
    expect(store.getFix(fix.fixId)!.data.applied).toMatchObject({ goldens: ['goldens/refund-in-limit', 'goldens/refund-over-limit-2'], from: { 'goldens/refund-in-limit': a, 'goldens/refund-over-limit-2': b } });
  });

  it('finds the recording an apply stopped part way copied, under whatever name it gave it, rather than taken', async () => {
    const { fix, runs } = verified({ runs: 2 });
    const [a, b] = runs as [string, string];
    // Stopped after it copied the first under the name the dialog gave it, before it marked the fix applied.
    mkdirSync(join(project, 'goldens', 'refund-twice'), { recursive: true });
    writeFileSync(join(project, 'goldens', 'refund-twice', 'run.json'), readFileSync(join(project, DIR, 'goldens', a, 'run.json')));
    // That copy keeps its name: another for it is refused, and none of the rest may take it.
    expect(await refused(fix, [{ run: a, name: 'refund-again' }])).toBe(`the recording of ${a} was copied before, to goldens/refund-twice, and keeps that name: --name names one apply copies now`);
    expect(await refused(fix, [{ run: b, name: 'refund-twice' }])).toBe(`goldens/refund-twice is taken: pick another name. Nothing was changed: name the recording of ${b} with --name ${b}=<name>`);
    // The same command again names where it went; with no --name, it is found there all the same.
    const lines: string[] = [];
    const again = await applyFix(store, fix, options(lines, [{ run: a, name: 'refund-twice' }, { run: b, name: 'refund-once' }]));
    expect(again.goldens).toEqual([
      { run: a, from: `${DIR}/goldens/${a}`, to: 'goldens/refund-twice', copied: false },
      { run: b, from: `${DIR}/goldens/${b}`, to: 'goldens/refund-once', copied: true },
    ]);
    expect(lines).toContain('  already there: goldens/refund-twice');
    expect(existsSync(join(project, 'goldens', 'refund-over-limit-1'))).toBe(false);
    expect(store.getFix(fix.fixId)!.data.applied).toMatchObject({ from: { 'goldens/refund-twice': a, 'goldens/refund-once': b } });
  });

  it('finds it with no --name given, under the name the label gave it or any other', async () => {
    const { fix, runs } = verified();
    mkdirSync(join(project, 'goldens', 'email-twice'), { recursive: true });
    writeFileSync(join(project, 'goldens', 'email-twice', 'run.json'), readFileSync(join(project, DIR, 'goldens', runs[0], 'run.json')));
    const result = await applyFix(store, fix, options([]));
    expect(result.goldens).toEqual([{ run: runs[0], from: `${DIR}/goldens/${runs[0]}`, to: 'goldens/email-twice', copied: false }]);
    expect(existsSync(join(project, 'goldens', 'refund-over-limit'))).toBe(false);
  });

  it('keeps a recording repair --goldens copied under its run’s name where it is, and names it no other', async () => {
    const { fix, runs } = verified({ runs: 2 });
    const [a, b] = runs as [string, string];
    mkdirSync(join(project, 'goldens', b), { recursive: true });
    expect(await refused(fix, [{ run: b, name: 'refund-twice' }])).toBe(`the recording of ${b} was copied before, to goldens/${b}, and keeps that name: --name names one apply copies now`);
    const lines: string[] = [];
    const result = await applyFix(store, fix, options(lines));
    expect(result.goldens).toEqual([
      { run: a, from: `${DIR}/goldens/${a}`, to: 'goldens/refund-over-limit-1', copied: true },
      { run: b, from: `${DIR}/goldens/${b}`, to: `goldens/${b}`, copied: false },
    ]);
    expect(lines).toContain(`  already there: goldens/${b}`);
  });

  it("names none of a teammate's repair's recordings, which stay on the machine that ran it", async () => {
    const { fix, runs } = verified();
    store.markRepairPulled('s3://northwind-agent-runs/support-agent', REPAIR);
    expect(await refused(fix, [{ run: runs[0], name: 'refund-bug' }])).toBe(`the recordings ${REPAIR} made stay on the machine that ran it, which came with a pull: --name names none here`);
  });

  it('reads --name as <run>=<name>', () => {
    expect(parseNameFlag('01K5CQ2E8M=double-email')).toEqual({ run: '01K5CQ2E8M', name: 'double-email' });
    expect(parseNameFlag(' 01K5CQ2E8M = double-email ')).toEqual({ run: '01K5CQ2E8M', name: 'double-email' });
    expect(parseNameFlag('01K5CQ2E8M=')).toEqual({ run: '01K5CQ2E8M', name: '' });
    expect(parseNameFlag('01K5CQ2E8M=a=b')).toEqual({ run: '01K5CQ2E8M', name: 'a=b' });
    for (const bad of ['double-email', '=double-email', ' =x', '']) expect(parseNameFlag(bad)).toBeNull();
  });
});
