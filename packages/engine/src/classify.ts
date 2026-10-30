/**
 * What a run is, whether it is an attempt bundled under another run, how it came out, and what
 * happened to each of its calls: the words the Runs table, the Overview, the calendar and the status
 * bar count by. Pure functions over a run's record. No Node imports: the dashboard's browser bundle
 * imports this module on its own (`@shadowlap/engine/classify`).
 */
import { checkStatus } from './check-status.js';
import type { Origin, Outcome, RunMode, RunStatus } from './types.js';
import { isObject } from './is-object.js';
import { lostAround, lostWords } from './run-verdicts.js';

/**
 * - `recording`: recorded by `shadowlap run`.
 * - `fork`: a replay that left the recording at some call (`divergence`), on purpose or not; one
 *   that stopped before its recording did (`ended_early`) among them, labelled `ended early @n`.
 * - `clean`: a finished replay that matched the recording all the way: it exited 0, or it served
 *   every call of a recording that failed and failed the same way (it reproduced the failure).
 * - `replay`: any other replay: still running, interrupted, empty, or one that failed short of
 *   reproducing its recording.
 * - `test`: made by `shadowlap test` (`meta.test`).
 * - `capture`: imported from a capture or a trace: a partial recording with no command (`meta.covers`).
 * - `pack`: a recording unpacked here from a pack someone else recorded (`meta.imported`). One pulled
 *   from the team store is a `recording`: a teammate's, or CI's (`pulledRun`).
 */
export type RunKind = 'recording' | 'fork' | 'clean' | 'replay' | 'test' | 'capture' | 'pack';

/**
 * Runs made by `--repeat`, by blame's probes and by verify, bundled under the run they came from; and
 * the attempts of a golden one test session replays more than once (`test`), bundled under the
 * attempt its result shows. The attempts of an error-path preset (`chaos`) are bundled under the
 * recording they forked.
 */
export type AttemptKind = 'repeat' | 'probe' | 'verify' | 'test' | 'chaos';

export interface RunClass {
  kind: RunKind;
  /** The run an attempt is bundled under (the run it replayed); null for a run that is not an attempt, or one whose run is gone. */
  attemptOf: string | null;
  attemptKind: AttemptKind | null;
}

/**
 * The parts of a run's metadata classification reads. Loosely typed on purpose: a run can come from
 * a pack, so nothing in it is trusted to be well formed. A `RunMeta` satisfies it.
 */
export interface ClassifiableMeta {
  imported?: unknown;
  covers?: readonly unknown[] | undefined;
  repeat?: unknown;
  probe?: { of?: unknown } | undefined;
  verify?: unknown;
  test?: unknown;
  chaos?: unknown;
  checks?: ReadonlyArray<{ ok?: unknown; label?: unknown; status?: unknown }> | undefined;
  blame?: { outcome?: unknown; callNo?: unknown; rescuedRunId?: unknown; range?: unknown } | undefined;
}

/** What classification reads of a run. A `RunRecord` has it all; a lighter query can supply it too. */
export interface ClassifiableRun {
  runId: string;
  parentRunId: string | null;
  mode: RunMode;
  status: RunStatus;
  divergence: { callNo: number; type?: string } | null;
  meta?: ClassifiableMeta | undefined;
}

/** What the kind of a run depends on, besides the run itself. */
export interface KindFacts {
  /** The calls the run holds. A finished replay with none is not a clean replay. Unknown: assume it has some. */
  calls?: number;
  /**
   * The run it replayed: its calls and status. A replay that exited with an error is a clean replay
   * only when it served every call of a recording that failed as well. Unknown or gone: it is not.
   */
  parent?: { calls: number; status: RunStatus } | null;
}

export interface ClassifyContext extends KindFacts {
  /**
   * The run is the fork blame rescued its run with (the blamed run's `meta.blame.rescuedRunId`).
   * Blame made it as a probe, but it is the path that passed, so it shows as a fork of its own.
   */
  rescued?: boolean;
}

/**
 * A team store's URL, as a pull marks the runs it brings (`meta.imported.from`): `s3://`, `gs://`,
 * `az://` or `r2://`, as `@shadowlap/remote` reads them. An unpack names the pack's folder there,
 * and an import its file or trace source, so none of them reads as a store.
 */
const STORE_URL = /^(?:s3|gs|az|r2):\/\/\S/;

/**
 * A run pulled from the team store: made by a teammate or by CI, on their machine, and kept there
 * with the team's runs. It reads as what it is (a recording, a fork), by its author, with what it
 * spent; a pack someone sent is the kind `pack`. Its command is still someone else's, so a replay
 * asks before running it (`commandIsImported`).
 */
export function pulledRun(run: { meta?: { imported?: unknown } | null | undefined }): boolean {
  const imported = run.meta?.imported;
  return isObject(imported) && typeof imported.from === 'string' && STORE_URL.test(imported.from);
}

/**
 * A recording whose calls were made outside the team's own runs: unpacked from a pack, or imported
 * from a capture or a trace (one a teammate pushed included). What its calls cost was paid where that
 * traffic ran: it counts as captured, not spent, and says nothing about the prompt cache. A
 * teammate's recording pulled from the team store is the team's: what it spent was spent.
 */
export function importedRecording(run: { mode: RunMode; meta?: { imported?: unknown; covers?: readonly unknown[] | null | undefined } | null | undefined }): boolean {
  if (run.mode !== 'record' || !run.meta?.imported) return false;
  return !pulledRun(run) || (Array.isArray(run.meta.covers) && run.meta.covers.length > 0);
}

/** The kind of a run, from its mode, divergence, metadata and, for a replay that failed, the run it replayed. */
export function runKind(run: Pick<ClassifiableRun, 'mode' | 'status' | 'divergence' | 'meta'>, facts: KindFacts = {}): RunKind {
  const m = run.meta;
  if (m?.test) return 'test';
  if (run.mode !== 'replay' && Array.isArray(m?.covers) && m.covers.length > 0) return 'capture';
  if (run.mode !== 'replay') return m?.imported && !pulledRun(run) ? 'pack' : 'recording';
  if (run.divergence) return 'fork';
  const { calls, parent } = facts;
  if (calls === 0) return 'replay';
  if (run.status === 'completed') return 'clean';
  // It exited with an error, but nothing was left out: every call of a recording that failed too
  // came from the recording, so this is that failure, reproduced exactly.
  if (run.status === 'failed' && parent?.status === 'failed' && calls !== undefined && calls >= parent.calls) return 'clean';
  return 'replay';
}

/**
 * A kind as the run list's line under the id says it: recording, capture, fork @n, clean replay,
 * replay or test. A replay that stopped before its recording did left it as a fork does, but made
 * nothing after: `ended early @n`, at the first recorded call it never made.
 */
export function kindLabel(kind: RunKind, divergence: { callNo: number; type?: string } | null): string {
  switch (kind) {
    case 'fork':
      return divergence ? `${divergence.type === 'ended_early' ? 'ended early' : 'fork'} @${divergence.callNo}` : 'fork';
    case 'clean':
      return 'clean replay';
    case 'pack':
      return 'recording';
    default:
      return kind;
  }
}

/**
 * A run's kind and, for an attempt, the run it is bundled under: the run it replayed. Probes of
 * `shadowlap blame` carry `meta.probe`, attempts of `shadowlap verify` carry `meta.verify`, and the
 * attempts of `replay --repeat` carry `meta.repeat`. A test run is the result of its golden in that
 * session, unless the golden was replayed more than once: then every attempt but the one its result
 * shows names that one (`meta.test.of`), a replay of the same recording, and is bundled under it.
 * Whether the run it names is that (a test run of the same golden, session and recording) only the
 * whole store can tell: `filedTestAttempt` checks it, for `attemptBundles` and the dashboard's run
 * index alike.
 */
export function classifyRun(run: ClassifiableRun, ctx: ClassifyContext = {}): RunClass {
  const kind = runKind(run, ctx);
  const m = run.meta;
  if (m?.test) {
    const of = isObject(m.test) ? m.test.of : undefined;
    const filed = typeof of === 'string' && of !== '' && of !== run.runId && run.mode === 'replay' && run.parentRunId !== null && of !== run.parentRunId;
    return filed && !ctx.rescued ? { kind, attemptOf: of, attemptKind: 'test' } : { kind, attemptOf: null, attemptKind: null };
  }
  if (!m || ctx.rescued) return { kind, attemptOf: null, attemptKind: null };
  const attemptKind: AttemptKind | null = isObject(m.probe) ? 'probe' : isObject(m.verify) ? 'verify' : isObject(m.repeat) ? 'repeat' : isObject(m.chaos) ? 'chaos' : null;
  if (!attemptKind) return { kind, attemptOf: null, attemptKind: null };
  // Blame always probes the run it replays. A probe naming another run did not come from blame here
  // (a pack can carry anything), and must not hide under, or be deleted with, a run it names.
  if (attemptKind === 'probe' && typeof m.probe?.of === 'string' && run.parentRunId !== null && m.probe.of !== run.parentRunId) return { kind, attemptOf: null, attemptKind: null };
  return { kind, attemptOf: run.parentRunId, attemptKind };
}

/**
 * Whether a test run that names `head` as the attempt its result shows (`meta.test.of`) is filed
 * under it: `head` is a test run of the same golden and session that replayed the same recording,
 * and no attempt itself. A run naming any other run (a pack can carry anything) is listed as a run
 * of its own, and is never hidden under, or deleted with, the run it names.
 */
export function filedTestAttempt(attempt: Pick<ClassifiableRun, 'parentRunId' | 'meta'>, head: Pick<ClassifiableRun, 'parentRunId' | 'meta'>): boolean {
  const a = attempt.meta?.test;
  const h = head.meta?.test;
  if (!isObject(a) || !isObject(h)) return false;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return typeof h.of !== 'string' && text(h.golden) === text(a.golden) && text(h.session) === text(a.session) && head.parentRunId === attempt.parentRunId;
}

/**
 * The attempts bundled under each run, as every list bundles them (`classifyRun`): each attempt by
 * the run it is filed under, when that run is among `runs`, and a test's only under a run it may be
 * filed under (`filedTestAttempt`). The fork blame rescued its run with shows as a fork of its own,
 * so it is in no bundle. What the lists leave out, and what goes when the run it is filed under is
 * deleted (`withAttempts`).
 */
export function attemptBundles(runs: readonly ClassifiableRun[]): Map<string, string[]> {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const rescued = new Set<string>();
  for (const r of runs) {
    const id = isObject(r.meta?.blame) ? r.meta.blame.rescuedRunId : undefined;
    if (typeof id === 'string') rescued.add(id);
  }
  const out = new Map<string, string[]>();
  for (const r of runs) {
    const c = classifyRun(r, { rescued: rescued.has(r.runId) });
    const head = c.attemptOf ? byId.get(c.attemptOf) : undefined;
    if (!c.attemptKind || !head || head.runId === r.runId) continue;
    if (c.attemptKind === 'test' && !filedTestAttempt(r, head)) continue;
    const list = out.get(head.runId);
    if (list) list.push(r.runId);
    else out.set(head.runId, [r.runId]);
  }
  return out;
}

/**
 * The attempts bundled under a run, and those bundled under them in turn (a `--repeat` of one of
 * blame's probes), in the order found: what a list shows only through the run, and what goes with it
 * when it is deleted. Never the run itself.
 */
export function withAttempts(bundles: ReadonlyMap<string, readonly string[]>, runId: string): string[] {
  const out: string[] = [];
  const seen = new Set([runId]);
  for (let i = -1; i < out.length; i++) {
    for (const id of bundles.get(i < 0 ? runId : out[i]!) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * How a run's outcome checks came out: `passed` of `total`, and, when there are any, how many were
 * `inconclusive` (could not be decided) or `notApplicable` (a `when` whose condition never held);
 * the rest failed. A not-applicable check is never counted as passed.
 */
export interface CheckCounts {
  passed: number;
  total: number;
  inconclusive?: number;
  notApplicable?: number;
}

/** The checks counts says failed: those neither passed, inconclusive nor not applicable. */
export const failedChecks = (n: CheckCounts): number => n.total - n.passed - (n.inconclusive ?? 0) - (n.notApplicable ?? 0);

/** The outcome checks a run carries (`meta.checks`, from `shadowlap test` or an attempt's oracle), counted by how they came out. */
export function checksOf(run: Pick<ClassifiableRun, 'meta'>): CheckCounts | null {
  const checks = run.meta?.checks;
  if (!Array.isArray(checks) || checks.length === 0) return null;
  // Something stored that is no check at all counts as failed: it is no pass.
  const statuses = checks.map((c) => (isObject(c) ? checkStatus(c) : 'failed'));
  const n = (s: string) => statuses.filter((x) => x === s).length;
  const inconclusive = n('inconclusive');
  const notApplicable = n('not-applicable');
  return { passed: n('passed'), total: checks.length, ...(inconclusive ? { inconclusive } : {}), ...(notApplicable ? { notApplicable } : {}) };
}

/** The model call `shadowlap blame` found lost the run, or null when it found none (or never ran). */
export function lostAt(run: Pick<ClassifiableRun, 'meta'>): number | null {
  const b = run.meta?.blame;
  return isObject(b) && b.outcome === 'blamed' && typeof b.callNo === 'number' && Number.isInteger(b.callNo) ? b.callNo : null;
}

/** A run blame found lost at `callNo`: and when no one call lost it, the two it was lost gradually around (lostAround). */
function lostOutcome(run: Pick<ClassifiableRun, 'meta'>, callNo: number): RunOutcome {
  const range = lostAround(run.meta?.blame?.range);
  return { kind: 'lost', callNo, ...(range ? { range } : {}) };
}

/**
 * How a run came out, as the Runs table's status column says it. Only the outcome: the line under
 * the run's id already says what kind of run it is.
 * - `running`: in progress.
 * - `diverged`: a test replay that left its golden at call `callNo`.
 * - `lost`: `shadowlap blame` replayed the run, saw it fail, and found the model call that lost it,
 *   or, with `range`, the two calls it was lost gradually around (lostAround): lostWords says which.
 * - `check-failed`: an outcome check failed, blame confirmed a failure it could not place, the
 *   agent exited with an error (the first check of every oracle is that it exits 0), or a test
 *   replay made no calls.
 * - `inconclusive`: no check failed, but one could not be decided (a judge with no verdict, a
 *   condition that could not be read). Not a failure, and never a pass.
 * - `passed`: every outcome check passed or did not apply: `checks` passed, `notApplicable` did
 *   not apply (when any did).
 * - `clean`: a clean replay, or a test that replayed clean without checks.
 * - `none`: nothing to report.
 */
export type RunOutcome =
  | { kind: 'running' }
  | { kind: 'diverged'; callNo: number }
  | { kind: 'lost'; callNo: number; range?: { from: number; to: number; gradual: true } }
  | { kind: 'check-failed'; check: string | null }
  | { kind: 'inconclusive'; check: string | null }
  | { kind: 'passed'; checks: number; notApplicable?: number }
  | { kind: 'clean' }
  | { kind: 'none' };

export interface OutcomeContext extends KindFacts {
  /** The run's kind, when already known. */
  kind?: RunKind;
  /**
   * The run answered a call with an injected failure (`--fail-at`). An agent that then exits with an
   * error did what the fork asked of it: that exit is not a failure.
   */
  injected?: boolean;
  /**
   * A call of the run was refused because it ran offline, as `shadowlap test` runs a golden that may
   * not fork: the replay left the recording and needed the network.
   */
  offline?: boolean;
}

/**
 * Whether a test run's divergence is its outcome. `shadowlap test` fails a golden that diverges,
 * whatever its checks say, unless the golden may fork (`"fork": true` under `tests`): then it goes
 * live from the fork and its checks decide. A run that says which (`meta.test.fork`) is taken at its
 * word; otherwise a call refused offline shows the golden was held to its recording, and a run with
 * no checks has nothing else to be judged by.
 */
function divergenceDecides(run: ClassifiableRun, hasChecks: boolean, offline: boolean): boolean {
  const test = run.meta?.test;
  const fork = isObject(test) ? test.fork : undefined;
  if (typeof fork === 'boolean') return !fork;
  return !hasChecks || offline;
}

/** What a test that made no calls failed on, in `shadowlap test`'s words. */
const NO_CALLS = 'no calls were made';

/** How a run came out. Reads `status`, `divergence`, `meta.blame` and `meta.checks`, as `ls --json` and lineage report them. */
export function runOutcome(run: ClassifiableRun, ctx: OutcomeContext = {}): RunOutcome {
  if (run.status === 'running') return { kind: 'running' };
  const kind = ctx.kind ?? runKind(run, ctx);
  const checks = checksOf(run);
  // Blame only records a result after replaying the run and seeing it fail.
  if (isObject(run.meta?.blame)) {
    const at = lostAt(run);
    return at !== null ? lostOutcome(run, at) : { kind: 'check-failed', check: firstCheck(run, 'failed') };
  }
  if (kind === 'test' && run.divergence && divergenceDecides(run, checks !== null, ctx.offline === true)) return { kind: 'diverged', callNo: run.divergence.callNo };
  // `shadowlap test` fails a golden whose replay made no calls at all: nothing was tested.
  if (kind === 'test' && ctx.calls === 0 && run.status === 'completed') return { kind: 'check-failed', check: NO_CALLS };
  if (checks && failedChecks(checks) > 0) return { kind: 'check-failed', check: firstCheck(run, 'failed') };
  if (run.status === 'failed' && !ctx.injected) return { kind: 'check-failed', check: null };
  if (checks?.inconclusive) return { kind: 'inconclusive', check: firstCheck(run, 'inconclusive') };
  if (checks) return { kind: 'passed', checks: checks.passed, ...(checks.notApplicable ? { notApplicable: checks.notApplicable } : {}) };
  if (kind === 'clean' || (kind === 'test' && run.status === 'completed')) return { kind: 'clean' };
  return { kind: 'none' };
}

/** The label of the run's first check that came out `status`. */
function firstCheck(run: ClassifiableRun, status: 'failed' | 'inconclusive'): string | null {
  const checks = run.meta?.checks;
  if (!Array.isArray(checks)) return null;
  const found = (checks as unknown[]).find((c): c is Record<string, unknown> => isObject(c) && checkStatus(c) === status);
  return found && typeof found.label === 'string' ? found.label : null;
}

/**
 * Whether an outcome is a failure: what the Failed chip and the calendar's red count. An
 * inconclusive one is not: it needs a verdict, not a fix.
 */
export function isFailedOutcome(o: RunOutcome): boolean {
  return o.kind === 'diverged' || o.kind === 'lost' || o.kind === 'check-failed';
}

/** The outcome in the words the Runs table uses. */
export function outcomeLabel(o: RunOutcome): string {
  switch (o.kind) {
    case 'running':
      return 'in progress';
    case 'diverged':
      return `diverged at #${o.callNo}`;
    case 'lost':
      return lostWords(o.callNo, o.range);
    case 'check-failed':
      return 'check failed';
    case 'inconclusive':
      return 'check inconclusive';
    case 'passed': {
      const na = o.notApplicable ?? 0;
      const noun = (n: number) => (n === 1 ? 'check' : 'checks');
      if (!na) return `${o.checks} ${noun(o.checks)} passed`;
      return o.checks ? `${o.checks} ${noun(o.checks)} passed, ${na} not applicable` : `${na} ${noun(na)} not applicable`;
    }
    case 'clean':
      return 'clean';
    case 'none':
      return '—';
  }
}

// ---- what happened to each call ----

/**
 * Where a call's answer came from, as every view that colours a call says it. The store keeps an
 * injected failure (`--fail-at`) as live, but Shadowlap answered it, not the provider. A call whose
 * answer was an error is `failed`, unless the error is the fence itself (a blocked write) or an
 * injected one.
 */
export type DisplayOrigin = 'replayed' | 'live' | 'overridden' | 'injected' | 'failed' | 'blocked' | 'stubbed';

/** One character per call: r replayed, l live, o overridden, i injected, f failed, b blocked, s stubbed. */
export type OriginCode = 'r' | 'l' | 'o' | 'i' | 'f' | 'b' | 's';

export const ORIGIN_CODE: Readonly<Record<DisplayOrigin, OriginCode>> = { replayed: 'r', live: 'l', overridden: 'o', injected: 'i', failed: 'f', blocked: 'b', stubbed: 's' };
export const ORIGIN_OF_CODE: Readonly<Record<OriginCode, DisplayOrigin>> = { r: 'replayed', l: 'live', o: 'overridden', i: 'injected', f: 'failed', b: 'blocked', s: 'stubbed' };
/** Every code, in the order legends list them. */
export const ORIGIN_CODES: readonly OriginCode[] = ['r', 'l', 'b', 's', 'o', 'i', 'f'];

/**
 * Which origin a range of calls shows when one cell stands for several: the most notable, so one
 * blocked write among replayed calls stays visible.
 */
export const ORIGIN_RANK: Readonly<Record<OriginCode, number>> = { f: 7, i: 6, b: 5, s: 4, o: 3, l: 2, r: 1 };

/** A call's display origin from its stored origin and its final answer (null while it has none). */
export function displayOrigin(origin: Origin, end: { outcome: Outcome; injected?: unknown } | null): DisplayOrigin {
  if (end?.injected === true) return 'injected';
  if (end?.outcome === 'error' && origin !== 'blocked' && origin !== 'stubbed') return 'failed';
  return origin;
}

export type OriginCounts = Record<OriginCode, number>;

export function emptyOriginCounts(): OriginCounts {
  return { r: 0, l: 0, o: 0, i: 0, f: 0, b: 0, s: 0 };
}

/** Calls per origin in a run's origin string. */
export function countOrigins(codes: string, into: OriginCounts = emptyOriginCounts()): OriginCounts {
  for (const ch of codes) if (ch in into) into[ch as OriginCode]++;
  return into;
}

/** The most notable origin among the codes, or null for none. */
export function notableOrigin(codes: string): OriginCode | null {
  let best: OriginCode | null = null;
  for (const ch of codes) {
    const c = ch as OriginCode;
    if (ORIGIN_RANK[c] !== undefined && (best === null || ORIGIN_RANK[c] > ORIGIN_RANK[best])) best = c;
  }
  return best;
}

/** One cell per `size` calls, each the most notable origin of its range. */
export function originCells(codes: string, size: number): string {
  if (size <= 1) return codes;
  let out = '';
  for (let i = 0; i < codes.length; i += size) out += notableOrigin(codes.slice(i, i + size)) ?? '';
  return out;
}

/** The strip's rule: one cell per call, or past `maxCells` calls one cell per range of `size` calls. */
export function binOrigins(codes: string, maxCells: number): { size: number; cells: string } {
  const size = codes.length > maxCells ? Math.ceil(codes.length / maxCells) : 1;
  return { size, cells: originCells(codes, size) };
}
