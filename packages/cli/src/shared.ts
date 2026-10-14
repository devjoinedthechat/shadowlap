import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { InvalidArgumentError } from 'commander';
import { formatDivergence, formatSummary, formatTokens, shortModel, Store, summarizeRun, type CallRecord, type RunRecord } from '@shadowlap/engine';
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

/** Asks before running an imported run's recorded command; refuses outright when nobody can answer. */
export async function confirmImportedCommand(runId: string, argv: string[]): Promise<boolean> {
  const cmd = quoteArgv(argv);
  const explain = `Run ${shortId(runId)} was imported from a pack. Replaying it runs the command it was recorded with:\n\n    ${safe(cmd)}\n\n`;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(p.red(explain) + `Pass --yes to run it, or give your own command: shadowlap replay ${shortId(runId)} -- <command>\n`);
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

export function requireRun(store: Store, idOrPrefix: string): RunRecord {
  const run = store.findRun(idOrPrefix);
  if (!run) throw new Error(`no run matches "${idOrPrefix}" (see: shadowlap ls)`);
  return run;
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
  if (summary.divergence) process.stderr.write(formatDivergence(summary.divergence, p) + '\n');
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
