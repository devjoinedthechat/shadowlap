import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentCallsOf, comparePair, forkEnd, loadApiRequest, normalizeConversation, type CallRecord, type DivergenceReport, type Normalizer, type RunRecord, type StoreOf } from '@shadowlap/engine';

/**
 * A golden's accepted changes: who replaced it, when and why, kept beside its pack in
 * `accepted.jsonl`, one JSON object a line, the oldest first. `shadowlap test --update --reason`
 * adds one when it replaces the golden, and `shadowlap fix apply` one for each golden it copies,
 * with the fix as the reason.
 *
 * A snapshot that is re-recorded says what the agent does and never why. The reason kept here is
 * read back when a later change takes out what an accepted one put in: `shadowlap test` then names
 * the sentence, who accepted it and why it is there, before anyone updates the golden again.
 *
 * The sentences a change added to the system prompt are kept as hashes, never as text: a golden's
 * pack is written under the project's redaction rules, and this file is no way around them. The
 * sentence is shown from the diverging request itself, which the report prints anyway.
 */
export const ACCEPTED_FILE = 'accepted.jsonl';

export interface Acceptance {
  /** When it was accepted, as an ISO date and time. */
  at: string;
  /** Who accepted it (resolveAuthor), or null where no one is named. */
  by: string | null;
  reason: string;
  /** The recording it replaced, null for a golden made by a fix. */
  from: string | null;
  /** The recording accepted. */
  to: string;
  /** The code it was accepted at. */
  code: string | null;
  /** The fix it came with (`fx-…`). */
  fix?: string;
  /** What the agent sends differently, in words (requestChanges). */
  changed: string[];
  /** What the agent decides differently, most consequential first (decidesOtherwise). */
  decides: string[];
  /** A hash of each sentence the change added to the system prompt. */
  added: string[];
}

/** The most sentences of one change that are kept: a prompt rewritten whole is no list of reasons. */
const MAX_ADDED = 200;

const isAcceptance = (v: unknown): v is Acceptance => {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return typeof a.at === 'string' && typeof a.reason === 'string' && typeof a.to === 'string' && Array.isArray(a.added) && a.added.every((h) => typeof h === 'string');
};

/** A golden's accepted changes, the oldest first. A line that is no acceptance is skipped: the file is edited by merges. */
export function readAcceptances(dir: string): Acceptance[] {
  const file = join(dir, ACCEPTED_FILE);
  if (!existsSync(file)) return [];
  const out: Acceptance[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isAcceptance(parsed)) out.push({ ...parsed, by: typeof parsed.by === 'string' ? parsed.by : null, changed: Array.isArray(parsed.changed) ? parsed.changed : [], decides: Array.isArray(parsed.decides) ? parsed.decides : [] });
    } catch {
      // a line a merge left half-written says nothing
    }
  }
  return out;
}

/** Adds an accepted change to a golden's list. */
export function appendAcceptance(dir: string, acceptance: Acceptance): void {
  appendFileSync(join(dir, ACCEPTED_FILE), `${JSON.stringify(acceptance)}\n`);
}

/** A prompt's sentences: each line, and each sentence in it, with its spaces collapsed. */
export function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

const hashOf = (sentence: string) => createHash('sha256').update(sentence).digest('hex').slice(0, 16);

/** The system prompt a run's agent sent with its first model call, as text: the instructions its conversation starts with. */
export function systemPromptOf(store: StoreOf<'recording'>, calls: readonly CallRecord[]): string {
  for (const c of agentCallsOf([...calls])) {
    if (c.kind !== 'api' || !c.requestRef) continue;
    try {
      const conv = normalizeConversation(loadApiRequest(store, c.requestRef));
      if (!conv) continue;
      const firstOther = conv.turns.findIndex((t) => t.role !== 'system');
      const leading = firstOther === -1 ? conv.turns : conv.turns.slice(0, firstOther);
      return leading.flatMap((t) => t.blocks.map((b) => (b.type === 'text' ? b.text : ''))).join('\n');
    } catch {
      // an unreadable request has no prompt to read
    }
  }
  return '';
}

/** A hash of each sentence `after` has that `before` lacks. */
export function addedSentences(before: string, after: string): string[] {
  const had = new Set(sentences(before));
  return [...new Set(sentences(after).filter((s) => !had.has(s)))].slice(0, MAX_ADDED).map(hashOf);
}

/**
 * What the accepted recording decides differently from the one it replaces, in words, the most
 * consequential first: a write made or no longer made, then reads, then the words of its answer.
 * Both passed their checks, so how they ended is no difference.
 */
export function decidesOtherwise(store: StoreOf<'recording'>, before: RunRecord, after: RunRecord, normalizers: readonly Normalizer[] = []): string[] {
  try {
    const ended = { a: forkEnd(before.status, { kind: 'none' }), b: forkEnd(after.status, { kind: 'none' }) };
    const comparison = comparePair(store, before, after, { a: 1, b: 1 }, ended, { normalizers });
    return comparison.changes.filter((c) => c.kind !== 'ended').map((c) => c.detail);
  } catch {
    return [];
  }
}

export interface TakenOut {
  /** The sentence the diverging request no longer has. */
  sentence: string;
  /** The accepted change that put it in. */
  acceptance: Acceptance;
}

const textOf = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : (JSON.stringify(v) ?? ''));

/**
 * The sentences a diverging request takes out that an accepted change put in, each with that
 * change, the latest acceptance to add a sentence first. Read from the divergence's own diff: a
 * sentence its recorded side has and its sent side lacks.
 */
export function takenOut(divergence: DivergenceReport | null | undefined, acceptances: readonly Acceptance[]): TakenOut[] {
  if (!divergence?.diff?.length || !acceptances.some((a) => a.added.length)) return [];
  const by = new Map<string, Acceptance>();
  for (const a of acceptances) for (const h of a.added) by.set(h, a);
  const out: TakenOut[] = [];
  const seen = new Set<string>();
  for (const entry of divergence.diff) {
    if (entry.op === 'added') continue;
    const kept = new Set(sentences(textOf(entry.after)));
    for (const sentence of sentences(textOf(entry.before))) {
      if (kept.has(sentence) || seen.has(sentence)) continue;
      const acceptance = by.get(hashOf(sentence));
      if (!acceptance) continue;
      seen.add(sentence);
      out.push({ sentence, acceptance });
    }
  }
  return out;
}

/** An accepted change in a line: `accepted 2026-11-14 by dev@example.com: <reason> (fix fx-01M3…)`. */
export function acceptanceLine(a: Acceptance): string {
  return `accepted ${a.at.slice(0, 10)}${a.by ? ` by ${a.by}` : ''}: ${a.reason}${a.fix ? ` (fix ${a.fix})` : ''}`;
}
