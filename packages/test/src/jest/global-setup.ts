/**
 * Jest `globalSetup`: starts one shadowlap host for the whole run, before Jest starts its workers,
 * which inherit its address through the environment. Pair it with
 * `@shadowlap/test/jest/global-teardown`, which stops it, and `@shadowlap/test/jest/environment` as
 * the test environment.
 */
import { HOST_ENV, startHost, type RunningHost } from '../host.js';

/** The host, for the teardown: Jest runs both in its own process. */
export const RUNNING = Symbol.for('shadowlap.test.jest.host');

export default async function globalSetup(): Promise<void> {
  if (process.env.SHADOWLAP_URL && !process.env[HOST_ENV]) return; // under `shadowlap run` or `replay`, which records every test
  const host = await startHost(process.cwd(), { keepProcessAlive: true });
  process.env[HOST_ENV] = JSON.stringify(host.info);
  (globalThis as Record<symbol, RunningHost | undefined>)[RUNNING] = host;
}
