import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packRun, plain, recordBlame, recordRepair, Store, unifiedDiff, type RepairReport } from '@shadowlap/engine';
import { fixDetail, patchInTree } from '@shadowlap/dashboard';
import { AFTER, BEFORE, blameReport, EXPECT, makeRun, repairReport } from '../../engine/test/fix-fixtures.js';
import { ApplyError, applyFix } from '../src/fix-apply.js';
import { formatFixDetail } from '../src/fix-format.js';

/** `fix apply` on a fix `repair --apply` applied: it finishes what was left, where it was left. */

let project: string;
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'fp-fix-apply-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  writeFileSync(join(project, 'agent.mjs'), `${BEFORE}\n`);
  git('init', '-q', '-b', 'main');
  git('add', 'agent.mjs');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'agent');
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('fix apply after repair --apply', () => {
  it('tests the goldens --goldens already put in the project, where they are, and copies none again', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      const run = makeRun(store, { labels: ['refund-over-limit'] });
      recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x' });
      const dir = '.shadowlap/repairs/repair-mv9gxsdm';
      const report = repairReport({ targets: [run], applied: true, dir });
      const name = run.slice(0, 10);
      // What repair --apply --goldens tests/goldens left: the change in the tree, the recordings copied.
      mkdirSync(join(project, dir, 'goldens', name), { recursive: true });
      writeFileSync(join(project, dir, 'fix.patch'), report.patch!);
      mkdirSync(join(project, 'tests', 'goldens', name), { recursive: true });
      writeFileSync(join(project, 'agent.mjs'), `${AFTER}\n`);
      const fix = recordRepair(store, { repairId: 'repair-mv9gxsdm', dir, report, expect: EXPECT, command: 'r', goldensCopied: [`tests/goldens/${name}`] }).fixes[0]!.fix;
      expect(fix).toMatchObject({ status: 'applied', data: { applied: { via: 'repair --apply', goldens: [`tests/goldens/${name}`], tests: 'skipped' } } });

      const lines: string[] = [];
      const result = await applyFix(store, fix, { cwd: project, goldens: 'goldens', test: true, build: null, db: join(project, 'shadowlap.db'), log: (l) => lines.push(l) });
      expect(result).toMatchObject({ status: 'applied', again: true, patch: 'already', goldens: [{ from: `${dir}/goldens/${name}`, to: `tests/goldens/${name}`, copied: false }] });
      // These folders are not real recordings, so the test fails: what matters is where it looked.
      expect(result.tests).toBe('failed');
      expect(lines).toContain(`  shadowlap test tests/goldens/${name}`);
      expect(existsSync(join(project, 'goldens'))).toBe(false);
      expect(store.getFix(fix.fixId)).toMatchObject({ status: 'applied', appliedAt: fix.appliedAt, data: { applied: { patch: 'applied', goldens: [`tests/goldens/${name}`], tests: 'failed', via: 'fix apply' } } });
    } finally {
      store.close();
    }
  });

  it('copies goldens afresh when the store names a place outside the project for them', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      const run = makeRun(store, { labels: ['refund-over-limit'] });
      recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x' });
      const dir = '.shadowlap/repairs/repair-mv9gxsdm';
      const report = repairReport({ targets: [run], applied: true, dir });
      const name = run.slice(0, 10);
      mkdirSync(join(project, dir, 'goldens', name), { recursive: true });
      writeFileSync(join(project, dir, 'fix.patch'), report.patch!);
      writeFileSync(join(project, 'agent.mjs'), `${AFTER}\n`);
      const fix = recordRepair(store, { repairId: 'repair-mv9gxsdm', dir, report, expect: EXPECT, command: 'r', goldensCopied: [`../elsewhere/${name}`] }).fixes[0]!.fix;
      const lines: string[] = [];
      const result = await applyFix(store, fix, { cwd: project, goldens: 'goldens', test: true, build: null, db: join(project, 'shadowlap.db'), log: (l) => lines.push(l) });
      expect(result.goldens).toEqual([{ from: `${dir}/goldens/${name}`, to: `goldens/${name}`, copied: true }]);
      expect(lines).toContain(`  shadowlap test goldens/${name}`);
    } finally {
      store.close();
    }
  });
});

describe('fix show of a verified fix whose patch is in the working tree already', () => {
  it('says applying only marks it applied, with the goldens it copies and runs, and offers no git apply to copy', () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      const run = makeRun(store, { labels: ['refund-over-limit'] });
      recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x' });
      const dir = '.shadowlap/repairs/repair-mv9gxsdm';
      const fix = recordRepair(store, { repairId: 'repair-mv9gxsdm', dir, report: repairReport({ targets: [run], dir }), expect: EXPECT, command: 'r' }).fixes[0]!.fix;
      expect(fix.status).toBe('verified');
      const shown = () => formatFixDetail(fixDetail(store, fix.fixId, { patchInTree: (patch) => patchInTree(project, patch) })!, plain);
      expect(shown()).toContain(`next: shadowlap fix apply ${fix.fixId.slice(0, 13)}   (or by hand: git -c core.autocrlf=false apply ${dir}/fix.patch)`);
      // A pull request merged it: agent.mjs has the change.
      writeFileSync(join(project, 'agent.mjs'), `${AFTER}\n`);
      expect(shown()).toContain(`next: shadowlap fix apply ${fix.fixId.slice(0, 13)} (its patch is in your working tree already: copies the goldens it is missing, runs them and marks it applied)`);
      expect(shown()).not.toContain('git apply');
    } finally {
      store.close();
    }
  });
});

/**
 * A project whose agent writes RAN when it runs, with a golden of it that apply's check of the
 * other goldens replays, and a fix verified by a repair that came with a pull. `patch` is what a
 * bucket writer left in the repair's report (and the pull wrote to fix.patch).
 */
function teammateFix(store: Store, patch: (own: string) => string, o: { pulled?: boolean } = {}) {
  const agent = `const system = '${BEFORE}';\nimport('node:fs').then((fs) => fs.writeFileSync(new URL('./RAN', import.meta.url), system));\n`;
  writeFileSync(join(project, 'agent.mjs'), agent);
  writeFileSync(join(project, 'triage.mjs'), '// The triage agent\nexport const ticket = 1;\n');
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\nshadowlap.db*\ngoldens/\nRAN\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' });
  git('add', '-f', 'agent.mjs', 'triage.mjs', '.gitignore');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'agents');
  // A golden of the agent, recorded before the fix: the check of the other goldens replays it.
  const golden = makeRun(store, { status: 'completed' });
  packRun(store, golden, join(project, 'goldens', 'before-fix'));
  const run = makeRun(store, { labels: ['refund-over-limit'] });
  recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x' });
  const dir = '.shadowlap/repairs/repair-mv9gxsdm';
  const report: RepairReport = repairReport({ targets: [run], dir });
  report.patch = patch(unifiedDiff('agent.mjs', agent, agent.replace(BEFORE, AFTER)));
  // What a pull writes: the patch and the reports, never the goldens.
  mkdirSync(join(project, dir), { recursive: true });
  writeFileSync(join(project, dir, 'fix.patch'), report.patch);
  const fix = recordRepair(store, { repairId: 'repair-mv9gxsdm', dir, report, expect: EXPECT, command: 'r' }).fixes[0]!.fix;
  if (o.pulled !== false) store.markRepairPulled('s3://northwind-agent-runs/support-agent', 'repair-mv9gxsdm');
  return { fix, agent };
}
const status = () => execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' });
const options = (lines: string[], build: string | null = null) => ({ cwd: project, goldens: 'goldens', test: true, build, db: join(project, 'shadowlap.db'), log: (l: string) => lines.push(l) });

describe("fix apply of a teammate's repair, from the team store", () => {
  it('puts the patch in, says its recordings stay on the machine that ran it, and leaves nothing to finish', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      const run = makeRun(store, { labels: ['refund-over-limit'] });
      recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x' });
      const dir = '.shadowlap/repairs/repair-mv9gxsdm';
      const report = repairReport({ targets: [run, makeRun(store, { labels: ['refund-over-limit'] })], dir });
      // What a pull writes: the patch and the reports, never the goldens.
      mkdirSync(join(project, dir), { recursive: true });
      writeFileSync(join(project, dir, 'fix.patch'), report.patch!);
      const fix = recordRepair(store, { repairId: 'repair-mv9gxsdm', dir, report, expect: EXPECT, command: 'r' }).fixes[0]!.fix;
      store.markRepairPulled('s3://northwind-agent-runs/support-agent', 'repair-mv9gxsdm');
      expect(fix.status).toBe('verified');

      const lines: string[] = [];
      const result = await applyFix(store, fix, { cwd: project, goldens: 'goldens', test: true, build: null, db: join(project, 'shadowlap.db'), log: (l) => lines.push(l) });
      expect(result).toMatchObject({ status: 'applied', patch: 'applied', goldens: [], tests: 'skipped' });
      expect(lines.filter((l) => l.includes('is gone'))).toEqual([]);
      expect(lines).toContain('  the 2 recordings the fixed code made stay on the machine that ran repair-mv9gxsdm, which came with a pull: commit them from there');
      expect(store.getFix(fix.fixId)).toMatchObject({ status: 'applied', data: { applied: { patch: 'applied', goldens: [], tests: 'skipped' } } });
      // Nothing is left to finish: a second run says it is applied.
      const again = await applyFix(store, store.getFix(fix.fixId)!, { cwd: project, goldens: 'goldens', test: true, build: null, db: join(project, 'shadowlap.db'), log: () => undefined });
      expect(again.status).toBe('already-applied');
    } finally {
      store.close();
    }
  });

  it('names the file to read from the folder it runs in when that folder is reached through a link', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    // git names the repository by where the link leads, as it names a folder reached by a short name
    // on Windows (C:\Users\RUNNER~1) by its long one.
    const link = `${project}-link`;
    try {
      const { fix } = teammateFix(store, (own) => own);
      symlinkSync(project, link, process.platform === 'win32' ? 'junction' : undefined);
      const lines: string[] = [];
      expect(await applyFix(store, fix, { ...options(lines), cwd: link })).toMatchObject({ status: 'applied', patch: 'applied' });
      expect(lines).toContain('  it came with a pull from the team store, so nothing here runs it yet: read the change (git diff -- agent.mjs), then check your goldens against it with shadowlap test');
    } finally {
      // The store first: if removing the link fails, the project's folder can still be removed after the test.
      store.close();
      rmSync(link, { force: true });
    }
  });
});

describe('fix apply of a patch from the store that is more than the change its repair verified', () => {
  it('refuses a patch that writes other files too, and changes nothing', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      // As found in a bucket: the change named in the dialog, plus a new file and a line in another agent.
      const evil = ['diff --git a/EVIL.txt b/EVIL.txt', 'new file mode 100644', '--- /dev/null', '+++ b/EVIL.txt', '@@ -0,0 +1 @@', '+from the bucket', 'diff --git a/triage.mjs b/triage.mjs', '--- a/triage.mjs', '+++ b/triage.mjs', '@@ -1,1 +1,2 @@', "+(await import('node:fs')).writeFileSync('MARKER', 'ran');", ' // The triage agent', ''].join('\n');
      const { fix, agent } = teammateFix(store, (own) => own + evil);
      const lines: string[] = [];
      const err = await applyFix(store, fix, options(lines)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApplyError);
      expect((err as Error).message).toBe('the patch repair-mv9gxsdm holds is not the change it verified: it changes agent.mjs, EVIL.txt and triage.mjs, where its accepted candidate changes agent.mjs alone. Nothing was changed: a repair only ever rewrites one span of one file, so read .shadowlap/repairs/repair-mv9gxsdm/fix.patch before you apply any of it by hand');
      expect(status()).toBe('');
      expect(existsSync(join(project, 'EVIL.txt'))).toBe(false);
      expect(readFileSync(join(project, 'agent.mjs'), 'utf8')).toBe(agent);
      expect(existsSync(join(project, 'RAN'))).toBe(false);
      expect(store.getFix(fix.fixId)!.status).toBe('verified');
      // fix show says so instead of offering the command, and offers no git apply to copy.
      const shown = formatFixDetail(fixDetail(store, fix.fixId)!, plain);
      expect(shown).toContain("  ! its patch is not the change its repair verified: it changes agent.mjs, EVIL.txt and triage.mjs, where its accepted candidate changes agent.mjs alone. shadowlap fix apply won't apply it");
      expect(shown).not.toContain('next: shadowlap fix apply');
      expect(shown).not.toContain('git apply');
    } finally {
      store.close();
    }
  });

  it("refuses a patch to the candidate's file that adds more than its rewrite", async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      const { fix, agent } = teammateFix(store, (own) => own.replace(/^@@ -1,2 \+1,2 @@$/m, '@@ -1,2 +1,3 @@').replace(/^\+const system(.*)$/m, "+const system$1\n+(await import('node:fs')).writeFileSync('MARKER', 'ran');"));
      const err = await applyFix(store, fix, options([])).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/^the patch repair-mv9gxsdm holds is not the change it verified: the lines it changes in agent\.mjs are not its accepted candidate's rewrite\./);
      expect(status()).toBe('');
      expect(readFileSync(join(project, 'agent.mjs'), 'utf8')).toBe(agent);
    } finally {
      store.close();
    }
  });

  it('refuses a patch to a file git ignores, where neither git status nor git diff would show the change', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      // The candidate names a dependency's code, and the patch rewrites it there alone.
      const dep = 'node_modules/refund-policy/index.js';
      const code = `export const policy = '${BEFORE}';\n`;
      mkdirSync(join(project, 'node_modules', 'refund-policy'), { recursive: true });
      writeFileSync(join(project, dep), code);
      writeFileSync(join(project, '.gitignore'), 'node_modules/\n.shadowlap/\nshadowlap.db*\n');
      const run = makeRun(store, { labels: ['refund-over-limit'] });
      recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x' });
      const dir = '.shadowlap/repairs/repair-mv9gxsdm';
      const report = repairReport({ targets: [run], dir });
      report.candidates = report.candidates.map((c) => (c.id === report.accepted ? { ...c, file: dep } : c));
      report.patch = unifiedDiff(dep, code, code.replace(BEFORE, AFTER));
      mkdirSync(join(project, dir), { recursive: true });
      writeFileSync(join(project, dir, 'fix.patch'), report.patch);
      const fix = recordRepair(store, { repairId: 'repair-mv9gxsdm', dir, report, expect: EXPECT, command: 'r' }).fixes[0]!.fix;
      store.markRepairPulled('s3://northwind-agent-runs/support-agent', 'repair-mv9gxsdm');
      const err = await applyFix(store, fix, options([])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApplyError);
      expect((err as Error).message).toBe(
        'node_modules/refund-policy/index.js is a path git ignores here, so a change to it would show in neither git status nor git diff: the patch was not applied. A repair only rewrites files git sees; read .shadowlap/repairs/repair-mv9gxsdm/fix.patch, and apply it by hand if you mean to',
      );
      expect(readFileSync(join(project, dep), 'utf8')).toBe(code);
      expect(store.getFix(fix.fixId)!.status).toBe('verified');
    } finally {
      store.close();
    }
  });

  it('refuses a patch to a file reached through a link, which could lead it out of the working tree', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    const outside = `${project}-outside`;
    const prompts = join(project, 'prompts');
    try {
      // The candidate names prompts/policy.mjs, and prompts links to a folder outside the project.
      const file = 'prompts/policy.mjs';
      const code = `export const policy = '${BEFORE}';\n`;
      mkdirSync(outside);
      writeFileSync(join(outside, 'policy.mjs'), code);
      symlinkSync(outside, prompts, process.platform === 'win32' ? 'junction' : undefined);
      const run = makeRun(store, { labels: ['refund-over-limit'] });
      recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x' });
      const dir = '.shadowlap/repairs/repair-mv9gxsdm';
      const report = repairReport({ targets: [run], dir });
      report.candidates = report.candidates.map((c) => (c.id === report.accepted ? { ...c, file } : c));
      report.patch = unifiedDiff(file, code, code.replace(BEFORE, AFTER));
      mkdirSync(join(project, dir), { recursive: true });
      writeFileSync(join(project, dir, 'fix.patch'), report.patch);
      const fix = recordRepair(store, { repairId: 'repair-mv9gxsdm', dir, report, expect: EXPECT, command: 'r' }).fixes[0]!.fix;
      store.markRepairPulled('s3://northwind-agent-runs/support-agent', 'repair-mv9gxsdm');
      const err = await applyFix(store, fix, options([])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApplyError);
      expect((err as Error).message).toBe('prompts/policy.mjs is reached through prompts, which is a link in this working tree, so the patch was not applied: apply it by hand if you mean to');
      expect(readFileSync(join(outside, 'policy.mjs'), 'utf8')).toBe(code);
      expect(store.getFix(fix.fixId)!.status).toBe('verified');
    } finally {
      store.close();
      // The link first, then the folder it leads to, which the project's removal after the test doesn't reach.
      rmSync(prompts, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("puts a teammate's patch in and runs nothing from it, no build and no replay, until it is read", async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      const { fix, agent } = teammateFix(store, (own) => own);
      const lines: string[] = [];
      const result = await applyFix(store, fix, options(lines, 'node -e "require(\'fs\').writeFileSync(\'BUILT\', \'\')"'));
      expect(result).toMatchObject({ status: 'applied', patch: 'applied', tests: 'skipped', outdated: [], update: null });
      expect(readFileSync(join(project, 'agent.mjs'), 'utf8')).toBe(agent.replace(BEFORE, AFTER));
      expect(status()).toBe(' M agent.mjs\n');
      // The agent never ran: neither the build nor the golden it would have replayed.
      expect(existsSync(join(project, 'BUILT'))).toBe(false);
      expect(existsSync(join(project, 'RAN'))).toBe(false);
      expect(lines.some((l) => l.includes("checking the project's other goldens"))).toBe(false);
      expect(lines).toContain('  it came with a pull from the team store, so nothing here runs it yet: read the change (git diff -- agent.mjs), then rebuild (node -e "require(\'fs\').writeFileSync(\'BUILT\', \'\')") and check your goldens against it with shadowlap test');
    } finally {
      store.close();
    }
  });

  it('replays the other goldens after a patch repaired here, as before', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      const { fix } = teammateFix(store, (own) => own, { pulled: false });
      const lines: string[] = [];
      const result = await applyFix(store, fix, options(lines));
      expect(result).toMatchObject({ status: 'applied', patch: 'applied' });
      expect(lines).toContain("  checking the project's other goldens against the patch: 1 replayed offline");
      expect(existsSync(join(project, 'RAN'))).toBe(true);
    } finally {
      store.close();
    }
  });
});

/**
 * Git for Windows sets core.autocrlf: git checks text files out with CRLF, and git apply writes a file
 * whose lines end with LF back with CRLF, every line of it. A text attribute in .gitattributes does
 * the same with core.autocrlf off, where the line ending git writes is CRLF, as Git for Windows' own
 * is. Set here in the project, on every system.
 */
describe('fix apply where git converts line endings (core.autocrlf, as Git for Windows sets it, or a text attribute)', () => {
  const crlf = (text: string) => text.replace(/\n/g, '\r\n');
  const agentFile = () => readFileSync(join(project, 'agent.mjs'), 'utf8');
  /** The agent checked out again, as git checks it out under core.autocrlf: every line ends with CRLF. */
  function checkOut() {
    rmSync(join(project, 'agent.mjs'));
    execFileSync('git', ['checkout', '--', 'agent.mjs'], { cwd: project, stdio: 'pipe' });
  }

  it('puts the patch in as the repair verified it, a file with LF left with LF', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: project });
      const { fix, agent } = teammateFix(store, (own) => own);
      const result = await applyFix(store, fix, options([]));
      expect(result).toMatchObject({ status: 'applied', patch: 'applied' });
      expect(agentFile()).toBe(agent.replace(BEFORE, AFTER));
      expect(status()).toBe(' M agent.mjs\n');
    } finally {
      store.close();
    }
  });

  it('puts the patch in as the repair verified it where .gitattributes says text=auto and git writes CRLF, a file with LF left with LF', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      writeFileSync(join(project, '.gitattributes'), '* text=auto\n');
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: project });
      execFileSync('git', ['config', 'core.eol', 'crlf'], { cwd: project });
      const { fix, agent } = teammateFix(store, (own) => own);
      const result = await applyFix(store, fix, options([]));
      expect(result).toMatchObject({ status: 'applied', patch: 'applied' });
      expect(agentFile()).toBe(agent.replace(BEFORE, AFTER));
    } finally {
      store.close();
    }
  });

  it("puts a patch with LF into a checkout's file with CRLF through git's conversion, which keeps the CRLF", async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      // A teammate's patch, made where the file has LF; here git checked it out with CRLF.
      const { fix, agent } = teammateFix(store, (own) => own);
      execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: project });
      checkOut();
      expect(agentFile()).toBe(crlf(agent));
      const result = await applyFix(store, fix, options([]));
      expect(result).toMatchObject({ status: 'applied', patch: 'applied' });
      expect(agentFile()).toBe(crlf(agent.replace(BEFORE, AFTER)));
      expect(status()).toBe(' M agent.mjs\n');
    } finally {
      store.close();
    }
  });

  it('knows a patch git apply put in by hand there as in already', async () => {
    const store = Store.open(join(project, 'shadowlap.db'));
    try {
      const { fix, agent } = teammateFix(store, (own) => own);
      execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: project });
      checkOut();
      execFileSync('git', ['apply', '.shadowlap/repairs/repair-mv9gxsdm/fix.patch'], { cwd: project, stdio: 'pipe' });
      expect(agentFile()).toBe(crlf(agent.replace(BEFORE, AFTER)));
      const lines: string[] = [];
      const result = await applyFix(store, fix, { ...options(lines), test: false });
      expect(result).toMatchObject({ status: 'applied', patch: 'already' });
      expect(lines).toContain('  the patch is already in the working tree (.shadowlap/repairs/repair-mv9gxsdm/fix.patch)');
      expect(agentFile()).toBe(crlf(agent.replace(BEFORE, AFTER)));
    } finally {
      store.close();
    }
  });
});
