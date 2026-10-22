import { clip, jsonText, num, plural, shortId } from '../format.js';
import { kindWord, type RunLike } from '../runs.js';
import type { CallRow, CodeChange, CompareView, LiveRun } from '../types.js';

/**
 * Compare's logic (`pages/Compare.tsx`), without the DOM so the tests import it: what the four
 * change cards say, which calls after the fork the other run made too, the prefix line, which runs
 * the pickers offer, and when the comparison is read again.
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
  const code = codeChanged ? codeNote(c.code) : { note: ch.code.a ?? 'no revision recorded', tip: sameCommit ? `The same commit, named ${ch.code.a} in one run and ${ch.code.b} in the other.` : null };
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
    { key: 'system prompt', changed: ch.systemPrompt, title: ch.systemPrompt ? 'changed' : 'unchanged', note: promptNote, tip: !ch.systemPrompt && prompts?.length === 1 ? `The same system prompt, sha256 ${prompts[0]}` : null },
    { key: 'tools', changed: toolsChanged, title: toolsChanged ? 'changed' : 'unchanged', note: toolNote, tip: toolTip },
    { key: 'model', changed: modelsChanged, title: modelsChanged ? `${ch.models.a.join(', ') || 'none'} → ${ch.models.b.join(', ') || 'none'}` : 'unchanged', note: modelsChanged ? 'different model' : ch.models.a.join(', ') || 'no model call', tip: null },
  ];
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

/** The line beside the identical prefix: how far the runs agree, and where they part. */
export function prefixLine(c: Pick<CompareView, 'identicalPrefix' | 'firstRequestDifference' | 'responseDifferences' | 'onlyInA' | 'onlyInB'>): { lead: string; rest: string } {
  const n = c.identicalPrefix;
  const first = c.firstRequestDifference?.callNo ?? null;
  const lead = n ? `#1–#${num(n)} identical.` : 'No identical prefix.';
  if (first) {
    const answered = answeredLine(c, true);
    return { lead, rest: `The first request that differs is #${first}${answered ? `; before it, ${answered}` : ''}.` };
  }
  // A run that went on past the other's end (one still recording): only the requests both made match.
  const shared = c.onlyInA || c.onlyInB ? 'Every request they share matches' : 'Every request matches';
  const answered = answeredLine(c, false);
  if (answered) return { lead, rest: `${shared}; ${answered}.` };
  if (c.onlyInA || c.onlyInB) return { lead, rest: `${shared}.` };
  return { lead, rest: 'Every call matches.' };
}

/** The line beside "Same request, different answer": how many calls, and before which request when one differs. */
export function answersSub(c: Pick<CompareView, 'firstRequestDifference' | 'responseDifferences'>): string {
  const n = plural(changedAnswers(c).length, 'call');
  return c.firstRequestDifference ? `${n}, before the first request that differs` : n;
}

type PathCall = Pick<CallRow, 'callNo' | 'kind' | 'name' | 'detail'>;

/** What a model call asked for: the tool calls that follow it until the next model call, with their arguments. */
function askedFor(calls: readonly PathCall[], i: number): string {
  const out: string[] = [];
  for (let j = i + 1; j < calls.length && calls[j]!.kind !== 'api'; j++) if (calls[j]!.kind === 'tool') out.push(`${calls[j]!.name}(${calls[j]!.detail})`);
  return out.join('\n');
}

/**
 * Which calls of a run's path after the fork the other run made too, at the same place: a tool
 * with the same arguments, or a model call that asked for the same tools (two final answers are
 * the same place). The mock dims those rows, so what differs stands out. The call where the
 * requests first differ (`first`) is never the same, whatever its name.
 */
export function samePlaces(calls: readonly PathCall[], other: readonly PathCall[], first: number | null): boolean[] {
  return calls.map((c, i) => {
    const o = other[i];
    if (!o || c.callNo === first || o.kind !== c.kind || o.name !== c.name) return false;
    if (c.kind === 'api') return askedFor(calls, i) === askedFor(other, i);
    return o.detail === c.detail;
  });
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

/** A run as the pickers list it, in the words every list uses: `01K5CQ4N7G · recording`, `01K5CQ4P2R · fork @17`, `01K5CQ4N9A · clean replay`. */
export function pickerLabel(r: RunLike): string {
  return `${shortId(r.runId)} · ${kindWord(r)}`;
}
