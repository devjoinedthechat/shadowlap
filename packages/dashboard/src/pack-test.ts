import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONS, askConsent, commandIsImported, goldenNeedsConsent, goldenPath, hasRecordedCommand, importedCommandSource, quoteArgv, saidYes, setupJobArgs, type ProjectHost, type RunRecord } from '@shadowlap/engine';
import type { ProjectConfig, RouteContext } from './context.js';
import type { JobBuildContext, JobBuildResult, JobKind, JobRequest } from './jobs.js';
import { gateAsk, gateStep } from './pack-gate.js';
import { sessionBusy, testsBusy } from './routes/tests.js';
import { copyableRun, projectRoot } from './run-exports.js';
import { keptGoldenAsk, type LiveQuestion } from './tests-live.js';

/**
 * `pack-test`: a recording packed as a golden, then its test, as one job (`pack <run> <golden>`,
 * then `test <golden>`), leaving shadowlap.config.json as it is: a golden needs no entry under
 * "tests". With a `gate` (Pack with injection gate…), the job writes the golden's gate into its tests
 * entry between the two, against the version the page read (pack-gate.ts). Two ways in:
 *
 * - a run page's Pack as golden… (`runId`): any run that has ended, on every dashboard with a
 *   project folder, `shadowlap ui` in one included;
 * - the setup's recording (no `runId`), on a dashboard over several projects.
 *
 * The golden's folder is the engine's rule (`goldenPath`): a bare name goes under goldens/, and a
 * folder that holds another golden, or anything else, is refused. One that holds this run already is
 * tested alone, to run it again. It replays a golden, so it waits as Tests' jobs do, for one of them
 * and for a test session started elsewhere. A test the golden's tests entry runs live (marked fork,
 * or with an injection gate) asks first, as Run tests does (tests-live.ts `keptGoldenAsk`). A
 * recording this machine didn't make (pulled from the team store, unpacked from someone's pack) runs
 * its recorded command in the test, and the packed folder is one no repository tracks yet, so the
 * job asks first, as a replay of it does, and passes the test --yes once the request says yes to
 * that command (consent.ts): one question, naming what its test runs live too where it does.
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

/** What a question's words end on, which one that asks two things at once says once. */
const CONFIRM = 'Confirm it to run it';

/**
 * The yes a test of a recording from elsewhere waits for: its question as a replay of it asks (the
 * command it was recorded with, under `shadowlap test <golden>`), or null once the request said yes
 * to this one. Where its test runs the golden live too (`live`, the question Run tests would ask),
 * the one question says that too, and its yes is to both.
 */
export function packTestConsent(run: RunRecord, test: readonly string[], yes: unknown, live: LiveQuestion | null = null): { error: string; status: number; confirm: string; live?: LiveQuestion['live'] } | null {
  const lines = [run.command.argv, ['shadowlap', ...test], ...(live ? [['live', live.confirm]] : [])];
  if (saidYes(yes, lines)) return null;
  const also = live ? ` ${(live.error.endsWith(CONFIRM) ? live.error.slice(0, -CONFIRM.length) : `${live.error}.`).trim()}` : '';
  const asked = askConsent(`${run.runId.slice(0, 10)} came from ${importedCommandSource(run)}: its test runs the command it was recorded with (${quoteArgv(run.command.argv)}), under ${quoteArgv(['shadowlap', ...test])}.${also} ${CONFIRM}`, lines);
  return live ? { ...asked, live: live.live } : asked;
}

function anyRun(ctx: RouteContext, req: JobRequest, { store, project, projectId }: JobBuildContext): JobBuildResult {
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const run = copyableRun(store, req.runId);
  if ('error' in run) return run;
  const check = goldenPath(typeof req.golden === 'string' ? req.golden : '', { folder: root, runId: run.runId });
  if (!check.ok) return { error: check.error, status: check.taken ? 409 : 400 };
  // Pack with injection gate…: the gate is written once the run is packed, then tested (pack-gate.ts).
  const gate = gateAsk(req);
  if (gate && 'error' in gate) return gate;
  const busy = testsBusy(ctx.jobs.list(), projectId, PACK_VERB) ?? sessionBusy(store, PACK_VERB);
  if (busy) return { error: busy, status: 409 };
  const packed = packedAlready(root, check.path);
  const test = setupJobArgs.test(check.path);
  // A folder packed now is one no repository tracks, so a command from elsewhere asks first; a pack
  // there already asks as `shadowlap test` would of it.
  const needs = packed ? goldenNeedsConsent(run, join(root, check.path), root) : commandIsImported(run) && hasRecordedCommand(run);
  const tested = needs ? [...test, '--yes'] : test;
  const job = packed ? { args: tested, runId: run.runId, title: 'Testing the golden' } : { args: setupJobArgs.pack(run.runId, check.path), then: [tested], runId: run.runId, title: ACTIONS.packAsGolden.doing };
  const commands = [job.args, ...('then' in job ? job.then : [])];
  // The gate's write goes before the test: after the pack, or first when the folder holds this run's pack already.
  if (gate) Object.assign(job, { title: ACTIONS.packWithGate.doing, step: gateStep(ctx, root, check.path, gate, commands.length - 1) });
  // A test that runs the golden live asks first, as Run tests does: with the command from elsewhere, in one question.
  const asked = needs ? packTestConsent(run, test, req.yes, keptGoldenAsk(root, check.path, commands, undefined)) : keptGoldenAsk(root, check.path, commands, req.yes);
  return asked ?? job;
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
  const job = packed ? { args: setupJobArgs.test(check.path), runId: run.runId, title: 'Testing the golden' } : { args: setupJobArgs.pack(run.runId, check.path), then: [setupJobArgs.test(check.path)], runId: run.runId };
  // A test that runs the golden live (its tests entry marks it fork, or gives it an injection gate) asks first, as Run tests does.
  return keptGoldenAsk(entry.path, check.path, [job.args, ...('then' in job ? job.then : [])], req.yes) ?? job;
}
