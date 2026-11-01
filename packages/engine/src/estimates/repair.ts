import type { BlameReport } from '../blame.js';
import { DEFAULT_REPAIRER } from '../fix-jobs.js';
import { estimateCost } from '../prices.js';
import { SPRT_DEFAULTS } from '../stats.js';
import { blameBound } from './blame.js';
import { counted, CUT_SHORT_LINE, liveFrom, noEstimate, noPriceWords, probedCalls, type Estimate, type PricedCall, type Prices } from './estimate.js';
import { amountWords } from './spending.js';
import { lastVerify, verifyCeiling, verifyParts, type LastVerify, type VerifyRule, type VerifyRunCost } from './verify.js';

/**
 * What Run repair can bill at most, as `shadowlap repair` bounds each step (repair.md): a blame of
 * each failing run it shows the repairer, where none is kept to reuse (one stopped part way is run
 * again from the first model call, as blame keeps no search to resume); the repairer's answer, at
 * most what repair checks a budget against before it asks; and its candidates, each verified until
 * one is accepted twice. It asks the repairer for `--candidates` (3) and takes up to twice that from
 * its answer; the first the gate accepts is verified once more with fresh attempts, so every
 * candidate may be verified up to twice, and at most ⌊1/risk⌋ are decided (repair-pick.ts). A
 * rewrite of the prompt or a tool description changes every request, so each attempt runs live from
 * each run's first model call. Where every failing run's kept blame rescued no call, or couldn't
 * settle, the repair ends "No fix to try" before it runs anything: Free. It asks first whatever
 * Spending says, since it makes each candidate from your working tree.
 */

/**
 * What asking the repairer may cost, as repair bounds it before it asks (cli/src/repair.ts
 * repairerMost and cli/src/repairer.ts, which a CLI test holds these to).
 */
export const REPAIRER_LIMITS = Object.freeze({
  /** The longest answer it may give, in tokens, a turn. */
  answerTokens: 16_000,
  /** The turns Claude Code takes: its second reads the prompt again with the first answer. */
  claudeCodeTurns: 2,
  /** The model Claude Code is priced at, and an `anthropic` repairer's when it names none. */
  model: 'claude-opus-5-5',
  /** Characters a prompt token is taken to hold: fewer than the 4 English averages, so a prompt is counted high. */
  charsPerToken: 3,
});

/** The candidates repair asks the repairer for, unless told otherwise (`--candidates 3`). */
export const REPAIR_CANDIDATES = 3;

/** Why Run repair would end "No fix to try" without running anything: the blame it reuses didn't settle, or rescued no call. */
export type NoFixToTry = 'unsettled' | 'unrescued';

/** What makes up the repairer's prompt: about 4 characters a token in what each failing run sent. */
const CHARS_PER_RECORDED_TOKEN = 4;

/**
 * The most asking `repairer` (`claude-code`, `anthropic[:<model>]`, `openai:<model>`) may cost for a
 * prompt of `promptChars` characters: the prompt counted high, and the longest answer, in each of its
 * turns. Null for a model with no price, and for one it names none of.
 */
export function repairerBound(repairer: string, promptChars: number, prices?: Prices): { usd: number | null; model: string | null } {
  const at = repairer.indexOf(':');
  const provider = at < 0 ? repairer : repairer.slice(0, at);
  const named = at < 0 ? '' : repairer.slice(at + 1).trim();
  const model = named || (provider === 'claude-code' || provider === 'anthropic' ? REPAIRER_LIMITS.model : null);
  const turns = provider === 'claude-code' ? REPAIRER_LIMITS.claudeCodeTurns : 1;
  const prompt = Math.ceil(promptChars / REPAIRER_LIMITS.charsPerToken);
  const answer = REPAIRER_LIMITS.answerTokens;
  return { usd: estimateCost(model, { inputTokens: turns * prompt + (turns - 1) * answer, outputTokens: turns * answer }, prices), model };
}

/** A failing run a repair takes: its priced calls, and the blame it would reuse. */
export interface RepairRun {
  runId: string;
  startedAt: number;
  calls: readonly PricedCall[];
  /** The blame kept on it under the same check, rescue and scope, which repair reuses; absent or null when it blames the run itself. */
  blame?: Pick<BlameReport, 'outcome'> | null;
}

export interface RepairPlan {
  failing: readonly RepairRun[];
  /** The good runs each candidate must keep passing (`--keeps`). */
  good?: ReadonlyArray<{ calls: readonly PricedCall[] }>;
  /** `--scope`: blame probes only the model calls made in it. */
  scope?: string | null;
  /** The verify each candidate is decided by. */
  rule?: VerifyRule;
  candidates?: number;
  /** The repairer, as the config or the command names it; the dashboard's default is your own Claude Code. */
  repairer?: string;
  /** Set when the repair would end "No fix to try" before it runs anything (fix-jobs.ts noFixToTry). */
  noFix?: NoFixToTry | null;
  /** The fix's last verify, for the price's card: what it took. */
  last?: LastVerify | null;
  /** The config's `prices`, for the repairer's answer: the runs' calls come priced (pricedCalls). */
  prices?: Prices;
}

/**
 * The failing runs repair shows the repairer and blames: with two or more and none held out by hand,
 * every other one, oldest first; the rest are held out from it, and only verified.
 */
function shown(failing: readonly RepairRun[]): RepairRun[] {
  if (failing.length < 2) return [...failing];
  return [...failing].sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId)).filter((_, i) => i % 2 === 0);
}

/** USD the runs blamed afresh may cost, every search at its bound; null with why when a run has no price. */
function blames(runs: readonly RepairRun[], o: RepairPlan): { usd: number; runs: number } | { none: string } {
  let usd = 0;
  let n = 0;
  for (const r of runs) {
    if (r.blame && r.blame.outcome !== 'stopped') continue;
    const probed = probedCalls(r.calls, o.scope);
    if (!probed.length) continue;
    const cost = liveFrom(r.calls, probed[0]!.callNo);
    if (cost.usd === null) return { none: noPriceWords(cost) };
    usd += blameBound(probed.length).attempts * cost.usd;
    n++;
  }
  return { usd, runs: n };
}

/** The most input tokens one of a run's model requests carried, its cache reads and writes with it: a pass, as a long run has more calls than a call takes arguments. */
function longestRequest(calls: readonly PricedCall[]): number {
  let most = 0;
  for (const c of calls) if (c.usage) most = Math.max(most, c.usage.inputTokens + (c.usage.cacheReadInputTokens ?? 0) + (c.usage.cacheCreationInputTokens ?? 0));
  return most;
}

/** A run as a verify of a candidate prices it: every attempt live from its first model call, so at most what the whole recording cost. */
function wholeRun(role: VerifyRunCost['role'], calls: readonly PricedCall[]): VerifyRunCost {
  const cost = liveFrom(calls, 0);
  return { role, usd: cost.usd, ...(cost.usd === null ? { none: noPriceWords(cost) } : {}) };
}

/** The most candidates repair decides: twice what it asks for, never past ⌊1/risk⌋ at its gate's risk. */
function decided(o: RepairPlan): number {
  const asked = Math.max(o.candidates ?? REPAIR_CANDIDATES, 1) * 2;
  const risk = o.rule?.attempts ? null : (o.rule?.gate?.risk ?? SPRT_DEFAULTS.risk);
  return risk ? Math.min(asked, Math.max(1, Math.floor(1 / risk + 1e-9))) : asked;
}

/**
 * Run repair's estimate: its ceiling (`At most ≈$37.16 · a new blame, then up to 6 candidates · each
 * verified up to twice · live from each run’s first model call, writes stubbed`), and what makes it
 * up on the price's card; Free where it would end "No fix to try". It always asks first.
 */
export function repairEstimate(o: RepairPlan): Estimate {
  const always = 'it makes its candidates from your working tree';
  const free = (why: NoFixToTry): Estimate => ({ kind: 'repair', usd: 0, ceiling: false, always, parts: [`nothing runs: the blame it reuses ${why === 'unsettled' ? 'didn’t settle' : 'rescued no call'}`] });
  if (o.noFix) return free(o.noFix);
  if (!o.failing.length) return { ...noEstimate('repair', 'there is no failing run to repair'), always };
  const targets = shown(o.failing);
  // The repairer is shown each run it learns from: every one blamed afresh, or whose kept blame rescued it.
  const learned = targets.filter((r) => r.blame?.outcome !== 'unrescuable');
  if (!learned.length) return free('unrescued');
  const blame = blames(targets, o);
  if ('none' in blame) return { ...noEstimate('repair', blame.none), always };
  const repairer = repairerBound(o.repairer ?? DEFAULT_REPAIRER, learned.reduce((n, r) => n + longestRequest(r.calls), 0) * CHARS_PER_RECORDED_TOKEN, o.prices);
  if (repairer.usd === null) return { ...noEstimate('repair', repairer.model ? `no price for ${repairer.model}, the repairer's model: add it under "prices" in shadowlap.config.json` : 'the repairer names no model to price its answer at'), always };
  const runs = [...o.failing.map((r) => wholeRun(targets.includes(r) ? 'target' : 'holdout', r.calls)), ...(o.good ?? []).map((g) => wholeRun('good', g.calls))];
  const each = verifyCeiling(runs, o.rule);
  if (each.usd === null) return { ...noEstimate('repair', runs.find((r) => r.none)?.none ?? 'a run it verifies has no price'), always };
  const k = decided(o);
  const verifies = 2 * k * each.usd;
  const parts = [`${blame.runs ? 'a new blame, then up' : 'up'} to ${counted(k, 'candidate')}`, 'each verified up to twice', 'live from each run’s first model call, writes stubbed'];
  const failing = runs.filter((r) => r.role !== 'good').length;
  const last = lastVerify(o.last);
  return {
    kind: 'repair',
    usd: blame.usd + repairer.usd + verifies,
    ceiling: true,
    always,
    parts,
    items: [...(blame.runs ? [{ what: 'Blame', usd: blame.usd }] : []), { what: 'Repairer', usd: repairer.usd }, { what: 'A verify', usd: each.usd }],
    card: {
      title: 'If every candidate ran to its limit',
      lines: [
        ...(blame.runs ? [`Blame: ${amountWords(blame.usd)}, from the first model call`] : []),
        `Repairer: its answer, ${amountWords(repairer.usd)} at most`,
        `A verify: ${amountWords(each.usd)} at most, ${verifyParts(failing, runs.length - failing, each.limits)}`,
        last ? `The last verify of this fix took ${counted(last.attempts, 'attempt')}, ${amountWords(last.usd)}.` : 'A run that replays clean settles in one free attempt.',
        CUT_SHORT_LINE,
      ],
    },
    attempts: 2 * k * each.attempts,
  };
}
