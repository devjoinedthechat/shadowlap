/** Jest `globalTeardown`: stops the host `@shadowlap/test/jest/global-setup` started. */
import type { RunningHost } from '../host.js';
import { RUNNING } from './global-setup.js';

export default async function globalTeardown(): Promise<void> {
  const g = globalThis as Record<symbol, RunningHost | undefined>;
  const host = g[RUNNING];
  delete g[RUNNING];
  await host?.close();
}
