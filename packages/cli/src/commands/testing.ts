import { writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { links } from '@shadowlap/dashboard';
import { describeRule, EXTERNAL_COMMAND, endedEarlyCount, formatDuration, formatPassK, formatTokens, GATE_MAX_ATTEMPTS, messageOf, SUITE_RISK, judgeLine, judgeParts, noVerdicts, packRun, proofLine, recordEvent, resolveAuthor, settleAppliedFixes, sessionInARow, statusTally, Store, unpackRun, volatileValues, wholeInput, type InjectionGateData, type RunRecord, type StoredFix, type WritePolicy } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { logActivity, newRunMeta } from '../activity.js';
import { STOP_SIGNALS } from '../agent-signals.js';
import { BisectDeclined, BisectError, formatBisect, runBisect } from '../bisect.js';
import { testChaos } from '../chaos-session.js';
import { checkLine, judgeResults, specFor, type JudgeCheck, type TestSpec } from '../checks.js';
import { codeVersion, defaultDbPath, loadConfig, loadTests, loadTestSettings, upstreamOverrides } from '../config.js';
import { EXIT, interruptedStatus, signalExit, usageError } from '../exit-codes.js';
import { ALLOW_UNRECORDED, ALLOW_UNRECORDED_HELP, allowedUnrecorded, collectNames } from '../unrecorded.js';
import { unrecordedInGoldens } from '../unrecorded-goldens.js';
import { sessionSource } from '../baseline-branch.js';
import { ProviderStreak, unavailableWords } from '../provider-retry.js';
import { planSession, suiteJson, suiteLines } from '../suite-plan.js';
import { readExpect } from './fix.js';
import { shortFixId } from '../fix-format.js';
import { formatChecks, inconclusiveFor, junitCase, outputTail, packResult, pruneQuietly, resultData, testGolden, verdictOf, type GoldenOutcome, type InconclusiveMode, type RecordingTestContext } from '../golden-test.js';
import { Turns } from '../turns.js';
import { confirmGolden, goldenNeedsConsent } from '../golden-consent.js';
import { callCounts, describeChange, keepJudgeVerdicts, requestChanges, rerecordGolden, updateReceipt, volatileWarning } from '../golden-update.js';
import { expandRecordings, goldenName, isPack, rawExpectFor } from '../goldens.js';
import { cannotJudge, judgedOptions, judgeEndedRun, judgesOf, type JudgedRun } from '../judge.js';
import { emitJobEvent } from '../job-events.js';
import { junitXml, type JunitCase } from '../junit.js';
import { RecordingHost } from '../recordings.js';
import { captureConfig, noProxyEnv, type GuardMode } from '../run-agent.js';
import { ancestorsOf, confirmImportedCommand, openStore, parseChoice, parseIntArg, printOutcome, readStore, requireEnded, requireRun, telemetry, unredacted, usageOf, VERSION, type GlobalOpts } from '../shared.js';
import { prepareTestPush, pushIfQueued, teamEnv } from '../team.js';
import { takeoverReader } from '../tasks.js';
import { gateLetsThrough, gateLine, injectionGate } from '../injection.js';
import { githubAnnotations, markdownReport, testReport, type PackResult } from '../test-report.js';
import { palette as p, quoteArgv, safe, shortId } from '../ui.js';

/** Recordings as tests: `shadowlap test` for packed goldens in CI, `bisect`, packs, and the host that the pytest and Vitest plugins start. */

/** How many failing goldens a dashboard job links to by their replay; Tests has every one. */
const FAILED_LINKS = 3;


/**
 * `shadowlap serve --recordings`: the host a test-runner plugin starts once per worker process.
 * It prints how to reach it (base URLs per slot, with `__SLOT__` for the plugin to fill in, and the
 * in-process capture module) and runs until its stdin closes, which is when the test runner exits.
 */
async function serveRecordings(store: Store, config: ReturnType<typeof loadConfig>, db: string | undefined, allowUnrecorded: readonly string[]): Promise<void> {
  const root = process.cwd();
  const upstreams = upstreamOverrides(process.env);
  // What a replay may run again though its recording never recorded it: the flag's, and the test run's environment's, which the plugins pass on.
  const allowed = allowedUnrecorded([...allowUnrecorded, process.env.SHADOWLAP_ALLOW_UNRECORDED ?? '']);
  const host = new RecordingHost(store, root, { codeVersion: codeVersion(root), redact: config.redact, unrecorded: { declared: config.unrecorded ?? {}, allowed } });
  const sidecar = await Sidecar.start({ store, normalizers: config.normalize, upstreams, api: host.api, ...(config.prices ? { prices: config.prices } : {}), ...(config.clock ? { clock: config.clock } : {}), ...(config.http ? { http: config.http } : {}), ...(config.tools ? { trust: config.tools } : {}) });
  host.attach(sidecar);
  const captureDir = fileURLToPath(new URL('../../guard/', import.meta.url));
  process.stdout.write(
    JSON.stringify({
      shadowlap: VERSION,
      url: sidecar.url,
      root,
      // The loopback addresses in NO_PROXY: a test worker behind a proxy reaches the sidecar directly.
      env: { ...noProxyEnv(process.env), ...sidecar.envForSlot('__SLOT__'), SHADOWLAP_CAPTURE: process.env.SHADOWLAP_CAPTURE === 'off' ? 'off' : captureConfig(upstreams, sidecar.httpRules) },
      capture: { node: join(captureDir, 'node-capture.mjs'), python: captureDir },
    }) + '\n',
  );
  await new Promise<void>((resolveDone) => {
    const done = () => resolveDone();
    process.stdin.on('end', done);
    process.stdin.on('close', done);
    process.stdin.resume();
    for (const s of STOP_SIGNALS) process.once(s, done);
  });
  // A stop signal can come while the plugin still holds its end open: nothing more is read from it.
  process.stdin.destroy();
  host.close();
  await sidecar.close();
  store.close();
  // Team store: recordings someone pushed while they were running go to the store now that they have ended.
  await pushIfQueued(teamEnv(db));
}

/**
 * The judge checks of the golden a pack folder is: those of its `tests` entry. A config that can't
 * be read leaves the pack unjudged, and says so.
 */
function judgesOfPack(dir: string): JudgeCheck[] {
  try {
    return judgesOf(specFor(loadTests(process.cwd()), resolve(dir), process.cwd()));
  } catch (err) {
    process.stderr.write(p.yellow(`[shadowlap] the checks for ${dir} could not be read, so no judge was asked: ${messageOf(err)}\n`));
    return [];
  }
}

/** Each judge check a pack was judged by: its verdict, or why it has none and how to get one. */
function printPackJudged(dir: string, run: RunRecord, judges: readonly JudgeCheck[], judged: JudgedRun): void {
  // A run that didn't complete is never judged, here or by its replays: nothing to get a verdict for.
  const cannot = cannotJudge(run);
  if (cannot) {
    process.stdout.write(p.dim(`no judge asked for the pack: ${cannot}\n`));
    return;
  }
  process.stdout.write(`judged ${judges.length} check${judges.length === 1 ? '' : 's'} for the pack${judged.judge ? ` (${judgeParts(judged.judge).join(' · ')})` : ''}:\n`);
  for (const line of judgeResults(judges, judgedOptions(judged)).map((c) => checkLine(c))) process.stdout.write(`  ${safe(line)}\n`);
  const again = `shadowlap test ${safe(quoteArgv([dir]))} --update`;
  const missing = judges.filter((j) => judged.notJudged.has(j.name));
  const names = (list: readonly JudgeCheck[]) => list.map((j) => safe(j.name)).join(', ');
  // A recording keeps no output: a check on it is judged on what a replay prints.
  const outputs = missing.filter((j) => j.of === 'output');
  const others = missing.filter((j) => j.of !== 'output');
  if (outputs.length) process.stdout.write(p.yellow(`  a recording keeps no output, so ${names(outputs)} ${outputs.length === 1 ? 'is' : 'are'} judged on what a replay prints: record ${outputs.length === 1 ? 'its verdict' : 'their verdicts'} with ${again}\n`));
  if (others.length) process.stdout.write(p.yellow(`  the pack holds no verdict for ${names(others)}, so ${others.length === 1 ? 'it is' : 'they are'} inconclusive offline: give the judge a way to be asked (its key) and pack again, or record ${others.length === 1 ? 'its verdict' : 'their verdicts'} with ${again}\n`));
}

/** The verdicts of a pack's judge checks, for a dashboard job: each one's verdict, reason, where it came from and its cost, or why it has none. */
function judgedList(judges: readonly JudgeCheck[], judged: JudgedRun) {
  return judges.map((j) => {
    const v = judged.verdicts.get(j.name);
    return { name: j.name, verdict: v?.verdict ?? null, reason: v?.reason ?? null, source: v?.source ?? null, cost: v ? (v.cost ?? null) : null, why: judged.notJudged.get(j.name) ?? null };
  });
}

/** Whether a pack folder is one the config's tests name, so a golden wherever it lives. */
function isTestPack(dir: string): boolean {
  try {
    return specFor(loadTests(process.cwd()), resolve(dir), process.cwd()) !== null;
  } catch {
    return false;
  }
}


/** `--suite-risk`: a share above 0 and below 0.5. */
function parseSuiteRisk(value: string): number {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0 || v >= 0.5) throw new InvalidArgumentError('must be a number above 0 and below 0.5, such as 0.05: the most a healthy suite may go red for nothing');
  return v;
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

/** The command as it was given, without the global options before it: `['shadowlap', 'test', 'goldens/*']`. */
export function givenCommand(argv: readonly string[], name: string): string[] {
  const args = argv.slice(2);
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-') && args[i] !== name) i += args[i] === '--db' ? 2 : 1;
  return ['shadowlap', ...(args[i] === name ? args.slice(i) : [name, ...args.slice(i)])];
}

/**
 * The environment `serve` prints, as the shell it is pasted into sets it: `export K=V` lines for a
 * POSIX shell, and on Windows PowerShell's `$env:K = 'V'`, which its terminals open by default.
 */
export function envLines(env: Record<string, string>, platform: NodeJS.Platform = process.platform): string {
  const lines = Object.entries(env).map(([k, v]) => (platform === 'win32' ? `$env:${k} = '${v.replace(/'/g, "''")}'` : `export ${k}=${v}`));
  return lines.join('\n');
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
    for (const note of o.notes ?? []) process.stdout.write(p.dim(`    ${note}\n`));
  };
  if (!o.failure) {
    // A gate's verdict line leads (the verdict word, the tally, the bound, the rule), with pass^k and the rest under it.
    if (gate) process.stdout.write(`${p.green('✓')} ${o.name}: ${gate.sentence}${suffix}\n${p.dim(`    ${[formatPassK(gate), passedLine(o)].filter(Boolean).join(' · ')}`)}\n`);
    else process.stdout.write(`${p.green('✓')} ${o.name}: ${passedLine(o)}${suffix}\n`);
    // A judge's verdict and reason are worth reading on a golden that passed too.
    const judged = (o.result?.shown.checks ?? []).filter((c) => c.judge);
    if (judged.length) process.stdout.write(p.dim(judged.map((c) => `    ${safe(checkLine(c))}`).join('\n')) + '\n');
    notes();
    return;
  }
  // Inconclusive is neither, whatever CI does with it: marked ? in amber, as a check that could not be decided is.
  const inconclusive = verdictOf(o) === 'inconclusive';
  process.stdout.write(`${inconclusive ? p.yellow('?') : p.red('✗')} ${o.name}: ${o.failure.message}\n`);
  notes();
  if (!o.result) return;
  const indent = (text: string, prefix = '    ') => text.split('\n').map((l) => prefix + l).join('\n') + '\n';
  if (o.result.shown.checks?.length) process.stdout.write(indent(formatChecks(o.result.shown.checks)));
  process.stdout.write(indent(o.failure.details));
  // An injection gate fails on its attempts, not on the replay: what the replay printed says nothing.
  const tail = o.kind === 'injection' ? null : outputTail(o.result.shown.output);
  // Every line of it after the bar, a bare CR's too, its control characters escaped: a CI log reads a line that starts with :: as a command.
  if (tail) process.stdout.write(p.dim(indent(tail.split(/\r\n|\r|\n/).map(safe).join('\n'), '    │ ')));
}

export function register(program: Command): void {
  program.commandsGroup('Test:');

  program
    .command('test')
    .description('Replay packed recordings offline and fail on any divergence or failed check (CI). Each pack re-runs its recorded command; checks come from "tests" in shadowlap.config.json. Each session is kept in the project\'s store as test history.')
    .argument('<pack...>', 'directories written by shadowlap pack; a * in the last part matches several, as in goldens/*')
    .option('--junit <file>', 'write a JUnit XML report')
    .option('--json <file>', 'write a JSON report (results per pack, with each replay\'s run id, for other tools)')
    .option('--markdown <file>', 'append a Markdown report to this file, e.g. $GITHUB_STEP_SUMMARY')
    .option('--annotations', 'print GitHub Actions error annotations for packs that fail')
    .option('--update', 're-record each golden that diverged, live with writes stubbed, and replace it in the working tree when its checks pass; a golden that replayed clean gets the judge verdicts it lacks asked live and kept')
    .option('--online', 'allow live calls after a divergence (default: offline, a live call fails the test)')
    .option('--writes <policy>', 'write tools after divergence: block | stub | allow', parseChoice<WritePolicy>(['block', 'stub', 'allow']), 'block')
    .option('--cwd <dir>', 'working directory for the recorded commands (default: current)')
    .option('--guard <mode>', 'network guard: block, warn or off (re-recording under --update, warn unless given)', parseChoice<GuardMode>(['warn', 'block', 'off']), 'block')
    .option('--push', "push every test run and the report to the team store, with this machine's (or the CI job's) own credentials; a pull request's job pushes to its own folder")
    .option('--inconclusive <mode>', "what an inconclusive verdict does, a gate's, a check's or, with --chaos, a preset's: fail the run, or warn and let it through; with neither given, a gate against history whose golden has fewer than 30 sessions only warns", parseChoice<InconclusiveMode>(['fail', 'warn']), 'fail')
    .option('--max-attempts <n>', "raise each gate's limit for this session: its max, the most attempts it runs", parseIntArg)
    .option('--suite-risk <r>', 'the most a healthy suite may go red for nothing, split across its gated goldens (default: tests.suiteRisk in the config, else 0.05)', parseSuiteRisk)
    .option('--continue', "carry an inconclusive gate's attempts over from the golden's last result, when its recording, checks and gate are unchanged, and run only the attempts still needed (with --max-attempts, the higher limit to run to)")
    // Error-path presets: each golden forked where a tool or the provider fails, instead of the session above.
    .option('--chaos', "run the error-path presets instead: each golden forked at one call with a tool timeout, an empty result, malformed JSON, an oversized result, a provider 429 and a 500, live from the call it hits (writes stubbed unless --writes says otherwise), each judged by its tests entry's chaos.expect, else the upper bounds its expect sets on write tools")
    .option('--presets <list>', 'with --chaos: the presets to run, comma-separated: timeout, empty, malformed, oversized, 429, 500 (default: all, or the tests entry\'s "chaos.presets")')
    .option('--chaos-tool <name>', 'with --chaos: the tool whose first call the tool presets hit (default: the first tool call that reads the world)')
    .option(ALLOW_UNRECORDED, 'run these tools again for real though a golden never recorded them and they write, or nothing says what they do: names separated by commas (repeatable)', collectNames)
    .option('-y, --yes', "run the recorded command of a golden from someone else's pack that this repository doesn't track, without asking (without it, such a golden asks first, and without a terminal isn't run)")
    .action(async function (this: Command, packArgs: string[], flags: { junit?: string; json?: string; markdown?: string; annotations?: boolean; update?: boolean; online?: boolean; writes: WritePolicy; cwd?: string; guard: GuardMode; push?: boolean; inconclusive: InconclusiveMode; maxAttempts?: number; suiteRisk?: number; continue?: boolean; chaos?: boolean; presets?: string; chaosTool?: string; allowUnrecorded?: string[]; yes?: boolean }) {
      const opts = program.opts<GlobalOpts>();
      // A golden whose model called a tool its recording never recorded, which writes, would run it
      // again for real: refused before anything runs, every such golden named. Reads only warn.
      {
        const found = expandRecordings(packArgs, process.cwd()).dirs;
        const looked = unrecordedInGoldens(found.map((dir) => ({ dir, name: goldenName(dir, process.cwd()) })), loadConfig(process.cwd()).unrecorded ?? {}, allowedUnrecorded(flags.allowUnrecorded));
        if (looked.refused) throw usageError(looked.refused);
        for (const w of looked.warnings) process.stderr.write(`${w}\n`);
      }
      if (flags.chaos) {
        if (flags.update || flags.push || flags.annotations || flags.maxAttempts || flags.continue || flags.suiteRisk !== undefined) throw new InvalidArgumentError('--chaos runs the error-path presets, not a test session: --update, --push, --annotations, --max-attempts, --suite-risk and --continue are for a test session');
        const chaosFlags = { ...(flags.yes ? { yes: true } : {}), ...(flags.presets ? { presets: flags.presets } : {}), ...(flags.chaosTool ? { chaosTool: flags.chaosTool } : {}), ...(this.getOptionValueSource('writes') === 'cli' ? { writes: flags.writes } : {}), guard: flags.guard, inconclusive: flags.inconclusive, ...(flags.json ? { json: flags.json } : {}), ...(flags.junit ? { junit: flags.junit } : {}), ...(flags.markdown ? { markdown: flags.markdown } : {}), ...(flags.cwd ? { cwd: flags.cwd } : {}), allowUnrecorded: allowedUnrecorded(flags.allowUnrecorded) };
        await testChaos(opts, packArgs, chaosFlags, givenCommand(process.argv, 'test'));
        return;
      }
      if (flags.presets || flags.chaosTool) throw new InvalidArgumentError('--presets and --chaos-tool go with --chaos');
      const guardGiven = this.getOptionValueSource('guard') === 'cli';
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
      // Team store: no store or no credentials is a warning; the tests still decide the exit code.
      const pusher = flags.push ? await prepareTestPush(teamEnv(opts.db), { ...(flags.annotations ? { annotations: true } : {}) }) : null;

      const store = openTestStore(opts, projectDir);
      const actor = resolveAuthor({ cwd: projectDir });
      const revision = codeVersion(cwd);
      // Where the session runs, kept with every result: only a session that passed on the baseline
      // branch, for no pull request, is part of a gate's baseline against history (gate-history.ts).
      const settings = loadTestSettings(projectDir);
      const source = sessionSource({ cwd, configured: settings.baselineBranch ?? null });
      const ran = { branch: source.branch, revision, pullRequest: source.pullRequest, baselineBranch: source.baselineBranch };
      const session = store.startTestSession({ command: givenCommand(process.argv, 'test'), revision, actor });
      // One risk for the session, split across its gated goldens before any runs (suite-plan.ts):
      // each gate takes its share, and the forecast says what the session costs.
      // --inconclusive given decides for every golden; with none, a gate against history whose golden has
      // too few sessions yet only warns when it runs out of attempts, and every other inconclusive fails.
      const given = this.getOptionValueSource('inconclusive') === 'cli' ? flags.inconclusive : null;
      const planned = planSession(packs, { store, tests, projectDir, prices: config.prices, baselineBranch: source.baselineBranch, risk: flags.suiteRisk ?? settings.suiteRisk ?? SUITE_RISK, inconclusive: given, maxAttempts: flags.maxAttempts });
      /** What a golden's inconclusive does, and why when it only warns for its short history. */
      const inconclusiveOf = (golden: string, o: GoldenOutcome) => inconclusiveFor(o, given, planned?.short.get(golden));
      /** A golden's lines, with why its inconclusive only warns. */
      const show = (golden: string, o: GoldenOutcome, suffix = '') => {
        const why = inconclusiveOf(golden, o).why;
        printGolden(why ? { ...o, notes: [...(o.notes ?? []), `${why}: until then an inconclusive only warns (--inconclusive fail counts it), or give it a gate on fixed rates, "good" and "bad", which needs no history`] } : o, suffix);
      };
      if (planned) for (const line of suiteLines(planned.plan)) process.stdout.write(p.dim(`${safe(line)}\n`));
      const cases: JunitCase[] = [];
      const results: PackResult[] = [];
      let upstreamRequests = 0;
      let updates = 0;
      const tested = new Map<string, { ok: boolean; fork: boolean }>();
      // The goldens not run for want of a yes: someone else's packs, which a session of nothing else ends 2 for.
      const unvouched = new Set<string>();
      // Goldens that diverged in a way an update would fix: not only on values that change every run.
      const updatable: string[] = [];
      // A golden that may fork and forked before its task's takeover passes, but no model can be scored
      // on it (a model takes over only where the recording still replays): --update re-records it too.
      const takeoverAt = takeoverReader(projectDir, store);
      const forkedEarly: Array<{ packDir: string; golden: string; at: number; takeover: number }> = [];
      // Ctrl-C, or a dashboard job being stopped: the replay running now is cut short (its agent, and
      // whatever the agent started, get the signal), nothing more starts, and the session ends with
      // the results of the goldens that finished.
      let signal = null as NodeJS.Signals | null;
      let current = null as string | null;
      // The goldens' attempts interleave (turns.ts): one runs at a time, each golden's next behind the
      // other goldens still open, so failures that come in a burst land on many goldens once each, not
      // on one golden's attempts in a row (gating.md, "Attempts are independent").
      const turns = packs.length > 1 ? new Turns() : null;
      // The provider is the session's: unavailable attempts in a row are counted across its goldens, and
      // enough of them stop the session (sessionInARow: 3 for one golden, one more for each tenfold).
      const streak = new ProviderStreak(sessionInARow(packs.length));
      const onSignal = (sig: NodeJS.Signals) => {
        if (signal) return;
        signal = sig;
        turns?.close();
        process.stderr.write(p.yellow(`\n[shadowlap] interrupted: ${current ? `stopping ${current}, ` : ''}nothing more starts, and the session keeps what finished\n`));
      };
      for (const s of STOP_SIGNALS) process.on(s, onSignal);
      const stopped = () => signal !== null;
      // The goldens a signal cut short: no result this time.
      const cut: string[] = [];
      // One question at a time: goldens tested side by side each wait for the one asked before them.
      let asking: Promise<unknown> = Promise.resolve();
      const askInTurn = (run: RunRecord, dir: string): Promise<boolean> => {
        const answer = asking.then(() => confirmGolden(run, dir));
        asking = answer.catch(() => undefined);
        return answer;
      };
      /** A golden's spec, its gate with its share of the session's risk, and how its replays run. */
      const prepare = (packDir: string) => {
        const golden = goldenName(packDir, projectDir);
        const configured = specFor(tests, packDir, projectDir);
        // Its gate with its share of the session's risk.
        const share = planned?.gates.get(golden);
        const spec = configured && share ? { ...configured, gate: share } : configured;
        const expect = rawExpectFor(tests, packDir, projectDir);
        const ctx: RecordingTestContext = {
          store,
          config,
          cwd,
          writes: flags.writes,
          guard: flags.guard,
          online: !!flags.online,
          test: { golden, session: session.sessionId },
          branch: source.branch,
          baselineBranch: source.baselineBranch,
          // The line a dashboard job reads a new run from, and a way to open each replay.
          onRun: (runId, attempt, of) => {
            current = golden;
            process.stderr.write(p.dim(`[shadowlap] replaying run ${runId} for ${golden}${of > 1 ? `, attempt ${attempt} of ${spec?.gate ? `up to ${of}` : of}` : ''}\n`));
          },
          // An attempt the agent failed while its provider couldn't answer: not counted, and run again.
          onUnavailable: (u, waitMs, counted) => process.stderr.write(p.yellow(`[shadowlap] ${golden}: ${unavailableWords(u, counted)}; running ${counted ? 'the next attempt' : 'it again'} in ${formatDuration(waitMs)}\n`)),
          stopped,
          streak,
          ...(flags.maxAttempts ? { maxAttempts: flags.maxAttempts } : {}),
          ...(flags.continue ? { continue: true } : {}),
          allowUnrecorded: allowedUnrecorded(flags.allowUnrecorded),
          // A golden from someone else's pack, which the repository doesn't track, asks first (golden-consent.ts).
          ...(flags.yes ? {} : { confirmCommand: (run: RunRecord, dir: string) => (goldenNeedsConsent(run, dir, projectDir) ? askInTurn(run, dir) : Promise.resolve(true)) }),
        };
        return { golden, spec, expect, ctx };
      };
      const prepared = new Map(packs.map((d) => [d, prepare(d)] as const));
      // Each golden's replays, run first and in turn when there are several: a golden whose replay is
      // clean is decided in the first round, one that forks over as many rounds as its gate takes.
      // Then each golden's result is taken in order, as one after another would give it.
      const replays = new Map<string, GoldenOutcome>();
      // Applied fixes whose goldens failed their last test and passed every one of them here.
      let settled: StoredFix[] = [];
      try {
        if (turns) {
          await Promise.all(
            packs.map(async (d) => {
              const g = prepared.get(d)!;
              replays.set(d, await testGolden(d, g.golden, g.spec, { ...g.ctx, turns }));
            }),
          );
        }
        for (const packDir of packs) {
          // Stopped: nothing more runs, but a golden whose replays had ended keeps its result.
          if (signal && !replays.has(packDir)) break;
          const { golden, spec, expect, ctx } = prepared.get(packDir)!;
          current = golden;
          // Every run this golden makes, for --push: its replays, and a re-recording with --update.
          const made: string[] = [];
          // Every replay counts towards the session's upstream requests, an updated golden's first one too.
          const replayed = (o: GoldenOutcome) => {
            for (const a of o.result?.attempts ?? []) {
              telemetry().record({ type: 'test', ...usageOf(a.ended, a.ms, a.code) });
              // A judge check's requests too: the session's count is everything it sent upstream.
              upstreamRequests += a.ended.summary.upstreamRequests + (a.ended.summary.judge?.upstreamRequests ?? 0);
              made.push(a.ended.summary.runId);
            }
            return o;
          };
          let outcome = replayed(replays.get(packDir) ?? (await testGolden(packDir, golden, spec, ctx)));
          if (outcome.unvouched) unvouched.add(packDir);
          // Cut short, it says nothing about the golden: no result, and nothing new after it. One stopped
          // before its first attempt started (waiting for its turn) never ran.
          if (outcome.interrupted) {
            if (outcome.result) cut.push(golden);
            continue;
          }
          // Its injection gate, once its replay passed: plant payloads in its untrusted reads, live from
          // the model call that reads them, writes stubbed, and fail it when too many attempts obey, or
          // when the gate showed too little to say (inconclusive, which --inconclusive warn lets through).
          // Null when a signal cut the gate short: then the golden has no result, as for its replay.
          const gated = async (o: GoldenOutcome): Promise<{ outcome: GoldenOutcome; injection: InjectionGateData | null } | null> => {
            if (!spec?.injection || !o.parent) return { outcome: o, injection: null };
            const allowed = { obeyed: spec.injection.obeyed, influenced: spec.injection.influenced };
            // Its replay did not pass: failed, or inconclusive, which is no failure, and says so here too.
            if (o.failure) return { outcome: o, injection: { resultId: null, attempts: 0, ...noVerdicts(), allowed, verdict: null, reason: null, skipped: `the golden ${verdictOf(o) === 'inconclusive' ? 'is inconclusive' : 'failed'}, so its injection gate did not run` } };
            if (signal) return null;
            process.stderr.write(p.dim(`[shadowlap] injection gate for ${golden}: planting payloads in its untrusted reads\n`));
            let data: InjectionGateData;
            let proof: string | null = null;
            try {
              const gate = await injectionGate({ opts, store, parent: o.parent, golden, entry: spec.injection, configDir: projectDir, cwd, sessionId: session.sessionId, actor, guard: flags.guard, allowUnrecorded: [...allowedUnrecorded(flags.allowUnrecorded)] }, (line) => process.stderr.write(`${line}\n`));
              upstreamRequests += gate.report.cost.upstreamRequests;
              if (signal) return null;
              data = gate.data;
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
          };
          const printGate = (d: InjectionGateData | null) => {
            if (d && d.verdict !== null) process.stdout.write(gateLine(d, flags.inconclusive) + '\n');
          };
          const first = await gated(outcome);
          if (!first) {
            cut.push(golden);
            continue;
          }
          outcome = first.outcome;
          let injection = first.injection;
          show(golden, outcome);
          printGate(injection);
          const forked = !outcome.failure && spec?.fork ? (outcome.result?.shown.ended.summary.divergence ?? null) : null;
          const takeover = forked ? takeoverAt(packDir) : null;
          const early = forked && takeover !== null && forked.callNo < takeover ? { at: forked.callNo, takeover } : null;

          let updated: PackResult['updated'] = null;
          // A clean replay whose judge checks the golden holds no verdict for: --update asks each live
          // and keeps its call in the golden, so every later replay is judged from the recording.
          const toKeep = flags.update && !signal ? verdictsToKeep(outcome, spec) : [];
          if (toKeep.length && outcome.parent && outcome.result) {
            const golden0 = outcome.parent;
            process.stdout.write(`    ${p.cyan('↻')} keeping ${toKeep.length === 1 ? `the verdict of ${toKeep[0]!.name}` : `${toKeep.length} judge verdicts`} in ${golden}: asking the judge live\n`);
            const k = await keepJudgeVerdicts(packDir, golden0, outcome.result.shown, toKeep, { store, config, projectDir });
            upstreamRequests += k.judge?.upstreamRequests ?? 0;
            for (const line of k.lines) process.stdout.write(`      ${safe(line)}\n`);
            if (k.reason) process.stdout.write(`    ${p.red('✗')} not kept: ${safe(k.reason)}\n`);
            else {
              updates++;
              const changes = k.kept.map((name) => `kept the verdict of ${name}`);
              const calls = callCounts(store.getCalls(golden0.runId)).total;
              process.stdout.write(`      kept in ${golden}${k.judge ? ` · ${judgeLine(k.judge)}` : ''}; review the change in your pull request\n`);
              recordEvent(store, { kind: 'golden.updated', actor, runId: golden0.runId, ref: golden, data: { session: session.sessionId, previous: golden0.runId, calls, checks: toKeep.length, changes, judged: k.kept } });
              updated = { from: golden0.runId, to: golden0.runId, calls, changes };
              const again = replayed(await testGolden(packDir, golden, spec, ctx));
              if (again.interrupted) process.stdout.write(p.dim(`    the replay of the updated golden was interrupted; it runs with the next test\n`));
              else {
                outcome = again;
                show(golden, outcome, ' (judged)');
              }
            }
          } else if (flags.update && (outcome.failure || early) && !signal) {
            if ((outcome.kind !== 'diverged' && !early) || !outcome.parent || !outcome.result) {
              process.stdout.write(p.dim(`    not updated: only a golden that diverged is re-recorded; ${outcome.kind === 'check' ? 'a failed check is fixed in the agent, not in its golden' : outcome.kind === 'inconclusive' ? (outcome.result?.gate ? 'an inconclusive gate is settled by more attempts (--max-attempts), not a new recording' : 'a check that could not be decided is settled by what it lacks (a judge that can be asked, its key; a value a condition can read), not a new recording') : outcome.kind === 'injection' ? (injection?.verdict === 'inconclusive' ? 'an inconclusive injection gate says why it showed nothing, and a new recording changes none of that' : 'an agent that obeys planted text is fixed in its prompt or code, not in its golden') : 'this one failed for another reason'}\n`));
            } else {
              const before = outcome.parent;
              const divergence = outcome.result.shown.ended.summary.divergence;
              const normalizers = outcome.normalizers;
              for (const w of volatileWarning(divergence, normalizers)) process.stdout.write(p.yellow(`    ! ${w.text}\n        ${w.command}\n`));
              const why = early ? ` it forks at #${early.at}, before its task's takeover at #${early.takeover}, so no model can be scored on it;` : '';
              process.stdout.write(`    ${p.cyan('↻')} updating ${golden}:${why} re-recording live, writes stubbed\n`);
              const u = await rerecordGolden(packDir, before, spec, {
                store,
                config,
                cwd,
                projectDir,
                // Live, as `run` records: the guard warns, unless --guard was given.
                guard: guardGiven ? flags.guard : 'warn',
                onRun: (runId) => {
                  process.stderr.write(p.dim(`[shadowlap] recording run ${runId}: ${golden} again, live, writes stubbed\n`));
                  emitJobEvent({ type: 'run', runId, role: 'new' });
                },
                stopped,
                allowUnrecorded: allowedUnrecorded(flags.allowUnrecorded),
              });
              upstreamRequests += (u.summary?.upstreamRequests ?? 0) + (u.summary?.judge?.upstreamRequests ?? 0);
              if (u.run) made.push(u.run.runId);
              if (u.checks?.length && !u.interrupted) process.stdout.write(formatChecks(u.checks).split('\n').map((l) => `      ${l}`).join('\n') + '\n');
              if (!u.replaced || !u.run) {
                process.stdout.write(`    ${p.red('✗')} not replaced: ${u.reason!}\n`);
                const tail = u.interrupted ? null : outputTail(u.output, 10);
                if (tail) process.stdout.write(p.dim(tail.split(/\r\n|\r|\n/).map((l) => `      │ ${safe(l)}`).join('\n') + '\n'));
              } else {
                updates++;
                const changes = requestChanges(store, before, u.run, divergence, normalizers);
                process.stdout.write(`      re-recorded as run ${shortId(u.run.runId)}: ${describeChange(u.before, u.after!)} · ${updateReceipt(u.summary)}\n`);
                if (changes.length) process.stdout.write(`      what changed: ${safe(changes.join(' · '))}\n`);
                process.stdout.write(`      replaced ${golden} in the working tree; review the change in your pull request\n`);
                recordEvent(store, { kind: 'golden.updated', actor, runId: u.run.runId, ref: golden, data: { session: session.sessionId, previous: before.runId, calls: u.after!.total, checks: u.checks?.length ?? 0, changes } });
                updated = { from: before.runId, to: u.run.runId, calls: u.after!.total, changes };
                // The new golden, replayed as the next test will replay it. Cut short, the result is the
                // replay that diverged, with the update it led to.
                const again = replayed(await testGolden(packDir, golden, spec, ctx));
                if (again.interrupted) process.stdout.write(p.dim(`    the replay of the updated golden was interrupted; it runs with the next test\n`));
                else {
                  // The updated golden's own injection gate, now that it replays.
                  const regated = await gated(again);
                  if (!regated) {
                    cut.push(golden);
                    continue;
                  }
                  outcome = regated.outcome;
                  injection = regated.injection;
                  show(golden, outcome, ' (updated)');
                  printGate(injection);
                }
              }
            }
          }

          for (const a of outcome.result?.attempts ?? []) emitJobEvent({ type: 'run', runId: a.ended.summary.runId, role: a.failure ? 'failing' : 'passing' });
          store.addTestResult({
            sessionId: session.sessionId,
            golden,
            ok: !outcome.failure,
            failure: outcome.kind,
            reason: outcome.failure?.message ?? null,
            runId: outcome.result?.shown.ended.summary.runId ?? null,
            goldenRunId: outcome.parent?.runId ?? null,
            revision,
            data: { ...resultData(store, outcome), ...(updated ? { updated } : {}), ...(injection ? { injection } : {}), ...ran },
          });
          const decided = inconclusiveOf(golden, outcome);
          cases.push(junitCase(outcome, decided.mode));
          results.push(packResult(outcome, { expect, updated, inconclusive: decided.mode, warned: decided.why, injection }));
          tested.set(golden, { ok: !outcome.failure, fork: !!spec?.fork });
          if (!flags.update && early) forkedEarly.push({ packDir, golden, ...early });
          const divergence = outcome.result?.shown.ended.summary.divergence;
          if (!flags.update && outcome.kind === 'diverged' && !(divergence && volatileValues(divergence, outcome.normalizers).explainsAll)) updatable.push(packDir);
          // Team store: every run this golden made, once its result is kept, with the golden it replayed.
          if (pusher && made.length) await pusher.pushRuns(store, made);
        }
        // An applied fix marked as not holding holds again once its goldens pass, as after an update
        // re-recorded what another fix changed. Never fails the session.
        try {
          settled = settleAppliedFixes(store, new Set([...tested].filter(([, t]) => t.ok).map(([g]) => g)));
        } catch (err) {
          process.stderr.write(p.yellow(`[shadowlap] applied fixes whose goldens passed were not marked: ${messageOf(err)}\n`));
        }
        // Housekeeping never fails a session whose goldens all ran: the reports below still get written.
        if (!signal) {
          const unpruned = pruneQuietly(store, session, tested);
          if (unpruned) process.stderr.write(p.yellow(`[shadowlap] ${unpruned}\n`));
        }
      } finally {
        for (const s of STOP_SIGNALS) process.off(s, onSignal);
        // Counted from the results recorded, so a session cut short by an error or a signal counts what
        // ran, each by how it came out: an inconclusive golden is neither passed nor failed, whatever CI
        // does with it, and the test history keeps how many there were with the event.
        const passed = results.filter((r) => r.verdict === 'passed').length;
        const failed = results.filter((r) => r.verdict === 'failed').length;
        const inconclusive = results.length - passed - failed;
        try {
          store.finishTestSession(session.sessionId, { passed, failed, upstreamRequests, interrupted: signal !== null });
        } catch (err) {
          process.stderr.write(p.yellow(`[shadowlap] the session's totals were not kept in the test history: ${messageOf(err)}\n`));
        }
        recordEvent(store, { kind: 'test.session', actor, ref: session.sessionId, data: { passed, failed, ...(inconclusive ? { inconclusive } : {}), goldens: results.length, revision, upstreamRequests, ...(updates ? { updated: updates } : {}), ...(signal ? { interrupted: true, notRun: packs.length - results.length } : {}) } });
        try {
          store.close();
        } catch {
          // every write above has either landed or been reported
        }
      }
      const notRun = packs.length - results.length;
      for (const c of cut) process.stdout.write(`${p.yellow('⏹')} ${safe(c)}: interrupted, so it has no result this time\n`);
      if (flags.junit) writeFileSync(flags.junit, junitXml('shadowlap', cases));
      const report = testReport(results, { id: session.sessionId, revision, interrupted: signal !== null }, planned ? suiteJson(planned.plan, planned.short.size) : null);
      if (flags.json) writeFileSync(flags.json, JSON.stringify(report, null, 2) + '\n');
      if (flags.markdown) writeFileSync(flags.markdown, markdownReport(report), { flag: 'a' });
      if (flags.annotations && (report.failed || report.inconclusive)) process.stdout.write(githubAnnotations(report) + '\n');
      if (pusher) await pusher.finish(report);
      emitJobEvent({ type: 'result', data: report });
      // A dashboard job's links: one golden (as Add normalizer and re-run tests it) to its replay; a
      // session over several to the replay of each that failed, the first few, then Tests for them all.
      const only = results.length === 1 && packs.length === 1 ? results[0]! : null;
      // One primary action: the replay of a single golden, else Tests, with the other links beside it.
      if (only?.runId) emitJobEvent({ type: 'link', label: only.ok ? 'Open the passing run' : 'Open the run', href: links.run(only.runId) });
      else for (const r of results.filter((x) => !x.ok && x.runId).slice(0, FAILED_LINKS)) emitJobEvent({ type: 'link', label: `Open ${r.name}’s run`, href: links.run(r.runId!), secondary: true });
      emitJobEvent({ type: 'link', label: 'Tests', href: links.tests(), ...(only?.runId ? { secondary: true } : {}) });
      // Inconclusive ones are counted apart, and what CI does with them is said.
      // Those inconclusive that only warn (--inconclusive warn, or too few sessions yet), and those that fail the run.
      const warned = results.filter((r) => r.verdict === 'inconclusive' && r.ok).length;
      const failing = report.inconclusive - warned;
      const inconclusive = report.inconclusive
        ? `, ${report.inconclusive} inconclusive (${[warned ? `${given === 'warn' ? 'let through: --inconclusive warn' : `${warned === report.inconclusive ? '' : `${warned} `}let through: too few sessions yet`}` : '', failing ? `${warned ? `${failing} ` : ''}failing the run: --inconclusive warn lets them through` : ''].filter(Boolean).join(', ')})`
        : '';
      const passedCount = results.filter((r) => r.verdict === 'passed').length;
      const failedCount = results.filter((r) => r.verdict === 'failed').length;
      process.stdout.write(`\n${passedCount} passed, ${failedCount} failed${inconclusive}${signal && notRun ? `, ${notRun} not run: interrupted` : ''} · ${upstreamRequests} upstream request${upstreamRequests === 1 ? '' : 's'}\n`);
      for (const fix of settled) process.stdout.write(`${p.green('✓')} ${shortFixId(fix.fixId)} holds again: its goldens passed · ${safe(fix.title)}\n`);
      // What to do about a divergence that was meant (one on values that change every run has its normalizer hint above).
      if (updatable.length) process.stdout.write(p.dim(`If the change was intended, update ${updatable.length === 1 ? 'it' : 'them'}: shadowlap test ${safe(quoteArgv(updatable))} --update\n`));
      // A golden that passes but forks before its task's takeover: Training lists its task as blocked until it is updated.
      for (const f of forkedEarly) process.stdout.write(p.dim(`${safe(f.golden)} forks at #${f.at}, before its task's takeover at #${f.takeover}, so no model can be scored on it. Update it: shadowlap test ${safe(quoteArgv([f.packDir]))} --update\n`));
      await telemetry().flush();
      // As a shell reports a command a signal stopped: 130 for Ctrl-C, 143 for SIGTERM. Then a golden
      // that failed, 1, unless the only ones that did were packs it needs --yes to run, which are a
      // usage error as `replay` makes one, 2; one that was inconclusive and not let through
      // (--inconclusive warn), 3.
      const failedHere = results.filter((r) => !r.ok && r.verdict === 'failed');
      process.exitCode = signal
        ? signalExit(signal)
        : noPack.length
          ? EXIT.usage
          : failedHere.some((r) => !unvouched.has(r.dir))
            ? EXIT.failed
            : failedHere.length
              ? EXIT.usage
              : results.some((r) => !r.ok)
                ? EXIT.inconclusive
                : EXIT.ok;
    });

  program
    .command('bisect')
    .description('Find the commit that broke a golden or a run: replay it at commits between a good one and a bad one, halving each time, each in a temporary git worktree. Replays are offline, so it costs no tokens.')
    .argument('<recording>', 'a golden (a directory written by shadowlap pack) or a run id')
    .argument('[command...]', 'the agent\'s command to run at each commit instead of the recorded one (after "--")')
    .requiredOption('--good <rev>', 'a commit where it still passed')
    .option('--bad <rev>', 'a commit where it fails', 'HEAD')
    .option('--expect <json|@file>', 'checks the replay must pass besides exiting 0 (default: the golden\'s under "tests" in shadowlap.config.json)')
    .option('--fork', 'let each replay diverge and run live from the fork (it costs tokens), so only the exit status and the checks decide: for a run that failed a check')
    .option('--build <command>', 'run in each worktree before the replay, e.g. "npm ci && npm run build"')
    .option('--cwd <dir>', 'the working directory of the recorded command, inside the repository (default: current)')
    .option('--timeout <seconds>', 'stop a replay after this long and count it as failing', parseIntArg, 300)
    .option('--guard <mode>', 'network guard: block, warn or off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'block')
    .option(ALLOW_UNRECORDED, ALLOW_UNRECORDED_HELP, collectNames)
    .option('-y, --yes', "run the recorded command of a run from a pack or the team store, or of a golden from a pack this repository doesn't track, at each commit without asking")
    .option('--json', 'print the result as JSON (progress still goes to stderr)')
    .action(async (target: string, command: string[], flags: { good: string; bad: string; expect?: string; fork?: boolean; build?: string; cwd?: string; timeout: number; guard: GuardMode; allowUnrecorded?: string[]; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      try {
        const report = await runBisect({
          opts,
          target,
          ...(command.length ? { argv: command } : {}),
          // A command someone else chose runs at every commit only with consent, as a replay of it does.
          confirm: flags.yes ? () => Promise.resolve(true) : (run, argv, golden) => (golden ? confirmGolden(run, golden, `shadowlap bisect ${golden} --good ${flags.good} --yes`) : confirmImportedCommand(run, argv, `shadowlap bisect ${shortId(run.runId)} --good ${flags.good} -- <command>`)),
          good: flags.good,
          bad: flags.bad,
          spec: flags.expect !== undefined ? readExpect(flags.expect) : undefined,
          fork: !!flags.fork,
          build: flags.build ?? null,
          cwd: resolve(flags.cwd ?? process.cwd()),
          timeoutMs: flags.timeout * 1000,
          guard: flags.guard,
          allowUnrecorded: allowedUnrecorded(flags.allowUnrecorded),
          log: (line) => process.stderr.write(`${line}\n`),
        });
        if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        else process.stdout.write(formatBisect(report, p) + '\n');
        emitJobEvent({ type: 'result', data: report });
        // Where the answer shows: above a golden's buttons on Tests, or on the run's page.
        emitJobEvent(report.target.kind === 'golden' ? { type: 'link', label: 'Open Tests', href: links.tests() } : { type: 'link', label: 'Open the run', href: links.run(report.target.runId) });
        // Found, 0; no first bad commit between the two, 1; a commit at either end that couldn't be tested, 3; cut short by a signal, its status.
        process.exitCode = report.outcome === 'found' ? EXIT.ok : report.outcome === 'untestable' ? EXIT.inconclusive : report.outcome === 'stopped' ? interruptedStatus() : EXIT.failed;
      } catch (err) {
        if (!(err instanceof BisectError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ outcome: 'error', error: { message: err.message } }, null, 2) + '\n');
        // Declined: the question, or why it couldn't be asked, is already on the terminal.
        else if (!(err instanceof BisectDeclined)) process.stderr.write(`${p.red('✗')} ${err.message}\n`);
        // What it was given can't be searched (a commit that isn't one, a run with no command), or the command needs --yes.
        process.exitCode = EXIT.usage;
      }
    });

  program
    .command('pack')
    .description('Export a run as a portable directory (run.json, calls.jsonl, blobs/) to commit or share')
    .argument('<run>', 'run id or unique prefix')
    .argument('<dir>', 'output directory')
    .option('--lineage', 'include the run\'s ancestors')
    .option('--no-redact', 'skip the redaction rules in shadowlap.config.json')
    .action(async (runArg: string, dir: string, flags: { lineage?: boolean; redact: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      const run = requireRun(store, runArg);
      requireEnded(store, run, 'pack', flags.lineage ? ancestorsOf(store, run) : []);
      const config = loadConfig(process.cwd());
      const configured = config.redact;
      const rules = flags.redact ? configured : [];
      // A golden whose checks ask a judge: each judge runs once, live, and its call goes into the
      // pack, so every replay of the golden is judged from the recording, for free.
      const judges = judgesOfPack(dir);
      const judged = judges.length ? await judgeEndedRun(store, run, judges, { config, upstreams: upstreamOverrides(process.env) }) : null;
      if (judged) printPackJudged(dir, run, judges, judged);
      const result = packRun(store, run.runId, dir, { lineage: flags.lineage === true, redact: rules });
      process.stdout.write(`packed ${result.runs.length} run${result.runs.length === 1 ? '' : 's'} (${result.calls} calls, ${result.blobs} blobs) to ${result.dir}${result.redacted ? ` with ${rules.length} redaction rule${rules.length === 1 ? '' : 's'}` : ''}\n`);
      if (!result.redacted) process.stderr.write(p.yellow(configured.length ? `  ${unredacted(configured.length, 'the pack holds everything the agent saw')}\n` : '  recordings contain everything the agent saw; add rules with `shadowlap redact add` before sharing\n'));
      // Signed reasoning stays as recorded: a fork of the pack sends it back, and the provider checks it.
      for (const s of result.signed) process.stderr.write(p.yellow(`  ! redaction rule #${s.n} (${safe(describeRule(s.rule))}) matches inside signed reasoning in ${s.calls.length === 1 ? 'call' : 'calls'} ${s.calls.map((c) => `#${c.callNo}`).join(', ')}, which the pack keeps as recorded: a fork sends it back and the provider refuses a signed block that has been changed. What it matches there leaves with the pack.\n`));
      const where = relative(process.cwd(), resolve(result.dir)).split('\\').join('/') || '.';
      // The activity log names a pack outside the project by its folder alone: a path climbing out
      // of it would put this machine's folders in a feed the whole team reads.
      const outside = where === '..' || where.startsWith('../') || isAbsolute(where);
      // A golden is a pack in a goldens folder or one the config's tests name; anything else is a pack to share.
      const golden = (!outside && /(^|\/)goldens(\/|$)/.test(where)) || isTestPack(result.dir);
      logActivity(store, { kind: golden ? 'golden.packed' : 'run.packed', runId: run.runId, ref: outside ? basename(resolve(result.dir)) : where, data: { runs: result.runs.length, calls: result.calls, redacted: result.redacted, ...(outside ? { outside: true } : {}), ...(judged ? { judged: judged.verdicts.size } : {}) } });
      emitJobEvent({ type: 'file', path: result.dir, label: 'Pack' });
      emitJobEvent({ type: 'result', data: { ...result, dir: where, ...(judged ? { judged: judgedList(judges, judged) } : {}) } });
      store.close();
      telemetry().record({ type: 'pack', calls: result.calls });
      await telemetry().flush();
    });

  program
    .command('unpack')
    .description('Import a packed recording into the store')
    .argument('<dir>', 'a directory written by shadowlap pack')
    .action((dir: string) => {
      const store = openStore(program.opts<GlobalOpts>());
      let result: ReturnType<typeof unpackRun>;
      try {
        result = unpackRun(store, dir);
      } finally {
        store.close();
      }
      for (const { runId, argv } of result.commands) process.stdout.write(`imported ${runId}  ${p.dim(`command: ${safe(quoteArgv(argv))}`)}\n`);
      for (const id of result.skipped) {
        // The store's run under that id may be another recording: it stays as it is, and is not the pack's.
        const other = result.mismatched.find((m) => m.runId === id);
        if (other) process.stdout.write(p.yellow(`skipped ${id}: the store already holds another recording under this id (${other.calls ? 'other calls' : 'another command'}), kept as it is\n`));
        else process.stdout.write(p.dim(`skipped ${id} (already present)\n`));
      }
      // A dashboard job opens what it brought in: the pack's own run, which comes after its ancestors.
      for (const runId of result.imported) emitJobEvent({ type: 'run', runId, role: 'imported' });
      emitJobEvent({ type: 'result', data: { imported: result.imported, skipped: result.skipped } });
      if (result.commands.length) {
        process.stdout.write(p.yellow(`\nReplaying an imported run executes the command it was recorded with (shown above), which came from whoever made the pack.\n`) + p.dim(`shadowlap replay asks before running it; give your own command after "--" to run that instead.\n`));
      }
    });

  program
    .command('serve')
    .description('Start a sidecar with one recording run for a process you launch yourself; prints the environment to set')
    .option('--recordings', 'no run of its own: serve recordings to a test-runner plugin (pytest, Vitest), and print its connection details as one JSON line')
    .option(ALLOW_UNRECORDED, 'with --recordings: replay these tools again for real though a recording never recorded them and they write, or nothing says what they do: names separated by commas (repeatable; SHADOWLAP_ALLOW_UNRECORDED in the test run says the same)', collectNames)
    .action(async (flags: { recordings?: boolean; allowUnrecorded?: string[] }) => {
      const opts = program.opts<GlobalOpts>();
      const store = openStore(opts);
      const config = loadConfig(process.cwd());
      if (flags.recordings) {
        await serveRecordings(store, config, opts.db, flags.allowUnrecorded ?? []);
        return;
      }
      const sidecar = await Sidecar.start({ store, normalizers: config.normalize, upstreams: upstreamOverrides(process.env), ...(config.prices ? { prices: config.prices } : {}), ...(config.clock ? { clock: config.clock } : {}), ...(config.http ? { http: config.http } : {}), ...(config.tools ? { trust: config.tools } : {}), log: (line) => process.stderr.write(p.dim(`[shadowlap] ${line}\n`)) });
      // The person starts the agent, so serve never knows its command: the run has none, as a
      // capture has none, and a replay of it asks for one after --.
      const run = sidecar.startRun({ mode: 'record', command: { argv: [EXTERNAL_COMMAND], cwd: process.cwd() }, codeVersion: codeVersion(process.cwd()), meta: newRunMeta() });
      emitJobEvent({ type: 'run', runId: run.runId, role: 'new' });
      const env = sidecar.envFor(run.runId);
      process.stdout.write(envLines(env) + '\n');
      process.stderr.write(p.dim(`[shadowlap] recording run ${run.runId}; Ctrl-C to end it\n`));
      // Recorded until a stop signal: Ctrl-C, a supervisor's stop, or the terminal closing.
      await new Promise<void>((resolve) => {
        const stop = () => resolve();
        for (const s of STOP_SIGNALS) process.once(s, stop);
      });
      const { summary } = sidecar.endRun(run.runId, 'completed');
      printOutcome(summary);
      await sidecar.close();
      store.close();
      await pushIfQueued(teamEnv(opts.db));
    });
}
