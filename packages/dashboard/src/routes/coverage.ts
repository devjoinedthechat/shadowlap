import { ACTIONS } from '@shadowlap/engine';
import type { RouteContext } from '../context.js';
import { coveragePackArgs, coverageView } from '../coverage.js';
import type { Router } from '../router.js';
import { sessionBusy, testsBusy } from './tests.js';

/**
 * Production coverage: the last `shadowlap coverage` scan (`GET /api/coverage`), for Tests' Not
 * covered panel and the line Needs a look shows, and the jobs that scan again and pack goldens:
 *
 *   coverage        {}                                        scan again: the imported runs and the goldens on disk
 *   coverage-pack   { key?, command?, confirmed?, fork?, expect? }
 *                                                             `coverage --pack`: a golden of one run of the behaviour
 *                                                             (or of each no golden covers), reproduced with the
 *                                                             agent's command a run here says, or the one typed;
 *                                                             with fork and expect, a golden that forks
 *
 * A typed command is the agent's own, after `--`, split without a shell, and it runs only once the
 * person confirmed it, as a recording's command does: the first time it runs in a folder (remembered
 * with the folder's other confirmed commands, when the dashboard keeps a project list), and every
 * time on a dashboard that serves one store. Packing writes goldens, so it waits for a test session,
 * an update or another pack to finish, as they wait for it.
 */
export const COVERAGE_JOB_KINDS = { scan: 'coverage', pack: 'coverage-pack' } as const;

const sameArgv = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function register(router: Router, ctx: RouteContext): void {
  router.get('/coverage', (r) => r.tagged(coverageView(ctx.store)));

  ctx.jobs.registerJobKind(COVERAGE_JOB_KINDS.scan, {
    title: () => ACTIONS.rescanCoverage.doing,
    build: () => ({ args: ['coverage'] }),
  });
  ctx.jobs.registerJobKind(COVERAGE_JOB_KINDS.pack, {
    title: () => 'Packing goldens',
    build: (req, { store, projectId }) => {
      const built = coveragePackArgs(store, req);
      if ('error' in built) return built;
      const busy = testsBusy(ctx.jobs.list(), projectId, 'pack it') ?? sessionBusy(store, 'pack it');
      if (busy) return { error: busy, status: 409 };
      if (!built.command) return { args: built.args, title: built.title };
      // Confirmed in this folder before (to record or to pack): it runs without asking again.
      const projects = ctx.options.projects ?? null;
      const entry = projects && projectId ? (projects.list().find((p) => p.id === projectId) ?? null) : null;
      const known = !!entry?.confirmed.some((c) => sameArgv(c.argv, built.command!));
      if (!known && req.confirmed !== true) {
        return { error: `Run this command in ${entry ? 'this project’s folder' : 'this folder'}? Packing starts your agent with it for each capture, offline, with writes stubbed: shadowlap ${built.args.join(' ')}. Confirm it first.`, status: 409 };
      }
      const remember = projects && projectId && !known ? () => void projects.confirmCommand(projectId, { argv: built.command!, upstream: null }) : undefined;
      return { args: built.args, title: built.title, ...(remember ? { started: remember } : {}) };
    },
  });
}
