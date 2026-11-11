import { causeEstimate, type Estimate, injectionEstimate, injectionGateEstimate, injectionTemplates, type InjectionPlan, type ToolTrust, untrustedReads } from '@shadowlap/engine';
import { defaultTemplates } from './injection-defaults.js';
import type { Pricing } from './pricing.js';

/**
 * What an injection test bills, priced by the engine's estimators on the server (they read node
 * modules, so a page draws their words and never works a sum out): the plan nobody picked, which each
 * opener's card shows and a dialog starts from, and the plan a dialog's picks make.
 */

/** The payloads a test of `reads` untrusted reads plants where nobody picked: every template, or the few past MANY_READS. */
export function defaultPayloads(reads: number): number {
  return defaultTemplates(reads)?.length ?? injectionTemplates().templates.length;
}

/** Run injection test… on a run: the plan picked (`plan`), else the one nobody picked (one attempt a payload, three clean replays). */
export function injectionPrice(runId: string, tools: ToolTrust | undefined, plan?: InjectionPlan): (p: Pricing) => Estimate {
  return (p) => {
    const reads = untrustedReads(p.raw(runId), tools).reads;
    return injectionEstimate(p.calls(runId), reads, plan ?? { payloads: defaultPayloads(reads.length) });
  };
}

/** Pack with injection gate…: what each test session's gate bills, at the plan picked, else at the one nobody picked. */
export function gatePrice(runId: string, tools: ToolTrust | undefined, plan?: Omit<InjectionPlan, 'budget'>): (p: Pricing) => Estimate {
  return (p) => {
    const reads = untrustedReads(p.raw(runId), tools).reads;
    return injectionGateEstimate(p.calls(runId), reads, plan ?? { payloads: defaultPayloads(reads.length) });
  };
}

/** Find cause… on each untrusted read of a run, by the read's call number: the read made neutral, up to its gate's attempts. */
export function causePrices(runId: string, tools: ToolTrust | undefined): (p: Pricing) => Record<number, Estimate> {
  return (p) => {
    const calls = p.calls(runId);
    return Object.fromEntries(untrustedReads(p.raw(runId), tools).reads.map((r) => [r.callNo, causeEstimate(calls, r)]));
  };
}
