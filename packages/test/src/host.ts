import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

/** What `shadowlap serve --recordings` prints when it is ready. */
export interface HostInfo {
  shadowlap: string;
  /** The sidecar, including its session token. */
  url: string;
  /** The project directory recordings must live in. */
  root: string;
  /** Environment for a worker, with `__SLOT__` where the worker's slot goes. */
  env: Record<string, string>;
  capture: { node: string; python: string };
}

/** Set by the global setup for workers, as JSON. */
export const HOST_ENV = 'SHADOWLAP_TEST_HOST';
export const SLOT_ENV = 'SHADOWLAP_TEST_SLOT';

export interface RunningHost {
  info: HostInfo;
  close(): Promise<void>;
}

function cliPath(): string {
  if (process.env.SHADOWLAP_CLI) return process.env.SHADOWLAP_CLI;
  return createRequire(import.meta.url).resolve('shadowlap/bin/shadowlap.js');
}

/** Starts `shadowlap serve --recordings` in `root` and waits for it. It exits when this process does. */
export function startHost(root: string = process.cwd(), opts: { keepProcessAlive?: boolean } = {}): Promise<RunningHost> {
  const child: ChildProcess = spawn(process.execPath, [cliPath(), 'serve', '--recordings'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('shadowlap serve --recordings did not start within 60 seconds'));
    }, 60_000);
    const fail = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    child.once('error', (err) => fail(new Error(`could not start the shadowlap CLI: ${err.message}`)));
    child.once('exit', (code) => fail(new Error(`shadowlap serve --recordings exited before it was ready (exit code ${code})`)));
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      child.stdout!.removeAllListeners('data');
      let info: HostInfo;
      try {
        info = JSON.parse(out.slice(0, nl)) as HostInfo;
      } catch {
        return fail(new Error(`shadowlap serve --recordings printed something unexpected: ${out.slice(0, 200)}`));
      }
      if (!opts.keepProcessAlive) {
        // The host lives as long as this process and never holds it open; it exits when its stdin closes.
        child.unref();
        (child.stdin as Socket).unref();
        (child.stdout as Socket).unref();
      }
      resolve({
        info,
        close: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null) return done();
            child.once('exit', () => done());
            child.stdin!.end();
          }),
      });
    });
  });
}

/** In-process capture's switch, shared with the preload, which reads it on every call. */
function captureState(): { active: boolean } {
  const g = globalThis as { [CAPTURE]?: { active: boolean } };
  return (g[CAPTURE] ??= { active: true });
}
const CAPTURE = Symbol.for('shadowlap.capture');

/** Kept for good: the loopback stays out of any proxy whether or not a recorded test runs. */
const LASTING = new Set(['NO_PROXY', 'no_proxy']);

/**
 * Points this process's model clients and the Shadowlap SDK at the host, under `slot`, and turns
 * in-process capture on, until the returned function puts back the variables as they were and turns
 * capture off. A recorded test runs between the two; a test without a recording sees the process as
 * it was, and calls its model and tools directly.
 */
export function pointAtSlot(info: HostInfo, slot: string): () => void {
  const before = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(info.env)) {
    if (LASTING.has(key)) continue;
    before.set(key, process.env[key]);
    process.env[key] = value.replace('__SLOT__', slot);
  }
  const capture = captureState();
  capture.active = true;
  return () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    capture.active = false;
  };
}

/**
 * Makes this process ready for recorded tests under `slot`: names the host for them, keeps the
 * loopback out of any proxy, and loads in-process capture, which reads its configuration as it loads
 * and stays off until a recorded test starts (see pointAtSlot).
 */
export async function useHost(info: HostInfo, slot: string): Promise<void> {
  process.env[HOST_ENV] = JSON.stringify(info);
  process.env[SLOT_ENV] = slot;
  for (const key of LASTING) if (info.env[key] !== undefined) process.env[key] = info.env[key];
  const restore = pointAtSlot(info, slot);
  try {
    await import(pathToFileURL(info.capture.node).href);
  } finally {
    restore();
  }
}

/** The worker's slot: one per test worker that can run at the same time. */
export function workerSlot(): string {
  const id = process.env.VITEST_POOL_ID ?? process.env.JEST_WORKER_ID;
  return id ? `worker-${id}` : 'main';
}
