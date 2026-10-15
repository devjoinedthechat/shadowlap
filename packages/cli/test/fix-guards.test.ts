import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordRepair, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { ApplyError, applyFix } from '../src/fix-apply.js';
import { recordBlameFix, recordRepairFix, recordVerifyFix } from '../src/fixes.js';

/** Fixes against a store that can't be trusted, and one that won't keep what a command found. */

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fp-fix-guards-'));
  path = join(dir, 'shadowlap.db');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const options = { cwd: '.', goldens: 'goldens', test: false, build: null, db: undefined, log: () => {} };

/** A verified fix whose repair the store describes as `tamper` says. */
function verifiedFix(store: Store, tamper: (report: ReturnType<typeof repairReport>) => { dir: string }) {
  const run = makeRun(store, { labels: ['refund-over-limit'] });
  recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x' });
  const report = repairReport({ targets: [run], dir: '.shadowlap/repairs/repair-mv9gxsdm' });
  const { dir: repairDir } = tamper(report);
  return recordRepair(store, { repairId: 'repair-mv9gxsdm', dir: repairDir, report, expect: EXPECT, command: 'r' }).fixes[0]!.fix;
}

describe('fix apply trusts no path from the store', () => {
  it('refuses a repair directory other than .shadowlap/repairs/<its id>', async () => {
    const store = Store.open(':memory:');
    try {
      const fix = verifiedFix(store, () => ({ dir: '../../outside' }));
      expect(fix.status).toBe('verified');
      await expect(applyFix(store, fix, options)).rejects.toThrow(ApplyError);
      await expect(applyFix(store, fix, options)).rejects.toThrow('the store gives repair-mv9gxsdm the directory "../../outside", not .shadowlap/repairs/repair-mv9gxsdm, so it is not used');
      expect(store.getFix(fix.fixId)?.status).toBe('verified');
    } finally {
      store.close();
    }
  });

  it('refuses goldens outside the repair directory', async () => {
    const store = Store.open(':memory:');
    try {
      const fix = verifiedFix(store, (report) => {
        report.output.goldens = ['.shadowlap/repairs/repair-mv9gxsdm/goldens/../../../../.ssh'];
        return { dir: '.shadowlap/repairs/repair-mv9gxsdm' };
      });
      await expect(applyFix(store, fix, options)).rejects.toThrow('which is not inside .shadowlap/repairs/repair-mv9gxsdm/goldens/, so nothing was applied');
      const other = Store.open(':memory:');
      try {
        const absolute = verifiedFix(other, (report) => {
          report.output.goldens = ['/etc'];
          return { dir: '.shadowlap/repairs/repair-mv9gxsdm' };
        });
        await expect(applyFix(other, absolute, options)).rejects.toThrow('"/etc"');
      } finally {
        other.close();
      }
    } finally {
      store.close();
    }
  });
});

describe('a store that refuses to keep what a command found', () => {
  /** Makes the store refuse every row of one Fixes table. */
  function refuse(table: string): void {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    const db = new DatabaseSync(path);
    db.exec(`CREATE TRIGGER refuse_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'the store refuses'); END;`);
    db.close();
  }

  it('leaves the blame standing, with a warning that it was not kept with a fix', () => {
    const store = Store.open(path);
    try {
      const run = makeRun(store);
      refuse('blames');
      const report = blameReport(run);
      const kept = recordBlameFix(store, { runId: run, report, settings: { spec: null, expect: null, fields: {}, attempts: 5, needed: 2 }, recording: { checks: [], failures: ['the agent exited with code 1'] } });
      expect(kept).toBeNull();
      expect(report.warnings).toEqual(['the blame could not be kept with its fix: the store refuses']);
      expect(store.listFixes()).toEqual([]);
      expect(store.listEvents()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('leaves the verdict and the repair standing, each with a warning', () => {
    const store = Store.open(path);
    const run = makeRun(store, { labels: ['refund-over-limit'] });
    recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'c', title: 't', checkText: 'x' });
    store.close();
    refuse('verdicts');
    refuse('repairs');

    const verify = verifyReport([{ runId: run, role: 'target', pass: true }]);
    expect(recordVerifyFix({ db: path }, verify, { expect: EXPECT, command: 'v' })).toBeNull();
    expect(verify.warnings).toEqual(['the verdict could not be kept: the store refuses']);

    const repair = repairReport({ targets: [run] });
    expect(recordRepairFix({ db: path }, repair, { expect: EXPECT, command: 'r' })).toBeNull();
    expect(repair.warnings).toEqual(['the repair could not be kept with its fix: the store refuses']);

    const after = Store.open(path);
    try {
      expect(after.listFixes().map((f) => f.status)).toEqual(['open']);
      expect(after.listEvents()).toEqual([]);
    } finally {
      after.close();
    }
  });
});
