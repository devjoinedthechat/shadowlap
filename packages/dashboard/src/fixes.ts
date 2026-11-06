/**
 * Fixes, as the dashboard and `shadowlap fix --json` read them: plain JSON from the store, one
 * function per view, no HTTP. A fix is one failure and its three steps (blame, repair, verify);
 * engine `fixes.ts` says how runs, blames, repairs and verdicts are grouped into one, and when a
 * verdict counts for a fix. Only verdicts that count move a step; the others are listed with why.
 *
 * Besides the Fixes list and a fix's page, other views read fixes through three helpers:
 * `fixesSummary` (the Overview's outcomes and funnel), `needsLookFixes` (Needs a look) and
 * `fixForRun` (a run page's banners and the Forks view's bundles).
 *
 * Each view has a module: fix-list.ts, the steps of a fix's page (fix-blame-step.ts,
 * fix-repair-step.ts, fix-verify-step.ts), fix-summary.ts, fix-for-run.ts and fix-bundles.ts, with
 * what they share in fix-shared.ts; the check a blame starts from is the engine's (`blameCheckFor`),
 * which the terminal UI asks too. This one keeps a fix's page (fixDetail) and the commands its
 * buttons run, and exports the rest.
 */

import { isAbsolute, join, resolve } from 'node:path';
import { applyGoldens, applyLeft, commitTitle, DEFAULT_REPAIRER, defaultGoldenNames, expectArgs, fixCost, type FixData, FixIdError, fixRecords, type FixRecords, gitApplyCommand, goldensFolder, lostRange, noFixReason, patchFiles, REPAIR_CANDIDATES, repairArgv, repairJobArgv, type RepairOutcome, repairPatchProblem, repairToApply, resolveFix, type RunRecord, shownBlame, type StoredBlame, type StoredFix, type StoredRepair, type StoreOf, unsettledFirst, verifyArgv } from '@shadowlap/engine';
import { type FixRow, rowOf } from './fix-list.js';
import { acceptedCandidate, commandLine, counting, fieldsSet, type FixActions, type PatchCheck, patchMerged, patchToCheck, type RewriteCheck, runHref, short, shownRepair, type StepKey, unrepairedVerdict } from './fix-shared.js';
import { blameNext, blameStep, type BlameStep } from './fix-blame-step.js';
import { repairStep, type RepairStep } from './fix-repair-step.js';
import { verifyStep, type VerifyStep } from './fix-verify-step.js';
export { type StepState, type FixStep, type FixRow, type FixList, fixList } from './fix-list.js';
export { type BlameStep } from './fix-blame-step.js';
export { type CandidateVerdict, type RepairStep } from './fix-repair-step.js';
export { type VerifyStep, type VerifyMore } from './fix-verify-step.js';
export { type FixesSummary, type WeekWindows, fixesSummary, type NeedsLookItem, needsLookFixes } from './fix-summary.js';
export { type FixRef, type RunBlame, type FixForRun, fixForRun } from './fix-for-run.js';
export { type FixBundleAttempt, type FixBundle, fixBundles } from './fix-bundles.js';
export { type StepKey, type VerifyRow, type FixActions, fixHref, shortFailure, type PatchCheck, type RewriteCheck } from './fix-shared.js';

export interface FixRunRef {
  runId: string;
  href: string;
  /** False when the run was deleted from the store since. */
  exists: boolean;
  status: RunRecord['status'] | null;
  startedAt: number | null;
  labels: string[];
}

export interface FixDetail extends FixRow {
  /** The check as JSON, as `--expect` takes it; null for the exit code alone. */
  expect: unknown;
  /** The check as the oracle's labels: what a verdict must check to count for the fix. */
  oracle: string[];
  failingRuns: FixRunRef[];
  goodRuns: FixRunRef[];
  openedBy: string | null;
  upstreamRequests: number;
  /** The step a fix opens on without one in its URL: its last finished step. */
  defaultStep: StepKey;
  actions: FixActions;
  /** The blame the Blame step shows (the latest that found a call, else the latest), and every blame, newest first. */
  blame: BlameStep | null;
  /**
   * Every blame, newest first: `unsettled` for one that placed the failure on no call only because its
   * first probe couldn't tell; `range`, the two calls the run was lost around or between, when no one call is pinned (lostRange).
   */
  blames: Array<{ blameId: string; runId: string; at: number; outcome: StoredBlame['outcome']; unsettled?: true; lostAt: number | null; range: { from: number; to: number; gradual?: true } | null; confidence: string }>;
  /** The repair the Repair step shows (the latest accepted that counts, else the latest accepted, else the latest), and every repair, newest first. */
  repair: RepairStep | null;
  repairs: Array<{ repairId: string; at: number; outcome: RepairOutcome; accepted: boolean; title: string }>;
  /** Every change verified, newest first, and the one shown without one in the URL: the newest that counts for the fix, else the newest. */
  verify: VerifyStep[];
  defaultVerify: string | null;
  /** Commands that run each step again, as the empty steps show them. */
  commands: { blame: string; repair: string; verify: string };
  /**
   * Who a repair from here asks for candidates: the repairer shadowlap.config.json names
   * (`repair.repairer`, which the CLI reads by itself), or else the user's own Claude Code. On an open
   * fix, `problem` says why it can't be asked from this machine (claude not found), when the caller
   * checks (`repairerProblem`); null otherwise.
   */
  repairer: { name: string; configured: boolean; problem: string | null };
  applied: FixData['applied'] | null;
}

function runRef(store: StoreOf<'recording'>, runId: string): FixRunRef {
  const run = store.getRun(runId);
  return { runId, href: runHref(runId), exists: run !== null, status: run?.status ?? null, startedAt: run?.startedAt ?? null, labels: run?.meta?.labels ?? [] };
}

/**
 * For a fix verified with no repair behind it, the request fields the change that verified it set
 * (`temperature=1 from each run's first model call`): a change no patch carries, which applying it
 * can only mark applied. Null when the change was all in the code, or a repair's.
 */
export function fieldChange(rec: FixRecords): string | null {
  const v = unrepairedVerdict(rec);
  return v ? fieldsSet(v) : null;
}

/** What applying a fix left undone, in words, or null. */
function pendingText(left: { goldens: boolean; test: boolean } | null): string | null {
  if (!left) return null;
  if (left.goldens) return 'copy the recordings the fixed code made into the goldens folder, and run shadowlap test on them';
  return 'run shadowlap test on its goldens';
}

/**
 * The patches a read model asks its `PatchCheck` about, for these fixes (every fix unless given):
 * git answers asynchronously and a read model works synchronously, so a route asks git about them
 * first (`patchesInTree`, patch-in-tree.ts) and hands the read model the answers.
 */
export function patchesToCheck(store: StoreOf<'fixes'>, fixes: readonly StoredFix[] = store.listFixes()): string[] {
  const out: string[] = [];
  for (const fix of fixes) {
    if (fix.status !== 'verified') continue;
    const patch = patchToCheck(fixRecords(store, fix));
    if (patch !== null) out.push(patch);
  }
  return out;
}

/**
 * The repairs a read model asks its `RewriteCheck` about, for these fixes (every fix unless given):
 * each verified fix's repair to apply, when a pull brought it and its patch is its candidate's one
 * rewrite. Whether that rewrite is one repair makes is read in the working tree, so a route reads it
 * first (`rewritesHere`, patch-in-tree.ts) and hands the read model the answers.
 */
export function pulledPatchesToCheck(store: StoreOf<'fixes' | 'team'>, fixes: readonly StoredFix[] = store.listFixes()): StoredRepair[] {
  const out: StoredRepair[] = [];
  for (const fix of fixes) {
    if (fix.status !== 'verified') continue;
    const r = repairToApply(fixRecords(store, fix));
    if (r?.report.patch && store.repairPulled(r.repairId) !== null && !repairPatchProblem(r.report)) out.push(r);
  }
  return out;
}

/**
 * A repair from here as the fix's page offers it: its command, and why it would end "No fix to try"
 * without running the agent, with which of the estimate's cases that is, as the engine words it. Read
 * only for an open fix a repair can start from.
 */
function repairOffer(store: StoreOf<'recording' | 'fixes'>, rec: FixRecords, scope: string | null, command: string, argv: string[]): NonNullable<FixDetail['actions']['repair']> {
  const noFix = noFixReason(store, rec, scope);
  return { argv, command, noFix: noFix?.sentence ?? null, noFixWhy: noFix?.kind ?? null, candidates: REPAIR_CANDIDATES };
}

/**
 * Why `fix apply` refuses the patch of `r`, the repair it would apply: more than its accepted
 * candidate's one rewrite (`repairPatchProblem`), or, for one a pull brought, a rewrite repair itself
 * doesn't make in this working tree, as `here` read it (`rewriteHere`).
 */
export function refusedOf(store: StoreOf<'team'>, r: StoredRepair | null, here: RewriteCheck | undefined): string | null {
  if (!r) return null;
  return repairPatchProblem(r.report) ?? (here && store.repairPulled(r.repairId) !== null ? here(r.repairId) : null);
}

/**
 * What the project's goldens folder holds, for the goldens apply copies (the engine's
 * `goldensFolder`): the runs whose recording is in it already, under the run's name or as the very
 * recording under any, which keep it, and every name it holds, which none of the rest may take.
 * Given each golden it offers by its run, with the folder of its recording, as the repair's report
 * gives it.
 */
export type GoldensFolder = (offered: ReadonlyArray<{ run: string; source: string }>) => { there: ReadonlyArray<{ run: string; at: string }>; held: readonly string[] };

/** The goldens folder the dashboard's apply job copies into: `fix apply`'s own, `goldens/` in the project. */
export const APPLY_GOLDENS = 'goldens';

/**
 * What a project's goldens folder holds, as Apply fix reads it beside the server (read-jobs.ts).
 * A recording the store places outside the project is never read: `fix apply` refuses it anyway.
 */
export const goldensFolderIn =
  (project: string): GoldensFolder =>
  (offered) =>
    goldensFolder(
      join(project, APPLY_GOLDENS),
      offered.map((g) => ({ ...g, source: !isAbsolute(g.source) && !g.source.split('/').includes('..') ? resolve(project, g.source) : '' })),
    );

/**
 * Apply fix, on a verified or applied fix (null on an open one): its repair's patch, or a change
 * verified on the working tree, to mark applied. Each recording of the fixed runs it copies now, by
 * its run, with the name it takes unless another is given (`names`, the engine's
 * `defaultGoldenNames`), but one the project's goldens folder holds already, and the names that
 * folder holds (`held`; null where it isn't read), which none of them may take.
 */
function applyOffer(store: StoreOf<'team'>, rec: FixRecords, row: FixRow, toApply: StoredRepair | null, o: { refused: string | null; inTree: boolean; folder: GoldensFolder | null }): FixActions['apply'] {
  const fix = rec.fix;
  if (fix.status === 'open') return null;
  const pulled = !!toApply && store.repairPulled(toApply.repairId) !== null;
  const patch = toApply?.report.patch ?? null;
  const patchFile = toApply && patch ? `${toApply.dir.replace(/\/+$/, '')}/fix.patch` : null;
  const copies = applyGoldens(fix, toApply, { pulled });
  const made = defaultGoldenNames({ label: row.label, title: fix.title }, copies.length);
  const offered = copies.flatMap((g, i) => (g.copied ? [] : [{ run: g.run, name: made[i]!, source: g.source }]));
  const folder = o.folder ? o.folder(offered) : null;
  return {
    kind: toApply ? 'patch' : 'mark',
    argv: ['fix', 'apply', fix.fixId],
    // Once the patch is in the working tree, git apply would only fail.
    gitApply: patchFile && !o.refused && !o.inTree && fix.status !== 'applied' ? gitApplyCommand(patchFile) : null,
    pending: pendingText(applyLeft(fix, toApply, { pulled })),
    pulled,
    files: patch ? patchFiles(patch) : [],
    diff: patch,
    patchFile,
    refused: o.refused,
    inTree: o.inTree,
    goldens: copies.length,
    names: offered.filter((g) => !folder?.there.some((t) => t.run === g.run)).map((g) => ({ run: g.run, name: g.name })),
    held: folder ? [...folder.held] : null,
    change: toApply ? null : fieldChange(rec),
  };
}

/**
 * One fix, every step as its page shows it. Null for an id that matches no fix, or several.
 * `repairer` is the one shadowlap.config.json names, if any: the repair commands use it.
 * `checkRepairer` says why the repairer a repair would ask can't be asked from here, for an open fix
 * (`repairerProblem`, which looks for claude on the PATH), `patchInTree` whether a verified
 * fix's patch is in the working tree already, `rewriteHere` why `fix apply` refuses a pulled
 * repair's patch there, and `goldensFolder` what the project's goldens folder holds of the goldens
 * apply copies and what else: this stays a read of the store without them.
 */
export function fixDetail(store: StoreOf<'recording' | 'readModels' | 'activity' | 'fixes' | 'team'>, idOrPrefix: string, options: { repairer?: string | null; checkRepairer?: (repairer: string, configured: boolean) => string | null; patchInTree?: PatchCheck; rewriteHere?: RewriteCheck; goldensFolder?: GoldensFolder } = {}): FixDetail | null {
  let found: StoredFix | null;
  try {
    found = resolveFix(store, idOrPrefix);
  } catch (err) {
    if (err instanceof FixIdError) return null;
    throw err;
  }
  if (!found) return null;
  const fix = found;
  const rec = fixRecords(store, fix);
  const row = rowOf(store, rec);
  const cost = fixCost([rec]);
  const b = shownBlame(rec);
  const p = shownRepair(rec);
  const done = row.steps.filter((x) => x.state === 'done');
  const repairArgs = repairArgv(store, rec);
  const verifyArgs = verifyArgv(store, rec);
  const expect = fix.check.expect;
  const blameRun = b?.runId ?? rec.failing[0] ?? null;
  const toApply = repairToApply(rec);
  const refused = refusedOf(store, toApply, options.rewriteHere);
  // Merged by a pull request, or applied by hand: there is nothing to apply, only to mark applied.
  const inTree = patchMerged(rec, options.patchInTree);
  // A repair a teammate ran, which came with a pull: its recordings are on their machine.
  const pulled = (r: StoredRepair | null) => !!r && store.repairPulled(r.repairId) !== null;
  const shortIds = (argv: string[]) => argv.map((a) => (/^[0-9A-Z]{26}$/.test(a) ? short(a) : a));
  const configured = options.repairer?.trim() || null;
  const commands = {
    blame: commandLine(['blame', blameRun ? short(blameRun) : '<run>', ...(expectArgs(expect) ?? [])]),
    repair: commandLine(repairJobArgv(repairArgs.length ? shortIds(repairArgs) : ['repair', '--fixes', '<runs>'], configured)),
    verify: commandLine(verifyArgs.length ? shortIds(verifyArgs) : ['verify', '--fixes', '<runs>']),
  };
  const verify = [...rec.verdicts].reverse().map((v) => verifyStep(rec, v, commands.verify));
  return {
    ...row,
    expect,
    oracle: fix.check.oracle,
    failingRuns: rec.failing.map((id) => runRef(store, id)),
    goodRuns: rec.good.map((id) => runRef(store, id)),
    openedBy: fix.data.openedBy ?? null,
    upstreamRequests: cost.upstreamRequests,
    defaultStep: done.at(-1)?.key ?? 'blame',
    actions: {
      repair: fix.status === 'open' && repairArgs.length ? repairOffer(store, rec, b?.scope ?? null, commandLine(repairJobArgv(repairArgs, configured)), repairArgs) : null,
      apply: applyOffer(store, rec, row, toApply, { refused, inTree, folder: options.goldensFolder ?? null }),
      applied: fix.status === 'applied',
      ...blameNext(store, rec, b),
    },
    blame: b ? blameStep(store, b, commands.blame) : null,
    blames: [...rec.blames].reverse().map((x) => ({ blameId: x.blameId, runId: x.runId, at: x.at, outcome: x.outcome, ...(unsettledFirst(x.report) ? { unsettled: true as const } : {}), lostAt: x.report.blamed?.callNo ?? null, range: lostRange(x.report.range), confidence: x.report.confidence })),
    repair: p ? repairStep(store, rec, p, fix.fixId, pulled(p), commands.repair) : null,
    repairs: [...rec.repairs].reverse().map((x) => {
      const c = acceptedCandidate(x);
      return { repairId: x.repairId, at: x.at, outcome: x.outcome, accepted: x.accepted, title: c ? commitTitle(c) : 'No change yet' };
    }),
    verify,
    // The newest that counts: one that doesn't count for the fix never opens the step.
    defaultVerify: counting(rec).at(-1)?.verifyId ?? verify[0]?.verifyId ?? null,
    commands,
    repairer: { name: configured ?? DEFAULT_REPAIRER, configured: configured !== null, problem: fix.status === 'open' && options.checkRepairer ? options.checkRepairer(configured ?? DEFAULT_REPAIRER, configured !== null) : null },
    applied: fix.data.applied ?? null,
  };
}
