import { writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { formatTokens, hasRecordedCommand, packRun, Store, unpackRun, type WritePolicy } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { specFor, type CheckResult } from '../checks.js';
import { codeVersion, loadConfig, loadTests, upstreamOverrides } from '../config.js';
import { junitXml, type JunitCase } from '../junit.js';
import { RecordingHost } from '../recordings.js';
import { captureConfig, placeholderAwsCredentials, providerIds, testAttempt, type GuardMode, type TestAttempt } from '../run-agent.js';
import { openStore, parseChoice, printOutcome, requireRun, telemetry, usageOf, VERSION, type GlobalOpts, type RunSummaryLike } from '../shared.js';
import { prepareTestPush, pushIfQueued, teamEnv } from '../team.js';
import { githubAnnotations, markdownReport, testReport, type PackResult } from '../test-report.js';
import { palette as p, quoteArgv, safe } from '../ui.js';

/** Recordings as tests: `shadowlap test` for packed goldens in CI, packs, and the host that the pytest and Vitest plugins start. */

function formatChecks(checks: CheckResult[]): string {
  return checks.map((c) => (c.ok ? `✓ ${c.label}` : `✗ ${c.label}: ${c.detail}`)).join('\n');
}

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
  // Team store: recordings someone pushed while they were running go to the store now that they have ended.
  await pushIfQueued(teamEnv(db));
}

export function register(program: Command): void {
  program.commandsGroup('Test:');

  program
    .command('test')
    .description('Replay packed recordings offline and fail on any divergence or failed check (CI). Each pack re-runs its recorded command; checks come from "tests" in shadowlap.config.json.')
    .argument('<pack...>', 'directories written by shadowlap pack')
    .option('--junit <file>', 'write a JUnit XML report')
    .option('--json <file>', 'write a JSON report (results per pack, for other tools)')
    .option('--markdown <file>', 'append a Markdown report to this file, e.g. $GITHUB_STEP_SUMMARY')
    .option('--annotations', 'print GitHub Actions error annotations for packs that fail')
    .option('--online', 'allow live calls after a divergence (default: offline, a live call fails the test)')
    .option('--writes <policy>', 'write tools after divergence: block | stub | allow', parseChoice<WritePolicy>(['block', 'stub', 'allow']), 'block')
    .option('--cwd <dir>', 'working directory for the recorded commands (default: current)')
    .option('--guard <mode>', 'network guard: block (default in CI), warn or off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'block')
    .option('--push', "push every test run and the report to the team store, with this machine's (or the CI job's) own credentials; a pull request's job pushes to its own folder")
    .action(async (packs: string[], flags: { junit?: string; json?: string; markdown?: string; annotations?: boolean; online?: boolean; writes: WritePolicy; cwd?: string; guard: GuardMode; push?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const config = loadConfig(process.cwd());
      const tests = loadTests(process.cwd());
      // Team store: no store or no credentials is a warning; the tests still decide the exit code.
      const pusher = flags.push ? await prepareTestPush(teamEnv(opts.db), { ...(flags.annotations ? { annotations: true } : {}) }) : null;
      const cwd = resolve(flags.cwd ?? process.cwd());
      const cases: JunitCase[] = [];
      const results: PackResult[] = [];
      let failed = 0;
      for (const packDir of packs) {
        const started = Date.now();
        const name = basename(resolve(packDir));
        const spec = specFor(tests, packDir, process.cwd());
        // An ephemeral store per pack: CI never accumulates recordings locally.
        const store = opts.db ? openStore(opts) : Store.open(':memory:');
        let output = '';
        let failure: JunitCase['failure'];
        let packSummary: RunSummaryLike | null = null;
        let checks: CheckResult[] | null = null;
        let attemptCounts: PackResult['attempts'] = null;
        try {
          const { imported, skipped } = unpackRun(store, packDir);
          const parentId = imported[imported.length - 1] ?? skipped[skipped.length - 1];
          if (!parentId) throw new Error('the pack contains no runs');
          const parent = store.getRun(parentId)!;
          // A golden has to be able to start its agent. One packed straight from a capture cannot, and
          // spawning its placeholder would fail for a reason the report would not name.
          if (!hasRecordedCommand(parent)) {
            throw new Error('this recording was imported from a capture and has no command to run. Replay it once with your agent (shadowlap replay <run> -- <command>) and pack that run: it records everything, and has a command of its own');
          }
          // A recording marked `fork` may diverge on purpose; from the fork on it needs the real providers.
          const live = !!flags.online || !!spec?.fork;
          const upstreams = live ? upstreamOverrides(process.env) : Object.fromEntries([...Object.keys(providerIds()), 'http'].map((id) => [id, 'offline']));
          const extraEnv = live ? {} : placeholderAwsCredentials(process.env, store.getCalls(parent.runId));
          const attempts: TestAttempt[] = [];
          for (let i = 0; i < (spec?.repeat ?? 1); i++) {
            const attempt = await testAttempt(store, parent, { cwd, upstreams, extraEnv, writes: flags.writes, guard: flags.guard, normalizers: config.normalize, prices: config.prices, clock: config.clock, http: config.http, spec });
            telemetry().record({ type: 'test', ...usageOf(attempt.ended, attempt.ms, attempt.code) });
            attempts.push(attempt);
          }
          if (pusher) await pusher.pushRuns(store, attempts.map((a) => a.ended.summary.runId));
          const passed = attempts.filter((a) => !a.failure).length;
          const required = spec?.passes ?? 1;
          const shown = passed >= required ? attempts.filter((a) => !a.failure).at(-1)! : attempts.find((a) => a.failure)!;
          output = shown.output;
          packSummary = shown.ended.summary;
          checks = shown.checks;
          if (attempts.length > 1) attemptCounts = { total: attempts.length, passed, required };
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
          const summary = shown.ended.summary;
          if (failure) {
            process.stdout.write(`${p.red('✗')} ${name}: ${failure.message}\n`);
          } else {
            const parts = [
              summary.divergence ? `forked at call ${summary.divergence.callNo}, ${summary.byOrigin.replayed}/${summary.total} replayed` : `${summary.byOrigin.replayed}/${summary.total} replayed`,
              `${formatTokens(summary.tokensNotRespent.inputTokens)} input tokens not re-spent`,
              ...(checks?.length ? [`${checks.length} check${checks.length === 1 ? '' : 's'} passed`] : []),
              ...(attempts.length > 1 ? [`${passed}/${attempts.length} attempts passed`] : []),
            ];
            process.stdout.write(`${p.green('✓')} ${name}: ${parts.join(', ')}\n`);
          }
          if (failure) {
            failed++;
            if (checks?.length) process.stdout.write(formatChecks(checks).split('\n').map((l) => '    ' + l).join('\n') + '\n');
            process.stdout.write(failure.details.split('\n').map((l) => '    ' + l).join('\n') + '\n');
            if (output.trim()) process.stdout.write(p.dim(output.trim().split('\n').slice(-20).map((l) => '    │ ' + l).join('\n')) + '\n');
          }
        } catch (err) {
          failed++;
          const message = err instanceof Error ? err.message : String(err);
          failure = { message, details: message };
          process.stdout.write(`${p.red('✗')} ${name}: ${message}\n`);
        } finally {
          store.close();
        }
        const junitFailure = failure && checks?.length ? { ...failure, details: `${formatChecks(checks)}\n\n${failure.details}` } : failure;
        cases.push({ name, classname: 'shadowlap.replay', timeSeconds: (Date.now() - started) / 1000, ...(junitFailure ? { failure: junitFailure } : {}), ...(output ? { systemOut: output } : {}) });
        const s = packSummary;
        results.push({
          name,
          dir: packDir,
          ok: !failure,
          message: failure?.message ?? null,
          details: failure?.details ?? null,
          output: failure && output.trim() ? output.trim().split('\n').slice(-20).join('\n') : null,
          seconds: (Date.now() - started) / 1000,
          calls: s ? { total: s.total, replayed: s.byOrigin.replayed + s.byOrigin.overridden, live: s.byOrigin.live, blocked: s.byOrigin.blocked, stubbed: s.byOrigin.stubbed } : null,
          upstreamRequests: s ? s.upstreamRequests : null,
          tokensNotRespent: s ? s.tokensNotRespent.inputTokens + (s.tokensNotRespent.cacheReadInputTokens ?? 0) : null,
          divergence: s?.divergence ? { type: s.divergence.type, callNo: s.divergence.callNo, kind: s.divergence.kind, name: s.divergence.name } : null,
          checks,
          attempts: attemptCounts,
        });
      }
      if (flags.junit) writeFileSync(flags.junit, junitXml('shadowlap', cases));
      const report = testReport(results);
      if (flags.json) writeFileSync(flags.json, JSON.stringify(report, null, 2) + '\n');
      if (flags.markdown) writeFileSync(flags.markdown, markdownReport(report), { flag: 'a' });
      if (flags.annotations && report.failed) process.stdout.write(githubAnnotations(report) + '\n');
      if (pusher) await pusher.finish(report);
      process.stdout.write(`\n${cases.length - failed} passed, ${failed} failed\n`);
      await telemetry().flush();
      process.exitCode = failed ? 1 : 0;
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
        await serveRecordings(store, config, opts.db);
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
      await pushIfQueued(teamEnv(opts.db));
    });

}
