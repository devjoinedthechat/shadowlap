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
 * fix-repair-step.ts, fix-verify-step.ts), fix-summary.ts, fix-for-run.ts, fix-bundles.ts and
 * fix-checks.ts, with what they share in fix-shared.ts. This one keeps a fix's page (fixDetail) and
 * the commands its buttons run, and exports the rest.
 */

import { applyLeft, commitTitle, fixCost, FixIdError, fixLabelInfo, fixRecords, gitApplyCommand, GOOD_LABEL, hasRecordedCommand, patchFiles, repairPatchProblem, repairToApply, resolveFix, type FixData, type FixRecords, type RepairOutcome, type RunRecord, type StoreOf, type StoredBlame, type StoredFix, type StoredRepair, unsettledFirst } from '@shadowlap/engine';
import { expectArgs, scopeArg } from './rerun.js';
import { type FixRow, rowOf } from './fix-list.js';
import { acceptedCandidate, commandLine, counting, fieldsSet, type FixActions, type PatchCheck, patchMerged, patchToCheck, runHref, short, shownBlame, shownRepair, type StepKey, unrepairedVerdict } from './fix-shared.js';
import { blameNext, blameStep, type BlameStep, noFixToTry } from './fix-blame-step.js';
import { repairStep, type RepairStep } from './fix-repair-step.js';
import { verifyStep, type VerifyStep } from './fix-verify-step.js';
export { type StepState, type FixStep, type FixRow, type FixList, fixList } from './fix-list.js';
export { type BlameStep } from './fix-blame-step.js';
export { type CandidateVerdict, type RepairStep } from './fix-repair-step.js';
export { type VerifyStep, type VerifyMore } from './fix-verify-step.js';
export { type FixesSummary, type WeekWindows, fixesSummary, type NeedsLookItem, needsLookFixes } from './fix-summary.js';
export { type FixRef, type RunBlame, type FixForRun, fixForRun } from './fix-for-run.js';
export { type FixBundleAttempt, type FixBundle, fixBundles } from './fix-bundles.js';
export { type BlameCheck, failedChecks, configExpect, blameCheckFor } from './fix-checks.js';
export { type StepKey, type VerifyRow, type FixActions, fixHref, shortFailure, type PatchCheck } from './fix-shared.js';

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
  /** Every blame, newest first: `unsettled` for one that placed the failure on no call only because its first probe couldn't tell. */
  blames: Array<{ blameId: string; runId: string; at: number; outcome: StoredBlame['outcome']; unsettled?: true; lostAt: number | null; confidence: string }>;
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

/**
 * Whether `label:<label>` selects exactly the fix's failing runs that are left: none of another
 * fix's (a customer's label, say), no run in no fix (a run that passed, labelled with the failure
 * it was recorded for), and every one of the fix's. Anything else would be repaired as failing.
 */
function labelSelectsFix(store: StoreOf<'recording'>, label: string, left: readonly string[]): boolean {
  const failing = new Set(left);
  const labelled = store.allRuns().filter((r) => r.meta?.labels?.includes(label));
  return labelled.length === failing.size && labelled.every((r) => failing.has(r.runId));
}

/** A word of a command that names the script it runs: `agent.mjs`, `src/agent.ts`, `refund_agent.py`. */
const SCRIPT = /\.(?:[cm]?[jt]sx?|py|rb|sh|php|pl|lua|exs?|jl)$/i;

/**
 * The agent a command runs, to tell one agent's runs from another's: its words up to the script it
 * runs (`node agent.mjs`, `python -m support.agent`), without the arguments of one run (`A-1150`,
 * `--persona pushy-customer`); the whole command when no word names a script. Null for none.
 */
export function agentOfArgv(argv: readonly string[]): string | null {
  if (!argv.length) return null;
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === '-m' && i + 1 < argv.length) return argv.slice(0, i + 2).join(' ');
    if (!w.startsWith('-') && SCRIPT.test(w)) return argv.slice(0, i + 1).join(' ');
  }
  return argv.join(' ');
}

/** The agent a run ran: its recording's, for a replay, a fork or an attempt; null for a run with no command (an import). */
function agentOfRun(store: StoreOf<'recording'>, run: RunRecord): string | null {
  let root = run;
  const seen = new Set([root.runId]);
  while (root.parentRunId) {
    const parent = store.getRun(root.parentRunId);
    if (!parent || seen.has(parent.runId)) break;
    seen.add(parent.runId);
    root = parent;
  }
  return hasRecordedCommand(root) ? agentOfArgv(root.command.argv) : null;
}

/**
 * The good runs a repair or a verify from a fix keeps: the fix's own good runs (those a repair or a
 * verify of it kept); else the runs labelled good that run the same agent as its failing runs
 * (`label:good` when that is all of them, else by id), since a good run of another agent checks
 * nothing a change to this one touches; else none.
 */
function keepArgs(store: StoreOf<'recording'>, rec: FixRecords, left: readonly string[]): string[] {
  const own = rec.good.filter((id) => store.getRun(id) !== null);
  if (own.length) return own;
  const agents = new Set(left.map((id) => agentOfRun(store, store.getRun(id)!)).filter((a): a is string => a !== null));
  if (!agents.size) return [];
  const failing = new Set(left);
  const good = store.allRuns().filter((r) => r.meta?.labels?.includes(GOOD_LABEL));
  const same = good.filter((r) => !failing.has(r.runId) && agents.has(agentOfRun(store, r) ?? ''));
  if (!same.length) return [];
  return same.length === good.length ? [`label:${GOOD_LABEL}`] : same.map((r) => r.runId);
}

/** What a repair from a fix and a verify of it are given: its failing runs, the good runs it keeps, and its check. */
function fixRunArgs(store: StoreOf<'recording' | 'fixes'>, rec: FixRecords): { fixes: string[]; keeps: string[]; expect: string[] } | null {
  // Without a failing run left, a label would select nothing, and repair would refuse it.
  const left = rec.failing.filter((id) => store.getRun(id) !== null);
  if (!left.length) return null;
  const { label } = fixLabelInfo(store, rec.fix);
  // A check that is no object (one a pull brought, say) is no `--expect`: nothing runs under it.
  const expect = expectArgs(rec.fix.check.expect);
  if (!expect) return null;
  return {
    fixes: label && labelSelectsFix(store, label, left) ? [`label:${label}`] : left,
    keeps: keepArgs(store, rec, left),
    expect,
  };
}

/**
 * `shadowlap repair` from a fix: its failing runs (by its label when that selects exactly them),
 * the good runs it keeps (`keepArgs`), the scope its blame searched, so the repair blames the same
 * calls and reuses that blame rather than make it again, and its check. Empty when none of its
 * failing runs is left in the store.
 */
export function repairArgv(store: StoreOf<'recording' | 'fixes'>, rec: FixRecords): string[] {
  const runs = fixRunArgs(store, rec);
  // A blame's scope (a pulled one's too) goes as `--scope` only when it is a name, never a flag.
  const scope = scopeArg(shownBlame(rec)?.scope);
  if (!runs || !scope) return [];
  return ['repair', '--fixes', ...runs.fixes, ...(runs.keeps.length ? ['--keeps', ...runs.keeps] : []), ...scope, ...runs.expect];
}

/** `shadowlap verify` of a change for a fix, as its empty Verify step shows it: the runs and the check a repair from it would take. Empty as `repairArgv` is. */
function verifyArgv(store: StoreOf<'recording' | 'fixes'>, rec: FixRecords): string[] {
  const runs = fixRunArgs(store, rec);
  if (!runs) return [];
  return ['verify', '--fixes', ...runs.fixes, ...(runs.keeps.length ? ['--keeps', ...runs.keeps] : []), ...runs.expect];
}

/** The repairer a repair from the dashboard (or `fix show`'s next step) uses when the config names none. */
export const DEFAULT_REPAIRER = 'claude-code';

/**
 * `shadowlap repair` as the dashboard runs it: a repairer set in shadowlap.config.json applies by
 * itself, as the CLI reads it; otherwise the user's own Claude Code, named on the command line.
 */
export function repairJobArgv(argv: readonly string[], configured: string | null | undefined): string[] {
  return [...argv, ...(configured ? [] : ['--repairer', DEFAULT_REPAIRER])];
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
 * One fix, every step as its page shows it. Null for an id that matches no fix, or several.
 * `repairer` is the one shadowlap.config.json names, if any: the repair commands use it.
 * `checkRepairer` says why the repairer a repair would ask can't be asked from here, for an open fix
 * (`repairerProblem`, which looks for claude on the PATH), and `patchInTree` whether a verified
 * fix's patch is in the working tree already: this stays a read of the store without them.
 */
export function fixDetail(store: StoreOf<'recording' | 'readModels' | 'activity' | 'fixes' | 'team'>, idOrPrefix: string, options: { repairer?: string | null; checkRepairer?: (repairer: string, configured: boolean) => string | null; patchInTree?: PatchCheck } = {}): FixDetail | null {
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
  const refused = toApply ? repairPatchProblem(toApply.report) : null;
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
      repair: fix.status === 'open' && repairArgs.length ? { argv: repairArgs, command: commandLine(repairJobArgv(repairArgs, configured)), noFix: noFixToTry(store, rec, b?.scope ?? null) } : null,
      apply:
        fix.status === 'open'
          ? null
          : {
              kind: toApply ? 'patch' : 'mark',
              argv: ['fix', 'apply', fix.fixId],
              // Once the patch is in the working tree, git apply would only fail.
              gitApply: toApply?.report.patch && !refused && !inTree && fix.status !== 'applied' ? gitApplyCommand(`${toApply.dir.replace(/\/+$/, '')}/fix.patch`) : null,
              pending: pendingText(applyLeft(fix, toApply, { pulled: pulled(toApply) })),
              pulled: pulled(toApply),
              files: toApply?.report.patch ? patchFiles(toApply.report.patch) : [],
              diff: toApply?.report.patch ?? null,
              patchFile: toApply?.report.patch ? `${toApply.dir.replace(/\/+$/, '')}/fix.patch` : null,
              refused,
              inTree,
              goldens: toApply && !pulled(toApply) ? toApply.report.output.goldens.length : 0,
              change: toApply ? null : fieldChange(rec),
            },
      applied: fix.status === 'applied',
      ...blameNext(store, rec, b),
    },
    blame: b ? blameStep(store, b, commands.blame) : null,
    blames: [...rec.blames].reverse().map((x) => ({ blameId: x.blameId, runId: x.runId, at: x.at, outcome: x.outcome, ...(unsettledFirst(x.report) ? { unsettled: true as const } : {}), lostAt: x.report.blamed?.callNo ?? null, confidence: x.report.confidence })),
    repair: p ? repairStep(store, rec, p, fix.fixId, pulled(p), commands.repair) : null,
    repairs: [...rec.repairs].reverse().map((x) => {
      const c = acceptedCandidate(x);
      return { repairId: x.repairId, at: x.at, outcome: x.outcome, accepted: x.accepted, title: c ? commitTitle(c) : 'No fix yet' };
    }),
    verify,
    // The newest that counts: one that doesn't count for the fix never opens the step.
    defaultVerify: counting(rec).at(-1)?.verifyId ?? verify[0]?.verifyId ?? null,
    commands,
    repairer: { name: configured ?? DEFAULT_REPAIRER, configured: configured !== null, problem: fix.status === 'open' && options.checkRepairer ? options.checkRepairer(configured ?? DEFAULT_REPAIRER, configured !== null) : null },
    applied: fix.data.applied ?? null,
  };
}
