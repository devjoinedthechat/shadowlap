import { ACTIONS, askConsent, commandIsImported, goldensNeedingConsent, hasRecordedCommand, importedCommandSource, parsePresets, presetsTarget, quoteArgv, saidYes, type RunRecord } from '@shadowlap/engine';
import { gitIndexStamp } from '../git-index.js';
import { lookupRun, noSuchRun } from '../api.js';
import { chaosFlags, chaosOfRun } from '../chaos.js';
import type { RouteContext } from '../context.js';
import { expectArgs } from '../expect-field.js';
import { HttpError } from '../http.js';
import { outcomeWork } from '../outcome-work.js';
import type { PresetsPlanJob } from '../presets-plan.js';
import { sendAnswerTagged } from '../read-pool.js';
import { runAffinity } from '../run-index.js';
import { runTag } from '../run-version.js';
import { optionLike } from '../tests.js';
import type { Router } from '../router.js';
import { sessionBusy, testsBusy } from './tests.js';
import { namesTeamStore } from './verdicts.js';

/**
 * Error-path presets: one run's matrix (`GET /api/chaos/runs/:id`: a preset's attempt opens on its
 * recording's), Run error-path presets…'s plan (`GET /api/chaos/runs/:id/plan`), and the job that
 * runs them:
 *
 *   chaos   { golden, presets?, tool?,           `test <golden> --chaos`: a golden on disk; one from a pack the
 *             confirmed? }                         repository doesn't track runs only confirmed
 *           { runId, presets?, tool?, expect?,     `replay <run> --chaos`, judged by `--expect` when given
 *             confirmed? }                         (checked as the CLI checks it); a run whose command came
 *                                                   from a pack or the team store runs only confirmed
 *
 * On a golden, the presets replay its pack: they wait for a test session, an update of goldens or
 * a pack to finish, as those wait for them.
 */
export const CHAOS_JOB_KIND = 'chaos';

/**
 * The plan's job: the picks checked as the job checks them, and what the server reads first (the
 * config's tests and goldens, `mcp.effects` and whether names show). Whether a golden's pack is one
 * the repository tracks is read beside the server, so `tracking` stamps the repository's index for
 * the plan's tag: a recording no golden holds needs none.
 */
function presetsPlanJob(ctx: RouteContext, run: RunRecord, query: URLSearchParams): { job: PresetsPlanJob; tracking: string } | { error: string } {
  const presets = query.get('presets');
  const tool = query.get('tool');
  const flags = chaosFlags({ ...(presets !== null ? { presets: presets ? presets.split(',') : [] } : {}), ...(tool ? { tool } : {}) });
  if ('error' in flags) return flags;
  const work = outcomeWork(ctx);
  const golden = work?.goldens.find((g) => g.runId === presetsTarget(run));
  let effects: Record<string, string> | undefined;
  try {
    effects = ctx.config().mcp?.effects;
  } catch {
    effects = undefined;
  }
  const job: PresetsPlanJob = {
    kind: 'presets-plan',
    runId: run.runId,
    ...(presets !== null ? { presets: parsePresets(presets ? presets.split(',') : [], 'presets') } : {}),
    ...(tool ? { tool } : {}),
    ...(query.get('expect') === '1' ? { expect: true } : {}),
    work,
    ...(effects ? { effects } : {}),
    shared: namesTeamStore(ctx.project?.path),
    ...(ctx.read.prices ? { prices: ctx.read.prices } : {}),
  };
  return { job, tracking: golden && work ? gitIndexStamp(work.dir) : '' };
}

export function register(router: Router, ctx: RouteContext): void {
  router.get('/chaos/runs/:id', (r) => {
    const run = lookupRun(ctx.store, r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id!}`);
    r.tagged({ runId: run.runId, matrix: chaosOfRun(ctx.store, run.runId) });
  });

  // Run error-path presets…'s plan for the picks (`presets=timeout,429`, `tool=`, `expect=1` while the
  // field has checks): a pooled read of the recording's calls, revalidated from where it stands.
  router.get('/chaos/runs/:id/plan', async (r) => {
    const run = lookupRun(ctx.store, r.params.id!);
    if (!run) {
      const no = noSuchRun(ctx.store, r.params.id!);
      throw new HttpError(no.status, no.message);
    }
    const asked = presetsPlanJob(ctx, run, r.query);
    if ('error' in asked) throw new HttpError(400, asked.error);
    const { job, tracking } = asked;
    const tag = runTag(ctx.store, run.runId, () => JSON.stringify([ctx.read, job, tracking]));
    await sendAnswerTagged(r, tag, () => ctx.reads.run(job, runAffinity(ctx.store, run.runId)));
  });

  ctx.jobs.registerJobKind(CHAOS_JOB_KIND, {
    title: () => ACTIONS.runPresets.doing,
    build: (req, { store, project, projectId }) => {
      const flags = chaosFlags(req);
      if ('error' in flags) return flags;
      if (typeof req.golden === 'string') {
        if (req.expect !== undefined && req.expect !== null && req.expect !== '') return { error: "expect goes with a run: a golden's presets are judged by its chaos.expect or the write limits of its expect" };
        const goldens = ctx.options.goldens?.() ?? [];
        if (!goldens.some((g) => g.path === req.golden)) return { error: `no golden ${req.golden} on disk` };
        // A path that starts with "-" would be read as one of the CLI's options, never as a golden.
        if (optionLike(req.golden)) return { error: `${req.golden.slice(0, 80)}: its path starts with "-", which the CLI would read as an option: rename it under "tests" in shadowlap.config.json` };
        const busy = testsBusy(ctx.jobs.list(), projectId, 'run its presets') ?? sessionBusy(store, 'run its presets');
        if (busy) return { error: busy, status: 409 };
        const args = ['test', req.golden, '--chaos', ...flags];
        // A golden from a pack the repository doesn't track runs the command it was recorded with only with a yes, as `test` asks of one.
        const sent = goldensNeedingConsent(store, [req.golden], project?.path ?? process.cwd())[0];
        if (!sent) return { args };
        const theirs = [sent.argv, ['shadowlap', ...args]];
        if (!saidYes(req.confirmed, theirs)) return askConsent(`${req.golden} is from a pack this repository doesn't track: each preset runs the command it was recorded with (${quoteArgv(sent.argv)}), under ${quoteArgv(['shadowlap', ...args])}. Confirm to run it.`, theirs);
        return { args: [...args, '--yes'] };
      }
      if (typeof req.runId !== 'string' || !req.runId) return { error: 'name a golden or a run' };
      const run = lookupRun(store, req.runId);
      if (!run) return { error: `unknown run ${req.runId}` };
      if (run.status === 'running') return { error: 'the run is still recording: run the presets once it has ended' };
      if (!hasRecordedCommand(run)) return { error: 'A capture has no command. Replay it with yours first; the presets run on that replay.' };
      const expect = expectArgs(req.expect);
      if ('error' in expect) return expect;
      const imported = commandIsImported(run);
      const args = ['replay', run.runId, '--chaos', ...flags, ...expect.args];
      // The yes is to the lines the question showed (consent.ts): the run's command and the presets'
      // own line, so a yes to one preset runs no other, and none an injection test of the run.
      const lines = [run.command.argv, ['shadowlap', ...args]];
      if (imported && !saidYes(req.confirmed, lines)) return askConsent(`This run came from ${importedCommandSource(run)}: each preset runs its command (${quoteArgv(run.command.argv)}), under ${quoteArgv(['shadowlap', ...args])}. Confirm to run it.`, lines);
      return { args: [...args, ...(imported ? ['--yes'] : [])], runId: run.runId };
    },
  });
}
