import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { HOST_ENV, LASTING, pointAtSlot, SLOT_ENV, type HostInfo } from './slot.js';

export { HOST_ENV, SLOT_ENV, pointAtSlot, workerSlot, type HostInfo } from './slot.js';

export interface RunningHost {
  info: HostInfo;
  close(): Promise<void>;
}

/**
 * The CLI the host runs: SHADOWLAP_CLI, or the `shadowlap` command of the CLI package this one
 * depends on, as that package's manifest names it (the package exports its module and its manifest,
 * no file inside it).
 */
export function cliPath(): string {
  if (process.env.SHADOWLAP_CLI) return process.env.SHADOWLAP_CLI;
  const manifest = createRequire(import.meta.url).resolve('shadowlap/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { shadowlap: string } };
  return join(dirname(manifest), bin.shadowlap);
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
    // One a signal ended has no exit code, only the signal.
    child.once('exit', (code, signal) => fail(new Error(`shadowlap serve --recordings exited before it was ready (${code === null ? `signal ${signal!}` : `exit code ${code}`})`)));
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
