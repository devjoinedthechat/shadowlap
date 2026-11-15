/**
 * Vitest `globalSetup`: starts one shadowlap host for the whole run, before the workers start, and
 * stops it at the end. Pair it with `@shadowlap/test/setup` in `setupFiles`.
 */
import { HOST_ENV, startHost } from './host.js';

export default async function setup(): Promise<() => Promise<void>> {
  if (process.env.SHADOWLAP_URL && !process.env[HOST_ENV]) {
    // Under `shadowlap run` or `replay`: that run records everything, tests included.
    return async () => {};
  }
  const host = await startHost(process.cwd(), { keepProcessAlive: true });
  process.env[HOST_ENV] = JSON.stringify(host.info);
  return () => host.close();
}
