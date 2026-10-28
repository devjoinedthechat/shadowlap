/**
 * The replay index: a parent's calls as a replay matches them, and how a model request is
 * fingerprinted under a run's rules, live or from its record. The parent's fingerprints are made
 * again under the current normalizers, most from the fingerprint cache the recording filled
 * (refingerprint); its model calls are read as matching reads them (asMatched, withoutParameters,
 * matchName), and its requests as a divergence report shows them (loadRequest).
 */
import { apiCallName, fingerprintApi, fingerprintMisc, fingerprintTool, isJudgeCall, judgeRules, loadApiRequest, matchable, matchedAs, multipartView, apiNumbers, queryPairs, redactApiPath, redactHeaderValues, reportable, withoutStoredCredentials, type CallRecord, type Normalizer } from '@shadowlap/engine';
import type { SidecarCore } from './core.js';
import { allowedHeaders, clockMarks, decodeMarks, encodeMarks, fingerprintKey, rulesId, servesClock, type ClockMark, type FingerprintRules } from './fingerprint-cache.js';
import { identityQuery } from './query.js';
import { withoutHeaderParameters, type Provider } from './providers.js';

/**
 * The rules a run's model calls are fingerprinted under, live and from their records: its
 * normalizers, the times dates are masked against, whether prompts are left out (`--prompt-from`),
 * and whether a request's numbers are read rounded, as a recording made before requests kept their
 * numbers stored them (RunMeta.exactNumbers).
 */
export interface MatchingRules {
  normalizers: Normalizer[];
  clockRef: readonly number[] | undefined;
  withoutPrompt: boolean;
  roundedNumbers: boolean;
}

/**
 * A model request's fingerprint under a run's matching rules: the one place an agent's model call
 * is fingerprinted, as it arrives and from its record (refingerprint).
 */
export function apiFingerprint(rules: MatchingRules, provider: Provider, req: { method: string; path: string; headers: Record<string, string>; body: unknown; query?: string }): string {
  return fingerprintApi(req, rules.normalizers, provider.fingerprintHeaders, rules.clockRef, { withoutPrompt: rules.withoutPrompt, matchPath: provider.matchPath?.(req.path), roundNumbers: rules.roundedNumbers }).fingerprint;
}

/** How a model call is fingerprinted, besides its request, as its fingerprint cache key names it. */
export function modelRules(rules: Pick<MatchingRules, 'clockRef' | 'withoutPrompt' | 'roundedNumbers'> & { ids: { normalizers: string; judge: string } }, provider: Provider, method: string, path: string, headers: Readonly<Record<string, string>>, query: string | undefined, judge: boolean): FingerprintRules {
  const shared = { method, path, matchPath: provider.matchPath?.(path) ?? null, headers: allowedHeaders(headers, provider.fingerprintHeaders), allow: provider.fingerprintHeaders, numbers: rules.roundedNumbers ? ('rounded' as const) : ('exact' as const) };
  return judge ? { kind: 'judge', ...shared, rules: rules.ids.judge, query: query ?? null } : { kind: 'api', ...shared, normalizers: rules.ids.normalizers, clock: rules.clockRef !== undefined, withoutPrompt: rules.withoutPrompt, query: query ?? null };
}

/**
 * Normalizers are a matching-time concern: a recording made before a normalizer was added must
 * still match under it. So a parent's fingerprints (and, since fingerprints partition occurrences,
 * its occurrence numbers) are recomputed from the stored requests under the current normalizers.
 * A captured HTTP call is fingerprinted under its name masked by the rules that redacted the
 * parent (`redactions`, matchedAs), as proxyHttp fingerprints a live one; a redacted copy already
 * holds it so. Its arguments are read with their credentials masked (withoutStoredCredentials),
 * as proxyHttp stores a live call's. `only` limits the calls fingerprinted again; the others keep
 * their stored fingerprints, and every call's occurrence is counted again.
 *
 * Most fingerprints come from the cache (fingerprint-cache.ts), which the recording filled: one
 * read for the whole run instead of every stored request read and hashed again. A request the cache
 * can't answer under these rules and dates is fingerprinted here, and kept in the cache for the
 * next replay. `cached` counts those the cache answered.
 */
export function refingerprint(core: SidecarCore, calls: CallRecord[], matching: MatchingRules & { redactions: Normalizer[] }, only?: (rec: CallRecord) => boolean): { calls: CallRecord[]; cached: number } {
  const { clockRef } = matching;
  const rules = { ...matching, ids: { normalizers: rulesId(matching.normalizers), judge: rulesId(judgeRules(matching.redactions)) } };
  // A clock or random read's request, its label, by its ref: the SDKs' unlabelled reads all share one.
  const labels = new Map<string, unknown>();
  const plans = calls.map((rec) => (only && !only(rec) ? null : fingerprintPlan(core, rec, rules, labels)));
  const found = core.store.cachedFingerprints(plans.flatMap((p) => (p?.key ? [p.key] : [])));
  const fresh: Array<{ key: string; requestRef: string; fingerprint: string; clock: string | null }> = [];
  let cached = 0;
  const counts = new Map<string, number>();
  const out = calls.map((rec, i) => {
    let fingerprint = rec.fingerprint;
    const plan = plans[i];
    if (plan) {
      const hit = plan.key === null ? undefined : found.get(plan.key);
      const marks = hit ? decodeMarks(hit.clock) : null;
      if (hit && marks && servesClock(marks, clockRef)) {
        fingerprint = hit.fingerprint;
        cached++;
      } else {
        try {
          const made = plan.compute();
          fingerprint = made.fingerprint;
          if (plan.key !== null) fresh.push({ key: plan.key, requestRef: plan.requestRef, fingerprint, clock: encodeMarks(made.marks) });
        } catch (err) {
          core.log(`could not re-fingerprint call #${rec.callNo}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const k = `${rec.kind}\n${typeof rec.meta.scope === 'string' ? rec.meta.scope : ''}\n${fingerprint}`;
    const occurrence = (counts.get(k) ?? 0) + 1;
    counts.set(k, occurrence);
    return { ...rec, fingerprint, occurrence };
  });
  if (fresh.length) core.writer.write({ what: 'the fingerprint cache', optional: true, run: () => core.store.cacheFingerprints(fresh) });
  return { calls: out, cached };
}

/**
 * How a recorded call is fingerprinted again under `rules`: its cache key, and the work to do when
 * the cache can't answer. A clock or random read has no key: its request is a label, read once per
 * label (`labels`), and no rule changes its fingerprint, which names the read (a recording from
 * before reads were named holds fingerprints without the name). Null to keep its stored
 * fingerprint (a call whose request or provider is unknown).
 */
function fingerprintPlan(core: SidecarCore, rec: CallRecord, rules: MatchingRules & { redactions: Normalizer[]; ids: { normalizers: string; judge: string } }, labels: Map<string, unknown>): { key: string | null; requestRef: string; compute: () => { fingerprint: string; marks: ClockMark[] } } | null {
  const ref = rec.requestRef;
  if (!ref) return null;
  if (rec.kind === 'clock' || rec.kind === 'random') {
    const kind = rec.kind;
    return {
      key: null,
      requestRef: ref,
      compute: () => {
        if (!labels.has(ref)) {
          const req = core.getJsonExact<{ label?: unknown }>(ref);
          if (!req) throw new Error(`missing request ${ref}`);
          labels.set(ref, req.label ?? '');
        }
        return { fingerprint: fingerprintMisc(kind, rec.name, labels.get(ref) as string).fingerprint, marks: [] };
      },
    };
  }
  if (rec.kind === 'api') {
    // The host of another's format it went through (`via`), whose root it is matched under.
    const provider = providerOf(core, rec);
    if (!provider) return null;
    const [method = 'POST', ...pathParts] = rec.name.split(' ');
    // Read through the rules that redacted the copy, as the live call's are: masking twice changes nothing.
    const path = redactApiPath(pathParts.join(' '), rules.redactions, rec);
    const headers = redactHeaderValues(matchedHeaders(provider, (rec.meta.fingerprintHeaders as Record<string, string> | undefined) ?? {}), rules.redactions, rec);
    const query = typeof rec.meta.query === 'string' ? rec.meta.query : undefined;
    // A judge's call is matched by its request as sent, not as the agent's calls are.
    const judge = isJudgeCall(rec);
    return {
      key: fingerprintKey(modelRules(rules, provider, method, path, headers, query, judge), ref),
      requestRef: ref,
      compute: () => {
        // From the query it kept: none for a call recorded before calls kept one.
        // Its numbers as they were stored, read as the live call's are (MatchingRules.roundedNumbers).
        const request = { method, path, headers, body: loadApiRequest(core.store, ref, { exact: true }), query: storedQuery(rec, rules.redactions) };
        if (judge) return { fingerprint: judgeFingerprint(request, rules.redactions, provider, provider.matchPath?.(path), rules.roundedNumbers).fingerprint, marks: [] };
        return { fingerprint: apiFingerprint(rules, provider, request), marks: clockMarks([multipartView(apiNumbers(request.body, rules.roundedNumbers)), ...queryValues(query), ...Object.values(headers)], rules.clockRef) };
      },
    };
  }
  if (rec.kind === 'tool') {
    const matched = matchedAs(rec, rules.normalizers, rules.redactions);
    const captured = capturedHttp(rec);
    return {
      key: fingerprintKey({ kind: 'tool', name: matched.name, normalizers: matched.normalizers === rules.normalizers ? rules.ids.normalizers : rulesId(matched.normalizers), clock: rules.clockRef !== undefined, captured }, ref),
      requestRef: ref,
      compute: () => {
        const req = core.getJsonExact<{ args?: unknown }>(ref);
        const args = (captured ? withoutStoredCredentials(req?.args) : req?.args) ?? null;
        return { fingerprint: fingerprintTool(matched.name, args, matched.normalizers, rules.clockRef).fingerprint, marks: clockMarks([matchable(args)], rules.clockRef) };
      },
    };
  }
  return null;
}

/**
 * The provider a recorded model call went through: the host of another's format it was for
 * (`meta.via`, Claude on Foundry), else the one it is recorded under.
 */
function providerOf(core: SidecarCore, rec: Pick<CallRecord, 'meta'>): Provider | undefined {
  const via = typeof rec.meta.via === 'string' ? core.byId.get(rec.meta.via) : undefined;
  return via ?? core.byId.get(String(rec.meta.provider ?? ''));
}

/**
 * A recorded model call's name as matching reads it (`Provider.matchPath`): a Vertex AI call without
 * its project and region, and its path through the rules that redacted the copy (`redactions`).
 */
export function matchName(core: SidecarCore, rec: CallRecord, redactions: readonly Normalizer[] = []): string {
  const provider = rec.kind === 'api' ? providerOf(core, rec) : undefined;
  if (!provider) return rec.name;
  const [method = 'POST', ...pathParts] = rec.name.split(' ');
  const recorded = pathParts.join(' ');
  const path = redactApiPath(recorded, redactions, rec);
  if (provider.matchPath) return apiCallName(method, provider.matchPath(path));
  return path === recorded ? rec.name : apiCallName(method, path);
}

/** A recorded model call's request as it was sent, each number as written: what a rebuild sends again. */
export function sentRequest(core: SidecarCore, rec: CallRecord): unknown {
  return rec.requestRef ? loadApiRequest(core.store, rec.requestRef, { exact: true }) : undefined;
}

/**
 * A recorded call's request as a divergence report shows it: each number as it was stored, or, for a
 * parent recorded before requests kept their numbers (`rounded`), every model request's number as
 * the double it reads as, the way it was matched.
 */
export function loadRequest(core: SidecarCore, rec: CallRecord, rounded = false): unknown {
  if (!rec.requestRef) return undefined;
  if (rec.kind === 'api') return rounded ? loadApiRequest(core.store, rec.requestRef) : reportable(loadApiRequest(core.store, rec.requestRef, { exact: true }));
  const req = reportable(core.getJsonExact<{ args?: unknown }>(rec.requestRef)) as { args?: unknown } | null;
  // A captured HTTP call is diffed as it is matched: no credential as sent from an older recording.
  return capturedHttp(rec) && req ? { ...req, args: withoutStoredCredentials(req.args) } : req;
}

/**
 * The providers whose model calls in a parent all name no API version (`Provider.apiVersion`), as
 * a trace's never do: a replay matches and keeps its calls to them without the version they name.
 */
export function unversioned(core: SidecarCore, calls: readonly CallRecord[]): Set<string> {
  const named = new Map<string, boolean>();
  for (const c of calls) {
    const provider = c.kind === 'api' && !isJudgeCall(c) ? providerOf(core, c) : undefined;
    if (!provider?.apiVersion) continue;
    const version = (c.meta.fingerprintHeaders as Record<string, string> | undefined)?.[provider.apiVersion.header];
    named.set(provider.id, named.get(provider.id) === true || version !== undefined);
  }
  return new Set([...named].filter(([, some]) => !some).map(([id]) => id));
}

/**
 * The providers none of whose model calls in a parent kept a query (`meta.query`), as a recording
 * made before calls kept one, or a trace's, never does: a replay matches its calls to them whatever
 * query they carry, as it does a version none of them named (`unversioned`), and keeps no query on
 * them, so its own replays match them the same way. A call that kept an empty query had none.
 */
export function unqueried(core: SidecarCore, calls: readonly CallRecord[]): Set<string> {
  const kept = new Map<string, boolean>();
  for (const c of calls) {
    if (c.kind !== 'api' || isJudgeCall(c)) continue;
    const id = providerOf(core, c)?.id ?? String(c.meta.provider ?? '');
    kept.set(id, kept.get(id) === true || typeof c.meta.query === 'string');
  }
  return new Set([...kept].filter(([, some]) => !some).map(([id]) => id));
}

/**
 * A model call of a run that holds no header parameters (RunMeta.headerParameters) as it is
 * matched: its fingerprint headers without them, should a producer have kept some all the same.
 */
export function withoutParameters(core: SidecarCore, rec: CallRecord): CallRecord {
  const provider = rec.kind === 'api' ? providerOf(core, rec) : undefined;
  const headers = rec.meta.fingerprintHeaders as Record<string, string> | undefined;
  if (!provider?.headerParameters?.some((h) => headers?.[h] !== undefined)) return rec;
  return { ...rec, meta: { ...rec.meta, fingerprintHeaders: withoutHeaderParameters(provider, headers!) } };
}

/** A model call with its fingerprint headers as matching reads them (Provider.matchHeaders). */
export function asMatched(core: SidecarCore, rec: CallRecord): CallRecord {
  const provider = rec.kind === 'api' ? providerOf(core, rec) : undefined;
  const headers = rec.meta.fingerprintHeaders as Record<string, string> | undefined;
  if (!provider?.matchHeaders || !headers) return rec;
  return { ...rec, meta: { ...rec.meta, fingerprintHeaders: provider.matchHeaders(headers) } };
}

/**
 * A query's names and values decoded, as a fingerprint reads them (queryPairs): what the fingerprint
 * cache's clock marks are read from, so a date sent encoded (`2026-11-24T09%3A00%3A00Z`) is marked as
 * the date the fingerprint masks.
 */
export function queryValues(query: string | undefined): string[] {
  return queryPairs(query).flat();
}

/** A model call's query as its identity reads it, from what its recording kept (none when it kept none), under the rules that redacted the recording. */
export function storedQuery(rec: Pick<CallRecord, 'meta' | 'name'>, redactions: readonly Normalizer[] = []): string {
  return identityQuery(typeof rec.meta.query === 'string' ? rec.meta.query : undefined, redactions, rec.name);
}

/** A call to a host under `http` in the config, recorded as a tool (proxyHttp). */
export function capturedHttp(rec: Pick<CallRecord, 'kind' | 'meta'>): boolean {
  return rec.kind === 'tool' && typeof rec.meta.http === 'string';
}

/** A request's headers as matching reads them (Provider.matchHeaders): as sent, for most providers. */
export function matchedHeaders(provider: Provider | undefined, headers: Readonly<Record<string, string>>): Record<string, string> {
  return provider?.matchHeaders?.(headers) ?? { ...headers };
}

/**
 * How a judge's request is matched against the recording: by its bytes as sent, with none of the
 * project's normalizers and no masking of dates or prompts, since the judge read all of it and its
 * verdict answers those bytes alone. The rules that redacted the recording, those that reach a
 * judge's request (judgeRules), apply as a copy applied them, so a pack's masked request still
 * matches the one a replay sends. Nothing is matched fuzzily because of a judge.
 */
export function judgeFingerprint(req: { method: string; path: string; headers: Record<string, string>; body: unknown; query?: string }, redactions: readonly Normalizer[], provider: Provider, matchPath: string | undefined, roundNumbers = false): { fingerprint: string } {
  return fingerprintApi(req, judgeRules(redactions), provider.fingerprintHeaders, undefined, { matchPath, roundNumbers });
}
