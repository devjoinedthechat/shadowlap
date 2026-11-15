import { sameModel } from './decisions.js';
import { isReservedScope } from './judge-scope.js';
import { retirementOf } from './model-retirements.js';
import type { CallRecord } from './types.js';

/**
 * Which recorded models a switch of model changes when `--from` names none, as `shadowlap decisions`
 * and `shadowlap migrate` pick them and a preview's or a migration's estimate prices them: the models
 * the runs' model calls were made with, counted, and from those the default.
 */

/** Whether a model call is one `--scope` asks: made in that scope, or with `none`, in none. shadowlap's own scopes (its judge's) never are. */
export function askedInScope(callScope: unknown, scope: string | null): boolean {
  if (isReservedScope(callScope)) return false;
  if (scope === null) return true;
  const s = typeof callScope === 'string' && callScope ? callScope : null;
  return scope === 'none' ? s === null : s === scope;
}

/** A model the runs' calls were made with: the provider its first call went through, and how many calls. */
export interface ModelUse {
  model: string;
  provider: string | null;
  calls: number;
}

/**
 * The models the runs' model calls were made with, as recorded (the agent's whose request was kept:
 * shadowlap's own scopes left out, and other scopes than `scope`), with how many calls each: most
 * used first.
 */
export function modelUse(runs: Iterable<readonly CallRecord[]>, scope: string | null): ModelUse[] {
  const use = new Map<string, ModelUse>();
  for (const calls of runs) {
    for (const c of calls) {
      if (c.kind !== 'api' || !c.requestRef || !askedInScope(c.meta.scope, scope)) continue;
      const model = c.end?.meta.model ?? c.meta.model ?? null;
      if (!model) continue;
      const had = use.get(model) ?? { model, provider: c.meta.provider ?? c.end?.meta.provider ?? null, calls: 0 };
      had.calls++;
      use.set(model, had);
    }
  }
  return [...use.values()].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
}

/**
 * The recorded models a switch to `to` changes when `--from` names none: for `migrate`, those the
 * retirement table says retire (as of `now`), else the one the runs use most; for `decisions`, the
 * one they use most. Null when the runs name no model.
 */
export function defaultFrom(use: readonly ModelUse[], kind: 'decisions' | 'migrate', to: string | null, now: number): { models: string[]; why: 'retire' | 'most' } | null {
  if (!use.length) return null;
  if (kind === 'migrate') {
    const retiring = use.filter((u) => !(to && sameModel(u.model, to)) && retirementOf(u.provider, u.model, { now }) !== null).map((u) => u.model);
    if (retiring.length) return { models: retiring, why: 'retire' };
  }
  return { models: [use[0]!.model], why: 'most' };
}
