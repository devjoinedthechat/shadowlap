import type { RouteContext } from '../context.js';
import { coveragePackArgs, coverageView } from '../coverage.js';
import type { Router } from '../router.js';

/**
 * Production coverage: the last `shadowlap coverage` scan (`GET /api/coverage`), for Tests' Not
 * covered panel and the line Needs a look shows, and the jobs that scan again and pack goldens:
 *
 *   coverage        {}                         scan again: the imported runs and the goldens on disk
 *   coverage-pack   { key?, command? }         `coverage --pack`: a golden of one run of the behaviour
 *                                              (or of each no golden covers), reproduced with the
 *                                              agent's command as typed, or the one a recording here says
 */
export const COVERAGE_JOB_KINDS = { scan: 'coverage', pack: 'coverage-pack' } as const;

export function register(router: Router, ctx: RouteContext): void {
  router.get('/coverage', (r) => r.tagged(coverageView(ctx.store)));

  ctx.jobs.registerJobKind(COVERAGE_JOB_KINDS.scan, {
    title: () => 'Reading coverage',
    build: () => ({ args: ['coverage'] }),
  });
  ctx.jobs.registerJobKind(COVERAGE_JOB_KINDS.pack, {
    title: () => 'Packing goldens',
    build: (req, { store }) => {
      const built = coveragePackArgs(store, req);
      return 'error' in built ? built : { args: built.args, title: built.title };
    },
  });
}
