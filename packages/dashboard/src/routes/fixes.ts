import { commandIsImported, FIX_STATUSES, FixIdError, hasRecordedCommand, readConfigFile, resolveFix, setFixTitle, type FixStatus, type RunRecord, type Store, type StoredFix } from '@shadowlap/engine';
import { lookupRun } from '../api.js';
import type { RouteContext } from '../context.js';
import { blameCheckFor, fixBundles, fixDetail, fixList, repairJobArgv } from '../fixes.js';
import { HttpError } from '../http.js';
import type { JobBuildResult, JobRequest } from '../jobs.js';
import type { Router } from '../router.js';

/**
 * Fixes: the list (`GET /api/fixes`), a fix with its three steps (`GET /api/fixes/:id`), its title
 * (`PUT /api/fixes/:id/title`), and the attempts blame and verify made in a run's family, bundled
 * for the Forks view (`GET /api/fixes/family/:runId`). Three job kinds act on them: `blame` (a
 * failed run, with the check it failed), `repair` (an open fix, from its failing and good runs) and
 * `apply` (a verified fix's patch, into the working tree). Each builder checks what it is asked and
 * builds the command line; the CLI records what it did, so the pages read it back from the store.
 * A blame needs the check the run failed: the one the request names, else the one its replay was
 * judged by, the config's for a test's golden, the fix it fails in or its labels point to, or the
 * agent's exit; with none of those it answers 422, and the page asks.
 */

const STATUSES = new Set<string>(['all', ...FIX_STATUSES]);
/** The largest check a blame takes from the browser, as JSON. */
const MAX_EXPECT = 16 * 1024;

const short = (id: string) => id.slice(0, 13);

/** A fix by its id or a unique prefix of it; a FixIdError (unknown, or ambiguous) as the 404 it is. */
function findFix(store: Store, id: unknown): StoredFix {
  if (typeof id !== 'string' || !id.trim()) throw new HttpError(400, 'fixId is required');
  try {
    const fix = resolveFix(store, id);
    if (!fix) throw new HttpError(404, `no fix ${id.slice(0, 40)}`);
    return fix;
  } catch (err) {
    if (err instanceof FixIdError) throw new HttpError(404, err.message);
    throw err;
  }
}

/** The repairer shadowlap.config.json names, or null; a config that can't be read names none. */
function configuredRepairer(ctx: RouteContext): string | null {
  if (!ctx.options.loadConfig) return null;
  try {
    return ctx.config().repair?.repairer ?? null;
  } catch {
    return null;
  }
}

/** The config's `tests`, as written: where a test run's golden gets its checks. A config that can't be read gives none. */
function configTests(ctx: RouteContext): unknown {
  if (!ctx.project) return undefined;
  try {
    return readConfigFile(ctx.project.path).data.tests;
  } catch {
    return undefined;
  }
}

/** The check a blame asks for, from the request: JSON (or its text), null for the exit code alone. */
function requestedCheck(raw: unknown): { expect: unknown } | { error: string } {
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_EXPECT) return { error: 'that check is too long' };
    try {
      value = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      return { error: `the check must be JSON, such as {"tools":{"send_email":1}}` };
    }
  }
  if (value === null) return { expect: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { error: `the check is an object, such as {"tools":{"send_email":1}}` };
  if (JSON.stringify(value).length > MAX_EXPECT) return { error: 'that check is too long' };
  return { expect: value };
}

/** A run whose command came from someone else's pack runs only once the user said yes to it. */
function importedCommand(runs: RunRecord[], yes: unknown): JobBuildResult | null {
  const imported = runs.find((r) => commandIsImported(r));
  if (!imported || yes === true) return null;
  return { error: `${imported.runId.slice(0, 10)} came from an imported pack: this runs the command it was recorded with (${imported.command.argv.join(' ')}). Confirm it to run it`, status: 409 };
}

function blameJob(req: JobRequest, store: Store, tests: () => unknown): JobBuildResult {
  if (typeof req.runId !== 'string' || !req.runId) return { error: 'runId is required' };
  const run = lookupRun(store, req.runId);
  if (!run) return { error: `no run ${req.runId.slice(0, 40)}`, status: 404 };
  if (run.status === 'running') return { error: `${run.runId.slice(0, 10)} is still recording: blame it once it has ended`, status: 409 };
  if (!hasRecordedCommand(run)) return { error: `${run.runId.slice(0, 10)} was imported from a capture and has no command to re-run: blame it in a terminal with yours, shadowlap blame ${run.runId.slice(0, 10)} -- <command>`, status: 409 };
  let expect: unknown;
  if ('expect' in req) {
    const asked = requestedCheck(req.expect);
    if ('error' in asked) return { error: asked.error };
    expect = asked.expect;
  } else {
    const found = blameCheckFor(store, run, { tests: run.meta?.test ? tests() : undefined });
    if (!found) return { error: `say what a passing run must do: blame needs the check ${run.runId.slice(0, 10)} failed, as expect JSON such as {"tools":{"send_email":1}}`, status: 422 };
    expect = found.expect;
  }
  const consent = importedCommand([run], req.yes);
  if (consent) return consent;
  return { args: ['blame', run.runId, ...(expect !== null && expect !== undefined ? ['--expect', JSON.stringify(expect)] : []), ...(req.yes === true ? ['--yes'] : [])], runId: run.runId };
}

function repairJob(req: JobRequest, store: Store, repairer: string | null): JobBuildResult {
  const fix = findFix(store, req.fixId);
  const d = fixDetail(store, fix.fixId, { repairer })!;
  if (fix.status !== 'open') return { error: `${short(fix.fixId)} is ${fix.status} already: a change was verified for it`, status: 409 };
  if (!d.actions.repair) return { error: `none of the failing runs of ${short(fix.fixId)} is left in the store, so there is nothing to repair`, status: 409 };
  const runs = [...d.failingRuns, ...d.goodRuns].map((r) => store.getRun(r.runId)).filter((r): r is RunRecord => r !== null);
  const consent = importedCommand(runs, req.yes);
  if (consent) return consent;
  return { args: [...repairJobArgv(d.actions.repair.argv, repairer), ...(req.yes === true ? ['--yes'] : [])] };
}

function applyJob(req: JobRequest, store: Store): JobBuildResult {
  const fix = findFix(store, req.fixId);
  const d = fixDetail(store, fix.fixId)!;
  const apply = d.actions.apply;
  if (!apply) return { error: `${short(fix.fixId)} is open: no change has been verified for it yet, so there is nothing to apply`, status: 409 };
  if (d.actions.applied && !apply.pending) return { error: `${short(fix.fixId)} is applied already, and nothing is left to do`, status: 409 };
  return { args: apply.argv, title: apply.kind === 'mark' ? 'Marking the fix applied' : d.actions.applied ? 'Finishing the apply' : 'Applying the patch' };
}

export function register(router: Router, ctx: RouteContext): void {
  const { store, jobs } = ctx;
  // A repair writes each candidate into the working tree and puts it back, and an apply changes it
  // for good: while one runs, another would trip over it.
  const busy = (): JobBuildResult | null => {
    const running = jobs.list().find((j) => !j.done && (j.kind === 'repair' || j.kind === 'apply'));
    return running ? { error: `${running.kind === 'repair' ? 'a repair' : 'an apply'} is running and changes the working tree until it is done: wait for it to finish`, status: 409 } : null;
  };

  router.get('/fixes', (r) => {
    const status = r.query.get('status') ?? 'all';
    if (!STATUSES.has(status)) throw new HttpError(400, `status is one of ${[...STATUSES].join(', ')}`);
    r.tagged(fixList(store, { status: status as FixStatus | 'all' }));
  });

  // The attempts in a run's family, bundled as the Forks view shows them. Before /fixes/:id would
  // take it: a literal segment wins.
  router.get('/fixes/family/:runId', (r) => {
    const run = lookupRun(store, r.params.runId!);
    const bundles = run ? fixBundles(store, run.runId) : null;
    if (!bundles) throw new HttpError(404, `no run ${r.params.runId}`);
    r.tagged({ bundles });
  });

  router.get('/fixes/:id', (r) => {
    const fix = findFix(store, r.params.id);
    r.tagged(fixDetail(store, fix.fixId, { repairer: configuredRepairer(ctx) }));
  });

  router.put('/fixes/:id/title', async (r) => {
    const body = await r.body();
    const fix = findFix(store, r.params.id);
    if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'a title needs some text');
    setFixTitle(store, fix.fixId, body.title);
    r.json(fixDetail(store, fix.fixId, { repairer: configuredRepairer(ctx) }));
  });

  jobs.registerJobKind('blame', { title: () => 'Blaming', build: (req, b) => blameJob(req, b.store, () => configTests(ctx)) });
  jobs.registerJobKind('repair', { title: () => 'Repairing', build: (req, b) => busy() ?? repairJob(req, b.store, configuredRepairer(ctx)) });
  jobs.registerJobKind('apply', { title: () => 'Applying the patch', build: (req, b) => busy() ?? applyJob(req, b.store) });
}
