/**
 * Scopes name the branch of an agent a call was made in (`scope()` in the SDKs): `agent`,
 * `agent/policy-checker`, `customer`. Picking one narrows every view to it and the scopes nested in
 * it. No DOM here: the tests import it.
 */

export interface ScopedCall {
  callNo: number;
  scope?: string | null;
}

/** Every scope in the order it first appears. */
export function scopesOf(calls: readonly ScopedCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) if (c.scope && !out.includes(c.scope)) out.push(c.scope);
  return out;
}

/**
 * The scope chips, as a tree: every scope, each nested one right after the scope it sits in, which
 * gets a chip of its own even when no call was made in it directly (`writer/review` brings `writer`).
 * Siblings keep the order they first appear in.
 */
export function scopeChips(calls: readonly ScopedCall[]): string[] {
  const first = new Map<string, number>();
  scopesOf(calls).forEach((s, i) => {
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

/** Whether a call is in a scope or one nested in it; `all` takes every call. */
export function inScope(c: ScopedCall, scope: string): boolean {
  if (scope === 'all') return true;
  const s = c.scope ?? '';
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
  const tools = (s: string) => calls.filter((c) => c.kind === 'tool' && inScope(c, s)).length;
  return pool.reduce((best, s) => (tools(s) > tools(best) ? s : best), pool[0]!);
}

/**
 * The scope bar's blame hint: the scope to blame within, and why in a few words. With a scope
 * picked, that one. Otherwise the scope that acts (blameScope), and when the run's only other
 * top-level scope makes no tool calls, a model that plays the user as in an eval, that it answers
 * that one: "Blame only the agent, not the customer it answers", as the design says.
 */
export function scopeHint(calls: ReadonlyArray<ScopedCall & { kind?: string }>, chips: readonly string[], picked: string): { lead: string; scope: string } | null {
  if (picked !== 'all') return { lead: 'Blame within this scope', scope: picked };
  const scope = blameScope(calls, chips);
  if (!scope) return null;
  const others = chips.filter((s) => scopeDepth(s) === 0 && s !== scope);
  const user = others.length === 1 && !calls.some((c) => c.kind === 'tool' && inScope(c, others[0]!)) ? others[0]! : null;
  return { lead: user ? `Blame only the ${scopeLeaf(scope)}, not the ${scopeLeaf(user)} it answers` : 'Blame within one scope', scope };
}
