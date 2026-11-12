/**
 * Coverage: what `shadowlap coverage` found when it last looked, the imported runs grouped by
 * behaviour with the goldens that cover each group (coverage_groups), every scan's totals
 * (coverage_scans), and what `coverage --pack` last made of each behaviour (coverage_packs).
 */
import { parseJsonColumn, StorePart } from './core.js';

// ---- coverage (v4): the shapes of the coverage tables ----

/** One `shadowlap coverage` scan: what it read and what it found. */
export interface CoverageScan {
  scanId: string;
  at: number;
  /** Imported runs read. */
  runs: number;
  groups: number;
  /** Groups no golden covers. */
  uncovered: number;
  /** Goldens read. */
  goldens: number;
  actor: string | null;
  /** The goldens read (by name), the ones that couldn't be (and why), and what the scan packed. */
  data: CoverageScanData | null;
}

export interface CoverageScanData {
  goldens?: string[];
  unreadable?: Array<{ golden: string; error: string }>;
  /** The goldens the \`--pack\` before this scan made, and the behaviours it couldn't pack, with why. */
  packed?: Array<{ key: string; golden: string; runId: string; mode?: CoveragePackMode }>;
  notPacked?: Array<{ key: string; reason: CoverageNotPacked; why: string }>;
}

/** How \`coverage --pack\` packed a behaviour: a golden that replays its capture, or one that forks (\`--fork\`). */
export type CoveragePackMode = 'replay' | 'fork';

/**
 * Why \`coverage --pack\` couldn't pack a behaviour: nothing says what starts the agent (\`no-command\`),
 * the command started it with another first message than production's (\`other-message\`), the agent
 * sends something else now (\`not-reproduced\`: \`--fork\` packs it as the test that the change holds),
 * the agent failed on what production got back (\`agent-error\`), or its runs were deleted (\`gone\`).
 */
export type CoverageNotPacked = 'no-command' | 'other-message' | 'not-reproduced' | 'agent-error' | 'gone';

/** What \`coverage --pack\` last made of a behaviour. */
export interface StoredCoveragePack {
  key: string;
  at: number;
  /** The golden it packed, or null when it couldn't. */
  golden: string | null;
  /** The run packed. */
  runId: string | null;
  /** The imported run it reproduces. */
  from: string | null;
  mode: CoveragePackMode | null;
  reason: CoverageNotPacked | null;
  /** Why it wasn't packed, in a sentence. */
  why: string | null;
  /** The agent's command it ran, and where that came from (\`--\`, or the run that sent the same first request). */
  command: { argv: string[]; from: string } | null;
}

/** A group of imported runs that behave alike, as the last scan left it (coverage.ts `CoverageGroup`, plus what `--pack` made of it). */
export interface StoredCoverageGroup {
  key: string;
  scanId: string;
  behaviour: CoverageBehaviour;
  runs: number;
  runIds: string[];
  sources: string[];
  firstSeen: number;
  lastSeen: number;
  coveredBy: string[];
  nearest: { golden: string; shared: number; differs: { step: number; seen: string | null; golden: string | null } | null } | null;
  /** For a group no golden covers: the command that would reproduce its newest run, and the recording that says so; null when none does. */
  command: { argv: string[]; from: string } | null;
  /** The golden `coverage --pack` made of the group: its name, the run packed, when, and whether it forks. */
  packed: { golden: string; runId: string; at: number; mode?: CoveragePackMode | null } | null;
}

/** coverage.ts `Behaviour`, as stored. */
export interface CoverageBehaviour {
  path: string[];
  writes: string[];
  unknown: string[];
  outcome: string;
}


/** A coverage_scans row as a scan. */
function scanOf(r: Record<string, unknown>): CoverageScan {
  return {
    scanId: String(r.scan_id),
    at: Number(r.at),
    runs: Number(r.runs),
    groups: Number(r.groups),
    uncovered: Number(r.uncovered),
    goldens: Number(r.goldens),
    actor: r.actor === null ? null : String(r.actor),
    data: r.data === null ? null : (JSON.parse(String(r.data)) as CoverageScanData),
  };
}

export abstract class Coverage extends StorePart {
  // ---- coverage (v4): what the last `shadowlap coverage` found ----

  /** Keeps a scan and its groups: the groups of the scan before it go. */
  saveCoverageScan(scan: CoverageScan, groups: readonly StoredCoverageGroup[]): void {
    this.transaction(() => {
      this.db
        .prepare(`INSERT INTO coverage_scans (scan_id, at, runs, groups, uncovered, goldens, actor, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scan.scanId, scan.at, scan.runs, scan.groups, scan.uncovered, scan.goldens, scan.actor, scan.data === null ? null : JSON.stringify(scan.data));
      this.db.prepare(`DELETE FROM coverage_groups`).run();
      const insert = this.db.prepare(
        `INSERT INTO coverage_groups (key, scan_id, behaviour, runs, run_ids, sources, first_seen, last_seen, covered_by, nearest, command, packed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const g of groups) {
        insert.run(g.key, scan.scanId, JSON.stringify(g.behaviour), g.runs, JSON.stringify(g.runIds), JSON.stringify(g.sources), g.firstSeen, g.lastSeen, JSON.stringify(g.coveredBy), g.nearest ? JSON.stringify(g.nearest) : null, g.command ? JSON.stringify(g.command) : null, g.packed ? JSON.stringify(g.packed) : null);
      }
    });
  }

  /** Keeps what \`coverage --pack\` made of a behaviour, replacing what it made of it before. */
  saveCoveragePack(p: StoredCoveragePack): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO coverage_packs (key, at, golden, run_id, from_run, mode, reason, why, command) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.key, p.at, p.golden, p.runId, p.from, p.mode, p.reason, p.why, p.command ? JSON.stringify(p.command) : null);
  }

  /** What \`coverage --pack\` last made of each behaviour it tried, newest first. */
  coveragePacks(): StoredCoveragePack[] {
    return this.db
      .prepare(`SELECT * FROM coverage_packs ORDER BY at DESC, key ASC`)
      .all()
      .map((r) => ({
        key: String(r.key),
        at: Number(r.at),
        golden: r.golden === null ? null : String(r.golden),
        runId: r.run_id === null ? null : String(r.run_id),
        from: r.from_run === null ? null : String(r.from_run),
        mode: r.mode === null ? null : (String(r.mode) as CoveragePackMode),
        reason: r.reason === null ? null : (String(r.reason) as CoverageNotPacked),
        why: r.why === null ? null : String(r.why),
        command: parseJsonColumn<StoredCoveragePack['command']>(r.command, null),
      }));
  }

  /** The newest scans, newest first. */
  listCoverageScans(limit = 20): CoverageScan[] {
    return this.db
      .prepare(`SELECT * FROM coverage_scans ORDER BY at DESC, scan_id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(1000, limit)))
      .map(scanOf);
  }

  /** The scans made at or after `at`, oldest first: the one `--pack` makes once it has tried says who tried it. */
  coverageScansSince(at: number): CoverageScan[] {
    return this.db.prepare(`SELECT * FROM coverage_scans WHERE at >= ? ORDER BY at ASC, scan_id ASC`).all(at).map(scanOf);
  }

  /** The groups of the last scan: not covered first, as the scan ordered them. */
  coverageGroups(): StoredCoverageGroup[] {
    const parse = <T>(v: unknown, fallback: T): T => (v === null || v === undefined ? fallback : (JSON.parse(String(v)) as T));
    return this.db
      .prepare(`SELECT * FROM coverage_groups ORDER BY rowid ASC`)
      .all()
      .map((r) => ({
        key: String(r.key),
        scanId: String(r.scan_id),
        behaviour: parse<CoverageBehaviour>(r.behaviour, { path: [], writes: [], unknown: [], outcome: 'answered' }),
        runs: Number(r.runs),
        runIds: parse<string[]>(r.run_ids, []),
        sources: parse<string[]>(r.sources, []),
        firstSeen: Number(r.first_seen),
        lastSeen: Number(r.last_seen),
        coveredBy: parse<string[]>(r.covered_by, []),
        nearest: parse<StoredCoverageGroup['nearest']>(r.nearest, null),
        command: parse<StoredCoverageGroup['command']>(r.command, null),
        packed: parse<StoredCoverageGroup['packed']>(r.packed, null),
      }));
  }
}
