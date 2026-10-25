import { agentCallsOf } from './judge-scope.js';
import type { Palette } from './report.js';
import { formatTokens, plain } from './report.js';
import { formatUsd } from './prices.js';
import { wholeInput } from './tokens.js';
import { safeLine } from './text.js';
import type { CallRecord, RunStatus, RunSummary } from './types.js';

/**
 * The same fork run several times. Everything before the fork is served from the recording, so it
 * is identical in every attempt; everything after it is live and may not be. The report answers the
 * question a single fork can't: did the change fix the behavior, or did this attempt get lucky?
 * Attempts are grouped by their path after the fork: the tools they called, model turn by model turn,
 * and what happened to each call.
 */

export interface RepeatAttemptInput {
  runId: string;
  exitCode: number;
  summary: RunSummary;
  calls: CallRecord[];
}

export interface RepeatAttempt {
  runId: string;
  exitCode: number;
  status: RunStatus;
  /** The call the attempt forked at, or null for a clean replay and one that ended early. */
  forkedAt: number | null;
  /**
   * An attempt that never forked but stopped before its recording did: the first recorded model or
   * tool call it never made. Null otherwise.
   */
  endedEarly: number | null;
  calls: number;
  replayed: number;
  live: number;
  blocked: number;
  stubbed: number;
  upstreamRequests: number;
  spent: number;
  /** Tool calls from the fork on, each as its name plus what happened to it when not plain live; sorted within a model turn. */
  path: string[];
  /** The last model response's content (text and tool calls), to count distinct final answers. */
  finalResponse: string | null;
}

export interface RepeatReport {
  parentRunId: string;
  attempts: RepeatAttempt[];
  /** Distinct fork points, in call order. One entry when the prefix is deterministic, as it should be. */
  forkedAt: Array<number | null>;
  /** Distinct paths, most frequent first. */
  paths: Array<{ path: string[]; runIds: string[] }>;
  /** Tools called after the fork, with how many attempts called each. */
  tools: Array<{ name: string; attempts: number; calls: number; blocked: number; stubbed: number; errors: number }>;
  distinctFinalResponses: number;
  succeeded: number;
  spent: number;
  saved: number;
  tokensNotRespent: number;
}

/**
 * Tool calls from `from` on. Calls between the same two model calls are sorted: agents often run a
 * turn's tools at once, and the order they start in is scheduling, not something the model chose.
 */
export function pathOf(calls: CallRecord[], from: number | null): string[] {
  const path: string[] = [];
  let turn: string[] = [];
  const endTurn = () => {
    path.push(...turn.sort());
    turn = [];
  };
  for (const c of [...calls].sort((a, b) => a.callNo - b.callNo)) {
    if (from !== null && c.callNo < from) continue;
    if (c.kind === 'api') endTurn();
    if (c.kind !== 'tool') continue;
    const what = c.origin === 'blocked' || c.origin === 'stubbed' || c.origin === 'overridden' ? c.origin : c.end?.outcome === 'error' ? 'error' : null;
    turn.push(what ? `${c.name} (${what})` : c.name);
  }
  endTurn();
  return path;
}

export interface RepeatOptions {
  /**
   * What a model response says, for comparing final answers. Responses carry ids and timestamps, so
   * their bytes differ even when the answer doesn't; the CLI passes the parsed text and tool calls.
   * Defaults to the stored response hash.
   */
  responseContent?: (call: CallRecord) => string | null;
}

export function summarizeRepeats(parentRunId: string, given: RepeatAttemptInput[], options: RepeatOptions = {}): RepeatReport {
  const contentOf = options.responseContent ?? ((c: CallRecord) => c.end?.responseRef ?? null);
  // What the agent did: a judge check's calls are none of its paths, tools or final answers.
  const inputs = given.map((i) => ({ ...i, calls: agentCallsOf(i.calls) }));
  const attempts: RepeatAttempt[] = inputs.map(({ runId, exitCode, summary: s, calls }) => {
    const d = s.divergence;
    const forkedAt = d && d.type !== 'ended_early' ? d.callNo : null;
    const lastApi = [...calls].reverse().find((c) => c.kind === 'api' && c.end);
    return {
      runId,
      exitCode,
      status: s.status,
      forkedAt,
      endedEarly: d?.type === 'ended_early' ? d.callNo : null,
      calls: s.total,
      replayed: s.byOrigin.replayed + s.byOrigin.overridden,
      live: s.byOrigin.live,
      blocked: s.byOrigin.blocked,
      stubbed: s.byOrigin.stubbed,
      upstreamRequests: s.upstreamRequests,
      spent: s.cost.spent,
      path: pathOf(calls, forkedAt),
      finalResponse: lastApi ? contentOf(lastApi) : null,
    };
  });

  const byPath = new Map<string, { path: string[]; runIds: string[] }>();
  for (const a of attempts) {
    const key = JSON.stringify(a.path);
    const group = byPath.get(key) ?? { path: a.path, runIds: [] };
    group.runIds.push(a.runId);
    byPath.set(key, group);
  }
  const paths = [...byPath.values()].sort((x, y) => y.runIds.length - x.runIds.length);

  const tools = new Map<string, { name: string; attempts: number; calls: number; blocked: number; stubbed: number; errors: number }>();
  inputs.forEach((input, i) => {
    const seen = new Set<string>();
    for (const c of input.calls) {
      if (c.kind !== 'tool' || (attempts[i]!.forkedAt !== null && c.callNo < attempts[i]!.forkedAt)) continue;
      const t = tools.get(c.name) ?? { name: c.name, attempts: 0, calls: 0, blocked: 0, stubbed: 0, errors: 0 };
      t.calls++;
      if (c.origin === 'blocked') t.blocked++;
      else if (c.origin === 'stubbed') t.stubbed++;
      else if (c.end?.outcome === 'error') t.errors++;
      if (!seen.has(c.name)) {
        t.attempts++;
        seen.add(c.name);
      }
      tools.set(c.name, t);
    }
  });

  return {
    parentRunId,
    attempts,
    forkedAt: [...new Set(attempts.map((a) => a.forkedAt))].sort((a, b) => (a ?? 0) - (b ?? 0)),
    paths,
    tools: [...tools.values()].sort((a, b) => b.attempts - a.attempts || a.name.localeCompare(b.name)),
    distinctFinalResponses: new Set(attempts.map((a) => a.finalResponse ?? '')).size,
    succeeded: attempts.filter((a) => a.exitCode === 0).length,
    spent: inputs.reduce((sum, i) => sum + i.summary.cost.spent, 0),
    saved: inputs.reduce((sum, i) => sum + i.summary.cost.saved, 0),
    tokensNotRespent: inputs.reduce((sum, i) => sum + wholeInput(i.summary.tokensNotRespent), 0),
  };
}

const short = (id: string) => id.slice(0, 10);

export function formatRepeats(r: RepeatReport, p: Palette = plain): string {
  const n = r.attempts.length;
  const lines: string[] = [];
  const forks = r.forkedAt.filter((f): f is number => f !== null);
  const where =
    r.forkedAt.length === 1
      ? forks.length
        ? `each forked at call ${forks[0]}`
        : 'none forked'
      : `forked at calls ${r.forkedAt.map((f) => (f === null ? 'none' : f)).join(', ')}: the prefix is not deterministic`;
  // An attempt that stopped before its recording did forked nowhere, yet is no clean replay either.
  const early = r.attempts.filter((a) => a.endedEarly !== null);
  const ended = early.length ? p.red(` · ${early.length} of ${n} ended early, at call ${[...new Set(early.map((a) => a.endedEarly!))].sort((a, b) => a - b).join(', ')}`) : '';
  lines.push(`${p.yellow('⑂')} ${p.bold(`${n} attempts`)} from ${short(r.parentRunId)}, ${where}${ended}`);
  const cost = r.spent || r.saved ? ` · ≈${formatUsd(r.spent)} spent, ${formatUsd(r.saved)} not re-spent` : '';
  lines.push(`  ${r.succeeded} of ${n} exited 0 · ${r.attempts.reduce((s, a) => s + a.upstreamRequests, 0)} upstream requests · ${formatTokens(r.tokensNotRespent)} input tokens not re-spent${cost}`);

  lines.push('', `  ${p.bold('Paths after the fork')}`);
  for (const g of r.paths) {
    const label = g.path.length ? g.path.map((s) => safeLine(s)).join(' → ') : p.dim('no tool calls');
    lines.push(`    ${String(g.runIds.length).padStart(String(n).length)}×  ${label}`);
  }
  if (r.paths.length === 1) lines.push(p.green(`  every attempt took the same path`));
  else lines.push(p.yellow(`  ${r.paths.length} different paths: the change doesn't settle the behavior on its own`));

  if (r.tools.length) {
    const width = Math.max(4, ...r.tools.map((t) => safeLine(t.name).length));
    lines.push('', `  ${p.bold('Tools after the fork')}`, p.dim(`    ${'tool'.padEnd(width)}  ${'attempts'.padEnd(9)}  calls`));
    for (const t of r.tools) {
      const fenced = [t.blocked ? `${t.blocked} blocked` : '', t.stubbed ? `${t.stubbed} stubbed` : '', t.errors ? `${t.errors} errors` : ''].filter(Boolean).join(', ');
      lines.push(`    ${safeLine(t.name).padEnd(width)}  ${`${t.attempts} of ${n}`.padEnd(9)}  ${t.calls}${fenced ? p.dim(` (${fenced})`) : ''}`);
    }
  } else {
    lines.push('', p.dim('  No tool was called after the fork in any attempt.'));
  }

  lines.push('', `  Final model responses: ${r.distinctFinalResponses === 1 ? 'the same in every attempt' : `${r.distinctFinalResponses} different`}`);
  lines.push(p.dim(`  runs: ${r.attempts.map((a) => short(a.runId)).join(' ')}`));
  if (r.paths.length > 1) lines.push(p.dim(`  compare the two most common paths: shadowlap diff ${short(r.paths[0]!.runIds[0]!)} ${short(r.paths[1]!.runIds[0]!)}`));
  return lines.join('\n');
}
