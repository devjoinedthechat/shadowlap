import { cpSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describeChanges, formatUsd, maskedChange, normalizeAddCommand, packRun, runChanges, volatileValues, type CallRecord, type DivergenceReport, type Normalizer, type RunMeta, type RunRecord, type RunSummary, type Store } from '@shadowlap/engine';
import { type CheckResult, type TestSpec } from './checks.js';
import { upstreamOverrides, type ShadowlapConfig } from './config.js';
import { scratchDir } from './goldens.js';
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
  /** The project: the new pack is written under its `.shadowlap/` before it takes the old one's place. */
  projectDir: string;
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

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What the agent sends differently, in words: the system prompt, the tools offered and the models
 * (the old recording against the new one), then the change that made the golden diverge, as its
 * replay found it. That replay served the recording's own ids and clock readings, so a value the
 * agent makes anew on every run doesn't show as a change there; nor does what the normalizers in
 * force mask. `system prompt changed`, `call 3 (api POST /v1/messages): ~ $.system`.
 */
export function requestChanges(store: Store, before: RunRecord, after: RunRecord, divergence: DivergenceReport | null, normalizers: readonly Normalizer[] = []): string[] {
  const out: string[] = [];
  try {
    // An update is always made at newer code; what the agent sends is the news.
    out.push(...describeChanges({ ...runChanges(store, before, store.getCalls(before.runId), after, store.getCalls(after.runId)), code: { a: null, b: null } }));
  } catch {
    // the call counts still say something
  }
  if (divergence) {
    const at = `call ${divergence.callNo} (${divergence.kind} ${clip(divergence.name)})`;
    if (divergence.type === 'request_changed') {
      const paths = (divergence.diff ?? []).filter((e) => !maskedChange(e, normalizers, divergence)).map((e) => `${e.op === 'added' ? '+' : e.op === 'removed' ? '−' : '~'} ${clip(e.path)}`);
      if (paths.length) out.push(`${at}: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`);
    } else if (divergence.type === 'new_call') {
      out.push(`${at} is a call the recording doesn't have`);
    } else if (divergence.type === 'beyond_recording') {
      out.push(`more calls than recorded, from ${at}`);
    }
  }
  return out;
}

/** What a pack is made of, as `packRun` writes it; run.json last, since a folder is taken for a pack by it. */
const PACK_ENTRIES = ['blobs', 'calls.jsonl', 'run.json'] as const;

const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** A rename, or across filesystems a copy and a removal. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Puts the new pack's entries in place of the golden's, and leaves everything else in its folder (a
 * README, an expect file, notes) as it was. Each old entry is moved aside first; on an error the old
 * ones go back, so the golden is the old pack or the new one, never a mix.
 */
export function swapPack(target: string, fresh: string, aside: string): void {
  const moved: Array<{ name: string; had: boolean }> = [];
  try {
    for (const name of PACK_ENTRIES) {
      const had = present(join(target, name));
      if (had) move(join(target, name), join(aside, name));
      moved.push({ name, had });
      move(join(fresh, name), join(target, name));
    }
  } catch (err) {
    for (const { name, had } of moved.reverse()) {
      try {
        if (had && !present(join(aside, name))) continue;
        rmSync(join(target, name), { recursive: true, force: true });
        if (had) move(join(aside, name), join(target, name));
      } catch {
        // it stays aside; the caller keeps that folder and names it
      }
    }
    throw err;
  }
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

  // The new pack is written under .shadowlap/ (git never sees it, and neither does a pattern such as
  // goldens/*), then its entries take the old ones' place, so a failure leaves the old golden.
  let stage: string | null = null;
  try {
    stage = scratchDir(ctx.projectDir, 'update');
    const fresh = join(stage, 'new');
    const aside = join(stage, 'old');
    packRun(store, runId, fresh, { redact: ctx.config.redact });
    mkdirSync(aside);
    swapPack(resolve(dir), fresh, aside);
  } catch (err) {
    let kept = '';
    try {
      // The old pack's entries that could not be put back stay where they are, and are named.
      if (stage && present(join(stage, 'old')) && readdirSync(join(stage, 'old')).length) kept = `; the old pack's files are in ${join(stage, 'old')}`;
      else if (stage) rmSync(stage, { recursive: true, force: true });
    } catch {
      // nothing more to tidy
    }
    return { ...result, reason: `the new recording could not replace ${dir}: ${(err as Error).message}${kept}` };
  }
  rmSync(stage, { recursive: true, force: true });
  return { ...result, replaced: true };
}

/** What a re-recording cost, as a receipt: `$0.04 live · 6 upstream requests`. */
export function updateReceipt(summary: RunSummary | null): string {
  if (!summary) return '';
  const spent = summary.cost.spent > 0 ? `${formatUsd(summary.cost.spent)} live` : 'no priced model calls';
  return `${spent} · ${summary.upstreamRequests} upstream request${summary.upstreamRequests === 1 ? '' : 's'}`;
}
