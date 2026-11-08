import { clip, jsonText, num, plural, shortId } from '../format.js';
import { exitWords } from '../runs.js';
import { jsonDiff, jsonInString, type JsonLine, type Sign } from '../json-diff.js';
import type { CodeChange, CompareView, LiveRun } from '../types.js';

/**
 * Compare's logic (`pages/Compare.tsx`), without the DOM so the tests import it: what changed and
 * what didn't, the prefix line and the card on what made the fork, the changed request's lines, each
 * run's line, which runs the pickers offer, and when the comparison is read again.
 */

export interface ChangeCard {
  key: 'code' | 'system prompt' | 'tools' | 'model';
  changed: boolean;
  /** `a7b3c2e → c91d0f4`, `changed`, `unchanged`. */
  title: string;
  /** The line under it: the change's commit subject, the prompt's hash, the tools added and removed. */
  note: string;
  /** More on hover: the commits between the revisions. */
  tip: string | null;
}

/** A hash as the card shows it: `sha 3f9e…a21`. */
export function shortSha(hash: string): string {
  return hash.length > 9 ? `sha ${hash.slice(0, 4)}…${hash.slice(-3)}` : `sha ${hash}`;
}

/** The commits between two revisions, counted as git counted them (capped at 1000). */
const commitCount = (n: number) => (n >= 1000 ? '1000+ commits' : plural(n, 'commit'));

/** What the code card says under the two revisions, from what git said about them (null: it couldn't). */
export function codeNote(code: CodeChange | null | undefined): { note: string; tip: string | null } {
  if (!code) return { note: 'different revision', tip: null };
  if (code.uncommitted) return { note: 'uncommitted changes', tip: 'The same commit; one run had uncommitted changes in its working tree.' };
  if (code.commits === null || code.newer === null) return { note: 'on separate branches', tip: 'Neither revision follows the other: they are on separate branches.' };
  const n = code.commits;
  const more = n > code.subjects.length ? `\n… and ${num(n - code.subjects.length)} more` : '';
  const tip = code.subjects.length ? `${code.subjects.join('\n')}${more}` : null;
  // Compared with an older run, the change is read backwards: what these commits did is undone.
  if (code.newer === 'a') return { note: `${commitCount(n)} earlier`, tip };
  const subject = code.subjects[0] ?? null;
  if (!subject) return { note: commitCount(n), tip };
  return { note: n === 1 ? subject : `${commitCount(n)} · ${subject}`, tip };
}

/** Tools a card names before it counts the rest. */
const TOOLS_SHOWN = 4;

/** What the four cards say, as the mock draws them: a changed one is outlined. */
export function changeCards(c: Pick<CompareView, 'changes' | 'code'>): ChangeCard[] {
  const ch = c.changes;
  // Two abbreviations of one commit (git gives more digits as a repository grows) are no change.
  const sameCommit = !!c.code?.same;
  const codeChanged = (ch.code.a ?? '') !== (ch.code.b ?? '') && !sameCommit;
  const code = codeChanged ? codeNote(c.code) : { note: ch.code.a ?? 'no revision recorded', tip: sameCommit ? `The same commit, named ${ch.code.a!} in one run and ${ch.code.b!} in the other.` : null };
  const t = ch.tools;
  const toolsChanged = t.added.length > 0 || t.removed.length > 0 || t.redefined;
  const named = [...t.added.map((x) => `+${x}`), ...t.removed.map((x) => `−${x}`)];
  // A run of another agent adds a dozen tools: the card names a few, the hover all of them.
  const toolNote = named.length > TOOLS_SHOWN ? `${named.slice(0, TOOLS_SHOWN - 1).join(' ')} · ${named.length - TOOLS_SHOWN + 1} more` : named.join(' ') || (t.redefined ? 'a definition changed' : 'same declarations');
  const toolTip = named.length > TOOLS_SHOWN ? named.join(' ') : null;
  const modelsChanged = ch.models.a.join() !== ch.models.b.join();
  const prompts = ch.systems?.a ?? null;
  const promptNote = ch.systemPrompt ? 'different prompt' : !prompts ? 'same prompt' : prompts.length === 1 ? shortSha(prompts[0]!) : prompts.length ? `${prompts.length} prompts, the same` : 'no system prompt';
  return [
    { key: 'code', changed: codeChanged, title: codeChanged ? `${ch.code.a ?? '—'} → ${ch.code.b ?? '—'}` : 'unchanged', note: code.note, tip: code.tip },
    { key: 'system prompt', changed: ch.systemPrompt, title: ch.systemPrompt ? 'changed' : 'unchanged', note: promptNote, tip: !ch.systemPrompt && prompts?.length === 1 ? `The same system prompt, sha256 ${prompts[0]!}` : null },
    { key: 'tools', changed: toolsChanged, title: toolsChanged ? 'changed' : 'unchanged', note: toolNote, tip: toolTip },
    { key: 'model', changed: modelsChanged, title: modelsChanged ? `${ch.models.a.join(', ') || 'none'} → ${ch.models.b.join(', ') || 'none'}` : 'unchanged', note: modelsChanged ? 'different model' : ch.models.a.join(', ') || 'no model call', tip: null },
  ];
}

/** A changed fact's line in What changed: `Code changed`, what changed set as code, then a muted note. */
export interface ChangedFact {
  key: ChangeCard['key'];
  /** `Code changed`, `System prompt changed`. */
  lead: string;
  /** What changed, as code: `a7b3c2e → c91d0f4`, `+lookup −email`, `claude-sonnet-5 → claude-haiku-4-5`. */
  code: string | null;
  /** Words after it, muted: the commit's subject, `a definition changed`. */
  note: string | null;
  /** More on hover: the commits between the revisions, every tool added and removed. */
  tip: string | null;
}

/** What changed between the two runs, a line a changed fact, and what didn't in one muted line, with a row a fact for its hover. */
export interface CompareFacts {
  changed: ChangedFact[];
  /** `Code, system prompt, tools and model unchanged`; null when every fact changed. */
  same: string | null;
  /** The unchanged line's card, `The same on both sides`: each fact and what it is in both runs. */
  sameRows: Array<{ key: string; value: string }>;
}

const sentenceCase = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const listed = (xs: readonly string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)!}` : xs.join(''));

/**
 * The change cards' words regrouped as What changed says them: each card words its change its own
 * way, as their titles and notes don't line up. The code's revisions and the model's names as code,
 * the commit's subject muted after them; the tools added and removed as code, or in words where
 * only a definition changed; a system prompt that changed, alone (its note says it again).
 */
export function compareFacts(cards: readonly ChangeCard[]): CompareFacts {
  const changed = cards
    .filter((c) => c.changed)
    .map((c): ChangedFact => {
      const fact = { key: c.key, lead: `${sentenceCase(c.key)} changed`, code: null, note: null, tip: null };
      if (c.key === 'code') return { ...fact, code: c.title, note: c.note || null, tip: c.tip };
      if (c.key === 'model') return { ...fact, code: c.title };
      if (c.key === 'tools') return /^[+−]/.test(c.note) ? { ...fact, code: c.note, tip: c.tip } : { ...fact, note: c.note, tip: c.tip };
      return fact;
    });
  const same = cards.filter((c) => !c.changed);
  return { changed, same: same.length ? `${sentenceCase(listed(same.map((c) => c.key)))} unchanged` : null, sameRows: same.map((c) => ({ key: sentenceCase(c.key), value: c.note })) };
}

/**
 * The answers that changed, for the table: a model that answered a call the same way again (its text,
 * tool calls and thinking; only the new response's id or token counts differ) gave no different answer.
 */
export function changedAnswers(c: Pick<CompareView, 'responseDifferences'>): CompareView['responseDifferences'] {
  return c.responseDifferences.filter((r) => !r.sameAnswer);
}

/**
 * How the calls with the same request were answered: `2 calls got a different answer`, and those the
 * model answered the same way in a new response (two live runs of one agent), or null when none differs.
 */
function answeredLine(c: Pick<CompareView, 'responseDifferences'>, toSame: boolean): string | null {
  const changed = changedAnswers(c).length;
  const again = c.responseDifferences.length - changed;
  const responses = (n: number) => (n === 1 ? 'a new response' : 'new responses');
  if (changed && again) return `${plural(changed, 'call')} got a different answer and ${num(again)} the same one in ${responses(again)}`;
  if (changed) return `${plural(changed, 'call')} got a different answer${toSame ? ' to the same request' : ''}`;
  return again ? `${plural(again, 'call')} got the same answer in ${responses(again)}` : null;
}

/**
 * What made the fork, as the line beside the identical prefix leads with it when no request shows it:
 * `#19 got HTTP 529 instead of an answer`, naming the run it made when that is A. Null when the pair
 * isn't a run and its replay, or the replay's flag changed a request (the cards and the first
 * difference say that), and from a copy or a server older than comparisons that carry it.
 */
export function madeBy(c: { a?: Pick<CompareView['a'], 'runId'>; intervention?: CompareView['intervention'] }): string | null {
  const iv = c.intervention ?? null;
  return iv ? `${iv.words}${iv.run === 'a' && c.a ? ` in ${shortId(c.a.runId)}` : ''}` : null;
}

/** How the flag that made the fork acted on its call, as the card on what made it says it. */
const ACTED: Record<NonNullable<CompareView['intervention']>['kind'], string> = { fail: 'answered with', override: 'overridden', answer: 'answered otherwise', plant: 'planted', resample: 'asked again' };

/**
 * The card on what made the fork: `Same request, different response`, then `#19, answered with
 * HTTP 529 by the fork. The paths differ from there.`, and the flag as its command.
 */
export function madeCard(iv: NonNullable<CompareView['intervention']>): { title: string; line: string; command: string } {
  const acted = iv.kind === 'fail' ? `${ACTED.fail} ${iv.after ?? 'an HTTP failure'}` : ACTED[iv.kind];
  return { title: 'Same request, different response', line: `#${num(iv.callNo)}, ${acted} by the fork. The paths differ from there.`, command: iv.flag };
}

/** The identical prefix's strip draws at most this many cells, one a call, so a long shared start (906 calls) still draws. */
export const PREFIX_CELLS = 60;

/** The strip's cells for `n` identical calls: one a call, at most PREFIX_CELLS. */
export const prefixCells = (n: number): number => Math.max(1, Math.min(n, PREFIX_CELLS));

/**
 * The line beside the identical prefix: how far the runs agree (`lead`), then what made the fork when
 * no request shows it and where they part (`rest`). `made`, the words `rest` starts with that say what
 * made the fork, which carry its card; null with none.
 */
export function prefixLine(c: Pick<CompareView, 'identicalPrefix' | 'firstRequestDifference' | 'responseDifferences' | 'onlyInA' | 'onlyInB'> & { a?: Pick<CompareView['a'], 'runId'>; intervention?: CompareView['intervention'] }): { lead: string; made: string | null; rest: string } {
  const line = prefixWords(c);
  const made = madeBy(c);
  return { lead: line.lead, made: made && line.rest.startsWith(made) ? made : null, rest: line.rest };
}

function prefixWords(c: Parameters<typeof prefixLine>[0]): { lead: string; rest: string } {
  const n = c.identicalPrefix;
  const first = c.firstRequestDifference?.callNo ?? null;
  const lead = n ? `#1–#${num(n)} identical.` : 'No identical prefix.';
  const made = madeBy(c);
  // The answer the flag changed is said by what made the fork: the others are counted as before.
  const flagged = made ? (c.intervention?.callNo ?? null) : null;
  const others = { responseDifferences: c.responseDifferences.filter((r) => r.callNo !== flagged) };
  if (first) {
    const answered = answeredLine(others, true);
    const where = `the first request that differs is #${first}${answered ? `; before it, ${answered}` : ''}`;
    return { lead, rest: made ? `${made}; ${where}.` : `T${where.slice(1)}.` };
  }
  // A run that went on past the other's end (one still recording): only the requests both made match.
  const shared = c.onlyInA || c.onlyInB ? 'Every request they share matches' : 'Every request matches';
  const answered = answeredLine(others, false);
  if (made) return { lead, rest: `${made}; ${shared.toLowerCase()}${answered ? `, and ${answered}` : ''}.` };
  if (answered) return { lead, rest: `${shared}; ${answered}.` };
  if (c.onlyInA || c.onlyInB) return { lead, rest: `${shared}.` };
  return { lead, rest: 'Every call matches.' };
}

/** The line beside "Same request, different answer": how many calls, and before which request when one differs. */
export function answersSub(c: Pick<CompareView, 'firstRequestDifference' | 'responseDifferences'>): string {
  const n = plural(changedAnswers(c).length, 'call');
  return c.firstRequestDifference ? `${n}, before the first request that differs` : n;
}

/** Two values that share a start longer than this open shortly before where they part. */
const SHARED_START = 60;

/**
 * A differing field's two values as the first-difference panel shows them: JSON on one line, and
 * `(absent)` on the side without the field. Two values that share a long start (an instruction
 * planted at the end of a tool's result) open shortly before where they part, at a comma or a space,
 * after an ellipsis, so the difference is in view without scrolling.
 */
export function diffTexts(e: { op: 'changed' | 'added' | 'removed'; before?: unknown; after?: unknown }, max = 600): { before: string; after: string } {
  const a = e.op === 'added' ? null : jsonText(e.before, false);
  const b = e.op === 'removed' ? null : jsonText(e.after, false);
  let from = 0;
  if (a !== null && b !== null) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    if (p > SHARED_START) {
      from = p - 24;
      const cut = a.slice(from, p - 4).search(/[, ]/);
      if (cut >= 0) from += cut + 1;
    }
  }
  const show = (s: string | null) => (s === null ? '(absent)' : from ? `…${clip(s.slice(from), max)}` : clip(s, max));
  return { before: show(a), after: show(b) };
}

type DiffEntry = NonNullable<NonNullable<CompareView['firstRequestDifference']>['diff']>[number];

/** How many of the first differing request's fields the changed request shows. */
export const DIFF_SHOWN = 12;

/** A plain string longer than this, on either side, shows as diffTexts' window of it rather than whole. */
const WHOLE_STRING = 600;

const signed = (lines: readonly JsonLine[], sign: Sign): JsonLine[] => lines.map((l) => ({ ...l, sign }));

/**
 * The first request that differs as one structural diff: each differing field, at most DIFF_SHOWN,
 * a line naming it (`tool_result lookup_policy`, its path on hover), then its two values walked a
 * level under it, a tool's result as the JSON in its string. A plain string past WHOLE_STRING on
 * either side shows as diffTexts' window of it, where the two part.
 */
export function requestLines(diff: readonly DiffEntry[]): JsonLine[] {
  return diff.slice(0, DIFF_SHOWN).flatMap((e) => {
    const long = [e.before, e.after].some((v) => typeof v === 'string' && v.length > WHOLE_STRING && !jsonInString(v));
    const cut = long ? diffTexts(e) : null;
    const [was, now] = cut ? [cut.before, cut.after] : [e.before, e.after];
    const walked = e.op === 'added' ? signed(jsonDiff(now, now), '+') : e.op === 'removed' ? signed(jsonDiff(was, was), '-') : jsonDiff(was, now);
    const head: JsonLine = { sign: ' ', depth: 0, key: e.what ?? e.path, value: [], whole: false, json: false, fold: false, path: e.path, ...(e.what ? { tip: e.path } : {}) };
    return [head, ...walked.map((l) => ({ ...l, depth: l.depth + 1 }))];
  });
}

/** Whether either run is recording now: the comparison is read again as its calls arrive. */
export function comparingLive(live: readonly Pick<LiveRun, 'runId'>[], a: string, b: string): boolean {
  return live.some((l) => l.runId === a || l.runId === b || l.runId.startsWith(a) || l.runId.startsWith(b));
}

/**
 * The runs a picker offers: every run (the newest 300), or in an exported copy of many runs, only
 * those it can be compared with (each run with `with`, which pairs with every other).
 */
export function pickable<R extends { runId: string; startedAt: number }>(runs: readonly R[], other: string, compareWith: string | null | undefined): R[] {
  const newest = [...runs].sort((x, y) => y.startedAt - x.startedAt).slice(0, 300);
  if (!compareWith) return newest;
  const otherIsHub = other === compareWith || compareWith.startsWith(other);
  return otherIsHub ? newest : newest.filter((r) => r.runId === compareWith);
}

/**
 * The pair Compare opens with one run named (`#/compare/<id>`), as the design pairs it: the run
 * with its newest fork, else its newest replay that isn't a test's, else its newest test replay;
 * with none, its parent and it. An attempt bundled under it is never one, nor a run `usable` turns
 * down (one still recording, or one an exported copy doesn't hold). Null when there is no such run:
 * nothing to compare yet.
 */
export function oneRunPair(d: { run: { runId: string }; parent: { runId: string } | null; children: ReadonlyArray<{ runId: string; kind?: string | null; startedAt: number; attempt?: unknown }> }, usable: (runId: string) => boolean = () => true): [string, string] | null {
  const kids = d.children.filter((c) => !c.attempt && usable(c.runId));
  const newest = (list: typeof kids) => [...list].sort((x, y) => y.startedAt - x.startedAt)[0];
  const kid = newest(kids.filter((c) => c.kind === 'fork')) ?? newest(kids.filter((c) => c.kind !== 'test')) ?? newest(kids);
  if (kid) return [d.run.runId, kid.runId];
  return d.parent && usable(d.parent.runId) ? [d.parent.runId, d.run.runId] : null;
}

/** The command that gives a run something to compare with: its replay, with the agent's command for a capture, which has none of its own. */
export function replayCommand(d: { run: { runId: string }; source: string | null }): string {
  return `shadowlap replay ${shortId(d.run.runId)}${d.source ? ' -- <your command>' : ''}`;
}

/** How one side ended after the calls the two runs share (`pair.endings`, fork-changes.ts `pairEnding`). */
type Ending = NonNullable<CompareView['pair']>['endings']['a'];

/**
 * A part of the line a run, each kept whole: the HTTP failures it got (`HTTP 529` `at #19–#21`), a
 * group of its writes, those a replay fenced under their origin's word, each tool with how many
 * times (`twice`, `3 times`), `no write`, then how its turn ended. `http`, a status the part names,
 * is kept on one line: before its words in a failures part, after them where a turn stopped on it.
 */
export type EndingPart = { kind: 'failures'; http: string; words: string } | { kind: 'writes'; fate: 'blocked' | 'stubbed' | null; tools: Array<{ tool: string; times: string | null }> } | { kind: 'words'; words: string; http?: string };

const timesWords = (n: number): string | null => (n === 1 ? null : n === 2 ? 'twice' : `${num(n)} times`);
const callRange = (from: number, to: number): string => (to > from ? `#${num(from)}–#${num(to)}` : `#${num(from)}`);

/** How a turn ended, the status it stopped on apart: `exited 1 at #22`, `stopped at #22 on` `HTTP 529`, `answered at #22`, `ended at #22`, `still running`, `no call`. */
function endPart(end: Ending['end']): { words: string; http?: string } {
  const at = end.callNo !== null ? ` at #${num(end.callNo)}` : '';
  if (end.kind === 'exited') return { words: `${exitWords(typeof end.code === 'number' ? { exitCode: end.code } : {})}${at}` };
  if (end.kind === 'stopped') return typeof end.status === 'number' ? { words: `stopped${at} on`, http: `HTTP ${end.status}` } : { words: `stopped${at}` };
  if (end.kind === 'answered' || end.kind === 'ended') return { words: `${end.kind}${at}` };
  return { words: end.kind === 'running' ? 'still running' : 'no call' };
}

/** How a turn ended: `exited 1 at #22`, `stopped at #22 on HTTP 529`, `answered at #22`, `ended at #22`, `still running`, `no call`. */
export function endWords(end: Ending['end']): string {
  const p = endPart(end);
  return p.http ? `${p.words} ${p.http}` : p.words;
}

/** The line a run's parts, from how it ended after the calls the two share; its checks and its spend follow them. */
export function endingParts(e: Ending): EndingPart[] {
  const parts: EndingPart[] = [];
  if (e.failures) parts.push({ kind: 'failures', http: `HTTP ${e.failures.status}`, words: `at ${callRange(e.failures.from, e.failures.to)}` });
  for (const g of e.writes) parts.push({ kind: 'writes', fate: g.fate, tools: g.tools.map((t) => ({ tool: t.tool, times: timesWords(t.count) })) });
  if (!e.writes.length) parts.push({ kind: 'words', words: 'no write' });
  parts.push({ kind: 'words', ...endPart(e.end) });
  return parts;
}
