import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { ProjectError, calibrationOutcome, checkFolder, goldenPath, runTotals, setupJobArgs, suggestFolders, tildePath, type CalibrationOutcome, type ProjectEntry, type ProjectHost, type StoreFacts } from '@shadowlap/engine';
import { parseStoreUrl, storeKey } from '@shadowlap/remote';
import type { ProjectConfig, RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { JobNotice } from '../jobs.js';
import { addedMessage, addProjectPage, projectSwitcher, removeDialog, setupView, type PickedFolder, type SetupView } from '../projects.js';
import { answerData } from '../read-pool.js';
import type { Router } from '../router.js';
import { countsOf, readTeamStoreInput } from '../team-store.js';
import { sessionBusy, testsBusy } from './tests.js';

/**
 * Projects: one dashboard over several folders, each with its own store (`DashboardOptions.projects`).
 *
 *   GET  /api/projects                     the switcher: every project, its path and runs, the current one
 *   POST /api/projects {path}              adds a folder (within the limits `checkFolder` keeps) and switches to it
 *   POST /api/projects/:id/select          switches: the store, config and folder jobs run in follow
 *   GET  /api/projects/folders?q=&pick=    Add project: folders for a typed path, and the picked one checked
 *   GET  /api/projects/:id/remove          the Remove dialog: what stays on disk, and the zone that deletes recordings
 *   POST /api/projects/:id/remove {deleteRecordings?, name?}   removes it (deleting its store once the typed name matches)
 *   GET  /api/setup                        the current project's setup: four steps, each with its command
 *   POST /api/setup/record {command}       what recording that command runs, and whether it asks first (changes nothing)
 *   POST /api/setup/golden {golden}        where the golden would go, checked (changes nothing)
 *   POST /api/setup/finish {project?}      Skip the rest, or Go to the overview: the project is set up
 *
 * And three job kinds: `init` (inspect the folder: `shadowlap init`, which writes what it finds to
 * the project list), `record` (`shadowlap run -- <command>`, the one place the browser sends a
 * command line: the agent's own, which only ever goes after `--`, split without a shell, and
 * confirmed the first time it runs in a folder) and `pack-test` (keep the setup's recording as a
 * golden: `pack <run> <golden>`, then `test <golden>`; only the test once it is packed). Setup
 * requests may name the project the page shows (`project`): one that is no longer current is
 * refused, so a click never acts on a project switched to elsewhere. The routes that name a project
 * by its id (switching, adding, removing) take any page's.
 *
 * A dashboard that serves one store (tests, `shadowlap ui`, `--read-only`) has none of this: these
 * routes answer 404 and the job kinds aren't registered, and the pages fall back to the commands.
 */

const ONE_STORE = 'this dashboard serves one store: start shadowlap dashboard to add and switch projects';

/**
 * How a project's runs here stand with the team store its config names, for the Remove dialog: how
 * many of them the store's index lists too, which deleting the recordings here leaves there. Null
 * without a store, or when it can't be read.
 */
function teamOf(h: ProjectHost<ProjectConfig>, project: ProjectEntry): { listed: number } | null {
  const input = readTeamStoreInput({ cwd: project.path });
  if (!input.store) return null;
  try {
    return { listed: countsOf(h.context(project.id).store(), storeKey(parseStoreUrl(input.store))).listedHere };
  } catch {
    return null;
  }
}

export function register(router: Router, ctx: RouteContext): void {
  const projects = ctx.options.projects ?? null;
  const need = (): ProjectHost<ProjectConfig> => {
    if (!projects) throw new HttpError(404, ONE_STORE);
    return projects;
  };
  /** The current project, checked against the one the page showed when it says which. */
  const currentFor = (h: ProjectHost<ProjectConfig>, asked: unknown): string => {
    const id = h.currentProject();
    if (typeof asked === 'string' && asked && asked !== id) throw new HttpError(409, `The dashboard switched to ${id}. Open ${asked} again from the project switcher to go on with its setup.`);
    return id;
  };
  const entryOf = (h: ProjectHost<ProjectConfig>, id: string): ProjectEntry => {
    const entry = h.list().find((p) => p.id === id);
    if (!entry) throw new HttpError(404, `No project ${id}.`);
    return entry;
  };
  /**
   * What these projects' stores say (engine `storeFacts`), read beside the server, since it reads
   * every run (read-jobs.ts `store-facts`): the current project's through its own threads, another's
   * from its file. A folder gone from disk has none, and a store that can't be read is left out, for
   * the host to read on this thread and say why. `keep`: the setup's recording, as the setup lists it.
   */
  const factsBeside = async (h: ProjectHost<ProjectConfig>, projects: readonly ProjectEntry[], o: { keep?: boolean } = {}): Promise<Record<string, StoreFacts>> => {
    const current = h.currentProject();
    const stores = projects.filter((p) => existsSync(p.path)).map((p) => ({ id: p.id, dbPath: p.id === current ? null : h.context(p.id).dbPath, keep: o.keep ? p.setup.runId : null }));
    return stores.length ? answerData<Record<string, StoreFacts>>(await ctx.reads.run({ kind: 'store-facts', stores })) : {};
  };
  /** The last calibrate job's outcome per project, for its setup's third step (until the replay is clean). */
  const calibrations = new Map<string, { runId: string; outcome: CalibrationOutcome }>();
  /** A message with paths under the home folder written as the rest of these screens write them: `~/x`. */
  const homeAsTilde = (h: ProjectHost<ProjectConfig>, text: string): string => {
    let out = text;
    for (const home of new Set([h.registry.realHome, h.registry.home])) out = out.split(`${home}${sep}`).join(`~${sep}`);
    return out;
  };

  // ---- the switcher

  router.get('/projects', async (r) => {
    const h = need();
    const list = h.list();
    const facts = await factsBeside(h, list);
    const view = projectSwitcher({ projects: list, current: h.currentProject(), stats: h.stats({ facts }), home: h.registry.realHome });
    r.tagged({ ...view, notice: h.notice, warnings: h.registry.warnings });
  });

  // Switching, adding and removing name their project: a page showing another one may do them.
  router.post(
    '/projects/:id/select',
    (r) => {
      const h = need();
      const ctxNow = h.switchTo(r.params.id!);
      r.json({ current: ctxNow.id, name: ctxNow.name });
    },
    { anyProject: true },
  );

  // ---- adding a folder

  router.get('/projects/folders', (r) => {
    const h = need();
    const reg = h.registry;
    const roots = reg.configuredRoots();
    const query = (r.query.get('q') ?? '').slice(0, 4096);
    const listed = h.list();
    const suggestions = suggestFolders(query, { home: reg.home, roots, opened: listed });
    const pickText = r.query.get('pick');
    let picked: PickedFolder | null = null;
    let refused: string | null = null;
    if (pickText) {
      // Checked as typed first, then where it leads, then for project files: the same order adding uses.
      const check = checkFolder(pickText, { home: reg.home, roots, requireProjectFiles: false });
      if (check.ok) picked = { path: check.path, folder: check.folder, added: listed.some((p) => p.path === check.path) };
      else refused = check.why;
    }
    const view = addProjectPage({ query, suggestions, picked, home: reg.realHome });
    r.json(refused ? { ...view, error: refused } : view);
  });

  router.post(
    '/projects',
    async (r) => {
      const h = need();
      const body = await r.body();
      if (typeof body.path !== 'string' || !body.path.trim()) throw new HttpError(400, 'Give the folder’s path, such as ~/my-agent.');
      const added = h.add(body.path);
      // After adding, the setup opens: the new project is the current one.
      h.switchTo(added.project.id);
      r.json({ project: { id: added.project.id, name: added.project.name, path: tildePath(added.project.path, h.registry.realHome) }, again: added.again, runs: added.runs, message: addedMessage(added, h.registry.realHome), current: added.project.id }, 201);
    },
    { anyProject: true },
  );

  // ---- removing one

  router.get('/projects/:id/remove', (r) => {
    const h = need();
    const list = h.list();
    const project = entryOf(h, r.params.id!);
    const stats = h.statsOf(project.id);
    r.json(removeDialog({ project, stats, projects: list.length, home: h.registry.realHome, team: stats.runs && !stats.missing && !stats.unreadable ? teamOf(h, project) : null }));
  });

  router.post(
    '/projects/:id/remove',
    async (r) => {
      const h = need();
      const body = await r.body();
      const project = entryOf(h, r.params.id!);
      const deleteRecordings = body.deleteRecordings === true;
      let out: Awaited<ReturnType<ProjectHost<ProjectConfig>['remove']>>;
      try {
        out = await h.remove(project.id, { deleteRecordings, typedName: typeof body.name === 'string' ? body.name : '' });
      } catch (err) {
        // Why it won't (a store in a folder it can't write to, a .shadowlap that is a link), with ~ for the home folder.
        if (err instanceof ProjectError) throw new HttpError(err.status, homeAsTilde(h, err.message));
        throw err;
      }
      calibrations.delete(project.id);
      r.json({
        removed: project.id,
        current: out.current,
        deleted: out.deleted,
        message: deleteRecordings ? `Removed ${project.name} and deleted its recordings` : `Removed ${project.name} · its folder and recordings are untouched`,
      });
    },
    { anyProject: true },
  );

  // ---- the setup

  /** The current project's setup, in the mock's words (`setupView`), from the list, its store and its repository. */
  const setupOf = (h: ProjectHost<ProjectConfig>, id: string, facts?: StoreFacts): SetupView => {
    const project = entryOf(h, id);
    const setup = h.setup(id, facts ? { facts } : {});
    let redactRules = 0;
    let prices: ProjectConfig['prices'];
    try {
      const config = ctx.config();
      redactRules = config.redact.length;
      prices = config.prices;
    } catch {
      // a config that can't be read: Settings says why; the setup counts no rules
    }
    const run = setup.run ? runTotals(ctx.store, setup.run.runId, prices) : null;
    const last = calibrations.get(id);
    const calibration = last && setup.run && last.runId === setup.run.runId ? last.outcome : null;
    return setupView({ project, setup, run, redactRules, home: h.registry.realHome, calibration, golden: h.suggestGolden(id, facts ? { facts } : {}) });
  };

  router.get('/setup', async (r) => {
    const h = need();
    const id = h.currentProject();
    const facts = await factsBeside(h, [entryOf(h, id)], { keep: true });
    r.tagged(setupOf(h, id, facts[id]));
  });

  router.post(
    '/setup/record',
    async (r) => {
      const h = need();
      const body = await r.body();
      const id = currentFor(h, body.project);
      const planned = h.planRecording(id, typeof body.command === 'string' ? body.command : '');
      if (!planned.ok) throw new HttpError(400, planned.error);
      r.json({ display: planned.plan.display, argv: planned.plan.argv, confirm: planned.plan.confirm });
    },
    { write: false },
  );

  router.post(
    '/setup/golden',
    async (r) => {
      const h = need();
      const body = await r.body();
      const id = currentFor(h, body.project);
      const project = entryOf(h, id);
      const setup = h.setup(id);
      const check = goldenPath(typeof body.golden === 'string' ? body.golden : '', { folder: project.path, runId: setup.run?.runId ?? null });
      if (!check.ok) throw new HttpError(400, check.error);
      r.json({ path: check.path, runId: setup.run?.runId ?? null });
    },
    { write: false },
  );

  router.post('/setup/finish', async (r) => {
    const h = need();
    const body = await r.body();
    const id = currentFor(h, body.project);
    const entry = h.finishSetup(id);
    r.json({ project: id, stage: entry.setup.stage, skipped: entry.setup.skipped, golden: entry.setup.golden });
  });

  if (!projects) return;
  const h = projects;

  // ---- jobs

  ctx.jobs.registerJobKind('init', {
    title: (req) => (req.again === true ? 'Checking again' : 'Inspecting the folder'),
    build: (req, { projectId, project }) => {
      if (!project || !projectId) return { error: ONE_STORE, status: 501 };
      if (typeof req.project === 'string' && req.project && req.project !== projectId) return { error: `The dashboard switched to ${projectId}. Open ${req.project} again to inspect it.`, status: 409 };
      // In the project's folder: init reads it, writes an empty config when there is none, and notes what it found.
      return { args: setupJobArgs.inspect() };
    },
  });

  ctx.jobs.registerJobKind('record', {
    title: () => 'Recording',
    build: (req, { projectId, project }) => {
      if (!project || !projectId) return { error: ONE_STORE, status: 501 };
      if (typeof req.project === 'string' && req.project && req.project !== projectId) return { error: `The dashboard switched to ${projectId}. Open ${req.project} again to record it.`, status: 409 };
      if (typeof req.command !== 'string' || !req.command.trim()) return { error: 'Give the command that starts your agent, such as python agent.py.' };
      const planned = h.planRecording(projectId, req.command);
      if (!planned.ok) return { error: planned.error };
      const plan = planned.plan;
      // The first time this command runs in this folder (through this model server), it asks first,
      // and it is remembered as confirmed once it has started: a start refused after this (too many
      // jobs, the dashboard stopping) asks again next time.
      if (plan.confirm && req.confirmed !== true) return { error: `${plan.confirm.title} Confirm it first: ${plan.display}`, status: 409 };
      return { args: plan.args, cwd: plan.cwd, env: plan.env, opensRun: true, title: 'Recording', ...(plan.confirm ? { started: () => void h.confirmCommand(projectId, plan) } : {}) };
    },
  });

  // Keep it as a test: the setup's recording packed as a golden, then its test, as one job; once
  // it is packed (here or in a terminal), the test alone, to run it again.
  ctx.jobs.registerJobKind('pack-test', {
    title: () => 'Packing and testing',
    build: (req, { store, projectId, project }) => {
      if (!project || !projectId) return { error: ONE_STORE, status: 501 };
      if (typeof req.project === 'string' && req.project && req.project !== projectId) return { error: `The dashboard switched to ${projectId}. Open ${req.project} again to keep its golden.`, status: 409 };
      const entry = entryOf(h, projectId);
      const setup = h.setup(projectId);
      const run = setup.run;
      if (!run || setup.live || !setup.steps.recorded) return { error: 'Record a first run before you keep it as a test.', status: 409 };
      const asked = typeof req.golden === 'string' && req.golden.trim() ? req.golden : (setup.golden ?? '');
      const check = goldenPath(asked, { folder: entry.path, runId: run.runId });
      if (!check.ok) return { error: check.error };
      // It replays a golden, so it waits as Tests' jobs do: for one of them in this project, and for a
      // test session started in a terminal or another dashboard.
      const busy = testsBusy(ctx.jobs.list(), projectId, 'keep it as a test') ?? sessionBusy(store, 'keep it as a test');
      if (busy) return { error: busy, status: 409 };
      const packed = h.context(projectId).packs().some((p) => p.path === check.path && p.runIds.includes(run.runId));
      if (packed) return { args: setupJobArgs.test(check.path), runId: run.runId, title: 'Testing the golden' };
      return { args: setupJobArgs.pack(run.runId, check.path), then: [setupJobArgs.test(check.path)], runId: run.runId };
    },
  });

  // What other jobs mean for a setup: a recording started and ended, calibrate made the replay clean,
  // the golden's test passed. Each is noted in the project's entry, in the project the job ran in.
  ctx.jobs.onJob((n: JobNotice) => {
    const id = n.projectId;
    if (!id) return;
    const job = n.job;
    if (n.type === 'run') {
      if (job.kind === 'record' && n.runId && (!n.role || n.role === 'new')) h.registry.noteRecording(id, n.runId, job.args.slice(job.args.indexOf('--') + 1));
      return;
    }
    switch (job.kind) {
      case 'record': {
        const runId = job.newRunId;
        if (!runId) return;
        // A recording that holds calls moves the setup on; one that recorded nothing says so on the step.
        const run = h.setup(id).run;
        if (run?.runId === runId && !run.live) h.registry.noteRecorded(id, runId);
        return;
      }
      case 'calibrate': {
        const outcome = calibrationOutcome(job.result, { write: job.args.includes('--write') });
        const result = job.result as { runId?: unknown } | null;
        const runId = typeof result?.runId === 'string' ? result.runId : job.runId;
        if (!outcome || !runId) return;
        // Only the setup's own recording: calibrating another run from Settings leaves the setup be.
        if (h.setup(id).run?.runId !== runId) return;
        calibrations.set(id, { runId, outcome });
        if (outcome.done) h.registry.noteCalibrated(id, runId, outcome.added);
        return;
      }
      case 'pack-test':
      case 'test': {
        if (job.code !== 0) return;
        const setup = h.setup(id);
        // The golden the setup packed from its recording, tested and passing (as the store says): the
        // list keeps it, so the project's setup comes back with it.
        if (setup.run && setup.golden && setup.steps.tested) h.registry.noteTested(id, setup.run.runId, setup.golden);
        return;
      }
      default:
        return;
    }
  });
}
