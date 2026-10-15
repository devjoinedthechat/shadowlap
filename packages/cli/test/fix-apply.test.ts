import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordRepair, Store } from '@shadowlap/engine';
import { AFTER, BEFORE, blameReport, EXPECT, makeRun, repairReport } from '../../engine/test/fix-fixtures.js';
import { applyFix } from '../src/fix-apply.js';

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
