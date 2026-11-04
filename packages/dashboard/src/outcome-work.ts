import { statSync } from 'node:fs';
import { isObject, readConfigFile } from '@shadowlap/engine';
import type { RouteContext } from './context.js';
import type { OutcomeWork } from './run-outcome.js';
import { goldensOf } from './routes/overview.js';

/**
 * What the server reads of the project, on its own thread, for the read models to judge runs by the
 * checks they were not given (run-outcome.ts): the config's version and its `tests` as written, when
 * it was last written, and the goldens on disk with the run each pack holds. Null outside a project,
 * or while its config can't be read: then only runs' own verdicts, and those kept on captures, say
 * anything.
 */
export function outcomeWork(ctx: RouteContext): OutcomeWork | null {
  const dir = ctx.project?.path;
  if (!dir) return null;
  let file: ReturnType<typeof readConfigFile>;
  try {
    file = readConfigFile(dir);
  } catch {
    return null;
  }
  let changedAt: number | null = null;
  try {
    changedAt = file.exists ? Math.floor(statSync(file.path).mtimeMs) : null;
  } catch {
    // gone since it was read: as without one
  }
  return {
    version: file.version,
    tests: isObject(file.data) ? file.data.tests : undefined,
    dir,
    changedAt,
    goldens: goldensOf(ctx).map((g) => ({ path: g.path, runId: g.runId, packedAt: g.packedAt })),
    ...(ctx.read.prices ? { prices: ctx.read.prices } : {}),
  };
}
