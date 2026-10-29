import { commitTitle, eachRun, noRepairerOf, patchFiles, repairMarkdown, verdictCounts, type FixRecords, type RepairCandidate, type RepairOutcome, type StoreOf, type StoredRepair, unrescuedWords } from '@shadowlap/engine';
import { acceptedCandidate, fixHref, repairerLabel, ROLE, s, sprtGate } from './fix-shared.js';

/** A fix's Repair step: the change repair proposed, every candidate it tried, and why each was kept or dropped. */

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
