import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { links } from '@shadowlap/dashboard';
import { formatDuration, hasRecordedCommand, parsePresets, recordEvent, resolveAuthor, Store, withoutCommand, type ChaosPreset, type RunRecord, type WritePolicy } from '@shadowlap/engine';
import { STOP_SIGNALS } from './agent-signals.js';
import { chaosFor, DEFAULT_CHAOS, type ChaosSpec } from './chaos-config.js';
import { chaosJunit, chaosMarkdown, chaosReport, chaosTotals, formatPresets, judgedOnExit, runPresets, type ChaosRecordingResult, type PresetOutcome } from './chaos.js';
import { parseExpect, specFor, type TestSpec } from './checks.js';
import { codeVersion, defaultDbPath, loadConfig, loadTests } from './config.js';
import { goldenConsented, notRunMessage } from './golden-consent.js';
import { importGolden } from './golden-test.js';
import { expandRecordings, goldenName, readPackHead, testsKeyFor } from './goldens.js';
import { EXIT, inconclusiveStatus, signalExit } from './exit-codes.js';
import { emitJobEvent } from './job-events.js';
import { junitXml } from './junit.js';
import { unavailableWords } from './provider-retry.js';
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
  /** The tools `--allow-unrecorded` lets a preset run again though the recording never recorded them and they write. */
  allowUnrecorded?: ReadonlySet<string>;
  /** Run a golden from someone else's pack, which the repository doesn't track, without asking (golden-consent.ts). */
  yes?: boolean;
}

/** What the presets asked for on the command line change in a recording's own: which ones, and the tool they hit. */
function withFlags(chaos: ChaosSpec, flags: ChaosFlags): ChaosSpec {
  return { ...chaos, ...(flags.presets ? { presets: parsePresets(flags.presets) } : {}), ...(flags.chaosTool ? { tool: flags.chaosTool } : {}) };
}

interface Session {
  store: Store;
  id: string;
  actor: string | null;
  revision: string | null;
  presets: ChaosPreset[];
  stopped: () => boolean;
  signal: () => NodeJS.Signals | null;
  done: () => void;
}

/** Starts a session in the store, and listens for Ctrl-C: the attempt running then is cut short, and nothing after it runs. */
function startSession(store: Store, command: string[], presets: ChaosPreset[], cwd: string): Session {
  const revision = codeVersion(cwd);
  const actor = resolveAuthor({ cwd: process.cwd() });
  const session = store.startChaosSession({ command, presets, revision, actor });
  let signal = null as NodeJS.Signals | null;
  const onSignal = (sig: NodeJS.Signals) => {
    if (signal) return;
    signal = sig;
    process.stderr.write(p.yellow('\n[shadowlap] interrupted: the attempt running now stops, no preset after it runs, and the session keeps what finished\n'));
  };
  for (const s of STOP_SIGNALS) process.on(s, onSignal);
  return {
    store,
    id: session.sessionId,
    actor,
    revision,
    presets,
    stopped: () => signal !== null,
    signal: () => signal,
    done: () => {
      for (const s of STOP_SIGNALS) process.off(s, onSignal);
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
  // The activity feed's line: on one run, that run; on goldens, how many.
  const ran = results.filter((r) => r.runId);
  const one = ran.length === 1 && !ran[0]!.golden ? ran[0]!.runId : null;
  recordEvent(s.store, { kind: 'chaos.session', actor: s.actor, ref: s.id, ...(one ? { runId: one } : {}), data: { passed: report.passed, failed: report.failed, inconclusive: report.inconclusive, notApplicable: report.notApplicable, goldens: results.filter((r) => r.golden).length, revision: s.revision, ...(interrupted ? { interrupted: true } : {}) } });
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
  // A signal, its status; a preset that failed or a golden that couldn't run, 1; a golden from a pack
  // it needs --yes to run, when nothing else failed, 2, as `test` ends; an inconclusive preset not
  // let through, 3.
  const failed = report.failed > 0 || results.some((r) => r.error && !r.unvouched);
  const sig = s.signal();
  process.exitCode = sig ? signalExit(sig) : failed ? EXIT.failed : results.some((r) => r.unvouched) ? EXIT.usage : report.inconclusive > 0 ? inconclusiveStatus(flags.inconclusive) : EXIT.ok;
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
        chaos = chaosFor(projectDir, testsKeyFor(tests, resolve(packDir), projectDir), parseExpect);
      } catch (err) {
        process.stdout.write(`${p.red('✗')} ${safe(golden)}: ${safe((err as Error).message)}\n`);
        results.push({ golden, runId: null, outcomes: [], judge: null, error: (err as Error).message, skipped: null });
        continue;
      }
      if (chaos === false) {
        process.stdout.write(p.dim(`– ${safe(golden)}: skipped, its tests entry turns the presets off ("chaos": false)\n`));
        results.push({ golden, runId: null, outcomes: [], judge: null, error: null, skipped: 'its tests entry turns the presets off ("chaos": false)' });
        continue;
      }
      let parent: RunRecord;
      let unvouched = false;
      try {
        parent = importGolden(store, packDir);
        if (!hasRecordedCommand(parent)) throw new Error(`this recording ${withoutCommand(parent)} and has no command to run. Replay it once with your agent (shadowlap replay <run> -- <command>) and pack that run`);
        // Its presets run its recorded command: from someone else's pack the repository doesn't track, only after a yes.
        const again = `shadowlap test ${packDir} --chaos --yes`;
        if (!(await goldenConsented(parent, packDir, projectDir, flags.yes, again))) {
          unvouched = true;
          throw new Error(notRunMessage(packDir, again));
        }
      } catch (err) {
        process.stdout.write(`${p.red('✗')} ${safe(golden)}: ${safe((err as Error).message)}\n`);
        results.push({ golden, runId: null, outcomes: [], judge: null, error: (err as Error).message, skipped: null, ...(unvouched ? { unvouched: true as const } : {}) });
        continue;
      }
      // A redacted pack replays with its rules as normalizers, as `test` replays it.
      const head = readPackHead(packDir);
      const packed = 'error' in head || JSON.stringify(parent.meta?.redactions ?? []) === JSON.stringify(head.redactions) ? [] : head.redactions;
      const { outcomes, judge } = await runPresets(parent, spec, withFlags(chaos, flags), {
        store,
        config: { ...config, normalize: [...config.normalize, ...packed] },
        cwd,
        writes: flags.writes ?? 'stub',
        guard: flags.guard,
        session: session.id,
        golden,
        onRun: (runId, preset, attempt) => process.stderr.write(ATTEMPT_LINE(runId, golden, preset, attempt)),
        onUnavailable: (u, waitMs, counted) => process.stderr.write(p.yellow(`[shadowlap] ${golden}: ${unavailableWords(u, counted)}; running ${counted ? 'the next attempt' : 'it again'} in ${formatDuration(waitMs)}\n`)),
        stopped: session.stopped,
        ...(flags.allowUnrecorded ? { allowUnrecorded: flags.allowUnrecorded } : {}),
      });
      if (outcomes.length) process.stdout.write(`${formatPresets(golden, outcomes, p, judge)}\n`);
      if (judge.source === 'exit' && outcomes.some((o) => o.attempts > 0)) process.stdout.write(p.dim(`${judgedOnExit('chaos.expect')}\n`));
      results.push({ golden, runId: parent.runId, outcomes, judge, error: null, skipped: null });
    }
  } finally {
    const only = results.length === 1 ? results[0]! : null;
    await endSession(session, results, flags, [...(only?.runId ? [{ label: 'Open the recording', href: links.run(only.runId) }] : []), { label: 'Tests', href: links.tests(), ...(only?.runId ? { secondary: true } : {}) }]);
  }
}

/**
 * `shadowlap replay <run> --chaos`: every preset on one run, judged by `--expect`, or by its golden's
 * `chaos.expect` or write limits. Asked for by name, a golden's run runs its presets even when its
 * tests entry leaves it out of `test --chaos` (`"chaos": false`), with the defaults.
 */
export async function replayChaos(opts: GlobalOpts, parent: RunRecord, checks: { spec: TestSpec; source: string } | null, flags: ChaosFlags, command: string[], argv?: string[]): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);
  // The run's own presets when it is a golden's recording, the defaults otherwise; --expect judges them when given.
  const chaos: ChaosSpec | false = checks && checks.source !== '--expect' ? chaosFor(projectDir, testsKeyFor(loadTests(projectDir), resolve(checks.source), projectDir), parseExpect) : DEFAULT_CHAOS;
  const own = chaos === false ? DEFAULT_CHAOS : chaos;
  const spec = withFlags(checks?.source === '--expect' ? { ...own, expect: checks.spec, expectFrom: '--expect' as const } : own, flags);
  const store = opts.db ? Store.open(opts.db) : Store.open(defaultDbPath(projectDir));
  const session = startSession(store, command, spec.presets, projectDir);
  const results: ChaosRecordingResult[] = [];
  try {
    const { outcomes, judge } = await runPresets(parent, checks?.source === '--expect' ? null : (checks?.spec ?? null), spec, {
      store,
      config,
      cwd: projectDir,
      writes: flags.writes ?? 'stub',
      guard: flags.guard,
      session: session.id,
      ...(argv?.length ? { argv } : {}),
      onRun: (runId, preset, attempt) => process.stderr.write(ATTEMPT_LINE(runId, shortId(parent.runId), preset, attempt)),
      onUnavailable: (u, waitMs, counted) => process.stderr.write(p.yellow(`[shadowlap] run ${shortId(parent.runId)}: ${unavailableWords(u, counted)}; running ${counted ? 'the next attempt' : 'it again'} in ${formatDuration(waitMs)}\n`)),
      stopped: session.stopped,
      ...(flags.allowUnrecorded ? { allowUnrecorded: flags.allowUnrecorded } : {}),
    });
    if (outcomes.length) process.stdout.write(`${formatPresets(`run ${shortId(parent.runId)}`, outcomes, p, judge)}\n`);
    if (judge.source === 'exit' && outcomes.some((o) => o.attempts > 0)) process.stdout.write(p.dim(`${judgedOnExit('--expect')}\n`));
    results.push({ golden: null, runId: parent.runId, outcomes, judge, error: null, skipped: null });
  } finally {
    await endSession(session, results, flags, [{ label: 'Open the run', href: links.run(parent.runId) }]);
  }
}

export type { PresetOutcome };
