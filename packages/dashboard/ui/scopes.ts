/**
 * The agents of a run, as the views group and narrow its calls: each call's agent as the server
 * names it (the engine's agents.ts: the scope its author gave, a trace's agent, a sub-agent a tool
 * started, an agent told by its system prompt), else its scope: `agent`, `agent/policy-checker`,
 * `customer`. Picking one narrows every view to it and the agents nested in it. Blame is scoped by
 * scope (`scope()` in the SDKs), so its hint reads scopes alone. Shadowlap's own scopes (its judge's,
 * `shadowlap:judge`) are no agent and nothing to blame by: they get no agent's chip. A judge's calls
 * are the check's, kept out of All and its counts: they have a chip of their own, `judge`, after the
 * agents', which shows the bar for them alone, and no fork starts at one (`forksAt`). No DOM here:
 * the tests import it.
 */

import { isReservedScope, JUDGE_SCOPE } from '../../engine/src/judge-scope.js';

export interface ScopedCall {
  callNo: number;
  scope?: string | null;
  agent?: string | null;
}

/** The agent a call is grouped by: the one the server names, else its scope. */
export const agentOf = (c: ScopedCall): string | null => c.agent ?? c.scope ?? null;
/** A call's scope alone, which blame is scoped by. */
export const scopeOnly = (c: ScopedCall): string | null => c.scope ?? null;

/** Whether Shadowlap's judge made a call, by the agent the server names it (its scope, `shadowlap:judge`): the judge chip's, never the agent's. */
export const isJudge = (c: ScopedCall): boolean => agentOf(c) === JUDGE_SCOPE;

/**
 * The numbers of a run's judge's calls: its rows' (isJudge), and while a long run's pages come the
 * server's (`judgeCalls`), which names those on pages not read yet. What the judge's chip holds, and
 * what All, its counts, a fork and where a run opens (open-at.ts) leave out.
 */
export function judgeNumbers(calls: readonly ScopedCall[], server: readonly number[] | null = null): Set<number> {
  const out = new Set(server);
  for (const c of calls) if (isJudge(c)) out.add(c.callNo);
  return out;
}

/** Whether a fork can start at a call: the one rule the row's Fork, the head's and ⌘K's read. Never at a judge's call, which is the check's. */
export const forksAt = (c: ScopedCall): boolean => !isJudge(c);

/** Why the head's Fork waits at a call no fork starts at (forksAt), and its card's line. */
export interface ForkWait {
  why: string;
  card: string;
}

const JUDGE_FORK: ForkWait = { why: 'A judge’s call can’t be forked', card: 'A judge’s call is the check’s, not the agent’s: no fork starts at it' };

/** Why no fork starts at the selected call: a judge's; null for any other call, or none. */
export const judgeForkWait = (c: ScopedCall | null): ForkWait | null => (c && !forksAt(c) ? JUDGE_FORK : null);

/** Whether a scope is the agent's, not one Shadowlap makes calls in itself (isReservedScope). */
const theirs = (s: string | null): s is string => !!s && !isReservedScope(s);

/** Every scope in the order it first appears. */
export function scopesOf(calls: readonly ScopedCall[], by = agentOf): string[] {
  const out: string[] = [];
  for (const c of calls) {
    const s = by(c);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The chips of the scopes the run's author gave, alone: what blame can be scoped by. */
export const realScopes = (calls: readonly ScopedCall[]): string[] => scopeChips(calls, scopeOnly);

/** Whether the views name a run's agents: a scope its author gave, or two agents or more, Shadowlap's own scopes aside. */
export const ownAgents = (calls: readonly ScopedCall[]): boolean => calls.some((c) => theirs(scopeOnly(c))) || scopesOf(calls).filter(theirs).length > 1;

/** Whether the run shows the agents' bar: for its own agents (`ownAgents`), or for a judge's calls, which the bar keeps apart. */
export const agentsShown = (calls: readonly ScopedCall[]): boolean => ownAgents(calls) || calls.some(isJudge);

/**
 * The scope chips, as a tree: every scope but Shadowlap's own, each nested one right after the scope
 * it sits in, which gets a chip of its own even when no call was made in it directly (`writer/review`
 * brings `writer`). Siblings keep the order they first appear in.
 */
export function scopeChips(calls: readonly ScopedCall[], by = agentOf): string[] {
  const first = new Map<string, number>();
  scopesOf(calls, by).filter(theirs).forEach((s, i) => {
    const parts = s.split('/');
    for (let k = 1; k <= parts.length; k++) {
      const p = parts.slice(0, k).join('/');
      if (!first.has(p)) first.set(p, i);
    }
  });
  const all = [...first.keys()];
  const depth = (s: string) => s.split('/').length;
  const kids = (parent: string | null) =>
    all.filter((s) => (parent === null ? depth(s) === 1 : depth(s) === depth(parent) + 1 && s.startsWith(`${parent}/`))).sort((a, b) => first.get(a)! - first.get(b)!);
  const out: string[] = [];
  const walk = (parent: string | null) => {
    for (const s of kids(parent)) {
      out.push(s);
      walk(s);
    }
  };
  walk(null);
  return out;
}

/** Whether a call is in a scope or one nested in it; `all` takes every call but the judge's. */
export function inScope(c: ScopedCall, scope: string, by = agentOf): boolean {
  if (scope === 'all') return by(c) !== JUDGE_SCOPE;
  const s = by(c) ?? '';
  return s === scope || s.startsWith(`${scope}/`);
}

export function scopeCount(calls: readonly ScopedCall[], scope: string): number {
  let n = 0;
  for (const c of calls) if (inScope(c, scope)) n++;
  return n;
}

/** How deep a scope is nested: `agent` is 0, `agent/policy-checker` is 1. */
export function scopeDepth(scope: string): number {
  return scope.split('/').length - 1;
}

export function scopeLeaf(scope: string): string {
  return scope.split('/').pop() ?? scope;
}

/**
 * The scope the run page suggests blaming within, when none is picked: the top-level scope that acts
 * (one that hands work to a scope nested in it, else the one with the most tool calls), so a model
 * that plays the user in an eval is not what blame asks again. The first top-level scope otherwise.
 */
export function blameScope(calls: ReadonlyArray<ScopedCall & { kind?: string }>, chips: readonly string[]): string | null {
  const top = chips.filter((s) => scopeDepth(s) === 0);
  if (!top.length) return chips[0] ?? null;
  const nests = top.filter((s) => chips.some((c) => c.startsWith(`${s}/`)));
  const pool = nests.length ? nests : top;
  const tools = (s: string) => calls.filter((c) => c.kind === 'tool' && inScope(c, s, scopeOnly)).length;
  return pool.reduce((best, s) => (tools(s) > tools(best) ? s : best), pool[0]!);
}

/**
 * The scope bar's blame hint: the scope to blame within, and why in a few words. With a scope
 * picked, that one. Otherwise the scope that acts (blameScope), and when the run's only other
 * top-level scope makes no tool calls, a model that plays the user as in an eval, that it answers
 * that one: "Blame only the agent, not the customer it answers", as the design says.
 */
export function scopeHint(calls: ReadonlyArray<ScopedCall & { kind?: string }>, chips: readonly string[], picked: string): { lead: string; scope: string } | null {
  if (chips.includes(picked)) return { lead: 'Blame within this scope', scope: picked };
  const scope = blameScope(calls, chips);
  if (!scope) return null;
  const others = chips.filter((s) => scopeDepth(s) === 0 && s !== scope);
  const user = others.length === 1 && !calls.some((c) => c.kind === 'tool' && inScope(c, others[0]!, scopeOnly)) ? others[0]! : null;
  return { lead: user ? `Blame only the ${scopeLeaf(scope)}, not the ${scopeLeaf(user)} it answers` : 'Blame within one scope', scope };
}
