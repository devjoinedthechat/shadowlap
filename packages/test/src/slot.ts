/**
 * What a recorded test needs of the host at run time: the host's address, the worker's slot, and
 * pointing this process at the slot while a recorded test runs. Nothing here loads a module at run
 * time, so it also compiles to the CommonJS copy test runners with a loader of their own require.
 */

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

/** In-process capture's switch, shared with the preload, which reads it on every call. */
export function captureState(): { active: boolean } {
  const g = globalThis as { [CAPTURE]?: { active: boolean } };
  return (g[CAPTURE] ??= { active: true });
}
export const CAPTURE = Symbol.for('shadowlap.capture');

/** Kept for good: the loopback stays out of any proxy whether or not a recorded test runs. */
export const LASTING = new Set(['NO_PROXY', 'no_proxy']);

/**
 * Points this process's model clients and the shadowlap SDK at the host, under `slot`, and turns
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

/** The worker's slot: one per test worker that can run at the same time. */
export function workerSlot(): string {
  const id = process.env.VITEST_POOL_ID ?? process.env.JEST_WORKER_ID;
  return id ? `worker-${id}` : 'main';
}
