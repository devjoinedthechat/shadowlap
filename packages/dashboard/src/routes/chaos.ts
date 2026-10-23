import { commandIsImported, hasRecordedCommand, importedCommandSource } from '@shadowlap/engine';
import { describeEvent } from '../activity.js';
import { lookupRun } from '../api.js';
import { chaosFlags, chaosOfRun, chaosView } from '../chaos.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { links } from '../links.js';
import type { Router } from '../router.js';
import { sessionBusy, testsBusy } from './tests.js';

/**
 * Error-path presets: every recording's matrix and the newest sessions (`GET /api/chaos`), one
 * run's matrix (`GET /api/chaos/runs/:id`: a preset's attempt opens on its recording's), and the job
 * that runs them:
 *
 *   chaos   { golden, presets?, tool? }            `test <golden> --chaos`: a golden on disk
 *           { runId, presets?, tool?, confirmed? }  `replay <run> --chaos`; a run whose command came
 *                                                   from a pack or the team store runs only confirmed
 *
 * On a golden, the presets replay its pack: they wait for a test session, an update of goldens or
 * a pack to finish, as those wait for them.
 */
export const CHAOS_JOB_KIND = 'chaos';

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// The activity feed: a session of presets, by how they came out; on one run, it opens that run. One
// with an inconclusive preset and no failure reads in amber, as a test session's does.
describeEvent('chaos.session', (e, d) => {
  const failed = count(d.failed);
  const inconclusive = count(d.inconclusive);
  const parts = [`${count(d.passed)} passed`, `${failed} failed`, ...(inconclusive ? [`${inconclusive} inconclusive`] : [])];
  return { kind: failed ? 'fail' : inconclusive ? 'warn' : 'test', text: `Error-path presets ${d.interrupted === true ? 'stopped' : 'ran'} · ${parts.join(', ')}`, href: e.runId ? links.run(e.runId) : links.tests() };
});

export function register(router: Router, ctx: RouteContext): void {
  router.get('/chaos', (r) => r.tagged(chaosView(ctx.store)));

  router.get('/chaos/runs/:id', (r) => {
    const run = lookupRun(ctx.store, r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id}`);
    r.tagged({ runId: run.runId, matrix: chaosOfRun(ctx.store, run.runId) });
  });

  ctx.jobs.registerJobKind(CHAOS_JOB_KIND, {
    title: () => 'Running error-path presets',
    build: (req, { store, projectId }) => {
      const flags = chaosFlags(req);
      if ('error' in flags) return flags;
      if (typeof req.golden === 'string') {
        const goldens = ctx.options.goldens?.() ?? [];
        if (!goldens.some((g) => g.path === req.golden)) return { error: `no golden ${req.golden} on disk` };
        const busy = testsBusy(ctx.jobs.list(), projectId, 'run its presets') ?? sessionBusy(store, 'run its presets');
        if (busy) return { error: busy, status: 409 };
        return { args: ['test', req.golden, '--chaos', ...flags] };
      }
      if (typeof req.runId !== 'string' || !req.runId) return { error: 'name a golden or a run' };
      const run = lookupRun(store, req.runId);
      if (!run) return { error: `unknown run ${req.runId}` };
      if (run.status === 'running') return { error: 'the run is still recording: run the presets once it has ended' };
      if (!hasRecordedCommand(run)) return { error: 'A capture has no command. Replay it with yours first; the presets run on that replay.' };
      const imported = commandIsImported(run);
      if (imported && req.confirmed !== true) return { error: `This run came from ${importedCommandSource(run)}: each preset runs its command (${run.command.argv.join(' ')}). Confirm to run it.`, status: 409 };
      return { args: ['replay', run.runId, '--chaos', ...flags, ...(imported ? ['--yes'] : [])], runId: run.runId };
    },
  });
}
