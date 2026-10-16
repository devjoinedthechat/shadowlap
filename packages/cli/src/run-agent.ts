import { spawn } from 'node:child_process';
import { existsSync, fstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, estimateCost, finalAnswer, formatDivergence, formatDuration, formatSummary, parseToolFailure, valueHints, type CallRecord, type RunMeta, type RunRecord, type RunStatus, type TestFailure, type ToolFailure, type WritePolicy } from '@shadowlap/engine';
import { httpRuleMatcher, providers, Sidecar, type HttpRule, type Interventions } from '@shadowlap/sidecar';
import { newRunMeta, stampAuthor } from './activity.js';
import { spawnAgent } from './agent-registry.js';
import { evaluateChecks, type CheckResult, type TestSpec } from './checks.js';
import { codeVersion, loadConfig, upstreamOverrides } from './config.js';
import { emitJobEvent } from './job-events.js';
import { type JunitCase } from './junit.js';
import { openStore, telemetry, usageOf, type GlobalOpts } from './shared.js';
import { noteUnrecordedTools } from './not-recorded.js';
import { pushIfQueued, teamEnv } from './team.js';
import { palette as p } from './ui.js';

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
  const routes = providers.map((pr) => [pr.hosts.source, pr.id]);
  const hosts: Record<string, string> = {};
  for (const [id, value] of Object.entries(upstreams)) {
    try {
      const u = new URL(value);
      if (u.protocol === 'http:' || u.protocol === 'https:') hosts[`${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`] = id;
    } catch {
      // "offline" and other non-URLs
    }
  }
  // HTTP hosts recorded as tools: [hostname regex, port or null], any scheme.
  return JSON.stringify({ routes, hosts, http: http.map(httpRuleMatcher) });
}

/**
 * Which input this process was given (`dev:ino` of fd 0), so the preloads record what a person
 * types on it and on nothing else: an agent's own pipe to a child process is not user input.
 */
function stdinIdentity(): string | null {
  try {
    // Exact and unsigned, as Python reads them: a pipe's inode on macOS is beyond a double's
    // precision, and Node's big integers for it are signed.
    const st = fstatSync(0, { bigint: true });
    const unsigned = (n: bigint) => (n < 0n ? n + (1n << 64n) : n);
    return st.ino ? `${unsigned(st.dev)}:${unsigned(st.ino)}` : null;
  } catch {
    return null;
  }
}

/**
 * The environment that loads Shadowlap into a Node or Python agent: in-process capture, the
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

/** The agent's environment for a run: base URLs to the sidecar, and the preloads. */
export function agentEnv(sidecar: Sidecar, runId: string, guard: GuardMode, upstreams: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...sidecar.envFor(runId), ...guardEnv(guard, process.env, upstreams, sidecar.httpRules) };
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
export function recordsInput(store: Store, runId: string): void {
  store.updateRunMeta(runId, { inputs: true });
}

const AWS_CREDENTIAL_SOURCES = ['AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'];

/**
 * AWS clients refuse to send a request without credentials, even one Shadowlap will serve from a
 * recording. An offline replay of a run with Bedrock calls gets placeholders when the environment
 * has no credential source at all, so CI needs no AWS secrets. Nothing signed with them leaves the machine.
 */
export function placeholderAwsCredentials(env: NodeJS.ProcessEnv, calls: readonly Pick<CallRecord, 'meta'>[], home = homedir()): Record<string, string> {
  if (!calls.some((c) => c.meta.provider === 'bedrock')) return {};
  if (AWS_CREDENTIAL_SOURCES.some((name) => env[name])) return {};
  const sharedFiles = [env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials'), env.AWS_CONFIG_FILE || join(home, '.aws', 'config')];
  if (sharedFiles.some((f) => existsSync(f))) return {};
  return { AWS_ACCESS_KEY_ID: 'SHADOWLAPREPLAY', AWS_SECRET_ACCESS_KEY: 'shadowlap-offline-replay-placeholder' };
}

export interface TestAttempt {
  ended: ReturnType<Sidecar['endRun']>;
  code: number;
  ms: number;
  output: string;
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
    // `shadowlap test` and `bisect`: the command to run (default: the recorded one), metadata for the
    // replay (`test: { golden, session }`), a callback once the replay run exists, a time limit, and a
    // call forced live (`test --update` re-records from call 1).
    argv?: string[]; meta?: Partial<RunMeta>; onRun?: (runId: string) => void; timeoutMs?: number | null; divergeAt?: number;
    /**
     * A signal always reaches the agent's whole process group, and the run ends as crashed. Then, with
     * `return`, the attempt returns (`interrupted`) to a caller that winds down by itself (`test`,
     * `bisect`); by default the signal is raised again, which ends this process as it would have ended
     * without Shadowlap in between.
     */
    onSignal?: 'return' | 'exit';
  },
): Promise<TestAttempt> {
  const started = Date.now();
  let output = '';
  const argv = o.argv ?? parent.command.argv;
  const sidecar = await Sidecar.start({ store, normalizers: o.normalizers, upstreams: o.upstreams, ...(o.prices ? { prices: o.prices } : {}), ...(o.clock ? { clock: o.clock } : {}), ...(o.http ? { http: o.http } : {}) });
  const run = sidecar.startRun({
    mode: 'replay',
    parentRunId: parent.runId,
    command: { argv, cwd: o.cwd },
    codeVersion: codeVersion(o.cwd),
    // A partial recording (an import that only saw the network) declares what it covers; everything else runs live.
    replay: { writes: o.writes, reads: 'live', liveTools: new Set(), ...(parent.meta?.covers?.length ? { kinds: new Set(parent.meta.covers) } : {}), ...(o.divergeAt !== undefined ? { divergeAt: o.divergeAt } : {}) },
  });
  if (o.meta) store.updateRunMeta(run.runId, o.meta);
  // Who replayed it: `shadowlap test`'s runs show by whom on Runs, as every other run does.
  stampAuthor(store, run.runId);
  recordsInput(store, run.runId);
  o.onRun?.(run.runId);
  // The agent gets a process group of its own, so stopping it also stops what it started (`npm run`,
  // `sh -c`): at the time limit, on a signal, and once it exits. It no longer hears the terminal's
  // Ctrl-C itself, so a signal that reaches this process is passed on to the group.
  const group = process.platform !== 'win32';
  const child = spawnAgent(argv[0]!, argv.slice(1), { cwd: o.cwd, env: { ...agentEnv(sidecar, run.runId, o.guard, o.upstreams), ...o.extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: group }, { url: sidecar.url, runId: run.runId });
  child.stdout!.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (output += d.toString()));
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (group && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // already gone
    }
  };
  let interrupted = null as NodeJS.Signals | null;
  const forward = (sig: NodeJS.Signals) => {
    // A second signal doesn't wait for the agent to wind down.
    kill(interrupted ? 'SIGKILL' : sig);
    interrupted ??= sig;
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  let timedOut = false;
  const timer = o.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), 5_000).unref();
      }, o.timeoutMs)
    : null;
  const code = await new Promise<number>((res) => {
    child.on('error', (err) => {
      output += `failed to start ${argv[0]}: ${err.message}\n`;
      res(127);
    });
    child.on('exit', (c, signal) => res(c ?? (signal ? 128 : 1)));
  });
  if (timer) clearTimeout(timer);
  process.off('SIGINT', forward);
  process.off('SIGTERM', forward);
  // Whatever the agent left running in its group goes with it.
  if (group) kill('SIGKILL');
  if (timedOut) output += `\n[shadowlap] stopped after ${formatDuration(o.timeoutMs!)}\n`;
  if (interrupted) output += `\n[shadowlap] interrupted (${interrupted})\n`;
  const ended = sidecar.endRun(run.runId, timedOut || interrupted ? 'crashed' : code === 0 ? 'completed' : 'failed');
  await sidecar.close();
  // Nothing waits for this attempt: the process ends as the signal meant it to, with the run ended.
  if (interrupted && o.onSignal !== 'return') process.kill(process.pid, interrupted);
  const { summary } = ended;

  let checks: CheckResult[] | null = null;
  if (o.spec) {
    const calls = store.getCalls(run.runId);
    checks = evaluateChecks(o.spec, {
      calls,
      output,
      answer: finalAnswer(store, calls),
      argsOf: (c) => (c.requestRef ? store.getJson<{ args?: unknown }>(c.requestRef)?.args : undefined),
      costOf: (c) => estimateCost(c.end?.meta.model ?? c.meta.model, c.end?.meta.usage, o.prices),
    });
    store.updateRunMeta(run.runId, { checks });
  }
  const failedChecks = checks?.filter((c) => !c.ok) ?? [];
  // Every value the report lists that changes every run gets its normalizer, not only the dates and
  // UUIDs the engine hints at: a request id too, and an id that may be a real change says so.
  if (summary.divergence) summary.divergence.hints = [...(summary.divergence.hints ?? []), ...valueHints(summary.divergence, [...o.normalizers, ...(parent.meta?.redactions ?? [])])];
  const divergence = summary.divergence ? formatDivergence(summary.divergence) + '\n' : '';
  let failure: JunitCase['failure'];
  let kind: TestAttempt['kind'] = null;
  if (interrupted) {
    // Never a pass, whatever the agent did with the signal: an update must not keep it.
    kind = 'exit';
    failure = { message: `the replay was interrupted (${interrupted})`, details: divergence + formatSummary(summary) };
  } else if (summary.divergence && !o.spec?.fork) {
    kind = 'diverged';
    failure = { message: `diverged at call ${summary.divergence.callNo} (${summary.divergence.kind} ${summary.divergence.name})`, details: divergence + formatSummary(summary) };
  } else if (code !== 0 || timedOut) {
    // Stopped at the time limit fails, even when the agent caught the signal and exited 0.
    kind = 'exit';
    failure = { message: timedOut ? `the agent was stopped after ${formatDuration(o.timeoutMs!)}` : `the agent exited with code ${code}`, details: divergence + formatSummary(summary) };
  } else if (summary.total === 0) {
    kind = 'no-calls';
    failure = { message: 'no calls were made', details: formatSummary(summary) };
  } else if (failedChecks.length) {
    kind = 'check';
    const first = failedChecks[0]!;
    const more = failedChecks.length > 1 ? `; ${failedChecks.length - 1} more check${failedChecks.length > 2 ? 's' : ''} failed` : '';
    failure = { message: `check failed: ${first.label}, but ${first.detail}${more}`, details: divergence + formatSummary(summary) };
  }
  return { ended, code, ms: Date.now() - started, output, checks, failure, kind, interrupted };
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
      out.set(callNo, JSON.parse(raw));
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
}

/** `--inject 15="text"`, `--set 15:max_tokens=2048`, `--model 15:claude-opus-5`. */
export function parseInterventions(flags: { inject?: string; injectAs: 'system' | 'user'; set: string[]; model?: string }, parentCalls: CallRecord[]): Interventions | undefined {
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
  for (const spec of flags.set) {
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
 * Resolves once a child with piped output has exited and its output has been read to the end: `exit`
 * can come before the last of stdout and stderr, and a check on what the agent printed must see all
 * of it. A grandchild that holds the pipes open keeps the run waiting no more than a moment.
 */
function onDrained(child: ReturnType<typeof spawn>, resolve: (code: number) => void): void {
  const status = (c: number | null, signal: NodeJS.Signals | null) => c ?? (signal ? 128 : 1);
  child.on('close', (c, signal) => resolve(status(c, signal)));
  child.on('exit', (c, signal) => setTimeout(() => resolve(status(c, signal)), 2_000).unref());
}

/**
 * The agent's output, for checks on what it printed, still shown as it comes. Only stdout and stderr
 * are piped, and only when a check needs them: stdin stays the terminal's.
 */
function teeOutput(child: ReturnType<typeof spawn>): () => string {
  let output = '';
  child.stdout?.on('data', (d: Buffer) => {
    output += d.toString();
    process.stdout.write(d);
  });
  child.stderr?.on('data', (d: Buffer) => {
    output += d.toString();
    process.stderr.write(d);
  });
  return () => output;
}

export async function runUnderSidecar(opts: GlobalOpts, argv: string[], start: (sidecar: Sidecar) => RunRecord, guard: GuardMode = 'warn', extra: { capture?: boolean } = {}): Promise<{ code: number; run: RunRecord; summary: ReturnType<Sidecar['endRun']>['summary']; output: string }> {
  if (argv.length === 0) throw new Error('no command given: shadowlap run -- <command> [args...]');
  const store = openStore(opts);
  const config = loadConfig(process.cwd());
  const sidecar = await Sidecar.start({
    store,
    normalizers: config.normalize,
    upstreams: upstreamOverrides(process.env),
    ...(config.prices ? { prices: config.prices } : {}), ...(config.clock ? { clock: config.clock } : {}), ...(config.http ? { http: config.http } : {}),
    ...(opts.verbose ? { log: (line: string) => void process.stderr.write(p.dim(`[shadowlap] ${line}\n`)) } : {}),
  });
  const run = start(sidecar);
  stampAuthor(store, run.runId);
  recordsInput(store, run.runId);
  emitJobEvent({ type: 'run', runId: run.runId, role: 'new' });
  process.stderr.write(p.dim(`[shadowlap] ${run.mode === 'record' ? 'recording' : 'replaying'} run ${run.runId}\n`));
  // MCP clients often start servers with a minimal environment; `shadowlap mcp` finds the sidecar through this file.
  const activeFile = resolve(process.cwd(), '.shadowlap', 'active.json');
  try {
    mkdirSync(resolve(process.cwd(), '.shadowlap'), { recursive: true, mode: 0o700 });
    // It carries the sidecar's session token: owner-only, and written fresh so a symbolic link
    // left at that path is replaced, never followed.
    rmSync(activeFile, { force: true });
    writeFileSync(activeFile, JSON.stringify({ url: sidecar.url, runId: run.runId, pid: process.pid }) + '\n', { mode: 0o600, flag: 'wx' });
  } catch {
    // read-only working directory: the environment still carries SHADOWLAP_URL
  }

  const child = spawnAgent(argv[0]!, argv.slice(1), { stdio: extra.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', env: agentEnv(sidecar, run.runId, guard, upstreamOverrides(process.env)) }, { url: sidecar.url, runId: run.runId });
  const output = extra.capture ? teeOutput(child) : () => '';
  let interrupted = false;
  const onSignal = (sig: NodeJS.Signals) => {
    interrupted = true;
    child.kill(sig);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const code = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(p.red(`failed to start ${argv[0]}: ${err.message}\n`));
      resolve(127);
    });
    if (extra.capture) onDrained(child, resolve);
    else child.on('exit', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
  });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  const status: Exclude<RunStatus, 'running'> = interrupted ? 'crashed' : code === 0 ? 'completed' : 'failed';
  rmSync(activeFile, { force: true });
  const result = sidecar.endRun(run.runId, status);
  if (run.mode === 'record') noteUnrecordedTools(store, run.runId, process.cwd());
  await sidecar.close();
  store.close();
  emitJobEvent({ type: 'result', data: { exitCode: code, summary: result.summary } });
  emitJobEvent({ type: 'link', label: `Open run ${run.runId.slice(0, 10)}`, href: `#/run/${run.runId}` });
  // Team store: a run someone pushed while it was recording goes to the store now that it has ended.
  await pushIfQueued(teamEnv(opts.db));
  telemetry().record({ type: run.mode === 'record' ? 'run' : 'replay', ...usageOf(result, Date.now() - run.startedAt, code) });
  await telemetry().flush();
  return { code, run, summary: result.summary, output: output() };
}

export interface AttemptResult {
  run: RunRecord;
  code: number;
  summary: ReturnType<Sidecar['endRun']>['summary'];
  /** What the agent printed, when it was captured for a check on it. */
  output: string;
}

/**
 * The same replay, `count` times, on one sidecar: each attempt is its own run and process. With a
 * concurrency of 1 the agent's output streams as usual under a header per attempt; with more, each
 * attempt's output is collected and printed whole when it finishes, so attempts never interleave.
 */
export async function repeatUnderSidecar(opts: GlobalOpts, argv: string[], count: number, concurrency: number, start: (sidecar: Sidecar) => RunRecord, guard: GuardMode, extra: { capture?: boolean } = {}): Promise<AttemptResult[]> {
  if (argv.length === 0) throw new Error('no command given: shadowlap run -- <command> [args...]');
  const store = openStore(opts);
  const config = loadConfig(process.cwd());
  const sidecar = await Sidecar.start({
    store,
    normalizers: config.normalize,
    upstreams: upstreamOverrides(process.env),
    ...(config.prices ? { prices: config.prices } : {}), ...(config.clock ? { clock: config.clock } : {}), ...(config.http ? { http: config.http } : {}),
    ...(opts.verbose ? { log: (line: string) => void process.stderr.write(p.dim(`[shadowlap] ${line}\n`)) } : {}),
  });
  const results: AttemptResult[] = new Array(count);
  const running = new Set<ReturnType<typeof spawn>>();
  let stopped = false;
  const onSignal = (sig: NodeJS.Signals) => {
    stopped = true;
    for (const child of running) child.kill(sig);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let next = 0;
  // Attempts of this invocation, so the dashboard can show them as one bundle.
  const group = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const worker = async () => {
    while (!stopped && next < count) {
      const i = next++;
      const run = start(sidecar);
      store.updateRunMeta(run.runId, { repeat: { group, attempt: i + 1, of: count }, ...newRunMeta() });
      recordsInput(store, run.runId);
      emitJobEvent({ type: 'run', runId: run.runId, role: 'attempt' });
      const header = p.dim(`── attempt ${i + 1} of ${count} · run ${run.runId} ──`);
      const streaming = concurrency === 1;
      if (streaming) process.stderr.write(`${header}\n`);
      const tee = streaming && extra.capture;
      const child = spawnAgent(argv[0]!, argv.slice(1), { stdio: streaming ? (tee ? ['inherit', 'pipe', 'pipe'] : 'inherit') : ['ignore', 'pipe', 'pipe'], env: agentEnv(sidecar, run.runId, guard, upstreamOverrides(process.env)) }, { url: sidecar.url, runId: run.runId });
      running.add(child);
      let output = '';
      const shown = tee ? teeOutput(child) : null;
      if (!tee) {
        child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
        child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
      }
      const code = await new Promise<number>((resolveCode) => {
        child.on('error', (err) => {
          output += `failed to start ${argv[0]}: ${err.message}\n`;
          resolveCode(127);
        });
        // Piped output is read to the end before it is printed or checked.
        if (!streaming || tee) onDrained(child, resolveCode);
        else child.on('exit', (c, signal) => resolveCode(c ?? (signal ? 128 : 1)));
      });
      running.delete(child);
      if (shown) output = shown();
      const status: Exclude<RunStatus, 'running'> = stopped ? 'crashed' : code === 0 ? 'completed' : 'failed';
      const ended = sidecar.endRun(run.runId, status);
      results[i] = { run, code, summary: ended.summary, output };
      telemetry().record({ type: 'replay', ...usageOf(ended, Date.now() - run.startedAt, code) });
      if (!streaming) process.stderr.write(`${header}\n${output}${output.endsWith('\n') || !output ? '' : '\n'}`);
      const s = ended.summary;
      const fork = s.divergence ? `fork @${s.divergence.callNo}` : 'clean';
      const fenced = s.byOrigin.blocked + s.byOrigin.stubbed;
      process.stderr.write(p.dim(`   attempt ${i + 1}: ${fork} · ${s.byOrigin.live} live${fenced ? ` · ${fenced} writes fenced` : ''} · exit ${code} · ${formatDuration(s.durationMs ?? 0)}\n`));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await sidecar.close();
  store.close();
  // Team store: attempts someone pushed while they were recording go to the store now that they have ended.
  await pushIfQueued(teamEnv(opts.db));
  await telemetry().flush();
  return results.filter(Boolean);
}
