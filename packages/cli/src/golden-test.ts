import { basename, resolve } from 'node:path';
import { formatDivergence, hasRecordedCommand, unpackRun, type RunRecord, type Store, type TestFailure, type TestResultData, type WritePolicy } from '@shadowlap/engine';
import { type CheckResult, type TestSpec } from './checks.js';
import { upstreamOverrides, type ShadowlapConfig } from './config.js';
import { readPackHead } from './goldens.js';
import { type JunitCase } from './junit.js';
import { placeholderAwsCredentials, providerIds, testAttempt, type GuardMode, type TestAttempt } from './run-agent.js';
import { type PackResult } from './test-report.js';

/**
 * One golden under `shadowlap test` (and each commit of `shadowlap bisect`): its recording replayed
 * as many times as its config asks, offline unless it may fork, and judged the way a test is. What
 * came out is kept as the golden's result in the store's test history and in the reports.
 */

export interface RecordingTestContext {
  store: Store;
  config: Pick<ShadowlapConfig, 'normalize' | 'prices' | 'clock' | 'http'>;
  /** Where the recorded command runs. */
  cwd: string;
  writes: WritePolicy;
  guard: GuardMode;
  /** Live calls after a divergence; a golden marked `fork` always has them. */
  online: boolean;
  /** Marks each replay as made by this test session for this golden (`meta.test`). */
  test?: { golden: string; session: string } | null;
  /** Called as each replay starts, with its run id. */
  onRun?: (runId: string, attempt: number, of: number) => void;
  /** The command to run instead of the recorded one (bisect runs it in a worktree). */
  argv?: string[];
  timeoutMs?: number | null;
}

export interface RecordingOutcome {
  spec: TestSpec | null;
  attempts: TestAttempt[];
  /** The attempt the result shows: the last that passed when enough did, else the first that failed. */
  shown: TestAttempt;
  passed: number;
  required: number;
  /** Why it failed, or undefined when it passed. */
  failure: JunitCase['failure'];
  kind: TestFailure | null;
}

/** What kind of failure an attempt is, in the order `testAttempt` judges them. */
export function failureKind(attempt: TestAttempt, spec: TestSpec | null): TestFailure | null {
  if (!attempt.failure) return null;
  const s = attempt.ended.summary;
  if (s.divergence && !spec?.fork) return 'diverged';
  if (attempt.code !== 0) return 'exit';
  if (s.total === 0) return 'no-calls';
  if (attempt.checks?.some((c) => !c.ok)) return 'check';
  return 'error';
}

/** Replays a recording that is already in the store, as a test does, and judges it. */
export async function testRecording(parent: RunRecord, spec: TestSpec | null, ctx: RecordingTestContext): Promise<RecordingOutcome> {
  // A golden has to be able to start its agent. One packed straight from a capture cannot, and
  // spawning its placeholder would fail for a reason the report would not name.
  if (!ctx.argv && !hasRecordedCommand(parent)) {
    throw new Error('this recording was imported from a capture and has no command to run. Replay it once with your agent (shadowlap replay <run> -- <command>) and pack that run: it records everything, and has a command of its own');
  }
  // A recording marked `fork` may diverge on purpose; from the fork on it needs the real providers.
  const live = ctx.online || !!spec?.fork;
  const upstreams = live ? upstreamOverrides(process.env) : Object.fromEntries([...Object.keys(providerIds()), 'http'].map((id) => [id, 'offline']));
  const extraEnv = live ? {} : placeholderAwsCredentials(process.env, ctx.store.getCalls(parent.runId));
  const attempts: TestAttempt[] = [];
  const repeat = spec?.repeat ?? 1;
  for (let i = 0; i < repeat; i++) {
    attempts.push(
      await testAttempt(ctx.store, parent, {
        cwd: ctx.cwd,
        upstreams,
        extraEnv,
        writes: ctx.writes,
        guard: ctx.guard,
        normalizers: ctx.config.normalize,
        prices: ctx.config.prices,
        clock: ctx.config.clock,
        http: ctx.config.http,
        spec,
        ...(ctx.argv ? { argv: ctx.argv } : {}),
        ...(ctx.test ? { meta: { test: ctx.test } } : {}),
        ...(ctx.onRun ? { onRun: (runId: string) => ctx.onRun!(runId, i + 1, repeat) } : {}),
        ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
      }),
    );
  }
  const passed = attempts.filter((a) => !a.failure).length;
  const required = spec?.passes ?? 1;
  const shown = passed >= required ? attempts.filter((a) => !a.failure).at(-1)! : attempts.find((a) => a.failure)!;
  let failure: JunitCase['failure'];
  if (passed < required) {
    const f = shown.failure!;
    failure =
      attempts.length === 1
        ? f
        : {
            message: `${passed} of ${attempts.length} attempts passed, ${required} needed. Attempt ${attempts.indexOf(shown) + 1}: ${f.message}`,
            details: `${attempts.map((a, i) => `attempt ${i + 1}  ${a.failure ? `✗ ${a.failure.message}` : '✓ passed'}`).join('\n')}\n\n${f.details}`,
          };
  }
  return { spec, attempts, shown, passed, required, failure, kind: failure ? failureKind(shown, spec) : null };
}

/** A golden as `shadowlap test` ran it: its pack, its recording, and how it came out. */
export interface GoldenOutcome {
  /** Its name in the test history: the pack folder relative to the project. */
  golden: string;
  /** The pack directory as given. */
  dir: string;
  /** The pack directory's own name. */
  name: string;
  parent: RunRecord | null;
  spec: TestSpec | null;
  /** Null when the golden could not be replayed at all (`failure` says why). */
  result: RecordingOutcome | null;
  failure: JunitCase['failure'];
  kind: TestFailure | null;
  seconds: number;
}

/**
 * Imports a golden's pack into the store (once) and returns the recording it replays: the last run
 * in its run.json, whether it was imported now or was already there. (With a store that persists,
 * a pack's ancestors can be missing while the run itself is present.)
 */
export function importGolden(store: Store, dir: string): RunRecord {
  const { imported, skipped } = unpackRun(store, dir);
  const head = readPackHead(dir);
  const parentId = 'error' in head ? (imported.at(-1) ?? skipped.at(-1)) : head.runId;
  const parent = parentId ? store.getRun(parentId) : null;
  if (!parent) throw new Error('the pack contains no runs');
  return parent;
}

export async function testGolden(dir: string, golden: string, spec: TestSpec | null, ctx: RecordingTestContext): Promise<GoldenOutcome> {
  const started = Date.now();
  const base = { golden, dir, name: basename(resolve(dir)), spec };
  let parent: RunRecord | null = null;
  try {
    parent = importGolden(ctx.store, dir);
    const result = await testRecording(parent, spec, ctx);
    return { ...base, parent, result, failure: result.failure, kind: result.kind, seconds: (Date.now() - started) / 1000 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, parent, result: null, failure: { message, details: message }, kind: 'error', seconds: (Date.now() - started) / 1000 };
  }
}

/** Input tokens of a run's model requests, cache reads and writes included: what it costs to run live. */
function inputTokens(store: Store, runId: string): number {
  return store
    .getCalls(runId)
    .filter((c) => c.kind === 'api')
    .reduce((n, c) => {
      const u = c.end?.meta.usage;
      return n + (u ? u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) : 0);
    }, 0);
}

/** The last lines the agent printed, for a failure. */
export function outputTail(output: string, lines = 20): string | null {
  const t = output.trim();
  return t ? t.split('\n').slice(-lines).join('\n') : null;
}

/** What the store keeps about a golden's result besides its verdict. */
export function resultData(store: Store, o: GoldenOutcome): TestResultData {
  const data: TestResultData = { mode: o.spec?.fork ? 'fork' : 'replay' };
  const r = o.result;
  if (!r) {
    if (o.failure) data.details = o.failure.details;
    return data;
  }
  const s = r.shown.ended.summary;
  data.calls = { total: s.total, replayed: s.byOrigin.replayed + s.byOrigin.overridden, live: s.byOrigin.live, blocked: s.byOrigin.blocked, stubbed: s.byOrigin.stubbed };
  data.upstreamRequests = r.attempts.reduce((n, a) => n + a.ended.summary.upstreamRequests, 0);
  data.tokensNotRespent = s.tokensNotRespent.inputTokens + (s.tokensNotRespent.cacheReadInputTokens ?? 0);
  data.inputTokens = inputTokens(store, s.runId);
  if (r.shown.checks) data.checks = r.shown.checks;
  if (r.attempts.length > 1) data.attempts = { total: r.attempts.length, passed: r.passed, required: r.required, runs: r.attempts.map((a) => a.ended.summary.runId) };
  if (s.divergence) {
    const d = s.divergence;
    data.divergence = {
      type: d.type,
      callNo: d.callNo,
      kind: d.kind,
      name: d.name,
      replayedBefore: d.replayedBefore,
      ...(d.diff ? { diff: d.diff.slice(0, 12) } : {}),
      ...(d.hints ? { hints: d.hints } : {}),
      text: formatDivergence(d),
    };
  }
  if (o.failure) data.details = o.failure.details;
  return data;
}

/** The golden's entry in the JSON report (`--json`), which the GitHub Action reads. */
export function packResult(o: GoldenOutcome, extra: { expect: Record<string, unknown> | null; updated?: PackResult['updated'] }): PackResult {
  const r = o.result;
  const s = r?.shown.ended.summary ?? null;
  return {
    name: o.name,
    dir: o.dir,
    golden: o.golden,
    ok: !o.failure,
    failure: o.kind,
    message: o.failure?.message ?? null,
    details: o.failure?.details ?? null,
    output: o.failure && r ? outputTail(r.shown.output) : null,
    seconds: o.seconds,
    runId: s?.runId ?? null,
    runs: r ? r.attempts.map((a) => ({ runId: a.ended.summary.runId, ok: !a.failure })) : [],
    goldenRunId: o.parent?.runId ?? null,
    calls: s ? { total: s.total, replayed: s.byOrigin.replayed + s.byOrigin.overridden, live: s.byOrigin.live, blocked: s.byOrigin.blocked, stubbed: s.byOrigin.stubbed } : null,
    upstreamRequests: s ? (r?.attempts.reduce((n, a) => n + a.ended.summary.upstreamRequests, 0) ?? 0) : null,
    tokensNotRespent: s ? s.tokensNotRespent.inputTokens + (s.tokensNotRespent.cacheReadInputTokens ?? 0) : null,
    divergence: s?.divergence ? { type: s.divergence.type, callNo: s.divergence.callNo, kind: s.divergence.kind, name: s.divergence.name } : null,
    checks: r?.shown.checks ?? null,
    attempts: r && r.attempts.length > 1 ? { total: r.attempts.length, passed: r.passed, required: r.required } : null,
    expect: extra.expect,
    updated: extra.updated ?? null,
  };
}

/** The checks, one per line, as the terminal and the JUnit report show them. */
export function formatChecks(checks: CheckResult[]): string {
  return checks.map((c) => (c.ok ? `✓ ${c.label}` : `✗ ${c.label}: ${c.detail}`)).join('\n');
}

/** The golden as a JUnit test case. */
export function junitCase(o: GoldenOutcome): JunitCase {
  const checks = o.result?.shown.checks;
  const failure = o.failure && checks?.length ? { ...o.failure, details: `${formatChecks(checks)}\n\n${o.failure.details}` } : o.failure;
  const output = o.result?.shown.output ?? '';
  return { name: o.name, classname: 'shadowlap.replay', timeSeconds: o.seconds, ...(failure ? { failure } : {}), ...(output ? { systemOut: output } : {}) };
}
