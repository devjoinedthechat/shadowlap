import { canonicallySame } from '../../engine/src/canonical.js';
import { approx, clock, minuteStamp, num } from './format.js';
import type { DecisionCell, DecisionRun, DecisionSessionView, DecisionView, PreviewNext, PreviewReceipt, PreviewView } from './types.js';

/**
 * Changes' Preview and a run's Decisions view, worked out from what the server words (src/decision-view.ts):
 * how a cell is drawn and which call a range stands for, the verdict's state, the one next step, the
 * picker's hint and the receipt's lines. Pure, with no DOM and nothing from api.ts, so the Node tests
 * read it as the page does.
 */

/** A cell's colour: `w` a write (red), `s` a stop, hand-over or judged change (amber), `r` a read, `m` the same or words only (the muted fill). */
export type Band = 'w' | 's' | 'r' | 'm';

/** The colour a rank draws in: 1 a write, 2 a stop, 3 and 4 a read, else the same or words. */
export const bandOf = (rank: number | null): Band => (rank === 1 ? 'w' : rank === 2 ? 's' : rank === 3 || rank === 4 ? 'r' : 'm');

/** How a cell is drawn: its fill, its bands a sample each where they differ (the most consequential at the bottom), and its marks. */
export interface CellLook {
  fill: Band;
  /** A band a sample, the most consequential first, which the cell draws at its bottom; null where every sample draws alike. */
  bands: Band[] | null;
  /** An amber ring on the muted fill: its change is in its words alone, which a judge couldn't judge. A change a cell shows besides keeps its colour. */
  ring: boolean;
  /** Hollow: the change leaves the call as recorded. */
  hollow: boolean;
  /** Dashed: not asked, or waiting on its control. */
  dashed: boolean;
}

const BAND_ORDER: Record<Band, number> = { w: 0, s: 1, r: 2, m: 3 };

export function cellLook(c: Pick<DecisionCell, 'state' | 'rank' | 'sampled' | 'ranks' | 'judge'>): CellLook {
  const hollow = c.state === 'left';
  const dashed = c.state === 'not-asked' || c.state === 'unsettled';
  // Within the model's own variation a cell shows what its samples showed, ranked or not.
  const fill = hollow || dashed ? 'm' : bandOf(c.state === 'noise' ? c.sampled : c.rank);
  const each = c.ranks.map((r) => bandOf(r || null));
  const bands = !hollow && !dashed && each.length > 1 && each.some((b) => b !== each[0]) ? [...each].sort((a, b) => BAND_ORDER[a] - BAND_ORDER[b]) : null;
  return { fill, bands, ring: c.judge === 'inconclusive' && fill === 'm' && !hollow && !dashed, hollow, dashed };
}

/** A cell's weight, to pick the call a range stands for: a write the most, then a stop, a read, words a judge couldn't read, words, the same, not asked, left as recorded. */
export function cellWeight(c: Pick<DecisionCell, 'state' | 'rank' | 'judge'>): number {
  if (c.state === 'left') return 0;
  if (c.state === 'not-asked' || c.state === 'unsettled') return 1;
  if (c.rank === null || c.rank === 0) return c.state === 'noise' ? 2.5 : 2;
  if (c.rank === 5) return c.judge === 'inconclusive' ? 3.5 : 3;
  return 9 - c.rank;
}

/** Past this many model calls a row's cells stand for ranges of calls. */
export const RANGES_PAST = 60;

/** A cell as drawn: one call, or a range of calls drawn as its most consequential one (`top`). */
export interface DrawnCell<C> {
  top: C;
  first: C;
  last: C;
  count: number;
}

/** A row's cells as drawn: one a call up to `most`, else ranges of calls, each as its most consequential call, the first of them on a tie. */
export function drawnCells<C extends Pick<DecisionCell, 'state' | 'rank' | 'judge'>>(cells: readonly C[], most = RANGES_PAST): Array<DrawnCell<C>> {
  const size = cells.length > most ? Math.ceil(cells.length / most) : 1;
  const out: Array<DrawnCell<C>> = [];
  for (let i = 0; i < cells.length; i += size) {
    const part = cells.slice(i, i + size);
    const top = part.reduce((a, b) => (cellWeight(b) > cellWeight(a) ? b : a));
    out.push({ top, first: part[0]!, last: part.at(-1)!, count: part.length });
  }
  return out;
}

/**
 * The verdict's state, as the page leads with it: runs to verify, some flagged (their count in its
 * colour); runs to verify, none flagged; a preview that settled nothing; verify's verdict; nothing to
 * verify.
 */
export type VerdictState = 'flagged' | 'unverified' | 'unsettled' | 'verified' | 'nothing';

export function verdictState(v: Pick<PreviewView, 'verdict' | 'verify'>): VerdictState {
  const word = v.verdict.word;
  if (word === 'not verified') return v.verdict.flaggedRank ? 'flagged' : 'unverified';
  if (word === 'nothing to verify') return 'nothing';
  if (v.verify && (word !== 'inconclusive' || v.verify.word === 'inconclusive')) return 'verified';
  return word === 'inconclusive' ? 'unsettled' : 'verified';
}

/** Verify's button: the runs it would verify, counted, with no ellipsis, as its ask only confirms the price. */
export const verifyLabel = (n: number): string => `Verify ${n} run${n === 1 ? '' : 's'}`;

/** The one next step: Verify the runs left to verify, Run more attempts on those verify left open, Migrate to the model switched to, else none. */
export type NextStep =
  | { kind: 'verify'; label: string; runs: string[]; every: boolean; gone: number }
  | ({ kind: 'more'; label: 'Run more attempts' | 'Verify again' } & Omit<NonNullable<PreviewNext['more']>, 'kind'>)
  | { kind: 'migrate'; label: string; to: string; from: string[]; goldens: string[]; runs: string[] }
  | null;

export function nextStep(next: PreviewNext): NextStep {
  if (next.verify) return { kind: 'verify', label: verifyLabel(next.verify.runs.length), runs: next.verify.runs, every: next.verify.every, gone: next.verify.gone };
  if (next.more) {
    const { kind, ...more } = next.more;
    return { kind: 'more', label: kind === 'again' ? 'Verify again' : 'Run more attempts', ...more };
  }
  if (next.migrate) return { kind: 'migrate', label: `Migrate to ${next.migrate.to}`, ...next.migrate };
  return null;
}

/** A session in the picker after its name: its goldens or runs and when, in the list also how often it asked a step: `7 goldens · 3 samples a step · <when>`. */
export function sessionHint(s: Pick<DecisionSessionView, 'runs' | 'unit' | 'samples' | 'at'>, o: { full?: boolean; now?: number } = {}): string {
  const n = `${s.runs} ${s.unit}${s.runs === 1 ? '' : 's'}`;
  return [n, o.full && s.samples && s.samples > 1 ? `${s.samples} samples a step` : null, minuteStamp(s.at, o.now)].filter(Boolean).join(' · ');
}

/**
 * Two prices side by side: as `approx` writes each, a place finer where the two would read alike
 * but differ, so a move never reads "$0.018 → $0.018 (+1%)".
 */
export function pricePair(a: number, b: number): string {
  const at = (v: number, places: number) => `≈$${v.toFixed(places)}`;
  const one = approx(a);
  const two = approx(b);
  if (one !== two || a === b || !a || !b) return `${one} → ${two}`;
  const places = (one.split('.')[1] ?? '').length;
  for (let p = places + 1; p <= 6; p++) if (at(a, p) !== at(b, p)) return `${at(a, p)} → ${at(b, p)}`;
  return `${one} → ${two}`;
}

/** A receipt's line: its parts, joined by dots, and its card's title and rows. */
export interface ReceiptWords {
  parts: string[];
  card: { title: string; rows: Array<[string, string]> } | null;
}

const requests = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
const unpriced = (models: readonly string[]) => (models.length ? ` (no price for ${models.join(', ')})` : '');

/**
 * The receipt at the matrix's foot: what a run costs as recorded and under the change and what the
 * preview spent, then what it asked; a run's tokens either way, then asking and judging apart, on the
 * first line's card. Once verify
 * ran, what the runs it verified cost end to end joins it.
 */
export function receiptWords(r: PreviewReceipt, endToEnd: string | null): ReceiptWords[] {
  const spent = r.spent + (r.judge?.spent ?? 0);
  const first = [r.perRun ? `per run ${pricePair(r.perRun.before, r.perRun.after)} (${r.perRun.change})` : null, `this preview spent ${approx(spent)}${unpriced([...r.unknownModels, ...(r.judge?.unknownModels ?? [])])}`, r.stopReason ? `stopped: ${r.stopReason}` : null].filter((x): x is string => !!x);
  const rows: Array<[string, string]> = [...(r.tokens ? [['per run', `${num(r.tokens.before)} → ${num(r.tokens.after)} input tokens`] as [string, string]] : []), ['asking', `${approx(r.spent)} · ${requests(r.requests, 'upstream request')}`], ...(r.judge ? [['judging', `${approx(r.judge.spent)} · ${requests(r.judge.requests, 'upstream request')}`] as [string, string]] : [])];
  return [
    { parts: first, card: { title: 'What it cost', rows } },
    { parts: [`${requests(r.requests, 'request')} to the model${r.judge ? `, ${r.judge.requests} to the judge` : ''}`], card: null },
    ...(endToEnd ? [{ parts: [`end to end ${endToEnd}`], card: null }] : []),
  ];
}

/**
 * A tool call's mark beside the other side's decision, as an opened cell draws it: the other side
 * makes the very call (`same`, a faint →), calls the tool otherwise (`diff`, → in ink), or doesn't
 * call it (`gone` on the recorded side, struck through, `new` on the changed one).
 */
export type ToolMark = 'same' | 'diff' | 'gone' | 'new';

export function toolMarks(d: Pick<DecisionView, 'tools'>, other: Pick<DecisionView, 'tools'> | null, side: 'recorded' | 'now'): ToolMark[] {
  const theirs = other?.tools ?? [];
  const same = (t: DecisionView['tools'][number]) => theirs.some((o) => o.name === t.name && canonicallySame(o.args ?? null, t.args ?? null));
  return d.tools.map((t) => (same(t) ? 'same' : theirs.some((o) => o.name === t.name) ? 'diff' : side === 'recorded' ? 'gone' : 'new'));
}

/** A tool's effect as its tag says it: a tool of unknown effect counts as a write, as the engine counts it; a hand-over keeps its word. */
export const effectTag = (effect: DecisionView['tools'][number]['effect']): string => (effect === 'unknown' ? 'write' : effect);

/**
 * A call's arguments as JSON, cut where a line may break: after a comma or an opening brace, never
 * inside a short quoted value (an id), which is `whole`; arguments of 30 characters or fewer stay whole.
 */
export function argParts(json: string): Array<{ text: string; whole: boolean }> {
  if (json.length <= 30) return [{ text: json, whole: true }];
  return json.split(/("(?:[^"\\]|\\.)*")/).flatMap((part, i) => (i % 2 ? [{ text: part, whole: part.length <= 30 && !/\s/.test(part) }] : part.split(/(?<=[,{])/).filter(Boolean).map((text) => ({ text, whole: false }))));
}

/** An opened cell's lead: a sentence where nothing was compared, else its rank, its change and how often, quieter. */
export type CellLead = { sentence: string } | { rank: number | null; text: string; quiet: string };

const sentence = (words: string) => `${words.charAt(0).toUpperCase()}${words.slice(1).replace(/\.$/, '')}.`;

export function cellLead(c: Pick<DecisionCell, 'state' | 'rank' | 'detail' | 'words' | 'answered'>): CellLead {
  if (c.state === 'not-asked' || c.state === 'left') return { sentence: sentence(c.words) };
  if (c.state === 'same') return { sentence: `The same decision${c.answered > 1 ? ` in all ${c.answered} samples` : ''}.` };
  const text = c.detail ?? '';
  const quiet = c.words.startsWith(text) ? c.words.slice(text.length) : '';
  return { rank: c.state === 'ranked' ? c.rank : null, text, quiet: quiet.trim() };
}

/**
 * What an opened cell's cost line says: the step's cost either way, how it was compared (after the
 * project's normalizers, and dates near the run's start masked unless its clock is exact), and the
 * masking where the project redacts. A config that couldn't be read says nothing of its clock.
 */
export function cellCost(delta: string, o: Pick<PreviewView, 'redacted' | 'clock'>): string {
  return [delta, `compared after the project’s normalizers${o.clock === 'auto' ? ', dates near the run’s start masked' : ''}`, o.redacted ? 'values masked by its redaction rules' : ''].filter(Boolean).join(' · ');
}

const OUTCOME_TONE: Readonly<Record<string, string>> = { kept: 'ok', fixed: 'ok', broken: 'no', 'not fixed': 'no', 'not-fixed': 'no' };
/** What verify found of a run, in its colour: kept and fixed green, broken and not fixed red, else amber (inconclusive). */
export const outcomeTone = (outcome: string): string => OUTCOME_TONE[outcome] ?? 'y';

/** What a run's Decisions view says where it lists no step: why it wasn't asked, else that it decided as recorded. */
export function noneLine(run: Pick<DecisionRun, 'refused' | 'asked' | 'decisions'>): string {
  if (run.refused) return sentence(`not asked: ${run.refused.split('\n')[0] ?? ''}`);
  if (run.asked) return 'The same decision at every step asked.';
  const error = run.decisions.find((d) => d.error)?.error;
  return error ? sentence(`nothing asked: ${error}`) : 'The change leaves this run’s requests as recorded.';
}

/** When a session asked a run, on its chip in the run's Decisions view: the time alone today (`14:05`), else with its day (`Nov 6, 14:05`). */
export function chipWhen(ms: number, now = Date.now()): string {
  return new Date(ms).toDateString() === new Date(now).toDateString() ? clock(ms) : minuteStamp(ms, now);
}
