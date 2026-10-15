import { num } from '../format.js';

/**
 * What Provenance works out on the page when the server does not: the providers a run's model calls
 * went to, and what a copy made now applies. No DOM here: the tests import it.
 */

/** One call per endpoint the model calls used, at most `max`, with how many calls went there: one endpoint means one provider. */
export function endpointSamples(calls: ReadonlyArray<{ callNo: number; kind: string; name: string }>, max = 4): Array<{ first: number; calls: number }> {
  const byEndpoint = new Map<string, { first: number; calls: number }>();
  for (const c of calls) {
    if (c.kind !== 'api') continue;
    const e = byEndpoint.get(c.name);
    if (e) e.calls++;
    else byEndpoint.set(c.name, { first: c.callNo, calls: 1 });
  }
  return [...byEndpoint.values()].slice(0, max);
}

/** The providers each endpoint's call named, with their calls, most used first; an endpoint whose call said none is left out. */
export function tallyProviders(found: ReadonlyArray<{ provider: string | null | undefined; calls: number }>): Array<{ provider: string; calls: number }> {
  const tally = new Map<string, number>();
  for (const x of found) if (x.provider) tally.set(x.provider, (tally.get(x.provider) ?? 0) + x.calls);
  return [...tally].map(([provider, calls]) => ({ provider, calls })).sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider));
}

/** What a copy made now applies, after "A copy made now (…) applies": the rules, and what they would mask when counted. */
export function copyRules(rules: number | null | undefined, masked: number | null | undefined): string {
  if (typeof rules !== 'number') return 'the redaction rules in shadowlap.config.json';
  if (!rules) return 'no redaction rules: it would hold what was recorded';
  const counted = typeof masked === 'number' ? ` and would mask ${num(masked)} ${masked === 1 ? 'value' : 'values'} in this run` : '';
  return `${rules} redaction ${rules === 1 ? 'rule' : 'rules'}${counted}`;
}

/**
 * How many redaction rules a copy made now applies, for the Share menu's note: the server's count
 * when it sends one (`meta.redactRules`), else the run's provenance record's; null when neither says.
 */
export function redactRuleCount(meta: { redactRules?: number | null } | null | undefined, prov: { mask?: { rules: number } | null } | null | undefined): number | null {
  if (typeof meta?.redactRules === 'number') return meta.redactRules;
  return typeof prov?.mask?.rules === 'number' ? prov.mask.rules : null;
}
