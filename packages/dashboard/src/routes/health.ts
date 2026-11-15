import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';

/**
 * Settings → Project's Health: the job kind `doctor` runs `shadowlap doctor`, which checks the
 * environment, the store and the configuration as support would, each problem with what to do. Its
 * drawer shows the checks as the CLI prints them, and its result (on fd 3) is the checks themselves,
 * as `doctor --json` prints them, which the page lists. It changes nothing, and asks no provider.
 */
export function register(_router: Router, ctx: RouteContext): void {
  ctx.jobs.registerJobKind('doctor', {
    title: () => 'Checking setup',
    build: () => ({ args: ['doctor'] }),
  });
}
