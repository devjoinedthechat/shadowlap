import { resolve } from 'node:path';
import {
  behaviourKey,
  commandFinder,
  describeBehaviour,
  effectsFor,
  groupCoverage,
  hasRecordedCommand,
  NO_COMMAND,
  OUTCOME_WORDS,
  runBehaviour,
  runKind,
  Store,
  type StoreOf,
  storeEffects,
  strongest,
  ulid,
  unpackRun,
  type Behaviour,
  type CoverageGolden,
  type CoverageGroup,
  type CoverageMember,
  type CoverageNotPacked,
  type CoverageScan,
  type Effect,
  type InferredCommand,
  type Palette,
  type RunRecord,
  type StoredCoverageGroup,
  type StoredCoveragePack,
} from '@shadowlap/engine';
import { type TestEntry } from './checks.js';
import { type ShadowlapConfig } from './config.js';
import { type PackJson } from './coverage-pack.js';
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
  /** For each group no golden covers, by key: the command that would reproduce its newest run, when a recording here says it. */
  commands: Map<string, { argv: string[]; from: string } | null>;
  /** What `--pack` last made of each behaviour it tried, by key, from the store. */
  packs: Map<string, StoredCoveragePack>;
  /** Finds the command a run here says for a capture, reading the store once: `--pack` uses it too. */
  finder: (capture: RunRecord) => InferredCommand | null;
}

/**
 * The runs coverage reads: captures and traces, as the run list calls them (`capture`: a recording
 * that declares what it covers), that have ended, and that came with no command: production's
 * traffic. A partial recording that has the agent's command (a golden `--pack` made of a capture,
 * unpacked by `test`) is a run of the agent, not traffic. Picked out in SQL, so a store of many runs
 * reads only these.
 */
export function importedRuns(store: StoreOf<'recording' | 'readModels'>): RunRecord[] {
  const rows = store.query(
    `SELECT run_id FROM runs WHERE mode = 'record' AND status <> 'running' AND json_valid(meta) AND json_type(meta, '$.covers') = 'array' AND json_array_length(meta, '$.covers') > 0
       AND json_valid(command) AND json_extract(command, '$.argv[0]') = ? ORDER BY started_at ASC, run_id ASC`,
    NO_COMMAND,
  );
  return rows.map((r) => store.getRun(String(r.run_id))).filter((r): r is RunRecord => r !== null && runKind(r) === 'capture' && !hasRecordedCommand(r));
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
function recordedEffects(store: StoreOf<'recording'>, runId: string): Map<string, Effect> {
  const out = new Map<string, Effect>();
  for (const c of store.getCalls(runId)) if (c.kind === 'tool' && c.effect) out.set(c.name, strongest(out.get(c.name), c.effect));
  return out;
}

/**
 * Reads the imported runs and the goldens, groups the runs by behaviour, and keeps the scan in the
 * store (replacing the groups of the one before). `pack` is what the `--pack` before it made of each
 * behaviour it tried, so the groups a new golden covers say so, and the scan keeps what wasn't packed.
 */
export function scanCoverage(
  store: StoreOf<'recording' | 'readModels' | 'coverage'>,
  o: { projectDir: string; tests: readonly TestEntry[]; config: Pick<ShadowlapConfig, 'mcp'>; actor: string | null; folder?: string; pack?: readonly PackJson[]; finder?: (capture: RunRecord) => InferredCommand | null; now?: number },
): CoverageScanResult {
  const finder = o.finder ?? commandFinder(store);
  const packed = new Map((o.pack ?? []).filter((p) => p.golden && p.runId).map((p) => [p.key, { golden: p.golden!, runId: p.runId!, mode: p.mode }]));
  const notPacked = (o.pack ?? []).filter((p) => !p.golden).map((p) => ({ key: p.key, reason: p.reason ?? ('no-command' as const), why: p.why ?? '' }));
  const infos = listGoldens(o.projectDir, o.tests, o.folder ?? GOLDENS_FOLDER);
  // Effects first: what the config names, then each golden's recorded calls, then the store's.
  const configured = new Map<string, Effect>(Object.entries<Effect>(o.config.mcp?.effects ?? {}));
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
        ...(packed.size ? { packed: [...packed].map(([key, p]) => ({ key, golden: p.golden, runId: p.runId, ...(p.mode ? { mode: p.mode } : {}) })) } : {}),
        ...(notPacked.length ? { notPacked } : {}),
      },
    };
    const byId = new Map(runs.map((r) => [r.runId, r]));
    const stored: StoredCoverageGroup[] = groups.map((g) => {
      const p = packed.get(g.key);
      // What Pack one would reproduce the newest run with, when a recording here says it.
      const newest = g.coveredBy.length ? undefined : byId.get(g.runIds[0]!);
      return { ...g, scanId: scan.scanId, command: newest ? finder(newest) : null, packed: p ? { golden: p.golden, runId: p.runId, at, mode: p.mode } : null };
    });
    store.saveCoverageScan(scan, stored);
    const packs = new Map(store.coveragePacks().map((p) => [p.key, p]));
    return { scan, groups, goldens, members: byId, effects, commands: new Map(stored.map((g) => [g.key, g.command])), packs, finder };
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
  /** For a behaviour no golden covers: the command `--pack` would reproduce its newest run with, and the recording that says so; null when none does. */
  command: { argv: string[]; from: string } | null;
  /** The golden this run's `--pack` made of it. */
  packed: { golden: string; runId: string; mode: PackJson['mode'] } | null;
  /** What `--pack` last made of it, in this run or before: the golden and how it replays, or why it couldn't. */
  lastPack: { at: number; golden: string | null; mode: PackJson['mode']; reason: PackJson['reason']; why: string | null } | null;
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
  const packed = new Map((pack ?? []).filter((p) => p.golden && p.runId).map((p) => [p.key, { golden: p.golden!, runId: p.runId!, mode: p.mode }]));
  const last = (key: string): CoverageGroupJson['lastPack'] => {
    const p = result.packs.get(key);
    return p ? { at: p.at, golden: p.golden, mode: p.mode, reason: p.reason, why: p.why } : null;
  };
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
      command: result.commands.get(g.key) ?? null,
      packed: packed.get(g.key) ?? null,
      lastPack: last(g.key),
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

/** Why the last `--pack` couldn't pack a behaviour, as the report's line says it (`--json` has the sentence). */
const NOT_PACKED: Readonly<Record<CoverageNotPacked, string>> = {
  'no-command': 'nothing says what starts the agent (give its command after --, with {message} where its input goes)',
  'other-message': 'the command given starts the agent with another first message than production',
  'not-reproduced': 'the agent no longer does this (--fork with --expect keeps it as a golden that forks)',
  'agent-error': 'the agent failed on what production got back',
  gone: 'its runs are no longer in the store',
};

/**
 * The report `coverage` prints: a line per behaviour, not covered first, with where each was seen and
 * the nearest golden, and, unless this run just packed, why the last `--pack` couldn't pack one.
 */
export function formatCoverage(result: CoverageScanResult, p: Palette, o: { now?: number; packed?: boolean } = {}): string {
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
      // Where the two part goes on a line of its own, so the report stays within a terminal's width.
      const n = g.nearest;
      const then = n.differs ? (n.differs.seen === null ? `then it stops where the golden calls ${safe(n.differs.golden ?? '')}` : n.differs.golden === null ? `then it calls ${safe(n.differs.seen)} where the golden has stopped` : `then it calls ${safe(n.differs.seen)} where the golden calls ${safe(n.differs.golden)}`) : null;
      lines.push(p.dim(`             nearest golden: ${safe(n.golden)}, the same for ${plural(n.shared, 'step')}${then ? ';' : ', but it ends another way'}`));
      if (then) lines.push(p.dim(`             ${then}`));
    }
    if (!covered) lines.push(p.dim(`             runs: ${g.runIds.slice(0, 3).map((id) => shortId(id)).join(' ')}${g.runIds.length > 3 ? ' …' : ''} · behaviour ${g.key}`));
    const last = covered || o.packed ? null : result.packs.get(g.key);
    if (last && !last.golden && last.reason) lines.push(p.dim(`             last --pack, ${last.at > now - 60_000 ? 'just now' : ago(last.at)}: ${NOT_PACKED[last.reason] ?? safe(last.why ?? '')}`));
  }
  const unreadable = goldens.filter((g) => g.error);
  if (unreadable.length) lines.push('', p.yellow(`! ${plural(unreadable.length, 'golden')} could not be read, so ${unreadable.length === 1 ? 'it covers' : 'they cover'} nothing here: ${unreadable.map((g) => `${safe(g.golden)} (${safe(g.error!)})`).join('; ')}`));
  if (scan.uncovered) {
    // A behaviour no run here says how to start needs the agent's command, its input left to {message}.
    const unstarted = groups.some((g) => !g.coveredBy.length && !result.commands.get(g.key));
    lines.push('', p.dim(`Make a golden of one run of each: shadowlap coverage --pack${unstarted ? " -- <the agent's command, with {message} where its input goes>" : ''}${goldens.length ? '' : ' (they go in goldens/)'}`));
  }
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
