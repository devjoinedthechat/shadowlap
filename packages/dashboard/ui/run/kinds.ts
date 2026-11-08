import { kindCode } from '../../src/call-kinds.js';
import { cutClean, dur } from '../format.js';
import { runType } from '../runs.js';
import type { CallRow, RunDetail } from '../types.js';
import { tokensText } from './calls.js';
import { runLikeOf } from './model.js';

/**
 * What each call was, as a recording's strip, its key and its Timeline draw it: a model call, a read,
 * a write or an error. Every call of a recording or a capture is live, so its origin says nothing
 * there; a replay, a fork and a test keep their origins, where they mean something. Kept out of
 * ui/strip.ts, which the Runs page loads too. No DOM here: the tests import it.
 */

export type Kind = 'k-model' | 'k-read' | 'k-write' | 'k-err';

/** The key's order. */
export const KINDS: readonly Kind[] = ['k-model', 'k-read', 'k-write', 'k-err'];

/** Which call a range of calls marks: an error outranks a write, a write a model call. */
export const KIND_RANK: Readonly<Record<Kind, number>> = { 'k-err': 4, 'k-write': 3, 'k-model': 2, 'k-read': 1 };

export const KIND_NAME: Readonly<Record<Kind, string>> = { 'k-model': 'model call', 'k-read': 'read', 'k-write': 'write', 'k-err': 'error' };

/** The colour token each kind is drawn in, for hover cards. */
export const KIND_COLOR: Readonly<Record<Kind, string>> = { 'k-model': 'var(--k-model)', 'k-read': 'var(--k-read)', 'k-write': 'var(--k-write)', 'k-err': 'var(--k-err)' };

/** A run's `kinds` string, a character a call (call-kinds.ts). */
const KIND_OF_CODE: Readonly<Record<string, Kind>> = { m: 'k-model', r: 'k-read', w: 'k-write', e: 'k-err' };

export type KindCall = Pick<CallRow, 'kind' | 'effect' | 'origin' | 'outcome'>;

export function callKind(c: KindCall): Kind {
  return KIND_OF_CODE[kindCode(c)]!;
}

export function isKind(k: string): k is Kind {
  return k in KIND_RANK;
}

/** A recording or a capture draws its calls by kind; a replay, a fork and a test by origin. */
export function byKind(d: RunDetail): boolean {
  const t = runType(runLikeOf(d));
  return t === 'recording' || t === 'capture';
}

/** A call's kind in words, for its card: a read also says what it read. */
export function kindLabel(c: KindCall & Pick<CallRow, 'input'>): string {
  const k = callKind(c);
  if (k !== 'k-read') return KIND_NAME[k];
  if (c.input) return 'read · input';
  if (c.kind === 'clock') return 'read · clock';
  if (c.kind === 'random') return 'read · random value';
  return c.effect === 'pure' ? 'read · pure' : 'read';
}

/** A call's kind as its name says it: one the fence answered (blocked, stubbed) by what it would have done, never by the error it got. */
export function ownKind(c: KindCall & Pick<CallRow, 'input'>): string {
  if ((c.origin === 'blocked' || c.origin === 'stubbed') && c.kind === 'tool') return KIND_NAME[c.effect === 'write' ? 'k-write' : 'k-read'];
  return kindLabel(c);
}

/** What a call's card says beside its kind: an HTTP error's status, an error to 40 characters, a model call's tokens, else its duration. */
export function kindValue(c: KindCall & Pick<CallRow, 'status' | 'error' | 'usage' | 'latencyMs'>): string {
  if (c.status !== null && c.status >= 400) return `HTTP ${c.status}`;
  const k = callKind(c);
  if (k === 'k-err' && c.error) return cutClean(c.error.replace(/\s+/g, ' ').trim(), 40);
  if (c.kind === 'api') return tokensText(c) || KIND_NAME['k-model'];
  return c.latencyMs !== null ? dur(c.latencyMs) : '—';
}

/** A kind's word beside a count of calls, plural but for one: `model calls 14`, `write 1`. */
export function kindWords(k: Kind, n: number): string {
  return n === 1 ? KIND_NAME[k] : `${KIND_NAME[k]}s`;
}

/** A run's `kinds` string, a kind a call; null when absent or unreadable, so the page falls back to what it has read. */
export function parseKinds(v: unknown): Kind[] | null {
  if (typeof v !== 'string') return null;
  const out: Kind[] = [];
  for (const ch of v) {
    const k = KIND_OF_CODE[ch];
    if (!k) return null;
    out.push(k);
  }
  return out;
}
