import {
  applyLeft,
  BLAME_DEFAULTS,
  canonicalize,
  commitTitle,
  describeBlocks,
  describeGate,
  describeRescue,
  eachRun,
  findPairs,
  fixCost,
  FixIdError,
  fixLabelInfo,
  fixLabels,
  fixOfRun,
  fixRecords,
  footprintDelta,
  formatUsd,
  GATE_MAX_ATTEMPTS,
  gateOdds,
  gitApplyCommand,
  GOOD_LABEL,
  hasRecordedCommand,
  NO_REPAIRER,
  noRepairerOf,
  outcomeOf,
  patchFiles,
  pinWords,
  probeBound,
  probeFinding,
  probeTally,
  probeWord,
  recordingsOfRun,
  repairMarkdown,
  repairPatchProblem,
  repairToApply,
  rescueRule,
  resolveFix,
  SPRT_DEFAULTS,
  testsEntryFor,
  unrescuedHead,
  unrescuedWhy,
  verdictCounts,
  rateBound,
  type Block,
  type BlameReport,
  type FixData,
  type FixRecords,
  type FixStatus,
  type PulledFrom,
  type RepairCandidate,
  type RepairOutcome,
  type RunRecord,
  type Store,
  type StoredBlame,
  type StoredFix,
  type StoredRepair,
  type SprtGate,
  type StoredVerdict,
  type VerdictStanding,
  type VerifiedRun,
  type VerifyOutcome,
  unrescuedWords,
  unsettledFirst,
  unsettledReason,
} from '@shadowlap/engine';
import { blameEvidence, gateEvidence, verifyEvidence, type BlameEvidence, type GateEvidence, type VerifyEvidence } from './evidence.js';
import { links } from './links.js';
import { expectArgs, fieldArgs, isCount, rerunFlags, runIds, scopeArg, type RerunFlags } from './rerun.js';
import { loadRunIndex, type RunIndex } from './run-index.js';
import { splitCommandLine } from './settings.js';
import { probeLine, runsRule, verifiedLine, type VerdictTone } from './verdict.js';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A report's gate as the steps read it: an SPRT gate with its four figures, or null for a fixed
 * count, or for one a copy from elsewhere carries malformed (the team store refuses those on pull;
 * a store edited by hand could still hold one).
 */
function sprtGate(g: unknown): SprtGate | null {
  if (!g || typeof g !== 'object') return null;
  const x = g as Record<string, unknown>;
  return x.kind === 'sprt' && finite(x.good) && finite(x.bad) && finite(x.risk) && finite(x.max) ? { kind: 'sprt', good: x.good, bad: x.bad, risk: x.risk, max: x.max } : null;
}

/** A run's gate result as the Verify step shows it: its decision, the Wilson interval, its sentence and the bound beside its tally; null when there is none to read. */
function rateOf(g: unknown): VerifyRow['rate'] {
  if (!g || typeof g !== 'object') return null;
  const x = g as Record<string, unknown>;
  const i = x.interval as Record<string, unknown> | null | undefined;
  if (typeof x.decision !== 'string' || typeof x.sentence !== 'string' || !i || typeof i !== 'object' || !finite(i.lo) || !finite(i.hi) || !finite(i.confidence)) return null;
  const attempts = finite(x.attempts) ? x.attempts : 0;
  const decision = x.decision === 'pass' || x.decision === 'fail' || x.decision === 'inconclusive' || x.decision === 'continue' ? x.decision : undefined;
  // A clean replay's one attempt has no rate to show: it comes out the same every time.
  return { decision: x.decision, lo: i.lo, hi: i.hi, confidence: i.confidence, sentence: x.sentence, bound: decision && x.clean !== true ? rateBound({ attempts, interval: { lo: i.lo, hi: i.hi, confidence: i.confidence }, decision }) : null };
}

/**
 * Fixes, as the dashboard and `shadowlap fix --json` read them: plain JSON from the store, one
 * function per view, no HTTP. A fix is one failure and its three steps (blame, repair, verify);
 * engine `fixes.ts` says how runs, blames, repairs and verdicts are grouped into one, and when a
 * verdict counts for a fix. Only verdicts that count move a step; the others are listed with why.
 *
 * Besides the Fixes list and a fix's page, other views read fixes through three helpers here:
 * `fixesSummary` (the Overview's outcomes and funnel), `needsLookFixes` (Needs a look) and
 * `fixForRun` (a run page's banners and the Forks view's bundles).
 */

export type StepKey = 'blame' | 'repair' | 'verify';
/**
 * Done, to do, (Verify only) rejected, or `warn`: a step that ran and needs a look, in amber, never
 * the grey of one not run yet: a blame no model call rescued ("not rescued"), one that couldn't
 * settle ("not settled") or stopped part way ("blame stopped"), a verify left inconclusive or
 * stopped before every run settled ("not settled").
 */
export type StepState = 'done' | 'todo' | 'no' | 'warn';

/** One of a fix's three steps, as the list (`short`) and the stepper (`title`, `meta`) show it. */
export interface FixStep {
  key: StepKey;
  n: '01' | '02' | '03';
  state: StepState;
  short: string;
  title: string;
  meta: string;
}

export interface FixRow {
  fixId: string;
  href: string;
  status: FixStatus;
  title: string;
  /** The label it goes by (the one most of its failing runs carry), or null when they carry none. */
  label: string | null;
  /** Every label it groups runs by: those its failing runs carry, `good` aside. */
  labels: string[];
  /** What a passing run does, in words. */
  check: string;
  /**
   * What its failing runs did, in the words blame titled the fix with when it opened it (`send_email
   * called twice, not once`): its title, until someone gives it one of their own. Without that
   * opening here (a teammate's fix), the first failure a blame of it recorded, as the CLI words it;
   * null when no blame recorded one. The page says it beside the check unless the title says it.
   */
  failed: string | null;
  failing: number;
  good: number;
  steps: FixStep[];
  /** Where it came from, such as "from CI · PR #138", or null for a fix opened here. */
  source: string | null;
  openedAt: number;
  verifiedAt: number | null;
  appliedAt: number | null;
  /** For an applied fix that doesn't hold, why: its test failed, or a verify rejected it since. */
  broken: string | null;
  /** What everything behind it took: attempts that ran live, and what they and the repairer cost. */
  attempts: number;
  spent: number;
}

export interface FixList {
  fixes: FixRow[];
  /** For the filter chips: Verified counts applied fixes too. */
  counts: { all: number; open: number; verified: number };
}

export interface FixRunRef {
  runId: string;
  href: string;
  /** False when the run was deleted from the store since. */
  exists: boolean;
  status: RunRecord['status'] | null;
  startedAt: number | null;
  labels: string[];
}

export interface BlameStep {
  blameId: string;
  runId: string;
  runExists: boolean;
  at: number;
  outcome: StoredBlame['outcome'];
  title: string;
  /** The model call whose recorded answer lost the run, by call number. */
  lostAt: number | null;
  /** Its position among the model calls of the blame's scope: model call `step` of `steps`. */
  step: number | null;
  steps: number;
  scope: string | null;
  confidence: 'high' | 'medium' | 'low';
  confidenceWhy: string;
  /** The evidence on both sides of the boundary, in one sentence. */
  boundary: string;
  /** The next model call, where asking again no longer rescued the run. */
  next: { callNo: number; step: number; passes: number; attempts: number } | null;
  rescuedRunId: string | null;
  /** What the model answered at the blamed call in the recording and in the rescued fork, in one line each. */
  answers: { callNo: number; recorded: string; rescued: string } | null;
  /**
   * How many training pairs the blame's attempts made, as `export pairs` counts them (engine
   * pairs.ts): each passing answer at the blamed call against the recorded one. Null once the
   * blamed run is gone from the store.
   */
  pairs: number | null;
  /** How a probe asked again: "resample the probed call", or the fields it changed. */
  rescue: string;
  /** A rescue needs `needed` of `attemptsPerProbe` attempts to pass, or, decided by a gate, the fewest passes that can rescue and the most attempts. */
  needed: number;
  attemptsPerProbe: number;
  /** How a probe decides, its gate's rule said once: `gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts`, or `a rescue needs 2 of 5 attempts to pass`. */
  rule: string;
  /** Each probe: its tally and verdict, and under a gate the Wilson bound on the attempts it decided on (`bound`, `rate >= 0.34 (95%)`; null for a fixed count). */
  /** Each probe: `inconclusive` counts its attempts that could not be judged, neither passed nor failed. */
  probes: Array<{ callNo: number; step: number; passes: number; attempts: number; inconclusive: number; verdict: 'rescued' | 'lost' | 'inconclusive' | 'rescued · blamed'; bound: string | null; blamed: boolean; href: string; gate: GateEvidence }>;
  /** The attempts, bundled per probe. */
  bundles: Array<{ callNo: number; title: string; blamed: boolean; passes: number; attempts: Array<{ runId: string; passed: boolean; verdict: AttemptVerdict; note: string; spent: number; href: string }> }>;
  /** Every call of the run, for the row that shows where it was lost; `inScope` is false for a call outside the blame's scope. */
  callRow: Array<{ callNo: number; kind: string; inScope: boolean; verdict: 'rescued' | 'lost' | 'inconclusive' | 'blamed' | null; passes: number; attempts: number; inconclusive: number }>;
  cost: { attempts: number; upstreamRequests: number; spent: number; unknownModels: string[] };
  oracle: string[];
  recordedFailures: string[];
  stopReason: string | null;
  /**
   * For a blame that placed the failure on no call and knows no answer of the model's lost the run
   * (its passing attempts answered as the recording did, or every attempt met a write's recorded
   * error again): where to look instead. Null otherwise.
   */
  look: string | null;
  warnings: string[];
  /**
   * The command that blames the run the same way again: as it ran, for a blame made here; for one
   * a pull brought (`pulled`), made here from its checked fields, so a teammate's command line is
   * never offered to copy.
   */
  command: string;
  /** The store a pull brought it from, and when; null for a blame made here. */
  pulled: PulledFrom | null;
  hrefs: { run: string; lostAt: string | null; rescued: string | null };
  /** What the report says beyond its probes, when it says it: the calls it lost the run between, and its error bound. */
  evidence: BlameEvidence;
}

export type CandidateVerdict = 'accepted' | 'rejected' | 'set aside' | 'not tried' | 'build failed' | 'unsettled';

export interface RepairStep {
  repairId: string;
  at: number;
  /** Its files, relative to the project folder: `.shadowlap/repairs/<id>`. */
  dir: string;
  outcome: RepairOutcome;
  accepted: boolean;
  /** The accepted change in a few words (the commit title), or "No fix yet". */
  title: string;
  /** Why nothing was accepted. */
  why: string | null;
  /** Who proposed the candidates: `claude-code`, `anthropic:claude-opus-5-5`; null when no repairer answered. */
  repairer: string | null;
  /**
   * Why no repairer proposed candidates: in a few words (`text`: `the repairer could not be asked:
   * claude was not found`, `the repairer had nothing it could rewrite`, `no repairer is configured`),
   * and the one of `warnings` that says it at length, with what to do. Null when one answered, or
   * when nothing called for it (a fix that needs no model was accepted, no failing run was rescued).
   */
  noRepairer: { text: string; warning: string | null } | null;
  /** The model that answered, when it differs from the one asked. */
  served: string | null;
  /** The gate's run on the accepted candidate: its verdict, attempts and spend, and whether it counts for this fix. */
  verify: { verifyId: string | null; attempts: number; spent: number; counts: boolean } | null;
  change: { file: string; anchor: string; before: string; after: string; added: { at: number; text: string } | null; removed: string } | null;
  /** The accepted change's result per role: target 1 of 1. */
  roles: Array<{ role: 'target' | 'held-out' | 'good'; held: number; of: number }>;
  needed: number | null;
  attemptsPerRun: number | null;
  /** How each run was decided: `each at 4 of 5 attempts`, or `each by its gate, which tells 90%+ from 70%- at <= 5% risk`, with the good runs' baseline rule after it when they were kept against one (verify's `eachRun`); null without a verification. */
  rule: string | null;
  /** Where each failing run was lost, from its blame. */
  lost: Array<{ runId: string; at: string; href: string }>;
  diagnosis: string | null;
  candidates: Array<{ id: number; text: string; surface: string; file: string; source: 'repairer' | 'model'; verdict: CandidateVerdict; why: string }>;
  files: Array<{ name: string; note: string }>;
  /** report.md: the pull request body. */
  prBody: string;
  command: string;
  /** `judge`: what judge checks' calls cost across blame and verify, when one was asked live. */
  cost: { blame: number; repairer: number | null; verify: number; judge?: number };
  /**
   * Every attempt the repair ran (`repairAttempts`): the probes of the blames it ran and the
   * verification of every candidate it tried, the ones it dropped and the one it accepted. Its
   * receipt leads with them.
   */
  attempts: number;
  output: { patch: string | null; applied: boolean; branch: string | null; pr: string | null; goldens: string[] };
  warnings: string[];
  /**
   * It came with a fix from the team store: it ran on a teammate's machine, where the recordings the
   * fixed code made (its goldens) stayed. Its patch and reports were written here by the pull.
   */
  pulled: boolean;
}

export interface VerifyRow {
  role: 'target' | 'held-out' | 'good';
  runId: string;
  href: string;
  attempts: number;
  passes: number;
  /** Attempts that could not be judged (all they fell short on is a check that could not be decided): neither passed nor failed. */
  inconclusive: number;
  /** The first attempt replayed clean, so it settled the run. */
  deterministic: boolean;
  outcome: ReturnType<typeof outcomeOf>;
  /**
   * Decided by a gate: what it said, the pass rate's Wilson interval at the confidence it decided at,
   * and its bound as the Attempts column shows it (`rate >= 0.76 (95%)`). Null for a fixed count, and
   * for a run an attempt it could not judge stopped before its gate decided anything.
   */
  rate: { decision: string; lo: number; hi: number; confidence: number; sentence: string; bound: string | null } | null;
  /** Where it went: where it forked, or why it failed. */
  note: string;
  /** Input tokens and cost per run, as recorded and under the change (the mean of its attempts). */
  tokens: { recorded: number; now: number } | null;
  cost: { recorded: number | null; now: number | null } | null;
  /** What verify's JSON says of the run beyond its tally, when it says it: its gate's bound method and unavailable attempts, its baseline and margin. */
  evidence: VerifyEvidence;
}

export interface VerifyStep {
  verifyId: string;
  href: string;
  at: number;
  verdict: VerifyOutcome;
  /** Whether it counts for this fix: it checked the fix's check on a run that failed it as recorded. */
  counts: boolean;
  /** That it was rejected after the fix was applied; null otherwise. One that doesn't count says why in its `headline`. */
  note: string | null;
  /** What was verified, named by what changed (`changeName`): "repair candidate 3", the request fields it set, or the code version. */
  code: string;
  /** How the switch between changes names it: "repair candidate 3 · accepted", and "· doesn't count" after one that doesn't count for the fix. */
  label: string;
  /** By the runs it checked ("Fixes 1 of 1 target run, keeps 1 of 1 good"), or for one that doesn't count, why ("Doesn't count for this fix: …"). */
  headline: string;
  /** "a run passes when 4 of 5 attempts meet the check: …" */
  oracle: string;
  needed: number;
  attemptsPerRun: number;
  rows: VerifyRow[];
  tokens: { before: number; after: number; change: string } | null;
  cost: { before: number; after: number; change: string } | null;
  attempts: number;
  upstreamRequests: number;
  spent: number;
  unknownModels: string[];
  reasons: string[];
  /** Those of `reasons` that say a run is inconclusive or not settled, not that the change failed it: shown in amber, the rest in red. */
  unsettled: string[];
  warnings: string[];
  /**
   * The command it ran: as it ran, for a verdict given here; for one a pull brought (`pulled`), the
   * same verify made here from its checked fields, so a teammate's command line is never offered to
   * copy.
   */
  command: string;
  /** The store a pull brought it from, and when; null for a verdict given here. */
  pulled: PulledFrom | null;
  repairId: string | null;
  candidate: number | null;
  /** What settles an incomplete verdict that counts for the fix (`verifyMore`); null for any other. */
  more: VerifyMore | null;
}

/**
 * What settles an incomplete verdict that counts for the fix, when it is a change `shadowlap verify`
 * checks by itself (not a repair's candidate, which only its repair can put in the working tree).
 * `more`: Run more attempts, its runs verified again from the start (verify has no `--continue`),
 * named by id in their roles, with twice the limit when a gate ran out of attempts, and without the
 * `--budget` that stopped it (`budget`); `again`: Verify again, the same command once the check
 * that couldn't be judged can be. `run` is the run it names first, and why it is open: its gate
 * ran out of attempts (`inconclusive`), the verify stopped first (`stopped`, with why), or an
 * attempt could not be judged (`unjudged`, with which attempt and why). `expected` is the attempts
 * it runs on average, each run at the rate it passed at so far, and `cost` what that would cost at
 * the verdict's own spend per attempt (null when it spent nothing it kept).
 */
export interface VerifyMore {
  kind: 'more' | 'again';
  run: { runId: string; state: 'inconclusive' | 'stopped' | 'unjudged'; why: string | null; attempt: number | null };
  max: number;
  expected: number;
  cost: number | null;
  /** The budget the verdict ran with, which Run more attempts leaves out; null when it had none. */
  budget: string | null;
  /** Built from the verdict's checked fields and flags (rerun.ts), never from its command line. */
  argv: string[];
  command: string;
  /** The store a pull brought the verdict from: it runs only once the user says yes to `command`. Null for one given here. */
  pulled: PulledFrom | null;
  /** What a pulled verdict ran with that runs on no other machine, left out: `--build`, `--base`, and `--` for the command after it. */
  left: string[];
}

export interface FixActions {
  /**
   * An open fix: repair from here. Argv after `shadowlap`, without `--db` or `--repairer`, which the
   * caller adds (`repairJobArgv`); `command` is the whole command line, repairer included. `noFix`:
   * why the repair would end "No fix to try" without running the agent, in a sentence (`noFixToTry`),
   * or null when it would run it.
   */
  repair: { argv: string[]; command: string; noFix: string | null } | null;
  /**
   * A verified or applied fix: apply its repair's patch (`patch`), or mark a change verified in the
   * working tree applied (`mark`). Once `applied`, the button is "Patch applied" ("Marked applied"
   * for a fix with no patch) and disabled, unless `pending` says what applying left undone, which
   * running it again finishes. `pulled`: the repair came from the team store, so its recordings are
   * on the machine that ran it, and applying here puts in the patch alone and runs nothing from it.
   * `files`: every file the patch changes, and `diff` the patch itself, for the confirm dialog to
   * show what goes in. `refused`: why `fix apply` won't put it in (it is more than the one rewrite
   * its repair verified); then there is no git apply command to copy either (`gitApply`, as
   * `gitApplyCommand` writes it), nor once the patch is in: `inTree` for a verified fix whose patch
   * is in the working tree already (merged, or applied by hand), which applying only marks applied,
   * and the fix applied. `patchFile` is where the patch is, relative to the project folder.
   * `goldens`: how many recordings the fixed code made that applying copies into the goldens folder
   * and tests. `change`: for a change of request fields (`--set`, `--model`) with no patch, what it
   * set (`fieldChange`): marking it applied leaves making it in the agent to you.
   */
  apply: { kind: 'patch' | 'mark'; argv: string[]; gitApply: string | null; pending: string | null; pulled: boolean; files: string[]; diff: string | null; patchFile: string | null; refused: string | null; inTree: boolean; goldens: number; change: string | null } | null;
  applied: boolean;
  /**
   * An open fix whose blame couldn't settle where its run was lost (`unsettled`: its first probe
   * passed between the gate's two rates) or stopped part way (`stopped`): Blame again, the same
   * blame under the fix's check, without the budget that stopped it, and for one not settled with
   * more attempts and a lower bar, as blame's report says (`gate`). Null otherwise.
   */
  blameAgain: { kind: 'unsettled' | 'stopped'; argv: string[]; command: string; gate: SprtGate | null; pulled: PulledFrom | null; left: string[] } | null;
  /**
   * An open fix whose blame rescued its run from no call, asking the recorded model again, and
   * found nothing that says the model's answer isn't what lost it: Blame with a stronger model, the
   * same blame with `--model <model>` after `argv`, the model asked for. `attempts` and `spent` are
   * what the last blame took. Null otherwise. Both are built from the blame's checked fields and
   * flags (rerun.ts), never from its command line; one a pull brought (`pulled`) runs only once the
   * user says yes to its command, without what runs on no other machine (`left`).
   */
  blameStronger: { argv: string[]; command: string; attempts: number; spent: number; pulled: PulledFrom | null; left: string[] } | null;
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

// ---- Shared pieces ---------------------------------------------------------------------------

// Links come from the one builder (links.ts), which the page's route parser reads back.
export const fixHref = (fixId: string, step?: StepKey, sub?: string): string => links.fixes(fixId, step ?? null, sub ?? null);
const runHref = (runId: string, call?: number | null): string => links.run(runId, call ?? null);
const short = (id: string) => id.slice(0, 10);
const s = (n: number) => (n === 1 ? '' : 's');
const approx = (usd: number) => `≈${formatUsd(usd)}`;
const ROLE: Record<VerifiedRun['role'], VerifyRow['role']> = { target: 'target', holdout: 'held-out', good: 'good' };

/** Single quotes around a shell word that needs them, as the CLI prints commands. */
const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const commandLine = (argv: string[]) => ['shadowlap', ...argv].map(quote).join(' ');

/** The blame a fix shows: the latest that found where a run was lost, else the latest. */
function shownBlame(rec: FixRecords): StoredBlame | null {
  return [...rec.blames].reverse().find((b) => b.outcome === 'blamed') ?? rec.blames.at(-1) ?? null;
}

/**
 * Whether a blame placed the failure on no call and knows that no answer of the model's lost the
 * run: its passing attempts answered as the recording did, or every attempt met a write's recorded
 * error again. A prompt repair is no fix for such a run; the tools, the harness or the command are.
 */
function noAnswerLost(b: StoredBlame | null): boolean {
  return !!b && b.outcome === 'unrescuable' && !!(b.report.sameAnswer || b.report.failedWrite);
}

/** Whether a repair's accepted candidate was verified in a way that counts for the fix. */
const repairCounts = (rec: FixRecords, r: StoredRepair) => rec.verdicts.some((v) => v.repairId === r.repairId && verdictCounts(rec, v));

/** The repair a fix shows: the latest whose accepted candidate counts for it, else the latest that accepted one, else the latest. */
function shownRepair(rec: FixRecords): StoredRepair | null {
  const latest = [...rec.repairs].reverse();
  return latest.find((r) => r.accepted && repairCounts(rec, r)) ?? latest.find((r) => r.accepted) ?? latest[0] ?? null;
}

const counting = (rec: FixRecords) => rec.verdicts.filter((v) => verdictCounts(rec, v));

function acceptedVerdict(rec: FixRecords): StoredVerdict | null {
  return [...counting(rec)].reverse().find((v) => v.verdict === 'accepted') ?? null;
}

const acceptedCandidate = (r: StoredRepair): RepairCandidate | null => (r.accepted ? (r.report.candidates.find((c) => c.id === r.report.accepted) ?? null) : null);

function repairerLabel(r: StoredRepair): string | null {
  const x = r.report.repairer;
  if (!x) return null;
  return x.model ? `${x.provider}:${x.model}` : x.provider;
}

/** What kind of change a candidate is, in two words. */
function changeKind(c: RepairCandidate): string {
  if (c.source === 'model' || c.surface === 'model') return 'model switch';
  if (c.surface.startsWith('tool ')) return 'tool description fix';
  return 'prompt fix';
}

/** "from CI", "from CI · PR #138", "PR #138". A pull request's state shows once it is known to be merged or closed. */
function sourceText(fix: StoredFix): string | null {
  const src = fix.data.source;
  if (!src) return null;
  const pr = src.pr ? `PR ${src.pr.number !== null ? `#${src.pr.number}` : src.pr.url}${src.pr.state && src.pr.state !== 'open' ? ` ${src.pr.state}` : ''}` : '';
  if (src.ci) return pr ? `from CI · ${pr}` : 'from CI';
  return pr || null;
}

/** Why a verdict doesn't count for a fix, as its heading says it: `Doesn't count for this fix: its check leaves out send_email called 1 time`. Null for one that counts. */
function uncountedHead(st: VerdictStanding): string | null {
  if (st.counts) return null;
  const why = st.why === 'another-check' ? (st.missing?.length ? `its check leaves out ${st.missing.join('; ')}` : 'it was checked under another check') : st.why === 'already-passing' ? 'every run of this fix it checked already passed as recorded' : 'none of the runs it checked fails in this fix';
  return `Doesn't count for this fix: ${why}`;
}

/** The latest settled verdict that counts, given after the fix was applied, when it rejected the change. */
function rejectedSinceApplied(rec: FixRecords): StoredVerdict | null {
  const at = rec.fix.appliedAt;
  if (rec.fix.status !== 'applied' || at === null) return null;
  const last = counting(rec).filter((v) => v.at > at && v.verdict !== 'incomplete').at(-1);
  return last?.verdict === 'rejected' ? last : null;
}

/** Why an applied fix doesn't hold, or null. */
function brokenOf(rec: FixRecords): string | null {
  if (rec.fix.status !== 'applied') return null;
  if (rec.fix.data.applied?.tests === 'failed') return 'shadowlap test failed on its goldens';
  return rejectedSinceApplied(rec) ? 'a verify rejected it after it was applied' : null;
}

/**
 * What the verdicts that held did, run by run, across every accepted verdict that counts: "3 fixed ·
 * 1 kept", a run counted once however many verdicts checked it. Never "4 of 4 held", which counts a
 * good run as held and reads as if every failing run was in one verdict.
 */
function fixedKept(rec: FixRecords): { text: string; kept: number } {
  const fixed = new Set<string>();
  const kept = new Set<string>();
  for (const v of counting(rec)) {
    if (v.verdict !== 'accepted') continue;
    for (const x of v.report.runs) {
      const o = outcomeOf(x);
      if (o === 'fixed') fixed.add(x.runId);
      else if (o === 'kept') kept.add(x.runId);
    }
  }
  return { text: [fixed.size ? `${fixed.size} fixed` : '', kept.size ? `${kept.size} kept` : ''].filter(Boolean).join(' · ') || 'verified', kept: kept.size };
}

/** The fix's failing runs that no accepted verdict that counts has checked as failing runs. */
function notVerified(rec: FixRecords): string[] {
  const checked = new Set(counting(rec).flatMap((v) => (v.verdict === 'accepted' ? v.report.runs.filter((x) => x.role !== 'good').map((x) => x.runId) : [])));
  return rec.failing.filter((id) => !checked.has(id));
}

/**
 * The two calls a blame found the run lost gradually around (`range.gradual`: the check of the call
 * the probes pinned found no drop there), or null when it was lost at one call.
 */
function gradualRange(r: BlameReport): { from: number; to: number } | null {
  const g = r.range;
  return g?.gradual && g.to > g.from ? { from: g.from, to: g.to } : null;
}

/** Where a blame that named call `callNo` found the run lost, as a line about the fix says it: at the call, or gradually around two. */
function lostWords(r: BlameReport, callNo: number): string {
  const g = gradualRange(r);
  return g ? `lost gradually around #${g.from} and #${g.to}` : `lost at model call #${callNo}`;
}

function stepsOf(rec: FixRecords): FixStep[] {
  const b = shownBlame(rec);
  const p = shownRepair(rec);
  const v = acceptedVerdict(rec);
  const rejected = counting(rec).filter((x) => x.verdict === 'rejected');

  let blame: FixStep;
  if (!b) blame = { key: 'blame', n: '01', state: 'todo', short: 'not blamed', title: 'Not blamed yet', meta: 'find the call that lost the run' };
  else {
    const r = b.report;
    const cost = `${r.attempts} attempt${s(r.attempts)} · ${approx(r.spent)}`;
    const g = gradualRange(r);
    if (b.outcome === 'blamed' && r.blamed)
      blame = g
        ? { key: 'blame', n: '01', state: 'done', short: `lost gradually, #${g.from}–#${g.to}`, title: `Lost gradually around model calls #${g.from} and #${g.to}`, meta: `confidence ${r.confidence} · ${cost}` }
        : { key: 'blame', n: '01', state: 'done', short: `lost at #${r.blamed.callNo}`, title: `Lost at model call #${r.blamed.callNo}`, meta: `confidence ${r.confidence} · ${cost}` };
    // Its first probe couldn't tell: not settled, never a finding that no call rescues the run.
    // Not rescued from any model call only where blame's bound bears it out; else from the first, as blame's report heads it.
    else if (b.outcome === 'unrescuable') blame = { key: 'blame', n: '01', state: 'warn', short: unsettledFirst(r) ? 'not settled' : 'not rescued', title: unrescuedHead(r).replace(/^\S+ /, ''), meta: cost };
    else blame = { key: 'blame', n: '01', state: 'warn', short: 'blame stopped', title: 'Stopped before the search finished', meta: r.stopReason ?? cost };
  }

  let repair: FixStep;
  const c = p && acceptedCandidate(p);
  if (p && c) {
    const n = p.report.candidates.length;
    const by = repairerLabel(p);
    repair = { key: 'repair', n: '02', state: 'done', short: changeKind(c), title: commitTitle(c), meta: `candidate ${p.report.candidates.indexOf(c) + 1} of ${n} · ${by ? `proposed by ${by}` : (noRepairerOf(p.report)?.text ?? 'no repairer needed')}${repairCounts(rec, p) ? '' : ' · verified under another check'}` };
  } else if (p) {
    const tried = p.report.candidates.filter((x) => x.state !== 'invalid' && x.state !== 'untried').length;
    // A repairer that proposed nothing is why, more than "there was no candidate to try".
    const none = noRepairerOf(p.report)?.text;
    repair = { key: 'repair', n: '02', state: 'todo', short: 'no fix yet', title: 'No fix yet', meta: p.report.candidates.length ? `${tried} candidate${s(tried)} tried, none accepted${none ? ` · ${none}` : ''}` : (none ?? p.report.why ?? 'the repair found nothing to try') };
  } else repair = { key: 'repair', n: '02', state: 'todo', short: 'no fix yet', title: 'No fix yet', meta: 'repair proposes a prompt fix' };

  let verify: FixStep;
  if (v) {
    const held = fixedKept(rec);
    const left = notVerified(rec).length;
    const earlier = rejected.filter((x) => x.at < v.at).length;
    const later = rejected.filter((x) => x.at > v.at).length;
    const meta = [earlier ? `${earlier} earlier change${s(earlier)} rejected` : left ? `${left} failing run${s(left)} not verified` : held.kept ? 'every failing run fixed, every good run kept' : 'every failing run fixed', ...(later ? [`${later} later change${s(later)} rejected`] : [])].join(' · ');
    verify = { key: 'verify', n: '03', state: 'done', short: held.text, title: held.text, meta };
  } else if (rejected.length) verify = { key: 'verify', n: '03', state: 'no', short: 'rejected', title: 'Rejected', meta: `${rejected.length} change${s(rejected.length)} rejected` };
  else if (counting(rec).length) {
    // A run it took is inconclusive (its gate ran out of attempts, or an attempt could not be judged), or the verify stopped first.
    const unsure = counting(rec).some((x) => x.report.runs.some((run) => outcomeOf(run) === 'inconclusive'));
    verify = { key: 'verify', n: '03', state: 'warn', short: 'not settled', title: 'Not settled', meta: unsure ? 'a run it verified is inconclusive' : 'a verify stopped before every run settled' };
  }
  else if (rec.verdicts.length) {
    const why = rec.standing.get(rec.verdicts.at(-1)!.verifyId)?.why;
    verify = { key: 'verify', n: '03', state: 'todo', short: 'not verified', title: 'Not verified yet', meta: why === 'another-check' ? 'verified only under another check' : why === 'already-passing' ? 'verified only on runs that already passed' : 'no verdict on its runs yet' };
  } else verify = { key: 'verify', n: '03', state: 'todo', short: 'not verified', title: 'Not verified yet', meta: 'checks a fix before it ships' };
  return [blame, repair, verify];
}

/**
 * The title each fix was opened with, by fix id: what its failing run did, as blame titled the fix
 * when it opened it (`blame.done`, `opened`). Read once per answer, and only once a fix was renamed.
 */
function openingTitles(store: Store): () => ReadonlyMap<string, string> {
  let titles: Map<string, string> | null = null;
  return () => {
    if (titles) return titles;
    titles = new Map();
    for (const e of store.listEvents({ kinds: ['blame.done'], limit: 10_000 })) {
      const title = e.data?.title;
      if (e.ref && e.data?.opened === true && typeof title === 'string' && title.trim()) titles.set(e.ref, title);
    }
    return titles;
  };
}

/** What a fix's failing runs did (`FixRow.failed`): its own title until it was given another, else the title it was opened with. */
function failedOf(rec: FixRecords, opening: () => ReadonlyMap<string, string>): string | null {
  const f = rec.fix;
  // Blame made the title from the failure when it opened the fix: it says what failed until someone renames it.
  if (!f.data.titleEdited) return f.title;
  return opening().get(f.fixId) ?? rec.blames.map((b) => b.report.recordedFailures?.[0]).find((x): x is string => typeof x === 'string' && x.trim() !== '') ?? null;
}

function rowOf(store: Store, rec: FixRecords, opening: () => ReadonlyMap<string, string> = openingTitles(store)): FixRow {
  const f = rec.fix;
  const cost = fixCost([rec]);
  const { label, labels } = fixLabelInfo(store, f);
  return {
    fixId: f.fixId,
    href: fixHref(f.fixId),
    status: f.status,
    title: f.title,
    label,
    labels,
    check: f.check.text,
    failed: failedOf(rec, opening),
    failing: rec.failing.length,
    good: rec.good.length,
    steps: stepsOf(rec),
    source: sourceText(f),
    openedAt: f.openedAt,
    verifiedAt: f.verifiedAt,
    appliedAt: f.appliedAt,
    broken: brokenOf(rec),
    attempts: cost.attempts,
    spent: cost.spent,
  };
}

// ---- The list ----------------------------------------------------------------------------------

/** Every fix, the most recently opened first, with the counts for the filter chips. */
export function fixList(store: Store, options: { status?: FixStatus | 'all' } = {}): FixList {
  const opening = openingTitles(store);
  const all = store.listFixes().map((f) => rowOf(store, fixRecords(store, f), opening));
  const open = all.filter((f) => f.status === 'open').length;
  const fixes = !options.status || options.status === 'all' ? all : all.filter((f) => (options.status === 'verified' ? f.status !== 'open' : f.status === options.status));
  return { fixes, counts: { all: all.length, open, verified: all.length - open } };
}

// ---- A fix -------------------------------------------------------------------------------------

function runRef(store: Store, runId: string): FixRunRef {
  const run = store.getRun(runId);
  return { runId, href: runHref(runId), exists: run !== null, status: run?.status ?? null, startedAt: run?.startedAt ?? null, labels: run?.meta?.labels ?? [] };
}

const inScope = (callScope: unknown, scope: string | null) => !scope || (typeof callScope === 'string' && (callScope === scope || callScope.startsWith(`${scope}/`)));

/** A failed attempt's first failure, short: `issue_refund called once`, `the agent exited with code 1`. */
export function shortFailure(f: string | undefined): string {
  if (!f) return 'failed';
  const m = /^(\S+)(?: with .*?)? called (.+?), but called (\d+) times?/.exec(f);
  if (m) {
    const n = Number(m[3]);
    return m[2] === '0 times' ? `${m[1]!} called` : `${m[1]!} called ${n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`}`;
  }
  return f.split(' (')[0]!;
}

/**
 * The pairs a blamed run's attempts made, read from that run and its attempts alone, so a fix's page
 * doesn't read every run in the store. Training owns what a pair is; this only counts them.
 */
function blamePairs(store: Store, runId: string): number | null {
  const run = store.getRun(runId);
  if (!run) return null;
  return findPairs(store, { runs: [run, ...store.childRuns(runId)] }).sources.find((x) => x.key === `blame:${runId}`)?.made ?? 0;
}

/**
 * A blame as the Blame step shows it. `fallback` is the fix's own blame command, which a pulled
 * blame shows when its fields can't be made into one.
 */
function blameStep(store: Store, b: StoredBlame, fallback: string): BlameStep {
  // The gate as it can be read: a malformed one reads as none, the fixed count's words then.
  const r = { ...b.report, gate: sprtGate(b.report.gate) };
  const run = store.getRun(b.runId);
  // An attempt that could not be judged is counted apart (probeTally), never as one that failed.
  const unsure = (x: Parameters<typeof probeTally>[0] | undefined) => x?.attempts.filter((a) => a.verdict === 'inconclusive').length ?? 0;
  const blamedCall = r.blamed?.callNo ?? null;
  let boundary: string;
  let title: string;
  if (b.outcome === 'blamed' && r.blamed) {
    // Two calls when the check of the one the probes pinned found no drop there: lost gradually around them.
    title = r.range?.gradual && r.lost ? `Lost gradually around model calls #${r.blamed.callNo} and #${r.lost.callNo}` : `Lost at model call #${r.blamed.callNo}`;
    const checked = r.pin ? ` ${pinWords(r.pin)}` : '';
    boundary =
      r.gate && r.blamed.decision
        ? `The re-asked call #${r.blamed.callNo}: ${probeFinding(r.blamed, r.gate)}; ${r.lost ? `#${r.lost.callNo}, the next model call: ${probeFinding(r.lost, r.gate)}.` : 'it is the last model call, and the recording, which kept its answer, fails.'}`
        : `Resampling #${r.blamed.callNo} rescued ${probeTally(r.blamed, ' attempts')}; ${r.lost?.undecided ? `#${r.lost.callNo}, the next model call, was inconclusive: ${probeTally(r.lost, ' passed')}.` : r.lost ? `resampling #${r.lost.callNo}, the next model call, rescued ${probeTally(r.lost)}.` : 'it is the last model call, and the recording, which kept its answer, fails.'}`;
    boundary += checked;
  } else if (b.outcome === 'unrescuable') {
    // Its first probe couldn't tell: not a finding that no answer lost it.
    title = unsettledFirst(r) ? 'Not settled from the first model call' : 'Not rescued from any model call';
    boundary = unrescuedWhy(r).evidence ?? 'No probe rescued the run.';
  } else {
    title = 'Stopped before the search finished';
    // The probe past the last rescue lost the run there, or could not tell, which is no loss.
    const after = r.lost ? (probeWord(r.lost) === 'inconclusive' ? `, inconclusive at #${r.lost.callNo}` : `, lost from #${r.lost.callNo}`) : '';
    boundary = `${r.stopReason ? `Stopped: ${r.stopReason}. ` : ''}${r.blamed ? `So far: rescued up to #${r.blamed.callNo}${after}.` : 'No probe had settled.'}`;
  }
  const confidenceWhy =
    r.confidence === 'low'
      ? r.nonMonotone.length
        ? `rescue worked again at ${r.nonMonotone.map((x) => `#${x.rescued} after failing at #${x.lost}`).join(', ')}, so the boundary is not clean`
        : unsettledFirst(r)
          ? `#${r.probes[0]!.callNo} was inconclusive: whether resampling rescues the run is not settled`
          : 'the search did not finish'
      : r.confidence === 'medium' && r.lost
        ? r.lost.decision === 'inconclusive'
          ? `#${r.lost.callNo} was inconclusive: the run was not reliably lost there`
          : `#${r.lost.callNo} still passed ${probeTally(r.lost)}, below the bar: the run was not reliably lost there`
        : 'rescue stops cleanly at the boundary';
  const probeOf = new Map(r.probes.map((x) => [x.callNo, x]));
  const verdictOf = (x: Parameters<typeof probeWord>[0] & { callNo: number }) => (x.callNo === blamedCall ? 'rescued · blamed' : probeWord(x));
  const callRow = run
    ? store.getCalls(b.runId).map((c) => {
        const p = probeOf.get(c.callNo);
        return { callNo: c.callNo, kind: c.kind, inScope: inScope(c.meta.scope, b.scope), verdict: p ? (p.callNo === blamedCall ? ('blamed' as const) : probeWord(p)) : null, passes: p?.passes ?? 0, attempts: p?.attempts.length ?? 0, inconclusive: unsure(p) };
      })
    : [];
  const contrast = r.contrast;
  const rescuedNote = contrast ? `passed · ${askedAgain(contrast.rescued)}` : 'passed';
  return {
    blameId: b.blameId,
    runId: b.runId,
    runExists: run !== null,
    at: b.at,
    outcome: b.outcome,
    title,
    lostAt: blamedCall,
    step: r.blamed?.step ?? null,
    steps: r.steps,
    scope: b.scope,
    confidence: r.confidence,
    confidenceWhy,
    boundary,
    next: r.lost ? { callNo: r.lost.callNo, step: r.lost.step, passes: r.lost.passes, attempts: r.lost.attempts.length } : null,
    rescuedRunId: contrast?.rescuedRunId ?? null,
    answers: contrast ? { callNo: contrast.callNo, recorded: describeBlocks(contrast.recorded), rescued: describeBlocks(contrast.rescued) } : null,
    pairs: blamePairs(store, b.runId),
    rescue: describeRescue(r.rescue?.fields ?? {}),
    needed: r.needed,
    attemptsPerProbe: r.attemptsPerProbe,
    rule: rescueRule(r),
    probes: r.probes.map((x) => ({ callNo: x.callNo, step: x.step, passes: x.passes, attempts: x.attempts.length, inconclusive: unsure(x), verdict: verdictOf(x), bound: probeBound(x, r.gate), blamed: x.callNo === blamedCall, href: runHref(b.runId, x.callNo), gate: gateEvidence(x) })),
    bundles: r.probes.map((x) => ({
      callNo: x.callNo,
      title: `blame · probe #${x.callNo}`,
      blamed: x.callNo === blamedCall,
      passes: x.passes,
      attempts: x.attempts.map((a) => ({ runId: a.runId, passed: a.passed, verdict: attemptVerdictOf(a), note: a.passed ? (a.runId === contrast?.rescuedRunId ? rescuedNote : 'passed') : attemptNote(false, a.failures[0], undefined, attemptVerdictOf(a)), spent: a.spent, href: runHref(a.runId) })),
    })),
    callRow,
    cost: { attempts: r.attempts, upstreamRequests: r.upstreamRequests, spent: r.spent, unknownModels: r.unknownModels },
    oracle: r.oracle,
    recordedFailures: r.recordedFailures,
    stopReason: r.stopReason,
    look: noAnswerLost(b) || unsettledFirst(r) ? unrescuedWhy(r).look : null,
    warnings: r.warnings,
    // A teammate's command line is never offered to copy: the same blame, made here from its checked fields.
    command: b.pulled ? sameBlame(b, fallback) : b.command,
    pulled: b.pulled ?? null,
    hrefs: { run: runHref(b.runId), lostAt: blamedCall ? runHref(b.runId, blamedCall) : null, rescued: contrast ? runHref(contrast.rescuedRunId) : null },
    evidence: blameEvidence(b.report),
  };
}

/** Where `after` differs from `before`: the text added, and where, and the text it replaced. */
function addedText(before: string, after: string): { added: { at: number; text: string } | null; removed: string } {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let e = 0;
  while (e < before.length - p && e < after.length - p && before[before.length - 1 - e] === after[after.length - 1 - e]) e++;
  const text = after.slice(p, after.length - e);
  return { added: text ? { at: p, text } : null, removed: before.slice(p, before.length - e) };
}

function candidateVerdict(c: RepairCandidate, r: StoredRepair): { verdict: CandidateVerdict; why: string } {
  switch (c.state) {
    case 'accepted':
      return { verdict: 'accepted', why: 'the smallest rewrite the gate accepts' };
    case 'invalid':
      return { verdict: 'set aside', why: c.reason ?? 'it could not be applied, so it never ran' };
    case 'rejected':
      return { verdict: 'rejected', why: c.reason ?? 'the gate rejected it' };
    case 'build-failed':
      return { verdict: 'build failed', why: c.reason ?? 'the build failed' };
    case 'incomplete':
      return { verdict: 'unsettled', why: c.reason ?? 'its verification did not finish' };
    default:
      return { verdict: 'not tried', why: r.accepted ? 'a smaller candidate was accepted first' : r.outcome === 'stopped' ? `the repair stopped first${r.report.why ? `: ${r.report.why}` : ''}` : 'not tried' };
  }
}

/** `1 file · +1 −1` for a patch. */
function patchNote(patch: string | null): string {
  if (!patch) return 'no patch';
  const lines = patch.split('\n');
  const files = patchFiles(patch).length;
  const plus = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const minus = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return `${files} file${s(files)} · +${plus} −${minus}`;
}

/**
 * Every attempt a repair ran, as its receipt counts them: the verification of every candidate it
 * tried (the ones it dropped and the one it accepted), and the probes of the blames it ran. A blame
 * it reused, kept from before, ran nothing; one it ran is kept like any other blame, the latest of
 * its run by the time the repair was kept.
 */
function repairAttempts(store: Store, r: StoredRepair): number {
  const verify = r.report.candidates.reduce((n, c) => n + (c.verify?.attempts ?? 0), 0);
  const blame = r.report.targets.reduce((n, t) => {
    // A run that passed, or that blame couldn't run on, left no blame to count.
    if (t.reused || (t.outcome !== 'blamed' && t.outcome !== 'unrescuable' && t.outcome !== 'stopped')) return n;
    const kept = store.blamesOfRun(t.runId).filter((b) => b.at <= r.at).at(-1);
    return n + (kept?.report.attempts ?? 0);
  }, 0);
  return verify + blame;
}

/**
 * A repair as the Repair step shows it. A teammate's (`pulled`) shows `fallback`, the fix's own
 * repair command, in place of the command line it ran on their machine, which is never offered to
 * copy.
 */
function repairStep(store: Store, rec: FixRecords, r: StoredRepair, fixId: string, pulled: boolean, fallback: string): RepairStep {
  const rep = r.report;
  const c = acceptedCandidate(r);
  const v = c?.verify ?? null;
  const verdict = rec.verdicts.find((x) => x.repairId === r.repairId) ?? null;
  const roles: RepairStep['roles'] = [];
  if (v) {
    for (const role of ['target', 'holdout', 'good'] as const) {
      const of = v.runs.filter((x) => x.role === role);
      if (of.length) roles.push({ role: ROLE[role], held: of.filter((x) => x.verdict === 'pass').length, of: of.length });
    }
  }
  const dir = r.dir.replace(/\/+$/, '');
  const goldens = rep.output.goldens.length;
  const none = noRepairerOf(rep);
  // A report kept before it said why no repairer proposed anything only says there was nothing to try: that is why.
  const why = none && !rep.candidates.length && rep.why === 'there was no candidate to try' ? none.text : rep.why;
  return {
    repairId: r.repairId,
    at: r.at,
    dir,
    outcome: r.outcome,
    accepted: r.accepted,
    title: c ? commitTitle(c) : 'No fix yet',
    why: c ? null : why,
    repairer: repairerLabel(r),
    noRepairer: none,
    served: rep.repairer?.served && rep.repairer.served !== rep.repairer.model ? rep.repairer.served : null,
    verify: v ? { verifyId: verdict?.verifyId ?? null, attempts: v.attempts, spent: v.spent, counts: verdict ? verdictCounts(rec, verdict) : false } : null,
    change: c ? { file: c.file, anchor: c.surface, before: c.before, after: c.after, ...addedText(c.before, c.after) } : null,
    roles,
    needed: v?.needed ?? null,
    attemptsPerRun: v?.attemptsPerRun ?? null,
    rule: v ? eachRun({ ...v, gate: sprtGate(v.gate) }) : null,
    lost: rep.targets.map((t) => ({
      runId: t.runId,
      at: t.outcome === 'blamed' && t.callNo !== null ? `model call #${t.callNo} (${t.step!} of ${t.steps})${t.rescuedBy ? `, rescued by ${t.rescuedBy}` : ''}` : t.outcome === 'unrescuable' ? unrescuedWords(t.unsettled === true) : (t.note ?? t.outcome),
      href: fixHref(fixId, 'blame'),
    })),
    diagnosis: rep.diagnosis,
    candidates: rep.candidates.map((x) => ({ id: x.id, text: x.after, surface: x.surface, file: x.file, source: x.source, ...candidateVerdict(x, r) })),
    files: [
      ...(rep.patch ? [{ name: 'fix.patch', note: patchNote(rep.patch) }] : []),
      { name: 'report.md', note: 'the pull request body' },
      { name: 'report.json', note: 'for agents and CI' },
      // A teammate's repair: its recordings stayed on the machine that ran it, and are committed from there.
      ...(goldens ? [{ name: 'goldens/', note: pulled ? `${goldens} recording${s(goldens)} made by the fixed code, kept where it ran` : `${goldens} recording${s(goldens)} made by the fixed code` }] : []),
    ],
    prBody: repairMarkdown(rep),
    command: pulled ? fallback : r.command,
    cost: rep.cost,
    attempts: repairAttempts(store, r),
    output: { patch: rep.output.patch, applied: rep.output.applied, branch: rep.output.branch, pr: rep.output.pr, goldens: rep.output.goldens },
    warnings: rep.warnings,
    pulled,
  };
}

/** A change in percent, as verify prints it: +20%, −5.0%, ±0%. */
function pct(before: number, after: number): string {
  if (before === 0) return after === 0 ? '±0%' : 'new';
  const d = ((after - before) / before) * 100;
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d) < 10 ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d))}%`;
}

/**
 * A verdict's heading, by the runs it checked. An accepted one that counts reads "Every failing run
 * fixed, every good run kept" only when it checked every failing run of the fix; else it says what
 * it did, role by role, as repair's Verified line does: "Fixes 1 of 1 target run, 1 of 1 held-out,
 * keeps 1 of 1 good". One that doesn't count for the fix says why instead (`uncountedHead`).
 */
function headline(rec: FixRecords, v: StoredVerdict, standing: VerdictStanding): string {
  const uncounted = uncountedHead(standing);
  if (uncounted) return uncounted;
  const runs = v.report.runs;
  if (v.verdict === 'accepted') {
    const checked = new Set(runs.filter((x) => x.role !== 'good').map((x) => x.runId));
    const good = runs.some((x) => x.role === 'good');
    if (rec.failing.length && rec.failing.every((id) => checked.has(id))) return good ? 'Every failing run fixed, every good run kept' : 'Every failing run fixed';
    const tally = (role: VerifiedRun['role']) => {
      const of = runs.filter((x) => x.role === role);
      return { n: of.length, text: `${of.filter((x) => x.verdict === 'pass').length} of ${of.length}` };
    };
    const [t, h, g] = [tally('target'), tally('holdout'), tally('good')];
    const parts = [t.n ? `fixes ${t.text} target run${s(t.n)}` : '', h.n ? `${t.n ? '' : 'fixes '}${h.text} held-out` : '', g.n ? `keeps ${g.text} good` : ''].filter(Boolean);
    const said = parts.join(', ');
    return said ? `${said.charAt(0).toUpperCase()}${said.slice(1)}` : 'No runs checked';
  }
  if (v.verdict === 'rejected') return runs.some((x) => x.role === 'good' && x.verdict === 'fail') ? 'The change broke a run that worked' : 'The change did not fix the failing runs it checked';
  return 'Not every run settled';
}

/**
 * The models `--from` named, for the words of a verdict's change: the fields it set changed only
 * their calls. From its kept flags; for a verdict kept before them, from the command line it
 * printed, read only for these words, never to run.
 */
function fromModels(v: Pick<StoredVerdict, 'command' | 'rerun'>): string[] {
  let words: string[];
  if (v.rerun) words = v.rerun.flags;
  else {
    try {
      words = splitCommandLine(v.command);
    } catch {
      return [];
    }
  }
  return words.flatMap((w, i) => (w === '--from' && words[i + 1] ? [words[i + 1]!] : []));
}

/**
 * What a verdict verified, named by what changed: a repair's candidate (`repair candidate 3`); the
 * request fields it set (`--set`, `--model`) from each run's first model call, at the code it ran
 * (`temperature=1 from each run's first model call · at 35034be`; with `--from`, from each run's
 * first call of those models); else the code itself, by its version (`working tree` outside git).
 * Two changes verified at one commit never read alike.
 */
function changeName(v: Pick<StoredVerdict, 'candidate' | 'command' | 'rerun' | 'report'>): string {
  if (v.candidate !== null) return `repair candidate ${v.candidate}`;
  const fields = fieldsSet(v);
  if (!fields) return v.report.codeVersion ?? 'working tree';
  return `${fields}${v.report.codeVersion ? ` · at ${v.report.codeVersion}` : ''}`;
}

/** The request fields a verdict's change set, as `temperature=1`; null for a change all in the code. */
function fieldsOf(v: Pick<StoredVerdict, 'report'>): string | null {
  const fields = Object.entries(v.report.fields ?? {});
  return fields.length ? fields.map(([k, x]) => `${k}=${typeof x === 'string' ? x : JSON.stringify(x)}`).join(', ') : null;
}

/** The request fields a verdict's change set, and from where: `temperature=1 from each run's first model call`; null for a change all in the code. */
function fieldsSet(v: Pick<StoredVerdict, 'command' | 'rerun' | 'report'>): string | null {
  const set = fieldsOf(v);
  if (!set) return null;
  const from = fromModels(v);
  return `${set} from each run's first ${from.length ? `${from.join(' or ')} call` : 'model call'}`;
}

/** The verdict that verified a fix with no repair behind it: a change of request fields, or one in the working tree. */
function unrepairedVerdict(rec: FixRecords): StoredVerdict | null {
  const v = acceptedVerdict(rec);
  return v && v.candidate === null ? v : null;
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
 * A verdict as the Verify step shows it. `fallback` is the fix's own verify command, which a pulled
 * verdict shows when its fields can't be made into one.
 */
function verifyStep(rec: FixRecords, v: StoredVerdict, fallback: string): VerifyStep {
  const r = v.report;
  const fixId = rec.fix.fixId;
  const standing = rec.standing.get(v.verifyId) ?? { counts: true, why: null };
  const appliedAt = rec.fix.appliedAt;
  const regressed = standing.counts && v.verdict === 'rejected' && rec.fix.status === 'applied' && appliedAt !== null && v.at > appliedAt;
  const code = changeName(v);
  const rows: VerifyRow[] = r.runs.map((x) => {
    const failure = x.verdict === 'fail' ? x.attempts.find((a) => !a.passed)?.failures[0] : undefined;
    const forks = [...new Set(x.attempts.map((a) => a.forkedAt).filter((f): f is number => f !== null))];
    const n = x.attempts.length;
    const mean = (pick: (a: (typeof x.attempts)[number]) => number | null) => {
      if (!n) return null;
      let sum = 0;
      for (const a of x.attempts) {
        const value = pick(a);
        if (value === null) return null;
        sum += value;
      }
      return sum / n;
    };
    const now = mean((a) => a.footprint.inputTokens);
    // A run an attempt it could not judge stopped was decided by no gate: no rate, as verify's JSON has none.
    const rate = x.undecided ? null : rateOf(x.gate);
    return {
      role: ROLE[x.role],
      runId: x.runId,
      href: runHref(x.runId),
      attempts: n,
      passes: x.passes,
      inconclusive: x.attempts.filter((a) => attemptVerdictOf(a) === 'inconclusive').length,
      deterministic: x.deterministic,
      outcome: outcomeOf(x),
      rate,
      note: failure ? shortFailure(failure) : x.undecided ? 'an attempt could not be judged' : !n ? 'not started' : x.deterministic ? 'clean replay' : forks.length ? `forked at ${forks.map((f) => `#${f}`).join(', ')}` : '',
      tokens: now === null ? null : { recorded: x.recorded.footprint.inputTokens, now },
      cost: n ? { recorded: x.recorded.footprint.cost, now: mean((a) => a.footprint.cost) } : null,
      evidence: verifyEvidence(x),
    };
  });
  const d = footprintDelta(r.runs);
  return {
    verifyId: v.verifyId,
    href: fixHref(fixId, 'verify', v.verifyId),
    at: v.at,
    verdict: v.verdict,
    counts: standing.counts,
    // One that doesn't count says why in its heading.
    note: regressed ? 'Rejected after the fix was applied: it no longer holds.' : null,
    code,
    label: `${code} · ${v.verdict}${standing.counts ? '' : " · doesn't count"}`,
    headline: headline(rec, v, standing),
    oracle: sprtGate(r.gate) ? `a run's attempts must meet the check: ${r.oracle.join('; ')}; its gate decides after each one: ${describeGate(sprtGate(r.gate)!)}` : `a run passes when ${r.needed} of ${r.attemptsPerRun} attempts meet the check: ${r.oracle.join('; ')}`,
    needed: r.needed,
    attemptsPerRun: r.attemptsPerRun,
    rows,
    tokens: d ? { before: d.recorded.inputTokens, after: d.now.inputTokens, change: pct(d.recorded.inputTokens, d.now.inputTokens) } : null,
    cost: d && d.recorded.cost !== null && d.now.cost !== null ? { before: d.recorded.cost, after: d.now.cost, change: pct(d.recorded.cost, d.now.cost) } : null,
    attempts: r.attempts,
    upstreamRequests: r.upstreamRequests,
    spent: r.spent,
    unknownModels: r.unknownModels,
    reasons: r.reasons,
    unsettled: r.reasons.filter(unsettledReason),
    warnings: [...r.warnings, ...(r.replayWarnings ?? [])],
    // A teammate's command line is never offered to copy: the same verify, made here from its checked fields.
    command: v.pulled ? sameVerify(v, fallback) : v.command,
    pulled: v.pulled ?? null,
    repairId: v.repairId,
    candidate: v.candidate,
    more: standing.counts ? verifyMore(v) : null,
  };
}

/**
 * A kept blame as `shadowlap blame` arguments that blame its run the same way again, from its
 * checked fields: the run, `expect` (the fix's check now, or the blame's own), its scope and
 * rescue, the gate or count after it (`decide`), and its flags (rerun.ts) but `--budget`. Null when
 * any of them isn't of its shape, or it kept no flags: then it is not run again from here.
 */
function blameArgs(b: StoredBlame, expect: unknown, decide: string[] | null): { argv: string[]; rerun: RerunFlags } | null {
  const rerun = rerunFlags('blame', b.rerun, { pulled: !!b.pulled, drop: new Set(['--budget']) });
  const check = expectArgs(expect);
  const scope = scopeArg(b.scope);
  const fields = fieldArgs(b.report.rescue?.fields);
  if (!rerun || !check || !scope || !fields || !decide || !runIds([b.runId])) return null;
  return { argv: ['blame', b.runId, ...check, ...scope, ...fields, ...decide, ...rerun.flags, ...(rerun.command ? ['--', ...rerun.command] : [])], rerun };
}

/** A blame's fixed count as the CLI takes it, or null when it isn't one. */
function blameCount(r: BlameReport): string[] | null {
  return isCount(r.attemptsPerProbe, 100) && r.attemptsPerProbe > 0 && isCount(r.needed, r.attemptsPerProbe) ? ['--attempts', String(r.attemptsPerProbe), '--passes', String(r.needed)] : null;
}

/**
 * Blame again, or Blame with a stronger model, for an open fix whose shown blame placed its failure
 * on no call (`FixActions`): built from that blame's checked fields (`blameArgs`), under the fix's
 * check now, with the run named in full and without its budget. Neither for a fix whose run is gone,
 * one whose command came from a capture, which has none to run again, or a blame kept before its
 * flags were.
 */
function blameNext(store: Store, rec: FixRecords, b: StoredBlame | null): Pick<FixActions, 'blameAgain' | 'blameStronger'> {
  const none = { blameAgain: null, blameStronger: null };
  if (rec.fix.status !== 'open' || !b || b.outcome === 'blamed') return none;
  const run = store.getRun(b.runId);
  if (!run || !hasRecordedCommand(run)) return none;
  const unsettled = unsettledFirst(b.report);
  const stopped = b.outcome === 'stopped';
  const g = sprtGate(b.report.gate);
  const pulled = b.pulled ?? null;
  if (stopped || unsettled) {
    // Not settled: more attempts and a lower bar, as blame's report words it; stopped: the same gate, to the end.
    const lower = g ? Math.max(0.05, +(g.good - 0.2).toFixed(2)) : null;
    const gate: SprtGate | null = g && unsettled ? { ...g, good: lower !== null && lower > g.bad ? lower : g.good, max: Math.min(GATE_MAX_ATTEMPTS, g.max * 2) } : g;
    const made = blameArgs(b, rec.fix.check.expect, gate ? gateArg(gate, BLAME_DEFAULTS) : blameCount(b.report));
    if (!made) return none;
    return { blameAgain: { kind: stopped ? 'stopped' : 'unsettled', argv: made.argv, command: commandLine(made.argv), gate: unsettled ? gate : null, pulled, left: made.rerun.left }, blameStronger: null };
  }
  // A stronger model can't help when blame found the model's answer isn't what lost the run, nor one asked already.
  if (noAnswerLost(b) || b.report.rescue.fields.model !== undefined) return none;
  const made = blameArgs(b, rec.fix.check.expect, g ? gateArg(g, BLAME_DEFAULTS) : blameCount(b.report));
  if (!made) return none;
  return { blameAgain: null, blameStronger: { argv: made.argv, command: `${commandLine(made.argv)} --model <model>`, attempts: b.report.attempts, spent: b.report.spent, pulled, left: made.rerun.left } };
}

const VERIFY_ROLE_FLAG: Readonly<Record<VerifiedRun['role'], string>> = { target: '--fixes', holdout: '--holdout', good: '--keeps' };

/** `--gate` with the figures that differ from `defaults`, as the CLI writes it; nothing when none do. */
function gateArg(gate: SprtGate, defaults: Omit<SprtGate, 'kind'>): string[] {
  const differs = (['good', 'bad', 'risk', 'max'] as const).filter((k) => gate[k] !== defaults[k]);
  return differs.length ? ['--gate', JSON.stringify(Object.fromEntries(differs.map((k) => [k, gate[k]])))] : [];
}

/**
 * A kept verdict as `shadowlap verify` arguments, from its checked fields: its runs named by id in
 * their roles, its check, the request fields it set, its gate (`gate` in its place, when given) or
 * fixed count, and its flags (rerun.ts) but `drop`. Null when any of them isn't of its shape, or it
 * kept no flags.
 */
function verdictArgs(v: StoredVerdict, o: { gate?: SprtGate | null; drop?: ReadonlySet<string> } = {}): { argv: string[]; rerun: RerunFlags } | null {
  const r = v.report;
  const rerun = rerunFlags('verify', v.rerun, { pulled: !!v.pulled, ...(o.drop ? { drop: o.drop } : {}) });
  const check = expectArgs(v.expect);
  const fields = fieldArgs(r.fields);
  if (!rerun || !check || !fields || !runIds(r.runs.map((x) => x.runId))) return null;
  const roles = (['target', 'holdout', 'good'] as const).flatMap((role) => {
    const ids = r.runs.filter((x) => x.role === role).map((x) => x.runId);
    return ids.length ? [VERIFY_ROLE_FLAG[role], ...ids] : [];
  });
  const gate = o.gate !== undefined ? o.gate : sprtGate(r.gate);
  const decide = gate ? gateArg(gate, SPRT_DEFAULTS) : isCount(r.attemptsPerRun, 100) && r.attemptsPerRun > 0 && isCount(r.needed, r.attemptsPerRun) ? ['--attempts', String(r.attemptsPerRun), '--passes', String(r.needed)] : null;
  if (!decide) return null;
  return { argv: ['verify', ...roles, ...check, ...fields, ...decide, ...rerun.flags, ...(rerun.command ? ['--', ...rerun.command] : [])], rerun };
}

/** A pulled verdict's verify as this machine would run it again, from its checked fields; `fallback` when they make none. */
function sameVerify(v: StoredVerdict, fallback: string): string {
  const made = verdictArgs(v);
  return made ? commandLine(made.argv) : fallback;
}

/** A pulled blame as this machine would run it again under its own check, from its checked fields; `fallback` when they make none. */
function sameBlame(b: StoredBlame, fallback: string): string {
  const g = sprtGate(b.report.gate);
  const made = blameArgs(b, b.expect, g ? gateArg(g, BLAME_DEFAULTS) : blameCount(b.report));
  return made ? commandLine(made.argv) : fallback;
}

/**
 * Run more attempts, or Verify again, for an incomplete verdict (`VerifyMore`), from its checked
 * fields (`verdictArgs`): its runs named in their roles, its change and check as they were, and the
 * gate's limit doubled when a run's gate ran out of attempts. Null for a verdict that isn't
 * incomplete, a repair's candidate, a fixed count with nothing stopped, or one whose fields can't
 * be checked (kept before its flags were, or with one of another shape).
 */
function verifyMore(v: StoredVerdict): VerifyMore | null {
  const r = v.report;
  if (v.verdict !== 'incomplete' || v.candidate !== null || v.repairId !== null) return null;
  const open = r.runs.filter((x) => x.verdict === 'open');
  if (!open.length) return null;
  const gate = sprtGate(r.gate);
  const ranOut = open.filter((x) => x.decision === 'inconclusive' && !x.undecided);
  const stopped = open.filter((x) => x.decision !== 'inconclusive' && !x.undecided);
  const unjudged = open.filter((x) => !!x.undecided);
  const kind: VerifyMore['kind'] = ranOut.length || stopped.length ? 'more' : 'again';
  // A fixed count that ran out decides nothing more with more of the same.
  if (kind === 'more' && !gate && !stopped.length) return null;
  const max = gate ? (ranOut.length ? Math.min(GATE_MAX_ATTEMPTS, gate.max * 2) : gate.max) : r.attemptsPerRun;
  if (kind === 'more' && gate && ranOut.length && max <= gate.max) return null;
  const raised: SprtGate | null = gate ? { ...gate, max } : null;
  // Run more attempts leaves out the budget that stopped it; Verify again runs as it ran.
  const made = verdictArgs(v, { gate: raised, ...(kind === 'more' ? { drop: new Set(['--budget']) } : {}) });
  if (!made) return null;
  // What it would take, each run from the start at the rate it passed at so far: a clean replay settles in one.
  let expected = 0;
  for (const x of r.runs) {
    if (x.deterministic) expected += 1;
    else if (raised) expected += gateOdds(raised, x.attempts.length ? x.passes / x.attempts.length : 0.5).attempts;
    else expected += r.attemptsPerRun;
  }
  expected = Math.round(expected);
  const spent = r.spent + (r.judge?.spent ?? 0);
  const perAttempt = spent > 0 && r.attempts > 0 ? spent / r.attempts : null;
  const first = ranOut[0] ?? stopped[0] ?? unjudged[0]!;
  const state = first.undecided ? 'unjudged' : first.decision === 'inconclusive' ? 'inconclusive' : 'stopped';
  return {
    kind,
    run: { runId: first.runId, state, why: state === 'unjudged' ? (first.undecided ?? null) : state === 'stopped' ? r.stopReason : null, attempt: state === 'unjudged' ? first.attempts.length : null },
    max,
    expected,
    cost: perAttempt === null ? null : perAttempt * expected,
    budget: kind === 'more' ? (made.rerun.dropped['--budget'] ?? null) : null,
    argv: made.argv,
    command: commandLine(made.argv),
    pulled: v.pulled ?? null,
    left: made.rerun.left,
  };
}

/**
 * Whether `label:<label>` selects exactly the fix's failing runs that are left: none of another
 * fix's (a customer's label, say), no run in no fix (a run that passed, labelled with the failure
 * it was recorded for), and every one of the fix's. Anything else would be repaired as failing.
 */
function labelSelectsFix(store: Store, label: string, left: readonly string[]): boolean {
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
function agentOfRun(store: Store, run: RunRecord): string | null {
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
function keepArgs(store: Store, rec: FixRecords, left: readonly string[]): string[] {
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
function fixRunArgs(store: Store, rec: FixRecords): { fixes: string[]; keeps: string[]; expect: string[] } | null {
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
export function repairArgv(store: Store, rec: FixRecords): string[] {
  const runs = fixRunArgs(store, rec);
  // A blame's scope (a pulled one's too) goes as `--scope` only when it is a name, never a flag.
  const scope = scopeArg(shownBlame(rec)?.scope);
  if (!runs || !scope) return [];
  return ['repair', '--fixes', ...runs.fixes, ...(runs.keeps.length ? ['--keeps', ...runs.keeps] : []), ...scope, ...runs.expect];
}

/**
 * Why a repair from here would end "No fix to try" without running the agent, in a sentence, or
 * null when it would run it. A repair reuses the blame kept on a failing run when it searched under
 * the same check, rescue and scope, rather than search again (as `shadowlap repair` does): when that
 * blame of every failing run left rescued it from no call, there is no passing path to learn from.
 * Said as the CLI says why: no answer of the model's lost the runs, blame couldn't settle where they
 * were lost, or nothing rescued them.
 */
function noFixToTry(store: Store, rec: FixRecords, scope: string | null): string | null {
  const runs = rec.failing.map((id) => store.getRun(id)).filter((r): r is RunRecord => r !== null);
  if (!runs.length) return null;
  const oracle = JSON.stringify(rec.fix.check.oracle);
  const kept: StoredBlame[] = [];
  for (const run of runs) {
    const stored = run.meta?.blame;
    const last = store.blamesOfRun(run.runId).at(-1);
    if (!stored || !last || stored.outcome !== 'unrescuable') return null;
    if (JSON.stringify(stored.oracle) !== oracle || Object.keys(stored.fields ?? {}).length || (stored.scope ?? null) !== scope) return null;
    kept.push(last);
  }
  const one = runs.length === 1;
  if (kept.every(noAnswerLost)) return `Blame found that no answer of the model's lost ${one ? 'this run' : 'these runs'}, so a rewrite of the prompt can't fix ${one ? 'it' : 'them'}: the repair ends “No fix to try”. Look at the tools, the harness or the command.`;
  if (kept.every((b, i) => runs[i]!.meta?.blame?.unsettled === true || (b.outcome === 'unrescuable' && unsettledFirst(b.report)))) return `Blame couldn't settle where ${one ? 'the run was' : 'the runs were'} lost, so a rewrite of the prompt has nothing to aim at yet: the repair ends “No fix to try”. Settle the blame first.`;
  return 'No failing run was rescued, so there is no passing path to learn from: the repair ends “No fix to try”.';
}

/** `shadowlap verify` of a change for a fix, as its empty Verify step shows it: the runs and the check a repair from it would take. Empty as `repairArgv` is. */
function verifyArgv(store: Store, rec: FixRecords): string[] {
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
 * Whether a fix's patch is in the project's working tree already, as the caller asks git
 * (`patchInTree`, patch-in-tree.ts); null when it can't say.
 */
export type PatchCheck = (patch: string) => boolean | null;

/**
 * A verified fix whose repair's patch is in the working tree already, as `check` asks git: merged by
 * a pull request, or applied by hand. Nothing is left to apply; `fix apply` only marks it applied.
 * A patch `fix apply` refuses is never asked about.
 */
function patchMerged(rec: FixRecords, check: PatchCheck | undefined): boolean {
  if (!check) return false;
  const patch = patchToCheck(rec);
  return patch !== null && check(patch) === true;
}

/** The patch `patchMerged` asks about for a fix: a verified fix's, which `fix apply` would apply; null for any other. */
function patchToCheck(rec: FixRecords): string | null {
  if (rec.fix.status !== 'verified') return null;
  const r = repairToApply(rec);
  return r?.report.patch && !repairPatchProblem(r.report) ? r.report.patch : null;
}

/**
 * The patches a read model asks its `PatchCheck` about, for these fixes (every fix unless given):
 * git answers asynchronously and a read model works synchronously, so a route asks git about them
 * first (`patchesInTree`, patch-in-tree.ts) and hands the read model the answers.
 */
export function patchesToCheck(store: Store, fixes: readonly StoredFix[] = store.listFixes()): string[] {
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
export function fixDetail(store: Store, idOrPrefix: string, options: { repairer?: string | null; checkRepairer?: (repairer: string, configured: boolean) => string | null; patchInTree?: PatchCheck } = {}): FixDetail | null {
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

// ---- For the other views ------------------------------------------------------------------------

export interface FixesSummary {
  /** Fixes still open, and verified fixes not applied yet. */
  open: number;
  readyToApply: number;
  /** Applied fixes that don't hold: their test failed, or a verify rejected them after they were applied. */
  broken: number;
  /**
   * How far failures got: every failure (fixes, and failed runs never blamed), those blamed to a
   * finished verdict, those with a verified fix (applied ones too), and those applied.
   */
  funnel: { failures: number; blamed: number; verified: number; applied: number };
  /** The attempts behind every fix, and what they and the repairers cost, in USD. */
  attempts: number;
  upstreamRequests: number;
  spent: number;
  /**
   * Failures blame reproduced (it replays a run exactly before it probes), by the time of each fix's
   * first blame: a failure is a fix, however many of its runs were blamed, as the funnel counts it.
   */
  reproduced: { thisWeek: number; lastWeek: number; total: number };
  /** Accepted verdicts that count for a fix. */
  verified: { thisWeek: number; lastWeek: number; total: number };
  /** Rejected verdicts that count for a fix, given before it was applied: changes rejected before they shipped. */
  rejected: { thisWeek: number; lastWeek: number; total: number };
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** A week as the Overview counts it: from its first instant, up to (not including) `to`. */
export interface WeekWindows {
  week: { from: number; to: number };
  lastWeek: { from: number; to: number };
}

/**
 * What fixes came to, for the Overview: this week is the 7 days up to `now`, last week the 7
 * before, unless `windows` names them. The Overview passes its own, the viewer's days, so a blame
 * counts in the same week as the runs beside it.
 */
export function fixesSummary(store: Store, now: number = Date.now(), windows?: WeekWindows, options: { patchInTree?: PatchCheck } = {}): FixesSummary {
  const fixes = store.listFixes();
  const records = fixes.map((f) => fixRecords(store, f));
  const cost = fixCost(records);
  const w = windows ?? { week: { from: now - WEEK + 1, to: now + 1 }, lastWeek: { from: now - 2 * WEEK + 1, to: now - WEEK + 1 } };
  const week = (at: number) => (at >= w.week.from && at < w.week.to ? 'this' : at >= w.lastWeek.from && at < w.lastWeek.to ? 'last' : null);
  const tally = (ats: number[]) => ({ thisWeek: ats.filter((a) => week(a) === 'this').length, lastWeek: ats.filter((a) => week(a) === 'last').length, total: ats.length });

  // A failure is a fix, as the funnel and Fixes count it: blaming three of its runs reproduced one failure.
  const firstBlames = records.flatMap((r) => (r.blames[0] ? [r.blames[0].at] : []));
  // A verdict shared by several fixes is one verdict.
  const accepted = new Map<string, number>();
  const rejected = new Map<string, number>();
  for (const rec of records) {
    for (const v of counting(rec)) {
      if (v.verdict === 'accepted') accepted.set(v.verifyId, v.at);
      else if (v.verdict === 'rejected' && (rec.fix.appliedAt === null || v.at < rec.fix.appliedAt)) rejected.set(v.verifyId, v.at);
    }
  }

  const blamed = records.filter((r) => r.blames.some((b) => b.outcome !== 'stopped')).length;
  return {
    open: fixes.filter((f) => f.status === 'open').length,
    // A patch already in the working tree is no more to apply.
    readyToApply: records.filter((r) => r.fix.status === 'verified' && !patchMerged(r, options.patchInTree)).length,
    broken: records.filter((r) => brokenOf(r) !== null).length,
    funnel: { failures: fixes.length + unblamedFailures(store).length, blamed, verified: fixes.filter((f) => f.status !== 'open').length, applied: fixes.filter((f) => f.status === 'applied').length },
    attempts: cost.attempts,
    upstreamRequests: cost.upstreamRequests,
    spent: cost.spent,
    reproduced: tally(firstBlames),
    verified: tally([...accepted.values()]),
    rejected: tally([...rejected.values()]),
  };
}

/**
 * A failed run that is not a fix yet, with no blame kept and in no fix: a recording whose agent
 * exited with an error, or a fork that failed as the run list judges it (its own check, or its
 * agent's exit), which Run blame takes as it takes a recording. Attempts are not: a blame probe's,
 * a verify's, a `--repeat`'s or a preset's failure counts towards what made them, a test's is
 * Tests', and an injection test's replay is judged by that test. A blame from before Fixes kept
 * blames (only `meta.blame` on the run) does not count: blaming it again opens its fix.
 */
function isUnblamedFailure(store: Store, run: RunRecord, index: RunIndex = loadRunIndex(store)): boolean {
  if (run.mode === 'record' ? run.status !== 'failed' : !failedFork(index, run)) return false;
  return store.blamesOfRun(run.runId).length === 0 && store.linksTo(run.runId, 'failing').length === 0;
}

/** A fork the run list counts as failed that stands on its own: no attempt of anything, no test's, and not the fork blame rescued a run with. */
function failedFork(index: RunIndex, run: RunRecord): boolean {
  const r = index.byId.get(run.runId);
  if (!r || r.kind !== 'fork' || !r.failed || r.rescues) return false;
  const m = r.meta;
  return !r.attemptOf && !m.probe && !m.verify && !m.repeat && !m.test && !m.chaos && !run.meta?.injection;
}

function unblamedFailures(store: Store): RunRecord[] {
  const index = loadRunIndex(store);
  return store.allRuns().filter((r) => isUnblamedFailure(store, r, index));
}

/**
 * The check a blame of a run never blamed can use: the check of a fix its labels point to, one that
 * holds every label of the run first, then one not yet applied, then the latest opened.
 */
function checkSuggestion(run: RunRecord, fixes: Array<{ fix: StoredFix; labels: string[] }>): { expect: unknown } | null {
  const labels = fixLabels(run);
  if (!labels.length) return null;
  const scored = fixes
    .map((x) => ({ ...x, shared: labels.filter((l) => x.labels.includes(l)).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || Number(a.fix.status === 'applied') - Number(b.fix.status === 'applied') || b.fix.openedAt - a.fix.openedAt);
  return scored[0] ? { expect: scored[0].fix.check.expect } : null;
}

const labelledFixes = (store: Store) => store.listFixes().map((fix) => ({ fix, labels: fixLabelInfo(store, fix).labels }));

export interface NeedsLookItem {
  /**
   * `broken`: an applied fix that doesn't hold; `open`: a failure with no fix yet; `unblamed`: a
   * failed run never blamed; `ready`: a verified fix not applied.
   */
  kind: 'broken' | 'open' | 'unblamed' | 'ready';
  href: string;
  /** The glyph the mock gives it: blame, fail or fixok. */
  icon: 'blame' | 'fail' | 'fixok';
  title: string;
  detail: string;
  action: 'Open' | 'Fix it' | 'Run blame' | 'Apply' | 'Mark applied';
  fixId: string | null;
  runId: string | null;
  at: number;
  /** For a failed run never blamed: the check of a fix its labels point to, which a blame of it can use. */
  expect?: unknown;
}

/**
 * Why a repair that accepted nothing found no fix, when its repairer was never asked and nothing
 * else was tried: in a few words, `the repairer could not be asked` (claude was not found, say), or
 * that none is configured or it had nothing to rewrite. Null for a repair that looked for a fix.
 */
function unaskedWords(r: StoredRepair): string | null {
  if (r.accepted || r.report.candidates.length) return null;
  const none = noRepairerOf(r.report)?.text;
  if (!none) return null;
  return none.startsWith(NO_REPAIRER.notAsked) ? NO_REPAIRER.notAsked : none;
}

/**
 * What needs a look about fixes, most urgent first: applied fixes that don't hold, failures with no
 * fix yet (open fixes, then failed runs never blamed), then verified fixes not applied.
 */
export function needsLookFixes(store: Store, options: { limit?: number; patchInTree?: PatchCheck } = {}): NeedsLookItem[] {
  const broken: NeedsLookItem[] = [];
  const open: NeedsLookItem[] = [];
  const ready: NeedsLookItem[] = [];
  for (const fix of store.listFixes()) {
    const rec = fixRecords(store, fix);
    if (fix.status === 'open') {
      const b = shownBlame(rec);
      const where = b?.outcome === 'blamed' && b.report.blamed ? lostWords(b.report, b.report.blamed.callNo) : b?.outcome === 'unrescuable' ? unrescuedWords(unsettledFirst(b.report)) : 'blame stopped early';
      // No answer of the model's lost it: a repair of the prompt is no fix, so the row opens the fix and says where to look.
      const elsewhere = noAnswerLost(b);
      // A repair whose repairer was never asked looked for no fix: it says why, not that none was found.
      const last = rec.repairs.at(-1);
      const repaired = last ? (unaskedWords(last) ?? 'no fix found yet') : 'no fix yet';
      open.push({ kind: 'open', href: fixHref(fix.fixId), icon: 'blame', title: fix.title, detail: `${where} · ${elsewhere ? 'look at the tools, the harness or the command' : repaired}`, action: elsewhere ? 'Open' : 'Fix it', fixId: fix.fixId, runId: null, at: fix.openedAt });
    } else if (fix.status === 'verified') {
      // Its patch is in the working tree already: nothing is ready to apply, and the fix's page offers Mark applied.
      if (patchMerged(rec, options.patchInTree)) continue;
      const p = shownRepair(rec);
      const c = p && acceptedCandidate(p);
      // No patch to apply, so the fix's page leads with Mark applied, and the line says it too: for a
      // change of request fields, which ones your agent is to make first.
      const mark = !repairToApply(rec);
      const v = mark ? unrepairedVerdict(rec) : null;
      const fields = v ? fieldsOf(v) : null;
      const detail = fields ? `make ${fields} in your agent, then mark it applied` : c ? commitTitle(c) : fix.title;
      ready.push({ kind: 'ready', href: fixHref(fix.fixId, c ? 'repair' : 'verify'), icon: 'fixok', title: 'A verified fix is ready', detail, action: mark ? 'Mark applied' : 'Apply', fixId: fix.fixId, runId: null, at: fix.verifiedAt ?? fix.openedAt });
    } else {
      const why = brokenOf(rec);
      if (!why) continue;
      const rejected = rejectedSinceApplied(rec);
      broken.push({ kind: 'broken', href: rejected ? fixHref(fix.fixId, 'verify', rejected.verifyId) : fixHref(fix.fixId), icon: 'fail', title: "An applied fix doesn't hold", detail: `${fix.title} · ${why}`, action: 'Open', fixId: fix.fixId, runId: null, at: rejected?.at ?? fix.appliedAt ?? fix.openedAt });
    }
  }
  const failed = unblamedFailures(store);
  const fixes = failed.length ? labelledFixes(store) : [];
  const unblamed: NeedsLookItem[] = failed.map((run) => {
    const suggested = checkSuggestion(run, fixes);
    return {
      kind: 'unblamed' as const,
      href: runHref(run.runId),
      icon: 'fail' as const,
      title: `A run failed: ${short(run.runId)}`,
      // A run is named by its id (decision 10): its labels are no name. The Overview puts the run's
      // about line in place of its command for the lines it shows.
      detail: `${run.command.argv.join(' ')} · not blamed yet`,
      action: 'Run blame' as const,
      fixId: null,
      runId: run.runId,
      at: run.startedAt,
      ...(suggested ? { expect: suggested.expect } : {}),
    };
  });
  const newest = (a: NeedsLookItem, b: NeedsLookItem) => b.at - a.at;
  const all = [...broken.sort(newest), ...open.sort(newest), ...unblamed.sort(newest), ...ready.sort(newest)];
  return options.limit ? all.slice(0, options.limit) : all;
}

export interface FixRef {
  fixId: string;
  href: string;
  title: string;
  status: FixStatus;
  label: string | null;
  check: string;
}

/** What a run page's blame banner says: lost at #n, model call k of m, the confidence, and in a few words what asking again did. */
export interface RunBlame {
  blameId: string;
  at: number;
  outcome: StoredBlame['outcome'];
  /** It placed the failure on no call only because its first probe couldn't tell: not settled, never "not rescued". Absent otherwise. */
  unsettled?: true;
  lostAt: number | null;
  step: number | null;
  steps: number;
  confidence: 'high' | 'medium' | 'low';
  rescuedRunId: string | null;
  /** "asked again, it calls escalate instead". */
  short: string;
  href: string;
}

export interface FixForRun {
  /**
   * How the run takes part: a failing run of the fix, a good run it keeps, an attempt of a blame
   * probe, the fork blame rescued it with, an attempt of a verify, or a failed run never blamed.
   */
  role: 'failing' | 'good' | 'probe' | 'rescued' | 'verify' | 'unblamed';
  fix: FixRef | null;
  /** The blame of the failing run (for a probe or the rescued fork, of the run it forked from). */
  blame: RunBlame | null;
  probe: { of: string; callNo: number; passed: boolean; blamed: boolean } | null;
  /** For a verify attempt: the verdict it counted towards (or the repair whose dropped candidate it tried). */
  verify: { verifyId: string | null; repairId: string | null; verdict: VerifyOutcome | null; role: VerifiedRun['role']; passed: boolean; href: string } | null;
  /** For a failed run never blamed: the check of a fix its labels point to, which Run blame can use. */
  expect?: unknown;
}

function fixRef(store: Store, fix: StoredFix): FixRef {
  return { fixId: fix.fixId, href: fixHref(fix.fixId), title: fix.title, status: fix.status, label: fixLabelInfo(store, fix).label, check: fix.check.text };
}

/** The tools a model's answer called, each once, in order. */
const toolsCalled = (blocks: ReadonlyArray<{ type: string; name?: string }>): string[] => [...new Set(blocks.flatMap((x) => (x.type === 'tool_call' && x.name ? [x.name] : [])))];

/**
 * What asking the blamed call again did, against what the recording answered there, in a few words:
 * "it calls escalate instead" only when it calls other tools; the same tools with other arguments,
 * an answer without a tool call, or the same calls in other words or order say so.
 */
function askedInstead(recorded: readonly Block[], rescued: readonly Block[]): string {
  const was = toolsCalled(recorded);
  const now = toolsCalled(rescued);
  const calls = (blocks: readonly Block[]) => blocks.flatMap((x) => (x.type === 'tool_call' ? [`${x.name} ${canonicalize(x.input ?? null)}`] : [])).sort().join('\n');
  if (!rescued.length) return 'the run passes';
  if (!now.length) return was.length ? 'it answers without a tool call' : 'it answers differently';
  if (now.length !== was.length || now.some((t) => !was.includes(t))) return `it calls ${now.join(' and ')} instead`;
  return calls(rescued) !== calls(recorded) ? `it calls ${now.join(' and ')} with other arguments` : 'it answers differently';
}

/** What the model did at the blamed call when asked again, in a few words: "called escalate". */
function askedAgain(blocks: ReadonlyArray<{ type: string; name?: string }>): string {
  const tools = toolsCalled(blocks);
  return tools.length ? `called ${tools.join(' and ')}` : blocks.length ? 'answered without a tool call' : 'the run passed';
}

function runBlame(b: StoredBlame, fixId: string | null): RunBlame {
  const r = b.report;
  const what = b.outcome === 'blamed' ? `asked again, ${askedInstead(r.contrast?.recorded ?? [], r.contrast?.rescued ?? [])}` : b.outcome === 'unrescuable' ? unrescuedWords(unsettledFirst(r)) : 'blame stopped early';
  return { blameId: b.blameId, at: b.at, outcome: b.outcome, ...(unsettledFirst(r) ? { unsettled: true as const } : {}), lostAt: r.blamed?.callNo ?? null, step: r.blamed?.step ?? null, steps: r.steps, confidence: r.confidence, rescuedRunId: r.contrast?.rescuedRunId ?? null, short: what, href: fixId ? fixHref(fixId, 'blame') : runHref(b.runId) };
}

/** How a run takes part in Fixes, for its page and the Forks view; null when it doesn't. */
export function fixForRun(store: Store, runId: string): FixForRun | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const failing = fixOfRun(store, runId);
  if (failing) {
    const b = store.blamesOfRun(runId).at(-1);
    return { role: 'failing', fix: fixRef(store, failing), blame: b ? runBlame(b, failing.fixId) : null, probe: null, verify: null };
  }
  const probe = run.meta?.probe;
  if (probe && typeof probe.of === 'string') {
    const fix = fixOfRun(store, probe.of);
    const blames = store.blamesOfRun(probe.of);
    const b = [...blames].reverse().find((x) => x.report.probes.some((p) => p.attempts.some((a) => a.runId === runId))) ?? blames.at(-1) ?? null;
    const rescued = !!b && b.report.contrast?.rescuedRunId === runId;
    return {
      role: rescued ? 'rescued' : 'probe',
      fix: fix ? fixRef(store, fix) : null,
      blame: b ? runBlame(b, fix?.fixId ?? null) : null,
      probe: { of: probe.of, callNo: probe.callNo, passed: probe.passed, blamed: !!b && b.report.blamed?.callNo === probe.callNo },
      verify: null,
    };
  }
  const attempt = run.meta?.verify;
  if (attempt) {
    const inReport = (r: { runs: VerifiedRun[] }) => r.runs.some((x) => x.attempts.some((a) => a.runId === runId));
    const verdict = [...store.listVerdicts()].reverse().find((v) => inReport(v.report)) ?? null;
    const repair = verdict ? null : ([...store.listRepairs()].reverse().find((r) => r.report.candidates.some((c) => c.verify && inReport(c.verify))) ?? null);
    const link = verdict ? store.linksTo(verdict.verifyId, 'verify')[0] : repair ? store.linksTo(repair.repairId, 'repair')[0] : undefined;
    const fix = link ? store.getFix(link.fixId) : run.parentRunId ? fixOfRun(store, run.parentRunId) : null;
    const href = fix ? (verdict ? fixHref(fix.fixId, 'verify', verdict.verifyId) : fixHref(fix.fixId, 'repair')) : runHref(run.parentRunId ?? runId);
    return { role: 'verify', fix: fix ? fixRef(store, fix) : null, blame: null, probe: null, verify: { verifyId: verdict?.verifyId ?? null, repairId: verdict?.repairId ?? repair?.repairId ?? null, verdict: verdict?.verdict ?? null, role: attempt.role, passed: attempt.passed, href } };
  }
  const good = store.linksTo(runId, 'good')[0];
  if (good) {
    const fix = store.getFix(good.fixId);
    if (fix) return { role: 'good', fix: fixRef(store, fix), blame: null, probe: null, verify: null };
  }
  if (isUnblamedFailure(store, run)) {
    const suggested = checkSuggestion(run, fixLabels(run).length ? labelledFixes(store) : []);
    return { role: 'unblamed', fix: null, blame: null, probe: null, verify: null, ...(suggested ? { expect: suggested.expect } : {}) };
  }
  return null;
}

// ---- The Forks view: the attempts blame and verify made, bundled under the run they replayed ----

export interface FixBundleAttempt {
  runId: string;
  passed: boolean;
  /** Passed, failed, or inconclusive: all it fell short on is a check that could not be decided, so it is neither. */
  verdict: AttemptVerdict;
  /** "passed", "issue_refund called", "passed · called escalate". */
  note: string;
  href: string;
  /** The fork blame rescued its run with: it shows as a fork of its own as well. */
  rescued: boolean;
}

export interface FixBundle {
  /** Blame's attempts at one probed call, or verify's attempts at one run under one change. */
  kind: 'blame' | 'verify';
  /** Stays the same from one load to the next. */
  key: string;
  /** The run the attempts replayed: the bundle sits under it in the family. */
  parentRunId: string;
  /** `blame · probe #5`, `verify · target`; under a run several fixes share, with the fix's name: `verify · good · refund-bug`. */
  title: string;
  /** For a probe: the model call asked again; the one blame named is where the run was lost. */
  callNo: number | null;
  blamed: boolean;
  /** For verify: the change it checked, named as the Verify step's switch names it (`changeName`), how it came out, and the run's role. */
  change: string | null;
  verdict: VerifyOutcome | null;
  role: VerifyRow['role'] | null;
  /**
   * For a verdict: whether it counts for the fix the bundle leads to, as its Verify step's switch
   * says (false: "doesn't count"). Null for blame's attempts, a candidate a repair dropped (no
   * verdict of the fix's), and attempts no stored report names.
   */
  counts: boolean | null;
  passes: number;
  attempts: FixBundleAttempt[];
  spent: number;
  at: number;
  /**
   * Its verdict as every page says a gate's (decision 9): the word, the tally and the Wilson bound,
   * `rescued · 2 of 2 · rate >= 0.34 (95%)`, `fixed · 12 of 12 · rate >= 0.76 (95%)` (a fixed count
   * its tally alone), in its tone; null for attempts no stored report names.
   */
  verdictLine?: string | null;
  tone?: VerdictTone | null;
  /**
   * The rule it was decided by (`gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20
   * attempts`), which the Forks view states once in the family, under the first bundle it decided;
   * null with no stored report.
   */
  rule?: string | null;
  /**
   * Where it leads: the fix's Blame step for a probe, the verdict on the fix's Verify step, the
   * Repair step for a candidate a repair tried and dropped; the run itself when no fix holds it.
   */
  href: string;
  fixId: string | null;
}

/** Runs the dashboard reads in one family at most, as the lineage endpoint does. */
const FAMILY_LIMIT = 5000;

/** A run's family: its root recording and every run that descends from it. */
function familyOf(store: Store, run: RunRecord): Map<string, RunRecord> {
  let root = run;
  const up = new Set([root.runId]);
  while (root.parentRunId) {
    const parent = store.getRun(root.parentRunId);
    if (!parent || up.has(parent.runId)) break;
    up.add(parent.runId);
    root = parent;
  }
  const family = new Map<string, RunRecord>();
  const queue = [root];
  while (queue.length && family.size < FAMILY_LIMIT) {
    const r = queue.shift()!;
    if (family.has(r.runId)) continue;
    family.set(r.runId, r);
    queue.push(...store.childRuns(r.runId));
  }
  return family;
}

/**
 * Every verdict and repair report, read once for each change to fixes: the store's `fixes` counter
 * moves whenever one is written, so a Forks view polled while nothing changes parses none again.
 */
const reportsRead = new WeakMap<Store, { n: number; verdicts: StoredVerdict[]; repairs: StoredRepair[] }>();
function storedReports(store: Store): { verdicts: StoredVerdict[]; repairs: StoredRepair[] } {
  const n = store.changeCounts().fixes;
  const kept = reportsRead.get(store);
  if (kept && n !== undefined && kept.n === n) return kept;
  const read = { n: n ?? -1, verdicts: store.listVerdicts(), repairs: store.listRepairs() };
  if (n !== undefined) reportsRead.set(store, read);
  return read;
}

type AttemptVerdict = 'passed' | 'failed' | 'inconclusive';

/**
 * An attempt's verdict as blame or verify kept it, or, for one kept before attempts had one, by whether
 * it passed. One its provider was unavailable for neither passed nor failed (attempts.ts in the CLI).
 */
function attemptVerdictOf(a: { passed: boolean; verdict?: string | undefined }): AttemptVerdict {
  return a.verdict === 'inconclusive' || a.verdict === 'unavailable' ? 'inconclusive' : a.passed ? 'passed' : 'failed';
}

/**
 * A failed attempt's first failure, from its run when the report kept none; for one that could not be
 * judged, the check that could not be decided, said as such: never as a failure.
 */
function attemptNote(passed: boolean, failure: string | undefined, run: RunRecord | undefined, verdict: AttemptVerdict = passed ? 'passed' : 'failed'): string {
  if (passed) return 'passed';
  if (verdict === 'inconclusive') {
    const label = failure?.split(', but it is inconclusive')[0] ?? run?.meta?.checks?.find((c) => !c.ok)?.label;
    return `inconclusive${label ? `: ${shortFailure(label)}` : ''}`;
  }
  if (failure) return shortFailure(failure);
  const check = run?.meta?.checks?.find((c) => !c.ok);
  return check ? shortFailure(check.label) : run?.status === 'crashed' ? 'interrupted' : 'failed';
}

/**
 * The attempts blame and verify made in a run's family, bundled per probe and per verified run, for
 * the Forks view: each bundle sits under the run its attempts replayed, says which probe blame named
 * (`blamed`) and how the change a verify checked came out, and links to the step of the fix it
 * belongs to. Attempts no stored report names (a blame made before fixes kept blames) are bundled
 * from the marks on the runs themselves. Null for a run that isn't in the store.
 */
export function fixBundles(store: Store, runId: string): FixBundle[] | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const family = familyOf(store, run);
  // Only attempts are bundled, so a family without one has no bundle and costs no more than its walk.
  const probed = new Set<string>();
  let checked = false;
  for (const r of family.values()) {
    if (r.meta?.probe && r.parentRunId) probed.add(r.parentRunId);
    if (r.meta?.verify) checked = true;
  }
  if (!probed.size && !checked) return [];
  const out: FixBundle[] = [];
  const bundled = new Set<string>();
  const exists = (id: string) => family.has(id);
  const startedAt = (ids: readonly string[], fallback: number) => Math.min(...ids.map((id) => family.get(id)?.startedAt ?? fallback), fallback);
  const linkedFix = (ref: string, kind: 'blame' | 'repair' | 'verify', runOf: string): StoredFix | null => {
    const fixes = store.linksTo(ref, kind).map((l) => store.getFix(l.fixId)).filter((f): f is StoredFix => f !== null);
    // A verdict shared by several fixes leads to the one the run takes part in.
    const own = fixes.find((f) => store.linksTo(runOf).some((l) => l.fixId === f.fixId && (l.kind === 'failing' || l.kind === 'good')));
    return own ?? fixes[0] ?? null;
  };

  // Blame: each blame of a run in the family whose probes are here (they fork from the run blamed), a
  // bundle per probed call.
  for (const id of probed) {
    const r = family.get(id);
    if (!r || r.meta?.probe || r.meta?.verify) continue;
    for (const b of store.blamesOfRun(r.runId)) {
      const fix = linkedFix(b.blameId, 'blame', r.runId) ?? fixOfRun(store, r.runId);
      const rescuedRunId = b.report.contrast?.rescuedRunId ?? null;
      const rescuedNote = b.report.contrast ? `passed · ${askedAgain(b.report.contrast.rescued)}` : 'passed';
      const blamedCall = b.outcome === 'blamed' ? (b.report.blamed?.callNo ?? null) : null;
      for (const p of b.report.probes) {
        const attempts = p.attempts.filter((a) => exists(a.runId));
        if (!attempts.length) continue;
        for (const a of attempts) bundled.add(a.runId);
        const v = probeLine(p, b.report);
        out.push({
          kind: 'blame',
          key: `${b.blameId}:${p.callNo}`,
          parentRunId: r.runId,
          title: `blame · probe #${p.callNo}`,
          callNo: p.callNo,
          blamed: p.callNo === blamedCall,
          change: null,
          verdict: null,
          role: null,
          counts: null,
          passes: attempts.filter((a) => a.passed).length,
          attempts: attempts.map((a) => ({ runId: a.runId, passed: a.passed, verdict: attemptVerdictOf(a), note: a.passed && a.runId === rescuedRunId ? rescuedNote : attemptNote(a.passed, a.failures[0], family.get(a.runId), attemptVerdictOf(a)), href: runHref(a.runId), rescued: a.runId === rescuedRunId })),
          spent: attempts.reduce((s2, a) => s2 + a.spent, 0),
          at: startedAt(attempts.map((a) => a.runId), b.at),
          verdictLine: v.line,
          tone: v.tone,
          rule: v.rule,
          href: fix ? fixHref(fix.fixId, 'blame') : runHref(r.runId, blamedCall),
          fixId: fix?.fixId ?? null,
        });
      }
      // The check of the call the probes pinned: its pairs, both calls' attempts, as one bundle.
      const check = b.report.pin;
      const checked = check ? check.pairs.flatMap((x) => [x.at, x.next]).filter((a) => exists(a.runId)) : [];
      if (check && checked.length) {
        for (const a of checked) bundled.add(a.runId);
        out.push({
          kind: 'blame',
          key: `${b.blameId}:check`,
          parentRunId: r.runId,
          title: `blame · check of #${check.callNo}`,
          callNo: check.callNo,
          blamed: false,
          change: null,
          verdict: null,
          role: null,
          counts: null,
          passes: checked.filter((a) => a.passed).length,
          attempts: checked.map((a) => ({ runId: a.runId, passed: a.passed, verdict: attemptVerdictOf(a), note: attemptNote(a.passed, a.failures[0], family.get(a.runId), attemptVerdictOf(a)), href: runHref(a.runId), rescued: false })),
          spent: checked.reduce((s2, a) => s2 + a.spent, 0),
          at: startedAt(checked.map((a) => a.runId), b.at),
          verdictLine: pinWords(check),
          tone: check.verdict === 'pinned' ? 'ok' : 'y',
          rule: null,
          href: fix ? fixHref(fix.fixId, 'blame') : runHref(r.runId, blamedCall),
          fixId: fix?.fixId ?? null,
        });
      }
    }
  }

  // Verify: each verdict on a run in the family, and each candidate a repair tried and dropped (its
  // check is kept in the repair's report, not as a verdict), a bundle per run it replayed.
  const verified = (key: string, x: VerifiedRun, change: string, verdict: VerifyOutcome, counts: boolean | null, fix: StoredFix | null, href: string, at: number, rule: string) => {
    const attempts = x.attempts.filter((a) => exists(a.runId) && !bundled.has(a.runId));
    if (!attempts.length) return;
    for (const a of attempts) bundled.add(a.runId);
    const v = verifiedLine(x);
    out.push({
      kind: 'verify',
      key,
      parentRunId: x.runId,
      title: `verify · ${ROLE[x.role]}`,
      callNo: null,
      blamed: false,
      change,
      verdict,
      role: ROLE[x.role],
      counts,
      passes: attempts.filter((a) => a.passed).length,
      attempts: attempts.map((a) => ({ runId: a.runId, passed: a.passed, verdict: attemptVerdictOf(a), note: attemptNote(a.passed, a.failures[0], family.get(a.runId), attemptVerdictOf(a)), href: runHref(a.runId), rescued: false })),
      spent: attempts.reduce((s2, a) => s2 + a.spent, 0),
      at: startedAt(attempts.map((a) => a.runId), at),
      verdictLine: v.line,
      tone: v.tone,
      rule,
      href,
      fixId: fix?.fixId ?? null,
    });
  };
  const inFamily = (runs: readonly VerifiedRun[]) => runs.filter((x) => exists(x.runId));
  const { verdicts, repairs } = checked ? storedReports(store) : { verdicts: [], repairs: [] };
  for (const v of verdicts) {
    for (const x of inFamily(v.report.runs)) {
      const fix = linkedFix(v.verifyId, 'verify', x.runId);
      const change = changeName(v);
      // Whether it counts for the fix it leads to, as that fix's Verify step says: kept with the link.
      const counts = fix ? (store.linksTo(v.verifyId, 'verify').find((l) => l.fixId === fix.fixId)?.data?.counts ?? true) : null;
      verified(`${v.verifyId}:${x.runId}`, x, change, v.verdict, counts, fix, fix ? fixHref(fix.fixId, 'verify', v.verifyId) : runHref(x.runId), v.at, runsRule({ gate: sprtGate(v.report.gate), needed: v.report.needed, attemptsPerRun: v.report.attemptsPerRun, kept: v.report.kept ?? null }, x));
    }
  }
  const kept = new Set(verdicts.flatMap((v) => (v.repairId !== null && v.candidate !== null ? [`${v.repairId}#${v.candidate}`] : [])));
  for (const r of repairs) {
    for (const c of r.report.candidates) {
      if (!c.verify || kept.has(`${r.repairId}#${c.id}`)) continue;
      for (const x of inFamily(c.verify.runs)) {
        const fix = linkedFix(r.repairId, 'repair', x.runId);
        verified(`${r.repairId}#${c.id}:${x.runId}`, x, `repair candidate ${c.id}`, c.verify.verdict, null, fix, fix ? fixHref(fix.fixId, 'repair') : runHref(x.runId), r.at, runsRule({ gate: sprtGate(c.verify.gate), needed: c.verify.needed, attemptsPerRun: c.verify.attemptsPerRun, kept: c.verify.kept ?? null }, x));
      }
    }
  }

  // Attempts that carry blame's or verify's mark but that no stored report names.
  const loose = new Map<string, { parent: RunRecord; kind: 'blame' | 'verify'; callNo: number | null; role: VerifyRow['role'] | null; runs: RunRecord[] }>();
  for (const r of family.values()) {
    if (bundled.has(r.runId) || !r.parentRunId || !family.has(r.parentRunId)) continue;
    const parent = family.get(r.parentRunId)!;
    const probe = r.meta?.probe;
    const check = r.meta?.verify;
    if (probe && typeof probe.callNo === 'number' && probe.of === parent.runId) {
      const key = `probe:${parent.runId}:${probe.callNo}`;
      const group = loose.get(key) ?? { parent, kind: 'blame' as const, callNo: probe.callNo, role: null, runs: [] };
      group.runs.push(r);
      loose.set(key, group);
    } else if (check && (check.role === 'target' || check.role === 'holdout' || check.role === 'good')) {
      const key = `verify:${parent.runId}:${check.role}`;
      const group = loose.get(key) ?? { parent, kind: 'verify' as const, callNo: null, role: ROLE[check.role], runs: [] };
      group.runs.push(r);
      loose.set(key, group);
    }
  }
  for (const [key, g] of loose) {
    const lost = g.parent.meta?.blame;
    const blamed = g.kind === 'blame' && lost?.outcome === 'blamed' && lost.callNo === g.callNo;
    const rescuedRunId = lost?.rescuedRunId ?? null;
    const fix = g.kind === 'blame' ? fixOfRun(store, g.parent.runId) : null;
    const passed = (r: RunRecord) => (g.kind === 'blame' ? r.meta?.probe?.passed === true : r.meta?.verify?.passed === true);
    const verdict = (r: RunRecord) => attemptVerdictOf({ passed: passed(r), verdict: g.kind === 'blame' ? r.meta?.probe?.verdict : r.meta?.verify?.verdict });
    out.push({
      kind: g.kind,
      key,
      parentRunId: g.parent.runId,
      title: g.kind === 'blame' ? `blame · probe #${g.callNo!}` : `verify · ${g.role!}`,
      callNo: g.callNo,
      blamed,
      change: null,
      verdict: null,
      role: g.role,
      counts: null,
      passes: g.runs.filter(passed).length,
      attempts: g.runs.map((r) => ({ runId: r.runId, passed: passed(r), verdict: verdict(r), note: attemptNote(passed(r), undefined, r, verdict(r)), href: runHref(r.runId), rescued: r.runId === rescuedRunId })),
      spent: 0,
      at: Math.min(...g.runs.map((r) => r.startedAt)),
      verdictLine: null,
      tone: null,
      rule: null,
      href: fix ? fixHref(fix.fixId, 'blame') : runHref(g.parent.runId, blamed ? g.callNo : null),
      fixId: fix?.fixId ?? null,
    });
  }
  nameSharedBundles(store, out);
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/**
 * A run several fixes blamed or verified carries bundles from each, which would read the same
 * ("verify · good" under a good run three fixes kept): there, each title names its fix, by its label
 * or its short id ("verify · good · refund-bug").
 */
function nameSharedBundles(store: Store, bundles: FixBundle[]): void {
  const fixesUnder = new Map<string, Set<string>>();
  for (const b of bundles) if (b.fixId) fixesUnder.set(b.parentRunId, (fixesUnder.get(b.parentRunId) ?? new Set()).add(b.fixId));
  const names = new Map<string, string>();
  const nameOf = (fixId: string): string => {
    let name = names.get(fixId);
    if (name === undefined) {
      const fix = store.getFix(fixId);
      name = (fix ? fixLabelInfo(store, fix).label : null) ?? fixId.slice(0, 13);
      names.set(fixId, name);
    }
    return name;
  };
  for (const b of bundles) if (b.fixId && (fixesUnder.get(b.parentRunId)?.size ?? 0) > 1) b.title = `${b.title} · ${nameOf(b.fixId)}`;
}

// ---- What a blame from the dashboard checks ------------------------------------------------------

export interface BlameCheck {
  /** The check as `--expect` takes it; null to blame on the exit code alone. */
  expect: unknown;
  /**
   * Where it came from: the run was judged by it with `--expect` (`replay`); shadowlap.config.json's
   * `tests` give it for the recording the run replays, found through its ancestors as the CLI finds
   * it (`config`); the fix the run fails in has it (`fix`); a fix the run's labels point to has it
   * (`labels`); or the agent exited with an error, which every blame checks (`exit`).
   */
  from: 'replay' | 'config' | 'fix' | 'labels' | 'exit';
}

const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The checks a run failed, as it recorded them (`meta.checks`). */
export function failedChecks(run: RunRecord): string[] {
  const checks: unknown = run.meta?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((c) => (plainObject(c) && c.ok === false && typeof c.label === 'string' ? [c.label] : []));
}

/**
 * The `expect` shadowlap.config.json's `tests` give the recording a run replays (the golden a test
 * replayed, or the pack it was unpacked from, through its ancestors), or undefined when no entry
 * names one. `tests` is the config's `tests` as written; `configDir` the folder it is in.
 */
export function configExpect(store: Store, run: RunRecord, tests: unknown, configDir: string): Record<string, unknown> | undefined {
  if (!plainObject(tests)) return undefined;
  const entries = Object.entries(tests).map(([recording, spec]) => ({ recording, spec }));
  for (const dir of recordingsOfRun(store, run)) {
    const entry = testsEntryFor(entries, dir, configDir);
    if (entry) return plainObject(entry.spec) && plainObject(entry.spec.expect) ? entry.spec.expect : undefined;
  }
  return undefined;
}

/**
 * The check a blame of a run can use when nobody named one, or null when nothing says what a
 * passing run must do: then the dashboard asks for it. In order: the run's own `--expect`; the
 * config's, for the recording it replays (`tests`, the config's `tests`, and `configDir`, its
 * folder); the fix it fails in; a fix its labels point to; the agent's exit, for a run that exited
 * with an error. A run that failed a check none of these name gets null rather than the exit code:
 * blaming on the exit alone would look for another failure than the one it had.
 */
export function blameCheckFor(store: Store, run: RunRecord, options: { tests?: unknown; configDir?: string | null } = {}): BlameCheck | null {
  const judged = run.meta?.expect;
  if (plainObject(judged)) return { expect: judged, from: 'replay' };
  const configured = options.configDir ? configExpect(store, run, options.tests, options.configDir) : undefined;
  if (configured) return { expect: configured, from: 'config' };
  const failing = fixOfRun(store, run.runId);
  if (failing) return { expect: failing.check.expect ?? null, from: 'fix' };
  const suggested = fixLabels(run).length ? checkSuggestion(run, labelledFixes(store)) : null;
  if (suggested) return { expect: suggested.expect ?? null, from: 'labels' };
  if (failedChecks(run).length) return null;
  if (run.status === 'failed') return { expect: null, from: 'exit' };
  return null;
}
