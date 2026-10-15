import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, estimateCost, finalAnswer, formatDivergence, formatDuration, formatSummary, type CallRecord, type RunMeta, type RunRecord, type RunStatus, type TestFailure, type WritePolicy } from '@shadowlap/engine';
import { httpRuleMatcher, providers, Sidecar, type HttpRule, type Interventions } from '@shadowlap/sidecar';
import { evaluateChecks, type CheckResult, type TestSpec } from './checks.js';
import { codeVersion, loadConfig, upstreamOverrides } from './config.js';
import { type JunitCase } from './junit.js';
import { openStore, telemetry, usageOf, type GlobalOpts } from './shared.js';
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
 * The environment that loads Shadowlap into a Node or Python agent: in-process capture, and the
 * network guard in `mode`. Capture is on unless SHADOWLAP_CAPTURE=off.
 */
export function guardEnv(mode: GuardMode, base: NodeJS.ProcessEnv = process.env, upstreams: Record<string, string> = {}, http: readonly HttpRule[] = []): Record<string, string> {
  const dir = fileURLToPath(new URL('../guard/', import.meta.url));
  const nodeImport = `--import=${pathToFileURL(resolve(dir, 'node-preload.mjs')).href}`;
  return {
    SHADOWLAP_GUARD: mode,
    SHADOWLAP_CAPTURE: base.SHADOWLAP_CAPTURE === 'off' ? 'off' : captureConfig(upstreams, http),
    NODE_OPTIONS: [base.NODE_OPTIONS, nodeImport].filter(Boolean).join(' '),
    PYTHONPATH: [dir, base.PYTHONPATH].filter(Boolean).join(delimiter),
  };
}

/** The agent's environment for a run: base URLs to the sidecar, and the preloads. */
export function agentEnv(sidecar: Sidecar, runId: string, guard: GuardMode, upstreams: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...sidecar.envFor(runId), ...guardEnv(guard, process.env, upstreams, sidecar.httpRules) };
  // The Node capture preload shows this value to the OpenAI SDK's AzureOpenAI constructor, which takes
  // its baseURL default from OPENAI_BASE_URL and refuses one alongside an endpoint. Everything else,
  // in every runtime, sees the sidecar.
  if (env.SHADOWLAP_CAPTURE !== 'off') env.SHADOWLAP_OPENAI_BASE_URL_WAS = process.env.OPENAI_BASE_URL ?? '';
  return env;
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
  o.onRun?.(run.runId);
  // With a time limit, the agent gets a process group of its own, so stopping it also stops what it
  // started (`npm run`, `sh -c`); signals that would have reached the group from the terminal are passed on.
  const group = !!o.timeoutMs && process.platform !== 'win32';
  const child = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: { ...agentEnv(sidecar, run.runId, o.guard, o.upstreams), ...o.extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
  child.stdout.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (group && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // already gone
    }
  };
  const forward = (sig: NodeJS.Signals) => kill(sig);
  if (group) {
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
  }
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
  if (group) {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
    // Whatever the agent left running in its group goes with it.
    kill('SIGKILL');
  }
  if (timedOut) output += `\n[shadowlap] stopped after ${formatDuration(o.timeoutMs!)}\n`;
  const ended = sidecar.endRun(run.runId, timedOut ? 'crashed' : code === 0 ? 'completed' : 'failed');
  await sidecar.close();
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
  const divergence = summary.divergence ? formatDivergence(summary.divergence) + '\n' : '';
  let failure: JunitCase['failure'];
  let kind: TestAttempt['kind'] = null;
  if (summary.divergence && !o.spec?.fork) {
    kind = 'diverged';
    failure = { message: `diverged at call ${summary.divergence.callNo} (${summary.divergence.kind} ${summary.divergence.name})`, details: divergence + formatSummary(summary) };
  } else if (code !== 0) {
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
  return { ended, code, ms: Date.now() - started, output, checks, failure, kind };
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
    const raw = m[2]!.startsWith('@') ? readFileSync(m[2]!.slice(1), 'utf8') : m[2]!;
    try {
      out.set(callNo, JSON.parse(raw));
    } catch {
      throw new Error(`--override: the result for call #${callNo} is not valid JSON`);
    }
  }
  return out;
}

/**
 * `--fail-at 12=429`: model calls to answer with an HTTP failure instead of the recording.
 *
 * Only statuses a provider could actually return are accepted, because the point is to exercise the
 * agent's own error path — the SDK's retry policy, the harness's handling of a give-up — and a made
 * up status would exercise neither.
 */
export function parseFailures(specs: string[], parentCalls: CallRecord[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const spec of specs) {
    const m = /^(\d+)=(\d{3})$/.exec(spec.trim());
    if (!m) throw new Error(`--fail-at expects <call>=<status>, such as 12=429, got "${spec}"`);
    const callNo = Number(m[1]);
    const status = Number(m[2]);
    if (status < 400 || status > 599) throw new Error(`--fail-at: ${status} is not a failure status; use 4xx or 5xx (429 rate limit, 500 or 529 overloaded, 400 bad request)`);
    requireModelCall(callNo, parentCalls, '--fail-at');
    out.set(callNo, status);
  }
  return out;
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

export async function runUnderSidecar(opts: GlobalOpts, argv: string[], start: (sidecar: Sidecar) => RunRecord, guard: GuardMode = 'warn'): Promise<{ code: number; run: RunRecord; summary: ReturnType<Sidecar['endRun']>['summary'] }> {
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

  const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', env: agentEnv(sidecar, run.runId, guard, upstreamOverrides(process.env)) });
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
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
  });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  const status: Exclude<RunStatus, 'running'> = interrupted ? 'crashed' : code === 0 ? 'completed' : 'failed';
  rmSync(activeFile, { force: true });
  const result = sidecar.endRun(run.runId, status);
  await sidecar.close();
  store.close();
  telemetry().record({ type: run.mode === 'record' ? 'run' : 'replay', ...usageOf(result, Date.now() - run.startedAt, code) });
  await telemetry().flush();
  return { code, run, summary: result.summary };
}

export interface AttemptResult {
  run: RunRecord;
  code: number;
  summary: ReturnType<Sidecar['endRun']>['summary'];
}

/**
 * The same replay, `count` times, on one sidecar: each attempt is its own run and process. With a
 * concurrency of 1 the agent's output streams as usual under a header per attempt; with more, each
 * attempt's output is collected and printed whole when it finishes, so attempts never interleave.
 */
export async function repeatUnderSidecar(opts: GlobalOpts, argv: string[], count: number, concurrency: number, start: (sidecar: Sidecar) => RunRecord, guard: GuardMode): Promise<AttemptResult[]> {
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
      store.updateRunMeta(run.runId, { repeat: { group, attempt: i + 1, of: count } });
      const header = p.dim(`── attempt ${i + 1} of ${count} · run ${run.runId} ──`);
      const streaming = concurrency === 1;
      if (streaming) process.stderr.write(`${header}\n`);
      const child = spawn(argv[0]!, argv.slice(1), { stdio: streaming ? 'inherit' : ['ignore', 'pipe', 'pipe'], env: agentEnv(sidecar, run.runId, guard, upstreamOverrides(process.env)) });
      running.add(child);
      let output = '';
      child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
      const code = await new Promise<number>((resolveCode) => {
        child.on('error', (err) => {
          output += `failed to start ${argv[0]}: ${err.message}\n`;
          resolveCode(127);
        });
        child.on('exit', (c, signal) => resolveCode(c ?? (signal ? 128 : 1)));
      });
      running.delete(child);
      const status: Exclude<RunStatus, 'running'> = stopped ? 'crashed' : code === 0 ? 'completed' : 'failed';
      const ended = sidecar.endRun(run.runId, status);
      results[i] = { run, code, summary: ended.summary };
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
  await telemetry().flush();
  return results.filter(Boolean);
}
