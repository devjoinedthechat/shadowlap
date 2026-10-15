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
