import { ACTIONS, blameCheckFor, DEFAULT_REPAIRER, failedCheckLabels, FIX_STATUSES, FixIdError, type FixStatus, goldenNameArgs, goldenNamesProblem, hasRecordedCommand, type JobConsent, needsConsent, readConfigFile, repairerProblem, repairJobArgv, resolveFix, type RunRecord, selectedRuns, setFixTitle, type StoredFix, type StoreOf } from '@shadowlap/engine';
import { lookupRun } from '../api.js';
import type { RouteContext } from '../context.js';
import { APPLY_GOLDENS, fixBundles, fixDetail, fixList, patchesToCheck, pulledPatchesToCheck } from '../fixes.js';
import { HttpError } from '../http.js';
import type { JobBuildResult, JobRequest } from '../jobs.js';
import { patchesInTree, rewritesHere } from '../patch-in-tree.js';
import { storePrStates } from '../pr-state.js';
import { sendAnswer } from '../read-pool.js';
import type { ReadAnswer } from '../read-jobs.js';
import { recordingNow } from '../run-exports.js';
import type { Router } from '../router.js';

/**
 * Fixes: the list (`GET /api/fixes`), a fix with its three steps (`GET /api/fixes/:id`), its title
 * (`PUT /api/fixes/:id/title`), and the attempts blame and verify made in a run's family, bundled
 * for the Forks view (`GET /api/fixes/family/:runId`). Four job kinds act on them: `blame` (a
 * failed run, with the check it failed; or an open fix's blame again, or with a stronger model),
 * `repair` (an open fix, from its failing and good runs), `verify` (more attempts for a verdict left
 * incomplete) and `apply` (a verified fix's patch, into the working tree, with the names the page
 * gave the goldens it copies). Each builder checks what it is asked and
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
function findFix(store: StoreOf<'fixes'>, id: unknown): StoredFix {
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

/**
 * A fix's page, worked out beside the server (read-jobs.ts `fix`): it reads the blamed run's calls,
 * every one of them. Whether each patch it could apply is in the project's working tree already, as
 * git says it there, and why `fix apply` refuses a pulled repair's patch there, as its file reads, are
 * asked here first and handed over as data; the thread reads what the project's goldens folder
 * holds itself. None of them without a project folder.
 */
async function fixAnswer(ctx: RouteContext, store: StoreOf<'fixes' | 'team'>, fix: StoredFix): Promise<ReadAnswer> {
  const project = ctx.project?.path;
  const patches = project ? patchesToCheck(store, [fix]) : [];
  const check = project && patches.length ? await patchesInTree(project, patches) : null;
  const pulled = project ? pulledPatchesToCheck(store, [fix]) : [];
  const here = project && pulled.length ? await rewritesHere(project, pulled) : null;
  return ctx.reads.run({
    kind: 'fix',
    fixId: fix.fixId,
    repairer: configuredRepairer(ctx),
    ...(check ? { inTree: patches.map((p): [string, boolean | null] => [p, check(p)]) } : {}),
    ...(here ? { refusedHere: pulled.map((r): [string, string | null] => [r.repairId, here(r.repairId)]) } : {}),
    ...(project ? { project } : {}),
  });
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

/** A run whose command came from someone else's pack, or from the team store, runs only once the user said yes to it and to `args`. */
function importedCommand(runs: RunRecord[], yes: unknown, args: readonly string[]): JobConsent {
  return needsConsent({ runs, yes, args });
}

/** A model as `--model` takes it: a name, never a flag. */
const MODEL = /^[A-Za-z0-9][\w.:/@-]{0,119}$/;

/**
 * Run blame again, or Run blame with stronger model, for an open fix whose blame placed its failure on no
 * call: the command the fix's page offers (`actions.blameAgain`, `actions.blameStronger` with the
 * model asked for), built by the server from that blame, never from the browser's arguments.
 */
function fixBlameJob(req: JobRequest, store: StoreOf<'recording' | 'readModels' | 'activity' | 'fixes' | 'team'>): JobBuildResult {
  const fix = findFix(store, req.fixId);
  const d = fixDetail(store, fix.fixId)!;
  const id = short(fix.fixId);
  let args: string[];
  if (req.again === true) {
    if (!d.actions.blameAgain) return { error: `${id}'s blame settled where its run was lost, or the fix isn't open: there is nothing to blame again`, status: 409 };
    args = d.actions.blameAgain.argv;
  } else {
    if (typeof req.model !== 'string' || !MODEL.test(req.model.trim())) return { error: 'name the model to blame with, such as claude-opus-5-5' };
    if (!d.actions.blameStronger) return { error: `${id}'s blame can't be made again with another model: it found where the run was lost, found the model's answer isn't what lost it, or asked another model already`, status: 409 };
    args = [...d.actions.blameStronger.argv, '--model', req.model.trim()];
  }
  const run = lookupRun(store, args[1]!);
  if (!run) return { error: `the run ${id} blamed is gone from the store`, status: 409 };
  // A blame a pull brought runs again only once the user says yes to the exact command, as an imported run's does.
  const next = req.again === true ? d.actions.blameAgain! : d.actions.blameStronger!;
  const consent = needsConsent({ runs: [run], yes: req.yes, args, pulled: next.pulled ? { what: `${id}'s blame`, left: next.left } : null });
  if ('ask' in consent) return consent.ask;
  return { args: [...args, ...consent.yes], runId: run.runId, title: req.again === true ? ACTIONS.runBlameAgain.doing : ACTIONS.runBlameStronger.doing };
}

/**
 * Run more attempts, or Verify again, for an incomplete verdict of a fix (`VerifyStep.more`): the
 * command the fix's page offers, built by the server from that verdict.
 */
function verifyJob(req: JobRequest, store: StoreOf<'recording' | 'readModels' | 'activity' | 'fixes' | 'team'>): JobBuildResult {
  const fix = findFix(store, req.fixId);
  const d = fixDetail(store, fix.fixId)!;
  if (typeof req.verifyId !== 'string' || !req.verifyId) return { error: 'verifyId is required' };
  const v = d.verify.find((x) => x.verifyId === req.verifyId);
  if (!v) return { error: `no verdict ${req.verifyId.slice(0, 40)} on ${short(fix.fixId)}`, status: 404 };
  if (!v.more) return { error: `${short(fix.fixId)}'s verdict ${v.verifyId.slice(0, 13)} is ${v.verdict}, or doesn't count for it: there is nothing to settle`, status: 409 };
  // A verdict a pull brought runs again only once the user says yes to the exact command, as an imported run's does.
  const runs = v.rows.map((x) => store.getRun(x.runId)).filter((r): r is RunRecord => r !== null);
  const consent = needsConsent({ runs, yes: req.yes, args: v.more.argv, pulled: v.more.pulled ? { what: `${short(fix.fixId)}'s verdict ${v.verifyId.slice(0, 13)}`, left: v.more.left } : null });
  if ('ask' in consent) return consent.ask;
  return { args: [...v.more.argv, ...consent.yes], title: v.more.kind === 'more' ? ACTIONS.runMoreAttempts.doing : ACTIONS.verifyAgain.doing };
}

function blameJob(req: JobRequest, store: StoreOf<'recording' | 'readModels' | 'activity' | 'fixes' | 'team'>, configDir: string | null): JobBuildResult {
  if (req.fixId !== undefined && (req.again === true || req.model !== undefined)) return fixBlameJob(req, store);
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
      const failed = failedCheckLabels(run);
      const what = failed.length ? `${id} failed “${failed[0]!}”, and neither the run nor shadowlap.config.json gives that check` : `blame needs the check ${id} failed`;
      return { error: `say what a passing run must do: ${what}. Give it as expect JSON, such as {"tools":{"send_email":1}}`, status: 422 };
    }
    expect = found.expect;
  }
  const args = ['blame', run.runId, ...(expect !== null && expect !== undefined ? ['--expect', JSON.stringify(expect)] : [])];
  const consent = importedCommand([run], req.yes, args);
  if ('ask' in consent) return consent.ask;
  return { args: [...args, ...consent.yes], runId: run.runId };
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
  return { error: `the repairer in shadowlap.config.json changed since this page loaded: now ${who}. Nothing ran: open Run repair again`, status: 409 };
}

function repairJob(req: JobRequest, store: StoreOf<'recording' | 'readModels' | 'activity' | 'fixes' | 'team'>, repairer: string | null): JobBuildResult {
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
  const args = repairJobArgv(d.actions.repair.argv, configured);
  const consent = importedCommand(selectedRuns(store, d.actions.repair.argv), req.yes, args);
  if ('ask' in consent) return consent.ask;
  return { args: [...args, ...consent.yes] };
}

/**
 * The names the page gave the goldens apply copies now (`names`, `{ <run>: <name> }`, each run by the
 * short id the fix's page gave it), as `fix apply --name` takes them, or why they won't do: a run it
 * copies no recording of now, or a name the engine's rule refuses, with the rest as each takes it.
 * Whether a name is taken, `fix apply` reads in the goldens folder, and refuses before it changes
 * anything. None given, each takes the name the fix's label makes.
 */
function namesFor(given: unknown, offered: ReadonlyArray<{ run: string; name: string }>): { names: Array<{ run: string; name: string }> } | { error: string } {
  if (given === undefined) return { names: [] };
  if (!given || typeof given !== 'object' || Array.isArray(given)) return { error: 'names gives each golden its name by its run, such as {"01K5CQ2E8M":"refund-bug"}' };
  const names: Array<{ run: string; name: string }> = [];
  for (const [run, name] of Object.entries(given)) {
    if (!offered.some((o) => o.run === run)) return { error: `${run.slice(0, 40)} is not a run whose recording applying the fix copies now` };
    if (typeof name !== 'string') return { error: `the name of the golden from ${run} is text` };
    names.push({ run, name: name.trim() });
  }
  const problem = goldenNamesProblem(
    offered.map((o) => names.find((n) => n.run === o.run)?.name ?? o.name),
    { folder: APPLY_GOLDENS, held: [] },
  );
  return problem ? { error: problem.text } : { names };
}

function applyJob(req: JobRequest, store: StoreOf<'recording' | 'readModels' | 'activity' | 'fixes' | 'team'>): JobBuildResult {
  const fix = findFix(store, req.fixId);
  const d = fixDetail(store, fix.fixId)!;
  const apply = d.actions.apply;
  if (!apply) return { error: `${short(fix.fixId)} is open: no change has been verified for it yet, so there is nothing to apply`, status: 409 };
  if (d.actions.applied && !apply.pending) return { error: `${short(fix.fixId)} is applied already, and nothing is left to do`, status: 409 };
  if (apply.refused) return { error: `${short(fix.fixId)}'s patch is not the change its repair verified: ${apply.refused}. Nothing ran`, status: 409 };
  const named = namesFor(req.names, apply.names);
  if ('error' in named) return named;
  return { args: [...apply.argv, ...goldenNameArgs(named.names)], title: apply.kind === 'mark' ? 'Marking the fix applied' : d.actions.applied ? 'Finishing the apply' : ACTIONS.applyFix.doing };
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
    if (!bundles) throw new HttpError(404, `no run ${r.params.runId!}`);
    r.tagged({ bundles });
  });

  router.get('/fixes/:id', async (r) => {
    const fix = findFix(store, r.params.id);
    prs?.refresh([fix]);
    sendAnswer(r, await fixAnswer(ctx, store, fix));
  });

  router.put('/fixes/:id/title', async (r) => {
    const body = await r.body();
    const fix = findFix(store, r.params.id);
    if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'a title needs some text');
    setFixTitle(store, fix.fixId, body.title);
    sendAnswer(r, await fixAnswer(ctx, store, fix), { etag: null });
  });

  // Repair and apply change the working tree, and blame runs the agent from it: the job manager
  // runs no two of them at once in one project where that would clash (worktree.ts).
  // Each titled as its drawer heads it, in the -ing form of the name its button has.
  jobs.registerJobKind('blame', { title: () => ACTIONS.runBlame.doing, build: (req, b) => blameJob(req, b.store, b.project?.path ?? null) });
  jobs.registerJobKind('repair', { title: () => ACTIONS.runRepair.doing, build: (req, b) => repairJob(req, b.store, configuredRepairer(ctx)) });
  jobs.registerJobKind('apply', { title: () => ACTIONS.applyFix.doing, build: (req, b) => applyJob(req, b.store) });
  jobs.registerJobKind('verify', { title: () => ACTIONS.runVerify.doing, build: (req, b) => verifyJob(req, b.store) });
}
