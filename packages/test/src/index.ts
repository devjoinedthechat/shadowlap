/**
 * Recordings for test suites. Wrap a test, and it records its agent's model and tool calls the first
 * time it runs, then replays them offline: no tokens, no network, the same answers every time. A
 * test whose code now sends a different request fails with the diff.
 *
 *   import { recorded } from '@shadowlap/test';
 *
 *   test('triages the inbox', recorded(async () => {
 *     const result = await runAgent('triage the inbox');
 *     expect(result.tickets).toHaveLength(3);
 *     expect(await currentRecording().called('send_email')).toBe(0);
 *   }));
 *
 * Recordings live next to the test file, in `__recordings__/<file>/<test name>`, one per test; commit them.
 * SHADOWLAP_RECORD picks the mode: `missing` (default) replays a recording when there is one and
 * records otherwise, `all` records again, `none` only replays and is the default when CI is set.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { HOST_ENV, SLOT_ENV, type HostInfo } from './host.js';

export { startHost, useHost, workerSlot, type HostInfo, type RunningHost } from './host.js';

export type RecordMode = 'missing' | 'all' | 'none';

export interface RecordingOptions {
  /** The recording directory. Default: `__recordings__/<test file>/<test name>` beside the test file. */
  recording?: string;
  /** The test's name, when it can't be read from the test runner. */
  name?: string;
  /** Default: SHADOWLAP_RECORD, else `none` when CI is set and `missing` otherwise. */
  mode?: RecordMode;
}

export interface RecordingResult {
  ok: boolean;
  mode: 'record' | 'replay';
  runId: string;
  recording: string;
  saved?: boolean;
  calls: number;
  replayed: number;
  message: string | null;
  report: string | null;
}

/** A call the agent made during the test, as the recording saw it. */
export interface RecordedCall {
  callNo: number;
  kind: 'api' | 'tool' | 'clock' | 'random';
  /** A model call's endpoint (`POST /v1/messages`), a tool's name, or `METHOD host/path` for an HTTP host recorded as a tool. */
  name: string;
  /** `live` or `replayed`; a write after a fork is `blocked` or `stubbed`. */
  origin: 'live' | 'replayed' | 'blocked' | 'stubbed' | 'overridden';
  /** null while the call is in flight. */
  outcome: 'ok' | 'error' | null;
  scope?: string;
  /** Model calls. */
  model?: string;
  /** Tool calls: the arguments, and the result or error the agent got. */
  args?: unknown;
  result?: unknown;
  error?: unknown;
}

/** The test's recording, to assert on what the agent did as well as what it returned. */
export class Recording {
  /** Null when the test runner itself runs under `shadowlap run` or `replay`, which records every test in one run. */
  constructor(
    private readonly info: HostInfo | null,
    readonly runId: string | null,
    /** Whether this run records the test or replays its recording. */
    readonly mode: 'record' | 'replay' | null,
    /** The recording directory, relative to the project. */
    readonly recording: string | null,
  ) {}

  private async read(): Promise<{ calls: RecordedCall[]; answer: string | null }> {
    if (!this.info || !this.runId) throw new Error('shadowlap: this test has no recording of its own to read, because the test runner runs under shadowlap run or replay. Run the tests directly.');
    return post(this.info, '/v1/recordings/calls', { runId: this.runId });
  }

  /** Every call so far, in order: model calls, tool calls, clock and random reads. */
  async calls(): Promise<RecordedCall[]> {
    return (await this.read()).calls;
  }

  /** Tool calls so far, or those of one tool. Calls blocked after a fork are included. */
  async toolCalls(name?: string): Promise<RecordedCall[]> {
    return (await this.calls()).filter((c) => c.kind === 'tool' && (name === undefined || c.name === name));
  }

  /** How many times a tool was called, counting only calls whose arguments contain `args` when given. */
  async called(name: string, args?: Record<string, unknown>): Promise<number> {
    return (await this.toolCalls(name)).filter((c) => args === undefined || argsMatch(c.args, args)).length;
  }

  /** The text of the last model response; null before one. */
  async answer(): Promise<string | null> {
    return (await this.read()).answer;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every expected value is present: objects partially, anything else exactly (as in `shadowlap test` checks). */
function argsMatch(actual: unknown, expected: unknown): boolean {
  if (isObject(expected)) return isObject(actual) && Object.entries(expected).every(([k, v]) => argsMatch(actual[k], v));
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => argsMatch(actual[i], v));
  return actual === expected;
}

const current = new AsyncLocalStorage<Recording>();

/** The recording of the test running now, inside `recorded()` or `withRecording()`. */
export function currentRecording(): Recording {
  const rec = current.getStore();
  if (!rec) throw new Error('shadowlap: no recording is running here. currentRecording() works inside a test wrapped in recorded() or withRecording().');
  return rec;
}

/** The replay sent a request its recording doesn't have. */
export class ShadowlapReplayDiverged extends Error {
  override readonly name = 'ShadowlapReplayDiverged';
  constructor(
    readonly result: RecordingResult,
    testError?: unknown,
  ) {
    const then = testError === undefined ? '' : `; the test then failed with ${errorLine(testError)}`;
    super(`${result.message}${then}\n\n${result.report ?? ''}`, testError === undefined ? undefined : { cause: testError });
  }
}

function errorLine(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const first = text.split('\n')[0] ?? '';
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}

export function recordMode(explicit?: RecordMode): RecordMode {
  const mode = explicit ?? (process.env.SHADOWLAP_RECORD || (process.env.CI ? 'none' : 'missing'));
  if (mode !== 'missing' && mode !== 'all' && mode !== 'none') throw new Error(`SHADOWLAP_RECORD must be missing, all or none, not ${mode}`);
  return mode;
}

async function post<T>(info: HostInfo, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${info.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      // not JSON
    }
    throw new Error(`shadowlap: ${message}`);
  }
  return JSON.parse(text) as T;
}

/** Runs `fn` as one recorded test. `fn` gets the recording, which `currentRecording()` also returns. */
export async function withRecording<T>(opts: RecordingOptions & { recording: string }, fn: (recording: Recording) => T | Promise<T>): Promise<T> {
  const raw = process.env[HOST_ENV];
  if (!raw) {
    if (process.env.SHADOWLAP_URL) {
      // Under shadowlap run or replay, which records everything in one run.
      const outer = new Recording(null, null, null, null);
      return current.run(outer, () => fn(outer));
    }
    throw new Error('shadowlap: recordings are not set up for this test run. With Vitest, add "@shadowlap/test/global-setup" to globalSetup and "@shadowlap/test/setup" to setupFiles; with node:test, run node --import @shadowlap/test/register --test.');
  }
  const info = JSON.parse(raw) as HostInfo;
  const started = await post<{ runId: string; mode: 'record' | 'replay'; recording: string }>(info, '/v1/recordings/start', {
    recording: opts.recording,
    slot: process.env[SLOT_ENV] ?? 'main',
    mode: recordMode(opts.mode),
    ...(opts.name ? { name: opts.name } : {}),
  });
  let value: T | undefined;
  let error: unknown;
  let failed = false;
  const rec = new Recording(info, started.runId, started.mode, started.recording);
  try {
    value = await current.run(rec, () => fn(rec));
  } catch (err) {
    failed = true;
    error = err;
  }
  const result = await post<RecordingResult>(info, '/v1/recordings/end', { runId: started.runId, passed: !failed });
  if (!result.ok) throw new ShadowlapReplayDiverged(result, failed ? error : undefined);
  if (result.message) console.warn(`shadowlap: ${result.message} (${result.recording})`);
  if (failed) throw error;
  return value as T;
}

interface VitestTask {
  name: string;
  suite?: VitestTask;
  file?: { filepath?: string };
}

/** The test's full name and file: from Vitest's test context, else from `expect.getState()` (Jest, Vitest globals). */
function currentTest(context: unknown): { name: string; file: string } | null {
  const task = (context as { task?: VitestTask } | undefined)?.task;
  if (task?.name && task.file?.filepath) {
    const names: string[] = [];
    for (let t: VitestTask | undefined = task; t; t = t.suite) if (t.name && t !== (task.file as unknown)) names.unshift(t.name);
    return { name: names.join(' > '), file: task.file.filepath };
  }
  const state = (globalThis as { expect?: { getState?: () => { currentTestName?: string; testPath?: string } } }).expect?.getState?.();
  if (state?.currentTestName && state.testPath) return { name: state.currentTestName, file: state.testPath };
  return null;
}

const NAME_LIMIT = 120;
const slug = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'test';

/** Which test made the recording in `dir`, from the command its run.json holds; null when there is none or it doesn't say. */
function recordedBy(dir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs?: Array<{ command?: { argv?: unknown } }> };
    const argv = manifest.runs?.at(-1)?.command?.argv;
    return Array.isArray(argv) && argv.length === 2 && argv[0] === '<test>' && typeof argv[1] === 'string' ? argv[1] : null;
  } catch {
    return null;
  }
}

/**
 * `__recordings__/<file>/<name>` beside the test file, one per test. A name is cut at 120 characters,
 * and one that was cut, or that would land on another test's recording (two names that differ only
 * in punctuation), ends in the first 8 hex digits of the sha256 of the test's full name. A long
 * name's recording made before it had the hash is used by the test that made it.
 */
function recordingFor(file: string, name: string, identity: string): string {
  const folder = join(dirname(file), '__recordings__', basename(file));
  const full = slug(name);
  const plain = full.slice(0, NAME_LIMIT);
  const hashed = `${plain}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
  if (full.length <= NAME_LIMIT) {
    const owner = recordedBy(join(folder, plain));
    return join(folder, owner !== null && owner !== identity ? hashed : plain);
  }
  if (!existsSync(join(folder, hashed, 'run.json')) && recordedBy(join(folder, plain)) === identity) return join(folder, plain);
  return join(folder, hashed);
}

/**
 * Wraps a test function so it runs as a recorded test. The recording is named after the test, and
 * lives beside the test file.
 */
export function recorded<A extends unknown[]>(fn: (...args: A) => unknown, opts: RecordingOptions = {}): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const test = currentTest(args[0]);
    const recording = opts.recording ?? (test ? recordingFor(test.file, test.name, opts.name ?? test.name) : undefined);
    if (!recording) throw new Error('shadowlap: could not tell which test is running; pass { recording: "path" } to recorded()');
    await withRecording({ ...opts, recording, ...(opts.name ?? test?.name ? { name: opts.name ?? test!.name } : {}) }, () => fn(...args));
  };
}
