import { byRule, CLEARED, decisionsHeadline, decisionsMoved, emptyCounts, endToEndWords, JUDGED_LATER, percentChange, plural, RANK_LABELS, runOutcomeWord, stepsAsked, tallyWords, verdictWord, verifiedCount, verifyHead, type DecisionCounts, type DecisionRun, type DecisionsHeadline, type DecisionsReport, type DecisionsVerify, type RunAbout, type Store } from '@shadowlap/engine';
import { LATER_STEPS, type DecisionCell, type DecisionRow } from './decision-cells.js';
import { decisionSession, sessionReport } from './decisions.js';
import { answer, failed, type ReadAnswer, type ReadTable } from './read-registry.js';
import { aboutsWithin } from './run-about.js';
import { loadRunIndex } from './run-index.js';
import { ROW_CALLS_BUDGET } from './runs-list.js';
import { previewVerdictOf, type PreviewVerdict } from './verdicts.js';

/**
 * One kept session as Changes' Preview shows it, worded here from the engine's words, since a page
 * can't load the engine's decisions module: its verdict in Verdicts' words, the headline, the steps
 * it asked, verify's verdict and the runs it ran end to end, the next step's facts, the key's counts,
 * the receipt's figures, and each row's about line and what verify found of it. A pooled read
 * (`decision-session`): a session's runs hold every step's two decisions, and the about lines read
 * their requests.
 */

/** What a row of the matrix holds besides its cells: its run's about line, whether the store still has it, what verify found of it. */
export interface PreviewRowFacts {
  about: RunAbout | null;
  /** Sessions outlive the runs they name (`gc` leaves them): a run no longer in the store has no page to open. */
  inStore: boolean;
  /** Whether the session left it to verify (`toVerify`, else flagged). */
  toVerify: boolean;
  /** Verify took it: its outcome, and its tally and bound (` · 4 of 4 · rate >= 0.6 (95%)`). */
  verified: { outcome: string; tally: string } | null;
  /** Verify ran, and the preview cleared it: not run end to end (`view.cleared` says why). */
  cleared: boolean;
  /** The run it was forked from and the call it forked at, where the change's turn is told from the parent's. */
  parent: string | null;
  forkAt: number | null;
}

/** Verify's verdict, once it ran: its word, its head, each rule once over its runs, what it says of them, and the runs it ran end to end. */
export interface PreviewVerify {
  word: 'accepted' | 'rejected' | 'inconclusive';
  head: string;
  rules: Array<{ rule: string | null; runs: string[] }>;
  reasons: string[];
  warnings: string[];
  /** `2 of 7 runs verified end to end`. */
  count: string;
  /** What the runs verified cost a run end to end: `4,000 → 5,000 input tokens (+25%) · ≈$0.014 → ≈$0.018 (+29%)`; null when no attempt showed it. */
  endToEnd: string | null;
}

/** What the next step is picked from (ui/decisions.ts): the runs left to verify, the runs verify left open, a switch to migrate to. */
export interface PreviewNext {
  /** The runs it could not clear that no verify has taken; `every`, when that is all of them; `gone`, how many left the store. */
  verify: { runs: string[]; every: boolean; gone: number } | null;
  /** The runs verify took and left inconclusive, once none is left to verify. */
  more: string[];
  /** A model switch it can migrate to: the model, the recorded models it switches from, and its goldens and runs. */
  migrate: { to: string; from: string[]; goldens: string[]; runs: string[] } | null;
}

/** The key's counts: steps by rank, the rest, and the cells a judge waits on or whose samples differ. */
export interface PreviewCounts {
  writes: number;
  stops: number;
  reads: number;
  text: number;
  same: number;
  left: number;
  notAsked: number;
  noise: number;
  waits: number;
  split: number;
}

/** What asking cost, for the receipt: per run before and after and how far it moved, what asking and judging spent, the requests. */
export interface PreviewReceipt {
  perRun: { before: number; after: number; change: string } | null;
  spent: number;
  requests: number;
  unknownModels: string[];
  judge: { requests: number; spent: number; unknownModels: string[] } | null;
  stopReason: string | null;
}

/** A key's entry: its count, its words, the cells' colour it counts, and its card, the rule it stands on. */
export interface PreviewKeyEntry {
  n: number;
  words: string;
  /** `w` a write, `s` a stop, `r` a read, `m` the same, `un` left as recorded, `jw` waits on a judge, `na` not asked, `spl` split. */
  sw: 'w' | 's' | 'r' | 'm' | 'un' | 'jw' | 'na' | 'spl';
  card: { title: string; text: string | null; rows: Array<[string, string]> };
}

export interface PreviewView {
  name: string;
  /** The change in words, as the session kept it (`the model claude-haiku-4-5`), for the ask's lead. */
  change: string;
  /** What an opened cell names the changed side by: its model, the working tree's prompt for `--from-code`, else the change. */
  side: string;
  /** The command that made it, to copy. */
  command: string;
  samples: number;
  unit: 'golden' | 'run';
  /** Verdicts' verdict for it: its word and tone, the line under it, the runs left to verify, what flags them and what moved. */
  verdict: Pick<PreviewVerdict, 'word' | 'tone' | 'line' | 'toVerify' | 'flaggedRank' | 'moved'>;
  headline: DecisionsHeadline;
  /** `56 steps asked, 3 samples each and as many as recorded`; `once`, each step asked once; what the line says after it (`4 not asked`, `no tool ran`); the report's notes, on its card. */
  steps: { text: string; once: boolean; tail: string[]; notes: string[] };
  /** The later steps in a few words, its card's title and sentence; null when no step was asked. */
  later: { text: string; title: string; card: string } | null;
  /** The runs a write, stop or judged change shows in that doesn't flag them, on a line of their own. */
  within: string | null;
  verify: PreviewVerify | null;
  next: PreviewNext;
  counts: PreviewCounts;
  /** The key's entries: the ranked counts, then the quieter ones. */
  key: { main: PreviewKeyEntry[]; quiet: PreviewKeyEntry[] };
  /** What couldn't be asked or judged, the report's and each run's, once each. */
  warnings: string[];
  receipt: PreviewReceipt;
  /** What a run the preview cleared rests on, once verify ran. */
  cleared: string;
  /** Whether the project has redaction rules: an opened cell's cost says its values are masked by them. */
  redacted: boolean;
}

export type PreviewSession = Record<string, unknown> & { sessionId: string; kind: 'decisions' | 'migrate'; matrix: Array<DecisionRow & PreviewRowFacts>; view: PreviewView };

/** A band's colour by its rank, as a cell draws it: a write, a stop, a read, else the same or words. */
const band = (r: number) => (r === 1 ? 'w' : r === 2 ? 's' : r === 3 || r === 4 ? 'r' : 'm');
/** Whether a cell is drawn split: its samples' colours differ. */
const split = (c: DecisionCell) => c.rank !== null && c.ranks.length > 1 && c.ranks.some((r) => band(r) !== band(c.ranks[0]!));

/**
 * The runs whose cells show a write, stop or judged change that doesn't flag them, counted on a line
 * of their own under the verdict, so the red and amber bands in their cells read with it: within
 * the model's own variation, with the control (`2 more runs change a write within the model's own
 * variation`); else in fewer than half their samples (`1 run changes when to stop in 1 of 2 samples,
 * not flagged`). Null asked once, or for none.
 */
export function withinLine(r: Pick<DecisionsReport, 'samples' | 'flagged'> & { runs: readonly DecisionRun[] }): string | null {
  const steps = r.runs.filter((x) => !r.flagged.includes(x.runId) && !x.refused).map((x) => x.decisions.filter((s) => (s.rank === null ? s.control && s.sampled && s.sampled <= 2 : s.rank <= 2 && !(s.majority !== null && s.majority <= 2))));
  const counted = steps.filter((x) => x.length);
  if (!counted.length || r.samples < 2) return null;
  const kinds = new Set(counted.flat().map((s) => { const k = s.changes[0]?.kind ?? ''; return k.startsWith('write') ? 'w' : k === 'judge' ? 'j' : 's'; }));
  const one = counted.length === 1;
  const acts = kinds.has('w') || kinds.has('s') ? `${one ? 'changes' : 'change'} ${kinds.has('w') && kinds.has('s') ? 'a write or when to stop' : kinds.has('w') ? 'a write' : 'when to stop'}` : '';
  const what = `${acts}${kinds.has('j') ? `${acts ? ', or ' : ''}${one ? 'is' : 'are'} judged otherwise` : ''}`;
  const runs = `${plural(counted.length, r.flagged.length ? 'more run' : 'run')} ${what}`;
  if (counted.flat().some((s) => s.control)) return `${runs} within the model's own variation`;
  const often = [...new Set(counted.flat().map((s) => s.samples.changed))];
  return `${runs} in ${often.length === 1 ? `${often[0]!} of ${r.samples}` : 'fewer than half their'} samples, not flagged`;
}

/** Verify's verdict, once it ran on the session's runs. */
function verifyView(v: DecisionsVerify, runs: readonly DecisionRun[]): PreviewVerify {
  const taken = new Set(v.runs.map((x) => x.runId));
  return {
    word: verdictWord(v.verdict as 'accepted' | 'rejected' | 'incomplete'),
    head: verifyHead(v.verdict as 'accepted' | 'rejected' | 'incomplete', v.runs),
    rules: byRule(v.runs, (x) => x.rule, v.rule ?? null).map((g) => ({ rule: g.rule, runs: g.runs.map((x) => x.runId) })),
    reasons: v.reasons,
    warnings: v.warnings ?? [],
    count: verifiedCount(runs.map((x) => ({ verified: taken.has(x.runId) }))),
    endToEnd: v.footprint ? endToEndWords(v.footprint) : null,
  };
}

/** What the next step is picked from. */
function nextFacts(store: Store, kind: 'decisions' | 'migrate', report: PreviewReport, v: DecisionsVerify | null, o: { asked: boolean; word: PreviewVerdict['word'] }): PreviewNext {
  const toVerify = report.toVerify ?? report.flagged;
  const taken = new Set(v?.runs.map((x) => x.runId) ?? []);
  const left = toVerify.filter((id) => !taken.has(id));
  const more = left.length ? [] : (v?.runs ?? []).filter((x) => runOutcomeWord(x.outcome) === 'inconclusive').map((x) => x.runId);
  const change = report.change;
  // Settled as Verdicts says it: accepted with none left, or nothing to verify (not a preview that stopped short).
  const settled = o.word === 'accepted' || o.word === 'nothing to verify';
  const waits = (report.judge?.inconclusive ?? 0) > 0;
  const migrate =
    kind === 'decisions' && change?.model && !change.fromCode && o.asked && !waits && settled
      ? { to: change.model, from: change.from ?? [], goldens: report.runs.flatMap((x) => (x.golden ? [x.golden] : [])), runs: report.runs.flatMap((x) => (x.golden ? [] : [x.runId])) }
      : null;
  return { verify: left.length ? { runs: left, every: left.length === toVerify.length, gone: left.filter((id) => !store.getRun(id)).length } : null, more, migrate };
}

/** A kept note that says what a key's entry stands on, found by its words: the report's notes are sentences. */
const noteOf = (notes: readonly string[], re: RegExp): string | null => notes.find((x) => re.test(x)) ?? null;
const movedWords = (part: Partial<Pick<DecisionCounts, '1' | '2' | '3'>>): string => (decisionsMoved({ 1: 0, 2: 0, 3: 0, 4: 0, ...part })[0] ?? '').replace(/^\d+ /, '');

/**
 * The key's entries, in the words Verdicts' What moved says a rank in (`2 writes changed`, `1 stop
 * changed`), then the quieter ones from the cells as they are drawn: the same (text only and within
 * the model's own variation with them, unless split), left as recorded, waits on a judge, not asked,
 * split. A card says the rule each stands on, in the report's own notes where it kept one.
 */
function previewKey(c: DecisionCounts, cells: readonly DecisionCell[], o: { notes: readonly string[]; samples: number }): PreviewView['key'] {
  const card = (title: string, text: string | null, rows: Array<[string, string]> = []) => ({ title, text, rows });
  const waits = cells.filter((x) => x.judge === 'inconclusive').length;
  const same = cells.filter((x) => !split(x) && x.judge !== 'inconclusive' && (x.state === 'same' || x.state === 'noise' || x.rank === 5)).length;
  const control = noteOf(o.notes, /^Each step was asked \d+ times under the change and/);
  return {
    main: [
      { n: c[1], words: movedWords({ 1: Math.max(c[1], 1) }), sw: 'w', card: card(`Rank 1 · ${RANK_LABELS[1]}`, 'A write added, removed, moved or called otherwise. A tool with no recorded effect counts as a write.') },
      { n: c[2], words: movedWords({ 2: Math.max(c[2], 1) }), sw: 's', card: card(`Rank 2 · ${RANK_LABELS[2]}`, 'When the agent stops or hands over differently, or a judge check reads its new words otherwise.') },
      { n: c[3] + c[4], words: movedWords({ 3: Math.max(c[3] + c[4], 1) }), sw: 'r', card: card('Ranks 3 and 4', null, [['rank 3', `${c[3]} · ${RANK_LABELS[3]}`], ['rank 4', `${c[4]} · ${RANK_LABELS[4]}`]]) },
    ],
    quiet: [
      { n: same, words: 'the same', sw: 'm', card: card(`${c.same} the same, ${c[5]} text only`, noteOf(o.notes, /counted, not judged\.$/)) },
      { n: c.untouched, words: 'left as recorded', sw: 'un', card: card('Left as recorded', noteOf(o.notes, / as recorded: the change is at the calls made with /)) },
      { n: waits, words: 'waits on a judge', sw: 'jw', card: card('Waits on a judge', 'A judge check could not read its words, the notes under the matrix say why: its run waits, unless another change flags it.') },
      { n: cells.filter((x) => x.state === 'not-asked' || x.state === 'unsettled').length, words: 'not asked', sw: 'na', card: card('Not asked', 'A step whose recorded call failed is not asked, nor one the change got no answer for: the notes under the matrix say why.') },
      { n: cells.filter(split).length, words: 'split', sw: 'spl', card: card('Split', `Its ${o.samples} samples decided differently, a band each.${control ? ` ${control}` : ''}`) },
    ],
  };
}

type PreviewReport = Pick<DecisionsReport, 'counts' | 'flagged' | 'samples' | 'cost' | 'stopReason' | 'judge'> & { runs: DecisionRun[]; toVerify?: string[]; verify?: DecisionsVerify | null; change?: { model?: string | null; from?: string[] | null; fromCode?: unknown; text?: string }; command?: string; notes?: string[]; warnings?: string[] };

/** A kept report, its parts a session kept before they were filled in as a report without them says: none flagged, nothing spent. */
function keptReport(r: Partial<PreviewReport>): PreviewReport {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
  return {
    ...r,
    runs: Array.isArray(r.runs) ? r.runs.filter((x) => x && Array.isArray(x.decisions)) : [],
    counts: { ...emptyCounts(), ...r.counts },
    flagged: list(r.flagged) ?? [],
    ...(list(r.toVerify) ? { toVerify: list(r.toVerify)! } : {}),
    samples: typeof r.samples === 'number' ? r.samples : 1,
    cost: { before: null, after: null, spent: 0, upstreamRequests: 0, unknownModels: [], ...r.cost },
    stopReason: typeof r.stopReason === 'string' ? r.stopReason : null,
    judge: r.judge ?? null,
    command: typeof r.command === 'string' ? r.command : '',
    notes: list(r.notes) ?? [],
    warnings: list(r.warnings) ?? [],
  };
}

/** One kept session, its matrix's rows with their facts and its `view`; null for an id the store doesn't keep. `redacted`: the project has redaction rules. */
export function previewSession(store: Store, sessionId: string, o: { redacted?: boolean } = {}): PreviewSession | null {
  const session = decisionSession(store, sessionId);
  const verdict = session && previewVerdictOf(store, sessionId);
  if (!session || !verdict) return null;
  const report = keptReport(sessionReport(session) as unknown as Partial<PreviewReport>);
  const runs = report.runs;
  const v = report.verify && report.verify.verdict !== 'not-run' ? report.verify : null;
  const toVerify = report.toVerify ?? report.flagged;
  const index = loadRunIndex(store);
  const indexed = runs.flatMap((x) => index.byId.get(x.runId) ?? []);
  const abouts = aboutsWithin(store, index, indexed, { budget: ROW_CALLS_BUDGET });
  const matrix = session.matrix.map((row): DecisionRow & PreviewRowFacts => {
    const run = store.getRun(row.runId);
    const entry = v?.runs.find((x) => x.runId === row.runId) ?? null;
    const forkAt = run?.mode === 'replay' ? (run.divergence?.callNo ?? null) : null;
    return { ...row, about: abouts.get(row.runId) ?? null, inStore: !!run, toVerify: toVerify.includes(row.runId), verified: entry ? { outcome: runOutcomeWord(entry.outcome), tally: tallyWords(entry) } : null, cleared: !!v && !toVerify.includes(row.runId), parent: run?.parentRunId ?? null, forkAt };
  });
  const headline = decisionsHeadline({ counts: report.counts, flagged: report.flagged, runs });
  const c = report.counts;
  const cells = matrix.flatMap((row) => row.cells);
  const cost = report.cost;
  const view: PreviewView = {
    name: verdict.title,
    change: report.change?.text ?? (typeof session.change === 'string' ? session.change : ''),
    side: report.change?.model || (report.change?.fromCode ? 'the working tree’s prompt' : report.change?.text) || 'the change',
    command: report.command ?? '',
    samples: report.samples,
    unit: runs.length && runs.every((x) => x.golden) ? 'golden' : 'run',
    verdict: { word: verdict.word, tone: verdict.tone, line: verdict.line, toVerify: verdict.toVerify, flaggedRank: verdict.flaggedRank, moved: verdict.moved },
    headline,
    steps: { text: stepsAsked({ counts: c, samples: report.samples, runs }), once: report.samples === 1, tail: [...(c.notAsked ? [`${c.notAsked} not asked`] : []), 'no tool ran'], notes: report.notes ?? [] },
    later: headline.asked ? { text: JUDGED_LATER, ...LATER_STEPS } : null,
    within: withinLine({ samples: report.samples, flagged: report.flagged, runs }),
    verify: v ? verifyView(v, runs) : null,
    next: nextFacts(store, session.kind, report, v, { asked: headline.asked, word: verdict.word }),
    counts: { writes: c[1], stops: c[2], reads: c[3] + c[4], text: c[5], same: c.same, left: c.untouched, notAsked: c.notAsked, noise: c.noise ?? 0, waits: cells.filter((x) => x.judge === 'inconclusive').length, split: cells.filter(split).length },
    key: previewKey(c, cells, { notes: report.notes ?? [], samples: report.samples }),
    warnings: [...new Set([...(report.warnings ?? []), ...runs.flatMap((x) => (Array.isArray(x.warnings) ? x.warnings : []))])],
    receipt: {
      perRun: cost.before !== null && cost.after !== null ? { before: cost.before, after: cost.after, change: percentChange(cost.before, cost.after) } : null,
      spent: cost.spent,
      requests: cost.upstreamRequests,
      unknownModels: cost.unknownModels,
      judge: report.judge ? { requests: report.judge.upstreamRequests, spent: report.judge.spent, unknownModels: report.judge.unknownModels } : null,
      stopReason: report.stopReason,
    },
    cleared: CLEARED,
    redacted: o.redacted === true,
  };
  return { ...session, sessionId, matrix, view };
}

/** One kept session for Changes' Preview, as `GET /api/decisions/:id` answers it. */
export type DecisionSessionJob = { kind: 'decision-session'; sessionId: string; redacted?: boolean };

function sessionRead(store: Store, job: DecisionSessionJob): ReadAnswer {
  const session = previewSession(store, job.sessionId, { redacted: job.redacted === true });
  return session ? answer(session, { tagged: true }) : failed(404, `no session ${job.sessionId.slice(0, 40)}`);
}

export const DECISION_READS: ReadTable<DecisionSessionJob> = {
  'decision-session': (store, job) => sessionRead(store, job),
};
