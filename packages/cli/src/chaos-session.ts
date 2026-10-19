import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasRecordedCommand, parsePresets, resolveAuthor, Store, withoutCommand, type ChaosPreset, type RunRecord, type WritePolicy } from '@shadowlap/engine';
import { chaosFor, DEFAULT_CHAOS, type ChaosSpec } from './chaos-config.js';
import { chaosJunit, chaosMarkdown, chaosReport, chaosTotals, formatPresets, runPresets, type ChaosRecordingResult, type PresetOutcome } from './chaos.js';
import { parseExpect, specFor, type TestSpec } from './checks.js';
import { codeVersion, configPath, defaultDbPath, loadConfig, loadTests } from './config.js';
import { importGolden } from './golden-test.js';
import { expandRecordings, goldenName, readPackHead, testsKeyFor } from './goldens.js';
import { emitJobEvent } from './job-events.js';
import { junitXml } from './junit.js';
import { type GuardMode } from './run-agent.js';
import { telemetry, type GlobalOpts } from './shared.js';
import { palette as p, safe, shortId } from './ui.js';

/**
 * A session of error-path presets: `test <pack...> --chaos` runs them on each golden, `replay <run>
 * --chaos` on one run. Each preset is a fork with live calls from the call it hits, so, like a golden
 * that forks, it needs the providers. The session and every result are kept in the store; the exit
 * status is 1 when a preset failed, or came out inconclusive under `--inconclusive fail`.
 */

export interface ChaosFlags {
  presets?: string;
  chaosTool?: string;
  writes?: WritePolicy;
  guard: GuardMode;
  inconclusive: 'fail' | 'warn';
  json?: string;
  junit?: string;
  markdown?: string;
  cwd?: string;
}

/** What the presets asked for on the command line change in a recording's own: which ones, and the tool they hit. */
function withFlags(chaos: ChaosSpec, flags: ChaosFlags): ChaosSpec {
  return { ...chaos, ...(flags.presets ? { presets: parsePresets(flags.presets) } : {}), ...(flags.chaosTool ? { tool: flags.chaosTool } : {}) };
}

interface Session {
  store: Store;
  id: string;
  revision: string | null;
  presets: ChaosPreset[];
  stopped: () => boolean;
  signal: () => NodeJS.Signals | null;
  done: () => void;
}

/** Starts a session in the store, and listens for Ctrl-C: the attempt running then is cut short, and nothing after it runs. */
function startSession(store: Store, command: string[], presets: ChaosPreset[], cwd: string): Session {
  const revision = codeVersion(cwd);
  const session = store.startChaosSession({ command, presets, revision, actor: resolveAuthor({ cwd: process.cwd() }) });
  let signal = null as NodeJS.Signals | null;
  const onSignal = (sig: NodeJS.Signals) => {
    if (signal) return;
    signal = sig;
    process.stderr.write(p.yellow('\n[shadowlap] interrupted: the attempt running now stops, no preset after it runs, and the session keeps what finished\n'));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    store,
    id: session.sessionId,
    revision,
    presets,
    stopped: () => signal !== null,
    signal: () => signal,
    done: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

/** Ends the session: totals kept, reports written, the dashboard's job told, the exit status set. */
async function endSession(s: Session, results: ChaosRecordingResult[], flags: ChaosFlags, links: Array<{ label: string; href: string; secondary?: boolean }>): Promise<void> {
  s.done();
  const interrupted = s.signal() !== null;
  const report = chaosReport(results, { session: s.id, revision: s.revision, presets: s.presets, interrupted });
  const all = results.flatMap((r) => r.outcomes);
  const upstream = all.reduce((n, o) => n + o.upstreamRequests, 0);
  const spent = all.reduce((n, o) => n + o.spent, 0);
  try {
    s.store.finishChaosSession(s.id, { passed: report.passed, failed: report.failed, inconclusive: report.inconclusive, upstreamRequests: upstream, interrupted });
  } catch (err) {
    process.stderr.write(p.yellow(`[shadowlap] the session's totals were not kept: ${(err as Error).message}\n`));
  }
  try {
    s.store.close();
  } catch {
    // every result has landed or been reported
  }
  if (flags.json) writeFileSync(flags.json, JSON.stringify(report, null, 2) + '\n');
  if (flags.junit) writeFileSync(flags.junit, junitXml('shadowlap error-path presets', chaosJunit(results, { inconclusive: flags.inconclusive })));
  if (flags.markdown) writeFileSync(flags.markdown, chaosMarkdown(report), { flag: 'a' });
  emitJobEvent({ type: 'result', data: report });
  for (const l of links) emitJobEvent({ type: 'link', ...l });
  process.stdout.write(`\n${chaosTotals(report, upstream, spent)}${interrupted ? ' · interrupted' : ''}\n`);
  if (report.inconclusive && flags.inconclusive === 'warn') process.stdout.write(p.dim(`${report.inconclusive} inconclusive: reported, not failed (--inconclusive warn)\n`));
  await telemetry().flush();
  const failed = report.failed > 0 || results.some((r) => r.error) || (flags.inconclusive === 'fail' && report.inconclusive > 0);
  const sig = s.signal();
  process.exitCode = sig ? (sig === 'SIGINT' ? 130 : 143) : failed ? 1 : 0;
}

const ATTEMPT_LINE = (runId: string, what: string, preset: string, attempt: number) => p.dim(`[shadowlap] replaying run ${runId} for ${what}: ${preset}${attempt > 1 ? `, attempt ${attempt}` : ''}\n`);

/** `shadowlap test <pack...> --chaos`: every preset on every golden, each golden's presets as a table. */
export async function testChaos(opts: GlobalOpts, packArgs: string[], flags: ChaosFlags, command: string[]): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);
  const tests = loadTests(projectDir);
  const cwd = resolve(flags.cwd ?? projectDir);
  const { dirs: packs, unmatched } = expandRecordings(packArgs, projectDir);
  if (unmatched.length) throw new Error(`no recordings match ${unmatched.join(' ')}: a recording is a directory written by shadowlap pack, with a run.json inside`);
  const asked = flags.presets ? parsePresets(flags.presets) : DEFAULT_CHAOS.presets;
  const store = opts.db ? Store.open(opts.db) : Store.open(defaultDbPath(projectDir));
  const session = startSession(store, command, asked, cwd);
  const results: ChaosRecordingResult[] = [];
  try {
    for (const packDir of packs) {
      if (session.stopped()) break;
      const golden = goldenName(packDir, projectDir);
      let chaos: ChaosSpec | false;
      let spec: TestSpec | null;
      try {
        spec = specFor(tests, packDir, projectDir);
        chaos = chaosFor(configPath(projectDir), testsKeyFor(tests, resolve(packDir), projectDir), parseExpect);
      } catch (err) {
        results.push({ golden, runId: null, outcomes: [], error: (err as Error).message, skipped: null });
        continue;
      }
      if (chaos === false) {
        process.stdout.write(p.dim(`– ${safe(golden)}: skipped, its tests entry turns the presets off ("chaos": false)\n`));
        results.push({ golden, runId: null, outcomes: [], error: null, skipped: 'its tests entry turns the presets off ("chaos": false)' });
        continue;
      }
      let parent: RunRecord;
      try {
        parent = importGolden(store, packDir);
        if (!hasRecordedCommand(parent)) throw new Error(`this recording ${withoutCommand(parent)} and has no command to run. Replay it once with your agent (shadowlap replay <run> -- <command>) and pack that run`);
      } catch (err) {
        process.stdout.write(`${p.red('✗')} ${safe(golden)}: ${safe((err as Error).message)}\n`);
        results.push({ golden, runId: null, outcomes: [], error: (err as Error).message, skipped: null });
        continue;
      }
      // A redacted pack replays with its rules as normalizers, as `test` replays it.
      const head = readPackHead(packDir);
      const packed = 'error' in head || JSON.stringify(parent.meta?.redactions ?? []) === JSON.stringify(head.redactions) ? [] : head.redactions;
      const { outcomes } = await runPresets(parent, spec, withFlags(chaos, flags), {
        store,
        config: { ...config, normalize: [...config.normalize, ...packed] },
        cwd,
        writes: flags.writes ?? 'stub',
        guard: flags.guard,
        session: session.id,
        golden,
        onRun: (runId, preset, attempt) => process.stderr.write(ATTEMPT_LINE(runId, golden, preset, attempt)),
        stopped: session.stopped,
      });
      if (outcomes.length) process.stdout.write(`${formatPresets(golden, outcomes, p)}\n`);
      results.push({ golden, runId: parent.runId, outcomes, error: null, skipped: null });
    }
  } finally {
    const only = results.length === 1 ? results[0]! : null;
    await endSession(session, results, flags, [...(only?.runId ? [{ label: 'Open the recording', href: `#/run/${only.runId}` }] : []), { label: 'Tests', href: '#/tests', ...(only?.runId ? { secondary: true } : {}) }]);
  }
}

/** `shadowlap replay <run> --chaos`: every preset on one run, judged by its checks (`--expect`, or its golden's). */
export async function replayChaos(opts: GlobalOpts, parent: RunRecord, checks: { spec: TestSpec; source: string } | null, flags: ChaosFlags, command: string[], argv?: string[]): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);
  // The run's own presets when it is a golden's recording, the defaults otherwise; --expect judges them when given.
  let chaos: ChaosSpec | false = DEFAULT_CHAOS;
  if (checks && checks.source !== '--expect') {
    try {
      chaos = chaosFor(configPath(projectDir), testsKeyFor(loadTests(projectDir), resolve(checks.source), projectDir), parseExpect);
    } catch {
      chaos = DEFAULT_CHAOS;
    }
  }
  const own = chaos === false ? DEFAULT_CHAOS : chaos;
  const spec = withFlags(checks?.source === '--expect' ? { ...own, expect: checks.spec } : own, flags);
  const store = opts.db ? Store.open(opts.db) : Store.open(defaultDbPath(projectDir));
  const session = startSession(store, command, spec.presets, projectDir);
  const results: ChaosRecordingResult[] = [];
  try {
    const { outcomes } = await runPresets(parent, checks?.source === '--expect' ? null : (checks?.spec ?? null), spec, {
      store,
      config,
      cwd: projectDir,
      writes: flags.writes ?? 'stub',
      guard: flags.guard,
      session: session.id,
      ...(argv?.length ? { argv } : {}),
      onRun: (runId, preset, attempt) => process.stderr.write(ATTEMPT_LINE(runId, shortId(parent.runId), preset, attempt)),
      stopped: session.stopped,
    });
    if (outcomes.length) process.stdout.write(`${formatPresets(`run ${shortId(parent.runId)}`, outcomes, p)}\n`);
    if (!spec.expect && outcomes.some((o) => o.attempts > 0)) process.stdout.write(p.dim('Each preset was judged on the agent exiting 0: no checks say what an error path must do. Give them with --expect, such as --expect \'{"tools":{"issue_refund":"<= 1"}}\'.\n'));
    results.push({ golden: null, runId: parent.runId, outcomes, error: null, skipped: null });
  } finally {
    await endSession(session, results, flags, [{ label: 'Open the run', href: `#/run/${parent.runId}` }]);
  }
}

export type { PresetOutcome };
