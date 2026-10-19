import { writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { EXTERNAL_COMMAND, endedEarlyCount, formatTally, formatTokens, GATE_MAX_ATTEMPTS, judgeLine, judgeParts, packRun, recordEvent, resolveAuthor, settleAppliedFixes, statusTally, Store, unpackRun, volatileValues, type RunRecord, type StoredFix, type WritePolicy } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { logActivity, stampAuthor } from '../activity.js';
import { BisectDeclined, BisectError, formatBisect, runBisect } from '../bisect.js';
import { checkLine, judgeResults, specFor, type JudgeCheck, type TestSpec } from '../checks.js';
import { codeVersion, defaultDbPath, loadConfig, loadTests, upstreamOverrides } from '../config.js';
import { readExpect } from './fix.js';
import { shortFixId } from '../fix-format.js';
import { formatChecks, junitCase, outputTail, packResult, pruneQuietly, resultData, testGolden, verdictOf, type GoldenOutcome, type InconclusiveMode, type RecordingTestContext } from '../golden-test.js';
import { callCounts, describeChange, keepJudgeVerdicts, requestChanges, rerecordGolden, updateReceipt, volatileWarning } from '../golden-update.js';
import { expandRecordings, goldenName, rawExpectFor } from '../goldens.js';
import { cannotJudge, judgedOptions, judgeEndedRun, judgesOf, type JudgedRun } from '../judge.js';
import { emitJobEvent } from '../job-events.js';
import { junitXml, type JunitCase } from '../junit.js';
import { RecordingHost } from '../recordings.js';
import { captureConfig, noProxyEnv, type GuardMode } from '../run-agent.js';
import { ancestorsOf, confirmImportedCommand, openStore, parseChoice, parseIntArg, printOutcome, readStore, requireEnded, requireRun, telemetry, unredacted, usageOf, VERSION, type GlobalOpts } from '../shared.js';
import { prepareTestPush, pushIfQueued, teamEnv } from '../team.js';
import { takeoverReader } from '../tasks.js';
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
async function serveRecordings(store: Store, config: ReturnType<typeof loadConfig>, db: string | undefined): Promise<void> {
  const root = process.cwd();
  const upstreams = upstreamOverrides(process.env);
  const host = new RecordingHost(store, root, { codeVersion: codeVersion(root), redact: config.redact });
  const sidecar = await Sidecar.start({ store, normalizers: config.normalize, upstreams, api: host.api, ...(config.prices ? { prices: config.prices } : {}), ...(config.clock ? { clock: config.clock } : {}), ...(config.http ? { http: config.http } : {}) });
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
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
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
    process.stderr.write(p.yellow(`[shadowlap] the checks for ${dir} could not be read, so no judge was asked: ${(err as Error).message}\n`));
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
    process.stderr.write(p.yellow(`[shadowlap] ${path} could not be opened (${(err as Error).message}); this session's history is not kept\n`));
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

/** The one-line result of a golden that passed: `30/30 replayed, 12k input tokens not re-spent, 2 checks passed`. */
function passedLine(o: GoldenOutcome): string {
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
    `${formatTokens(s.tokensNotRespent.inputTokens)} input tokens not re-spent`,
    ...(r.shown.checks?.length ? [statusTally(r.shown.checks)] : []),
    ...(r.attempts.length > 1 && !r.gate ? [`${r.passed}/${r.attempts.length} attempts passed`] : []),
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
    // A gate's verdict leads, in its one sentence, with the evidence under it.
    if (gate) process.stdout.write(`${p.green('✓')} ${o.name}: ${gate.sentence}${suffix}\n${p.dim(`    ${formatTally(gate)} · ${passedLine(o)}`)}\n`);
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
  const tail = outputTail(o.result.shown.output);
  if (tail) process.stdout.write(p.dim(indent(tail, '    │ ')));
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
    .option('--inconclusive <mode>', "what an inconclusive verdict does, a gate's or a check's: fail the run, or warn and let it through", parseChoice<InconclusiveMode>(['fail', 'warn']), 'fail')
    .option('--max-attempts <n>', "raise each gate's limit for this session: its max, the most attempts it runs", parseIntArg)
    .option('--continue', "carry an inconclusive gate's attempts over from the golden's last result, when its recording, checks and gate are unchanged, and run only the attempts still needed (with --max-attempts, the higher limit to run to)")
    .action(async function (this: Command, packArgs: string[], flags: { junit?: string; json?: string; markdown?: string; annotations?: boolean; update?: boolean; online?: boolean; writes: WritePolicy; cwd?: string; guard: GuardMode; push?: boolean; inconclusive: InconclusiveMode; maxAttempts?: number; continue?: boolean }) {
      const opts = program.opts<GlobalOpts>();
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
      // Team store: no store or no credentials is a warning; the tests still decide the exit code.
      const pusher = flags.push ? await prepareTestPush(teamEnv(opts.db), { ...(flags.annotations ? { annotations: true } : {}) }) : null;

      const store = openTestStore(opts, projectDir);
      const actor = resolveAuthor({ cwd: projectDir });
      const revision = codeVersion(cwd);
      const session = store.startTestSession({ command: givenCommand(process.argv, 'test'), revision, actor });
      const cases: JunitCase[] = [];
      const results: PackResult[] = [];
      let upstreamRequests = 0;
      let updates = 0;
      const tested = new Map<string, { ok: boolean; fork: boolean }>();
      // Goldens that diverged in a way an update would fix: not only on values that change every run.
      const updatable: string[] = [];
      // A golden that may fork and forked before its task's takeover passes, but no model can be scored
      // on it (a model takes over only where the recording still replays): --update re-records it too.
      const takeoverAt = takeoverReader(projectDir, store);
      const forkedEarly: Array<{ packDir: string; golden: string; at: number; takeover: number }> = [];
      // Ctrl-C, or a dashboard job being stopped: the replay running now is cut short (its agent, and
      // whatever the agent started, get the signal), the goldens after it don't run, and the session
      // ends with the results of the ones that finished.
      let signal = null as NodeJS.Signals | null;
      let current = null as string | null;
      const onSignal = (sig: NodeJS.Signals) => {
        if (signal) return;
        signal = sig;
        process.stderr.write(p.yellow(`\n[shadowlap] interrupted: ${current ? `stopping ${current}, ` : ''}no golden after it runs, and the session keeps what finished\n`));
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      const stopped = () => signal !== null;
      let cut = null as string | null;
      // Applied fixes whose goldens failed their last test and passed every one of them here.
      let settled: StoredFix[] = [];
      try {
        for (const packDir of packs) {
          if (signal) break;
          const golden = goldenName(packDir, projectDir);
          current = golden;
          const spec = specFor(tests, packDir, projectDir);
          const expect = rawExpectFor(tests, packDir, projectDir);
          const ctx: RecordingTestContext = {
            store,
            config,
            cwd,
            writes: flags.writes,
            guard: flags.guard,
            online: !!flags.online,
            test: { golden, session: session.sessionId },
            // The line a dashboard job reads a new run from, and a way to open each replay.
            onRun: (runId, attempt, of) => process.stderr.write(p.dim(`[shadowlap] replaying run ${runId} for ${golden}${of > 1 ? `, attempt ${attempt} of ${spec?.gate ? `up to ${of}` : of}` : ''}\n`)),
            stopped,
            ...(flags.maxAttempts ? { maxAttempts: flags.maxAttempts } : {}),
            ...(flags.continue ? { continue: true } : {}),
          };
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
          let outcome = replayed(await testGolden(packDir, golden, spec, ctx));
          // Cut short, it says nothing about the golden: no result, and nothing after it.
          if (outcome.interrupted) {
            cut = golden;
            break;
          }
          printGolden(outcome);
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
                printGolden(outcome, ' (judged)');
              }
            }
          } else if (flags.update && (outcome.failure || early) && !signal) {
            if ((outcome.kind !== 'diverged' && !early) || !outcome.parent || !outcome.result) {
              process.stdout.write(p.dim(`    not updated: only a golden that diverged is re-recorded; ${outcome.kind === 'check' ? 'a failed check is fixed in the agent, not in its golden' : outcome.kind === 'inconclusive' ? (outcome.result?.gate ? 'an inconclusive gate is settled by more attempts (--max-attempts), not a new recording' : 'a check that could not be decided is settled by what it lacks (a judge that can be asked, its key; a value a condition can read), not a new recording') : 'this one failed for another reason'}\n`));
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
              });
              upstreamRequests += (u.summary?.upstreamRequests ?? 0) + (u.summary?.judge?.upstreamRequests ?? 0);
              if (u.run) made.push(u.run.runId);
              if (u.checks?.length && !u.interrupted) process.stdout.write(formatChecks(u.checks).split('\n').map((l) => `      ${l}`).join('\n') + '\n');
              if (!u.replaced || !u.run) {
                process.stdout.write(`    ${p.red('✗')} not replaced: ${u.reason}\n`);
                const tail = u.interrupted ? null : outputTail(u.output, 10);
                if (tail) process.stdout.write(p.dim(tail.split('\n').map((l) => `      │ ${l}`).join('\n') + '\n'));
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
                  outcome = again;
                  printGolden(outcome, ' (updated)');
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
            data: { ...resultData(store, outcome), ...(updated ? { updated } : {}) },
          });
          cases.push(junitCase(outcome, flags.inconclusive));
          results.push(packResult(outcome, { expect, updated, inconclusive: flags.inconclusive }));
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
          process.stderr.write(p.yellow(`[shadowlap] applied fixes whose goldens passed were not marked: ${(err as Error).message}\n`));
        }
        // Housekeeping never fails a session whose goldens all ran: the reports below still get written.
        if (!signal) {
          const unpruned = pruneQuietly(store, session, tested);
          if (unpruned) process.stderr.write(p.yellow(`[shadowlap] ${unpruned}\n`));
        }
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        // Counted from the results recorded, so a session cut short by an error or a signal counts what
        // ran, each by how it came out: an inconclusive golden is neither passed nor failed, whatever CI
        // does with it, and the test history keeps how many there were with the event.
        const passed = results.filter((r) => r.verdict === 'passed').length;
        const failed = results.filter((r) => r.verdict === 'failed').length;
        const inconclusive = results.length - passed - failed;
        try {
          store.finishTestSession(session.sessionId, { passed, failed, upstreamRequests, interrupted: signal !== null });
        } catch (err) {
          process.stderr.write(p.yellow(`[shadowlap] the session's totals were not kept in the test history: ${(err as Error).message}\n`));
        }
        recordEvent(store, { kind: 'test.session', actor, ref: session.sessionId, data: { passed, failed, ...(inconclusive ? { inconclusive } : {}), goldens: results.length, revision, upstreamRequests, ...(updates ? { updated: updates } : {}), ...(signal ? { interrupted: true, notRun: packs.length - results.length } : {}) } });
        try {
          store.close();
        } catch {
          // every write above has either landed or been reported
        }
      }
      const notRun = packs.length - results.length;
      if (cut) process.stdout.write(`${p.yellow('⏹')} ${safe(cut)}: interrupted, so it has no result this time\n`);
      if (flags.junit) writeFileSync(flags.junit, junitXml('shadowlap', cases));
      const report = testReport(results, { id: session.sessionId, revision, interrupted: signal !== null });
      if (flags.json) writeFileSync(flags.json, JSON.stringify(report, null, 2) + '\n');
      if (flags.markdown) writeFileSync(flags.markdown, markdownReport(report), { flag: 'a' });
      if (flags.annotations && (report.failed || report.inconclusive)) process.stdout.write(githubAnnotations(report) + '\n');
      if (pusher) await pusher.finish(report);
      emitJobEvent({ type: 'result', data: report });
      // A dashboard job's links: one golden (as Add normalizer and re-run tests it) to its replay; a
      // session over several to the replay of each that failed, the first few, then Tests for them all.
      const only = results.length === 1 && packs.length === 1 ? results[0]! : null;
      // One primary action: the replay of a single golden, else Tests, with the other links beside it.
      if (only?.runId) emitJobEvent({ type: 'link', label: only.ok ? 'Open the passing run' : 'Open the run', href: `#/run/${only.runId}` });
      else for (const r of results.filter((x) => !x.ok && x.runId).slice(0, FAILED_LINKS)) emitJobEvent({ type: 'link', label: `Open ${r.name}’s run`, href: `#/run/${r.runId}`, secondary: true });
      emitJobEvent({ type: 'link', label: 'Tests', href: '#/tests', ...(only?.runId ? { secondary: true } : {}) });
      // Inconclusive ones are counted apart, and what CI does with them is said.
      const inconclusive = report.inconclusive ? `, ${report.inconclusive} inconclusive (${flags.inconclusive === 'warn' ? 'let through: --inconclusive warn' : 'failing the run: --inconclusive warn lets them through'})` : '';
      const passedCount = results.filter((r) => r.verdict === 'passed').length;
      const failedCount = results.filter((r) => r.verdict === 'failed').length;
      process.stdout.write(`\n${passedCount} passed, ${failedCount} failed${inconclusive}${signal && notRun ? `, ${notRun} not run: interrupted` : ''} · ${upstreamRequests} upstream request${upstreamRequests === 1 ? '' : 's'}\n`);
      for (const fix of settled) process.stdout.write(`${p.green('✓')} ${shortFixId(fix.fixId)} holds again: its goldens passed · ${safe(fix.title)}\n`);
      // What to do about a divergence that was meant (one on values that change every run has its normalizer hint above).
      if (updatable.length) process.stdout.write(p.dim(`If the change was intended, update ${updatable.length === 1 ? 'it' : 'them'}: shadowlap test ${safe(quoteArgv(updatable))} --update\n`));
      // A golden that passes but forks before its task's takeover: Training lists its task as blocked until it is updated.
      for (const f of forkedEarly) process.stdout.write(p.dim(`${safe(f.golden)} forks at #${f.at}, before its task's takeover at #${f.takeover}, so no model can be scored on it. Update it: shadowlap test ${safe(quoteArgv([f.packDir]))} --update\n`));
      await telemetry().flush();
      // As a shell reports a command a signal stopped: 130 for Ctrl-C, 143 for SIGTERM.
      process.exitCode = signal ? (signal === 'SIGINT' ? 130 : 143) : report.failed ? 1 : 0;
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
    .option('-y, --yes', 'run the recorded command of a run from a pack or the team store at each commit without asking')
    .option('--json', 'print the result as JSON (progress still goes to stderr)')
    .action(async (target: string, command: string[], flags: { good: string; bad: string; expect?: string; fork?: boolean; build?: string; cwd?: string; timeout: number; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      try {
        const report = await runBisect({
          opts,
          target,
          ...(command.length ? { argv: command } : {}),
          // A command someone else chose runs at every commit only with consent, as a replay of it does.
          confirm: flags.yes ? async () => true : (run, argv) => confirmImportedCommand(run, argv, `shadowlap bisect ${shortId(run.runId)} --good ${flags.good} -- <command>`),
          good: flags.good,
          bad: flags.bad,
          spec: flags.expect !== undefined ? readExpect(flags.expect) : undefined,
          fork: !!flags.fork,
          build: flags.build ?? null,
          cwd: resolve(flags.cwd ?? process.cwd()),
          timeoutMs: flags.timeout * 1000,
          guard: flags.guard,
          log: (line) => process.stderr.write(`${line}\n`),
        });
        if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        else process.stdout.write(formatBisect(report, p) + '\n');
        emitJobEvent({ type: 'result', data: report });
        // Where the answer shows: above a golden's buttons on Tests, or on the run's page.
        emitJobEvent(report.target.kind === 'golden' ? { type: 'link', label: 'Open Tests', href: '#/tests' } : { type: 'link', label: 'Open the run', href: `#/run/${report.target.runId}` });
        process.exitCode = report.outcome === 'found' ? 0 : 1;
      } catch (err) {
        if (!(err instanceof BisectError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ outcome: 'error', error: { message: err.message } }, null, 2) + '\n');
        // Declined: the question, or why it couldn't be asked, is already on the terminal.
        else if (!(err instanceof BisectDeclined)) process.stderr.write(`${p.red('✗')} ${err.message}\n`);
        process.exitCode = 1;
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
    .action(async (flags: { recordings?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const store = openStore(opts);
      const config = loadConfig(process.cwd());
      if (flags.recordings) {
        await serveRecordings(store, config, opts.db);
        return;
      }
      const sidecar = await Sidecar.start({ store, normalizers: config.normalize, upstreams: upstreamOverrides(process.env), ...(config.prices ? { prices: config.prices } : {}), ...(config.clock ? { clock: config.clock } : {}), ...(config.http ? { http: config.http } : {}), log: (line) => process.stderr.write(p.dim(`[shadowlap] ${line}\n`)) });
      // The person starts the agent, so serve never knows its command: the run has none, as a
      // capture has none, and a replay of it asks for one after --.
      const run = sidecar.startRun({ mode: 'record', command: { argv: [EXTERNAL_COMMAND], cwd: process.cwd() }, codeVersion: codeVersion(process.cwd()) });
      stampAuthor(store, run.runId);
      emitJobEvent({ type: 'run', runId: run.runId, role: 'new' });
      const env = sidecar.envFor(run.runId);
      process.stdout.write(envLines(env) + '\n');
      process.stderr.write(p.dim(`[shadowlap] recording run ${run.runId}; Ctrl-C to end it\n`));
      await new Promise<void>((resolve) => {
        const stop = () => resolve();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      const { summary } = sidecar.endRun(run.runId, 'completed');
      printOutcome(summary);
      await sidecar.close();
      store.close();
      await pushIfQueued(teamEnv(opts.db));
    });
}
