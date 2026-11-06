import { approx } from '../format.js';
import type { BlameStep, CandidateVerdict, FixBundle, FixDetail, FixRow, RepairStep, StepKey, VerifyMore, VerifyRow, VerifyStep } from '../types.js';
import { blameStateWord } from '../../../engine/src/blame-words.js';
import { repairOutcomeWord } from '../../../engine/src/repair-words.js';
import { verdictWord } from '../../../engine/src/verdict-words.js';
import { ACTIONS } from '../labels.js';
import { isObject } from '../../../engine/src/is-object.js';
import { lostWords } from '../../../engine/src/run-verdicts.js';
import { pluralS as s, shortFixId, twoDigits as pad } from '../../../engine/src/words.js';

/**
 * How the Fixes pages read a fix: which rows a filter keeps, which step and verdict a URL opens, the
 * words beside each badge, the run's calls as the Blame step lines them up, the change a repair made
 * cut to what changed, and report.md as blocks. No DOM here: the tests import it.
 */

// ---------------------------------------------------------------------------------------------- the list

export type FixChip = 'all' | 'open' | 'ready' | 'applied';

export const FIX_CHIPS: ReadonlyArray<{ key: FixChip; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'ready', label: 'Ready to apply' },
  { key: 'applied', label: 'Applied' },
];

export const isFixChip = (v: string): v is FixChip => FIX_CHIPS.some((c) => c.key === v);

/** A chip keeps the fixes in its bucket: open, ready to apply, or applied (a merged pull request's too). */
export function chipKeeps(chip: FixChip, f: { bucket: FixChip }): boolean {
  return chip === 'all' || f.bucket === chip;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** When a fix was opened: Sep 30, 16:20 (local time). */
export function fixStamp(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]!} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A later moment beside an earlier one: only its time on the same day (17:40), else its date too. */
export function laterStamp(ms: number, since: number): string {
  return sameDay(new Date(ms), new Date(since)) ? `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}` : fixStamp(ms);
}

// A fix's id as the CLI prints it, for the fix page and Settings.
export { shortFixId };

/** What the breadcrumb and the eyebrow call a fix: its label, or its short id. */
export function fixName(f: Pick<FixRow, 'label' | 'fixId'>): string {
  return f.label ?? shortFixId(f.fixId);
}

/** "3 failing runs": what they did and the check they must meet follow it, each labelled (`failedMust`). */
export function failingLine(f: Pick<FixRow, 'failing'>): string {
  return `${f.failing} failing run${s(f.failing)}`;
}

/**
 * A fix names its failure twice, what its failing runs did and the check they must meet, labelled
 * so the two never read as one: "Failed: send_email called twice, not once · Must: send_email called
 * once", in the list and the fix's header alike. A title that says what failed (blame titled the fix
 * by it, and nobody renamed it) leaves the check alone: `failed` is null then.
 */
export function failedMust(f: Pick<FixRow, 'title' | 'failed' | 'check'>): { failed: string | null; must: string } {
  const said = !f.failed?.trim() || f.failed.trim().toLowerCase() === f.title.trim().toLowerCase();
  return { failed: said ? null : f.failed, must: f.check };
}

/**
 * A check or a failure in words, cut where it may wrap: a count keeps its unit ("1 time", "2
 * attempts"), and a comparison keeps both sides with its operator (`amount <= get_policy.result
 * .limit`, `amount 240 > get_policy.result.limit 100`), set whole where there is room, so neither
 * side starts a line alone.
 */
export function wholeParts(text: string): Array<{ text: string; whole: boolean }> {
  const t = text.replace(/(\d) (times?|attempts?)\b/g, '$1\u00a0$2');
  const out: Array<{ text: string; whole: boolean }> = [];
  const re = /(\S+ (?:\d[\d.,]* )?)(<=|>=|!=|<|>) (\S+(?: \d[\d.,]*\b)?)/g;
  let at = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (m.index > at) out.push({ text: t.slice(at, m.index), whole: false });
    out.push({ text: `${m[1]!}${m[2]!}\u00a0${m[3]!.replace(' ', '\u00a0')}`, whole: true });
    at = m.index + m[0].length;
  }
  if (at < t.length) out.push({ text: t.slice(at), whole: false });
  return out;
}

// ---------------------------------------------------------------------------------------------- a fix

const STEPS: readonly StepKey[] = ['blame', 'repair', 'verify'];

/** The step a URL opens: the one it names, else the fix's last finished step. */
export function stepFor(f: Pick<FixDetail, 'defaultStep'>, step: string | null): StepKey {
  return step && (STEPS as readonly string[]).includes(step) ? (step as StepKey) : f.defaultStep;
}

/** The verdict the Verify step shows: the one its URL names (by id or a prefix of it), else the one the fix shows first. */
export function verifyFor(f: Pick<FixDetail, 'verify' | 'defaultVerify'>, sub: string | null): VerifyStep | null {
  const want = sub?.toLowerCase();
  const named = want ? f.verify.find((v) => v.verifyId.toLowerCase() === want || (want.length >= 6 && v.verifyId.toLowerCase().startsWith(want))) : undefined;
  return named ?? f.verify.find((v) => v.verifyId === f.defaultVerify) ?? f.verify[0] ?? null;
}

/**
 * The verdict the step open on a fix's page leads with, as the design's fixActions() reads it: on the
 * Verify step, the verdict it shows when that counts for the fix and was left incomplete, with what
 * settles it (Run more attempts, Verify again); else null. The header draws its step as the lime
 * button, rightmost, and its own plain.
 */
export function leadingVerdict(f: Pick<FixDetail, 'defaultStep' | 'verify' | 'defaultVerify'>, step: string | null, sub: string | null): VerifyStep | null {
  if (stepFor(f, step) !== 'verify') return null;
  const v = verifyFor(f, sub);
  return v && v.counts && v.verdict === 'incomplete' && v.more ? v : null;
}

/** Run blame again's card, on the fix's header and its Fixes row alike. */
export const blameAgainTip = (again: { kind: 'stopped' | 'unsettled'; gate: { good: number; max: number } | null }): string =>
  again.kind === 'stopped' ? 'Runs the search to the end, without the budget that stopped it' : `More attempts and a lower bar: a rescue at ${Math.round((again.gate?.good ?? 0.4) * 100)}% or more, up to ${again.gate?.max ?? 40} attempts`;

/** Run blame with stronger model's card. */
export const STRONGER_TIP = 'Another model answers from each probed call instead of the recorded one';

/**
 * The header's next step for an open fix besides Run repair, as the design's fixActions()
 * orders them: Run blame again while its blame couldn't settle where the run was lost or stopped part
 * way, Run blame with stronger model while asking the recorded model again rescued it from no call.
 * Either leads, with Run repair plain beside it; null when blame found the call.
 */
export function blameNextStep(f: Pick<FixDetail, 'status' | 'actions'>): { kind: 'again'; label: typeof ACTIONS.runBlameAgain.label; tip: string; command: string } | { kind: 'stronger'; label: typeof ACTIONS.runBlameStronger.label; tip: string; command: string } | null {
  if (f.status !== 'open') return null;
  const again = f.actions.blameAgain;
  if (again) {
    return { kind: 'again', label: ACTIONS.runBlameAgain.label, tip: blameAgainTip(again), command: again.command };
  }
  const stronger = f.actions.blameStronger;
  if (stronger) return { kind: 'stronger', label: ACTIONS.runBlameStronger.label, tip: STRONGER_TIP, command: stronger.command };
  return null;
}

/**
 * What Run more attempts or Verify again will do, after the id of the run it names, as the Verify
 * step says it under the verdict: why the run is open, then what settles it and what that takes
 * ("is inconclusive. Run more attempts verifies again from the start (verify has no --continue), up
 * to 160 a run: about 35 attempts, ≈$0.70.").
 */
export function moreLine(m: Pick<VerifyMore, 'kind' | 'run' | 'max' | 'expected' | 'cost' | 'budget'>): string {
  if (m.kind === 'again') return ` stopped at attempt ${m.run.attempt ?? '?'}, which could not be judged${m.run.why ? `: ${m.run.why}` : ''}. Verify again once it can be.`;
  // Inconclusive, the page's one word for a run its attempts left open, with why when they stopped first.
  const why = ` is inconclusive${m.run.state !== 'inconclusive' && m.run.why ? `: ${m.run.why}` : ''}.`;
  const takes = `about\u00a0${m.expected} attempt${m.expected === 1 ? '' : 's'}${m.cost !== null ? `, ${approx(m.cost)}` : ''}`;
  return `${why} Run more attempts verifies again from the start (verify has no --continue), up to ${m.max} a run${m.budget ? `, without its --budget ${m.budget}` : ''}: ${takes}.`;
}

/** What the page's main button does, if anything: repair an open fix, apply a verified one, finish an apply, or nothing. */
export type FixAction = { kind: 'repair' } | { kind: 'apply'; label: typeof ACTIONS.applyFix.label | 'Mark applied' | 'Finish applying' } | { kind: 'applied' } | { kind: 'none'; label: typeof ACTIONS.runRepair.label | typeof ACTIONS.applyFix.label; why: string };

export function fixAction(f: Pick<FixDetail, 'status' | 'actions'>): FixAction {
  if (f.status === 'open') return f.actions.repair ? { kind: 'repair' } : { kind: 'none', label: ACTIONS.runRepair.label, why: 'None of its failing runs is left in the store, so there is nothing to repair from here.' };
  const apply = f.actions.apply;
  if (!apply) return { kind: 'none', label: ACTIONS.applyFix.label, why: 'No change has been verified for it.' };
  if (f.actions.applied && !apply.pending) return { kind: 'applied' };
  // More than the one rewrite its repair verified: fix apply won't put it in, so neither does the button.
  if (apply.refused) return { kind: 'none', label: ACTIONS.applyFix.label, why: `This patch is not the change its repair verified: ${apply.refused}. Nothing applies it from here.` };
  if (f.actions.applied) return { kind: 'apply', label: 'Finish applying' };
  // Its patch is in the working tree already (merged, or applied by hand): applying only marks it applied.
  return { kind: 'apply', label: apply.kind === 'mark' || apply.inTree ? 'Mark applied' : ACTIONS.applyFix.label };
}

/**
 * The plain button an applied fix with no patch shows in place of its action, and its hover: it was
 * only marked applied, so it reads "Marked applied", and its hover names the change of request fields
 * it was verified with, which the agent makes, or says it was verified on the working tree as it was:
 * never "the patch", which it hasn't got. None for a patch, which Show patch offers to read.
 */
export function appliedButton(apply: Pick<NonNullable<FixDetail['actions']['apply']>, 'kind' | 'change'> | null): { label: 'Marked applied'; title: string } | null {
  if (apply?.kind !== 'mark') return null;
  return { label: 'Marked applied', title: apply.change ? `Verified with ${apply.change}, a change to the requests that your agent makes, not to your files` : 'Verified on your working tree as it was, and marked applied' };
}

/** A patch's lines as the dialog shows them, each line a hunk adds or removes marked; the headers are neither. */
export function patchLines(diff: string): Array<{ text: string; tone: 'add' | 'del' | null }> {
  let inHunk = false;
  return diff
    .replace(/\n$/, '')
    .split('\n')
    .map((text) => {
      if (text.startsWith('@@')) inHunk = true;
      else if (text.startsWith('diff ')) inHunk = false;
      return { text, tone: inHunk && text.startsWith('+') ? 'add' : inHunk && text.startsWith('-') ? 'del' : null };
    });
}

/**
 * Why Run repair isn't the page's lead action, or null when it is: the repair would end "No
 * fix to try" without running the agent, since the blame of every failing run rescued it from no
 * call (`noFix`, with why: no answer of the model's lost it, blame couldn't settle where, or nothing
 * rescued it). The button stays, plain, with this on hover, and its dialog says it in place of what
 * a repair that runs the agent costs.
 */
export function repairAside(f: Pick<FixDetail, 'actions'>): string | null {
  return f.actions.repair?.noFix ?? null;
}

/** What the Run repair dialog says and sends, once the fix is read again as it opens. */
export interface RepairAsk {
  /** Whether Repair can be confirmed: the fix was read, and it can still be repaired from here. */
  ready: boolean;
  /** Who is asked for candidates, in words: `anthropic (from shadowlap.config.json)`, `your own Claude Code`. */
  who: string | null;
  /** The repairer the job is sent with, which the server holds to the config. */
  repairer: string | null;
  command: string | null;
  /** Why it can't be repaired from here any more, read again. */
  why: string | null;
}

/**
 * The Run repair dialog. Who is asked for candidates (and so whose account pays) comes from
 * shadowlap.config.json, which can change while the page stays open, so the dialog reads the fix
 * again as it opens (`fresh`; null while that is out) and names the repairer it read. When the read
 * fails it names the page's, as it loaded: the job is sent with the repairer named, and the server
 * refuses one the config no longer names, so a stale name can't bill another account. A repairer
 * that can't be asked from here (claude not found) is said instead, and Repair stays off.
 */
export function repairAsk(page: FixDetail, fresh: { fix: FixDetail | null } | null): RepairAsk {
  if (!fresh) return { ready: false, who: null, repairer: null, command: page.actions.repair?.command ?? null, why: null };
  const f = fresh.fix ?? page;
  if (f.status !== 'open') return { ready: false, who: null, repairer: null, command: null, why: `It was ${f.status} meanwhile, so there is nothing left to repair.` };
  const action = fixAction(f);
  if (action.kind !== 'repair' || !f.actions.repair) return { ready: false, who: null, repairer: null, command: null, why: action.kind === 'none' ? action.why : null };
  // The repairer can't be asked from here (claude isn't on the PATH): it would blame the runs for nothing.
  if (f.repairer.problem) return { ready: false, who: null, repairer: null, command: f.actions.repair.command, why: f.repairer.problem };
  const who = f.repairer.configured ? `${f.repairer.name} (from shadowlap.config.json)` : 'your own Claude Code';
  return { ready: true, who, repairer: f.repairer.name, command: f.actions.repair.command, why: null };
}

/** A job as the working tree's lock reads it: whether it is running, and how it uses which tree. */
export interface TreeJob {
  id: string;
  done: boolean;
  /** `folder` is the folder it runs in, its project's (null or absent: the dashboard's own). */
  worktree?: { use: 'reads' | 'writes'; doing: string; folder?: string | null } | null;
}

/**
 * The jobs the lock reads: the server's list, with this tab's own on top, as they last read (they
 * show before the change feed brings the list again). A job the server no longer has (`lost`) holds
 * nothing.
 */
export function mergeTreeJobs<L extends TreeJob, W extends TreeJob>(listed: readonly L[] | null | undefined, watched: ReadonlyArray<{ job: W; lost?: boolean | undefined }>): Array<L | W> {
  const byId = new Map<string, L | W>();
  for (const j of listed ?? []) byId.set(j.id, j);
  for (const w of watched) {
    if (w.lost) byId.delete(w.job.id);
    else byId.set(w.job.id, w.job);
  }
  return [...byId.values()];
}

/** Whether two folders are one working tree, as the server tells them apart: the same, or one inside the other. Null is the dashboard's own, one with every tree. */
export function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  const trim = (p: string) => p.replace(/[\\/]+$/, '');
  const [x, y] = [trim(a), trim(b)];
  const within = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`) || inner.startsWith(`${outer}\\`);
  return within(x, y) || within(y, x);
}

/**
 * Why an action that uses the working tree of `folder` (the project's) as `use` can't start now, as
 * the server would refuse it: in that tree, a job that changes it is running, or, for one that
 * changes it, any job running the agent from it. Jobs in another project's tree don't count. `verb`
 * is what to do once it is free: "A repair is verifying candidates made from your working tree: blame once it
 * is done." Null when it can start.
 */
export function treeBusy(jobs: readonly TreeJob[], use: 'reads' | 'writes', verb: string, folder: string | null = null): string | null {
  const j = jobs.find((x) => !x.done && x.worktree && sameFolder(x.worktree.folder, folder) && (use === 'writes' || x.worktree.use === 'writes'));
  const doing = j?.worktree?.doing;
  return doing ? `${doing.charAt(0).toUpperCase()}${doing.slice(1)}: ${verb} once it is done.` : null;
}

// ---------------------------------------------------------------------------------------------- blame

const EXAMPLE_CHECK = '{"tools":{"send_email":1}}';

/** The check typed into Run blame's dialog, as the blame job takes it: a JSON object, or why it isn't one. */
export function parseCheck(text: string): { expect: Record<string, unknown> } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: `That isn’t JSON. Give an object, such as ${EXAMPLE_CHECK}.` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: `The check is an object, such as ${EXAMPLE_CHECK}.` };
  return { expect: value as Record<string, unknown> };
}

export interface CallCell {
  callNo: number;
  /** A model call (a ring) or another call (a dot); `gap` stands for calls left out. */
  kind: 'm' | 't' | 'gap';
  /** Where blame looked: rescued, lost, or the call it blamed. */
  verdict: 'rescued' | 'lost' | 'inconclusive' | 'blamed' | null;
  passes: number;
  attempts: number;
  /** Attempts that could not be judged: neither passed nor failed. */
  inconclusive: number;
  /** Outside the blame's scope. */
  dim: boolean;
  /** A model call blame's search steps through, probed or not (`BlameStep['callRow']`'s `probed`). */
  probed: boolean;
  /** Its probe's passes of the attempts judged, over the call (`3/4`); null for one no probe re-asked. */
  tally: string | null;
  /** For a gap: how many calls it stands for. */
  skipped?: number;
}

/** Calls the row shows at most before it leaves some out: past this, each would be too narrow to read. */
export const CALL_ROW_MAX = 18;

/**
 * The run's calls as the Blame step lines them up, one cell each, rings for model calls. A long run
 * keeps its model calls only (`toolsLeftOut`); a longer one only the probed calls, the model calls on
 * either side of each, and the first and last, with a gap for each stretch of model calls left out.
 */
export function callRowCells(row: BlameStep['callRow'], max = CALL_ROW_MAX): { cells: CallCell[]; toolsLeftOut: boolean } {
  const cell = (c: BlameStep['callRow'][number]): CallCell => ({ callNo: c.callNo, kind: c.kind === 'api' ? 'm' : 't', verdict: c.verdict, passes: c.passes, attempts: c.attempts, inconclusive: c.inconclusive ?? 0, dim: !c.inScope, probed: c.probed, tally: c.tally });
  if (row.length <= max) return { cells: row.map(cell), toolsLeftOut: false };
  const models = row.filter((c) => c.kind === 'api' || c.verdict !== null);
  const keep = new Set<number>();
  if (models.length <= max) for (const c of models) keep.add(c.callNo);
  else {
    const add = (i: number) => models[i] && keep.add(models[i].callNo);
    add(0);
    add(models.length - 1);
    models.forEach((c, i) => {
      if (c.verdict !== null) [i - 1, i, i + 1].forEach(add);
    });
    // Room left: fill from the start, so the row reads from the beginning.
    for (let i = 0; i < models.length && keep.size < max; i++) add(i);
  }
  const cells: CallCell[] = [];
  const gap = (callNo: number, skipped: number): CallCell => ({ callNo, kind: 'gap', verdict: null, passes: 0, attempts: 0, inconclusive: 0, dim: false, probed: false, tally: null, skipped });
  let hiddenModels = 0;
  let hidden = 0;
  for (const c of row) {
    if (!keep.has(c.callNo)) {
      hidden++;
      if (c.kind === 'api') hiddenModels++;
      continue;
    }
    if (hiddenModels) cells.push(gap(c.callNo - 0.5, hidden));
    hiddenModels = 0;
    hidden = 0;
    cells.push(cell(c));
  }
  if (hiddenModels) cells.push(gap(row.at(-1)!.callNo + 0.5, hidden));
  return { cells, toolsLeftOut: true };
}

/**
 * How a probe's verdict reads as a status: rescued in lime (the blamed one too: it rescued the run),
 * lost in red, inconclusive in amber. Amber means only that a verdict couldn't be reached; the blamed
 * call is marked apart, in ink (`probeVerdictWords`).
 */
export function probeTone(verdict: BlameStep['probes'][number]['verdict']): 'ok' | 'err' | 'warn' {
  return verdict === 'inconclusive' ? 'warn' : verdict === 'lost' ? 'err' : 'ok';
}

/** A probe's verdict word, and whether it is the blamed call, which the badge's row marks in ink: `rescued` and `blamed`. */
export function probeVerdictWords(verdict: BlameStep['probes'][number]['verdict']): { word: string; blamed: boolean } {
  return verdict === 'rescued · blamed' ? { word: 'rescued', blamed: true } : { word: verdict, blamed: false };
}

// ---------------------------------------------------------------------------------------------- repair

/** A candidate's badge: accepted in lime, rejected in red, anything else plain. */
export function candidateTone(v: CandidateVerdict): 'ok' | 'no' | 'n' {
  return v === 'accepted' ? 'ok' : v === 'rejected' || v === 'build failed' ? 'no' : 'n';
}

/**
 * Where a repair's candidates came from, as its header says it: the repairer that proposed them;
 * why none did, when one was wanted, with what to do (`the repairer could not be asked: claude was
 * not found: install Claude Code, …`); or, for a fix that needed no model, that no repairer was
 * needed. Null when nothing called for one (no failing run was rescued, the repair stopped first):
 * its why says so.
 */
export function repairBy(r: Pick<RepairStep, 'repairer' | 'served' | 'noRepairer' | 'accepted'>): { repairer: string; served: string | null } | { text: string } | null {
  if (r.repairer) return { repairer: r.repairer, served: r.served };
  if (r.noRepairer) return { text: r.noRepairer.warning ?? r.noRepairer.text };
  return r.accepted ? { text: 'no repairer needed' } : null;
}

/**
 * What a repair that accepted nothing says after where its candidates came from: how many it tried,
 * or why it found none (`interrupted`). Null when that is only the repairer's silence again, which
 * `repairBy` says.
 */
export function nothingAcceptedWhy(r: Pick<RepairStep, 'candidates' | 'why' | 'noRepairer'>): string | null {
  if (r.candidates.length) {
    const tried = r.candidates.filter((c) => c.verdict !== 'set aside' && c.verdict !== 'not tried').length;
    return `${tried} candidate${s(tried)} tried, none accepted`;
  }
  if (r.noRepairer && r.why === r.noRepairer.text) return null;
  return r.why ?? 'nothing was accepted';
}

/**
 * A repair's receipt, as the mock's Repair step gives it: how many attempts it ran (its blames' and
 * every candidate's verification), then what every stage cost, as the CLI's summary line says it:
 * blame, the repairer (or that its model has no price), the verification of every candidate it
 * tried, the accepted one's and the dropped ones', and judge checks apart: `87 attempts · cost:
 * blame ≈$0.054 · repairer ≈$0.0085 · verify ≈$0.239`. The parts, for the line to break only
 * between them.
 */
export function repairReceipt(r: Pick<RepairStep, 'attempts' | 'cost' | 'repairer' | 'served'>): string[] {
  const parts = [`${r.attempts} attempt${s(r.attempts)}`, `cost: blame ${approx(r.cost.blame)}`];
  if (r.repairer) parts.push(`repairer ${r.cost.repairer === null ? `(no price for ${r.served ?? r.repairer})` : approx(r.cost.repairer)}`);
  parts.push(`verify ${approx(r.cost.verify)}`);
  if (r.cost.judge) parts.push(`judge checks ${approx(r.cost.judge)}`);
  return parts;
}

/** The warnings the foot of the Repair step lists: all but the one its header says already (`repairBy`). */
export function footWarnings(r: Pick<RepairStep, 'warnings' | 'noRepairer' | 'repairer'>): string[] {
  const said = !r.repairer ? r.noRepairer?.warning : null;
  return said ? r.warnings.filter((w) => w !== said) : r.warnings;
}

/** The result per role, as a badge: "target 1 of 1", lime when every run held. */
export function roleBadges(roles: RepairStep['roles']): Array<{ text: string; tone: 'ok' | 'no' }> {
  return roles.map((r) => ({ text: `${r.role} ${r.held} of ${r.of}`, tone: r.held === r.of ? 'ok' : 'no' }));
}

/**
 * The change a repair made, cut to what changed: the text before it and after it in the new
 * version, the added text itself, and the old version. A long prompt keeps `context` characters on
 * each side of the change, with an ellipsis where it was cut.
 */
export function changeParts(change: NonNullable<RepairStep['change']>, context = 240): { was: string; head: string; added: string; tail: string } {
  const cut = (text: string, from: number, to: number) => `${from > 0 ? '…' : ''}${text.slice(Math.max(0, from), Math.min(text.length, to))}${to < text.length ? '…' : ''}`;
  if (!change.added) {
    const at = commonPrefix(change.before, change.after);
    return { was: cut(change.before, at - context, at + context + change.removed.length), head: cut(change.after, at - context, at + context), added: '', tail: '' };
  }
  const { at, text } = change.added;
  const end = at + text.length;
  const removedEnd = at + change.removed.length;
  return {
    was: cut(change.before, at - context, removedEnd + context),
    head: at > context ? `…${change.after.slice(at - context, at)}` : change.after.slice(0, at),
    added: text,
    tail: change.after.length - end > context ? `${change.after.slice(end, end + context)}…` : change.after.slice(end),
  };
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ---------------------------------------------------------------------------------------------- verify

/**
 * A run's outcome as a badge, in the verdicts' colours: fixed and kept in lime, broken and not fixed
 * in red, and inconclusive in amber, the colour of a run nothing has decided.
 */
export function outcomeTone(o: VerifyRow['outcome']): 'ok' | 'no' | 'y' {
  return o === 'fixed' || o === 'kept' ? 'ok' : o === 'unsettled' || o === 'inconclusive' ? 'y' : 'no';
}

/** A verdict's panel: accepted in lime, rejected in red, incomplete in amber, as inconclusive is everywhere. */
export function verdictTone(v: VerifyStep['verdict']): 'ok' | 'no' | 'warn' {
  return v === 'accepted' ? 'ok' : v === 'rejected' ? 'no' : 'warn';
}

/** Tokens per run, as a person reads them: 4,329. */
export const tokens = (n: number): string => Math.round(n).toLocaleString('en-US');

// ---------------------------------------------------------------------------------------------- the Forks view

/** The HTTP status an error from the client carries (`ApiError`), or null. */
const statusOf = (err: unknown): number | null => {
  const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : null;
};

/**
 * A run's bundles for the Forks view, asked for with `get` (`GET /api/fixes/family/:runId`): null
 * when the server doesn't know the run (404) or doesn't bundle attempts (405), and the view lists
 * the attempts as runs. A server that doesn't bundle them isn't asked again. Any other failure is
 * thrown, for the view to show.
 */
export function bundleSource(get: (runId: string) => Promise<FixBundle[]>): (runId: string) => Promise<FixBundle[] | null> {
  let unsupported = false;
  return async (runId) => {
    if (unsupported) return null;
    try {
      return await get(runId);
    } catch (err) {
      const status = statusOf(err);
      if (status === 405) unsupported = true;
      if (status === 404 || status === 405) return null;
      throw err;
    }
  };
}

/** The runs a family view leaves out because a bundle lists them: every attempt but the fork blame rescued a run with, which shows as a fork. */
export function bundledRuns(bundles: readonly FixBundle[]): Set<string> {
  const out = new Set<string>();
  for (const b of bundles) for (const a of b.attempts) if (!a.rescued) out.add(a.runId);
  return out;
}

/** An attempt's mark: none for a pass, amber for one that could not be judged (neither passed nor failed), red for a failure. */
export function attemptMark(a: { passed: boolean; verdict?: string }): 'unsure' | 'no' | undefined {
  return a.passed ? undefined : a.verdict === 'inconclusive' ? 'unsure' : 'no';
}

/**
 * A bundle's icon and the words for it: blame attempts; a verify's by how its run came out (held in
 * lime, failed in red, inconclusive in amber), or, for attempts no report names, by its verdict. A
 * verdict that doesn't count for the fix is no verdict on it, so its icon is a verify's, drawn plain
 * (`plain`), as its Verify step draws the verdict.
 */
export function bundleGlyph(b: Pick<FixBundle, 'kind' | 'verdict' | 'counts'> & { tone?: FixBundle['tone'] }): { kind: 'blame' | 'fixok' | 'fixbad' | 'warn'; label: string; plain?: true } {
  if (b.kind === 'blame') return { kind: 'blame', label: 'Blame attempts' };
  if (b.counts === false) return { kind: 'fixok', label: "Verify attempts of a verdict that doesn't count for the fix", plain: true };
  if (b.tone === 'ok') return { kind: 'fixok', label: 'Verify attempts: the run held' };
  if (b.tone === 'no') return { kind: 'fixbad', label: 'Verify attempts: the run failed' };
  if (b.tone === 'y') return { kind: 'warn', label: 'Verify attempts: inconclusive' };
  if (b.verdict === 'accepted') return { kind: 'fixok', label: 'Verify accepted the change' };
  if (b.verdict === 'rejected') return { kind: 'fixbad', label: 'Verify rejected the change' };
  return { kind: 'warn', label: 'Verify attempts: inconclusive' };
}

/**
 * The line under a bundle's title. A stored report's says its verdict as a gate's (decision 9: the
 * word, the tally and the Wilson bound) and what its attempts spent, `rescued · 2 of 2 · rate >= 0.34
 * (95%) · ≈$0.032`, its rule said once under the family; attempts no report names, "4 attempts, 2
 * passed" (those that could not be judged counted apart). A verify's then names the change it
 * checked and how that came out, as the Verify step's switch names it: `fixed · 12 of 12 · rate >=
 * 0.76 (95%) · ≈$0.046 · repair candidate 3 · accepted`, since a run kept under a change says
 * nothing of whether the change was accepted, and "· doesn't count" after one that doesn't count
 * for the fix. The verdict is a page's word for it: inconclusive for one that didn't settle every
 * run, never verify's incomplete. A revision stays with the "at" before it (`keepAt`).
 */
export function bundleLine(b: Pick<FixBundle, 'kind' | 'attempts' | 'passes' | 'spent' | 'change' | 'verdict' | 'counts'> & { verdictLine?: string | null }, money: (usd: number) => string): string {
  const change = b.kind === 'verify' && b.change ? [keepAt(b.change), ...(b.verdict ? [verdictWord(b.verdict)] : []), ...(b.counts === false ? ["doesn't count"] : [])] : [];
  if (b.verdictLine) return [b.verdictLine, ...(b.spent ? [money(b.spent)] : []), ...change].join(' · ');
  const n = b.attempts.length;
  const unsure = b.attempts.filter((a) => a.verdict === 'inconclusive').length;
  return [`${n} attempt${s(n)}, ${b.passes} passed${unsure ? `, ${unsure} inconclusive` : ''}`, ...(b.spent ? [money(b.spent)] : []), ...change].join(' · ');
}

/**
 * A change's name as the page sets it, the revision kept with the "at" before it, so a line never
 * ends on "at": "temperature=1 from each run's first model call · at dbcef5d".
 */
export function keepAt(name: string): string {
  return name.replace(/ · at (\S)/g, ' · at $1');
}

// ---------------------------------------------------------------------------------------------- report.md

export type MdBlock =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'ul'; items: string[] };

const BLOCK_START = /^(#{1,6}\s|```|\s*\||\s*[-*]\s+)/;

/** Splits a table row on its pipes, leaving `\|` inside a cell as a pipe. */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * report.md as blocks the page draws as React elements: headings, paragraphs, code fences, tables and
 * lists, which is all a repair report writes. Never HTML: the text stays text.
 */
export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ kind: 'code', lang: fence[1] ?? '', lines: body });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: 'h', level: h[1]!.length, text: h[2]!.trim() });
      i++;
      continue;
    }
    if (line.trimStart().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('|')) rows.push(cells(lines[i++]!));
      const sep = rows[1]?.every((c) => /^:?-{2,}:?$/.test(c)) ? 1 : -1;
      out.push({ kind: 'table', head: rows[0] ?? [], rows: rows.filter((_, k) => k !== 0 && k !== sep) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, ''));
      out.push({ kind: 'ul', items });
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !BLOCK_START.test(lines[i]!)) para.push(lines[i++]!.trim());
    out.push({ kind: 'p', text: para.join(' ') });
  }
  return out;
}

/** A table header of report.md as plain words, for the label a narrow panel shows above each value. */
export const plainCell = (text: string): string => text.replace(/`/g, '').trim();

/** A cell that reads as one token (a run id, a role, an outcome, a count) and so stays on one line while longer cells wrap. */
export function cellKeepsWhole(text: string): boolean {
  const t = plainCell(text);
  return t.length <= 16 && !/\s/.test(t);
}

/**
 * Text cut where JSON in a narrow cell may wrap before it has to break a word: after each `,`, `:`,
 * `(` and `{` of a long word (`issue_refund({"order_id":"A-1042",…`). Words of plain text wrap at
 * their spaces as they are.
 */
export function breakPoints(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const piece of text.split(/(\s+)/)) {
    if (piece.length <= 12 || /\s/.test(piece)) {
      cur += piece;
      continue;
    }
    const [first = '', ...rest] = piece.split(/(?<=[,:({])/);
    cur += first;
    for (const part of rest) {
      out.push(cur);
      cur = part;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Text cut where it names a command-line flag, with its placeholder when it has one (`--stronger
 * <model>`, `--repairer`), so each is set as code that keeps to one line: a flag broken after its
 * first hyphen reads as two.
 */
export function flagParts(text: string): Array<{ flag: boolean; text: string }> {
  const out: Array<{ flag: boolean; text: string }> = [];
  const re = /(^|[^\w-])(--[a-z][a-z0-9-]*(?: <[a-z][a-z0-9-]*>)?)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[1]!.length;
    if (start > at) out.push({ flag: false, text: text.slice(at, start) });
    out.push({ flag: true, text: m[2]! });
    at = start + m[2]!.length;
  }
  if (at < text.length) out.push({ flag: false, text: text.slice(at) });
  return out;
}

/** A line of report.md cut where it sets code in backticks. */
export function inlineParts(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const re = /`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ code: false, text: text.slice(at, m.index) });
    out.push({ code: true, text: m[1]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) });
  return out;
}

/**
 * How another blame of the fix came out, as the Blame step lists it after Also blamed: where it found
 * the run lost (at a call, or around or between two), inconclusive or not rescued, or stopped.
 */
export function otherBlameWords(o: FixDetail['blames'][number]): string {
  if (o.outcome === 'blamed' && o.lostAt !== null) return lostWords(o.lostAt, o.range);
  return blameStateWord(o.outcome === 'unrescuable' ? 'unrescuable' : 'stopped', o.unsettled === true);
}

// ---------------------------------------------------------------------------------------------- the job drawer

/**
 * How a blame, a repair or a fix apply ended, as the drawer's status says it, from the result the
 * command reported: "lost at #5 · exit 0" (or "lost between #7 and #9 · exit 0"), "no fix
 * found · exit 1", "applied · tests passed · exit 0".
 * A repair whose repairer was never asked (claude was not found, none is configured, it had nothing
 * to rewrite) and that tried nothing else looked for no fix: "repairer not asked", in amber. Null
 * for any other job, or a result this doesn't know, so the drawer reads the output instead.
 */
export function fixJobStatus(job: { kind?: string; code: number | null; result?: unknown }): { text: string; tone: 'ok' | 'warn' | 'err' } | null {
  const r = job.result;
  if (job.code === null || !isObject(r)) return null;
  const exit = `exit ${job.code}`;
  const tone = job.code === 0 ? 'ok' : 'err';
  if (job.kind === 'blame') {
    const blamed = isObject(r.blamed) && typeof r.blamed.callNo === 'number' ? r.blamed.callNo : null;
    // At the call it names, or around or between two when no one call is pinned.
    if (r.outcome === 'blamed' && blamed !== null) return { text: `${lostWords(blamed, r.range)} · ${exit}`, tone };
    if (r.outcome === 'unrescuable') {
      // Its first probe couldn't tell, and nothing else was found (blame's unsettledFirst): inconclusive, never "not rescued".
      const first = Array.isArray(r.probes) && isObject(r.probes[0]) ? r.probes[0] : null;
      const unsettled = first?.decision === 'inconclusive' && !r.sameAnswer && !r.failedWrite;
      return { text: `${blameStateWord('unrescuable', unsettled)} · ${exit}`, tone: job.code === 0 ? 'warn' : 'err' };
    }
    if (r.outcome === 'stopped') return { text: `${blameStateWord('stopped', false)} · ${exit}`, tone: 'warn' };
    return null;
  }
  if (job.kind === 'repair') {
    // The words the CLI says a repair's end in (`repairOutcomeWord`), but for what only a job's line tells.
    if (r.outcome === 'fixed') return { text: `${repairOutcomeWord('fixed')}${isObject(r.error) ? ', not handed over' : ''} · ${exit}`, tone };
    if (r.outcome === 'not-fixed') {
      const unasked = typeof r.noRepairer === 'string' && r.noRepairer.trim() !== '' && !(Array.isArray(r.candidates) && r.candidates.length);
      return unasked ? { text: `repairer not asked · ${exit}`, tone: 'warn' } : { text: `no fix found · ${exit}`, tone: 'err' };
    }
    if (r.outcome === 'no-diagnosis') return { text: `${repairOutcomeWord('no-diagnosis')} · ${exit}`, tone: 'warn' };
    if (r.outcome === 'stopped') return { text: `${repairOutcomeWord('stopped')} · ${exit}`, tone: 'warn' };
    return null;
  }
  if (job.kind === 'apply') {
    if (r.status === 'already-applied') return { text: `applied already · ${exit}`, tone };
    if (r.status !== 'applied') return null;
    const outdated = outdatedOf(r).length;
    const left = outdated ? ` · ${outdated} golden${outdated === 1 ? '' : 's'} to update` : '';
    return { text: `applied${r.tests === 'passed' || r.tests === 'failed' ? ` · tests ${r.tests}` : ''}${left} · ${exit}`, tone: r.tests === 'failed' ? 'err' : outdated && tone === 'ok' ? 'warn' : tone };
  }
  return null;
}

/** One of the project's other goldens a fix's patch made diverge, as `fix apply --json` lists it. */
export interface OutdatedGolden {
  golden: string;
  callNo: number;
  path: string;
}

/** The goldens a fix apply's result lists as diverging on what its patch changed (`outdated`), well formed only. */
export function outdatedOf(result: unknown): OutdatedGolden[] {
  const list = isObject(result) && Array.isArray(result.outdated) ? result.outdated : [];
  return list.filter((g): g is OutdatedGolden => isObject(g) && typeof g.golden === 'string' && g.golden !== '' && typeof g.callNo === 'number' && typeof g.path === 'string');
}

