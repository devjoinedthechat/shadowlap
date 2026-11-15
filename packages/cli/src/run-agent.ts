import { spawn } from 'node:child_process';
import { existsSync, fstatSync, readFileSync, statSync, type BigIntStats } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { links } from '@shadowlap/dashboard';
import { Store, type StoreOf, divergenceLine, formatDivergence, formatDuration, formatSummary, isJudgeCall, kindLabel, parseJsonExact, parseToolFailure, quoteArgv, unmaskedHints, valueHints, type CallRecord, type ReplayOptions, type RunMeta, type RunRecord, type RunStatus, type TestFailure, type ToolFailure, type WritePolicy } from '@shadowlap/engine';
import { activeProviders, httpRuleMatcher, providers, Sidecar, type HttpRule, type Interventions } from '@shadowlap/sidecar';
import { clearActiveRun, markActiveRun } from './active-run.js';
import { newRunMeta } from './activity.js';
import { AGENT_NODE_MAYBE_TOO_OLD, AGENT_NODE_TOO_OLD, namesNode, nodeRefusesPreload, refusedPreload } from './agent-node.js';
import { spawnAgent } from './agent-registry.js';
import { AgentStop, exitBySignal, exitStatus, GROUPS, sharedGroup, STOP_SIGNALS, trackAgent } from './agent-signals.js';
import { evaluateChecks, storedCheckInput, type CheckResult, type TestSpec } from './checks.js';
import { guardAccept, loadConfig, readCodeVersion, upstreamOverrides } from './config.js';
import { askJudges, judgedOptions, judgesOf, materialOf, notAsked, unjudged, type Judged } from './judge.js';
import { emitJobEvent } from './job-events.js';
import { killTree } from './kill-tree.js';
import { type JunitCase } from './junit.js';
import { proxyFolder } from './mcp-proxies.js';
import { guardOutcome, openStore, telemetry, usageOf, type GlobalOpts } from './shared.js';
import { noteUnrecordedTools } from './not-recorded.js';
import { keyEnvPatch } from './placeholder-keys.js';
import { pushIfQueued, teamEnv } from './team.js';
import { palette as p, shortId } from './ui.js';
import { refuseUnrecorded } from './unrecorded.js';

/** Running an agent command under a sidecar: its environment (base URLs, capture, the network guard), interventions, repeated attempts, and the offline replays of `shadowlap test` and `calibrate`. */

export function providerIds(): Record<string, true> {
  return Object.fromEntries(providers.map((pr) => [pr.id, true as const]));
}

export type GuardMode = 'warn' | 'block' | 'off';

/**
 * Environment that preloads the network guard into the agent process: Node through NODE_OPTIONS
 * --import, Python through a sitecustomize on PYTHONPATH. Both are no-ops for other runtimes.
 */
/**
 * Where in-process capture sends requests: each provider's API hosts, plus the host of every
 * configured upstream (a local model server, a mock), so a client with a hardcoded base URL is
 * recorded too. JSON, read by the Node and Python preloads.
 */
export function captureConfig(upstreams: Record<string, string>, http: readonly HttpRule[] = []): string {
  // The built-in providers and the hosts the config declares (`providers`), as every sidecar serves them.
  const routes = activeProviders()
    .filter((pr) => !(pr.format && pr.id.includes(':')))
    .map((pr) => [pr.hosts.source, pr.id]);
  const hosts: Record<string, string> = {};
  for (const [id, value] of Object.entries(upstreams)) {
    try {
      const u = new URL(value);
      if (u.protocol === 'http:' || u.protocol === 'https:') hosts[`${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`] = id;
    } catch {
      // "offline" and other non-URLs
    }
  }
  // A declared host with a port is taken there, over http too: its own server, as the agent names it.
  for (const pr of activeProviders()) if (pr.format && /^[^*]+:\d+$/.test(pr.id)) hosts[pr.id] ??= pr.id;
  // HTTP hosts recorded as tools: [hostname regex, port or null], any scheme.
  return JSON.stringify({ routes, hosts, http: http.map(httpRuleMatcher) });
}

/**
 * Which input this process was given (`dev:ino` of fd 0), so the preloads record what a person
 * types on it and on nothing else: an agent's own pipe to a child process is not user input.
 */
function stdinIdentity(): string | null {
  try {
    return inputIdentity(fstatSync(0, { bigint: true }));
  } catch {
    return null;
  }
}

/**
 * An input's `dev:ino`, exact and unsigned, as Python reads them: a pipe's inode on macOS is beyond
 * a double's precision, and Node's big integers for it are signed. On Windows only a file has one:
 * Node numbers a pipe or a console by its handle, a number of the process's own that another
 * process's pipe can have too, and Python sees none at all.
 */
export function inputIdentity(st: Pick<BigIntStats, 'dev' | 'ino' | 'isFile'>, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32' && !st.isFile()) return null;
  const unsigned = (n: bigint) => (n < 0n ? n + (1n << 64n) : n);
  return st.ino ? `${unsigned(st.dev)}:${unsigned(st.ino)}` : null;
}

/**
 * The environment that loads shadowlap into a Node or Python agent: in-process capture, the
 * network guard in `mode`, and recorded user input. Capture is on unless SHADOWLAP_CAPTURE=off.
 */
export function guardEnv(mode: GuardMode, base: NodeJS.ProcessEnv = process.env, upstreams: Record<string, string> = {}, http: readonly HttpRule[] = []): Record<string, string> {
  const dir = fileURLToPath(new URL('../guard/', import.meta.url));
  const nodeImport = `--import=${pathToFileURL(resolve(dir, 'node-preload.mjs')).href}`;
  const stdin = stdinIdentity();
  return {
    SHADOWLAP_GUARD: mode,
    SHADOWLAP_CAPTURE: base.SHADOWLAP_CAPTURE === 'off' ? 'off' : captureConfig(upstreams, http),
    NODE_OPTIONS: [base.NODE_OPTIONS, nodeImport].filter(Boolean).join(' '),
    PYTHONPATH: [dir, base.PYTHONPATH].filter(Boolean).join(delimiter),
    ...(stdin ? { SHADOWLAP_STDIN: stdin } : {}),
  };
}

/**
 * NO_PROXY and no_proxy with the loopback addresses added, so the agent's HTTP clients reach the
 * sidecar directly even behind a proxy (HTTP_PROXY): through one, a model call would carry the API
 * key, the prompt and the session token in clear text, and the proxy can't reach this machine's
 * loopback anyway. Every entry either spelling had is kept, in both: a client that reads only one of
 * them (Python prefers the lowercase one) still bypasses what the person set.
 */
export function noProxyEnv(base: NodeJS.ProcessEnv): { NO_PROXY: string; no_proxy: string } {
  const entries = [base.NO_PROXY, base.no_proxy].flatMap((v) => (v ?? '').split(',')).map((e) => e.trim()).filter(Boolean);
  const value = [...new Set([...entries, '127.0.0.1', 'localhost', '::1'])].join(',');
  return { NO_PROXY: value, no_proxy: value };
}

/**
 * The agent's environment for a run: base URLs to the sidecar, and the preloads, with the folder the
 * `shadowlap mcp --listen` proxies of this user's register in, which its guard lets it reach.
 */
export function agentEnv(sidecar: Sidecar, runId: string, guard: GuardMode, upstreams: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...noProxyEnv(process.env), ...sidecar.envFor(runId), ...guardEnv(guard, process.env, upstreams, sidecar.httpRules), SHADOWLAP_MCP_REGISTRY: proxyFolder() ?? '' };
  // The dashboard job's event pipe is this command's; an agent that runs shadowlap itself reports nothing into it.
  delete env.SHADOWLAP_EVENTS_FD;
  // The Node capture preload shows this value to the OpenAI SDK's AzureOpenAI constructor, which takes
  // its baseURL default from OPENAI_BASE_URL and refuses one alongside an endpoint. Everything else,
  // in every runtime, sees the sidecar.
  if (env.SHADOWLAP_CAPTURE !== 'off') env.SHADOWLAP_OPENAI_BASE_URL_WAS = process.env.OPENAI_BASE_URL ?? '';
  return env;
}

/**
 * Marks a run whose agent starts with the preloads, which record what a person types: a replay of
 * it treats an input it doesn't hold as a change, where one of a run recorded before input was
 * recorded runs the agent's reads live (`RunMeta.inputs`).
 */
export function recordsInput(store: StoreOf<'recording'>, runId: string): void {
  store.updateRunMeta(runId, { inputs: true });
}

export interface TestAttempt {
  ended: ReturnType<Sidecar['endRun']>;
  code: number;
  ms: number;
  output: string;
  /** What the agent printed on stdout alone: what a judge check reads as its output. */
  stdout: string;
  /** Null when the recording has no checks. */
  checks: CheckResult[] | null;
  failure: JunitCase['failure'];
  /** What kind of failure it was, or null when it passed. */
  kind: Exclude<TestFailure, 'error'> | null;
  /** The signal (Ctrl-C, a dashboard job stopped) that cut it short: its run ended as crashed, and its result says nothing about the recording. */
  interrupted: NodeJS.Signals | null;
}

/** One replay of a packed recording under `shadowlap test`, judged by its checks. */
export async function testAttempt(
  store: Store,
  parent: RunRecord,
  o: {
    cwd: string; upstreams: Record<string, string>; extraEnv: Record<string, string>; writes: WritePolicy; guard: GuardMode; normalizers: ReturnType<typeof loadConfig>['normalize']; prices: ReturnType<typeof loadConfig>['prices']; clock: ReturnType<typeof loadConfig>['clock']; http?: ReturnType<typeof loadConfig>['http']; spec: TestSpec | null;
    // The project's redaction rules: what a judge check reads has them applied.
    redact?: ReturnType<typeof loadConfig>['redact'];
    // `shadowlap test` and `bisect`: the command to run (default: the recorded one), metadata for the
    // replay (`test: { golden, session }`), a callback once the replay run exists, a time limit, and a
    // call forced live (`test --update` re-records from call 1).
    argv?: string[]; meta?: Partial<RunMeta>; onRun?: (runId: string) => void; timeoutMs?: number | null; divergeAt?: number;
    /** What the replay plays in besides its policies: an error-path preset's failing tool, result or model call (`test --chaos`). */
    replay?: Partial<ReplayOptions>;
    /**
     * A signal always reaches the agent's whole process group, and the run ends as crashed. Then, with
     * `return`, the attempt returns (`interrupted`) to a caller that winds down by itself (`test`,
     * `bisect`); by default the signal is raised again, which ends this process as it would have ended
     * without shadowlap in between.
     */
    onSignal?: 'return' | 'exit';
    /** The tools `--allow-unrecorded` lets run again though the recording never recorded them and they write. */
    allowUnrecorded?: ReadonlySet<string>;
    /** A golden that may fork, under `test` and `bisect`: its judge checks are asked only where no other check failed (`judgeAttempt`). */
    skipJudgesOnFailure?: boolean;
  },
): Promise<TestAttempt> {
  // A tool the model called that the recording never recorded runs again for real: one that writes
  // is refused before anything starts, whichever command asked for the replay.
  refuseUnrecorded(store, parent, o.allowUnrecorded);
  // What the guard accepts unwatched, read before anything starts: a value it can't take ends the command.
  const accept = guardAccept();
  const started = Date.now();
  let output = '';
  const argv = o.argv ?? parent.command.argv;
  const sidecar = await Sidecar.start({ store, normalizers: o.normalizers, upstreams: o.upstreams, ...(o.prices ? { prices: o.prices } : {}), ...(o.clock ? { clock: o.clock } : {}), ...(o.http ? { http: o.http } : {}) });
  let run: RunRecord;
  try {
    // Read for each attempt, as the code may change between them, and without holding up a sidecar in this process.
    const version = await readCodeVersion(o.cwd);
    run = sidecar.startRun({
      mode: 'replay',
      parentRunId: parent.runId,
      command: { argv, cwd: o.cwd },
      codeVersion: version,
      // A partial recording (an import that only saw the network) declares what it covers; everything else runs live.
      replay: { writes: o.writes, reads: 'live', liveTools: new Set(), ...(parent.meta?.covers?.length ? { kinds: new Set(parent.meta.covers) } : {}), ...(o.divergeAt !== undefined ? { divergeAt: o.divergeAt } : {}), ...(o.replay ?? {}) },
    });
    // Who replayed it (`shadowlap test`'s runs show by whom on Runs, as every other run does), the keys
    // its environment held, and that it records what a person types: through the sidecar, which writes
    // them after the run's start and never waits on the thread for another process's lock.
    sidecar.updateRunMeta(run.runId, { ...(o.meta ?? {}), ...newRunMeta(), ...keyEnvPatch(store, parent.runId), inputs: true });
  } catch (err) {
    // Nothing is left running for what can't start: the sidecar holds the process open otherwise.
    await sidecar.close();
    throw err;
  }
  o.onRun?.(run.runId);
  // The agent gets a process group of its own, so stopping it also stops what it started (`npm run`,
  // `sh -c`): at the time limit, on a signal, and once it exits. It no longer hears the terminal's
  // Ctrl-C itself, so a signal that reaches this process is passed on to the group, once (AgentStop).
  // Windows has no groups: there the agent's whole process tree is ended while it runs.
  const group = GROUPS;
  // The run ends once: as it came out, or as interrupted when a second signal doesn't wait for it.
  let endedRun: ReturnType<Sidecar['endRun']> | null = null;
  const endRun = (status: Exclude<RunStatus, 'running'>) => (endedRun ??= sidecar.endRun(run.runId, status));
  let interrupted = null as NodeJS.Signals | null;
  // Heard until the run has ended, its judge checks included: a signal never leaves it running.
  const stop = new AgentStop({ group, onSignal: (sig) => void (interrupted ??= sig), abandon: () => endRun('crashed') }).start();
  // Each Node and Python process of the agent says its preload loaded: one that made calls with none
  // was never watched by the guard, which fails it under block.
  sidecar.expectPreloads(run.runId, o.guard, accept);
  const child = spawnAgent(argv[0]!, argv.slice(1), { cwd: o.cwd, env: { ...agentEnv(sidecar, run.runId, o.guard, o.upstreams), ...o.extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: group }, { url: sidecar.url, runId: run.runId });
  trackAgent(child, group);
  stop.add(child);
  // What a judge reads as the output is stdout alone: interleaved with stderr it could differ on every run.
  let stdout = '';
  child.stdout!.on('data', (d: Buffer) => {
    output += d.toString();
    stdout += d.toString();
  });
  child.stderr!.on('data', (d: Buffer) => (output += d.toString()));
  const kill = (sig: NodeJS.Signals) => killTree(child, sig, { group });
  let timedOut = false;
  const timer = o.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), 5_000).unref();
      }, o.timeoutMs)
    : null;
  // The command never started: why, in plain words (it isn't there, or the folder to run it in isn't).
  let notStarted: ReturnType<typeof startFailure> | null = null;
  const code = await new Promise<number>((res) => {
    child.on('error', (err) => {
      notStarted = startFailure(err, argv[0]!, o.cwd);
      output += `failed to start ${argv[0]!}: ${err.message}\n`;
      res(127);
    });
    child.on('exit', (c, signal) => res(exitStatus(c, signal)));
  });
  if (timer) clearTimeout(timer);
  // Whatever the agent left running in its group goes with it.
  if (group) kill('SIGKILL');
  // An agent on a Node before 18.18 never started either: its Node refused the preload and exited 9.
  if (!notStarted && !timedOut && !interrupted && code === 9 && store.countCalls(run.runId) === 0) {
    await outputDrained(child);
    if (refusedPreload(output)) notStarted = { notFound: false, message: AGENT_NODE_TOO_OLD };
  }
  if (timedOut) output += `\n[shadowlap] stopped after ${formatDuration(o.timeoutMs!)}\n`;
  if (interrupted) output += `\n[shadowlap] interrupted (${interrupted})\n`;
  // Judge checks are asked once the agent has exited, through this sidecar while the run is open, so
  // their calls are the run's: a clean replay's from its recording, a fork's live. What the agent
  // printed is read to its end first: `exit` can come before the last of it.
  if (o.spec && judgesOf(o.spec).length) await outputDrained(child);
  const judged = o.spec && judgesOf(o.spec).length ? await judgeAttempt(store, sidecar, run.runId, o.spec, { code, timedOut, interrupted: interrupted !== null, stdout, upstreams: o.upstreams, redact: o.redact ?? [], normalize: o.normalizers, clock: o.clock, prices: o.prices, forkFails: !o.spec.fork, output, skipJudgesOnFailure: o.skipJudgesOnFailure }) : null;
  // A signal heard while the judge was asked interrupted the attempt too: it is read after the judge.
  const ended = endRun(timedOut || interrupted ? 'crashed' : code === 0 ? 'completed' : 'failed');
  stop.stop();
  // What of the run could not be written once its summary was made goes into the summary it reports.
  ended.summary.warnings.push(...(await writtenEnd(sidecar, run.runId)));
  await sidecar.close();
  // Nothing waits for this attempt: the process ends as the signal meant it to, with the run ended.
  if (interrupted && o.onSignal !== 'return') exitBySignal(interrupted);
  const { summary } = ended;

  let checks: CheckResult[] | null = null;
  if (o.spec) {
    const calls = store.getCalls(run.runId);
    checks = evaluateChecks(o.spec, storedCheckInput(store, calls, output, o.prices), judgedOptions(judged));
    store.updateRunMeta(run.runId, { checks });
  }
  const failedChecks = checks?.filter((c) => !c.ok) ?? [];
  // Every value the report lists that changes every run gets its normalizer, not only the dates and
  // UUIDs the engine hints at: a request id too, and an id that may be a real change says so. A
  // value a rule in force masks already gets none: the report lists it, but it didn't diverge.
  // A replay that stopped short changed no request: its summary line says all there is.
  const changed = summary.divergence && summary.divergence.type !== 'ended_early' ? summary.divergence : null;
  if (changed) {
    const rules = [...o.normalizers, ...(parent.meta?.redactions ?? [])];
    changed.hints = [...unmaskedHints(changed, rules), ...valueHints(changed, rules)];
  }
  const divergence = changed ? formatDivergence(changed) + '\n' : '';
  let failure: JunitCase['failure'];
  let kind: TestAttempt['kind'] = null;
  if (interrupted) {
    // Never a pass, whatever the agent did with the signal: an update must not keep it.
    kind = 'exit';
    failure = { message: `the replay was interrupted (${interrupted})`, details: divergence + formatSummary(summary) };
  } else if (ended.preloads?.failed) {
    // Nothing watched the agent's connections under --guard block: whatever else came out, it proves nothing.
    kind = 'guard';
    failure = { message: ended.preloads.missing ?? ended.preloads.unguarded!, details: divergence + formatSummary(summary, undefined, guardOutcome(ended.preloads)) };
  } else if (changed && !o.spec?.fork) {
    kind = 'diverged';
    failure = { message: divergenceLine(changed), details: divergence + formatSummary(summary) };
  } else if (code !== 0 || timedOut) {
    // Stopped at the time limit fails, even when the agent caught the signal and exited 0.
    kind = 'exit';
    // A command that never started did so for its own reason, whatever its empty summary would suggest about the environment.
    const why = notStarted;
    failure = why ? { message: why.message, details: output.trim() } : { message: timedOut ? `the agent was stopped after ${formatDuration(o.timeoutMs!)}` : `the agent exited with code ${code}`, details: divergence + formatSummary(summary) };
  } else if (summary.total === 0) {
    kind = 'no-calls';
    failure = { message: 'no calls were made', details: formatSummary(summary) };
  } else if (summary.divergence && !o.spec?.fork) {
    // Every request matched, but the agent stopped before the recording did: what it never sent
    // (a write, the last model turn) is as much a change as a request sent differently. An exit
    // code or no call at all, above, says more about why.
    kind = 'diverged';
    failure = { message: divergenceLine(summary.divergence), details: formatSummary(summary) };
  } else if (failedChecks.length) {
    kind = 'check';
    // A check that could not be decided (a judge with no verdict) never passes, and says it is inconclusive, not failed.
    const definite = failedChecks.filter((c) => c.status !== 'inconclusive');
    const first = definite[0] ?? failedChecks[0]!;
    const word = definite.length ? 'failed' : 'inconclusive';
    const others = definite.length ? definite.length - 1 : failedChecks.length - 1;
    const more = others > 0 ? `; ${others} more check${others > 1 ? 's' : ''} ${word}` : '';
    const inconclusive = definite.length && failedChecks.length > definite.length ? `; ${failedChecks.length - definite.length} inconclusive` : '';
    failure = { message: `check ${word}: ${first.label}, but ${first.detail!}${more}${inconclusive}`, details: divergence + formatSummary(summary) };
  }
  return { ended, code, ms: Date.now() - started, output, stdout, checks, failure, kind, interrupted };
}

/**
 * Resolves once a child's piped output has been read to its end, or after `ms`: a grandchild that
 * holds the pipes open keeps nothing waiting longer than that.
 */
export function outputDrained(child: ReturnType<typeof spawn>, ms = 2_000): Promise<void> {
  const open = [child.stdout, child.stderr].filter((s) => s !== null && !s.readableEnded && !s.destroyed);
  if (!open.length) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    let left = open.length;
    for (const s of open) {
      s!.once('close', () => {
        if (--left === 0) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  });
}

/**
 * A run this command ended, once it is written (Sidecar.endWritten): its rows and its end, waited for
 * on the store writer's timer, and what of it could not be written, for its summary. Said once the
 * store has been held a while, since another process's write can take that long.
 */
export async function writtenEnd(sidecar: Sidecar, runId: string): Promise<string[]> {
  const held = setTimeout(() => process.stderr.write(p.dim(`[shadowlap] another process holds the store: run ${shortId(runId)} is written once it is free\n`)), 2_000);
  try {
    return await sidecar.endWritten(runId);
  } finally {
    clearTimeout(held);
  }
}

/**
 * The judge checks of an attempt whose agent has exited: asked through its sidecar, unless the
 * attempt can't pass anyway (the agent failed or was stopped, or, with `forkFails`, the replay
 * forked), when asking a judge would only cost: each then says why it was not judged. With
 * `skipJudgesOnFailure`, none is asked either where another check failed on the run's calls and
 * `output` (stdout with stderr, as the checks read it): each is then not applicable, and nothing is
 * sent. What a judge reads is masked as the replay was matched (`normalize`, and the dates near the
 * run's start unless `clock` is exact), so a clean replay asks what its recording asked.
 */
export async function judgeAttempt(
  store: Store,
  sidecar: Sidecar,
  runId: string,
  spec: TestSpec,
  a: { code: number; timedOut?: boolean; interrupted: boolean; stdout: string; upstreams: Record<string, string>; redact: ReturnType<typeof loadConfig>['redact']; normalize?: ReturnType<typeof loadConfig>['normalize']; clock?: ReturnType<typeof loadConfig>['clock']; prices: ReturnType<typeof loadConfig>['prices']; forkFails?: boolean; output?: string; skipJudgesOnFailure?: boolean | undefined },
): Promise<Judged> {
  const judges = judgesOf(spec);
  if (a.interrupted) return unjudged(judges, 'the replay was interrupted');
  if (a.timedOut) return unjudged(judges, 'the agent was stopped before it finished');
  if (a.code !== 0) return unjudged(judges, `the agent exited with code ${a.code}`);
  // What the judge reads of the run, once its rows are made: waited for on the writer's timer, so
  // another attempt's stream goes on while another process holds the store.
  await sidecar.settled(runId);
  if (a.forkFails && store.getRun(runId)?.divergence) return unjudged(judges, 'the replay diverged, which fails the test whatever the judge says');
  // Judged with no verdict, a judge check is never failed: a failure is another check's.
  if (a.skipJudgesOnFailure && evaluateChecks(spec, storedCheckInput(store, store.getCalls(runId), a.output ?? '', a.prices)).some((c) => c.status === 'failed')) return notAsked(judges);
  return askJudges(judges, materialOf(store, runId, a.stdout, a.clock), { sidecar, store, runId, upstreams: a.upstreams, redact: a.redact, ...(a.normalize ? { normalize: a.normalize } : {}), ...(a.prices ? { prices: a.prices } : {}) });
}

export function parseOverrides(specs: string[], parentCalls: CallRecord[]): Map<number, unknown> {
  const out = new Map<number, unknown>();
  for (const spec of specs) {
    const m = /^(\d+)=([\s\S]+)$/.exec(spec);
    if (!m) throw new Error(`--override expects <call>=<json|@file>, got "${spec}"`);
    const callNo = Number(m[1]);
    const call = parentCalls.find((c) => c.callNo === callNo);
    if (!call) throw new Error(`--override: the recording has no call #${callNo}`);
    if (call.kind !== 'tool') throw new Error(`--override: call #${callNo} is a ${call.kind} call; only tool results can be overridden`);
    // `@@…` is text starting with `@` (which is no JSON either), never a file name.
    const raw = m[2]!.startsWith('@@') ? m[2]!.slice(1) : m[2]!.startsWith('@') ? readFileSync(m[2]!.slice(1), 'utf8') : m[2]!;
    try {
      // Each number as it was typed: an id past 2^53 reaches the agent with its digits.
      out.set(callNo, parseJsonExact(raw));
    } catch {
      throw new Error(`--override: the result for call #${callNo} is not valid JSON`);
    }
  }
  return out;
}

/**
 * `--fail-at 12=429`: a model call answered with an HTTP failure instead of the recording.
 * `--fail-at 19=timeout`, `19=error:connection reset`, `19=503`: a tool call that fails without
 * running, so the agent's handling of a failing tool runs.
 *
 * Only failures a provider or a tool could really produce are accepted, because the point is to
 * exercise the agent's own error path — the SDK's retry policy, the harness's handling of a give-up
 * — and a made-up status would exercise neither.
 */
export function parseFailures(specs: string[], parentCalls: CallRecord[]): { models: Map<number, number>; tools: Map<number, ToolFailure> } {
  const models = new Map<number, number>();
  const tools = new Map<number, ToolFailure>();
  for (const spec of specs) {
    const m = /^(\d+)=([\s\S]+)$/.exec(spec.trim());
    if (!m) throw new Error(`--fail-at expects <call>=<status>, such as 12=429, or on a tool call <call>=timeout|error[:message]|<status>, got "${spec}"`);
    const callNo = Number(m[1]);
    const value = m[2]!.trim();
    const call = parentCalls.find((c) => c.callNo === callNo);
    if (!call) throw new Error(`--fail-at: the recording has no call #${callNo}`);
    if (call.kind === 'tool') {
      const failure = parseToolFailure(value);
      if ('error' in failure) throw new Error(`--fail-at ${callNo}=${value}: ${failure.error}`);
      tools.set(callNo, failure);
      continue;
    }
    if (call.kind !== 'api') throw new Error(`--fail-at: call #${callNo} is a ${call.kind} read; give the number of a model or tool call (see shadowlap show)`);
    if (isJudgeCall(call)) throw new Error(JUDGE_CALL('--fail-at', callNo));
    if (value === 'timeout' || value === 'error' || value.startsWith('error:')) {
      throw new Error(`--fail-at ${callNo}=${value}: #${callNo} is a model call, which fails with an HTTP status (429 rate limited, 500 or 529 overloaded, 400 bad request); timeout and error are for tool calls`);
    }
    if (!/^\d{3}$/.test(value)) throw new Error(`--fail-at expects <call>=<status>, such as 12=429, got "${spec}"`);
    const status = Number(value);
    if (status < 400 || status > 599) throw new Error(`--fail-at: ${status} is not a failure status; use 4xx or 5xx (429 rate limit, 500 or 529 overloaded, 400 bad request)`);
    models.set(callNo, status);
  }
  return { models, tools };
}

export function requireModelCall(callNo: number, parentCalls: CallRecord[], flag: string): void {
  const call = parentCalls.find((c) => c.callNo === callNo);
  if (!call) throw new Error(`${flag}: the recording has no call #${callNo}`);
  if (call.kind !== 'api') throw new Error(`${flag}: call #${callNo} is a ${call.kind} call; give the number of a model call (see shadowlap show)`);
  if (isJudgeCall(call)) throw new Error(JUDGE_CALL(flag, callNo));
}

/** Why a flag that names one of the agent's model calls can't name a judge's. */
const JUDGE_CALL = (flag: string, callNo: number) => `${flag}: call #${callNo} is a judge check's call, not the agent's: give the number of one of the agent's model calls (see shadowlap show)`;

/** `--inject 15="text"`, `--set 15:max_tokens=2048`, `--model 15:claude-opus-5`. */
export function parseInterventions(flags: { inject?: string; injectAs: 'system' | 'user'; set?: string[]; model?: string }, parentCalls: CallRecord[]): Interventions | undefined {
  const out: Interventions = {};
  if (flags.inject) {
    const m = /^(\d+)=([\s\S]+)$/.exec(flags.inject);
    if (!m) throw new Error(`--inject expects <call>=<text>, got "${flags.inject}"`);
    const atCall = Number(m[1]);
    requireModelCall(atCall, parentCalls, '--inject');
    out.inject = { atCall, text: m[2]!, as: flags.injectAs };
  }
  const fields: Record<string, unknown> = {};
  let fromCall: number | undefined;
  const at = (n: number, flag: string) => {
    requireModelCall(n, parentCalls, flag);
    if (fromCall !== undefined && fromCall !== n) throw new Error(`${flag}: all --set/--model patches must start at the same model call (got ${fromCall} and ${n})`);
    fromCall = n;
  };
  for (const spec of flags.set ?? []) {
    const m = /^(\d+):([A-Za-z_][\w.]*)=([\s\S]*)$/.exec(spec);
    if (!m) throw new Error(`--set expects <call>:<key>=<value>, got "${spec}"`);
    at(Number(m[1]), '--set');
    const raw = m[3]!;
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // a bare string
    }
    fields[m[2]!] = value;
  }
  if (flags.model) {
    const m = /^(\d+):(.+)$/.exec(flags.model);
    if (!m) throw new Error(`--model expects <call>:<model>, got "${flags.model}"`);
    at(Number(m[1]), '--model');
    fields.model = m[2];
  }
  if (fromCall !== undefined) out.set = { fromCall, fields };
  return out.inject || out.set ? out : undefined;
}

/**
 * Whether an agent ended on a signal that asks a process to stop. It was interrupted, whoever sent
 * it: a terminal's Ctrl-C reaches an agent that shares the terminal and this process alike, and the
 * agent can end on it before this process has heard its own.
 */
const stoppedBy = (signal: NodeJS.Signals | null): boolean => signal !== null && (STOP_SIGNALS as readonly string[]).includes(signal);

/**
 * Resolves once a child with piped output has exited and its output has been read to the end: `exit`
 * can come before the last of stdout and stderr, and a check on what the agent printed must see all
 * of it. A grandchild that holds the pipes open keeps the run waiting no more than a moment.
 */
function onDrained(child: ReturnType<typeof spawn>, resolve: (code: number) => void): void {
  // An agent a signal stopped ends with 128 + the signal's number, as a shell reports it: `run` and `replay` pass that on.
  child.on('close', (c, signal) => resolve(exitStatus(c, signal)));
  child.on('exit', (c, signal) => setTimeout(() => resolve(exitStatus(c, signal)), 2_000).unref());
}

/**
 * The agent's output, for checks on what it printed, still shown as it comes. Only stdout and stderr
 * are piped, and only when a check needs them: stdin stays the terminal's. `stdout` alone is what a
 * judge check reads as the output: interleaved with stderr, it could differ on every run.
 */
function teeOutput(child: ReturnType<typeof spawn>): { all: () => string; stdout: () => string } {
  let output = '';
  let stdout = '';
  child.stdout?.on('data', (d: Buffer) => {
    output += d.toString();
    stdout += d.toString();
    process.stdout.write(d);
  });
  child.stderr?.on('data', (d: Buffer) => {
    output += d.toString();
    process.stderr.write(d);
  });
  return { all: () => output, stdout: () => stdout };
}

/**
 * Called once a run's agent has exited, while its sidecar still has the run open: where a replay's
 * judge checks are asked, so their calls are the run's.
 */
export type BeforeEnd = (sidecar: Sidecar, store: Store, run: RunRecord, agent: { code: number; interrupted: boolean; stdout: string }) => Promise<void>;

/**
 * Whether a program by this name is on PATH, as a shell would find it (on Windows with each of
 * PATHEXT's extensions).
 */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const win = platform === 'win32';
  const path = (win ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  const exts = win ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  return path.split(win ? ';' : delimiter).some((dir) => dir && exts.some((ext) => {
    try {
      return statSync(join(dir, name + ext)).isFile();
    } catch {
      return false;
    }
  }));
}

/**
 * What to say when the agent's command isn't on PATH: `✗ pythn: command not found on PATH`, and for
 * `python` where only `python3` is (macOS, most Linux distributions), or the other way round, the
 * command again with the one that is there. `again` gives the command line to show for an argv.
 */
export function notFoundMessage(argv: readonly string[], again: (argv: string[]) => string, has: (name: string) => boolean = (name) => onPath(name)): string {
  const lines = [`${p.red('✗')} ${argv[0]!}: command not found on PATH`];
  const other = argv[0] === 'python' ? 'python3' : argv[0] === 'python3' ? 'python' : argv[0] === 'pip' ? 'pip3' : null;
  if (other && has(other)) lines.push(`  ${other} is on PATH: ${again([other, ...argv.slice(1)])}`);
  return lines.join('\n');
}

/**
 * Why the agent's command could not start, from spawn's error. Node says ENOENT both when the
 * program isn't there and when the working directory isn't, so the two are told apart here: a
 * missing folder is never blamed on PATH. A program that is there and still can't start (a script
 * whose interpreter is missing) keeps spawn's own words. `notFound`: the program itself isn't there.
 */
export function startFailure(err: NodeJS.ErrnoException, argv0: string, cwd: string, has: (name: string) => boolean = (name) => onPath(name)): { notFound: boolean; message: string } {
  if (err.code === 'ENOENT') {
    let folder = false;
    try {
      folder = statSync(cwd).isDirectory();
    } catch {
      // no such folder
    }
    if (!folder) return { notFound: false, message: `${cwd}: working directory does not exist` };
    // A path names the file itself; a bare name is looked up on PATH.
    if (/[\\/]/.test(argv0)) {
      if (!existsSync(resolve(cwd, argv0))) return { notFound: true, message: `${argv0}: no such file` };
    } else if (!has(argv0)) return { notFound: true, message: `${argv0}: command not found on PATH` };
  }
  return { notFound: false, message: `failed to start ${argv0}: ${err.message}` };
}

/**
 * Runs an agent under a sidecar, as `run` and `replay` do. `code` is the agent's exit status (128 + n
 * when signal n ended it); `signal` the stop signal this process heard while it waited, if any, which
 * the command ends on in turn (status 128 + n); `preloads` what the preloads in the agent's processes
 * said, with `failed` when the run failed for having none under --guard block.
 */
export async function runUnderSidecar(opts: GlobalOpts, argv: string[], start: (sidecar: Sidecar) => RunRecord, guard: GuardMode = 'warn', extra: { capture?: boolean; beforeEnd?: BeforeEnd; env?: Record<string, string> } = {}): Promise<{ code: number; run: RunRecord; summary: ReturnType<Sidecar['endRun']>['summary']; output: string; started: boolean; signal: NodeJS.Signals | null; preloads: ReturnType<Sidecar['endRun']>['preloads'] }> {
  if (argv.length === 0) throw new Error('no command given: shadowlap run -- <command> [args...]');
  const store = openStore(opts);
  const config = loadConfig(process.cwd());
  // What the guard accepts unwatched, read before anything starts: a value it can't take ends the command.
  const accept = guardAccept();
  const sidecar = await Sidecar.start({
    store,
    normalizers: config.normalize,
    upstreams: upstreamOverrides(process.env),
    ...(config.prices ? { prices: config.prices } : {}), ...(config.clock ? { clock: config.clock } : {}), ...(config.http ? { http: config.http } : {}),
    ...(config.tools ? { trust: config.tools } : {}),
    ...(opts.verbose ? { log: (line: string) => void process.stderr.write(p.dim(`[shadowlap] ${line}\n`)) } : {}),
  });
  let run: RunRecord;
  try {
    run = start(sidecar);
  } catch (err) {
    await sidecar.close();
    throw err;
  }
  // Who made it, the keys its environment held, and that it records what a person types.
  sidecar.updateRunMeta(run.runId, { ...newRunMeta(), ...keyEnvPatch(store, run.parentRunId), inputs: true });
  process.stderr.write(p.dim(`[shadowlap] ${run.mode === 'record' ? 'recording' : 'replaying'} run ${run.runId}\n`));
  // MCP clients often start servers with a minimal environment; `shadowlap mcp` finds the sidecar through this file.
  try {
    markActiveRun(process.cwd(), { url: sidecar.url, runId: run.runId, pid: process.pid });
  } catch {
    // read-only working directory: the environment still carries SHADOWLAP_URL
  }

  // Only while it still names this run: another run that started here since has written its own.
  const clearActive = () => {
    try {
      clearActiveRun(process.cwd(), run.runId);
    } catch {
      // never written here (a read-only folder), or another run kept it busy
    }
  };
  // The run ends once: as it came out, or as interrupted when a second signal doesn't wait for it.
  let ended: ReturnType<Sidecar['endRun']> | null = null;
  const endRun = (status: Exclude<RunStatus, 'running'>) => (ended ??= sidecar.endRun(run.runId, status));
  let interrupted = false;
  // The agent reads this process's stdin. In a terminal it shares the terminal's process group, where
  // the terminal's own Ctrl-C reaches it once, and in a dashboard job the job's group, which the
  // dashboard signals and kills as a whole; elsewhere it leads a group of its own, which a stop signal
  // is passed on to, once (AgentStop). Heard until the run has ended, its judge checks included.
  const shared = sharedGroup(true);
  const group = GROUPS && !shared;
  const stop = new AgentStop({ group, shared, onSignal: () => void (interrupted = true), abandon: () => (endRun('crashed'), clearActive()) }).start();
  sidecar.expectPreloads(run.runId, guard, accept);
  const child = spawnAgent(argv[0]!, argv.slice(1), { stdio: extra.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', env: { ...agentEnv(sidecar, run.runId, guard, upstreamOverrides(process.env)), ...extra.env }, detached: group }, { url: sidecar.url, runId: run.runId });
  trackAgent(child, group);
  stop.add(child);
  // A dashboard job links to the run once its agent has started: one whose command isn't found is not kept.
  child.once('spawn', () => emitJobEvent({ type: 'run', runId: run.runId, role: 'new' }));
  const tee = extra.capture ? teeOutput(child) : null;
  const output = () => tee?.all() ?? '';
  // Heard before the run's status is settled: the listener that settles it comes after this one.
  child.once('exit', (_c, signal) => {
    if (stoppedBy(signal)) interrupted = true;
  });
  // A command that never started (it isn't there, or can't be run): nothing ran, so nothing is kept of it.
  let notStarted: ReturnType<typeof startFailure> | null = null;
  const code = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      notStarted = startFailure(err, argv[0]!, process.cwd());
      resolve(127);
    });
    if (extra.capture) onDrained(child, resolve);
    else child.on('exit', (c, signal) => resolve(exitStatus(c, signal)));
  });
  // An agent on a Node before 18.18 never started either: its Node refused the preload and exited 9.
  // Its words went to the terminal unless a check captured them, so that Node is asked again. One a
  // launcher or a script picked can't be: its run is kept, and its summary says what Node's words mean.
  let unasked = false;
  if (!notStarted && !interrupted && code === 9 && store.countCalls(run.runId) === 0) {
    if (tee ? refusedPreload(tee.all()) : nodeRefusesPreload(argv[0]!, { ...process.env, ...guardEnv(guard) }, process.cwd())) notStarted = { notFound: false, message: AGENT_NODE_TOO_OLD };
    else unasked = !tee && !namesNode(argv[0]!);
  }

  clearActive();
  if (extra.beforeEnd && !notStarted) await extra.beforeEnd(sidecar, store, run, { code, interrupted, stdout: tee?.stdout() ?? '' });
  // A signal heard while the judge was asked interrupted the run too: it is read after the judge.
  const result = endRun(interrupted ? 'crashed' : code === 0 ? 'completed' : 'failed');
  stop.stop();
  // What of the run could not be written once its summary was made goes into the summary it prints.
  result.summary.warnings.push(...(await writtenEnd(sidecar, run.runId)));
  if (unasked) result.summary.warnings.push(AGENT_NODE_MAYBE_TOO_OLD);
  const why = notStarted;
  if (why) {
    // Not a failed recording, or a replay that made no calls: the agent never ran. The run goes, and
    // so does the paragraph about the environment its empty summary would print.
    store.deleteRun(run.runId);
    await sidecar.close();
    store.close();
    const again = (a: string[]) => (run.mode === 'replay' && run.parentRunId ? `shadowlap replay ${shortId(run.parentRunId)} -- ${quoteArgv(a)}` : `shadowlap run -- ${quoteArgv(a)}`);
    const said = why.notFound && !/[\\/]/.test(argv[0]!) ? notFoundMessage(argv, again) : `${p.red('✗')} ${why.message}`;
    process.stderr.write(`${said}\n${p.dim(`  nothing ran, so run ${shortId(run.runId)} is not kept`)}\n`);
    emitJobEvent({ type: 'result', data: { exitCode: code, summary: result.summary, started: false } });
    return { code, run, summary: result.summary, output: output(), started: false, signal: stop.signal, preloads: result.preloads };
  }
  if (run.mode === 'record') noteUnrecordedTools(store, run.runId, process.cwd());
  await sidecar.close();
  store.close();
  emitJobEvent({ type: 'result', data: { exitCode: code, summary: result.summary } });
  emitJobEvent({ type: 'link', label: 'Open run', href: links.run(run.runId) });
  // Team store: a run someone pushed while it was recording goes to the store now that it has ended.
  await pushIfQueued(teamEnv(opts.db));
  telemetry().record({ type: run.mode === 'record' ? 'run' : 'replay', ...usageOf(result, Date.now() - run.startedAt, code) });
  await telemetry().flush();
  return { code, run, summary: result.summary, output: output(), started: true, signal: stop.signal, preloads: result.preloads };
}

export interface AttemptResult {
  run: RunRecord;
  code: number;
  summary: ReturnType<Sidecar['endRun']>['summary'];
  /** What the agent printed, when it was captured for a check on it. */
  output: string;
  /** What the preloads in the attempt's agent said, with `failed` when it ran unwatched under --guard block. */
  preloads: ReturnType<Sidecar['endRun']>['preloads'];
}

/**
 * The same replay of `extra.recording`, `count` times, on one sidecar: each attempt is its own run
 * and process. With a concurrency of 1 the agent's output streams as usual under a header per
 * attempt; with more, each attempt's output is collected and printed whole when it finishes, so
 * attempts never interleave. A recording whose model called a tool it never recorded that writes is
 * refused before any attempt starts, unless `extra.allowUnrecorded` names it.
 */
export async function repeatUnderSidecar(opts: GlobalOpts, argv: string[], count: number, concurrency: number, start: (sidecar: Sidecar) => RunRecord, guard: GuardMode, extra: { recording: RunRecord; allowUnrecorded?: ReadonlySet<string>; capture?: boolean; beforeEnd?: BeforeEnd; env?: Record<string, string> }): Promise<AttemptResult[]> {
  if (argv.length === 0) throw new Error('no command given: shadowlap run -- <command> [args...]');
  const store = openStore(opts);
  try {
    refuseUnrecorded(store, extra.recording, extra.allowUnrecorded);
  } catch (err) {
    store.close();
    throw err;
  }
  const config = loadConfig(process.cwd());
  // What the guard accepts unwatched, read before anything starts: a value it can't take ends the command.
  let accept: string[];
  try {
    accept = guardAccept();
  } catch (err) {
    store.close();
    throw err;
  }
  const sidecar = await Sidecar.start({
    store,
    normalizers: config.normalize,
    upstreams: upstreamOverrides(process.env),
    ...(config.prices ? { prices: config.prices } : {}), ...(config.clock ? { clock: config.clock } : {}), ...(config.http ? { http: config.http } : {}),
    ...(config.tools ? { trust: config.tools } : {}),
    ...(opts.verbose ? { log: (line: string) => void process.stderr.write(p.dim(`[shadowlap] ${line}\n`)) } : {}),
  });
  const results = new Array<AttemptResult>(count);
  let stopped = false;
  // Streamed one at a time, an attempt reads this process's stdin: in a terminal it shares the
  // terminal's process group, where the terminal's own Ctrl-C reaches it once. In a dashboard job
  // each shares the job's group, which the dashboard signals and kills as a whole. Otherwise each
  // leads a group of its own, which a stop signal is passed on to, once (AgentStop). Heard until the
  // last run has ended: a second signal while only judge checks are left ends those runs as interrupted.
  const streaming = concurrency === 1;
  const shared = sharedGroup(streaming);
  const agentGroup = GROUPS && !shared;
  const open = new Set<string>();
  const stop = new AgentStop({
    group: agentGroup,
    shared,
    onSignal: () => void (stopped = true),
    abandon: () => {
      for (const runId of open) sidecar.endRun(runId, 'crashed');
      open.clear();
    },
  }).start();
  let next = 0;
  // Attempts of this invocation, so the dashboard can show them as one bundle.
  const group = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Attempts whose Node refused the preload (Node before 18.18), as every attempt's would: none ran.
  const refused: string[] = [];
  // Whether the line for an agent whose Node couldn't be asked has been printed.
  let hinted = false;
  // Whether the line for an attempt no preload watched under --guard block has been printed.
  let unwatched = false;
  const worker = async () => {
    while (!stopped && !refused.length && next < count) {
      const i = next++;
      const run = start(sidecar);
      // Through the sidecar, after the run's start: an attempt that starts while another streams never holds it up.
      sidecar.updateRunMeta(run.runId, { repeat: { group, attempt: i + 1, of: count }, ...newRunMeta(), ...keyEnvPatch(store, run.parentRunId), inputs: true });
      emitJobEvent({ type: 'run', runId: run.runId, role: 'attempt' });
      const header = p.dim(`── attempt ${i + 1} of ${count} · run ${run.runId} ──`);
      if (streaming) process.stderr.write(`${header}\n`);
      const tee = streaming && extra.capture;
      sidecar.expectPreloads(run.runId, guard, accept);
      const child = spawnAgent(argv[0]!, argv.slice(1), { stdio: streaming ? (tee ? ['inherit', 'pipe', 'pipe'] : 'inherit') : ['ignore', 'pipe', 'pipe'], env: { ...agentEnv(sidecar, run.runId, guard, upstreamOverrides(process.env)), ...extra.env }, detached: agentGroup }, { url: sidecar.url, runId: run.runId });
      trackAgent(child, agentGroup);
      stop.add(child);
      let stoppedBySignal = false;
      child.once('exit', (_c, signal) => {
        if (stoppedBy(signal)) stoppedBySignal = true;
      });
      let output = '';
      let stdout = '';
      const shown = tee ? teeOutput(child) : null;
      if (!tee) {
        child.stdout?.on('data', (d: Buffer) => {
          output += d.toString();
          stdout += d.toString();
        });
        child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
      }
      const code = await new Promise<number>((resolveCode) => {
        child.on('error', (err) => {
          output += `failed to start ${argv[0]!}: ${err.message}\n`;
          resolveCode(127);
        });
        // Piped output is read to the end before it is printed or checked.
        if (!streaming || tee) onDrained(child, resolveCode);
        else child.on('exit', (c, signal) => resolveCode(exitStatus(c, signal)));
      });
      if (shown) {
        output = shown.all();
        stdout = shown.stdout();
      }
      // Streamed to the terminal, the Node's words can't be read here: that Node is asked again. One a
      // launcher or a script picked can't be: the attempt counts, and a line says what Node's words mean.
      let unasked = false;
      // Counted once its rows are made, waited for on the writer's timer: another attempt's stream goes on.
      if (!stopped && !stoppedBySignal && code === 9 && (await sidecar.settled(run.runId), store.countCalls(run.runId) === 0)) {
        if (streaming && !tee ? nodeRefusesPreload(argv[0]!, { ...process.env, ...guardEnv(guard) }, process.cwd()) : refusedPreload(output)) {
          sidecar.endRun(run.runId, 'failed');
          refused.push(run.runId);
          continue;
        }
        unasked = streaming && !tee && !namesNode(argv[0]!);
      }
      open.add(run.runId);
      if (extra.beforeEnd) await extra.beforeEnd(sidecar, store, run, { code, interrupted: stopped || stoppedBySignal, stdout });
      // Ended as interrupted already, when a second signal didn't wait for its judge.
      if (!open.delete(run.runId)) continue;
      // A signal heard while the judge was asked interrupted the attempt too: it is read after the judge.
      const ended = sidecar.endRun(run.runId, stopped || stoppedBySignal ? 'crashed' : code === 0 ? 'completed' : 'failed');
      results[i] = { run, code, summary: ended.summary, output, preloads: ended.preloads };
      telemetry().record({ type: 'replay', ...usageOf(ended, Date.now() - run.startedAt, code) });
      if (!streaming) process.stderr.write(`${header}\n${output}${output.endsWith('\n') || !output ? '' : '\n'}`);
      const s = ended.summary;
      const fork = s.divergence ? kindLabel('fork', s.divergence) : 'clean';
      const fenced = s.byOrigin.blocked + s.byOrigin.stubbed;
      process.stderr.write(p.dim(`   attempt ${i + 1}: ${fork} · ${s.byOrigin.live} live${fenced ? ` · ${fenced} writes fenced` : ''} · exit ${code} · ${formatDuration(s.durationMs ?? 0)}\n`));
      // Once: every attempt that follows starts on the same Node.
      if (unasked && !hinted) {
        hinted = true;
        process.stderr.write(p.yellow(`   ! ${AGENT_NODE_MAYBE_TOO_OLD}`) + '\n');
      }
      // Once too: the command is the same for every attempt, and so is why no preload loaded in it.
      if (ended.preloads?.failed && !unwatched) {
        unwatched = true;
        process.stderr.write(p.yellow(`   ! ${ended.preloads.missing ?? ended.preloads.unguarded!}`) + '\n');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  stop.stop();
  // Every attempt written, its end too, however long another process holds the store.
  await sidecar.settled();
  // Nothing ran in them, so they are not kept, and no report is made of the attempts.
  for (const runId of refused) store.deleteRun(runId);
  await sidecar.close();
  store.close();
  // Team store: attempts someone pushed while they were recording go to the store now that they have ended.
  await pushIfQueued(teamEnv(opts.db));
  await telemetry().flush();
  if (refused.length) throw new Error(AGENT_NODE_TOO_OLD);
  return results.filter(Boolean);
}
