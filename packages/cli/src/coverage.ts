import { resolve } from 'node:path';
import {
  behaviourKey,
  describeBehaviour,
  effectsFor,
  groupCoverage,
  OUTCOME_WORDS,
  runBehaviour,
  runKind,
  Store,
  storeEffects,
  strongest,
  ulid,
  unpackRun,
  type Behaviour,
  type CoverageGolden,
  type CoverageGroup,
  type CoverageMember,
  type CoverageScan,
  type Effect,
  type Palette,
  type RunRecord,
  type StoredCoverageGroup,
} from '@shadowlap/engine';
import { type TestEntry } from './checks.js';
import { type ShadowlapConfig } from './config.js';
import { GOLDENS_FOLDER, listGoldens } from './goldens.js';
import { ago, safe, shortId } from './ui.js';

/**
 * `shadowlap coverage`: what the project's imported runs (captures of production traffic, traces
 * from OpenTelemetry, Langfuse and LangSmith) did, grouped by behaviour, and which of those
 * behaviours no golden covers. The goldens are read from their packs on disk, as `shadowlap test`
 * reads them, so a golden counts whether or not this store has seen it. Each scan is kept in the
 * store (the dashboard's Tests and Needs a look read it), and `--pack` (coverage-pack.ts) turns one
 * run of each uncovered behaviour into a golden.
 */

/** A golden as the scan read it: what its recording did, or why it couldn't be read. */
export interface GoldenRead {
  golden: string;
  dir: string;
  runId: string | null;
  behaviour: Behaviour | null;
  error: string | null;
}

export interface CoverageScanResult {
  scan: CoverageScan;
  groups: CoverageGroup[];
  goldens: GoldenRead[];
  /** The imported runs read, by id. */
  members: Map<string, RunRecord>;
  /** Every tool's effect, as the store, the goldens and the config name it. */
  effects: Map<string, Effect>;
}

/** The runs coverage reads: captures and traces, as the run list calls them (`capture`), that have ended. */
export function importedRuns(store: Store): RunRecord[] {
  return store.allRuns().filter((r) => r.status !== 'running' && runKind(r) === 'capture');
}

/** Reads a golden's pack into a store of its own, in memory, as `test` would import it, and says what its recording did. */
function readGoldenRecording(dir: string, runId: string | null): { store: Store; run: RunRecord } {
  const mem = Store.open(':memory:');
  try {
    const { imported, skipped } = unpackRun(mem, dir);
    const id = runId ?? imported.at(-1) ?? skipped.at(-1);
    const run = id ? mem.getRun(id) : null;
    if (!run) throw new Error('the pack holds no run');
    return { store: mem, run };
  } catch (err) {
    mem.close();
    throw err;
  }
}

/** A golden's own recorded effects, by tool. */
function recordedEffects(store: Store, runId: string): Map<string, Effect> {
  const out = new Map<string, Effect>();
  for (const c of store.getCalls(runId)) if (c.kind === 'tool' && c.effect) out.set(c.name, strongest(out.get(c.name), c.effect));
  return out;
}

/**
 * Reads the imported runs and the goldens, groups the runs by behaviour, and keeps the scan in the
 * store (replacing the groups of the one before). `packed` names the goldens `--pack` just made, by
 * group, so the groups it covers say so.
 */
export function scanCoverage(
  store: Store,
  o: { projectDir: string; tests: readonly TestEntry[]; config: Pick<ShadowlapConfig, 'mcp'>; actor: string | null; folder?: string; packed?: ReadonlyMap<string, { golden: string; runId: string }>; now?: number },
): CoverageScanResult {
  const infos = listGoldens(o.projectDir, o.tests, o.folder ?? GOLDENS_FOLDER);
  // Effects first: what the config names, then each golden's recorded calls, then the store's.
  const configured = new Map<string, Effect>(Object.entries(o.config.mcp?.effects ?? {}) as Array<[string, Effect]>);
  const opened: Array<{ info: (typeof infos)[number]; dir: string; read: { store: Store; run: RunRecord } | null; error: string | null }> = infos.map((info) => {
    const dir = resolve(o.projectDir, info.path);
    if (info.error) return { info, dir, read: null, error: info.error };
    try {
      return { info, dir, read: readGoldenRecording(dir, info.runId), error: null };
    } catch (err) {
      return { info, dir, read: null, error: (err as Error).message };
    }
  });
  try {
    for (const g of opened) if (g.read) for (const [name, effect] of recordedEffects(g.read.store, g.read.run.runId)) configured.set(name, strongest(configured.get(name), effect));
    const effects = storeEffects(store, configured);
    const goldens: GoldenRead[] = opened.map((g) => {
      if (!g.read) return { golden: g.info.path, dir: g.dir, runId: g.info.runId, behaviour: null, error: g.error };
      const calls = g.read.store.getCalls(g.read.run.runId);
      return { golden: g.info.path, dir: g.dir, runId: g.read.run.runId, behaviour: runBehaviour(g.read.store, g.read.run, calls, effectsFor(calls, effects)), error: null };
    });
    const runs = importedRuns(store);
    const members: CoverageMember[] = runs.map((run) => {
      const calls = store.getCalls(run.runId);
      return { runId: run.runId, startedAt: run.startedAt, source: run.meta?.imported?.from ?? null, behaviour: runBehaviour(store, run, calls, effectsFor(calls, effects)) };
    });
    const read = goldens.filter((g): g is GoldenRead & { behaviour: Behaviour } => g.behaviour !== null);
    const groups = groupCoverage(members, read.map((g): CoverageGolden => ({ golden: g.golden, runId: g.runId, behaviour: g.behaviour })));
    const at = o.now ?? Date.now();
    const scan: CoverageScan = {
      scanId: ulid(at),
      at,
      runs: runs.length,
      groups: groups.length,
      uncovered: groups.filter((g) => !g.coveredBy.length).length,
      goldens: read.length,
      actor: o.actor,
      data: {
        goldens: read.map((g) => g.golden),
        ...(goldens.some((g) => g.error) ? { unreadable: goldens.filter((g) => g.error).map((g) => ({ golden: g.golden, error: g.error! })) } : {}),
        ...(o.packed?.size ? { packed: [...o.packed].map(([key, p]) => ({ key, golden: p.golden, runId: p.runId })) } : {}),
      },
    };
    const stored: StoredCoverageGroup[] = groups.map((g) => {
      const p = o.packed?.get(g.key);
      return { ...g, scanId: scan.scanId, packed: p ? { golden: p.golden, runId: p.runId, at } : null };
    });
    store.saveCoverageScan(scan, stored);
    return { scan, groups, goldens, members: new Map(runs.map((r) => [r.runId, r])), effects };
  } finally {
    for (const g of opened) g.read?.store.close();
  }
}

// ---- what it prints ----

/** The JSON `coverage --json` prints for a group. */
export interface CoverageGroupJson {
  key: string;
  covered: boolean;
  coveredBy: string[];
  path: string[];
  writes: string[];
  unknown: string[];
  outcome: string;
  runs: number;
  runIds: string[];
  sources: string[];
  firstSeen: number;
  lastSeen: number;
  nearest: CoverageGroup['nearest'];
  packed: { golden: string; runId: string } | null;
}

/** What `--pack` made of one group. */
export interface PackJson {
  key: string;
  /** The golden written, or null when none could be. */
  golden: string | null;
  /** The run packed: the replay of the capture that reproduced it. */
  runId: string | null;
  /** The imported run it reproduces. */
  from: string | null;
  /** The command it ran, and where that came from: given after `--`, or the recording that sends the same first request. */
  command: { argv: string[]; from: string } | null;
  /** Why it wasn't packed, or null. */
  why: string | null;
}

export interface CoverageJson {
  scanId: string;
  at: number;
  runs: number;
  uncovered: number;
  groups: CoverageGroupJson[];
  goldens: Array<{ golden: string; runId: string | null; path: string[] | null; writes: string[] | null; outcome: string | null; error: string | null }>;
  pack: PackJson[] | null;
}

export function coverageJson(result: CoverageScanResult, pack: PackJson[] | null = null): CoverageJson {
  const packed = new Map((pack ?? []).filter((p) => p.golden && p.runId).map((p) => [p.key, { golden: p.golden!, runId: p.runId! }]));
  return {
    scanId: result.scan.scanId,
    at: result.scan.at,
    runs: result.scan.runs,
    uncovered: result.scan.uncovered,
    groups: result.groups.map((g) => ({
      key: g.key,
      covered: g.coveredBy.length > 0,
      coveredBy: g.coveredBy,
      path: g.behaviour.path,
      writes: g.behaviour.writes,
      unknown: g.behaviour.unknown,
      outcome: g.behaviour.outcome,
      runs: g.runs,
      runIds: g.runIds,
      sources: g.sources,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      nearest: g.nearest,
      packed: packed.get(g.key) ?? null,
    })),
    goldens: result.goldens.map((g) => ({ golden: g.golden, runId: g.runId, path: g.behaviour?.path ?? null, writes: g.behaviour?.writes ?? null, outcome: g.behaviour?.outcome ?? null, error: g.error })),
    pack,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A path for one terminal line: up to eight steps, the middle elided past that. */
export function shortPath(path: readonly string[], arrow = ' → '): string {
  if (!path.length) return 'no tool calls';
  const steps = path.length > 8 ? [...path.slice(0, 5), `… ${path.length - 7} more …`, ...path.slice(-2)] : [...path];
  return steps.map((s) => safe(s)).join(arrow);
}

/** The report `coverage` prints: a line per behaviour, not covered first, with where each was seen and the nearest golden. */
export function formatCoverage(result: CoverageScanResult, p: Palette, o: { now?: number } = {}): string {
  const { scan, groups, goldens } = result;
  const lines: string[] = [];
  if (!scan.runs) {
    lines.push('No imported runs to read: coverage groups what captures and traces did (shadowlap import …) and checks it against the goldens.');
    return lines.join('\n');
  }
  lines.push(
    `${p.bold('Coverage')} of what ${plural(scan.runs, 'imported run')} did: ${plural(groups.length, 'behaviour')}, ${scan.uncovered ? p.red(`${scan.uncovered} not covered by a golden`) : p.green('each covered by a golden')} ${p.dim(`(${plural(scan.goldens, 'golden')} read)`)}`,
  );
  const now = o.now ?? Date.now();
  for (const g of groups) {
    const covered = g.coveredBy.length > 0;
    const mark = covered ? p.green('✓') : p.red('✗');
    lines.push('', `  ${mark} ${plural(g.runs, 'run').padEnd(8)} ${shortPath(g.behaviour.path)}`);
    const writes = g.behaviour.writes.length ? `writes ${g.behaviour.writes.map(safe).join(', ')}` : 'no writes';
    const unknown = g.behaviour.unknown.length ? p.dim(` (effect unknown: ${g.behaviour.unknown.map(safe).join(', ')})`) : '';
    const seen = `seen ${g.lastSeen > now - 60_000 ? 'just now' : ago(g.lastSeen)}${g.sources.length ? ` in ${g.sources.map(safe).join(', ')}` : ''}`;
    lines.push(`             ${writes}${unknown} · ${OUTCOME_WORDS[g.behaviour.outcome]} · ${seen}`);
    if (covered) lines.push(p.dim(`             covered by ${g.coveredBy.map(safe).join(', ')}`));
    else if (g.nearest) {
      const n = g.nearest;
      const then = n.differs ? (n.differs.seen === null ? `; then it stops where the golden calls ${safe(n.differs.golden ?? '')}` : n.differs.golden === null ? `; then it calls ${safe(n.differs.seen)} where the golden has stopped` : `; then it calls ${safe(n.differs.seen)} where the golden calls ${safe(n.differs.golden)}`) : ', but it ends another way';
      lines.push(p.dim(`             nearest golden: ${safe(n.golden)}, the same for ${plural(n.shared, 'step')}${then}`));
    }
    if (!covered) lines.push(p.dim(`             runs: ${g.runIds.slice(0, 3).map((id) => shortId(id)).join(' ')}${g.runIds.length > 3 ? ' …' : ''} · behaviour ${g.key}`));
  }
  const unreadable = goldens.filter((g) => g.error);
  if (unreadable.length) lines.push('', p.yellow(`! ${plural(unreadable.length, 'golden')} could not be read, so ${unreadable.length === 1 ? 'it covers' : 'they cover'} nothing here: ${unreadable.map((g) => `${safe(g.golden)} (${safe(g.error!)})`).join('; ')}`));
  if (scan.uncovered) lines.push('', p.dim(`Make a golden of one run of each: shadowlap coverage --pack${goldens.length ? '' : ' (they go in goldens/)'}`));
  return lines.join('\n');
}

/** One behaviour in a sentence, for a dashboard line or a job's title. */
export function behaviourLine(b: Behaviour): string {
  return describeBehaviour(b);
}

/** The key a group goes by, from a prefix of it as typed (at least four characters). */
export function findGroup(groups: readonly CoverageGroup[], prefix: string): CoverageGroup | { error: string } {
  const p = prefix.trim().toLowerCase();
  if (p.length < 4) return { error: `a behaviour is named by its key, at least four characters of it (shadowlap coverage lists them): "${prefix}"` };
  const found = groups.filter((g) => g.key.startsWith(p));
  if (!found.length) return { error: `no behaviour ${prefix} in this scan (shadowlap coverage lists them)` };
  if (found.length > 1) return { error: `${prefix} names ${found.length} behaviours; give more of the key` };
  return found[0]!;
}

export { behaviourKey };
