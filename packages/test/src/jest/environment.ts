/**
 * Jest `testEnvironment`: Jest's Node environment, made ready for recorded tests. Jest runs each test
 * file in a sandbox with globals of its own and a copy of the process's environment, so this does in
 * the worker what Vitest's setup file does in a test's own context: it points the worker at its slot
 * on the host the global setup started and loads in-process capture there, then hands the sandbox
 * what a recorded test shares with capture: its switch, the store that carries scopes, and the
 * `fetch` capture wraps. A recorded test then records the clients its modules made when they were
 * imported, as under Vitest. Without the global setup (or under `shadowlap run`) it is Jest's Node
 * environment as it is.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { useHost } from '../host.js';
import { CAPTURE, captureState, HOST_ENV, LASTING, SLOT_ENV, workerSlot, type HostInfo } from '../slot.js';

interface JestEnvironment {
  global: Record<string | symbol, unknown>;
  setup(): Promise<void>;
  teardown(): Promise<void>;
}
type JestEnvironmentClass = new (config: never, context: never) => JestEnvironment;

/** Jest's Node environment, as the project that runs Jest has it. */
function nodeEnvironment(): JestEnvironmentClass {
  for (const from of [join(process.cwd(), 'package.json'), import.meta.url]) {
    try {
      const found = createRequire(from)('jest-environment-node') as { TestEnvironment?: JestEnvironmentClass; default?: JestEnvironmentClass };
      const cls = found.TestEnvironment ?? found.default;
      if (cls) return cls;
    } catch {
      // the next place
    }
  }
  throw new Error("@shadowlap/test/jest/environment builds on Jest's Node environment, and jest-environment-node isn't installed where Jest runs: install jest");
}

const SCOPES = Symbol.for('shadowlap.scope');

/** The worker's slot and capture: once per worker, whatever the number of test files it runs. */
let ready: Promise<void> | undefined;

export default class ShadowlapEnvironment extends nodeEnvironment() {
  override async setup(): Promise<void> {
    await super.setup();
    const raw = process.env[HOST_ENV];
    if (!raw) return;
    const slot = workerSlot();
    await (ready ??= useHost(JSON.parse(raw) as HostInfo, slot));
    const sandbox = this.global as Record<string | symbol, unknown> & { process?: { env?: Record<string, string | undefined> } };
    // The sandbox's environment is a copy, made before this ran: what a recorded test reads goes in it.
    const env = sandbox.process?.env;
    if (env) {
      env[HOST_ENV] = raw;
      env[SLOT_ENV] = slot;
      for (const key of LASTING) if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    sandbox[CAPTURE] = captureState();
    const g = globalThis as Record<symbol, unknown>;
    sandbox[SCOPES] = g[SCOPES] ??= new AsyncLocalStorage<string>();
    if (typeof globalThis.fetch === 'function') sandbox.fetch = globalThis.fetch;
  }
}
