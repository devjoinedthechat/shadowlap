import { writeFileSync } from 'node:fs';
import { InvalidArgumentError, type Command } from 'commander';
import { links } from '@shadowlap/dashboard';
import { GATEWAY_UNCHANGED, checkOutcome, commandIsImported, formatDivergence, formatRepeats, hasRecordedCommand, normalizeResponse, overrideSources, statusTally, summarizeRepeats, type CallRecord, type CheckStatus, type ReadPolicy, type ReplayOptions, type RunRecord, type UnrecordedTool, type WritePolicy } from '@shadowlap/engine';
import type { PreloadReport } from '@shadowlap/sidecar';
import { formatAttemptsUnrecorded } from '../attempt-unrecorded.js';
import { replayChaos } from '../chaos-session.js';
import { CHECK_MARKS, checkWords, type CheckResult, type TestSpec } from '../checks.js';
import { codeVersion, loadConfig, upstreamOverrides } from '../config.js';
import { EXIT, interruptedStatus, stoppedBy, usageError } from '../exit-codes.js';
import { checkRequestInterventions, checksOfRun, expectJson, judgeRun, parsePlants, refuseOverlaps, storedResult, UNJUDGED_PLANT } from '../interventions.js';
import { emitJobEvent } from '../job-events.js';
import { judgesOf, type Judged } from '../judge.js';
import { placeholderKeys } from '../placeholder-keys.js';
import { judgeAttempt, parseFailures, parseInterventions, parseOverrides, repeatUnderSidecar, runUnderSidecar, type BeforeEnd, type GuardMode } from '../run-agent.js';
import { confirmImportedCommand, givenCommand, openStore, printOutcome, readStore, requireEnded, requireRun, withoutCommand, type GlobalOpts } from '../shared.js';
import { palette as p, safe, shortId } from '../ui.js';
import { allowedUnrecorded, declaredUnrecorded, formatUnrecorded, unrecordedOf, unrecordedRefusal } from '../unrecorded.js';
import { watchAndRerun } from '../watch.js';
import { readExpect } from './fix-flags.js';

/**
 * `shadowlap replay`: a recorded run replayed after a change, forking at the first changed call. It
 * reads what it was asked against the recording (parseReplay), plans the replay (replayPlan), and
 * runs it once, again on every edit (--watch), or n times (--repeat), reporting each as it ends.
 */

/** The flags of `shadowlap replay`, as commander gives them. */
export interface ReplayFlags {
  strict?: boolean;
  writes: WritePolicy;
  reads: ReadPolicy;
  liveTool?: string[];
  divergeAt?: number;
  promptFrom?: number;
  override?: string[];
  failAt?: string[];
  injectResult?: string[];
  expect?: string;
  watch?: boolean;
  inject?: string;
  injectAs: 'system' | 'user';
  set?: string[];
  model?: string;
  guard: GuardMode;
  allowUnrecorded?: string[];
  yes?: boolean;
  repeat?: number;
  concurrency: number;
  summaryJson?: string;
  liveInput?: boolean;
  chaos?: boolean;
  presets?: string;
  chaosTool?: string;
  inconclusive: 'fail' | 'warn';
}

/** A replay as it was asked for, read against its recording. */
interface ReplayRequest {
  parent: RunRecord;
  parentCalls: CallRecord[];
  overrides: Map<number, unknown>;
  failures: ReturnType<typeof parseFailures>;
  plants: Map<number, string>;
  interventions: ReturnType<typeof parseInterventions>;
  checks: { spec: TestSpec; source: string } | null;
  /** The run's record names the file an override came from (`16=@policy.json`), not the result itself. */
  sources: ReturnType<typeof overrideSources>;
  argv: string[];
  /** A run imported from a pack carries a command someone else chose; running it needs consent. */
  commandFromImport: boolean;
}

/** How each replay runs, and how it is judged once its agent has exited. */
interface ReplayPlan {
  start: Parameters<typeof runUnderSidecar>[2];
  env: Record<string, string>;
  /** A check on what the agent printed needs its output, and so does a judge check that reads it; nothing else does. */
  capture: boolean;
  beforeEnd: BeforeEnd | undefined;
  judge: (runId: string, output: string) => CheckResult[];
  /** Planted text with nothing to say whether the agent obeyed it: say so, and how to add a check. */
  unjudged: boolean;
}

const checksFrom = (source: string) => (source === '--expect' ? '--expect' : `shadowlap.config.json for ${source}`);

/** A status's mark, coloured as the verdict it is: lime passed, red failed, amber inconclusive, grey not applicable. */
const MARK: Record<CheckStatus, (s: string) => string> = { passed: p.green, failed: p.red, inconclusive: p.yellow, 'not-applicable': p.dim };
const mark = (status: CheckStatus) => MARK[status](CHECK_MARKS[status]);

/** One replay's checks, one line each. */
function formatChecks(checks: CheckResult[], source: string): string {
  const outcome = checkOutcome(checks);
  const head = (outcome === 'failed' ? p.red : outcome === 'inconclusive' ? p.yellow : p.green)(`${CHECK_MARKS[outcome]} ${statusTally(checks)}`);
  return [`${head} ${p.dim(`(${checksFrom(source)})`)}`, ...checks.map((c) => `  ${mark(c.status)} ${safe(checkWords(c, ', but '))}`)].join('\n');
}

/** Each check across the attempts of `--repeat`: in how many it failed or could not be decided, and which; where it did not apply. */
function formatCheckTally(judged: CheckResult[][], source: string): string {
  const labels = [...new Set(judged.flatMap((checks) => checks.map((c) => c.label)))];
  const of = `${judged.length} attempt${judged.length === 1 ? '' : 's'}`;
  const lines = labels.map((label) => {
    const where = (status: CheckStatus) => judged.map((checks, i) => (checks.some((c) => c.label === label && c.status === status) ? i + 1 : 0)).filter(Boolean);
    const numbers = (ns: number[]) => `(${ns.map((n) => `#${n}`).join(', ')})`;
    const failedIn = where('failed');
    const unsettledIn = where('inconclusive');
    const notIn = where('not-applicable');
    const unsettled = unsettledIn.length ? `, inconclusive in ${unsettledIn.length} ${numbers(unsettledIn)}` : '';
    if (failedIn.length) return `    ${mark('failed')} ${safe(label)}: failed in ${failedIn.length} of ${of} ${numbers(failedIn)}${unsettled}`;
    if (unsettledIn.length) return `    ${mark('inconclusive')} ${safe(label)}: inconclusive in ${unsettledIn.length} of ${of} ${numbers(unsettledIn)}`;
    if (notIn.length === judged.length) return `    ${mark('not-applicable')} ${safe(label)}: not applicable in all ${judged.length}`;
    if (notIn.length) return `    ${mark('passed')} ${safe(label)}: passed in ${judged.length - notIn.length} of ${of}, not applicable in ${notIn.length} ${numbers(notIn)}`;
    return `    ${mark('passed')} ${safe(label)}: passed in all ${judged.length}`;
  });
  return [`  Checks ${p.dim(`(${checksFrom(source)})`)}`, ...lines].join('\n');
}

/** The tools each run's model called that it left unrecorded, read once the runs have ended; none when the store can't be read. */
export function unrecordedAfter(opts: GlobalOpts, runIds: readonly string[]): UnrecordedTool[][] {
  try {
    const store = openStore(opts);
    try {
      const declared = declaredUnrecorded(process.cwd());
      return runIds.map((runId) => unrecordedOf(store, runId, declared));
    } finally {
      store.close();
    }
  } catch {
    return runIds.map(() => []);
  }
}

/** How a replay's checks came out as a whole: failed when one failed, else inconclusive when one could not be decided, else passed. */
function judgedOutcome(checks: readonly CheckResult[]): 'passed' | 'failed' | 'inconclusive' {
  return checks.some((c) => c.status === 'failed') ? 'failed' : checks.some((c) => !c.ok) ? 'inconclusive' : 'passed';
}

/**
 * A replay's status before its checks have a say: 1 when no preload loaded in the agent's processes
 * under --guard block, which fails the run whatever the agent did (nothing stopped a connection that
 * bypassed Shadowlap, so the replay proves nothing); else the agent's own.
 */
function agentStatus(code: number, preloads: PreloadReport | null): number {
  return preloads?.failed ? EXIT.failed : code;
}

/** The flags given that change the replay, which --chaos refuses: each preset would be judged with them. */
function changesBesideChaos(flags: ReplayFlags): string[] {
  return [flags.override?.length && '--override', flags.failAt?.length && '--fail-at', flags.injectResult?.length && '--inject-result', flags.inject && '--inject', flags.set?.length && '--set', flags.model && '--model', flags.promptFrom !== undefined && '--prompt-from', flags.divergeAt !== undefined && '--diverge-at', flags.liveTool?.length && '--live-tool', flags.repeat !== undefined && '--repeat', flags.watch && '--watch', flags.strict && '--strict'].filter((x): x is string => typeof x === 'string');
}

/** `shadowlap replay <run> [-- command]`. */
export async function replayRun(command: Command, opts: GlobalOpts, runArg: string, given: string[], flags: ReplayFlags): Promise<void> {
  if (flags.chaos) {
    // The presets play their own failures in, one at a time: anything else that changes the replay would be judged with them.
    const others = changesBesideChaos(flags);
    if (others.length) throw new InvalidArgumentError(`--chaos plays each preset in alone; it doesn't combine with ${others.join(', ')}`);
  } else if (flags.presets || flags.chaosTool) throw new InvalidArgumentError('--presets and --chaos-tool go with --chaos');
  const request = parseReplay(opts, runArg, given, flags);
  if (request.commandFromImport && !flags.yes && !(await confirmImportedCommand(request.parent, request.argv))) {
    process.exitCode = EXIT.usage;
    return;
  }
  if (flags.chaos) {
    const chaosFlags = { ...(flags.presets ? { presets: flags.presets } : {}), ...(flags.chaosTool ? { chaosTool: flags.chaosTool } : {}), ...(command.getOptionValueSource('writes') === 'cli' ? { writes: flags.writes } : {}), guard: flags.guard, inconclusive: flags.inconclusive, ...(flags.summaryJson ? { json: flags.summaryJson } : {}), allowUnrecorded: allowedUnrecorded(flags.allowUnrecorded) };
    await replayChaos(opts, request.parent, request.checks, chaosFlags, givenCommand(process.argv, 'replay'), given.length ? given : undefined);
    return;
  }
  const plan = replayPlan(opts, request, flags);
  if (flags.repeat !== undefined && flags.repeat > 1) return replayRepeated(opts, request, plan, flags, flags.repeat);
  if (!flags.watch) return replayOnce(opts, request, plan, flags);
  // The prefix before a fork replays for free, so re-running after every edit costs nothing.
  // What a replay writes itself is no edit: the store (with its journals) and the summary file.
  const db = opts.db && opts.db !== ':memory:' ? [opts.db, `${opts.db}-wal`, `${opts.db}-shm`, `${opts.db}-journal`] : [];
  await watchAndRerun({
    cwd: process.cwd(),
    ignore: [...db, ...(flags.summaryJson ? [flags.summaryJson] : [])],
    log: (m) => process.stderr.write(`\n${p.dim(m)}\n`),
    run: async (again) => {
      if (again) process.stderr.write(`\n${p.dim('─'.repeat(40))}\n`);
      await replayOnce(opts, request, plan, flags);
    },
  });
}

/**
 * The recording a replay starts from, and what the flags change in it, each read against its calls
 * and refused now when it can't be done, not by the agent part way through.
 */
function parseReplay(opts: GlobalOpts, runArg: string, given: string[], flags: ReplayFlags): ReplayRequest {
  const store = readStore(opts);
  const parent = requireRun(store, runArg);
  const parentCalls = store.getCalls(parent.runId);
  let overrides: Map<number, unknown>;
  let failures: ReturnType<typeof parseFailures>;
  let plants: Map<number, string>;
  let interventions: ReturnType<typeof parseInterventions>;
  let checks: { spec: TestSpec; source: string } | null;
  try {
    // A recording still being made has no end to replay to yet, as the dashboard's Replay and Fork wait for it.
    requireEnded(store, parent, 'replay');
    overrides = parseOverrides(flags.override ?? [], parentCalls);
    failures = parseFailures(flags.failAt ?? [], parentCalls);
    plants = parsePlants(flags.injectResult ?? [], parentCalls, storedResult(store));
    refuseOverlaps([['--override', overrides.keys()], ['--fail-at', failures.tools.keys()], ['--inject-result', plants.keys()]]);
    interventions = parseInterventions(flags, parentCalls);
    // A change the recorded request can't take is refused now, not by the agent part way through.
    checkRequestInterventions(store, parentCalls, interventions);
    checks = flags.expect ? { spec: readExpect(flags.expect), source: '--expect' } : checksOfRun(store, parent, process.cwd());
    // A tool the model called that the recording never recorded runs again for real: one that writes is refused.
    const refusal = unrecordedRefusal(parent, unrecordedOf(store, parent.runId, loadConfig(process.cwd()).unrecorded ?? {}), allowedUnrecorded(flags.allowUnrecorded), ['shadowlap', ...process.argv.slice(2)]);
    if (refusal) throw usageError(refusal);
  } catch (err) {
    store.close();
    throw err;
  }
  const sources = overrideSources(flags.override ?? []);
  if (flags.promptFrom !== undefined) {
    const target = parentCalls.find((c) => c.callNo === flags.promptFrom);
    if (!target || target.kind !== 'api') {
      store.close();
      throw new InvalidArgumentError(`--prompt-from: call #${flags.promptFrom} is not a model call of ${shortId(parent.runId)} (see shadowlap show ${shortId(parent.runId)})`);
    }
    if ((target.meta.provider ?? target.end?.meta.provider) === 'ai-gateway') {
      store.close();
      throw new InvalidArgumentError(`--prompt-from: #${flags.promptFrom} can't be changed: ${GATEWAY_UNCHANGED}`);
    }
    // Reasoning a model produced under the old prompt goes back to it with the new one.
    const reasoned = parentCalls.some((c) => {
      if (c.kind !== 'api' || c.callNo >= flags.promptFrom! || !c.end?.responseRef) return false;
      const provider = c.end.meta.provider ?? c.meta.provider;
      return normalizeResponse(store.getBlob(c.end.responseRef), c.end.meta.headers?.['content-type'], c.end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined).blocks.some((b) => b.type === 'thinking');
    });
    if (reasoned) process.stderr.write(p.yellow(`! Model calls before #${flags.promptFrom} include reasoning produced under the old prompt. A provider that binds reasoning to the prompt it came from may refuse call #${flags.promptFrom}; if it does, fork from a call before the first reasoning.\n`));
  }
  store.close();
  // A run built from a capture never knew what started the agent. Spawning its placeholder would
  // fail and still record a failed run with no calls, which is worse than refusing.
  if (!given.length && !hasRecordedCommand(parent)) {
    throw new InvalidArgumentError(
      `${shortId(parent.runId)} ${withoutCommand(parent)}, which records what was sent but not what sent it, so it has no command to re-run. Give yours after --:\n  shadowlap replay ${shortId(parent.runId)} -- python agent.py\nThat replay records everything, tool calls included, so it has a command of its own and every fork works on it.`,
    );
  }
  const argv = given.length ? given : parent.command.argv;
  return { parent, parentCalls, overrides, failures, plants, interventions, checks, sources, argv, commandFromImport: !given.length && commandIsImported(parent) };
}

/** How each replay runs (what it replays, its environment, whether its output is kept) and how it is judged. */
function replayPlan(opts: GlobalOpts, request: ReplayRequest, flags: ReplayFlags): ReplayPlan {
  const { parent, parentCalls, overrides, failures, plants, interventions, checks, sources, argv, commandFromImport } = request;
  const replay: Partial<ReplayOptions> = { writes: flags.writes, reads: flags.reads, liveTools: new Set(flags.liveTool ?? []) };
  // A placeholder for each provider whose key the recording's environment held and this one lacks,
  // so a clean replay needs no real key: the agent took its key from the environment then. Anything
  // else the agent signs in with is left to it, and the sidecar sends no call that carries one.
  const env = placeholderKeys(process.env, { calls: parentCalls, keyEnv: parent.meta?.keyEnv }, 'replay');
  // A partial recording (an import that only saw the network) declares what it covers; everything else runs live.
  if (parent.meta?.covers?.length) replay.kinds = new Set(parent.meta.covers);
  if (flags.liveInput) replay.liveInput = true;
  if (flags.divergeAt !== undefined) replay.divergeAt = flags.divergeAt;
  if (flags.promptFrom !== undefined) replay.promptFrom = flags.promptFrom;
  if (overrides.size) replay.overrides = overrides;
  if (failures.models.size) replay.failAt = failures.models;
  if (failures.tools.size) replay.toolFailures = failures.tools;
  if (plants.size) replay.plants = plants;
  const capture = !!checks?.spec.output || judgesOf(checks?.spec).some((j) => j.of === 'output');
  const config = checks ? loadConfig(process.cwd()) : null;
  const expected = flags.expect ? expectJson(flags.expect) : undefined;
  // Judge checks are asked once each replay's agent has exited, before its run ends: a clean
  // replay's from the recording, a fork's live, and either way the call is the replay's.
  const verdicts = new Map<string, Judged>();
  const beforeEnd: BeforeEnd | undefined = judgesOf(checks?.spec).length
    ? async (sidecar, store, run, agent) => {
        verdicts.set(run.runId, await judgeAttempt(store, sidecar, run.runId, checks!.spec, { code: agent.code, interrupted: agent.interrupted, stdout: agent.stdout, upstreams: upstreamOverrides(process.env), redact: config!.redact, normalize: config!.normalize, clock: config!.clock, prices: config!.prices }));
      }
    : undefined;
  const judge = (runId: string, output: string): CheckResult[] => {
    const reader = openStore(opts);
    try {
      return judgeRun(reader, runId, checks!.spec, output, config?.prices, expected, verdicts.get(runId));
    } finally {
      reader.close();
    }
  };
  const start: ReplayPlan['start'] = (sidecar) => sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv, cwd: process.cwd() }, codeVersion: codeVersion(process.cwd()), replay, ...(interventions ? { interventions } : {}), ...(commandFromImport ? { commandFromImport: true } : {}), overrideSources: sources });
  return { start, env, capture, beforeEnd, judge, unjudged: plants.size > 0 && !checks };
}

/** `--repeat <n>`: the replay n times, and how the attempts differ after the fork. */
async function replayRepeated(opts: GlobalOpts, { parent, checks, argv }: ReplayRequest, plan: ReplayPlan, flags: ReplayFlags, repeat: number): Promise<void> {
  if (repeat > 100) throw new InvalidArgumentError('--repeat is at most 100');
  if (flags.watch) throw new InvalidArgumentError('--watch and --repeat both re-run the replay; use one of them');
  const attempts = await repeatUnderSidecar(opts, argv, repeat, flags.concurrency, plan.start, flags.guard, { recording: parent, allowUnrecorded: allowedUnrecorded(flags.allowUnrecorded), capture: plan.capture, env: plan.env, ...(plan.beforeEnd ? { beforeEnd: plan.beforeEnd } : {}) });
  const judged = checks ? attempts.map((a) => plan.judge(a.run.runId, a.output)) : [];
  const reader = openStore(opts);
  const report = summarizeRepeats(
    parent.runId,
    attempts.map((a) => ({ runId: a.run.runId, exitCode: a.code, summary: a.summary, calls: reader.getCalls(a.run.runId) })),
    {
      // Compare what the model said, not the response bytes: those carry per-response ids.
      responseContent: (call) => {
        const end = call.end;
        if (!end?.responseRef) return null;
        const provider = end.meta.provider ?? call.meta.provider;
        const r = normalizeResponse(reader.getBlob(end.responseRef), end.meta.headers?.['content-type'], end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
        return r.blocks.length ? JSON.stringify(r.blocks) : end.responseRef;
      },
    },
  );
  reader.close();
  const first = attempts.find((a) => a.summary.divergence)?.summary.divergence;
  process.stderr.write('\n' + (first ? formatDivergence(first, p) + '\n\n' : '') + formatRepeats(report, p) + '\n');
  // What each attempt ran that nothing recorded, the recording's tools allowed to run and a fork's own: named once, every attempt counted.
  const unrecorded = unrecordedAfter(opts, attempts.map((a) => a.run.runId));
  const ran = formatAttemptsUnrecorded(unrecorded);
  if (ran) process.stderr.write('\n' + ran);
  if (checks) process.stderr.write('\n' + formatCheckTally(judged, checks.source) + '\n');
  if (plan.unjudged) process.stderr.write('\n' + p.yellow(`! ${UNJUDGED_PLANT}`) + '\n');
  // Each attempt's status as the replay counts it: one the guard never watched under --guard block failed.
  if (flags.summaryJson) writeFileSync(flags.summaryJson, JSON.stringify({ attempts: attempts.map((a, i) => ({ exitCode: agentStatus(a.code, a.preloads), summary: a.summary, ...(checks ? { checks: judged[i] } : {}), unrecordedTools: unrecorded[i] ?? [] })), report }, null, 2) + '\n');
  emitJobEvent({ type: 'result', data: { attempts: attempts.map((a, i) => ({ runId: a.run.runId, exitCode: agentStatus(a.code, a.preloads), summary: a.summary, ...(checks ? { checks: judged[i] } : {}) })), report } });
  emitJobEvent({ type: 'link', label: 'Open attempts', href: links.run(parent.runId, first?.callNo ?? 1, 'forks') });
  // One that stopped before its recording did is among them: its divergence says so.
  const anyDiverged = attempts.some((a) => a.summary.divergence);
  // A signal ends it with the signal's status; then a divergence under --strict, an attempt that
  // failed, was never run or ran unwatched under --guard block, or a check that failed, 1; a
  // check that could not be decided, 3.
  const outcome = judgedOutcome(judged.flat());
  process.exitCode = stoppedBy() ? interruptedStatus() : (flags.strict && anyDiverged) || attempts.length < repeat || attempts.some((a) => agentStatus(a.code, a.preloads) !== 0) || outcome === 'failed' ? EXIT.failed : outcome === 'inconclusive' ? EXIT.inconclusive : EXIT.ok;
}

/** One replay, its checks and what it ran unrecorded, and the status it ends with. */
async function replayOnce(opts: GlobalOpts, { checks, argv }: ReplayRequest, plan: ReplayPlan, flags: ReplayFlags): Promise<void> {
  const { code, summary, run, output, started, preloads } = await runUnderSidecar(opts, argv, plan.start, flags.guard, { capture: plan.capture, env: plan.env, ...(plan.beforeEnd ? { beforeEnd: plan.beforeEnd } : {}) });
  if (!started) {
    // The command never started: it has said so, and no run is kept to show or judge.
    if (flags.summaryJson) writeFileSync(flags.summaryJson, JSON.stringify({ exitCode: code, summary }, null, 2) + '\n');
    process.exitCode = code;
    return;
  }
  // Under --guard block, a replay the guard never watched fails, however clean: never called clean.
  const agent = agentStatus(code, preloads);
  printOutcome(summary, preloads);
  const judged = checks ? plan.judge(run.runId, output) : null;
  if (judged) process.stderr.write(formatChecks(judged, checks!.source) + '\n');
  if (plan.unjudged) process.stderr.write(p.yellow(`! ${UNJUDGED_PLANT}`) + '\n');
  // What this replay ran for real without recording it: tools the model called that no wrapper saw.
  const unrecorded = unrecordedAfter(opts, [run.runId])[0]!;
  if (unrecorded.length) process.stderr.write(formatUnrecorded(unrecorded, 'replay'));
  if (flags.summaryJson) writeFileSync(flags.summaryJson, JSON.stringify({ exitCode: agent, summary, ...(judged ? { checks: judged } : {}), unrecordedTools: unrecorded }, null, 2) + '\n');
  // A replay that stopped before its recording did is no clean one either: its divergence says so.
  // A check that failed ends it with 1; then an agent that failed, with its own status, or that
  // no preload watched under --guard block, with 1; then a check that could not be decided, with 3.
  const outcome = judged ? judgedOutcome(judged) : 'passed';
  process.exitCode = flags.strict && summary.divergence ? EXIT.failed : outcome === 'failed' ? EXIT.failed : agent === 0 && outcome === 'inconclusive' ? EXIT.inconclusive : agent;
}
