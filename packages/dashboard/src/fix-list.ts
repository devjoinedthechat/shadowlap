import { blameStateWord, commitTitle, fixCost, fixLabelInfo, type FixRecords, fixRecords, type FixStatus, formatUsd, JUDGE_READS, judgeLabel, lostWords, madeUnderOldCheck, noRepairerOf, outcomeOf, parseExpect, type RepairCandidate, shownBlame, type StoredFix, type StoredRepair, type StoreOf, unrescuedHead, unsettledFirst } from '@shadowlap/engine';
import { acceptedCandidate, acceptedVerdict, brokenOf, counting, fixHref, notVerified, repairCounts, repairerLabel, s, shownRepair, type StepKey } from './fix-shared.js';

/** The Fixes list: a row for each fix, the most recently opened first, with its status, its failing runs and how far blame, repair and verify got. */

/**
 * Done, to do, (Verify only) rejected, or `warn`: a step that ran and needs a look, in amber, never
 * the grey of one not run yet: a blame no model call rescued ("not rescued"), one whose first probe
 * couldn't tell ("inconclusive") or stopped part way ("stopped"), a verify left inconclusive or
 * stopped before every run settled ("inconclusive"), one word for each state on every page. Repair
 * is done with the change repair made, or with one made by hand that a verdict checked ("by hand").
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
  /** Its check's first judge, as the Must line's card says it (`judgeOf`), or null: a check with no judge, or one that doesn't parse. */
  judge: FixJudge | null;
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

/** A judge of a fix's check: its label, the question it asks, what it reads and the model asked. */
export interface FixJudge {
  label: string;
  question: string;
  reads: string;
  model: string;
}

export interface FixList {
  fixes: FixRow[];
  /** For the filter chips: Verified counts applied fixes too. */
  counts: { all: number; open: number; verified: number };
}

const approx = (usd: number) => `≈${formatUsd(usd)}`;

/** What kind of change a candidate is, in two words: repair's result is a change, a fix the failure worked through. */
function changeKind(c: RepairCandidate): string {
  if (c.source === 'model' || c.surface === 'model') return 'model switch';
  if (c.surface.startsWith('tool ')) return 'tool change';
  return 'prompt change';
}

/** "from CI", "from CI · PR #138", "PR #138". A pull request's state shows once it is known to be merged or closed. */
function sourceText(fix: StoredFix): string | null {
  const src = fix.data.source;
  if (!src) return null;
  const pr = src.pr ? `PR ${src.pr.number !== null ? `#${src.pr.number}` : src.pr.url}${src.pr.state && src.pr.state !== 'open' ? ` ${src.pr.state}` : ''}` : '';
  if (src.ci) return pr ? `from CI · ${pr}` : 'from CI';
  return pr || null;
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

/**
 * The Blame step, or, once the fix's check changed after its blame ran, the old check's: in amber,
 * the step it was, and that blame again searches under the fix's check (madeUnderOldCheck, by key).
 */
function blameStepOf(rec: FixRecords): FixStep {
  const st = blameStepUnder(rec);
  const b = shownBlame(rec);
  return b && madeUnderOldCheck(rec, b) ? { key: 'blame', n: '01', state: 'warn', short: 'old check', title: 'Found under the old check', meta: `${st.short} · blame again under this one` } : st;
}

function blameStepUnder(rec: FixRecords): FixStep {
  const b = shownBlame(rec);
  if (!b) return { key: 'blame', n: '01', state: 'todo', short: 'not blamed', title: 'Not blamed yet', meta: 'find the call that lost the run' };
  const r = b.report;
  const cost = `${r.attempts} attempt${s(r.attempts)} · ${approx(r.spent)}`;
  // At the call blame names, or around or between two when no one call is pinned.
  if (b.outcome === 'blamed' && r.blamed) return { key: 'blame', n: '01', state: 'done', short: lostWords(r.blamed.callNo, r.range), title: lostWords(r.blamed.callNo, r.range, 'title'), meta: `confidence ${r.confidence} · ${cost}` };
  // Its first probe couldn't tell: inconclusive at the first model call, never a finding that no call rescues the run.
  // Not rescued from any model call only where blame's bound bears it out; else from the first, as blame's report heads it.
  if (b.outcome === 'unrescuable') return { key: 'blame', n: '01', state: 'warn', short: blameStateWord('unrescuable', unsettledFirst(r)), title: unrescuedHead(r).replace(/^\S+ /, ''), meta: cost };
  return { key: 'blame', n: '01', state: 'warn', short: blameStateWord('stopped', false), title: 'Stopped before the search finished', meta: r.stopReason ?? cost };
}

/** Why a repair's change doesn't count for the fix, after its meta: verified under the fix's old check, or under another; nothing when it counts. */
function uncountedRepair(rec: FixRecords, p: StoredRepair): string {
  if (repairCounts(rec, p)) return '';
  const old = rec.verdicts.some((v) => v.repairId === p.repairId && rec.standing.get(v.verifyId)?.why === 'old-check');
  return old ? ' · verified under its old check' : ' · verified under another check';
}

/** A change made by hand, which verify checked: Repair says so (`by hand`), beside what a repair that ran left, if one did. */
const byHand = (meta: string): FixStep => ({ key: 'repair', n: '02', state: 'done', short: 'by hand', title: 'Changed by hand', meta });

/**
 * The Repair step: the change repair made, or, with none, a change made by hand that a verdict that
 * counts checked (its verdict names no repair): with no repair run, any such verdict; after a repair
 * that made none, the accepted one, beside what that repair left. Else no change yet.
 */
function repairStepOf(rec: FixRecords): FixStep {
  const p = shownRepair(rec);
  const c = p && acceptedCandidate(p);
  if (p && c) {
    const n = p.report.candidates.length;
    const by = repairerLabel(p);
    return { key: 'repair', n: '02', state: 'done', short: changeKind(c), title: commitTitle(c), meta: `candidate ${p.report.candidates.indexOf(c) + 1} of ${n} · ${by ? `proposed by ${by}` : (noRepairerOf(p.report)?.text ?? 'no repairer needed')}${uncountedRepair(rec, p)}` };
  }
  if (!p) return counting(rec).some((v) => v.repairId === null) ? byHand('verify checks it; repair hasn’t run') : { key: 'repair', n: '02', state: 'todo', short: 'no change yet', title: 'No change yet', meta: 'repair proposes a prompt change' };
  const tried = p.report.candidates.filter((x) => x.state !== 'invalid' && x.state !== 'untried').length;
  // A repairer that proposed nothing is why, more than "there was no candidate to try".
  const none = noRepairerOf(p.report)?.text;
  const meta = p.report.candidates.length ? `${tried} candidate${s(tried)} tried, none accepted${none ? ` · ${none}` : ''}` : (none ?? p.report.why ?? 'the repair found nothing to try');
  return acceptedVerdict(rec)?.repairId === null ? byHand(meta) : { key: 'repair', n: '02', state: 'todo', short: 'no change yet', title: 'No change yet', meta };
}

/** The Verify step's meta when its newest verdict doesn't count, by why. */
const UNCOUNTED_META: Partial<Record<string, string>> = {
  'another-check': 'verified only under another check',
  'old-check': 'verified only under its old check',
  'already-passing': 'verified only on runs that already passed',
};

function verifyStepOf(rec: FixRecords): FixStep {
  const v = acceptedVerdict(rec);
  const rejected = counting(rec).filter((x) => x.verdict === 'rejected');
  if (v) {
    const held = fixedKept(rec);
    const left = notVerified(rec).length;
    const earlier = rejected.filter((x) => x.at < v.at).length;
    const later = rejected.filter((x) => x.at > v.at).length;
    const meta = [earlier ? `${earlier} earlier change${s(earlier)} rejected` : left ? `${left} failing run${s(left)} not verified` : held.kept ? 'every failing run fixed, every good run kept' : 'every failing run fixed', ...(later ? [`${later} later change${s(later)} rejected`] : [])].join(' · ');
    return { key: 'verify', n: '03', state: 'done', short: held.text, title: held.text, meta };
  }
  if (rejected.length) return { key: 'verify', n: '03', state: 'no', short: 'rejected', title: 'Rejected', meta: `${rejected.length} change${s(rejected.length)} rejected` };
  if (counting(rec).length) {
    // A run it took is inconclusive (its gate ran out of attempts, or an attempt could not be judged), or the verify stopped first.
    const unsure = counting(rec).some((x) => x.report.runs.some((run) => outcomeOf(run) === 'inconclusive'));
    return { key: 'verify', n: '03', state: 'warn', short: 'inconclusive', title: 'Inconclusive', meta: unsure ? 'a run it verified is inconclusive' : 'a verify stopped before every run settled' };
  }
  if (rec.verdicts.length) {
    const why = rec.standing.get(rec.verdicts.at(-1)!.verifyId)?.why;
    return { key: 'verify', n: '03', state: 'todo', short: 'not verified', title: 'Not verified yet', meta: (why && UNCOUNTED_META[why]) ?? 'no verdict on its runs yet' };
  }
  return { key: 'verify', n: '03', state: 'todo', short: 'not verified', title: 'Not verified yet', meta: 'checks a fix before it ships' };
}

/** A fix's three steps, as its stepper, its row on Fixes and its row on Needs a look say them. */
const stepsOf = (rec: FixRecords): FixStep[] => [blameStepOf(rec), repairStepOf(rec), verifyStepOf(rec)];

/**
 * What changed on a fix and what verify made of it, as Needs a look words an open fix after where
 * blame left it, from the Repair and Verify steps its row on Fixes shows: the accepted change's kind
 * (`prompt change, not verified yet`), or `changed by hand` where Repair says `by hand` (a change
 * made by hand, then verified with `verify --fix`), then `, verify inconclusive` or `, verify
 * rejected it` from the Verify step's state. Null where nothing changed yet.
 */
export function changeWords(rec: FixRecords, steps: readonly FixStep[] = stepsOf(rec)): string | null {
  const [, repair, verify] = steps;
  if (repair?.state !== 'done') return null;
  const verdict = verify?.state === 'warn' ? ', verify inconclusive' : verify?.state === 'no' ? ', verify rejected it' : verify?.state === 'todo' ? ', not verified yet' : '';
  return `${repair.short === 'by hand' ? 'changed by hand' : repair.short}${verdict}`;
}

/**
 * The title each fix was opened with, by fix id: what its failing run did, as blame titled the fix
 * when it opened it (`blame.done`, `opened`). Read once per answer, and only once a fix was renamed.
 */
export function openingTitles(store: StoreOf<'activity'>): () => ReadonlyMap<string, string> {
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

/** The first judge of a check, or null: none, or a check that doesn't parse, which a pulled one may not (a teammate's store can hold anything). */
export function judgeOf(expect: unknown): FixJudge | null {
  let j;
  try {
    j = expect === null ? undefined : parseExpect(expect, 'expect').judge?.[0];
  } catch {
    return null;
  }
  return j ? { label: judgeLabel(j), question: j.question, reads: JUDGE_READS.find(([of]) => of === j.of)?.[1] ?? j.of, model: j.model } : null;
}

export function rowOf(store: StoreOf<'recording' | 'activity' | 'fixes'>, rec: FixRecords, opening: () => ReadonlyMap<string, string> = openingTitles(store)): FixRow {
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
    judge: judgeOf(f.check.expect),
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

/** Every fix, the most recently opened first, with the counts for the filter chips. */
export function fixList(store: StoreOf<'recording' | 'activity' | 'fixes'>, options: { status?: FixStatus | 'all' } = {}): FixList {
  const opening = openingTitles(store);
  const all = store.listFixes().map((f) => rowOf(store, fixRecords(store, f), opening));
  const open = all.filter((f) => f.status === 'open').length;
  const fixes = !options.status || options.status === 'all' ? all : all.filter((f) => (options.status === 'verified' ? f.status !== 'open' : f.status === options.status));
  return { fixes, counts: { all: all.length, open, verified: all.length - open } };
}
