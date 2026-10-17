import { commandIsImported, FIX_STATUSES, FixIdError, hasRecordedCommand, importedCommandSource, readConfigFile, resolveFix, setFixTitle, type FixStatus, type RunRecord, type Store, type StoredFix } from '@shadowlap/engine';
import { lookupRun } from '../api.js';
import type { RouteContext } from '../context.js';
import { blameCheckFor, DEFAULT_REPAIRER, failedChecks, fixBundles, fixDetail, fixList, repairJobArgv } from '../fixes.js';
import { HttpError } from '../http.js';
import type { JobBuildResult, JobRequest } from '../jobs.js';
import { storePrStates } from '../pr-state.js';
import { repairerProblem } from '../repairer-check.js';
import { recordingNow } from '../run-exports.js';
import type { Router } from '../router.js';

/**
 * Fixes: the list (`GET /api/fixes`), a fix with its three steps (`GET /api/fixes/:id`), its title
 * (`PUT /api/fixes/:id/title`), and the attempts blame and verify made in a run's family, bundled
 * for the Forks view (`GET /api/fixes/family/:runId`). Three job kinds act on them: `blame` (a
 * failed run, with the check it failed), `repair` (an open fix, from its failing and good runs) and
 * `apply` (a verified fix's patch, into the working tree). Each builder checks what it is asked and
 * builds the command line; the CLI records what it did, so the pages read it back from the store.
 * A blame needs the check the run failed: the one the request names, else the one it was judged by
 * (its own --expect, or the config's tests for the recording it replays, through its ancestors),
 * the fix it fails in or its labels point to, or the agent's exit; when none of those applies, or
 * the run failed a check none of them names, it answers 422 and the page asks. A repair comes with
 * the repairer its confirm dialog named, and is refused (409) when shadowlap.config.json names
 * another by then, or when that repairer can't be asked from here (claude not found on the PATH the
 * jobs get, which the fix's `repairer.problem` says first). Repair and apply change the working
 * tree, so the job manager runs them alone in their project (worktree.ts). A fix's pull request
 * state is read from GitHub in the background as the pages are read (pr-state.ts).
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

/** The config's `tests` in `folder`, as written: where a run judged by the config gets its checks. A config that can't be read gives none. */
function configTests(folder: string | null): unknown {
  if (!folder) return undefined;
  try {
    return readConfigFile(folder).data.tests;
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

/** A run whose command came from someone else's pack, or from the team store, runs only once the user said yes to it. */
function importedCommand(runs: RunRecord[], yes: unknown): JobBuildResult | null {
  const imported = runs.find((r) => commandIsImported(r));
  if (!imported || yes === true) return null;
  return { error: `${imported.runId.slice(0, 10)} came from ${importedCommandSource(imported)}: this runs the command it was recorded with (${imported.command.argv.join(' ')}). Confirm it to run it`, status: 409 };
}

/**
 * The runs a repair command line gives its `--fixes`, `--holdout` and `--keeps`, as the CLI selects
 * them when it runs: run ids, and `label:<name>` for every run with that label, imported ones too.
 */
function selectedRuns(store: Store, argv: readonly string[]): RunRecord[] {
  const out = new Map<string, RunRecord>();
  let listing = false;
  for (const a of argv) {
    if (a.startsWith('--')) {
      listing = a === '--fixes' || a === '--holdout' || a === '--keeps';
      continue;
    }
    if (!listing) continue;
    if (a.startsWith('label:')) {
      const label = a.slice('label:'.length);
      for (const r of store.allRuns()) if (r.meta?.labels?.includes(label)) out.set(r.runId, r);
    } else {
      const r = lookupRun(store, a);
      if (r) out.set(r.runId, r);
    }
  }
  return [...out.values()];
}

function blameJob(req: JobRequest, store: Store, configDir: string | null): JobBuildResult {
  if (typeof req.runId !== 'string' || !req.runId) return { error: 'runId is required' };
  const run = lookupRun(store, req.runId);
  if (!run) return { error: `no run ${req.runId.slice(0, 40)}`, status: 404 };
  const id = run.runId.slice(0, 10);
  // A run its recorder left marked running was interrupted, as every page reads it: nothing failed to blame.
  if (run.status === 'running') return { error: recordingNow(store, run) ? `${id} is still recording: blame it once it has ended` : `${id} was interrupted: its recorder stopped before it ended, so it has no failure to blame`, status: 409 };
  if (!hasRecordedCommand(run)) return { error: `${id} was imported from a capture and has no command to re-run: blame it in a terminal with yours, shadowlap blame ${id} -- <command>`, status: 409 };
  let expect: unknown;
  if ('expect' in req) {
    const asked = requestedCheck(req.expect);
    if ('error' in asked) return { error: asked.error };
    expect = asked.expect;
  } else {
    const found = blameCheckFor(store, run, { tests: configTests(configDir), configDir });
    if (!found) {
      const failed = failedChecks(run);
      const what = failed.length ? `${id} failed “${failed[0]}”, and neither the run nor shadowlap.config.json gives that check` : `blame needs the check ${id} failed`;
      return { error: `say what a passing run must do: ${what}. Give it as expect JSON, such as {"tools":{"send_email":1}}`, status: 422 };
    }
    expect = found.expect;
  }
  const consent = importedCommand([run], req.yes);
  if (consent) return consent;
  return { args: ['blame', run.runId, ...(expect !== null && expect !== undefined ? ['--expect', JSON.stringify(expect)] : []), ...(req.yes === true ? ['--yes'] : [])], runId: run.runId };
}

/**
 * The repairer a repair asks for candidates, and so whose account pays: the one the config names,
 * else the user's own Claude Code. The page names it in its confirm dialog and sends it back with the
 * job: one shadowlap.config.json no longer names would bill an account the user never said yes to,
 * so a job that names another than the config does now is refused, and nothing runs.
 */
function repairerChanged(req: JobRequest, configured: string | null): JobBuildResult | null {
  if (req.repairer === undefined) return null;
  if (typeof req.repairer !== 'string' || !req.repairer.trim()) return { error: 'repairer is the one the page named, such as claude-code' };
  const now = configured ?? DEFAULT_REPAIRER;
  if (req.repairer.trim() === now) return null;
  const who = configured ? now : `none, so your own Claude Code (${DEFAULT_REPAIRER})`;
  return { error: `the repairer in shadowlap.config.json changed since this page loaded: now ${who}. Nothing ran: open Repair from here again`, status: 409 };
}

function repairJob(req: JobRequest, store: Store, repairer: string | null): JobBuildResult {
  const fix = findFix(store, req.fixId);
  const configured = repairer?.trim() || null;
  const changed = repairerChanged(req, configured);
  if (changed) return changed;
  const d = fixDetail(store, fix.fixId, { repairer: configured, checkRepairer: repairerProblem })!;
  if (fix.status !== 'open') return { error: `${short(fix.fixId)} is ${fix.status} already: a change was verified for it`, status: 409 };
  if (!d.actions.repair) return { error: `none of the failing runs of ${short(fix.fixId)} is left in the store, so there is nothing to repair`, status: 409 };
  // It would blame every failing run, then find no one to propose a fix: nothing runs.
  if (d.repairer.problem) return { error: `${d.repairer.problem.replace(/\.$/, '')}. Nothing ran`, status: 409 };
  // Every run the command will select, as the CLI selects it: a label can bring in an imported run.
  const consent = importedCommand(selectedRuns(store, d.actions.repair.argv), req.yes);
  if (consent) return consent;
  return { args: [...repairJobArgv(d.actions.repair.argv, configured), ...(req.yes === true ? ['--yes'] : [])] };
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
  // A fix's pull request moves past "open" once the forge says so: asked with gh in the background
  // while the pages are read, and written to the store, whose change brings the pages up to date.
  // Only pull requests on github.com and the project's own GitHub hosts are read. A read-only
  // dashboard asks no one, as it changes nothing.
  const prs = ctx.readOnly ? null : storePrStates(() => store, { projectDir: ctx.project?.path ?? null });

  router.get('/fixes', (r) => {
    const status = r.query.get('status') ?? 'all';
    if (!STATUSES.has(status)) throw new HttpError(400, `status is one of ${[...STATUSES].join(', ')}`);
    prs?.refresh(store.listFixes());
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
    prs?.refresh([fix]);
    r.tagged(fixDetail(store, fix.fixId, { repairer: configuredRepairer(ctx), checkRepairer: repairerProblem }));
  });

  router.put('/fixes/:id/title', async (r) => {
    const body = await r.body();
    const fix = findFix(store, r.params.id);
    if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'a title needs some text');
    setFixTitle(store, fix.fixId, body.title);
    r.json(fixDetail(store, fix.fixId, { repairer: configuredRepairer(ctx), checkRepairer: repairerProblem }));
  });

  // Repair and apply change the working tree, and blame runs the agent from it: the job manager
  // runs no two of them at once in one project where that would clash (worktree.ts).
  jobs.registerJobKind('blame', { title: () => 'Blaming', build: (req, b) => blameJob(req, b.store, b.project?.path ?? null) });
  jobs.registerJobKind('repair', { title: () => 'Repairing', build: (req, b) => repairJob(req, b.store, configuredRepairer(ctx)) });
  jobs.registerJobKind('apply', { title: () => 'Applying the patch', build: (req, b) => applyJob(req, b.store) });
}
