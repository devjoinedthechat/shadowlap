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

/** Points this process's model clients and the Shadowlap SDK at the host, under `slot`, and loads in-process capture. */
export async function useHost(info: HostInfo, slot: string): Promise<void> {
  for (const [key, value] of Object.entries(info.env)) process.env[key] = value.replace('__SLOT__', slot);
  process.env[HOST_ENV] = JSON.stringify(info);
  process.env[SLOT_ENV] = slot;
  await import(pathToFileURL(info.capture.node).href);
}

/** The worker's slot: one per test worker that can run at the same time. */
export function workerSlot(): string {
  const id = process.env.VITEST_POOL_ID ?? process.env.JEST_WORKER_ID;
  return id ? `worker-${id}` : 'main';
}
