import { approx, num } from '../format.js';
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

/**
 * The Upstream row: the requests the run sent its providers and what they cost, and for a run pulled
 * from the team store, who spent it there (`pulledSpender`), as a quiet note after it, the way the
 * Models row counts calls: "by maya".
 */
export function upstreamParts(requests: number, spent: number, by?: string): { text: string; note: string | null } {
  return { text: `${num(requests)} ${requests === 1 ? 'request' : 'requests'} · ${approx(spent)}`, note: by ? `by ${by}` : null };
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
 * mask when counted (in a pack; `returned` more in a copy that is only read, export html or dataset,
 * where a path rule reaches what calls got back), with what else they match that a pack leaves as it
 * is (`unmasked`: numbers a pattern never rewrites), or that it wasn't counted (`uncounted`: a rule
 * took too long, the run is long; the reason goes on hover), or that it is yet to be (`busy`: the
 * previews were busy, and the page asks again).
 */
export function copyRules(rules: number | null | undefined, masked: number | null | undefined, uncounted = false, busy = false, unmasked = 0, returned = 0): string {
  if (typeof rules !== 'number') return 'the redaction rules in shadowlap.config.json';
  if (!rules) return 'no redaction rules: it would hold what was recorded';
  const they = rules === 1 ? 'it' : 'they';
  const named = `${rules} redaction ${rules === 1 ? 'rule' : 'rules'}`;
  if (typeof masked === 'number') {
    const values = masked ? `${num(masked)} ${masked === 1 ? 'value' : 'values'}` : 'no values';
    const read = returned ? ` (${num(masked + returned)} in export html or dataset, which are only read)` : '';
    const left = unmasked ? `; ${num(unmasked)}${masked ? ' more' : ''} ${they} ${rules === 1 ? 'matches' : 'match'} ${unmasked === 1 ? 'stays as it is' : 'stay as they are'}${returned ? ' in a pack' : ''}` : '';
    return `${named} and would mask ${values} in this run${read}${left}`;
  }
  if (busy) return `${named}; what ${they} would mask in this run is being counted`;
  return uncounted ? `${named}; what ${they} would mask in this run wasn’t counted` : named;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * What an exported copy's Provenance says in place of what a copy made now would apply: the copy's
 * own redaction, when it was made and with how many rules ("Exported Oct 22 with 3 redaction rules
 * applied"), the year too when it isn't this one. A copy made before it kept the count says only
 * whether rules applied.
 */
export function exportedLine(o: { exportedAt?: number | null; rules?: number | null; redacted?: boolean | null }, now = Date.now()): string {
  let when = '';
  if (typeof o.exportedAt === 'number') {
    const d = new Date(o.exportedAt);
    when = ` ${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== new Date(now).getFullYear() ? `, ${d.getFullYear()}` : ''}`;
  }
  const rules = typeof o.rules === 'number' ? o.rules : o.redacted === false ? 0 : null;
  if (rules === 0) return `Exported${when} with no redaction rules: it holds what was recorded.`;
  if (rules === null) return `Exported${when} with the project’s redaction rules applied.`;
  return `Exported${when} with ${num(rules)} redaction ${rules === 1 ? 'rule' : 'rules'} applied.`;
}

/**
 * How many redaction rules a copy made now applies, for the Share menu's note: the server's count
 * when it sends one (`meta.redactRules`), else the run's provenance record's; null when neither says.
 */
export function redactRuleCount(meta: { redactRules?: number | null } | null | undefined, prov: { mask?: { rules: number } | null } | null | undefined): number | null {
  if (typeof meta?.redactRules === 'number') return meta.redactRules;
  return typeof prov?.mask?.rules === 'number' ? prov.mask.rules : null;
}
