import { ACTIONS, askConsent, commandIsImported, hasRecordedCommand, importedCommandSource, quoteArgv, saidYes } from '@shadowlap/engine';
import { lookupRun } from '../api.js';
import { chaosFlags, chaosOfRun, chaosView } from '../chaos.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { optionLike } from '../tests.js';
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

export function register(router: Router, ctx: RouteContext): void {
  router.get('/chaos', (r) => r.tagged(chaosView(ctx.store)));

  router.get('/chaos/runs/:id', (r) => {
    const run = lookupRun(ctx.store, r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id!}`);
    r.tagged({ runId: run.runId, matrix: chaosOfRun(ctx.store, run.runId) });
  });

  ctx.jobs.registerJobKind(CHAOS_JOB_KIND, {
    title: () => ACTIONS.runPresets.doing,
    build: (req, { store, projectId }) => {
      const flags = chaosFlags(req);
      if ('error' in flags) return flags;
      if (typeof req.golden === 'string') {
        const goldens = ctx.options.goldens?.() ?? [];
        if (!goldens.some((g) => g.path === req.golden)) return { error: `no golden ${req.golden} on disk` };
        // A path that starts with "-" would be read as one of the CLI's options, never as a golden.
        if (optionLike(req.golden)) return { error: `${req.golden.slice(0, 80)}: its path starts with "-", which the CLI would read as an option: rename it under "tests" in shadowlap.config.json` };
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
      const args = ['replay', run.runId, '--chaos', ...flags];
      // The yes is to the lines the question showed (consent.ts): the run's command and the presets'
      // own line, so a yes to one preset runs no other, and none an injection test of the run.
      const lines = [run.command.argv, ['shadowlap', ...args]];
      if (imported && !saidYes(req.confirmed, lines)) return askConsent(`This run came from ${importedCommandSource(run)}: each preset runs its command (${quoteArgv(run.command.argv)}), under ${quoteArgv(['shadowlap', ...args])}. Confirm to run it.`, lines);
      return { args: [...args, ...(imported ? ['--yes'] : [])], runId: run.runId };
    },
  });
}
