import { CONTROL_MIN_SAMPLES } from '../control-arm.js';
import { modelFamily, sameModel, type DecisionRun } from '../decisions.js';
import { estimateCost } from '../prices.js';
import { askedInScope } from '../switch-from.js';
import { counted, noEstimate, noPriceWords, type Estimate, type PricedCall, type Prices } from './estimate.js';
import { amountWords } from './spending.js';
import { verifyCeiling, verifyParts, type VerifyRule, type VerifyRunCost } from './verify.js';

/**
 * What Changes' jobs bill. A preview (`shadowlap decisions`) asks each recorded model call the change
 * touches again, every sample, and from 3 samples on as many again as recorded (the control arm), no
 * tool running: about what those calls cost at the asked model's price. Its verify, and a
 * migration's, can't know before it asks which runs change, so a migration is priced at its ceiling:
 * the switched calls asked again, then every run they touch verified to its gate's limit. Which
 * recorded models a switch changes, when `--from` names none, is the commands' own pick
 * (switch-from.ts defaultFrom), which the caller gives as `from`.
 */

/** Samples a preview asks a call unless told otherwise (`decisions --samples 3`); a migration asks once (`migrate --samples 1`). */
export const PREVIEW_SAMPLES = 3;
export const MIGRATE_SAMPLES = 1;

/** A preview's change: `--model`, the recorded models it switches from, `--from-code`. */
export interface PreviewChange {
  /** `--model`: the model the calls it switches are asked of. */
  model?: string | null;
  /**
   * The recorded models it switches from: `--from`, else defaultFrom's for a switch of model, as
   * `decisions` picks them; null for a change of every call (a change of fields alone).
   */
  from: readonly string[] | null;
  /**
   * `--from-code`: the prompt and tools in the working tree. Which calls they change is known only
   * once the preview has replayed the working tree offline, so it has no estimate before it runs.
   */
  fromCode?: boolean;
}

export interface PreviewOptions {
  samples?: number;
  /** Ask the control arm whatever the samples (`--control`); by default from 3 samples on. */
  control?: boolean;
  /** `--scope`: only calls made in it; `none`, those made in none. */
  scope?: string | null;
  prices?: Prices;
}

/** A call a preview may ask, as decisions plans it: the agent's, in `scope` (exactly it; `none`, none), its request kept and its answer recorded. */
function askable(c: PricedCall, scope: string | null | undefined): boolean {
  return !c.judge && c.request && c.answered && askedInScope(c.scope, scope ?? null);
}

/** Whether a switch to `model` carries a call made with another: a request of another family's shape can't be, so decisions skips it. */
function sameFamily(c: PricedCall, model: string | null): boolean {
  const was = modelFamily(c.model);
  const now = modelFamily(model);
  return !was || !now || was === now;
}

/** Whether a change asks a call again: one made with a model it switches from (any, without `from`), that the switch carries. */
function switchedTo(c: PricedCall, from: readonly string[] | null, model: string | null): boolean {
  return (!from || from.some((m) => sameModel(c.model, m))) && sameFamily(c, model);
}

/**
 * A preview's estimate: each call the change touches asked `samples` times at the asked model's price,
 * and the control arm as often at the recorded one's (`≈$0.18 · about 1,224 requests, half as
 * recorded`). Free when no call of the runs is made with a model it switches from; none for a change
 * of the working tree's prompt, until its offline replay has named the calls it changes.
 */
export function previewEstimate(runs: ReadonlyArray<readonly PricedCall[]>, change: PreviewChange, o: PreviewOptions = {}): Estimate {
  if (change.fromCode) return noEstimate('preview', 'which calls the working tree changes is known once the preview has replayed it offline');
  const samples = o.samples ?? PREVIEW_SAMPLES;
  const control = o.control ?? samples >= CONTROL_MIN_SAMPLES;
  const from = change.from?.length ? change.from : null;
  let usd = 0;
  let asked = 0;
  let otherFamily = 0;
  const missing = { unpriced: [] as string[], uncounted: [] as number[] };
  for (const c of runs.flat()) {
    if (!askable(c, o.scope) || (from && !from.some((m) => sameModel(c.model, m)))) continue;
    if (!sameFamily(c, change.model ?? null)) {
      otherFamily++;
      continue;
    }
    asked++;
    if (!c.usage) {
      missing.uncounted.push(c.callNo);
      continue;
    }
    const model = change.model ?? c.model;
    const now = estimateCost(model, c.usage, o.prices);
    const was = control ? c.usd : 0;
    if (now !== null && was !== null) {
      usd += samples * (now + was);
      continue;
    }
    const name = (now === null ? model : c.model) ?? `the model of #${c.callNo}`;
    if (!missing.unpriced.includes(name)) missing.unpriced.push(name);
  }
  if (missing.unpriced.length || missing.uncounted.length) return noEstimate('preview', noPriceWords(missing));
  if (!asked) {
    const why = otherFamily ? `${change.model!} is of another family than the calls it switches, so none can be asked again: verify that switch instead` : from ? `no call of the runs is made with ${from.join(' or ')}` : 'no model call of the runs to ask';
    return { kind: 'preview', usd: 0, ceiling: false, parts: [why] };
  }
  const requests = asked * samples * (control ? 2 : 1);
  return { kind: 'preview', usd, ceiling: false, parts: [`about ${counted(requests, 'request')}${control ? ', half as recorded' : ''}`] };
}

/**
 * A run of a kept preview, as its verify prices it: one that failed its checks as recorded must now
 * pass, each attempt about what the run costs under the change; one that passed must keep passing
 * against itself as recorded, its baseline at what it cost before.
 */
export function decisionRunCost(run: { cost: Pick<DecisionRun['cost'], 'before' | 'after'> }, failed: boolean): VerifyRunCost {
  const none = run.cost.after === null || (!failed && run.cost.before === null) ? { none: 'a model of the run has no price' } : {};
  return failed ? { role: 'target', usd: run.cost.after, ...none } : { role: 'good', usd: run.cost.after, baseline: run.cost.before, ...none };
}

export interface MigratePlan {
  to: string;
  /** The recorded models it switches from: `--from`, else defaultFrom's for a migration. */
  from: readonly string[];
  samples?: number;
  rule?: VerifyRule;
  scope?: string | null;
  prices?: Prices;
}

/** Why a migration has no estimate, by call and by model, each once. */
class Missing {
  unpriced = new Set<string>();
  uncounted = new Set<number>();
  unanswered = new Set<number>();
  /** A call it could not price: asked of `model`, or as recorded. */
  add(c: PricedCall, model: string | null): void {
    if (!c.usage) (c.answered ? this.uncounted : this.unanswered).add(c.callNo);
    else this.unpriced.add(model ?? `the model of #${c.callNo}`);
  }
  get any(): boolean {
    return this.unpriced.size + this.uncounted.size + this.unanswered.size > 0;
  }
  words(): string {
    return noPriceWords({ unpriced: [...this.unpriced], uncounted: [...this.uncounted], unanswered: [...this.unanswered] });
  }
}

/**
 * Migrate to…'s estimate, its ceiling: the goldens' calls made with the models it switches from asked
 * again at the new model's price, then every golden they touch verified, each attempt live from its
 * first switched call to its end, a golden whose recording fails its checks up to the gate's most
 * attempts, one that passes in pairs against itself on the model it was recorded with (`At most
 * ≈$23.01 · ≈$0.31 to ask 41 calls again · then verify, up to 80 attempts a failing run, 200 pairs a
 * good one · live from the switched calls, writes stubbed`). It asks first whatever Spending says.
 */
export function migrateEstimate(goldens: ReadonlyArray<{ calls: readonly PricedCall[]; failed: boolean }>, plan: MigratePlan): Estimate {
  const always = 'it writes a config change and a pull request body';
  const samples = plan.samples ?? MIGRATE_SAMPLES;
  const switched = (c: PricedCall) => askable(c, plan.scope) && switchedTo(c, plan.from, plan.to);
  const missing = new Missing();
  let ask = 0;
  let n = 0;
  const runs: VerifyRunCost[] = [];
  for (const g of goldens) {
    const first = g.calls.find(switched)?.callNo;
    if (first === undefined) continue;
    // From its first switched call on: what an attempt costs under the change, and as recorded, its baseline's.
    let now = 0;
    let was = 0;
    for (const c of g.calls) {
      if (c.callNo < first) continue;
      const mine = switched(c);
      const cost = mine ? (c.usage ? estimateCost(plan.to, c.usage, plan.prices) : null) : c.usd;
      if (cost === null) missing.add(c, mine ? plan.to : c.model);
      else now += cost;
      if (mine) {
        n++;
        ask += samples * (cost ?? 0);
      }
      if (g.failed) continue;
      if (c.usd === null) missing.add(c, c.model);
      else was += c.usd;
    }
    runs.push(g.failed ? { role: 'target', usd: now } : { role: 'good', usd: now, baseline: was });
  }
  if (missing.any) return { ...noEstimate('migrate', missing.words()), always };
  if (!n) return { kind: 'migrate', usd: 0, ceiling: false, always, parts: [`no golden’s call is made with ${plan.from.join(' or ') || 'a model it switches from'}`] };
  const verify = verifyCeiling(runs, plan.rule);
  const failing = runs.filter((r) => r.role === 'target').length;
  return {
    kind: 'migrate',
    usd: ask + verify.usd!,
    ceiling: true,
    always,
    parts: [`${amountWords(ask)} to ask ${counted(n, 'call')} again`, `then verify, ${verifyParts(failing, runs.length - failing, verify.limits)}`, 'live from the switched calls, writes stubbed'],
    items: [
      { what: 'Asking', usd: ask },
      { what: 'Verify', usd: verify.usd! },
    ],
    attempts: verify.attempts,
  };
}
