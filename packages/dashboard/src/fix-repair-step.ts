import { commitTitle, eachRun, fixVerifyHead, noRepairerOf, patchFiles, repairMarkdown, repairOutcomeWord, targetWhere, verdictCounts, type FixRecords, type RepairCandidate, type RepairOutcome, type RepairReport, type StoreOf, type StoredRepair, unrescuedWords } from '@shadowlap/engine';
import { repairSpent } from './fix-lead.js';
import { acceptedCandidate, fixHref, repairerLabel, ROLE, runHref, s, short, sprtGate, type StepLine } from './fix-shared.js';
import { verdictHeadline } from './fix-verify-step.js';

/** A fix's Repair step: the change repair proposed, every candidate it tried, and why each was kept or dropped. */

export type CandidateVerdict = 'accepted' | 'rejected' | 'set aside' | 'not tried' | 'build failed' | 'unsettled';

export interface RepairStep {
  repairId: string;
  at: number;
  /** Its files, relative to the project folder: `.shadowlap/repairs/<id>`. */
  dir: string;
  outcome: RepairOutcome;
  accepted: boolean;
  /** The accepted change in a few words (the commit title), or "No change yet". */
  title: string;
  /**
   * Its verdict line: `accepted` in lime, headed by its verdict's heading (`fixVerifyHead`), as the
   * Verify step heads the same verdict. One that accepted nothing: `rejected` in red where the gate
   * rejected the candidates it tried, else the engine's outcome word (`not fixed` red, `no fix to
   * try` and `stopped` amber), headed by why (`report.why`) and saying what is left to do.
   */
  line: StepLine;
  /** How the accepted change was checked beyond its rule: `verified twice, the second time with fresh attempts`; null for one that accepted nothing. */
  again: string | null;
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
  /**
   * How each run was decided: `each at 4 of 5 attempts`, or `each by its gate, which tells 90%+ from
   * 70%- at <= 5% risk`, with the good runs' baseline rule after it when they were kept against one
   * (verify's `eachRun`): the accepted candidate's verification, or for a repair that accepted
   * nothing the first candidate's that ran one; null when none did.
   */
  rule: string | null;
  /** Where each failing run was lost, from its blame. */
  lost: Array<{ runId: string; at: string; href: string }>;
  diagnosis: string | null;
  candidates: Array<{ id: number; text: string; surface: string; file: string; source: 'repairer' | 'model'; verdict: CandidateVerdict; why: string }>;
  /**
   * The runs the candidates' whys name, by the short id they say them in (`target run 01M3RZ4XKN
   * not fixed: 0 of 3 passed`): each a link to its run, with its about line on hover, which only the
   * fix's pooled read fills (`withAbouts`), null elsewhere.
   */
  named: Array<{ id: string; runId: string; href: string; about: string | null }>;
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

/** The runs the candidates' whys name (`RepairStep['named']`): any failing run it blamed or run a candidate was verified on, the first of any two that share a short id. */
function namedRuns(rep: RepairReport, whys: readonly string[]): RepairStep['named'] {
  const text = whys.join('\n');
  const named = new Map<string, string>();
  for (const runId of [...rep.targets.map((t) => t.runId), ...rep.candidates.flatMap((c) => c.verify?.runs.map((x) => x.runId) ?? [])]) {
    const id = short(runId);
    if (!named.has(id) && text.includes(id)) named.set(id, runId);
  }
  return [...named].map(([id, runId]) => ({ id, runId, href: runHref(runId), about: null }));
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
function repairAttempts(store: StoreOf<'fixes'>, r: StoredRepair): number {
  const verify = r.report.candidates.reduce((n, c) => n + (c.verify?.attempts ?? 0), 0);
  const blame = r.report.targets.reduce((n, t) => {
    // A run that passed, or that blame couldn't run on, left no blame to count.
    if (t.reused || (t.outcome !== 'blamed' && t.outcome !== 'unrescuable' && t.outcome !== 'stopped')) return n;
    const kept = store.blamesOfRun(t.runId).filter((b) => b.at <= r.at).at(-1);
    return n + (kept?.report.attempts ?? 0);
  }, 0);
  return verify + blame;
}

/** How the repair's gate decided each run (`RepairStep['rule']`), said once: the accepted candidate's verification, else the first candidate's that ran one, as it ran on every candidate it tried. */
function repairRule(candidates: readonly RepairCandidate[], v: RepairCandidate['verify'] | null): string | null {
  const ruled = v ?? candidates.find((x) => x.verify)?.verify ?? null;
  return ruled ? eachRun({ ...ruled, gate: sprtGate(ruled.gate) }) : null;
}

/** The accepted change's result per role (`RepairStep['roles']`): target 1 of 1. */
function rolesOf(runs: ReadonlyArray<{ role: 'target' | 'holdout' | 'good'; verdict: string }>): RepairStep['roles'] {
  return (['target', 'holdout', 'good'] as const).flatMap((role) => {
    const of = runs.filter((x) => x.role === role);
    return of.length ? [{ role: ROLE[role], held: of.filter((x) => x.verdict === 'pass').length, of: of.length }] : [];
  });
}

/**
 * A repair's verdict line (`RepairStep['line']`): one that accepted nothing never says repaired.
 * Its finding says what is left: each candidate and why it was dropped, and, once a repair would
 * only try the same again (`repairSpent`), to change the prompt by hand.
 */
function repairLine(rec: FixRecords, r: StoredRepair, why: string | null): StepLine {
  const c = acceptedCandidate(r);
  if (c) {
    const verdict = rec.verdicts.find((x) => x.repairId === r.repairId);
    const head = verdict ? verdictHeadline(rec, verdict) : c.verify ? fixVerifyHead('accepted', c.verify.runs, rec.failing) : commitTitle(c);
    return { word: 'accepted', tone: 'ok', head: [head], finding: null };
  }
  const rejected = r.outcome === 'not-fixed' && r.report.candidates.some((x) => x.state === 'rejected');
  const spent = repairSpent(rec) && rec.repairs.at(-1)?.repairId === r.repairId;
  const next = spent ? 'Repairing again would try the same: change the prompt yourself and verify it.' : 'Repair again, or verify a fix of your own.';
  const text = why ?? 'No candidate was accepted';
  return {
    word: rejected ? 'rejected' : repairOutcomeWord(r.outcome),
    tone: r.outcome === 'no-diagnosis' || r.outcome === 'stopped' ? 'warn' : 'err',
    head: [text.charAt(0).toUpperCase() + text.slice(1)],
    finding: r.report.candidates.length ? `The fix stays open, with each candidate and why it was dropped. ${next}` : 'The fix stays open. Repair again, or verify a fix of your own.',
  };
}

/**
 * A repair as the Repair step shows it. A teammate's (`pulled`) shows `fallback`, the fix's own
 * repair command, in place of the command line it ran on their machine, which is never offered to
 * copy.
 */
export function repairStep(store: StoreOf<'fixes'>, rec: FixRecords, r: StoredRepair, fixId: string, pulled: boolean, fallback: string): RepairStep {
  const rep = r.report;
  const c = acceptedCandidate(r);
  const v = c?.verify ?? null;
  const verdict = rec.verdicts.find((x) => x.repairId === r.repairId) ?? null;
  const dir = r.dir.replace(/\/+$/, '');
  const goldens = rep.output.goldens.length;
  const none = noRepairerOf(rep);
  // A report kept before it said why no repairer proposed anything only says there was nothing to try: that is why.
  const why = none && !rep.candidates.length && rep.why === 'there was no candidate to try' ? none.text : rep.why;
  const candidates = rep.candidates.map((x) => ({ id: x.id, text: x.after, surface: x.surface, file: x.file, source: x.source, ...candidateVerdict(x, r) }));
  return {
    repairId: r.repairId,
    at: r.at,
    dir,
    outcome: r.outcome,
    accepted: r.accepted,
    title: c ? commitTitle(c) : 'No change yet',
    line: repairLine(rec, r, why),
    again: v ? 'verified twice, the second time with fresh attempts' : null,
    why: c ? null : why,
    repairer: repairerLabel(r),
    noRepairer: none,
    served: rep.repairer?.served && rep.repairer.served !== rep.repairer.model ? rep.repairer.served : null,
    verify: v ? { verifyId: verdict?.verifyId ?? null, attempts: v.attempts, spent: v.spent, counts: verdict ? verdictCounts(rec, verdict) : false } : null,
    change: c ? { file: c.file, anchor: c.surface, before: c.before, after: c.after, ...addedText(c.before, c.after) } : null,
    roles: v ? rolesOf(v.runs) : [],
    needed: v?.needed ?? null,
    attemptsPerRun: v?.attemptsPerRun ?? null,
    rule: repairRule(rep.candidates, v),
    lost: rep.targets.map((t) => ({
      runId: t.runId,
      // As repair's report and its pull request say it: at a model call, or gradually around (or between) two.
      at: t.outcome === 'blamed' && t.callNo !== null ? `${targetWhere(t)}${t.rescuedBy ? `, rescued by ${t.rescuedBy}` : ''}` : t.outcome === 'unrescuable' ? unrescuedWords(t.unsettled === true) : (t.note ?? t.outcome),
      href: fixHref(fixId, 'blame'),
    })),
    diagnosis: rep.diagnosis,
    candidates,
    named: namedRuns(rep, candidates.map((x) => x.why)),
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
