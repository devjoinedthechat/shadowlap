import { isAbsolute, join, resolve } from 'node:path';
import { applyGoldens, applyLeft, defaultGoldenNames, type FixRecords, gitApplyCommand, goldensFolder, noFixReason, patchFiles, REPAIR_CANDIDATES, repairArgv, repairJobArgv, repairPatchProblem, repairToApply, shownBlame, type StoredRepair, type StoreOf, verifyArgv } from '@shadowlap/engine';
import { blameNext } from './fix-blame-step.js';
import { repairSpent } from './fix-lead.js';
import { acceptedVerdict, commandLine, fieldsSet, type FixActions, notVerified, type PatchCheck, patchMerged, type RewriteCheck, unrepairedVerdict } from './fix-shared.js';
import { verifyLeftArgs } from './fix-verify-step.js';

/**
 * What a fix's buttons run (`FixActions`), as its page and its Fixes row read them: worked out from
 * the store's records of the fix, its blames, repairs and verdicts and the runs they name, never a
 * call. What git says of the working tree comes in as answers (`patchInTree`, `rewriteHere`), and
 * what the goldens folder holds as a read of it (`goldensFolder`), each when the caller has them.
 */

/** For a change of request fields with no patch (`--set`, `--model`), what it set: marking it applied leaves making it in the agent to you. */
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
 * A repair from here as the fix's page offers it: its command, and why it would end "No fix to try"
 * without running the agent, with which of the estimate's cases that is, as the engine words it. Read
 * only for an open fix a repair can start from.
 */
function repairOffer(store: StoreOf<'recording' | 'fixes'>, rec: FixRecords, scope: string | null, command: string, argv: string[]): NonNullable<FixActions['repair']> {
  const noFix = noFixReason(store, rec, scope);
  return { argv, command, noFix: noFix?.sentence ?? null, noFixWhy: noFix?.kind ?? null, candidates: REPAIR_CANDIDATES, spent: repairSpent(rec) };
}

/**
 * Why a fix offers no Verify this run, the first that holds: it is open; no accepted verdict counts
 * for it; no failing run it lists is left unverified in the store; its change isn't in the working
 * tree; or the accepted verdict's fields, flags or check can't be made into a verify.
 */
export type NoVerifyLeft = 'open' | 'no-verdict' | 'none-left' | 'not-in-tree' | 'not-made';

/**
 * Verify this run, on a verified or applied fix whose change is in the working tree (`inTree`: its
 * patch there, as git says; or applied, or verified on the tree as it is, with no repair behind it),
 * for its failing runs still in the store that no accepted verdict that counts checked. The CLI's
 * verify checks the code as it is now, so a change not in the tree yet is applied first. Else why not.
 */
export function verifyLeftOr(store: StoreOf<'recording'>, rec: FixRecords, inTree: boolean): { offer: NonNullable<FixActions['verifyLeft']> } | { none: NoVerifyLeft } {
  if (rec.fix.status === 'open') return { none: 'open' };
  const v = acceptedVerdict(rec);
  if (!v) return { none: 'no-verdict' };
  const runs = notVerified(rec).filter((id) => store.getRun(id) !== null);
  if (!runs.length) return { none: 'none-left' };
  if (!(inTree || rec.fix.status === 'applied' || unrepairedVerdict(rec))) return { none: 'not-in-tree' };
  const made = verifyLeftArgs(rec, v, runs);
  return made ? { offer: { runs, argv: made.argv, command: commandLine(made.argv), pulled: made.pulled, left: made.left } } : { none: 'not-made' };
}

/** Verify this run as the fix's actions offer it (`verifyLeftOr`), or null. */
export function verifyLeftOffer(store: StoreOf<'recording'>, rec: FixRecords, inTree: boolean): FixActions['verifyLeft'] {
  const got = verifyLeftOr(store, rec, inTree);
  return 'offer' in got ? got.offer : null;
}

/**
 * Why `fix apply` refuses the patch of `r`, the repair it would apply: more than its accepted
 * candidate's one rewrite (`repairPatchProblem`), or, for one a pull brought, a rewrite repair itself
 * doesn't make in this working tree, as `here` read it (`rewriteHere`).
 */
function refusedOf(store: StoreOf<'team'>, r: StoredRepair | null, here: RewriteCheck | undefined): string | null {
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
function applyOffer(store: StoreOf<'team'>, rec: FixRecords, label: string | null, toApply: StoredRepair | null, o: { refused: string | null; inTree: boolean; folder: GoldensFolder | null }): FixActions['apply'] {
  const fix = rec.fix;
  if (fix.status === 'open') return null;
  const pulled = !!toApply && store.repairPulled(toApply.repairId) !== null;
  const patch = toApply?.report.patch ?? null;
  const patchFile = toApply && patch ? `${toApply.dir.replace(/\/+$/, '')}/fix.patch` : null;
  const copies = applyGoldens(fix, toApply, { pulled });
  const made = defaultGoldenNames({ label, title: fix.title }, copies.length);
  const offered = copies.flatMap((g, i) => (g.copied ? [] : [{ run: g.run, name: made[i]!, source: g.source }]));
  const folder = o.folder ? o.folder(offered) : null;
  const argv = ['fix', 'apply', fix.fixId];
  return {
    kind: toApply ? 'patch' : 'mark',
    argv,
    command: commandLine(argv),
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

export interface FixActionsOptions {
  /** The label the fix goes by (`fixLabelInfo`), which the goldens apply copies are named after. */
  label: string | null;
  /** The repairer shadowlap.config.json names, or null: the repair command names it. */
  repairer: string | null;
  patchInTree?: PatchCheck | undefined;
  rewriteHere?: RewriteCheck | undefined;
  goldensFolder?: GoldensFolder | null | undefined;
  /** The engine's `repairArgv` for the fix, where the caller has it already: each is a read of every run. */
  repairArgs?: readonly string[] | undefined;
  /** The engine's `verifyArgv` for the fix, likewise: without it, worked out only for an open fix, the one a list's row leads with it for. */
  verifyArgs?: readonly string[] | undefined;
}

/**
 * Verify your change (`FixActions['verifyChange']`): the fix's verify command, with the failing runs
 * it verifies, every one left in the store, those it holds out among them (as `verifyArgv` selects
 * them, read with no other read of every run); null where it makes none.
 */
function verifyChangeOffer(store: StoreOf<'recording'>, rec: FixRecords, argv: readonly string[]): FixActions['verifyChange'] {
  if (!argv.length) return null;
  return { runs: rec.failing.filter((id) => store.getRun(id) !== null), argv: [...argv], command: commandLine([...argv]) };
}

/** What each of a fix's buttons would run, as its page offers them and its Fixes row leads with one (fix-lead.ts). */
export function fixActions(store: StoreOf<'recording' | 'fixes' | 'team'>, rec: FixRecords, o: FixActionsOptions): FixActions {
  const fix = rec.fix;
  const b = shownBlame(rec);
  const repairArgs = fix.status === 'open' ? [...(o.repairArgs ?? repairArgv(store, rec))] : [];
  const toApply = repairToApply(rec);
  const configured = o.repairer?.trim() || null;
  const inTree = patchMerged(rec, o.patchInTree);
  return {
    repair: repairArgs.length ? repairOffer(store, rec, b?.scope ?? null, commandLine(repairJobArgv(repairArgs, configured)), repairArgs) : null,
    // Merged by a pull request, or applied by hand: there is nothing to apply, only to mark applied.
    apply: applyOffer(store, rec, o.label, toApply, { refused: refusedOf(store, toApply, o.rewriteHere), inTree, folder: o.goldensFolder ?? null }),
    applied: fix.status === 'applied',
    ...blameNext(store, rec, b),
    verifyLeft: verifyLeftOffer(store, rec, inTree),
    // The list leads with it only for an open fix, so a row of any other reads no runs for it; the page gives its own.
    verifyChange: verifyChangeOffer(store, rec, o.verifyArgs ?? (fix.status === 'open' ? verifyArgv(store, rec) : [])),
  };
}
