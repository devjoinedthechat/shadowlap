import { num, plural } from '../format.js';
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
  const codeChanged = (ch.code.a ?? '') !== (ch.code.b ?? '');
  const code = codeChanged ? codeNote(c.code) : { note: ch.code.a ?? 'no revision recorded', tip: null };
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

/** The line beside the identical prefix: how far the runs agree, and where they part. */
export function prefixLine(c: Pick<CompareView, 'identicalPrefix' | 'firstRequestDifference' | 'responseDifferences' | 'onlyInA' | 'onlyInB'>): { lead: string; rest: string } {
  const n = c.identicalPrefix;
  const first = c.firstRequestDifference?.callNo ?? null;
  const answers = c.responseDifferences.length;
  const lead = n ? `#1–#${num(n)} identical.` : 'No identical prefix.';
  if (first) return { lead, rest: `The first request that differs is #${first}${answers ? `; before it, ${plural(answers, 'call')} got a different answer to the same request` : ''}.` };
  if (answers) return { lead, rest: `Every request matches; ${plural(answers, 'call')} got a different answer.` };
  if (c.onlyInA || c.onlyInB) return { lead, rest: 'Every request they share matches.' };
  return { lead, rest: 'Every call matches.' };
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
