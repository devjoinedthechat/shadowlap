import { causeEstimate, type Estimate, injectionEstimate, injectionGateEstimate, injectionTemplates, type InjectionPlan, noEstimate, type ToolTrust, type UntrustedRead, untrustedReads } from '@shadowlap/engine';
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

/** The untrusted reads a test plants in: those a model call reads, as the estimators and the CLI count them; one no model call follows is never planted in. */
const plantedReads = (p: Pricing, runId: string, tools: ToolTrust | undefined): UntrustedRead[] => untrustedReads(p.raw(runId), tools).reads.filter((r) => r.readAt !== null);

/** Run injection test… on a run: the plan picked (`plan`), else the one nobody picked (one attempt a payload, three clean replays). */
export function injectionPrice(runId: string, tools: ToolTrust | undefined, plan?: InjectionPlan): (p: Pricing) => Estimate {
  return (p) => {
    const reads = plantedReads(p, runId, tools);
    return injectionEstimate(p.calls(runId), reads, plan ?? { payloads: defaultPayloads(reads.length) });
  };
}

/** Pack with injection gate…: what each test session's gate bills, at the plan picked, else at the one nobody picked. */
export function gatePrice(runId: string, tools: ToolTrust | undefined, plan?: Omit<InjectionPlan, 'budget'>): (p: Pricing) => Estimate {
  return (p) => {
    const reads = plantedReads(p, runId, tools);
    return injectionGateEstimate(p.calls(runId), reads, plan ?? { payloads: defaultPayloads(reads.length) });
  };
}

/** Find cause… on one untrusted read of a run, as its dialog picks it: the read made neutral, up to its gate's attempts. */
export function causePrice(runId: string, tools: ToolTrust | undefined, read: number): (p: Pricing) => Estimate {
  return (p) => {
    const r = untrustedReads(p.raw(runId), tools).reads.find((x) => x.callNo === read);
    return r ? causeEstimate(p.calls(runId), r) : noEstimate('cause', `#${read} is no untrusted read of this run`);
  };
}
