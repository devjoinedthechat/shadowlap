import { spawn } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { estimateCost, finalAnswer, formatUsd, normalizeAddCommand, packRun, volatileValues, type CallRecord, type DivergenceReport, type RunRecord, type RunSummary, type Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { evaluateChecks, type CheckResult, type TestSpec } from './checks.js';
import { codeVersion, upstreamOverrides, type ShadowlapConfig } from './config.js';
import { agentEnv, type GuardMode } from './run-agent.js';
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
export function volatileWarning(d: DivergenceReport | null): Array<{ text: string; command: string }> {
  if (!d) return [];
  const { values, explainsAll } = volatileValues(d);
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
  const upstreams = upstreamOverrides(process.env);
  const sidecar = await Sidecar.start({ store, normalizers: ctx.config.normalize, upstreams, ...(ctx.config.prices ? { prices: ctx.config.prices } : {}), ...(ctx.config.clock ? { clock: ctx.config.clock } : {}), ...(ctx.config.http ? { http: ctx.config.http } : {}) });
  const argv = parent.command.argv;
  // Live from the first call: a fork at call 1 that replays nothing. Writes are stubbed, so the
  // agent carries on as if each one succeeded and nothing acts on the world.
  const run = sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv, cwd: ctx.cwd }, codeVersion: codeVersion(ctx.cwd), replay: { writes: 'stub', reads: 'live', liveTools: new Set(), divergeAt: 1 } });
  ctx.onRun?.(run.runId);
  let output = '';
  const started = Date.now();
  const child = spawn(argv[0]!, argv.slice(1), { cwd: ctx.cwd, env: agentEnv(sidecar, run.runId, ctx.guard, upstreams), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));
  const code = await new Promise<number>((res) => {
    child.on('error', (err) => {
      output += `failed to start ${argv[0]}: ${err.message}\n`;
      res(127);
    });
    child.on('exit', (c, signal) => res(c ?? (signal ? 128 : 1)));
  });
  const ended = sidecar.endRun(run.runId, code === 0 ? 'completed' : 'failed');
  await sidecar.close();
  telemetry().record({ type: 'replay', ...usageOf(ended, Date.now() - started, code) });

  const calls = store.getCalls(run.runId);
  const after = callCounts(calls);
  let checks: CheckResult[] | null = null;
  if (spec) {
    checks = evaluateChecks(spec, {
      calls,
      output,
      answer: finalAnswer(store, calls),
      argsOf: (c) => (c.requestRef ? store.getJson<{ args?: unknown }>(c.requestRef)?.args : undefined),
      costOf: (c) => estimateCost(c.end?.meta.model ?? c.meta.model, c.end?.meta.usage, ctx.config.prices),
    });
    store.updateRunMeta(run.runId, { checks });
  }
  const failed = checks?.filter((c) => !c.ok) ?? [];
  const reason =
    code !== 0
      ? `the agent exited with code ${code}`
      : calls.length === 0
        ? 'no calls were made through Shadowlap'
        : before.model > 0 && after.model === 0
          ? 'the agent made no model calls through Shadowlap, so the new recording would hold none'
          : failed.length
            ? `check failed: ${failed[0]!.label}, but ${failed[0]!.detail}${failed.length > 1 ? `; ${failed.length - 1} more failed` : ''}`
            : null;
  const result: UpdateResult = { replaced: false, reason, run: store.getRun(run.runId), summary: ended.summary, checks, code, output, before, after };
  if (reason) return result;

  // The new pack is written beside the old one, then swapped in, so a failure leaves the old one.
  const target = resolve(dir);
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const fresh = join(dirname(target), `.${basename(target)}.new-${stamp}`);
  const old = join(dirname(target), `.${basename(target)}.old-${stamp}`);
  try {
    packRun(store, run.runId, fresh, { redact: ctx.config.redact });
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
