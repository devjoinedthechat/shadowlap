import { existsSync, statSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { InvalidArgumentError } from 'commander';
import { EXTERNAL_COMMAND, formatDivergence, formatSummary, formatTokens, pulledRun, recordEvent, resolveAuthor, shortModel, Store, summarizeRun, type CallRecord, type RecordEventInput, type RunRecord } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { defaultDbPath } from './config.js';
import { Telemetry, type EventInput } from './telemetry.js';
import { palette as p, quoteArgv, safe, shortId } from './ui.js';

/** What every command needs: the store, run lookup, argument parsing, telemetry and the summary printed after a run. */

export type RunSummaryLike = ReturnType<typeof summarizeRun>;

const require = createRequire(import.meta.url);
export const VERSION: string = (require('../package.json') as { version: string }).version;

let telemetryInstance: Telemetry | null = null;
export function telemetry(): Telemetry {
  return (telemetryInstance ??= new Telemetry({ version: VERSION }));
}

export function usageOf(result: EndRunResultLike, durationMs: number, exitCode: number | null): Omit<EventInput, 'type'> {
  const s = result.summary;
  return {
    providers: result.providers,
    sdks: result.sdks,
    calls: s.total,
    replayed: s.byOrigin.replayed,
    live: s.byOrigin.live,
    blocked: s.byOrigin.blocked,
    stubbed: s.byOrigin.stubbed,
    overridden: s.byOrigin.overridden,
    divergence: s.divergence?.type ?? null,
    tokensNotRespent: s.tokensNotRespent.inputTokens + (s.tokensNotRespent.cacheReadInputTokens ?? 0),
    durationMs,
    exitCode,
  };
}

export type EndRunResultLike = ReturnType<Sidecar['endRun']>;

export interface GlobalOpts {
  db?: string;
  verbose?: boolean;
}

export function openStore(opts: GlobalOpts): Store {
  return Store.open(opts.db ?? defaultDbPath(process.cwd()));
}

/**
 * The store, or null when the project has none yet: for commands that only read it or clean it up
 * (`gc`, `redact preview`, `calibrate`), which must not leave an empty store behind.
 */
export function openStoreIfExists(opts: GlobalOpts): Store | null {
  const dbPath = opts.db ?? defaultDbPath(process.cwd());
  return existsSync(dbPath) ? Store.open(dbPath) : null;
}

/** Stores {@link readStore} stood in for, with what to say about the one that isn't there. */
const missing = new WeakMap<Store, string>();

/**
 * The store for a command that only reads it, or changes only what it already holds (a run's
 * labels, a fix's title): when the project has none yet, an empty one in memory, so that a read
 * never leaves an empty store behind and a missing store reads as one with nothing in it. When
 * that is likely the wrong folder (the project's store is in one above it, or `--db` names a file
 * that isn't there), {@link missingStoreNote} says so.
 */
export function readStore(opts: GlobalOpts): Store {
  const dbPath = opts.db ?? defaultDbPath(process.cwd());
  if (existsSync(dbPath)) return Store.open(dbPath);
  const store = Store.open(':memory:');
  const note = opts.db ? `there is no store at ${opts.db}` : storeAbove(process.cwd());
  if (note) missing.set(store, note);
  return store;
}

/** Why a store from {@link readStore} has nothing in it, when it is likely the wrong one; null otherwise. */
export function missingStoreNote(store: Store): string | null {
  return missing.get(store) ?? null;
}

/** The nearest store in a folder above `cwd`, and how to use it: run from there, or name it with --db. Null for none. */
function storeAbove(cwd: string): string | null {
  for (let dir = cwd; dirname(dir) !== dir; ) {
    dir = dirname(dir);
    const found = defaultDbPath(dir);
    if (existsSync(found)) {
      const shown = relative(cwd, found);
      return `there is no store in this folder, and the nearest is ${shown}. Run shadowlap from ${dir}, or name that store: shadowlap --db ${shown} <command>`;
    }
  }
  return null;
}

/**
 * Records what a command changed in the project's activity log (a rule added or removed, old runs
 * cleaned up). Only into a store that exists: editing shadowlap.config.json never creates one. Never
 * fails the command, whose work is already done.
 */
export function recordEvents(opts: GlobalOpts, events: Array<Omit<RecordEventInput, 'actor'>>): void {
  if (!events.length) return;
  const dbPath = opts.db ?? defaultDbPath(process.cwd());
  if (!existsSync(dbPath)) return;
  try {
    const store = Store.open(dbPath);
    try {
      const actor = resolveAuthor({ cwd: process.cwd() });
      for (const event of events) recordEvent(store, { ...event, actor });
    } finally {
      store.close();
    }
  } catch {
    // a store from a newer Shadowlap, or one this user can't write: the activity line is lost, not the edit
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Asks before running an imported run's recorded command (a pack's, or a teammate's pulled from the
 * team store); refuses outright when nobody can answer. `own` is how to run the agent with a command
 * of the person's own instead, as the refusal suggests (default: a replay with one).
 */
export async function confirmImportedCommand(run: RunRecord, argv: string[], own = `shadowlap replay ${shortId(run.runId)} -- <command>`): Promise<boolean> {
  const runId = run.runId;
  const cmd = quoteArgv(argv);
  const author = typeof run.meta?.author === 'string' && run.meta.author ? run.meta.author : null;
  const from = pulledRun(run) ? `came from the team store${author ? `, recorded by ${safe(author)}` : ''}` : 'was imported from a pack';
  const explain = `Run ${shortId(runId)} ${from}. Replaying it runs the command it was recorded with:\n\n    ${safe(cmd)}\n\n`;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(p.red(explain) + `Pass --yes to run it, or give your own command: ${own}\n`);
    return false;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(p.yellow(explain) + 'Run it? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * How a run came to have no command to run again (`hasRecordedCommand` false): `shadowlap serve`
 * never saw what started the agent, and a capture records what was sent, not what sent it.
 */
export function withoutCommand(run: Pick<RunRecord, 'command'>): string {
  return run.command.argv[0] === EXTERNAL_COMMAND ? 'was recorded through shadowlap serve' : 'was imported from a capture';
}

export function requireRun(store: Store, idOrPrefix: string): RunRecord {
  const run = store.findRun(idOrPrefix);
  if (!run) {
    const note = missingStoreNote(store);
    throw new Error(`no run matches "${idOrPrefix}"${note ? `: ${note}` : ' (see: shadowlap ls)'}`);
  }
  return run;
}

/**
 * Why a run can't be copied or replayed yet, or null: a process is still recording it, or, for a
 * copy with its lineage, one of the runs it was forked from. The copy would never end (an HTML copy
 * shows it recording for good, a pack makes a golden of half a run), and a replay would run out of
 * recording part way. A run its process left marked running counts as ended: nothing will add to it.
 * `lineage` is the runs the copy holds besides `run` (ancestorsOf).
 */
export function stillRecording(store: Store, run: RunRecord, verb: string, lineage: readonly RunRecord[] = []): string | null {
  const short = (r: RunRecord) => r.runId.slice(0, 10);
  const all = [run, ...lineage];
  if (!all.some((r) => r.status === 'running')) return null;
  const live = new Set(store.recordingRuns().live.map((r) => r.run.runId));
  if (run.status === 'running' && live.has(run.runId)) return `${short(run)} is still recording: ${verb} it once it has ended`;
  const parent = lineage.find((r) => r.runId !== run.runId && r.status === 'running' && live.has(r.runId));
  return parent ? `${short(parent)}, which ${short(run)} was forked from, is still recording: ${verb} ${short(run)} with --lineage once it has ended, or without --lineage now` : null;
}

/** Refuses to copy or replay a run still recording, as the dashboard's Share, Replay and Fork do (stillRecording). */
export function requireEnded(store: Store, run: RunRecord, verb: string, lineage: readonly RunRecord[] = []): void {
  const why = stillRecording(store, run, verb, lineage);
  if (why) throw new Error(why);
}

/**
 * How a copy says no redaction rule was applied to it, and what it holds therefore: there were none
 * in the config, or `--no-redact` skipped the `configured` ones.
 */
export function unredacted(configured: number, holds: string): string {
  return configured ? `--no-redact: the ${configured === 1 ? 'redaction rule' : `${configured} redaction rules`} in shadowlap.config.json ${configured === 1 ? 'was' : 'were'} not applied; ${holds}` : `no redaction rules in shadowlap.config.json: ${holds}`;
}

/** The runs a run was forked from, its recording first: what `--lineage` adds to a copy of it. */
export function ancestorsOf(store: Store, run: RunRecord): RunRecord[] {
  const out: RunRecord[] = [];
  let parent = run.parentRunId ? store.getRun(run.parentRunId) : null;
  while (parent && out.length < 64 && !out.some((r) => r.runId === parent!.runId)) {
    out.unshift(parent);
    parent = parent.parentRunId ? store.getRun(parent.parentRunId) : null;
  }
  return out;
}

export function parseIntArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

/** `--override 9='{"a":1}'` or `--override 9=@result.json`; the call must be a tool call of the parent run. */

export function parseChoice<T extends string>(choices: readonly T[]) {
  return (value: string): T => {
    if (!(choices as readonly string[]).includes(value)) throw new InvalidArgumentError(`must be one of ${choices.join(', ')}`);
    return value as T;
  };
}

/** Spawns the agent under a sidecar-managed run and returns the child's exit status. */

export function printOutcome(summary: ReturnType<Sidecar['endRun']>['summary']): void {
  process.stderr.write('\n' + formatSummary(summary, p) + '\n');
  // One that stopped before its recording did changed no request: the summary line says it all.
  if (summary.divergence && summary.divergence.type !== 'ended_early') process.stderr.write(formatDivergence(summary.divergence, p) + '\n');
  process.stderr.write(p.dim(`  shadowlap show ${shortId(summary.runId)}\n`));
}

export function describeCall(store: Store, c: CallRecord): string[] {
  const end = c.end;
  const outcome = end ? (end.outcome === 'ok' ? p.green('ok') : p.red(end.meta.status ? `error ${end.meta.status}` : 'error')) : p.yellow('pending');
  // An injected failure is stored as live, because it did not come from the recording — but it did
  // not come from the provider either, and a reader of the timeline should not have to guess.
  const origin = end?.meta.injected ? 'injected' : c.origin;
  const originColor = c.origin === 'replayed' ? p.cyan : c.origin === 'live' ? p.bold : p.yellow;
  let detail = '';
  if (c.kind === 'api') {
    const u = end?.meta.usage;
    if (u) detail = `${formatTokens(u.inputTokens + (u.cacheReadInputTokens ?? 0))}→${formatTokens(u.outputTokens)} tok`;
    const model = shortModel(end?.meta.model ?? c.meta.model);
    detail = [detail, model, end?.meta.stopReason ?? ''].filter(Boolean).join(' · ');
  } else if (c.kind === 'tool' && c.requestRef) {
    const req = store.getJson<{ args?: unknown }>(c.requestRef);
    const args = JSON.stringify(req?.args ?? null);
    detail = args.length > 48 ? args.slice(0, 47) + '…' : args;
  }
  const attempts = c.attempts.length ? p.dim(` (+${c.attempts.length} retr${c.attempts.length === 1 ? 'y' : 'ies'})`) : '';
  const latency = end?.meta.latencyMs !== undefined ? `${end.meta.latencyMs}ms` : '';
  return [`#${c.callNo}`, c.kind, safe(c.name) + attempts, end?.meta.injected ? p.yellow(origin) : originColor(origin), outcome, latency, p.dim(safe(detail))];
}
