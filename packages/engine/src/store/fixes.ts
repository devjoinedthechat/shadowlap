/**
 * Fixes: each failure from the blame that reproduced it to a change that held (fixes), the runs and
 * reports linked to it (fix_links), and every blame, verdict and repair report, kept whole (blames,
 * verdicts, repairs).
 */
import type { BlameReport } from '../blame.js';
import type { RepairOutcome, RepairReport } from '../repair.js';
import type { VerifyOutcome, VerifyReport } from '../verify.js';
import { StorePart } from './core.js';

// ---- Fixes (v4): the rows of the fixes, fix_links, blames, verdicts and repairs tables. fixes.ts
// decides what goes in them; these are only their shapes.

export type FixStatus = 'open' | 'verified' | 'applied';
export type FixLinkKind = 'failing' | 'good' | 'blame' | 'repair' | 'verify';

/** One failure, from the blame that reproduced it to a change that held. */
export interface StoredFix {
  /** `fx-<ulid>`. */
  fixId: string;
  title: string;
  /** Every label but `good` its failing runs carried when they joined it, in the order they came. */
  labels: string[];
  /**
   * The check its first blame was made under: the `--expect` JSON as given (null for the exit code
   * alone), its canonical key (`check:<canonical JSON>`, `check:exit`), the oracle as the labels of
   * what a passing run does, and in words.
   */
  check: { expect: unknown; key: string; oracle: string[]; text: string };
  status: FixStatus;
  openedAt: number;
  verifiedAt: number | null;
  appliedAt: number | null;
  data: FixData;
}

export interface FixData {
  /** Where it came from: a CI provider it was opened under, the pull request a repair opened for it. */
  source?: { ci?: string; pr?: { url: string; number: number | null; state?: 'open' | 'merged' | 'closed'; at?: number } };
  /** Who opened it (resolveAuthor). */
  openedBy?: string | null;
  /** Someone gave it a title of their own (`shadowlap fix title`). */
  titleEdited?: boolean;
  /** When the title was last given (ms): of two copies renamed apart, the later rename wins. */
  titleEditedAt?: number;
  /** How it was applied: by `shadowlap fix apply`, or by `repair --apply`, which copies no goldens unless asked and runs no test. */
  applied?: { patch: 'applied' | 'already' | 'none'; repairId: string | null; goldens: string[]; tests: 'passed' | 'failed' | 'skipped'; by?: string | null; via?: 'fix apply' | 'repair --apply' };
}

/**
 * Whether a verdict counts for a fix: it checked everything the fix's check asks, on at least one
 * of the fix's failing runs that failed it as recorded. One that doesn't is kept and shown, and
 * changes nothing: `another-check` (it left out `missing`), `already-passing` (every failing run
 * of the fix it replayed already passed as recorded), `no-runs` (none of its runs fails in the fix).
 */
export type VerdictStanding = { counts: true; why: null } | { counts: false; why: 'another-check' | 'already-passing' | 'no-runs'; missing?: string[] };

export interface FixLink {
  fixId: string;
  kind: FixLinkKind;
  /** A run id (failing, good), a blame id, a repair id or a verdict id. */
  ref: string;
  at: number;
  /** For a verdict, whether it counts for the fix; null otherwise. */
  data: VerdictStanding | null;
}

/** One `shadowlap blame`, kept whole: a later blame of the same run doesn't overwrite it, as `meta.blame` is. */
export interface StoredBlame {
  /** `bl-<ulid>`. */
  blameId: string;
  /** The failed run that was blamed. */
  runId: string;
  at: number;
  outcome: BlameReport['outcome'];
  report: BlameReport;
  /** The `--expect` the oracle came from, as given, or null for the exit code alone. */
  expect: unknown;
  /** The scope whose model calls were probed, when blame was limited to one. */
  scope: string | null;
  /** A command that blames the run the same way again. */
  command: string;
}

/** One verdict of `shadowlap verify`, or of the verify a repair ran on the candidate it accepted. */
export interface StoredVerdict {
  /** `vf-<ulid>`. */
  verifyId: string;
  at: number;
  verdict: VerifyOutcome;
  /** The repair whose candidate this verified, and which candidate; null for a verify of the working tree. */
  repairId: string | null;
  candidate: number | null;
  report: VerifyReport;
  expect: unknown;
  command: string;
}

/** One `shadowlap repair`: its report.json, and where its files are. */
export interface StoredRepair {
  /** The name of its directory, `repair-<time>`. */
  repairId: string;
  at: number;
  /** Its directory, relative to the folder the repair ran in: `.shadowlap/repairs/<id>`. */
  dir: string;
  outcome: RepairOutcome;
  accepted: boolean;
  report: RepairReport;
  expect: unknown;
  command: string;
}

export abstract class Fixes extends StorePart {
  // ---- Fixes (v4): fixes, their links, and the blame, verdict and repair reports behind them ----

  insertFix(fix: StoredFix): void {
    this.db
      .prepare(
        `INSERT INTO fixes (fix_id, title, labels, check_key, check_expect, check_oracle, check_text, status, opened_at, verified_at, applied_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fix.fixId,
        fix.title,
        JSON.stringify(fix.labels),
        fix.check.key,
        fix.check.expect === null || fix.check.expect === undefined ? null : JSON.stringify(fix.check.expect),
        JSON.stringify(fix.check.oracle),
        fix.check.text,
        fix.status,
        fix.openedAt,
        fix.verifiedAt,
        fix.appliedAt,
        JSON.stringify(fix.data),
      );
  }

  getFix(fixId: string): StoredFix | null {
    const row = this.db.prepare(`SELECT * FROM fixes WHERE fix_id = ?`).get(fixId);
    return row ? rowToFix(row) : null;
  }

  /** Every fix, the most recently opened first. */
  listFixes(): StoredFix[] {
    return this.db.prepare(`SELECT * FROM fixes ORDER BY opened_at DESC, fix_id DESC`).all().map(rowToFix);
  }

  /**
   * Sets the columns given, and only those, so two commands changing different things about one fix
   * at once don't undo each other. `data` goes through `mergeFixData`.
   */
  updateFix(fixId: string, patch: Partial<Pick<StoredFix, 'title' | 'labels' | 'status' | 'verifiedAt' | 'appliedAt'>>): void {
    const columns: Array<[string, string | number | null]> = [];
    if (patch.title !== undefined) columns.push(['title', patch.title]);
    if (patch.labels !== undefined) columns.push(['labels', JSON.stringify(patch.labels)]);
    if (patch.status !== undefined) columns.push(['status', patch.status]);
    if (patch.verifiedAt !== undefined) columns.push(['verified_at', patch.verifiedAt]);
    if (patch.appliedAt !== undefined) columns.push(['applied_at', patch.appliedAt]);
    if (!columns.length) return;
    const done = this.db.prepare(`UPDATE fixes SET ${columns.map(([c]) => `${c} = ?`).join(', ')} WHERE fix_id = ?`).run(...columns.map(([, v]) => v), fixId);
    if (Number(done.changes) === 0) throw new Error(`unknown fix ${fixId}`);
  }

  /**
   * Merges `patch` into a fix's data in one statement (a JSON merge patch: objects merge, anything
   * else replaces, null removes), so it never writes back data another command changed meanwhile.
   */
  mergeFixData(fixId: string, patch: Record<string, unknown>): void {
    const done = this.db.prepare(`UPDATE fixes SET data = json_patch(coalesce(data, '{}'), ?) WHERE fix_id = ?`).run(JSON.stringify(patch), fixId);
    if (Number(done.changes) === 0) throw new Error(`unknown fix ${fixId}`);
  }

  /** Links a run or a report to a fix; linking it again keeps the first link. */
  addFixLink(fixId: string, kind: FixLinkKind, ref: string, at: number = Date.now(), data: FixLink['data'] = null): void {
    this.db.prepare(`INSERT OR IGNORE INTO fix_links (fix_id, kind, ref, at, data) VALUES (?, ?, ?, ?, ?)`).run(fixId, kind, ref, at, data === null ? null : JSON.stringify(data));
  }

  /** A fix's links, in the order they were made. */
  fixLinks(fixId: string, kind?: FixLinkKind): FixLink[] {
    const rows = kind
      ? this.db.prepare(`SELECT * FROM fix_links WHERE fix_id = ? AND kind = ? ORDER BY at ASC, ref ASC`).all(fixId, kind)
      : this.db.prepare(`SELECT * FROM fix_links WHERE fix_id = ? ORDER BY at ASC, ref ASC`).all(fixId);
    return rows.map(rowToFixLink);
  }

  /** The links to a run or a report, from every fix, in the order they were made. */
  linksTo(ref: string, kind?: FixLinkKind): FixLink[] {
    const rows = kind
      ? this.db.prepare(`SELECT * FROM fix_links WHERE ref = ? AND kind = ? ORDER BY at ASC, fix_id ASC`).all(ref, kind)
      : this.db.prepare(`SELECT * FROM fix_links WHERE ref = ? ORDER BY at ASC, fix_id ASC`).all(ref);
    return rows.map(rowToFixLink);
  }

  putBlame(b: StoredBlame): void {
    this.db
      .prepare(`INSERT INTO blames (blame_id, run_id, at, outcome, record) VALUES (?, ?, ?, ?, ?)`)
      .run(b.blameId, b.runId, b.at, b.outcome, JSON.stringify({ report: b.report, expect: b.expect ?? null, scope: b.scope, command: b.command }));
  }

  getBlame(blameId: string): StoredBlame | null {
    const row = this.db.prepare(`SELECT * FROM blames WHERE blame_id = ?`).get(blameId);
    return row ? rowToBlame(row) : null;
  }

  /** The blames of one run, the first made first. */
  blamesOfRun(runId: string): StoredBlame[] {
    return this.db.prepare(`SELECT * FROM blames WHERE run_id = ? ORDER BY at ASC, blame_id ASC`).all(runId).map(rowToBlame);
  }

  /** Every blame, the first made first. */
  listBlames(): StoredBlame[] {
    return this.db.prepare(`SELECT * FROM blames ORDER BY at ASC, blame_id ASC`).all().map(rowToBlame);
  }

  putVerdict(v: StoredVerdict): void {
    this.db
      .prepare(`INSERT INTO verdicts (verify_id, at, verdict, repair_id, record) VALUES (?, ?, ?, ?, ?)`)
      .run(v.verifyId, v.at, v.verdict, v.repairId, JSON.stringify({ report: v.report, candidate: v.candidate, expect: v.expect ?? null, command: v.command }));
  }

  getVerdict(verifyId: string): StoredVerdict | null {
    const row = this.db.prepare(`SELECT * FROM verdicts WHERE verify_id = ?`).get(verifyId);
    return row ? rowToVerdict(row) : null;
  }

  /** Every verdict, the first given first. */
  listVerdicts(): StoredVerdict[] {
    return this.db.prepare(`SELECT * FROM verdicts ORDER BY at ASC, verify_id ASC`).all().map(rowToVerdict);
  }

  putRepair(r: StoredRepair): void {
    this.db
      .prepare(`INSERT INTO repairs (repair_id, at, dir, outcome, accepted, record) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.repairId, r.at, r.dir, r.outcome, r.accepted ? 1 : 0, JSON.stringify({ report: r.report, expect: r.expect ?? null, command: r.command }));
  }

  getRepair(repairId: string): StoredRepair | null {
    const row = this.db.prepare(`SELECT * FROM repairs WHERE repair_id = ?`).get(repairId);
    return row ? rowToRepair(row) : null;
  }

  /** Every repair, the first made first. */
  listRepairs(): StoredRepair[] {
    return this.db.prepare(`SELECT * FROM repairs ORDER BY at ASC, repair_id ASC`).all().map(rowToRepair);
  }
}

// ---- Fixes (v4): rows to records ----

const nullableNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const record = (v: unknown): Record<string, unknown> => {
  const parsed = JSON.parse(String(v)) as unknown;
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
};

const strings = (v: unknown): string[] => {
  const parsed = typeof v === 'string' ? (JSON.parse(v) as unknown) : [];
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
};

function rowToFix(row: Record<string, unknown>): StoredFix {
  return {
    fixId: String(row.fix_id),
    title: String(row.title),
    labels: strings(row.labels),
    check: { expect: typeof row.check_expect === 'string' ? (JSON.parse(row.check_expect) as unknown) : null, key: String(row.check_key), oracle: strings(row.check_oracle), text: String(row.check_text) },
    status: row.status as FixStatus,
    openedAt: Number(row.opened_at),
    verifiedAt: nullableNumber(row.verified_at),
    appliedAt: nullableNumber(row.applied_at),
    data: typeof row.data === 'string' ? (record(row.data) as FixData) : {},
  };
}

function rowToFixLink(row: Record<string, unknown>): FixLink {
  return { fixId: String(row.fix_id), kind: row.kind as FixLinkKind, ref: String(row.ref), at: Number(row.at), data: typeof row.data === 'string' ? (record(row.data) as unknown as VerdictStanding) : null };
}

function rowToBlame(row: Record<string, unknown>): StoredBlame {
  const r = record(row.record);
  return {
    blameId: String(row.blame_id),
    runId: String(row.run_id),
    at: Number(row.at),
    outcome: row.outcome as StoredBlame['outcome'],
    report: r.report as BlameReport,
    expect: r.expect ?? null,
    scope: typeof r.scope === 'string' ? r.scope : null,
    command: typeof r.command === 'string' ? r.command : '',
  };
}

function rowToVerdict(row: Record<string, unknown>): StoredVerdict {
  const r = record(row.record);
  return {
    verifyId: String(row.verify_id),
    at: Number(row.at),
    verdict: row.verdict as VerifyOutcome,
    repairId: row.repair_id === null || row.repair_id === undefined ? null : String(row.repair_id),
    candidate: typeof r.candidate === 'number' ? r.candidate : null,
    report: r.report as VerifyReport,
    expect: r.expect ?? null,
    command: typeof r.command === 'string' ? r.command : '',
  };
}

function rowToRepair(row: Record<string, unknown>): StoredRepair {
  const r = record(row.record);
  return {
    repairId: String(row.repair_id),
    at: Number(row.at),
    dir: String(row.dir),
    outcome: row.outcome as RepairOutcome,
    accepted: Number(row.accepted) === 1,
    report: r.report as RepairReport,
    expect: r.expect ?? null,
    command: typeof r.command === 'string' ? r.command : '',
  };
}
