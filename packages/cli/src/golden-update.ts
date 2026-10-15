import { existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { formatUsd, normalizeAddCommand, packRun, volatileValues, type CallRecord, type DivergenceReport, type Normalizer, type RunMeta, type RunRecord, type RunSummary, type Store } from '@shadowlap/engine';
import { type CheckResult, type TestSpec } from './checks.js';
import { upstreamOverrides, type ShadowlapConfig } from './config.js';
import { testAttempt, type GuardMode } from './run-agent.js';
import { telemetry, usageOf } from './shared.js';

/**
 * `shadowlap test --update`: a golden that diverged because the agent changed on purpose is
 * re-recorded, live, with every write tool stubbed (the agent is told the write succeeded; nothing
 * is sent), and replaces the old one in the working tree only when the agent exits 0 and the
 * golden's outcome checks pass on the new recording. What changed is printed, and the change is
 * reviewed in a pull request like any other.
 */

export interface UpdateContext {
  store: Store;
  config: Pick<ShadowlapConfig, 'normalize' | 'redact' | 'prices' | 'clock' | 'http'>;
  /** Where the recorded command runs. */
  cwd: string;
  guard: GuardMode;
  /** Called once the re-recording's run exists. */
  onRun?: (runId: string) => void;
}

export interface UpdateResult {
  /** The golden was replaced in the working tree. */
  replaced: boolean;
  /** Why it was not. */
  reason: string | null;
  /** The new recording, or null when it could not start. */
  run: RunRecord | null;
  summary: RunSummary | null;
  checks: CheckResult[] | null;
  code: number;
  output: string;
  before: CallCounts;
  after: CallCounts | null;
}

export interface CallCounts {
  total: number;
  model: number;
  tools: Record<string, number>;
}

export function callCounts(calls: readonly CallRecord[]): CallCounts {
  const tools: Record<string, number> = {};
  for (const c of calls) if (c.kind === 'tool') tools[c.name] = (tools[c.name] ?? 0) + 1;
  return { total: calls.length, model: calls.filter((c) => c.kind === 'api').length, tools };
}

/** What changed between two recordings, in one line: `12 calls, was 11 · model calls 5 → 6 · escalate 0 → 1`. */
export function describeChange(before: CallCounts, after: CallCounts): string {
  const parts = [`${after.total} call${after.total === 1 ? '' : 's'}${after.total === before.total ? ', as before' : `, was ${before.total}`}`];
  if (after.model !== before.model) parts.push(`model calls ${before.model} → ${after.model}`);
  const names = [...new Set([...Object.keys(before.tools), ...Object.keys(after.tools)])].sort();
  const tools = names.filter((n) => (before.tools[n] ?? 0) !== (after.tools[n] ?? 0)).map((n) => `${n} ${before.tools[n] ?? 0} → ${after.tools[n] ?? 0}`);
  if (tools.length) parts.push(tools.join(', '));
  return parts.join(' · ');
}

/**
 * Warnings that a divergence is a value the agent makes anew on every run, each naming its path and
 * the command that adds the normalizer that fixes it for good. Empty when it isn't.
 */
export function volatileWarning(d: DivergenceReport | null, normalizers: readonly Normalizer[] = []): Array<{ text: string; command: string }> {
  if (!d) return [];
  const { values, explainsAll } = volatileValues(d, normalizers);
  return values.map((v) => ({
    text:
      v.op === 'changed'
        ? `${v.path} looks like ${v.looks}, a value that changes every run: updating re-records it, and the next run diverges again. ${explainsAll ? 'A normalizer fixes it for good:' : 'The update covers the rest of the change; a normalizer fixes this part for good:'}`
        : `${v.path} is new in the request and looks like ${v.looks}, a value that changes every run: after this update the next run diverges on it, unless a normalizer masks it:`,
    command: normalizeAddCommand(v.normalizer),
  }));
}

/** Re-records a diverged golden live with writes stubbed, checks it, and replaces its pack when it passes. */
export async function rerecordGolden(dir: string, parent: RunRecord, spec: TestSpec | null, ctx: UpdateContext): Promise<UpdateResult> {
  const { store } = ctx;
  const before = callCounts(store.getCalls(parent.runId));
  // Live from the first call: a fork at call 1 that replays nothing. Writes are stubbed, so the
  // agent carries on as if each one succeeded and nothing acts on the world. As a fork, it may
  // diverge; the exit status and the golden's checks decide.
  const attempt = await testAttempt(store, parent, {
    cwd: ctx.cwd,
    upstreams: upstreamOverrides(process.env),
    extraEnv: {},
    writes: 'stub',
    guard: ctx.guard,
    normalizers: ctx.config.normalize,
    prices: ctx.config.prices,
    clock: ctx.config.clock,
    ...(ctx.config.http ? { http: ctx.config.http } : {}),
    spec: { ...(spec ?? { repeat: 1, passes: 1, tools: [] }), fork: true },
    divergeAt: 1,
    ...(ctx.onRun ? { onRun: ctx.onRun } : {}),
  });
  telemetry().record({ type: 'replay', ...usageOf(attempt.ended, attempt.ms, attempt.code) });
  const runId = attempt.ended.summary.runId;
  // A golden without checks keeps none on its new recording either (an undefined key is dropped when stored).
  if (!spec) store.updateRunMeta(runId, { checks: undefined } as unknown as Partial<RunMeta>);
  const after = callCounts(store.getCalls(runId));
  const reason = attempt.failure
    ? attempt.failure.message
    : before.model > 0 && after.model === 0
      ? 'the agent made no model calls through Shadowlap, so the new recording would hold none'
      : null;
  const result: UpdateResult = { replaced: false, reason, run: store.getRun(runId), summary: attempt.ended.summary, checks: spec ? attempt.checks : null, code: attempt.code, output: attempt.output, before, after };
  if (reason) return result;

  // The new pack is written beside the old one, then swapped in, so a failure leaves the old one.
  const target = resolve(dir);
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const fresh = join(dirname(target), `.${basename(target)}.new-${stamp}`);
  const old = join(dirname(target), `.${basename(target)}.old-${stamp}`);
  try {
    packRun(store, runId, fresh, { redact: ctx.config.redact });
    renameSync(target, old);
    try {
      renameSync(fresh, target);
    } catch (err) {
      renameSync(old, target);
      throw err;
    }
    rmSync(old, { recursive: true, force: true });
  } catch (err) {
    if (existsSync(fresh)) rmSync(fresh, { recursive: true, force: true });
    return { ...result, reason: `the new recording could not replace ${dir}: ${(err as Error).message}` };
  }
  return { ...result, replaced: true };
}

/** What a re-recording cost, as a receipt: `$0.04 live · 6 upstream requests`. */
export function updateReceipt(summary: RunSummary | null): string {
  if (!summary) return '';
  const spent = summary.cost.spent > 0 ? `${formatUsd(summary.cost.spent)} live` : 'no priced model calls';
  return `${spent} · ${summary.upstreamRequests} upstream request${summary.upstreamRequests === 1 ? '' : 's'}`;
}
