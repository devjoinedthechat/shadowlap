import { BLAME_DEFAULTS, fieldValue, outcomeOf, repairPatchProblem, repairToApply, SPRT_DEFAULTS, verdictCounts, type AttemptVerdict, type FixRecords, type NoFixToTry, type PulledFrom, type RepairCandidate, type RunRecord, type StoreOf, type StoredRepair, type SprtGate, type StoredVerdict, type VerifiedRun } from '@shadowlap/engine';
import { type VerifyEvidence } from './evidence.js';
import { links } from './links.js';
import { isCount } from './rerun.js';
import { loadRunIndex, type RunIndex } from './run-index.js';
import { splitCommandLine } from './settings.js';

/** What the Fixes pages' read models share: a fix's links and its steps' words, its blame, repair and verdicts as the pages pick them, a patch as it is checked, and the change a verdict was made under. */

export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A report's gate as the steps read it: an SPRT gate with its four figures, or null for a fixed
 * count, or for one a copy from elsewhere carries malformed (the team store refuses those on pull;
 * a store edited by hand could still hold one).
 */
export function sprtGate(g: unknown): SprtGate | null {
  if (!g || typeof g !== 'object') return null;
  const x = g as Record<string, unknown>;
  return x.kind === 'sprt' && finite(x.good) && finite(x.bad) && finite(x.risk) && finite(x.max) ? { kind: 'sprt', good: x.good, bad: x.bad, risk: x.risk, max: x.max } : null;
}

export type StepKey = 'blame' | 'repair' | 'verify';

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

export interface FixActions {
  /**
   * An open fix: repair from here. Argv after `shadowlap`, without `--db` or `--repairer`, which the
   * caller adds (`repairJobArgv`); `command` is the whole command line, repairer included. `noFix`:
   * why the repair would end "No fix to try" without running the agent, in a sentence (`noFixToTry`),
   * or null when it would run it; `noFixWhy`, which of the estimate's two cases that is; `candidates`,
   * how many it asks the repairer for.
   */
  repair: { argv: string[]; command: string; noFix: string | null; noFixWhy: NoFixToTry | null; candidates: number } | null;
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
   * and tests. `names`: each of them it copies now (one copied before keeps where it went), by the
   * run it is a recording of (its short id), with the name it takes unless the dialog gives another
   * (`fix apply --name <run>=<name>`); `held`: the names the project's goldens folder holds, which
   * none may take, or null where the folder wasn't read. `change`: for a change of request fields
   * (`--set`, `--model`) with no patch, what it set (`fieldChange`): marking it applied leaves making
   * it in the agent to you.
   */
  apply: { kind: 'patch' | 'mark'; argv: string[]; gitApply: string | null; pending: string | null; pulled: boolean; files: string[]; diff: string | null; patchFile: string | null; refused: string | null; inTree: boolean; goldens: number; names: Array<{ run: string; name: string }>; held: string[] | null; change: string | null } | null;
  applied: boolean;
  /**
   * An open fix whose blame couldn't settle where its run was lost (`unsettled`: its first probe
   * passed between the gate's two rates) or stopped part way (`stopped`): Run blame again, the same
   * blame under the fix's check, without the budget that stopped it, and for one inconclusive with
   * more attempts and a lower bar, as blame's report says (`gate`), with the last blame's good rate
   * beside it (`lastGood`). For one stopped part way, `soFar` is the furthest call a probe rescued the
   * run at, which its ask says the last search stopped at; null when none did. Null otherwise.
   */
  blameAgain: { kind: 'unsettled' | 'stopped'; argv: string[]; command: string; gate: SprtGate | null; lastGood: number | null; soFar: number | null; pulled: PulledFrom | null; left: string[] } | null;
  /**
   * An open fix whose blame rescued its run from no call, asking the recorded model again, and
   * found nothing that says the model's answer isn't what lost it: Run blame with stronger model, the
   * same blame with `--model <model>` after `argv`, the model asked for. `attempts` and `spent` are
   * what the last blame took. Null otherwise. Both are built from the blame's checked fields and
   * flags (rerun.ts), never from its command line; one a pull brought (`pulled`) runs only once the
   * user says yes to its command, without what runs on no other machine (`left`).
   */
  blameStronger: { argv: string[]; command: string; attempts: number; spent: number; pulled: PulledFrom | null; left: string[] } | null;
}

// Links come from the one builder (links.ts), which the page's route parser reads back.
export const fixHref = (fixId: string, step?: StepKey, sub?: string): string => links.fixes(fixId, step ?? null, sub ?? null);

export const runHref = (runId: string, call?: number | null): string => links.run(runId, call ?? null);

// The fix modules' run ids, plurals and blames that lost no answer, as the engine says them.
export { noAnswerLost, pluralS as s, shortRunId as short } from '@shadowlap/engine';

export const ROLE: Record<VerifiedRun['role'], VerifyRow['role']> = { target: 'target', holdout: 'held-out', good: 'good' };

/** Single quotes around a shell word that needs them, as the CLI prints commands. */
const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

export const commandLine = (argv: string[]) => ['shadowlap', ...argv].map(quote).join(' ');

/** Whether a repair's accepted candidate was verified in a way that counts for the fix. */
export const repairCounts = (rec: FixRecords, r: StoredRepair) => rec.verdicts.some((v) => v.repairId === r.repairId && verdictCounts(rec, v));

/** The repair a fix shows: the latest whose accepted candidate counts for it, else the latest that accepted one, else the latest. */
export function shownRepair(rec: FixRecords): StoredRepair | null {
  const latest = [...rec.repairs].reverse();
  return latest.find((r) => r.accepted && repairCounts(rec, r)) ?? latest.find((r) => r.accepted) ?? latest[0] ?? null;
}

export const counting = (rec: FixRecords) => rec.verdicts.filter((v) => verdictCounts(rec, v));

export function acceptedVerdict(rec: FixRecords): StoredVerdict | null {
  return [...counting(rec)].reverse().find((v) => v.verdict === 'accepted') ?? null;
}

export const acceptedCandidate = (r: StoredRepair): RepairCandidate | null => (r.accepted ? (r.report.candidates.find((c) => c.id === r.report.accepted) ?? null) : null);

export function repairerLabel(r: StoredRepair): string | null {
  const x = r.report.repairer;
  if (!x) return null;
  return x.model ? `${x.provider}:${x.model}` : x.provider;
}

/** The latest settled verdict that counts, given after the fix was applied, when it rejected the change. */
export function rejectedSinceApplied(rec: FixRecords): StoredVerdict | null {
  const at = rec.fix.appliedAt;
  if (rec.fix.status !== 'applied' || at === null) return null;
  const last = counting(rec).filter((v) => v.at > at && v.verdict !== 'incomplete').at(-1);
  return last?.verdict === 'rejected' ? last : null;
}

/** Why an applied fix doesn't hold, or null. */
export function brokenOf(rec: FixRecords): string | null {
  if (rec.fix.status !== 'applied') return null;
  if (rec.fix.data.applied?.tests === 'failed') return 'shadowlap test failed on its goldens';
  return rejectedSinceApplied(rec) ? 'a verify rejected it after it was applied' : null;
}

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
export function changeName(v: Pick<StoredVerdict, 'candidate' | 'command' | 'rerun' | 'report'>): string {
  if (v.candidate !== null) return `repair candidate ${v.candidate}`;
  const fields = fieldsSet(v);
  if (!fields) return v.report.codeVersion ?? 'working tree';
  return `${fields}${v.report.codeVersion ? ` · at ${v.report.codeVersion}` : ''}`;
}

/** The request fields a verdict's change set, as `--set` takes them (fieldValue): `temperature=1`, `stop="1"`; null for a change all in the code. */
export function fieldsOf(v: Pick<StoredVerdict, 'report'>): string | null {
  const fields = Object.entries(v.report.fields ?? {});
  return fields.length ? fields.map(([k, x]) => `${k}=${fieldValue(x)}`).join(', ') : null;
}

/** The request fields a verdict's change set, and from where: `temperature=1 from each run's first model call`; null for a change all in the code. */
export function fieldsSet(v: Pick<StoredVerdict, 'command' | 'rerun' | 'report'>): string | null {
  const set = fieldsOf(v);
  if (!set) return null;
  const from = fromModels(v);
  return `${set} from each run's first ${from.length ? `${from.join(' or ')} call` : 'model call'}`;
}

/** The verdict that verified a fix with no repair behind it: a change of request fields, or one in the working tree. */
export function unrepairedVerdict(rec: FixRecords): StoredVerdict | null {
  const v = acceptedVerdict(rec);
  return v && v.candidate === null ? v : null;
}

/**
 * What one yes may spend running a pulled record again. Its figures came from a teammate's machine,
 * or from anyone who can write the bucket, so they run at most what Shadowlap runs by itself, at
 * most twice over: a gate up to twice its default max (blame's 20, verify's 80), a fixed count up to
 * 10 attempts (5 is the default), and blame probing at most its default 2 calls past the boundary
 * (rerun.ts). A record made here runs as it was kept.
 */
export const PULLED_CAP = { blame: 2 * BLAME_DEFAULTS.max, verify: 2 * SPRT_DEFAULTS.max, count: 10 } as const;

/** A gate as a pulled record runs again: its max held to `cap`. */
export function pulledGate(gate: SprtGate | null, pulled: boolean, cap: number): SprtGate | null {
  return gate && pulled && gate.max > cap ? { ...gate, max: cap } : gate;
}

/** A fixed count as the CLI takes it (`--attempts n --passes k`), held to PULLED_CAP's for a pulled record; null when it isn't one. */
export function countArgs(attempts: number, needed: number, pulled: boolean): string[] | null {
  if (!isCount(attempts, 100) || attempts < 1 || !isCount(needed, attempts)) return null;
  const n = pulled ? Math.min(attempts, PULLED_CAP.count) : attempts;
  return ['--attempts', String(n), '--passes', String(Math.min(needed, n))];
}

/** `--gate` with the figures that differ from `defaults`, as the CLI writes it; nothing when none do. */
export function gateArg(gate: SprtGate, defaults: Omit<SprtGate, 'kind'>): string[] {
  const differs = (['good', 'bad', 'risk', 'max'] as const).filter((k) => gate[k] !== defaults[k]);
  return differs.length ? ['--gate', JSON.stringify(Object.fromEntries(differs.map((k) => [k, gate[k]])))] : [];
}

/**
 * Whether a fix's patch is in the project's working tree already, as the caller asks git
 * (`patchInTree`, patch-in-tree.ts); null when it can't say.
 */
export type PatchCheck = (patch: string) => boolean | null;

/**
 * Why `fix apply` refuses a repair's patch in the project's working tree, by the repair: one a pull
 * brought goes in only as a rewrite repair itself makes there, as the caller reads the file
 * (`rewritesHere`, patch-in-tree.ts); null when it doesn't refuse it, or can't say.
 */
export type RewriteCheck = (repairId: string) => string | null;

/**
 * A verified fix whose repair's patch is in the working tree already, as `check` asks git: merged by
 * a pull request, or applied by hand. Nothing is left to apply; `fix apply` only marks it applied.
 * A patch `fix apply` refuses is never asked about.
 */
export function patchMerged(rec: FixRecords, check: PatchCheck | undefined): boolean {
  if (!check) return false;
  const patch = patchToCheck(rec);
  return patch !== null && check(patch) === true;
}

/** The patch `patchMerged` asks about for a fix: a verified fix's, which `fix apply` would apply; null for any other. */
export function patchToCheck(rec: FixRecords): string | null {
  if (rec.fix.status !== 'verified') return null;
  const r = repairToApply(rec);
  return r?.report.patch && !repairPatchProblem(r.report) ? r.report.patch : null;
}

/**
 * A failed run that is not a fix yet, with no blame kept and in no fix: a recording whose agent
 * exited with an error, or a fork that failed as the run list judges it (its own check, or its
 * agent's exit), which Run blame takes as it takes a recording. Attempts are not: a blame probe's,
 * a verify's, a `--repeat`'s or a preset's failure counts towards what made them, a test's is
 * Tests', and an injection test's replay is judged by that test. A blame from before Fixes kept
 * blames (only `meta.blame` on the run) does not count: blaming it again opens its fix.
 */
export function isUnblamedFailure(store: StoreOf<'readModels' | 'fixes'>, run: RunRecord, index: RunIndex = loadRunIndex(store)): boolean {
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

/** The tools a model's answer called, each once, in order. */
export const toolsCalled = (blocks: ReadonlyArray<{ type: string; name?: string }>): string[] => [...new Set(blocks.flatMap((x) => (x.type === 'tool_call' && x.name ? [x.name] : [])))];

/** What the model did at the blamed call when asked again, in a few words: "called escalate". */
export function askedAgain(blocks: ReadonlyArray<{ type: string; name?: string }>): string {
  const tools = toolsCalled(blocks);
  return tools.length ? `called ${tools.join(' and ')}` : blocks.length ? 'answered without a tool call' : 'the run passed';
}

/**
 * A failed attempt's first failure, from its run when the report kept none; for one that could not be
 * judged, the check that could not be decided, said as such: never as a failure.
 */
export function attemptNote(passed: boolean, failure: string | undefined, run: RunRecord | undefined, verdict: AttemptVerdict = passed ? 'passed' : 'failed'): string {
  if (passed) return 'passed';
  if (verdict === 'inconclusive') {
    const label = failure?.split(', but it is inconclusive')[0] ?? run?.meta?.checks?.find((c) => !c.ok)?.label;
    return `inconclusive${label ? `: ${shortFailure(label)}` : ''}`;
  }
  if (failure) return shortFailure(failure);
  const check = run?.meta?.checks?.find((c) => !c.ok);
  return check ? shortFailure(check.label) : run?.status === 'crashed' ? 'interrupted' : 'failed';
}
