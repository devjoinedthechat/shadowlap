import { callName, dur, ktok } from '../format.js';
import { displayOrigin, isFailure, type Origin7 } from '../origins.js';
import { recordedDuration, type CallIndex } from '../recorded.js';
import { inScope, scopeOnly } from '../scopes.js';

/**
 * Each call's line in the run page's views: its detail, its result, its time, the turn it belongs
 * to and its place on the clock. Typed by shape, with no DOM and no API module, so the tests import it.
 */

export interface CallLike {
  callNo: number;
  kind: string;
  name: string;
  origin: string;
  effect: string | null;
  outcome: 'ok' | 'error' | null;
  status: number | null;
  latencyMs: number | null;
  model: string | null;
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  detail: string;
  attempts: number;
  replayedFrom: number | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  ttftMs: number | null;
  scope: string | null;
  /** The agent that made it, as the server names it (agents.ts); absent from an older server's rows. */
  agent?: string | null;
  /** A judge's call: the check it answered and the verdict the run kept of it. */
  judge?: { check: string; verdict: 'yes' | 'no' | null };
  recordedMs?: number | null;
  resultShort?: string | null;
  /** A model call: the tools its answer asked for, as the server reads them from the response. */
  asks?: readonly string[] | null;
}

export function originOf(c: Pick<CallLike, 'origin' | 'outcome'>): Origin7 {
  return displayOrigin(c);
}

/** Model calls in a scope (every model call without one), in order. */
export function modelCalls<C extends Pick<CallLike, 'kind' | 'scope' | 'callNo'>>(calls: readonly C[], scope: string | null | undefined): C[] {
  return calls.filter((c) => c.kind === 'api' && (!scope || inScope(c, scope, scopeOnly)));
}

/** Which model call a call is among the model calls of its scope: k of m, or null when it is not one. */
export function modelCallOf(calls: ReadonlyArray<Pick<CallLike, 'kind' | 'scope' | 'callNo'>>, callNo: number, scope: string | null | undefined): { k: number; m: number } | null {
  const ms = modelCalls(calls, scope);
  const k = ms.findIndex((c) => c.callNo === callNo) + 1;
  return k ? { k, m: ms.length } : null;
}

/** Tokens in and out, as `3.0k → 80`. */
export function tokensText(c: Pick<CallLike, 'kind' | 'usage'>): string {
  if (c.kind !== 'api' || !c.usage) return '';
  return `${ktok(c.usage.input + c.usage.cacheRead + c.usage.cacheWrite)} → ${ktok(c.usage.output)}`;
}

/** A failed call's error without the status the note already says, so `HTTP 529: Overloaded` names 529 once. */
function errorWords(c: Pick<CallLike, 'status' | 'error'>): string {
  const e = (c.error ?? '').trim();
  return (c.status ? e.replace(new RegExp(`^(HTTP\\s*)?${c.status}\\b[\\s:·.-]*`, 'i'), '') : e).replace(/\.+$/, '');
}

/** Why a call failed, in a sentence: the provider's status and error, the error alone, or that it ended in one. */
export function failedWhy(c: Pick<CallLike, 'status' | 'error'>): string {
  const why = errorWords(c);
  if (c.status) return `The provider answered HTTP ${c.status}${why ? `: ${why}` : ''}.`;
  return why ? `${why}.` : 'The call ended in an error.';
}

/** A model call an offline replay refused: not in the recording, so it got HTTP 503 instead of reaching the provider. */
export function refusedOffline(c: Pick<CallLike, 'status' | 'error'>): boolean {
  return c.status === 503 && /\boffline\b/i.test(c.error ?? '');
}

/** Who answered a failed model call: shadowlap (`--fail-at`), an offline replay that refused it, or the provider. */
export type FailedBy = 'injected' | 'offline' | 'provider';

/** Who answered a failed model call, by its detail: one shadowlap answered keeps `injected` as its origin. */
export const failedBy = (c: Pick<CallLike, 'origin' | 'status' | 'error'>): FailedBy => (c.origin === 'injected' ? 'injected' : refusedOffline(c) ? 'offline' : 'provider');

/**
 * A failed model call's note, as the inspector leads with it (CallNote, which then says what its
 * view shows) and Compare's opened row says it: its word, then why, in parts, the flag shadowlap
 * answered with as code (`--fail-at 19=529` where the fork's flag is one) and the attempts it took;
 * an error-path preset's attempt, the preset that played in (`played`).
 */
export function failureNote(c: Pick<CallLike, 'status' | 'error' | 'attempts'>, by: FailedBy, flag: string | null, played: string | null = null): { word: string; why: Array<string | { code: string }> } {
  const tries = c.attempts ? `, ${c.attempts + 1} attempts` : '';
  // An error-path preset's attempt names its preset, in place of the flag.
  if (by === 'injected' && played) return { word: 'Never sent.', why: [`The ${played} preset answered with HTTP ${c.status ?? '?'}${tries}.`] };
  if (by === 'injected') return { word: 'Never sent.', why: [`shadowlap answered with HTTP ${c.status ?? '?'} (`, { code: flag && /^--fail-at\b/.test(flag) ? flag : '--fail-at' }, `)${tries}.`] };
  if (by === 'offline') return { word: 'Refused.', why: [`The replay is offline and this request is not in the recording, so it got HTTP ${c.status ?? '?'}.`] };
  return { word: 'Failed.', why: [failedWhy(c)] };
}

/**
 * The tools each model call asked for, by the calls the run made for it (`requestedBy`), as the Calls
 * view words them: `search_web, read_file`, a tool asked for more than once with its count.
 */
export function askedTools(calls: ReadonlyArray<{ callNo: number; kind: string; name: string; requestedBy?: number | null }>): Map<number, string> {
  const by = new Map<number, string[]>();
  for (const c of calls) {
    if (c.kind !== 'tool' || c.requestedBy === null || c.requestedBy === undefined) continue;
    by.set(c.requestedBy, [...(by.get(c.requestedBy) ?? []), c.name]);
  }
  return new Map([...by].map(([n, names]) => [n, toolNames(names)]));
}

/** Tool names as a call's line lists them: each once, in order, with how many times past one (`lookup ×2`). */
export function toolNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name)).join(', ');
}

/**
 * The detail beside a call's name: a model call's HTTP failure, the tools it asked for (`→ search_web`)
 * or its stop reason; a tool's arguments; the value a clock read or a random value gave.
 */
export function callDetail(c: CallLike, asked?: string | null): { text: string; err: boolean } {
  if (c.kind === 'api') {
    if (c.outcome === 'error') return { text: c.status ? `HTTP ${c.status}${c.attempts ? ` · ${c.attempts + 1} attempts` : refusedOffline(c) ? ' · refused offline' : ''}` : (c.error ?? 'error'), err: true };
    // A judge's call, by its check and the verdict it gave: `judge "explains" · no`.
    if (c.judge) return { text: `judge "${c.judge.check}"${c.judge.verdict ? ` · ${c.judge.verdict}` : ''}`, err: false };
    if (asked) return { text: `→ ${asked}`, err: false };
    // No tool call of the run says this model call asked for it (a capture records none, a tool that
    // isn't wrapped leaves none): the answer does.
    if (c.asks?.length) return { text: `→ ${toolNames(c.asks)}`, err: false };
    // Known to have asked for nothing: how it stopped, with what it answered on the line under it
    // (resultLine). Not known (an older server): the model too.
    return { text: (asked === undefined && !c.asks ? [c.model, c.stopReason] : [c.stopReason]).filter(Boolean).join(' · '), err: false };
  }
  if (c.kind === 'clock' || c.kind === 'random') return { text: c.resultShort ?? c.detail, err: false };
  if (c.error && c.origin !== 'blocked' && c.origin !== 'stubbed') return { text: c.detail || c.error, err: false };
  return { text: c.detail, err: false };
}

/**
 * What a call came back with, on the line under it: a tool's short result, or what fenced it; for a
 * model call that asked for no tool, what it answered (the agent's final answer), as the server
 * reads it from the response.
 */
export function resultLine(c: CallLike): { text: string; err: boolean; blocked?: true } | null {
  if (c.kind === 'api') return c.outcome !== 'error' && c.resultShort && !c.asks?.length ? { text: c.resultShort, err: false } : null;
  if (c.kind !== 'tool') return null;
  // shadowlap's fence, not a failure: drawn in the blocked grey, never the red of what failed.
  if (c.origin === 'blocked') return { text: 'blocked', err: false, blocked: true };
  // The server's line already says `stubbed …` for a write its stand-in answered.
  if (c.resultShort) return { text: c.resultShort, err: false };
  if (c.origin === 'stubbed') return { text: 'stubbed', err: false };
  if (isFailure(c) && c.error) return { text: c.error, err: true };
  return null;
}

/** A call's time: its own, or for a replayed call its recorded duration, which the replay did not wait for. */
export function timeOf(c: CallLike, ancestors: readonly CallIndex[], live: boolean): { text: string; was: boolean } {
  if (c.origin === 'replayed') {
    const ms = recordedDuration(c, ancestors);
    // A clock or random read records no duration: blank, as on the run it was recorded in.
    if (ms === null && (c.kind === 'clock' || c.kind === 'random')) return { text: '', was: true };
    return { text: ms === null ? '—' : dur(ms), was: true };
  }
  if (c.latencyMs !== null) return { text: dur(c.latencyMs), was: false };
  return { text: c.outcome === null && live ? '…' : '', was: false };
}

/**
 * The call each message of a conversation came from, by the message's place in it: a tool result is
 * the tool call with its tool-use id, and an assistant message that asks for a tool is the model call
 * that asked. Needs the server to name each tool call's id and the model call that asked for it;
 * without, the map is empty.
 */
export function turnCalls(
  turns: ReadonlyArray<{ role: string; blocks: ReadonlyArray<{ type: string; id?: string | undefined }> }>,
  calls: ReadonlyArray<{ callNo: number; kind: string; toolUseId?: string | null; requestedBy?: number | null }>,
): Map<number, number> {
  const byId = new Map<string, { callNo: number; requestedBy: number | null }>();
  for (const c of calls) if (c.kind === 'tool' && c.toolUseId) byId.set(c.toolUseId, { callNo: c.callNo, requestedBy: c.requestedBy ?? null });
  const out = new Map<number, number>();
  if (!byId.size) return out;
  turns.forEach((t, i) => {
    for (const b of t.blocks) {
      const hit = b.id ? byId.get(b.id) : undefined;
      if (!hit) continue;
      if (t.role === 'tool' && b.type === 'tool_result') {
        out.set(i, hit.callNo);
        return;
      }
      if (t.role === 'assistant' && b.type === 'tool_call' && hit.requestedBy !== null) {
        out.set(i, hit.requestedBy);
        return;
      }
    }
  });
  return out;
}

export function callTitle(c: Pick<CallLike, 'callNo' | 'kind' | 'name'>): string {
  return `#${c.callNo} ${callName(c.kind, c.name)}`;
}

/**
 * Where a call that is not a model call sits in its own conversation, for its Conversation tab: the
 * model call that asked for it, else the one whose request the server shows for it (the latest before
 * it in the same conversation, or the first after it for a call made before its conversation's first
 * model call); in a batch, which conversation. Null when the server names none: never a guess from
 * the order of calls, which in a batch can be another ticket's.
 */
export function conversationLink(
  call: { callNo: number; kind: string; requestedBy?: number | null; conversation?: number | null },
  conv: { fromCallNo: number; n?: number | null } | null,
  calls: ReadonlyArray<{ conversation?: number | null }>,
): { callNo: number; text: string } | null {
  if (call.kind === 'api') return null;
  const by = call.requestedBy ?? null;
  const at = by ?? conv?.fromCallNo ?? null;
  if (at === null || at === call.callNo) return null;
  const all = calls.reduce((n, x) => Math.max(n, x.conversation ?? 0), 0);
  const n = conv?.n ?? call.conversation ?? null;
  const which = n && all > 1 ? ` · conversation ${n.toLocaleString('en-US')} of ${all.toLocaleString('en-US')}` : '';
  // Made before its conversation's first model call: the server knows the order, not that the call reads it.
  const how = by !== null ? `Asked for by #${by}` : at > call.callNo ? `Before #${at}, its conversation’s first model call` : `After #${at}`;
  return { callNo: at, text: `${how}${which}` };
}
