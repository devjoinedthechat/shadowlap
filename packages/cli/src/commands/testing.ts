import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { links } from '@shadowlap/dashboard';
import { describeRule, EXTERNAL_COMMAND, messageOf, judgeParts, packRun, Store, unpackRun, type RunRecord, type WritePolicy } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { logActivity, newRunMeta } from '../activity.js';
import { STOP_SIGNALS } from '../agent-signals.js';
import { BisectDeclined, BisectError, formatBisect, runBisect } from '../bisect.js';
import { checkLine, judgeResults, specFor, type JudgeCheck } from '../checks.js';
import { codeVersion, loadConfig, loadTests, upstreamOverrides } from '../config.js';
import { EXIT, interruptedStatus } from '../exit-codes.js';
import { ALLOW_UNRECORDED, ALLOW_UNRECORDED_HELP, allowedUnrecorded } from '../unrecorded.js';
import { confirmGolden } from '../golden-consent.js';
import { readExpect } from './fix-flags.js';
import { parseSuiteRisk, testPacks, type TestFlags } from './test-session.js';
import type { InconclusiveMode } from '../golden-test.js';
import { cannotJudge, judgedOptions, judgeEndedRun, judgesOf, type JudgedRun } from '../judge.js';
import { emitJobEvent } from '../job-events.js';
import { RecordingHost } from '../recordings.js';
import { captureConfig, noProxyEnv, type GuardMode } from '../run-agent.js';
import { ancestorsOf, collect, confirmImportedCommand, openStore, parseChoice, parseIntArg, printOutcome, readStore, requireEnded, requireRun, telemetry, unredacted, VERSION, type GlobalOpts } from '../shared.js';
import { pushIfQueued, teamEnv } from '../team.js';
import { palette as p, quoteArgv, safe, shortId } from '../ui.js';

/** Recordings as tests: `shadowlap test` for packed goldens in CI, `bisect`, packs, and the host that the pytest and Vitest plugins start. */

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

/**
 * The environment `serve` prints, as the shell it is pasted into sets it: `export K=V` lines for a
 * POSIX shell, and on Windows PowerShell's `$env:K = 'V'`, which its terminals open by default.
 */
export function envLines(env: Record<string, string>, platform: NodeJS.Platform = process.platform): string {
  const lines = Object.entries(env).map(([k, v]) => (platform === 'win32' ? `$env:${k} = '${v.replace(/'/g, "''")}'` : `export ${k}=${v}`));
  return lines.join('\n');
}


/** `shadowlap test`, with its flags. */
function testCommand(program: Command): void {
  program
    .command('test')
    .description('Replay packed recordings offline and fail on any divergence or failed check (CI). Each pack re-runs its recorded command; checks come from "tests" in shadowlap.config.json. Each session is kept in the project\'s store as test history.')
    .argument('<pack...>', 'directories written by shadowlap pack; a * in the last part matches several, as in goldens/*')
    .option('--junit <file>', 'write a JUnit XML report')
    .option('--json <file>', 'write a JSON report (results per pack, with each replay\'s run id, for other tools)')
    .option('--markdown <file>', 'append a Markdown report to this file, e.g. $GITHUB_STEP_SUMMARY')
    .option('--annotations', 'print a GitHub Actions annotation for each pack that did not pass: an error, or a warning for an inconclusive one let through')
    .option('--update', 're-record each golden that diverged, live with writes stubbed, and replace it in the working tree when its checks pass; a golden that replayed clean gets the judge verdicts it lacks asked live and kept')
    .option('--reason <why>', 'with --update: why the change is meant, kept beside each golden it replaces (accepted.jsonl) and shown when a later change takes out what this one put in')
    .option('--online', 'allow live calls after a divergence (default: offline, a live call fails the test)')
    .option('--writes <policy>', 'write tools after divergence: block | stub | allow', parseChoice<WritePolicy>(['block', 'stub', 'allow']), 'block')
    .option('--cwd <dir>', 'working directory for the recorded commands (default: current)')
    .option('--guard <mode>', 'network guard: block, warn or off (re-recording under --update, warn unless given)', parseChoice<GuardMode>(['warn', 'block', 'off']), 'block')
    .option('--push', "push every test run and the report to the team store, with this machine's (or the CI job's) own credentials; a pull request's job pushes to its own folder")
    .option('--inconclusive <mode>', "what an inconclusive verdict does, a gate's, a check's, an injection gate's or, with --chaos, a preset's: fail the run, or warn and let it through; with neither given, a gate against history whose golden has fewer than 30 sessions (three of its windows) only warns, unless the plan reads its last sessions below the ones before them, a decline at 99 to 1 or a drop: then it counts", parseChoice<InconclusiveMode>(['fail', 'warn']), 'fail')
    .option('--max-attempts <n>', "raise each gate's limit for this session: its max, the most attempts it runs", parseIntArg)
    .option('--suite-risk <r>', 'the most a healthy suite may go red for nothing, split across its gated goldens (default: tests.suiteRisk in the config, else 0.05)', parseSuiteRisk)
    .option('--continue', "carry an inconclusive gate's attempts over from the golden's last result, when its recording, checks and gate are unchanged, and run only the attempts still needed (with --max-attempts, the higher limit to run to)")
    // Error-path presets: each golden forked where a tool or the provider fails, instead of the session above.
    .option('--chaos', "run the error-path presets instead: each golden forked at one call with a tool timeout, an empty result, malformed JSON, an oversized result, a provider 429 and a 500, live from the call it hits (writes stubbed unless --writes says otherwise), each judged by its tests entry's chaos.expect, else the upper bounds its expect sets on write tools")
    .option('--presets <list>', 'with --chaos: the presets to run, comma-separated: timeout, empty, malformed, oversized, 429, 500 (default: all, or the tests entry\'s "chaos.presets")')
    .option('--chaos-tool <name>', 'with --chaos: the tool whose first call the tool presets hit (default: the first tool call that reads the world)')
    .option(ALLOW_UNRECORDED, 'run these tools again for real though a golden never recorded them and they write, or nothing says what they do: names separated by commas (repeatable)', collect)
    .option('-y, --yes', "run the recorded command of a golden from someone else's pack that this repository doesn't track, without asking (without it, such a golden asks first, and without a terminal isn't run)")
    .action(async function (this: Command, packArgs: string[], flags: TestFlags) {
      await testPacks(this, program.opts<GlobalOpts>(), packArgs, flags);
    });
}

export function register(program: Command): void {
  program.commandsGroup('Test:');

  testCommand(program);

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
    .option(ALLOW_UNRECORDED, ALLOW_UNRECORDED_HELP, collect)
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
        emitJobEvent(report.target.kind === 'golden' ? { type: 'link', label: 'Open Tests', href: links.tests() } : { type: 'link', label: 'Open run', href: links.run(report.target.runId) });
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
    .option(ALLOW_UNRECORDED, 'with --recordings: replay these tools again for real though a recording never recorded them and they write, or nothing says what they do: names separated by commas (repeatable; SHADOWLAP_ALLOW_UNRECORDED in the test run says the same)', collect)
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
