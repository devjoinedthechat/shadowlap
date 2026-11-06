import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONS, askConsent, commandIsImported, goldenNeedsConsent, goldenPath, hasRecordedCommand, importedCommandSource, quoteArgv, saidYes, setupJobArgs, type ProjectHost, type RunRecord } from '@shadowlap/engine';
import type { ProjectConfig, RouteContext } from './context.js';
import type { JobBuildContext, JobBuildResult, JobKind, JobRequest } from './jobs.js';
import { sessionBusy, testsBusy } from './routes/tests.js';
import { copyableRun, projectRoot } from './run-exports.js';

/**
 * `pack-test`: a recording packed as a golden, then its test, as one job (`pack <run> <golden>`,
 * then `test <golden>`), leaving shadowlap.config.json as it is: a golden needs no entry under
 * "tests". Two ways in:
 *
 * - a run page's Pack as golden… (`runId`): any run that has ended, on every dashboard with a
 *   project folder, `shadowlap ui` in one included;
 * - the setup's recording (no `runId`), on a dashboard over several projects.
 *
 * The golden's folder is the engine's rule (`goldenPath`): a bare name goes under goldens/, and a
 * folder that holds another golden, or anything else, is refused. One that holds this run already is
 * tested alone, to run it again. It replays a golden, so it waits as Tests' jobs do, for one of them
 * and for a test session started elsewhere. A recording this machine didn't make (pulled from the
 * team store, unpacked from someone's pack) runs its recorded command in the test, and the packed
 * folder is one no repository tracks yet, so the job asks first, as a replay of it does, and passes
 * the test --yes once the request says yes to that command (consent.ts).
 */

const KEEP_VERB = 'keep it as a test';
const PACK_VERB = 'pack it';

/** The job kind, for any run, and for the setup's recording where `setup` holds the projects. */
export function packTestKind(ctx: RouteContext, setup: ProjectHost<ProjectConfig> | null): JobKind {
  return {
    title: () => 'Packing and testing',
    build: (req, place) => (req.runId === undefined && setup ? setupRun(ctx, setup, req, place) : anyRun(ctx, req, place)),
  };
}

/** Whether a golden's folder the engine passed holds something: then it is a pack of this run (`goldenPath` refuses any other). */
function packedAlready(root: string, path: string): boolean {
  try {
    return readdirSync(join(root, path)).length > 0;
  } catch {
    return false;
  }
}

/**
 * The yes a test of a recording from elsewhere waits for: its question as a replay of it asks (the
 * command it was recorded with, under `shadowlap test <golden>`), or null once the request said yes
 * to this one.
 */
export function packTestConsent(run: RunRecord, test: readonly string[], yes: unknown): { error: string; status: number; confirm: string } | null {
  const lines = [run.command.argv, ['shadowlap', ...test]];
  if (saidYes(yes, lines)) return null;
  return askConsent(`${run.runId.slice(0, 10)} came from ${importedCommandSource(run)}: its test runs the command it was recorded with (${quoteArgv(run.command.argv)}), under ${quoteArgv(['shadowlap', ...test])}. Confirm it to run it`, lines);
}

function anyRun(ctx: RouteContext, req: JobRequest, { store, project, projectId }: JobBuildContext): JobBuildResult {
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const run = copyableRun(store, req.runId);
  if ('error' in run) return run;
  const check = goldenPath(typeof req.golden === 'string' ? req.golden : '', { folder: root, runId: run.runId });
  if (!check.ok) return { error: check.error, status: check.taken ? 409 : 400 };
  const busy = testsBusy(ctx.jobs.list(), projectId, PACK_VERB) ?? sessionBusy(store, PACK_VERB);
  if (busy) return { error: busy, status: 409 };
  const packed = packedAlready(root, check.path);
  const test = setupJobArgs.test(check.path);
  // A folder packed now is one no repository tracks, so a command from elsewhere asks first; a pack
  // there already asks as `shadowlap test` would of it.
  const needs = packed ? goldenNeedsConsent(run, join(root, check.path), root) : commandIsImported(run) && hasRecordedCommand(run);
  const asked = needs ? packTestConsent(run, test, req.yes) : null;
  if (asked) return asked;
  const tested = needs ? [...test, '--yes'] : test;
  if (packed) return { args: tested, runId: run.runId, title: 'Testing the golden' };
  return { args: setupJobArgs.pack(run.runId, check.path), then: [tested], runId: run.runId, title: ACTIONS.packAsGolden.doing };
}

/** Keep it as a test: the setup's recording packed as a golden, then its test; once it is packed (here or in a terminal), the test alone. */
function setupRun(ctx: RouteContext, h: ProjectHost<ProjectConfig>, req: JobRequest, place: JobBuildContext): JobBuildResult {
  const { store, projectId } = place;
  if (!projectId) return anyRun(ctx, req, place);
  const entry = h.list().find((p) => p.id === projectId);
  if (!entry) return { error: `No project ${projectId}.`, status: 404 };
  if (typeof req.project === 'string' && req.project && req.project !== projectId) return { error: `The dashboard switched to ${projectId}. Open ${req.project} again to keep its golden.`, status: 409 };
  const setup = h.setup(projectId);
  const run = setup.run;
  if (!run || setup.live || !setup.steps.recorded) return { error: 'Record a first run before you keep it as a test.', status: 409 };
  const asked = typeof req.golden === 'string' && req.golden.trim() ? req.golden : (setup.golden ?? '');
  const check = goldenPath(asked, { folder: entry.path, runId: run.runId });
  if (!check.ok) return { error: check.error };
  // It replays a golden, so it waits as Tests' jobs do: for one of them in this project, and for a
  // test session started in a terminal or another dashboard.
  const busy = testsBusy(ctx.jobs.list(), projectId, KEEP_VERB) ?? sessionBusy(store, KEEP_VERB);
  if (busy) return { error: busy, status: 409 };
  const packed = h.context(projectId).packs().some((p) => p.path === check.path && p.runIds.includes(run.runId));
  if (packed) return { args: setupJobArgs.test(check.path), runId: run.runId, title: 'Testing the golden' };
  return { args: setupJobArgs.pack(run.runId, check.path), then: [setupJobArgs.test(check.path)], runId: run.runId };
}
