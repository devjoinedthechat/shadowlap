import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';
import { links } from '@shadowlap/dashboard';
import { ACTIONS, endedEarlyCount, formatDuration, formatPassK, formatTokens, GATE_MAX_ATTEMPTS, judgeLine, messageOf, noVerdicts, proofCall, proofLine, proofOf, recordEvent, resolveAuthor, sessionInARow, settleAppliedFixes, statusTally, Store, SUITE_RISK, volatileValues, wholeInput, type AttemptReport, type InjectionGateData, type PlantReport, type RunRecord, type StoreOf, type StoredFix, type TestSession, type WritePolicy } from '@shadowlap/engine';
import { STOP_SIGNALS } from '../agent-signals.js';
import { sessionSource } from '../baseline-branch.js';
import { testChaos } from '../chaos-session.js';
import { checkLine, specFor, type JudgeCheck, type TestEntry, type TestSpec } from '../checks.js';
import { codeVersion, defaultDbPath, loadConfig, loadTests, loadTestSettings, type ShadowlapConfig } from '../config.js';
import { EXIT, signalExit, usageError } from '../exit-codes.js';
import { shortFixId } from '../fix-format.js';
import { confirmGolden, goldenNeedsConsent } from '../golden-consent.js';
import { formatChecks, inconclusiveFor, junitCase, outputTail, packResult, pruneQuietly, resultData, testGolden, verdictOf, type GoldenOutcome, type InconclusiveMode, type RecordingTestContext } from '../golden-test.js';
import { callCounts, describeChange, keepJudgeVerdicts, requestChanges, rerecordGolden, updateReceipt, volatileWarning } from '../golden-update.js';
import { expandRecordings, goldenName, isPack, rawExpectFor } from '../goldens.js';
import { gateLetsThrough, gateLine, injectionGate } from '../injection.js';
import { emitJobEvent, type JobEvent } from '../job-events.js';
import { judgesOf } from '../judge.js';
import { junitXml, type JunitCase } from '../junit.js';
import { ProviderStreak, unavailableWords } from '../provider-retry.js';
import { type GuardMode } from '../run-agent.js';
import { givenCommand, telemetry, usageOf, type GlobalOpts } from '../shared.js';
import { planSession, suiteJson, suiteLines } from '../suite-plan.js';
import { takeoverReader } from '../tasks.js';
import { prepareTestPush, teamEnv } from '../team.js';
import { githubAnnotations, markdownReport, testReport, type PackResult } from '../test-report.js';
import { Turns } from '../turns.js';
import { palette as p, quoteArgv, safe, safeLines, shortId } from '../ui.js';
import { allowedUnrecorded } from '../unrecorded.js';
import { unrecordedInGoldens } from '../unrecorded-goldens.js';

/**
 * `shadowlap test`: packed goldens replayed offline, as a session the project's store keeps as test
 * history. parseTest checks what it was asked, runSession replays each golden (with its injection
 * gate, and under --update a new recording or the judge verdicts it lacks) and keeps each result, and
 * reportSession writes the reports and sets the exit status.
 */

/** The flags of `shadowlap test`, as commander gives them. */
export interface TestFlags {
  junit?: string;
  json?: string;
  markdown?: string;
  annotations?: boolean;
  update?: boolean;
  online?: boolean;
  writes: WritePolicy;
  cwd?: string;
  guard: GuardMode;
  push?: boolean;
  inconclusive: InconclusiveMode;
  maxAttempts?: number;
  suiteRisk?: number;
  continue?: boolean;
  chaos?: boolean;
  presets?: string;
  chaosTool?: string;
  allowUnrecorded?: string[];
  yes?: boolean;
}

/** What a session was asked, checked: the packs it runs, and how. */
interface TestRequest {
  opts: GlobalOpts;
  flags: TestFlags;
  /** --guard given on the command line: an update's live re-recording keeps it, and otherwise warns. */
  guardGiven: boolean;
  /**
   * --inconclusive given on the command line, which decides for every golden; null with none: a gate
   * against history whose golden has too few sessions yet only warns when it runs out of attempts, and
   * every other inconclusive fails.
   */
  inconclusiveGiven: InconclusiveMode | null;
  projectDir: string;
  config: ShadowlapConfig;
  tests: TestEntry[];
  cwd: string;
  packs: string[];
  /** Paths named as they are that hold no pack: each fails as a golden, and the session ends with 2. */
  noPack: string[];
}

type Pusher = Awaited<ReturnType<typeof prepareTestPush>>;

/** How many failing goldens a dashboard job links to by their replay; Tests has every one. */
const FAILED_LINKS = 3;

/** `--suite-risk`: a share above 0 and below 0.5. */
export function parseSuiteRisk(value: string): number {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0 || v >= 0.5) throw new InvalidArgumentError('must be a number above 0 and below 0.5, such as 0.05: the most a healthy suite may go red for nothing');
  return v;
}

/** `shadowlap test <pack...>`. */
export async function testPacks(command: Command, opts: GlobalOpts, packArgs: string[], flags: TestFlags): Promise<void> {
  refuseUnrecordedWrites(packArgs, flags);
  if (flags.chaos) return testChaosPresets(command, opts, packArgs, flags);
  const request = parseTest(command, opts, packArgs, flags);
  // Team store: no store or no credentials is a warning; the tests still decide the exit code.
  const pusher = flags.push ? await prepareTestPush(teamEnv(opts.db), { ...(flags.annotations ? { annotations: true } : {}) }) : null;
  const session = new Session(request, pusher);
  await session.run();
  await reportSession(request, pusher, session);
}

/**
 * A golden whose model called a tool its recording never recorded, which writes, would run it
 * again for real: refused before anything runs, every such golden named. Reads only warn.
 */
function refuseUnrecordedWrites(packArgs: string[], flags: TestFlags): void {
  const found = expandRecordings(packArgs, process.cwd()).dirs;
  const looked = unrecordedInGoldens(found.map((dir) => ({ dir, name: goldenName(dir, process.cwd()) })), loadConfig(process.cwd()).unrecorded ?? {}, allowedUnrecorded(flags.allowUnrecorded));
  if (looked.refused) throw usageError(looked.refused);
  for (const w of looked.warnings) process.stderr.write(`${w}\n`);
}

/** `--chaos`: the error-path presets instead of a session, each golden forked where a tool or the provider fails. */
async function testChaosPresets(command: Command, opts: GlobalOpts, packArgs: string[], flags: TestFlags): Promise<void> {
  if (flags.update || flags.push || flags.annotations || flags.maxAttempts || flags.continue || flags.suiteRisk !== undefined) throw new InvalidArgumentError('--chaos runs the error-path presets, not a test session: --update, --push, --annotations, --max-attempts, --suite-risk and --continue are for a test session');
  const chaosFlags = { ...(flags.yes ? { yes: true } : {}), ...(flags.presets ? { presets: flags.presets } : {}), ...(flags.chaosTool ? { chaosTool: flags.chaosTool } : {}), ...(command.getOptionValueSource('writes') === 'cli' ? { writes: flags.writes } : {}), guard: flags.guard, inconclusive: flags.inconclusive, ...(flags.json ? { json: flags.json } : {}), ...(flags.junit ? { junit: flags.junit } : {}), ...(flags.markdown ? { markdown: flags.markdown } : {}), ...(flags.cwd ? { cwd: flags.cwd } : {}), allowUnrecorded: allowedUnrecorded(flags.allowUnrecorded) };
  await testChaos(opts, packArgs, chaosFlags, givenCommand(process.argv, 'test'));
}

/** The flags checked against each other, the config read, and the packs found. */
function parseTest(command: Command, opts: GlobalOpts, packArgs: string[], flags: TestFlags): TestRequest {
  if (flags.presets || flags.chaosTool) throw new InvalidArgumentError('--presets and --chaos-tool go with --chaos');
  const guardGiven = command.getOptionValueSource('guard') === 'cli';
  const inconclusiveGiven = command.getOptionValueSource('inconclusive') === 'cli' ? flags.inconclusive : null;
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);
  const tests = loadTests(projectDir);
  const cwd = resolve(flags.cwd ?? projectDir);
  if (flags.maxAttempts !== undefined && (flags.maxAttempts < 1 || flags.maxAttempts > GATE_MAX_ATTEMPTS)) throw new InvalidArgumentError(`--max-attempts must be a whole number from 1 to ${GATE_MAX_ATTEMPTS}`);
  if (flags.continue && flags.update) throw new InvalidArgumentError('--continue adds attempts to an inconclusive gate, --update re-records a golden: give one or the other');
  const { dirs: packs, unmatched } = expandRecordings(packArgs, projectDir);
  if (unmatched.length) {
    throw new InvalidArgumentError(`no recordings match ${unmatched.join(' ')}: a recording is a directory written by shadowlap pack, with a run.json inside`);
  }
  // A path named as it is that holds no pack is a typo to fix, as a bad flag is: the others still
  // run, and it fails as a golden in every report, but the session ends with 2.
  const noPack = packs.filter((d) => !isPack(resolve(projectDir, d)));
  return { opts, flags, guardGiven, inconclusiveGiven, projectDir, config, tests, cwd, packs, noPack };
}

/**
 * The store a test session keeps its history in: the one `--db` names (`:memory:` keeps nothing),
 * else the project's, created if needed. A project store that can't be opened (a read-only
 * checkout) costs the history, not the tests.
 */
function openTestStore(opts: GlobalOpts, projectDir: string): Store {
  if (opts.db) return Store.open(opts.db);
  const path = defaultDbPath(projectDir);
  try {
    return Store.open(path);
  } catch (err) {
    process.stderr.write(p.yellow(`[shadowlap] ${path} could not be opened (${messageOf(err)}); this session's history is not kept\n`));
    return Store.open(':memory:');
  }
}

/** A golden's spec, its gate with its share of the session's risk, and how its replays run. */
interface Prepared {
  golden: string;
  spec: TestSpec | null;
  expect: ReturnType<typeof rawExpectFor>;
  ctx: RecordingTestContext;
}

/** What --update did to a golden: re-recorded it, or kept the judge verdicts it lacked. */
type Updated = PackResult['updated'];

/**
 * A session as it runs: the store that keeps its history, the goldens' results so far, and the stop
 * signal that ends it early. run() replays every golden and keeps each result as it comes.
 */
class Session {
  readonly store: Store;
  readonly actor: string | null;
  readonly revision: string | null;
  /** Where the session runs, kept with every result: only a session that passed on the baseline branch, for no pull request, is part of a gate's baseline against history (gate-history.ts). */
  readonly ran: { branch: string | null; revision: string | null; pullRequest: boolean; baselineBranch: string | null };
  readonly source: ReturnType<typeof sessionSource>;
  readonly session: TestSession;
  /** One risk for the session, split across its gated goldens before any runs (suite-plan.ts): each gate takes its share, and the forecast says what the session costs. */
  readonly planned: ReturnType<typeof planSession>;
  readonly cases: JunitCase[] = [];
  readonly results: PackResult[] = [];
  upstreamRequests = 0;
  updates = 0;
  /** The attempt that proves the last injection gate that failed, which a job testing one golden opens first (sessionLinks). */
  gateProof: AttemptReport | null = null;
  readonly tested = new Map<string, { ok: boolean; fork: boolean }>();
  /** The goldens not run for want of a yes: someone else's packs, which a session of nothing else ends 2 for. */
  readonly unvouched = new Set<string>();
  /** Goldens that diverged in a way an update would fix: not only on values that change every run. */
  readonly updatable: string[] = [];
  /**
   * A golden that may fork and forked before its task's takeover passes, but no model can be scored
   * on it (a model takes over only where the recording still replays): --update re-records it too.
   */
  readonly forkedEarly: Array<{ packDir: string; golden: string; at: number; takeover: number }> = [];
  /** The goldens a signal cut short: no result this time. */
  readonly cut: string[] = [];
  /** Applied fixes whose goldens failed their last test and passed every one of them here. */
  settled: StoredFix[] = [];
  /**
   * Ctrl-C, or a dashboard job being stopped: the replay running now is cut short (its agent, and
   * whatever the agent started, get the signal), nothing more starts, and the session ends with
   * the results of the goldens that finished.
   */
  signal: NodeJS.Signals | null = null;
  private current: string | null = null;
  private readonly takeoverAt: ReturnType<typeof takeoverReader>;
  /**
   * The goldens' attempts interleave (turns.ts): one runs at a time, each golden's next behind the
   * other goldens still open, so failures that come in a burst land on many goldens once each, not
   * on one golden's attempts in a row (gating.md, "Attempts are independent").
   */
  private readonly turns: Turns | null;
  /**
   * The provider is the session's: unavailable attempts in a row are counted across its goldens, and
   * enough of them stop the session (sessionInARow: 3 for one golden, one more for each tenfold).
   */
  private readonly streak: ProviderStreak;
  /** One question at a time: goldens tested side by side each wait for the one asked before them. */
  private asking: Promise<unknown> = Promise.resolve();

  constructor(
    readonly request: TestRequest,
    private readonly pusher: Pusher | null,
  ) {
    const { opts, flags, projectDir, cwd, config, tests, packs } = request;
    this.store = openTestStore(opts, projectDir);
    this.actor = resolveAuthor({ cwd: projectDir });
    this.revision = codeVersion(cwd);
    const settings = loadTestSettings(projectDir);
    this.source = sessionSource({ cwd, configured: settings.baselineBranch ?? null });
    this.ran = { branch: this.source.branch, revision: this.revision, pullRequest: this.source.pullRequest, baselineBranch: this.source.baselineBranch };
    this.session = this.store.startTestSession({ command: givenCommand(process.argv, 'test'), revision: this.revision, actor: this.actor });
    // One risk for the session, split across its gated goldens before any runs (suite-plan.ts): each gate
    // takes its share, and the forecast says what the session costs.
    this.planned = planSession(packs, { store: this.store, tests, projectDir, prices: config.prices, baselineBranch: this.source.baselineBranch, risk: flags.suiteRisk ?? settings.suiteRisk ?? SUITE_RISK, inconclusive: request.inconclusiveGiven, maxAttempts: flags.maxAttempts });
    if (this.planned) for (const line of suiteLines(this.planned.plan)) process.stdout.write(p.dim(`${safe(line)}\n`));
    this.takeoverAt = takeoverReader(projectDir, this.store);
    this.turns = packs.length > 1 ? new Turns() : null;
    this.streak = new ProviderStreak(sessionInARow(packs.length));
  }

  private readonly onSignal = (sig: NodeJS.Signals) => {
    if (this.signal) return;
    this.signal = sig;
    this.turns?.close();
    process.stderr.write(p.yellow(`\n[shadowlap] interrupted: ${this.current ? `stopping ${safe(this.current)}, ` : ''}nothing more starts, and the session keeps what finished\n`));
  };

  private readonly stopped = () => this.signal !== null;

  private askInTurn(run: RunRecord, dir: string): Promise<boolean> {
    const answer = this.asking.then(() => confirmGolden(run, dir));
    this.asking = answer.catch(() => undefined);
    return answer;
  }

  /** A golden's spec, its gate with its share of the session's risk, and how its replays run. */
  private prepare(packDir: string): Prepared {
    const { flags, projectDir, tests, config, cwd } = this.request;
    const golden = goldenName(packDir, projectDir);
    const configured = specFor(tests, packDir, projectDir);
    // Its gate with its share of the session's risk.
    const share = this.planned?.gates.get(golden);
    const spec = configured && share ? { ...configured, gate: share } : configured;
    const expect = rawExpectFor(tests, packDir, projectDir);
    const ctx: RecordingTestContext = {
      store: this.store,
      config,
      cwd,
      writes: flags.writes,
      guard: flags.guard,
      online: !!flags.online,
      test: { golden, session: this.session.sessionId },
      branch: this.source.branch,
      baselineBranch: this.source.baselineBranch,
      // The line a dashboard job reads a new run from, and a way to open each replay.
      onRun: (runId, attempt, of) => {
        this.current = golden;
        process.stderr.write(p.dim(`[shadowlap] replaying run ${runId} for ${safe(golden)}${of > 1 ? `, attempt ${attempt} of ${spec?.gate ? `up to ${of}` : of}` : ''}\n`));
      },
      // An attempt the agent failed while its provider couldn't answer: not counted, and run again.
      onUnavailable: (u, waitMs, counted) => process.stderr.write(p.yellow(`[shadowlap] ${safe(golden)}: ${unavailableWords(u, counted)}; running ${counted ? 'the next attempt' : 'it again'} in ${formatDuration(waitMs)}\n`)),
      stopped: this.stopped,
      streak: this.streak,
      ...(flags.maxAttempts ? { maxAttempts: flags.maxAttempts } : {}),
      ...(flags.continue ? { continue: true } : {}),
      allowUnrecorded: allowedUnrecorded(flags.allowUnrecorded),
      // A golden from someone else's pack, which the repository doesn't track, asks first (golden-consent.ts).
      ...(flags.yes ? {} : { confirmCommand: (run: RunRecord, dir: string) => (goldenNeedsConsent(run, dir, projectDir) ? this.askInTurn(run, dir) : Promise.resolve(true)) }),
    };
    return { golden, spec, expect, ctx };
  }

  /** Every golden replayed and its result kept, then the session's totals; a signal ends it early. */
  async run(): Promise<void> {
    const { packs } = this.request;
    for (const s of STOP_SIGNALS) process.on(s, this.onSignal);
    const prepared = new Map(packs.map((d) => [d, this.prepare(d)] as const));
    // Each golden's replays, run first and in turn when there are several: a golden whose replay is
    // clean is decided in the first round, one that forks over as many rounds as its gate takes.
    // Then each golden's result is taken in order, as one after another would give it.
    const replays = new Map<string, GoldenOutcome>();
    try {
      if (this.turns) {
        const turns = this.turns;
        await Promise.all(
          packs.map(async (d) => {
            const g = prepared.get(d)!;
            replays.set(d, await testGolden(d, g.golden, g.spec, { ...g.ctx, turns }));
          }),
        );
      }
      for (const packDir of packs) {
        // Stopped: nothing more runs, but a golden whose replays had ended keeps its result.
        if (this.signal && !replays.has(packDir)) break;
        await this.testPack(packDir, prepared.get(packDir)!, replays.get(packDir));
      }
      // An applied fix marked as not holding holds again once its goldens pass, as after an update
      // re-recorded what another fix changed. Never fails the session.
      try {
        this.settled = settleAppliedFixes(this.store, new Set([...this.tested].filter(([, t]) => t.ok).map(([g]) => g)));
      } catch (err) {
        process.stderr.write(p.yellow(`[shadowlap] applied fixes whose goldens passed were not marked: ${messageOf(err)}\n`));
      }
      // Housekeeping never fails a session whose goldens all ran: the reports below still get written.
      if (!this.signal) {
        const unpruned = pruneQuietly(this.store, this.session, this.tested);
        if (unpruned) process.stderr.write(p.yellow(`[shadowlap] ${unpruned}\n`));
      }
    } finally {
      for (const s of STOP_SIGNALS) process.off(s, this.onSignal);
      this.finish();
    }
  }

  /**
   * The session's totals in its history, counted from the results recorded, so a session cut short by
   * an error or a signal counts what ran, each by how it came out: an inconclusive golden is neither
   * passed nor failed, whatever CI does with it, and the test history keeps how many there were with
   * the event.
   */
  private finish(): void {
    const { packs } = this.request;
    const passed = this.results.filter((r) => r.verdict === 'passed').length;
    const failed = this.results.filter((r) => r.verdict === 'failed').length;
    const inconclusive = this.results.length - passed - failed;
    try {
      this.store.finishTestSession(this.session.sessionId, { passed, failed, upstreamRequests: this.upstreamRequests, interrupted: this.signal !== null });
    } catch (err) {
      process.stderr.write(p.yellow(`[shadowlap] the session's totals were not kept in the test history: ${messageOf(err)}\n`));
    }
    recordEvent(this.store, { kind: 'test.session', actor: this.actor, ref: this.session.sessionId, data: { passed, failed, ...(inconclusive ? { inconclusive } : {}), goldens: this.results.length, revision: this.revision, upstreamRequests: this.upstreamRequests, ...(this.updates ? { updated: this.updates } : {}), ...(this.signal ? { interrupted: true, notRun: packs.length - this.results.length } : {}) } });
    try {
      this.store.close();
    } catch {
      // every write above has either landed or been reported
    }
  }

  /** One golden: its replays (taken as they ran, or run now), its injection gate, --update's work, and its result kept. */
  private async testPack(packDir: string, prepared: Prepared, replay: GoldenOutcome | undefined): Promise<void> {
    const { flags } = this.request;
    const { golden, spec, ctx } = prepared;
    this.current = golden;
    // Every run this golden makes, for --push: its replays, and a re-recording with --update.
    const made: string[] = [];
    let outcome = this.replayed(replay ?? (await testGolden(packDir, golden, spec, ctx)), made);
    if (outcome.unvouched) this.unvouched.add(packDir);
    // Cut short, it says nothing about the golden: no result, and nothing new after it. One stopped
    // before its first attempt started (waiting for its turn) never ran.
    if (outcome.interrupted) {
      if (outcome.result) this.cut.push(golden);
      return;
    }
    const first = await this.gated(outcome, golden, spec);
    if (!first) {
      this.cut.push(golden);
      return;
    }
    outcome = first.outcome;
    let injection = first.injection;
    this.show(golden, outcome);
    this.printGate(injection);
    const forked = !outcome.failure && spec?.fork ? (outcome.result?.shown.ended.summary.divergence ?? null) : null;
    const takeover = forked ? this.takeoverAt(packDir) : null;
    const early = forked && takeover !== null && forked.callNo < takeover ? { at: forked.callNo, takeover } : null;

    let updated: Updated = null;
    // A clean replay whose judge checks the golden holds no verdict for: --update asks each live
    // and keeps its call in the golden, so every later replay is judged from the recording.
    const toKeep = flags.update && !this.signal ? verdictsToKeep(outcome, spec) : [];
    if (toKeep.length && outcome.parent && outcome.result) {
      const kept = await this.keepVerdicts(packDir, prepared, outcome, toKeep, made);
      updated = kept.updated;
      outcome = kept.outcome;
    } else if (flags.update && (outcome.failure || early) && !this.signal) {
      const after = await this.update(packDir, prepared, outcome, injection, early, made);
      if (!after) {
        this.cut.push(golden);
        return;
      }
      ({ outcome, injection, updated } = after);
    }
    await this.keep(packDir, prepared, { outcome, injection, updated, early, made });
  }

  /** Every replay counts towards the session's upstream requests, an updated golden's first one too. */
  private replayed(o: GoldenOutcome, made: string[]): GoldenOutcome {
    for (const a of o.result?.attempts ?? []) {
      telemetry().record({ type: 'test', ...usageOf(a.ended, a.ms, a.code) });
      // A judge check's requests too: the session's count is everything it sent upstream.
      this.upstreamRequests += a.ended.summary.upstreamRequests + (a.ended.summary.judge?.upstreamRequests ?? 0);
      made.push(a.ended.summary.runId);
    }
    return o;
  }

  /**
   * Its injection gate, once its replay passed: plant payloads in its untrusted reads, live from
   * the model call that reads them, writes stubbed, and fail it when too many attempts obey, or
   * when the gate showed too little to say (inconclusive, which --inconclusive warn lets through).
   * Null when a signal cut the gate short: then the golden has no result, as for its replay.
   */
  private async gated(o: GoldenOutcome, golden: string, spec: TestSpec | null): Promise<{ outcome: GoldenOutcome; injection: InjectionGateData | null } | null> {
    const { opts, flags, projectDir, cwd } = this.request;
    if (!spec?.injection || !o.parent) return { outcome: o, injection: null };
    const allowed = { obeyed: spec.injection.obeyed, influenced: spec.injection.influenced };
    // Its replay did not pass: failed, or inconclusive, which is no failure, and says so here too.
    if (o.failure) return { outcome: o, injection: { resultId: null, attempts: 0, ...noVerdicts(), allowed, verdict: null, reason: null, skipped: `the golden ${verdictOf(o) === 'inconclusive' ? 'is inconclusive' : 'failed'}, so its injection gate did not run` } };
    if (this.signal) return null;
    process.stderr.write(p.dim(`[shadowlap] injection gate for ${safe(golden)}: planting payloads in its untrusted reads\n`));
    let data: InjectionGateData;
    let proof: string | null = null;
    try {
      const gate = await injectionGate({ opts, store: this.store, parent: o.parent, golden, entry: spec.injection, configDir: projectDir, cwd, sessionId: this.session.sessionId, actor: this.actor, guard: flags.guard, allowUnrecorded: [...allowedUnrecorded(flags.allowUnrecorded)] }, (line) => process.stderr.write(`${line}\n`));
      this.upstreamRequests += gate.report.cost.upstreamRequests;
      if (this.signal) return null;
      data = gate.data;
      this.gateProof = failedProof(this.store, gate);
      const obeyed = gate.report.attempts.find((a) => a.verdict === 'obeyed');
      proof = obeyed ? proofLine(obeyed) : null;
    } catch (err) {
      // A gate that can't run (a payload file gone) fails the golden: nothing let it through.
      data = { resultId: null, attempts: 0, ...noVerdicts(), allowed, verdict: 'failed', reason: `the injection gate could not run: ${messageOf(err)}`, skipped: null };
    }
    if (data.verdict === 'passed') return { outcome: o, injection: data };
    // The golden's verdict is the gate's: failed, or inconclusive, which --inconclusive warn lets
    // through (packResult and the JUnit case read it), while every report still says it.
    const verdict = data.verdict === 'inconclusive' ? 'inconclusive' : 'failed';
    const word = verdict === 'inconclusive' ? 'injection inconclusive' : 'injection';
    const through = verdict === 'inconclusive' ? (gateLetsThrough(data, flags.inconclusive) ? 'Let through by --inconclusive warn. ' : '--inconclusive warn lets an inconclusive gate through. ') : '';
    const failure = { message: `${word}: ${data.reason!}`, details: `${proof ? `${proof}\n` : ''}${through}${verdict === 'inconclusive' ? 'Every attempt, and why: ' : 'Every attempt, with its proof: '}shadowlap injection ${golden} --html report.html` };
    return { outcome: { ...o, ...(o.result ? { result: { ...o.result, verdict } } : {}), failure, kind: 'injection' }, injection: data };
  }

  /** What a golden's inconclusive does, and why when it only warns for its short history, or counts all the same (inconclusiveFor). */
  private inconclusiveOf(golden: string, o: GoldenOutcome): ReturnType<typeof inconclusiveFor> {
    return inconclusiveFor(o, this.request.inconclusiveGiven, this.planned?.short.get(golden), this.planned?.counts.get(golden));
  }

  /** A golden's lines, with why its inconclusive only warns, or counts though its history is short. */
  private show(golden: string, o: GoldenOutcome, suffix = ''): void {
    const { warned, counted } = this.inconclusiveOf(golden, o);
    const note = warned ? `${warned}: until then an inconclusive only warns (--inconclusive fail counts it), or give it a gate on fixed rates, "good" and "bad", which needs no history` : counted;
    printGolden(note ? { ...o, notes: [...(o.notes ?? []), note] } : o, suffix);
  }

  private printGate(d: InjectionGateData | null): void {
    if (d && d.verdict !== null) process.stdout.write(gateLine(d, this.request.flags.inconclusive) + '\n');
  }

  /** --update on a clean replay: the judge verdicts the golden lacks, asked live and kept in it, then the golden replayed as the next test replays it. */
  private async keepVerdicts(packDir: string, { golden, spec, ctx }: Prepared, outcome: GoldenOutcome, toKeep: JudgeCheck[], made: string[]): Promise<{ outcome: GoldenOutcome; updated: Updated }> {
    const { config, projectDir } = this.request;
    const golden0 = outcome.parent!;
    process.stdout.write(`    ${p.cyan('↻')} keeping ${toKeep.length === 1 ? `the verdict of ${safe(toKeep[0]!.name)}` : `${toKeep.length} judge verdicts`} in ${safe(golden)}: asking the judge live\n`);
    const k = await keepJudgeVerdicts(packDir, golden0, outcome.result!.shown, toKeep, { store: this.store, config, projectDir });
    this.upstreamRequests += k.judge?.upstreamRequests ?? 0;
    for (const line of k.lines) process.stdout.write(`      ${safe(line)}\n`);
    if (k.reason) {
      process.stdout.write(`    ${p.red('✗')} not kept: ${safe(k.reason)}\n`);
      return { outcome, updated: null };
    }
    this.updates++;
    const changes = k.kept.map((name) => `kept the verdict of ${name}`);
    const calls = callCounts(this.store.getCalls(golden0.runId)).total;
    process.stdout.write(`      kept in ${safe(golden)}${k.judge ? ` · ${judgeLine(k.judge)}` : ''}; review the change in your pull request\n`);
    recordEvent(this.store, { kind: 'golden.updated', actor: this.actor, runId: golden0.runId, ref: golden, data: { session: this.session.sessionId, previous: golden0.runId, calls, checks: toKeep.length, changes, judged: k.kept } });
    const updated = { from: golden0.runId, to: golden0.runId, calls, changes };
    const again = this.replayed(await testGolden(packDir, golden, spec, ctx), made);
    if (again.interrupted) {
      process.stdout.write(p.dim(`    the replay of the updated golden was interrupted; it runs with the next test\n`));
      return { outcome, updated };
    }
    this.show(golden, again, ' (judged)');
    return { outcome: again, updated };
  }

  /**
   * --update on a golden that diverged, or forked before its task's takeover: re-recorded live with
   * writes stubbed and replaced in the working tree when its checks pass, then replayed with its
   * injection gate. Null when a signal cut that gate short.
   */
  private async update(packDir: string, { golden, spec, ctx }: Prepared, outcome: GoldenOutcome, injection: InjectionGateData | null, early: { at: number; takeover: number } | null, made: string[]): Promise<{ outcome: GoldenOutcome; injection: InjectionGateData | null; updated: Updated } | null> {
    const { flags, config, cwd, projectDir, guardGiven } = this.request;
    if ((outcome.kind !== 'diverged' && !early) || !outcome.parent || !outcome.result) {
      process.stdout.write(p.dim(`    not updated: only a golden that diverged is re-recorded; ${notUpdatedWhy(outcome, injection)}\n`));
      return { outcome, injection, updated: null };
    }
    const before = outcome.parent;
    const divergence = outcome.result.shown.ended.summary.divergence;
    const normalizers = outcome.normalizers;
    for (const w of volatileWarning(divergence, normalizers)) process.stdout.write(p.yellow(`    ! ${w.text}\n        ${w.command}\n`));
    const why = early ? ` it forks at #${early.at}, before its task's takeover at #${early.takeover}, so no model can be scored on it;` : '';
    process.stdout.write(`    ${p.cyan('↻')} updating ${safe(golden)}:${why} re-recording live, writes stubbed\n`);
    const u = await rerecordGolden(packDir, before, spec, {
      store: this.store,
      config,
      cwd,
      projectDir,
      // Live, as `run` records: the guard warns, unless --guard was given.
      guard: guardGiven ? flags.guard : 'warn',
      onRun: (runId) => {
        process.stderr.write(p.dim(`[shadowlap] recording run ${runId}: ${safe(golden)} again, live, writes stubbed\n`));
        emitJobEvent({ type: 'run', runId, role: 'new' });
      },
      stopped: this.stopped,
      allowUnrecorded: allowedUnrecorded(flags.allowUnrecorded),
    });
    this.upstreamRequests += (u.summary?.upstreamRequests ?? 0) + (u.summary?.judge?.upstreamRequests ?? 0);
    if (u.run) made.push(u.run.runId);
    if (u.checks?.length && !u.interrupted) process.stdout.write(formatChecks(u.checks).split('\n').map((l) => `      ${l}`).join('\n') + '\n');
    if (!u.replaced || !u.run) {
      process.stdout.write(`    ${p.red('✗')} not replaced: ${safe(u.reason!)}\n`);
      const tail = u.interrupted ? null : outputTail(u.output, 10);
      if (tail) process.stdout.write(p.dim(safeLines(tail, '      │ ')));
      return { outcome, injection, updated: null };
    }
    this.updates++;
    const changes = requestChanges(this.store, before, u.run, divergence, normalizers);
    process.stdout.write(`      re-recorded as run ${shortId(u.run.runId)}: ${describeChange(u.before, u.after!)} · ${updateReceipt(u.summary)}\n`);
    if (changes.length) process.stdout.write(`      what changed: ${safe(changes.join(' · '))}\n`);
    process.stdout.write(`      replaced ${safe(golden)} in the working tree; review the change in your pull request\n`);
    recordEvent(this.store, { kind: 'golden.updated', actor: this.actor, runId: u.run.runId, ref: golden, data: { session: this.session.sessionId, previous: before.runId, calls: u.after!.total, checks: u.checks?.length ?? 0, changes } });
    const updated = { from: before.runId, to: u.run.runId, calls: u.after!.total, changes };
    // The new golden, replayed as the next test will replay it. Cut short, the result is the
    // replay that diverged, with the update it led to.
    const again = this.replayed(await testGolden(packDir, golden, spec, ctx), made);
    if (again.interrupted) {
      process.stdout.write(p.dim(`    the replay of the updated golden was interrupted; it runs with the next test\n`));
      return { outcome, injection, updated };
    }
    // The updated golden's own injection gate, now that it replays.
    const regated = await this.gated(again, golden, spec);
    if (!regated) return null;
    this.show(golden, regated.outcome, ' (updated)');
    this.printGate(regated.injection);
    return { outcome: regated.outcome, injection: regated.injection, updated };
  }

  /** A golden's result, kept in the session's history and its reports, and its runs pushed with --push. */
  private async keep(packDir: string, { golden, spec, expect }: Prepared, r: { outcome: GoldenOutcome; injection: InjectionGateData | null; updated: Updated; early: { at: number; takeover: number } | null; made: string[] }): Promise<void> {
    const { flags } = this.request;
    const { outcome, injection, updated, early, made } = r;
    for (const a of outcome.result?.attempts ?? []) emitJobEvent({ type: 'run', runId: a.ended.summary.runId, role: a.failure ? 'failing' : 'passing' });
    this.store.addTestResult({
      sessionId: this.session.sessionId,
      golden,
      ok: !outcome.failure,
      failure: outcome.kind,
      reason: outcome.failure?.message ?? null,
      runId: outcome.result?.shown.ended.summary.runId ?? null,
      goldenRunId: outcome.parent?.runId ?? null,
      revision: this.revision,
      data: { ...resultData(this.store, outcome), ...(updated ? { updated } : {}), ...(injection ? { injection } : {}), ...this.ran },
    });
    const decided = this.inconclusiveOf(golden, outcome);
    this.cases.push(junitCase(outcome, decided.mode));
    this.results.push(packResult(outcome, { expect, updated, inconclusive: decided.mode, warned: decided.warned, counted: decided.counted, injection }));
    this.tested.set(golden, { ok: !outcome.failure, fork: !!spec?.fork });
    if (!flags.update && early) this.forkedEarly.push({ packDir, golden, ...early });
    const divergence = outcome.result?.shown.ended.summary.divergence;
    if (!flags.update && outcome.kind === 'diverged' && !(divergence && volatileValues(divergence, outcome.normalizers).explainsAll)) this.updatable.push(packDir);
    // Team store: every run this golden made, once its result is kept, with the golden it replayed.
    if (this.pusher && made.length) await this.pusher.pushRuns(this.store, made);
  }
}

/** Why --update leaves a golden that failed as it is: only one that diverged is re-recorded. */
function notUpdatedWhy(outcome: GoldenOutcome, injection: InjectionGateData | null): string {
  if (outcome.kind === 'check') return 'a failed check is fixed in the agent, not in its golden';
  if (outcome.kind === 'inconclusive') return outcome.result?.gate ? 'an inconclusive gate is settled by more attempts (--max-attempts), not a new recording' : 'a check that could not be decided is settled by what it lacks (a judge that can be asked, its key; a value a condition can read), not a new recording';
  if (outcome.kind === 'injection') return injection?.verdict === 'inconclusive' ? 'an inconclusive injection gate says why it showed nothing, and a new recording changes none of that' : 'an agent that obeys planted text is fixed in its prompt or code, not in its golden';
  return 'this one failed for another reason';
}

/**
 * What the summary says of the session's `count` inconclusive goldens: those that only warn (--inconclusive
 * warn, or too few sessions yet for a gate against history), and those that fail the run. Empty with none.
 */
function inconclusiveWords(count: number, results: readonly PackResult[], given: InconclusiveMode | null): string {
  if (!count) return '';
  const warned = results.filter((r) => r.verdict === 'inconclusive' && r.ok).length;
  const failing = count - warned;
  const through = warned ? (given === 'warn' ? 'let through: --inconclusive warn' : `${warned === count ? '' : `${warned} `}let through: too few sessions yet`) : '';
  const fails = failing ? `${warned ? `${failing} ` : ''}failing the run: --inconclusive warn lets them through` : '';
  return `, ${count} inconclusive (${[through, fails].filter(Boolean).join(', ')})`;
}

/**
 * One golden's injection gate that decided nothing to fail on: a pass ends on Tests alone, and one
 * that showed too little on Tests beside it, so the dashboard's Re-run test leads (a footer starts
 * what a link can't). Null for any other session.
 */
function gateLinks(only: PackResult): JobEvent[] | null {
  const verdict = only.injection?.verdict;
  if (verdict === 'passed' && only.ok) return [{ type: 'link', label: 'Open Tests', href: links.tests() }];
  return verdict === 'inconclusive' ? [{ type: 'link', label: 'Open Tests', href: links.tests(), secondary: true }] : null;
}

/**
 * A dashboard job's links: one golden (as Add normalizer and re-run tests it) to its replay; a
 * session over several to the replay of each that failed, the first few, then Tests for them all.
 * One primary action: Open proof where one golden's injection gate failed on an attempt that proves
 * it, Tests where it passed, else the replay of a single golden, else Tests, with the other links beside it.
 */
function sessionLinks(results: readonly PackResult[], only: PackResult | null, gateProof: AttemptReport | null): JobEvent[] {
  const proof = only?.runId && only.injection?.verdict === 'failed' ? gateProof : null;
  if (!only?.runId) return [...results.filter((x) => !x.ok && x.runId).slice(0, FAILED_LINKS).map((r): JobEvent => ({ type: 'link', label: r.name, href: links.run(r.runId!), secondary: true })), { type: 'link', label: 'Open Tests', href: links.tests() }];
  const gate = gateLinks(only);
  if (gate) return gate;
  const replay: JobEvent = { type: 'link', label: only.ok ? 'Open passing run' : 'Open run', href: links.run(only.runId), ...(proof ? { secondary: true } : {}) };
  return [...(proof ? [{ type: 'link', label: ACTIONS.openProof.label, href: links.run(proof.runId, proofCall(proof)) } satisfies JobEvent] : []), replay, { type: 'link', label: 'Open Tests', href: links.tests(), secondary: true }];
}

/** The attempt that proves a gate that failed, among the runs kept (the engine's proofOf); null for one that passed or couldn't say. */
const failedProof = (store: StoreOf<'recording'>, gate: { data: InjectionGateData; report: PlantReport }): AttemptReport | null => (gate.data.verdict === 'failed' ? proofOf(store, gate.report) : null);

/** The reports a session was asked for, its job's links and summary, and the status it ends with. */
async function reportSession(request: TestRequest, pusher: Pusher | null, s: Session): Promise<void> {
  const { flags, packs, noPack } = request;
  const { results, signal } = s;
  const notRun = packs.length - results.length;
  for (const c of s.cut) process.stdout.write(`${p.yellow('⏹')} ${safe(c)}: interrupted, so it has no result this time\n`);
  if (flags.junit) writeFileSync(flags.junit, junitXml('shadowlap', s.cases));
  const report = testReport(results, { id: s.session.sessionId, revision: s.revision, interrupted: signal !== null }, s.planned ? suiteJson(s.planned.plan) : null);
  if (flags.json) writeFileSync(flags.json, JSON.stringify(report, null, 2) + '\n');
  // What CI did with an inconclusive golden, as the summary names it: the --inconclusive given, or the default and a young golden's rule.
  if (flags.markdown) writeFileSync(flags.markdown, markdownReport(report, request.inconclusiveGiven), { flag: 'a' });
  if (flags.annotations && (report.failed || report.inconclusive)) process.stdout.write(githubAnnotations(report) + '\n');
  if (pusher) await pusher.finish(report);
  emitJobEvent({ type: 'result', data: report });
  sessionLinks(results, results.length === 1 && packs.length === 1 ? results[0]! : null, s.gateProof).forEach((e) => emitJobEvent(e));
  // Inconclusive ones are counted apart, and what CI does with them is said.
  const inconclusive = inconclusiveWords(report.inconclusive, results, request.inconclusiveGiven);
  const passedCount = results.filter((r) => r.verdict === 'passed').length;
  const failedCount = results.filter((r) => r.verdict === 'failed').length;
  process.stdout.write(`\n${passedCount} passed, ${failedCount} failed${inconclusive}${signal && notRun ? `, ${notRun} not run: interrupted` : ''} · ${s.upstreamRequests} upstream request${s.upstreamRequests === 1 ? '' : 's'}\n`);
  for (const fix of s.settled) process.stdout.write(`${p.green('✓')} ${shortFixId(fix.fixId)} holds again: its goldens passed · ${safe(fix.title)}\n`);
  // What to do about a divergence that was meant (one on values that change every run has its normalizer hint above).
  if (s.updatable.length) process.stdout.write(p.dim(`If the change was intended, update ${s.updatable.length === 1 ? 'it' : 'them'}: shadowlap test ${safe(quoteArgv(s.updatable))} --update\n`));
  // A golden that passes but forks before its task's takeover: Training lists its task as blocked until it is updated.
  for (const f of s.forkedEarly) process.stdout.write(p.dim(`${safe(f.golden)} forks at #${f.at}, before its task's takeover at #${f.takeover}, so no model can be scored on it. Update it: shadowlap test ${safe(quoteArgv([f.packDir]))} --update\n`));
  await telemetry().flush();
  process.exitCode = sessionStatus(results, { signal, noPack, unvouched: s.unvouched });
}

/**
 * As a shell reports a command a signal stopped: 130 for Ctrl-C, 143 for SIGTERM. Then a golden
 * that failed, 1, unless the only ones that did were packs it needs --yes to run, which are a
 * usage error as `replay` makes one, 2; one that was inconclusive and not let through
 * (--inconclusive warn), 3.
 */
function sessionStatus(results: readonly PackResult[], s: { signal: NodeJS.Signals | null; noPack: readonly string[]; unvouched: ReadonlySet<string> }): number {
  if (s.signal) return signalExit(s.signal);
  if (s.noPack.length) return EXIT.usage;
  const failedHere = results.filter((r) => !r.ok && r.verdict === 'failed');
  if (failedHere.some((r) => !s.unvouched.has(r.dir))) return EXIT.failed;
  if (failedHere.length) return EXIT.usage;
  return results.some((r) => !r.ok) ? EXIT.inconclusive : EXIT.ok;
}

/**
 * The one-line result of a golden that passed: `30/30 replayed, 12k input tokens not re-spent, 2
 * checks passed`. Input tokens as `show` and the dashboard count them: uncached, written to the
 * cache and read from it.
 */
export function passedLine(o: GoldenOutcome): string {
  const r = o.result!;
  const s = r.shown.ended.summary;
  // Out of what the recording holds, not what this replay made: one that stopped short never reads as whole.
  const replayed = s.byOrigin.replayed + s.byOrigin.overridden;
  return [
    // A golden that may fork passes on its checks, one that stopped short included.
    s.divergence?.type === 'ended_early'
      ? `ended early at call ${s.divergence.callNo}, ${endedEarlyCount(s.divergence)} replayed`
      : s.divergence
        ? `forked at call ${s.divergence.callNo}, ${s.byOrigin.replayed}/${s.total} replayed`
        : `${replayed}/${replayed + s.notReached.length} replayed`,
    `${formatTokens(wholeInput(s.tokensNotRespent))} input tokens not re-spent`,
    // Reads the recording never held (a timestamp the agent logs now), answered live: no change, said all the same.
    ...(s.extraReads?.length ? [`${s.extraReads.length} extra read${s.extraReads.length === 1 ? '' : 's'} answered live`] : []),
    ...(r.shown.checks?.length ? [statusTally(r.shown.checks)] : []),
    // An attempt a check could not decide, after the count was met, is counted apart: it did not fail.
    ...(r.attempts.length - r.unavailable > 1 && !r.gate ? [`${r.passed}/${r.attempts.length - r.unavailable} attempts passed${r.inconclusive ? ` (${r.inconclusive} inconclusive)` : ''}`] : []),
    // Attempts the provider was unavailable for: run, and not counted. A gate's verdict line says so in its tally.
    ...(r.unavailable && !r.gate ? [`${r.unavailable} attempt${r.unavailable === 1 ? '' : 's'} not counted: the provider was unavailable`] : []),
  ].join(', ');
}

/**
 * The judge checks `test --update` asks live for a golden and keeps in it: those whose verdict a
 * clean replay didn't take from the recording, when nothing but judge checks stands between the
 * golden and a pass. A replay that forked read other material than its golden's, and any other
 * failure is the agent's to fix.
 */
function verdictsToKeep(o: GoldenOutcome, spec: TestSpec | null): JudgeCheck[] {
  const shown = o.result?.shown;
  if (!judgesOf(spec).length || !shown || !o.parent || shown.code !== 0 || shown.interrupted || shown.ended.summary.divergence) return [];
  if (o.failure && ((o.kind !== 'check' && o.kind !== 'inconclusive') || shown.checks?.some((c) => !c.ok && !c.judge))) return [];
  const names = new Set((shown.checks ?? []).filter((c) => c.judge && c.judge.source !== 'recording').map((c) => c.judge!.name));
  return judgesOf(spec).filter((j) => names.has(j.name));
}

function printGolden(o: GoldenOutcome, suffix = ''): void {
  const gate = o.result?.gate;
  // What to know about how its gate decided, under its line.
  const notes = () => {
    for (const note of o.notes ?? []) process.stdout.write(p.dim(`    ${safe(note)}\n`));
  };
  if (!o.failure) {
    // A gate's verdict line leads (the verdict word, the tally, the bound, the rule), with pass^k and the rest under it.
    if (gate) process.stdout.write(`${p.green('✓')} ${safe(o.name)}: ${gate.sentence}${suffix}\n${p.dim(`    ${[formatPassK(gate), passedLine(o)].filter(Boolean).join(' · ')}`)}\n`);
    else process.stdout.write(`${p.green('✓')} ${safe(o.name)}: ${passedLine(o)}${suffix}\n`);
    // A judge's verdict and reason are worth reading on a golden that passed too.
    const judged = (o.result?.shown.checks ?? []).filter((c) => c.judge);
    if (judged.length) process.stdout.write(p.dim(judged.map((c) => `    ${safe(checkLine(c))}`).join('\n')) + '\n');
    notes();
    return;
  }
  // Inconclusive is neither, whatever CI does with it: marked ? in amber, as a check that could not be decided is.
  const inconclusive = verdictOf(o) === 'inconclusive';
  // Its message as one line: it can carry what the golden's command or its provider said.
  process.stdout.write(`${inconclusive ? p.yellow('?') : p.red('✗')} ${safe(o.name)}: ${safe(o.failure.message)}\n`);
  notes();
  if (!o.result) return;
  const indent = (text: string, prefix = '    ') => text.split('\n').map((l) => prefix + l).join('\n') + '\n';
  if (o.result.shown.checks?.length) process.stdout.write(indent(formatChecks(o.result.shown.checks)));
  // Every line of it escaped, as what the agent printed is: it can hold that (a command that never started), an error's words, a proof.
  process.stdout.write(safeLines(o.failure.details, '    '));
  // An injection gate fails on its attempts, not on the replay: what the replay printed says nothing.
  const tail = o.kind === 'injection' ? null : outputTail(o.result.shown.output);
  // Every line of it after the bar, a bare CR's too, its control characters escaped: a CI log reads a line that starts with :: as a command.
  if (tail) process.stdout.write(p.dim(safeLines(tail, '    │ ')));
}
