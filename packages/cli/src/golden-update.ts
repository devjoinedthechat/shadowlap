import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentCallsOf, describeChanges, formatUsd, judgeLine, lexists as present, maskedChange, messageOf, movePath as move, normalizeAddCommand, PACK_ENTRIES, packRun, ruleInForce, runChanges, volatileValues, writePackAttributes, type CallRecord, type DivergenceReport, type JudgeSummary, type Normalizer, type RunMeta, type RunRecord, type RunSummary, type Store, type StoreOf } from '@shadowlap/engine';
import { type CheckResult, type TestSpec } from './checks.js';
import { upstreamOverrides, type ShadowlapConfig } from './config.js';
import { scratchDir } from './goldens.js';
import { judgedOptions, judgeEndedRun, materialOf } from './judge.js';
import { checkLine, judgeResults, type JudgeCheck } from './checks.js';
import { testAttempt, type GuardMode, type TestAttempt } from './run-agent.js';
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
  /** For a caller that winds down on a signal by itself: a re-recording a signal cuts short returns, and replaces nothing. */
  stopped?: () => boolean;
  /** The tools `--allow-unrecorded` lets the re-recording run again though the golden never recorded them and they write. */
  allowUnrecorded?: ReadonlySet<string>;
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
  /** A signal cut the re-recording short. */
  interrupted: boolean;
}

export interface CallCounts {
  total: number;
  model: number;
  tools: Record<string, number>;
}

/** The agent's calls of a recording, counted: a judge check's are none of them. */
export function callCounts(all: readonly CallRecord[]): CallCounts {
  const calls = agentCallsOf(all);
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
 * the command that adds the normalizer that fixes it for good, and that a changed id may be a real
 * change, which the update records. Empty when there is neither.
 */
export function volatileWarning(d: DivergenceReport | null, normalizers: readonly Normalizer[] = []): Array<{ text: string; command: string }> {
  if (!d) return [];
  const { values, explainsAll } = volatileValues(d, normalizers);
  // A field new in the request is never masked where it diverged, but a rule at its path in force now masks it from the next run on.
  return values.filter((v) => !(v.op === 'added' && ruleInForce(v.normalizer, normalizers))).map((v) => ({
    text:
      v.op === 'added'
        ? `${v.path} is new in the request and looks like ${v.looks}, a value that changes every run: after this update the next run diverges on it, unless a normalizer masks it:`
        : v.certain
          ? `${v.path} looks like ${v.looks}, a value that changes every run: updating re-records it, and the next run diverges again. ${explainsAll ? 'A normalizer fixes it for good:' : 'The update covers the rest of the change; a normalizer fixes this part for good:'}`
          : `${v.path} is an id that changed, which may be a real change (the agent acting on another customer or order): the update records the new one. If it is made anew on every run instead, the next run diverges again, and a normalizer fixes it for good:`,
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
export function requestChanges(store: StoreOf<'recording'>, before: RunRecord, after: RunRecord, divergence: DivergenceReport | null, normalizers: readonly Normalizer[] = []): string[] {
  const out: string[] = [];
  try {
    // An update is always made at newer code; what the agent sends is the news, and a judge's model and prompt are none of it.
    out.push(...describeChanges({ ...runChanges(store, before, agentCallsOf(store.getCalls(before.runId)), after, agentCallsOf(store.getCalls(after.runId))), code: { a: null, b: null } }));
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
    } else if (divergence.type === 'ended_early') {
      out.push(`fewer calls than recorded: it stopped before ${at}`);
    }
  }
  return out;
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
    // Its judge checks run once, live (or from the old golden, for an unchanged answer), and their calls go into the new pack.
    redact: ctx.config.redact,
    spec: { ...(spec ?? { repeat: 1, passes: 1, tools: [] }), fork: true },
    divergeAt: 1,
    ...(ctx.onRun ? { onRun: ctx.onRun } : {}),
    ...(ctx.stopped ? { onSignal: 'return' as const } : {}),
    ...(ctx.allowUnrecorded ? { allowUnrecorded: ctx.allowUnrecorded } : {}),
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
  const result: UpdateResult = { replaced: false, reason, run: store.getRun(runId), summary: attempt.ended.summary, checks: spec ? attempt.checks : null, code: attempt.code, output: attempt.output, before, after, interrupted: attempt.interrupted !== null };
  if (reason) return result;
  const failed = repackGolden(store, runId, dir, ctx.projectDir, ctx.config.redact);
  return failed ? { ...result, reason: `the new recording could not replace ${dir}: ${failed}` } : { ...result, replaced: true };
}

/** What `test --update` did for a golden's judge checks: the verdicts it now keeps, each check's line, and what asking cost. */
export interface KeptVerdicts {
  kept: string[];
  lines: string[];
  judge: JudgeSummary | null;
  /** Why the golden keeps none, or null. */
  reason: string | null;
}

/**
 * `test --update` for a golden that replayed clean but holds no verdict for some of its judge
 * checks (they were added after it was packed, or read its output, which a recording doesn't
 * keep): each is asked live, about what the clean replay read, which it shares with its golden,
 * the output included, and its call is added to the golden's recording. Its pack is written again,
 * the same recording with the judge's calls, so every later replay is judged from them, for free.
 */
export async function keepJudgeVerdicts(dir: string, golden: RunRecord, replay: TestAttempt, judges: readonly JudgeCheck[], ctx: Pick<UpdateContext, 'store' | 'config' | 'projectDir'>): Promise<KeptVerdicts> {
  const r = await judgeEndedRun(ctx.store, golden, judges, { material: materialOf(ctx.store, replay.ended.summary.runId, replay.stdout, ctx.config.clock), config: ctx.config, upstreams: upstreamOverrides(process.env) });
  const lines = judgeResults(judges, judgedOptions(r)).map((c) => checkLine(c));
  const kept = judges.filter((j) => r.verdicts.has(j.name)).map((j) => j.name);
  if (!kept.length) return { kept, lines, judge: r.judge, reason: 'no judge check got a verdict to keep' };
  const failed = repackGolden(ctx.store, golden.runId, dir, ctx.projectDir, ctx.config.redact, packedLineage(dir));
  if (failed) return { kept: [], lines, judge: r.judge, reason: `${dir} could not be written: ${failed}` };
  return { kept, lines, judge: r.judge, reason: null };
}

/** Whether a pack holds its run's ancestors (`pack --lineage`), so writing it again keeps them. */
function packedLineage(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs?: unknown };
    return Array.isArray(manifest.runs) && manifest.runs.length > 1;
  } catch {
    return false;
  }
}

/**
 * Writes a run as a golden's pack in place of the one in `dir`. The new pack is written under
 * .shadowlap/ (git never sees it, and neither does a pattern such as goldens/*), then its entries
 * take the old ones' place, so a failure leaves the old golden. Returns why it could not, or null.
 */
export function repackGolden(store: Store, runId: string, dir: string, projectDir: string, redact: Normalizer[], lineage = false): string | null {
  let stage: string | null = null;
  try {
    stage = scratchDir(projectDir, 'update');
    const fresh = join(stage, 'new');
    const aside = join(stage, 'old');
    packRun(store, runId, fresh, { redact, ...(lineage ? { lineage: true } : {}) });
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
    return `${messageOf(err)}${kept}`;
  }
  rmSync(stage, { recursive: true, force: true });
  // A golden packed before packs carried their .gitattributes gets one, so a checkout that converts
  // line endings can't break it. The golden is replaced either way.
  try {
    writePackAttributes(resolve(dir));
  } catch {
    // its folder can't be written to: the pack itself is in place
  }
  return null;
}

/** What a re-recording cost, as a receipt: `$0.04 live · 6 upstream requests`, and its judge checks' apart. */
export function updateReceipt(summary: RunSummary | null): string {
  if (!summary) return '';
  const spent = summary.cost.spent > 0 ? `${formatUsd(summary.cost.spent)} live` : 'no priced model calls';
  return `${spent} · ${summary.upstreamRequests} upstream request${summary.upstreamRequests === 1 ? '' : 's'}${summary.judge ? ` · ${judgeLine(summary.judge)}` : ''}`;
}
