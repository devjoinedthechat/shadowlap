import { num } from '../format.js';
import { failedWord, isFailed, isInterrupted, isLive, runType, type RunLike } from '../runs.js';

/**
 * What Provenance works out on the page when the server does not: the providers a run's model calls
 * went to, and what a copy made now applies. No DOM here: the tests import it.
 */

/**
 * A run of the lineage in the design's words: what it is (`label`, the server's: "fork @3"), what a
 * failed recording or test failed in its place, in red (`err`), "recording now" while it records,
 * and, after what it is, that it was interrupted, in grey, as Runs, the sidebar and the Forks view say.
 */
export function lineageWords(r: RunLike, label: string): { err: string | null; text: string } {
  const t = runType(r);
  if (isLive(r)) return { err: null, text: t === 'recording' ? 'recording now' : `${label} · running now` };
  if (isInterrupted(r)) return { err: null, text: `${label} · interrupted` };
  if (isFailed(r) && t === 'test') return { err: 'test failed', text: '' };
  if (isFailed(r) && (t === 'recording' || t === 'replay')) return { err: failedWord(r), text: '' };
  return { err: null, text: label };
}

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

/**
 * What a copy made now applies, after "A copy made now (…) applies": the rules, and what they would
 * mask when counted, or that it wasn't (`uncounted`: a rule took too long, the run is long; the
 * reason goes on hover), or that it is yet to be (`busy`: the previews were busy, and the page asks
 * again).
 */
export function copyRules(rules: number | null | undefined, masked: number | null | undefined, uncounted = false, busy = false): string {
  if (typeof rules !== 'number') return 'the redaction rules in shadowlap.config.json';
  if (!rules) return 'no redaction rules: it would hold what was recorded';
  const they = rules === 1 ? 'it' : 'they';
  const counted = typeof masked === 'number' ? ` and would mask ${num(masked)} ${masked === 1 ? 'value' : 'values'} in this run` : busy ? `; what ${they} would mask in this run is being counted` : uncounted ? `; what ${they} would mask in this run wasn’t counted` : '';
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
