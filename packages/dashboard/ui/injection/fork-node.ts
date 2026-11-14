import { goneWords, injectionCountParts } from '../../../engine/src/trust-words.js';
import { approx, goldenName, num, plural, shortId } from '../format.js';
import type { InjectionRow, LineageNode } from '../types.js';

/*
 * The Forks view's node for a kept injection test, filed under the run it tested: a plant's or a
 * gate's, or a --clean answer's, its replays as cells in one picture. No DOM here: the tests import
 * it. The words of each replay's card are the server's (its proof line, its writes gone), drawn here.
 */

/** A replay's mark in the strip: red, amber or muted, never lime. Its card says which replay it is and what it showed. */
export interface TestCell {
  runId: string;
  tone: 'no' | 'inc' | 'mu';
  card: { t: string; s?: string };
}

/** A line under the strip: an attempt the verdict rests on, opened at the call that shows it. */
export interface TestLine {
  runId: string;
  tone: 'no' | 'inc';
  callNo: number | null;
  words: string;
}

export interface TestNodeView {
  title: string;
  glyph: { kind: 'fail' | 'warn' | 'test'; label: string };
  /** The line, its parts joined by dots: the verdict, the counts, a gate's golden and what it spent; a --clean answer's own line. */
  parts: string[];
  /** The test's attempts, then a plant's clean replays after a hairline. */
  cells: TestCell[];
  replays: TestCell[];
  /** The strip's name: what it holds, by its counts. */
  label: string;
  lines: TestLine[];
  /** What the lines leave out, and the attempts the family's list doesn't hold; empty when there is nothing to say. */
  more: string;
  /** Every run the node holds: the page of one of them is here. */
  runs: ReadonlySet<string>;
}

/**
 * The runs whose kept tests the Forks view reads: each run the family's injection replays tested, the
 * page's run, and each run the family starts from. Their tests draw though no replay of theirs is in
 * the list (gc took them, or they are past its first 1,000 runs), saying how many attempts aren't drawn.
 */
export function testedRuns(nodes: readonly LineageNode[] | null, runId: string): string[] {
  if (!nodes) return [];
  const ids = new Set(nodes.map((n) => n.runId));
  const first = nodes.filter((n) => !n.parentRunId || !ids.has(n.parentRunId)).map((n) => n.runId);
  const page = nodes.filter((n) => n.runId === runId || n.runId.startsWith(runId)).map((n) => n.runId);
  return [...new Set([...nodes.flatMap((n) => (n.injection && n.parentRunId ? [n.parentRunId] : [])), ...first, ...page])].sort();
}

/** The family's injection replays by the result they belong to. */
export function byResult(nodes: readonly LineageNode[]): Map<string, LineageNode[]> {
  const out = new Map<string, LineageNode[]>();
  for (const n of nodes) if (n.injection) out.set(n.injection.result, [...(out.get(n.injection.result) ?? []), n]);
  return out;
}

const ATTEMPT_TONE: Readonly<Record<string, TestCell['tone']>> = { obeyed: 'no', influenced: 'inc', inconclusive: 'inc', ignored: 'mu' };
/** The attempts the verdict rests on, the strongest first: those that obeyed, then influenced, then couldn't say. */
const RESTS_ON = ['obeyed', 'influenced', 'inconclusive'] as const;

/** In the order the test ran them. */
const ranOrder = (a: LineageNode, b: LineageNode) => (a.repeat?.attempt ?? 0) - (b.repeat?.attempt ?? 0) || a.startedAt - b.startedAt;

type Marked = LineageNode & { injection: NonNullable<LineageNode['injection']> };

/** What a clean attempt showed: why it decided nothing, else its writes gone; nothing where its result is gone. */
const cleanSays = (i: Marked['injection']): string | null => i.says ?? (i.gone ? goneWords(i.gone) : null);

const said = (s: string | null): { s?: string } => (s ? { s } : {});

function attemptCell(n: Marked): TestCell {
  const i = n.injection;
  const s = i.verdict ? `${i.verdict}${i.says ? `: ${i.says}` : ''}` : 'running';
  return { runId: n.runId, tone: ATTEMPT_TONE[i.verdict ?? ''] ?? 'mu', card: { t: `${i.payload ?? 'a payload'} at #${i.read}, attempt ${i.attempt} · ${shortId(n.runId)}`, s } };
}

function cleanCell(n: Marked): TestCell {
  const i = n.injection;
  return { runId: n.runId, tone: i.says ? 'inc' : i.gone?.length ? 'no' : 'mu', card: { t: `clean attempt ${i.attempt} · ${shortId(n.runId)}`, ...said(cleanSays(i)) } };
}

/** How many of each, `8 obeyed`, leaving out a zero. */
const each = (counts: ReadonlyArray<readonly [string, number]>): string[] => counts.filter(([, n]) => n).map(([w, n]) => `${num(n)} ${w}`);

/** The test's own line: a plant's gate verdict, its counts, a gate's golden and what it spent; a running one's line; a --clean answer's line, then what it spent. */
function lineParts(row: InjectionRow): string[] {
  const money = row.spent ? [approx(row.spent)] : [];
  if (row.mode === 'clean') return [...row.line.split(' · '), ...money];
  if (!row.gate) return [row.line, ...money];
  return [row.gate, ...injectionCountParts(row, { num }), ...(row.golden ? [goldenName(row.golden)] : []), ...money];
}

function glyphOf(row: InjectionRow): TestNodeView['glyph'] {
  const v = row.mode === 'plant' ? row.gate : row.verdict;
  return { kind: v === 'failed' || v === 'caused' ? 'fail' : v === 'inconclusive' ? 'warn' : 'test', label: row.mode === 'plant' ? 'Injection test' : 'Clean attempts' };
}

/** A plant's strip, lines and what they leave out. */
function plantParts(own: readonly Marked[], replays: readonly Marked[], missing: number) {
  const verdictOf = (n: Marked) => n.injection.verdict ?? 'running';
  const count = (list: readonly Marked[], v: string) => list.filter((n) => verdictOf(n) === v).length;
  const shown = RESTS_ON.flatMap((v) => own.filter((n) => verdictOf(n) === v)).slice(0, 3);
  const lines = shown.map((n): TestLine => ({ runId: n.runId, tone: n.injection.verdict === 'obeyed' ? 'no' : 'inc', callNo: n.injection.at, words: `${n.injection.payload ?? 'a payload'} · ${attemptCell(n).card.s!}` }));
  const counts = (['obeyed', 'influenced', 'ignored', 'inconclusive', 'running'] as const).map((v) => [v, count(own, v)] as const);
  const label = `${plural(own.length, 'attempt')} in the order they ran${own.length ? `: ${each(counts).join(', ')}` : ''}${replays.length ? `, then ${plural(replays.length, 'clean replay')}` : ''}`;
  const left = RESTS_ON.map((v) => [`more ${v}`, count(own, v) - count(shown, v)] as const);
  const more = [...each([...left, ['ignored', count(own, 'ignored')], ['running', count(own, 'running')]]), missingWords(missing), own.length ? 'each attempt is a cell above' : ''];
  return { lines, label, more };
}

/** A --clean answer's strip, its lines (the clean attempts where a write went) and what they leave out. */
function cleanParts(own: readonly Marked[], missing: number) {
  const kind = (n: Marked) => (n.injection.says ? 'inconclusive' : n.injection.gone?.length ? 'gone' : 'back');
  const count = (list: readonly Marked[], k: string) => list.filter((n) => kind(n) === k).length;
  const shown = own.filter((n) => kind(n) === 'gone').slice(0, 3);
  const lines = shown.map((n): TestLine => ({ runId: n.runId, tone: 'no', callNo: n.injection.at, words: `clean attempt ${n.injection.attempt} · ${goneWords(n.injection.gone ?? [])}` }));
  const counts = [['with a write gone', count(own, 'gone')], ['with every write made again', count(own, 'back')], ['inconclusive', count(own, 'inconclusive')]] as const;
  const label = `${plural(own.length, 'clean attempt')} in the order they ran${own.length ? `: ${each(counts).join(', ')}` : ''}`;
  const more = [...each([['more with a write gone', count(own, 'gone') - shown.length], ['with every write made again', count(own, 'back')], ['inconclusive', count(own, 'inconclusive')]]), missingWords(missing), own.length ? 'each attempt is a cell above' : ''];
  return { lines, label, more };
}

/** The attempts a test ran that the family's list doesn't hold, never left out silently: gc took them, or the list stopped at its first 1,000 runs. */
const missingWords = (n: number) => (n > 0 ? `${plural(n, 'attempt')} not drawn: gone from the store, or past the family’s first 1,000 runs` : '');

/** A kept test's node: its title, glyph and line from its row, its replays from the family's marked runs. */
export function testNode(row: InjectionRow, runs: readonly LineageNode[]): TestNodeView {
  const plant = row.mode === 'plant';
  const marked = runs.filter((n): n is Marked => !!n.injection).sort(ranOrder);
  const own = marked.filter((n) => n.injection.role === (plant ? 'attempt' : 'clean'));
  const replays = plant ? marked.filter((n) => n.injection.role === 'baseline') : [];
  const missing = Math.max(0, row.attempts - own.length);
  const { lines, label, more } = plant ? plantParts(own, replays, missing) : cleanParts(own, missing);
  return {
    // Only a test session's is a golden's gate: a golden tested on its own is an injection test.
    title: plant ? (row.sessionId ? 'injection gate' : 'injection test') : `injection --clean${row.read !== null ? ` ${row.read}` : ''}`,
    glyph: glyphOf(row),
    parts: lineParts(row),
    cells: own.map(plant ? attemptCell : cleanCell),
    replays: replays.map((n, k) => ({ runId: n.runId, tone: 'mu', card: { t: `clean replay ${k + 1} · ${shortId(n.runId)}`, ...said(n.about?.text ?? null) } })),
    label,
    lines,
    more: more.filter(Boolean).join(' · '),
    runs: new Set(marked.map((n) => n.runId)),
  };
}
