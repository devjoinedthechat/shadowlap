import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { formatTokens, packRun, recordEvent, resolveAuthor, Store, unpackRun, type WritePolicy } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { BisectError, formatBisect, runBisect } from '../bisect.js';
import { specFor } from '../checks.js';
import { codeVersion, defaultDbPath, loadConfig, loadTests, upstreamOverrides } from '../config.js';
import { readExpect } from './fix.js';
import { formatChecks, junitCase, outputTail, packResult, resultData, testGolden, type GoldenOutcome, type RecordingTestContext } from '../golden-test.js';
import { describeChange, rerecordGolden, updateReceipt, volatileWarning } from '../golden-update.js';
import { expandRecordings, goldenName, rawExpectFor } from '../goldens.js';
import { emitJobEvent } from '../job-events.js';
import { junitXml, type JunitCase } from '../junit.js';
import { RecordingHost } from '../recordings.js';
import { captureConfig, type GuardMode } from '../run-agent.js';
import { openStore, parseChoice, parseIntArg, printOutcome, requireRun, telemetry, usageOf, VERSION, type GlobalOpts } from '../shared.js';
import { githubAnnotations, markdownReport, testReport, type PackResult } from '../test-report.js';
import { palette as p, quoteArgv, safe, shortId } from '../ui.js';

/** Recordings as tests: `shadowlap test` for packed goldens in CI, `bisect`, packs, and the host that the pytest and Vitest plugins start. */

/**
 * `shadowlap serve --recordings`: the host a test-runner plugin starts once per worker process.
 * It prints how to reach it (base URLs per slot, with `__SLOT__` for the plugin to fill in, and the
 * in-process capture module) and runs until its stdin closes, which is when the test runner exits.
 */
async function serveRecordings(store: Store, config: ReturnType<typeof loadConfig>): Promise<void> {
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
      env: { ...sidecar.envForSlot('__SLOT__'), SHADOWLAP_CAPTURE: process.env.SHADOWLAP_CAPTURE === 'off' ? 'off' : captureConfig(upstreams, sidecar.httpRules) },
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

/** The one-line result of a golden that passed: `30/30 replayed, 12k input tokens not re-spent, 2 checks passed`. */
function passedLine(o: GoldenOutcome): string {
  const r = o.result!;
  const s = r.shown.ended.summary;
  return [
    s.divergence ? `forked at call ${s.divergence.callNo}, ${s.byOrigin.replayed}/${s.total} replayed` : `${s.byOrigin.replayed}/${s.total} replayed`,
    `${formatTokens(s.tokensNotRespent.inputTokens)} input tokens not re-spent`,
    ...(r.shown.checks?.length ? [`${r.shown.checks.length} check${r.shown.checks.length === 1 ? '' : 's'} passed`] : []),
    ...(r.attempts.length > 1 ? [`${r.passed}/${r.attempts.length} attempts passed`] : []),
  ].join(', ');
}

function printGolden(o: GoldenOutcome, suffix = ''): void {
  if (!o.failure) {
    process.stdout.write(`${p.green('✓')} ${o.name}: ${passedLine(o)}${suffix}\n`);
    return;
  }
  process.stdout.write(`${p.red('✗')} ${o.name}: ${o.failure.message}\n`);
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
    .option('--update', 're-record each golden that diverged, live with writes stubbed, and replace it in the working tree when its checks pass')
    .option('--online', 'allow live calls after a divergence (default: offline, a live call fails the test)')
    .option('--writes <policy>', 'write tools after divergence: block | stub | allow', parseChoice<WritePolicy>(['block', 'stub', 'allow']), 'block')
    .option('--cwd <dir>', 'working directory for the recorded commands (default: current)')
    .option('--guard <mode>', 'network guard: block (default in CI), warn or off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'block')
    .action(async (packArgs: string[], flags: { junit?: string; json?: string; markdown?: string; annotations?: boolean; update?: boolean; online?: boolean; writes: WritePolicy; cwd?: string; guard: GuardMode }) => {
      const opts = program.opts<GlobalOpts>();
      const projectDir = process.cwd();
      const config = loadConfig(projectDir);
      const tests = loadTests(projectDir);
      const cwd = resolve(flags.cwd ?? projectDir);
      const { dirs: packs, unmatched } = expandRecordings(packArgs, projectDir);
      if (unmatched.length) {
        throw new InvalidArgumentError(`no recordings match ${unmatched.join(' ')}: a recording is a directory written by shadowlap pack, with a run.json inside`);
      }

      const store = openTestStore(opts, projectDir);
      const actor = resolveAuthor({ cwd: projectDir });
      const revision = codeVersion(cwd);
      const session = store.startTestSession({ command: givenCommand(process.argv, 'test'), revision, actor });
      const cases: JunitCase[] = [];
      const results: PackResult[] = [];
      let failed = 0;
      let upstreamRequests = 0;
      let updates = 0;
      try {
        for (const packDir of packs) {
          const golden = goldenName(packDir, projectDir);
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
            onRun: (runId, attempt, of) => process.stderr.write(p.dim(`[shadowlap] replaying run ${runId} for ${golden}${of > 1 ? `, attempt ${attempt} of ${of}` : ''}\n`)),
          };
          // Every replay counts towards the session's upstream requests, an updated golden's first one too.
          const replayed = (o: GoldenOutcome) => {
            for (const a of o.result?.attempts ?? []) {
              telemetry().record({ type: 'test', ...usageOf(a.ended, a.ms, a.code) });
              upstreamRequests += a.ended.summary.upstreamRequests;
            }
            return o;
          };
          let outcome = replayed(await testGolden(packDir, golden, spec, ctx));
          printGolden(outcome);

          let updated: PackResult['updated'] = null;
          if (flags.update && outcome.failure) {
            if (outcome.kind !== 'diverged' || !outcome.parent || !outcome.result) {
              process.stdout.write(p.dim(`    not updated: only a golden that diverged is re-recorded; ${outcome.kind === 'check' ? 'a failed check is fixed in the agent, not in its golden' : 'this one failed for another reason'}\n`));
            } else {
              const before = outcome.parent;
              for (const w of volatileWarning(outcome.result.shown.ended.summary.divergence)) process.stdout.write(p.yellow(`    ! ${w.text}\n        ${w.command}\n`));
              process.stdout.write(`    ${p.cyan('↻')} updating ${golden}: re-recording live, writes stubbed\n`);
              const u = await rerecordGolden(packDir, before, spec, {
                store,
                config,
                cwd,
                guard: 'warn',
                onRun: (runId) => {
                  process.stderr.write(p.dim(`[shadowlap] recording run ${runId}: ${golden} again, live, writes stubbed\n`));
                  emitJobEvent({ type: 'run', runId, role: 'new' });
                },
              });
              upstreamRequests += u.summary?.upstreamRequests ?? 0;
              if (u.checks?.length) process.stdout.write(formatChecks(u.checks).split('\n').map((l) => `      ${l}`).join('\n') + '\n');
              if (!u.replaced || !u.run) {
                process.stdout.write(`    ${p.red('✗')} not replaced: ${u.reason}\n`);
                const tail = outputTail(u.output, 10);
                if (tail) process.stdout.write(p.dim(tail.split('\n').map((l) => `      │ ${l}`).join('\n') + '\n'));
              } else {
                updates++;
                process.stdout.write(`      re-recorded as run ${shortId(u.run.runId)}: ${describeChange(u.before, u.after!)} · ${updateReceipt(u.summary)}\n`);
                process.stdout.write(`      replaced ${golden} in the working tree; review the change in your pull request\n`);
                recordEvent(store, { kind: 'golden.updated', actor, runId: u.run.runId, ref: golden, data: { session: session.sessionId, previous: before.runId, calls: u.after!.total, checks: u.checks?.length ?? 0 } });
                updated = { from: before.runId, to: u.run.runId, calls: u.after!.total };
                // The new golden, replayed as the next test will replay it.
                outcome = replayed(await testGolden(packDir, golden, spec, ctx));
                printGolden(outcome, ' (updated)');
              }
            }
          }

          if (outcome.failure) failed++;
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
          cases.push(junitCase(outcome));
          results.push(packResult(outcome, { expect, updated }));
        }
      } finally {
        const passed = packs.length - failed;
        store.finishTestSession(session.sessionId, { passed, failed, upstreamRequests });
        recordEvent(store, { kind: 'test.session', actor, ref: session.sessionId, data: { passed, failed, goldens: packs.length, revision, upstreamRequests, ...(updates ? { updated: updates } : {}) } });
        store.close();
      }
      if (flags.junit) writeFileSync(flags.junit, junitXml('shadowlap', cases));
      const report = testReport(results, { id: session.sessionId, revision });
      if (flags.json) writeFileSync(flags.json, JSON.stringify(report, null, 2) + '\n');
      if (flags.markdown) writeFileSync(flags.markdown, markdownReport(report), { flag: 'a' });
      if (flags.annotations && report.failed) process.stdout.write(githubAnnotations(report) + '\n');
      emitJobEvent({ type: 'result', data: report });
      emitJobEvent({ type: 'link', label: 'Tests', href: '#/tests' });
      process.stdout.write(`\n${report.passed} passed, ${report.failed} failed · ${upstreamRequests} upstream request${upstreamRequests === 1 ? '' : 's'}\n`);
      await telemetry().flush();
      process.exitCode = report.failed ? 1 : 0;
    });

  program
    .command('bisect')
    .description('Find the commit that broke a golden or a run: replay it at commits between a good one and a bad one, halving each time, each in a temporary git worktree. Replays are offline, so it costs no tokens.')
    .argument('<recording>', 'a golden (a directory written by shadowlap pack) or a run id')
    .requiredOption('--good <rev>', 'a commit where it still passed')
    .option('--bad <rev>', 'a commit where it fails (default: HEAD)', 'HEAD')
    .option('--expect <json|@file>', 'checks the replay must pass besides exiting 0 (default: the golden\'s under "tests" in shadowlap.config.json)')
    .option('--fork', 'let each replay diverge and run live from the fork (it costs tokens), so only the exit status and the checks decide: for a run that failed a check')
    .option('--build <command>', 'run in each worktree before the replay, e.g. "npm ci && npm run build"')
    .option('--cwd <dir>', 'the working directory of the recorded command, inside the repository (default: current)')
    .option('--timeout <seconds>', 'stop a replay after this long and count it as failing', parseIntArg, 300)
    .option('--guard <mode>', 'network guard: block, warn or off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'block')
    .option('--json', 'print the result as JSON (progress still goes to stderr)')
    .action(async (target: string, flags: { good: string; bad: string; expect?: string; fork?: boolean; build?: string; cwd?: string; timeout: number; guard: GuardMode; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      try {
        const report = await runBisect({
          opts,
          target,
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
        process.exitCode = report.outcome === 'found' ? 0 : 1;
      } catch (err) {
        if (!(err instanceof BisectError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ outcome: 'error', error: { message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`${p.red('✗')} ${err.message}\n`);
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
      const store = openStore(program.opts<GlobalOpts>());
      const run = requireRun(store, runArg);
      const rules = flags.redact ? loadConfig(process.cwd()).redact : [];
      const result = packRun(store, run.runId, dir, { lineage: flags.lineage === true, redact: rules });
      process.stdout.write(`packed ${result.runs.length} run${result.runs.length === 1 ? '' : 's'} (${result.calls} calls, ${result.blobs} blobs) to ${result.dir}${result.redacted ? ` with ${rules.length} redaction rule${rules.length === 1 ? '' : 's'}` : ''}\n`);
      if (!result.redacted) process.stderr.write(p.yellow('  recordings contain everything the agent saw; add rules with `shadowlap redact add` before sharing\n'));
      recordEvent(store, { kind: 'golden.packed', actor: resolveAuthor({ cwd: process.cwd() }), runId: run.runId, ref: goldenName(dir, process.cwd()), data: { calls: result.calls, redacted: result.redacted ? rules.length : 0 } });
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
      for (const id of result.skipped) process.stdout.write(p.dim(`skipped ${id} (already present)\n`));
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
        await serveRecordings(store, config);
        return;
      }
      const sidecar = await Sidecar.start({ store, normalizers: config.normalize, upstreams: upstreamOverrides(process.env), ...(config.prices ? { prices: config.prices } : {}), ...(config.clock ? { clock: config.clock } : {}), ...(config.http ? { http: config.http } : {}), log: (line) => process.stderr.write(p.dim(`[shadowlap] ${line}\n`)) });
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['<external>'], cwd: process.cwd() }, codeVersion: codeVersion(process.cwd()) });
      const env = sidecar.envFor(run.runId);
      process.stdout.write(Object.entries(env).map(([k, v]) => `export ${k}=${v}`).join('\n') + '\n');
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
    });
}
