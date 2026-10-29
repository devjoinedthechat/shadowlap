import { applyNormalizers, credentialFreeHeaders, loadApiRequest, redactApiPath, redactBytes, rewriteText, type CallRecord, type Normalizer, type RunRecord, type StoreOf } from '@shadowlap/engine';
import { providers } from '@shadowlap/sidecar';
import { VERSION } from './shared.js';

/**
 * A run's model API calls as a HAR, the format mitmproxy, Charles, Proxyman, devtools and Polly.js
 * read and write. The reverse of `shadowlap import har`, for handing a recording to a tool that
 * speaks HAR — and the round trip is a test of both: exporting a run and importing it again must
 * produce the same fingerprints.
 *
 * Only API calls appear: a HAR describes HTTP, and tool, clock and randomness calls never crossed
 * the network. An imported HAR therefore declares itself a partial recording.
 *
 * A HAR leaves the machine, so the redaction rules apply to it as they do to a pack or an HTML copy:
 * every rule to the request body (rules with a path included), and the rules without a path to the
 * URL, the headers and the response, streamed or not. The rules travel in the log (`_shadowlap`), so
 * a recording imported from it can be matched under them again.
 */

/** The provider's canonical host. Azure, Vertex and Bedrock hosts depend on the account, so a representative one stands in. */
const HOSTS: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  gemini: 'generativelanguage.googleapis.com',
  azure: 'resource.openai.azure.com',
  vertex: 'aiplatform.googleapis.com',
  bedrock: 'bedrock-runtime.us-east-1.amazonaws.com',
};

const pairs = (h: Record<string, string> | undefined) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value }));

export interface HarExportResult {
  har: unknown;
  /** API calls written. */
  entries: number;
  /** Calls left out, with the reason. */
  skipped: Array<{ callNo: number; reason: string }>;
}

export function runToHar(store: StoreOf<'recording'>, run: RunRecord, calls: CallRecord[], options: { redact?: Normalizer[] } = {}): HarExportResult {
  const entries: unknown[] = [];
  const skipped: HarExportResult['skipped'] = [];
  const rules = options.redact ?? [];
  const text = (s: string) => (rules.length ? rewriteText(s, rules) : s);
  const masked = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, text(v)]));

  for (const c of calls) {
    if (c.kind !== 'api') continue;
    if (!c.end) {
      skipped.push({ callNo: c.callNo, reason: 'the call never completed' });
      continue;
    }
    const host = HOSTS[String(c.meta.provider ?? '')] ?? providers.find((p) => p.id === c.meta.provider)?.upstream ?? 'api.anthropic.com';
    const [method = 'POST', rawPath = '/'] = c.name.split(' ');
    // Each segment read decoded, as a copy's call name is: a Bedrock model's ARN, with the account id, is one.
    const path = redactApiPath(rawPath, rules, c);
    const stored = c.requestRef ? loadApiRequest(store, c.requestRef) : null;
    const body = rules.length ? (typeof stored === 'string' ? text(stored) : applyNormalizers(stored, rules, 'api', c.name)) : stored;
    const postText = typeof body === 'string' ? body : JSON.stringify(body);
    const recorded = c.end.responseRef ? (store.getBlob(c.end.responseRef) ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const bytes = rules.length ? redactBytes(recorded, rules, c) : recorded;
    // A credential header a recording made before it was known to be one kept leaves without its value,
    // and the organization a key belonged to not at all.
    const responseHeaders = masked(credentialFreeHeaders((c.end.meta.headers ?? {})));
    const mimeType = responseHeaders['content-type'] ?? 'application/json';
    const time = Math.max(0, (c.end.at ?? c.at) - c.at);
    // The headers that fingerprint have to travel, or a re-import matches nothing.
    const requestHeaders = masked({ 'content-type': 'application/json', ...((c.meta.fingerprintHeaders ?? {}) as Record<string, string>) });

    entries.push({
      startedDateTime: new Date(c.at).toISOString(),
      time,
      request: {
        method,
        url: `https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}${path}`,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: pairs(requestHeaders),
        queryString: [],
        postData: { mimeType: 'application/json', text: postText ?? '', params: [] },
        headersSize: -1,
        bodySize: Buffer.byteLength(postText ?? ''),
      },
      response: {
        status: c.end.meta.status ?? (c.end.outcome === 'error' ? 500 : 200),
        statusText: '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: pairs(responseHeaders),
        content: { size: bytes.length, mimeType, text: bytes.toString('base64'), encoding: 'base64' },
        redirectURL: '',
        headersSize: -1,
        bodySize: bytes.length,
      },
      cache: {},
      timings: { send: 0, wait: time, receive: 0 },
      comment: `shadowlap ${run.runId} call ${c.callNo}`,
    });
  }

  return {
    har: { log: { version: '1.2', creator: { name: 'shadowlap', version: VERSION }, pages: [], entries, ...(rules.length ? { _shadowlap: { redactions: rules } } : {}) } },
    entries: entries.length,
    skipped,
  };
}
