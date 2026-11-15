import { createHash } from 'node:crypto';
import { canonicalize, estimateCost, heldVerdict, isJudgeCall, JUDGE_NOT_ASKED, JUDGE_REQUEST_VERSION, JUDGE_SCOPE, judgeAskId, judgeMaterialFor, judgeRequest, judgeTarget, loadApiRequest, matchedClockOf, materialDifference, materialOfRequest, messageOf, readVerdict, type ClockMode, type JudgeMaterial, type JudgeMaterialSource, type JudgeProvider, type JudgeRequest, type JudgeSummary, type Judged, type Normalizer, type Price, type RunRecord, type Store, type StoreOf } from '@shadowlap/engine';
import { providers, Sidecar } from '@shadowlap/sidecar';
import { JUDGE_KEYS, judgeChecksOf, type JudgeCheck, type JudgeVerdict, type TestSpec } from './checks.js';
import type { ShadowlapConfig } from './config.js';

/**
 * Judge checks at runtime. After the agent exits, each judge check's question goes through the
 * sidecar in the scope `shadowlap:judge`, as one model request, so its call is stored in the run
 * like any other: a clean replay sends the same request and is answered from the recording, free
 * and the same verdict every time; a fork, whose material changed, asks the judge live and records
 * it. A recorded verdict answers only the very request it was given, byte for byte: what the judge
 * reads has what replay matching masks masked already (the project's normalizers, dates near the
 * run's start), so a clean replay asks what its recording asked, and nothing else is ever matched
 * fuzzily. Where the judge can't be asked live (no key, a test that runs offline), a request the
 * recording doesn't hold is answered by no one, nothing of it is kept, and the check is
 * inconclusive, never passed, with why.
 *
 * `pack` and `test --update` judge a run that has ended: its judge calls are added to it
 * (Sidecar.openForJudge), so the pack carries them and every replay of it is judged for free.
 */

/**
 * Every judge check a spec holds, those under a `when` included: what is asked after the agent
 * exits. The one place the runtime reads them.
 */
export function judgesOf(spec: TestSpec | null | undefined): JudgeCheck[] {
  return spec ? judgeChecksOf(spec) : [];
}

function authHeaders(provider: JudgeProvider, name: string, key: string): Record<string, string> {
  if (provider === 'anthropic') return name === 'ANTHROPIC_AUTH_TOKEN' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key };
  if (provider === 'gemini') return { 'x-goog-api-key': key };
  return { authorization: `Bearer ${key}` };
}

/**
 * How a judge on `provider` can be asked live through `upstreams` (the run's): with the key the
 * environment holds for it, or through an upstream configured for it (a mock, a local server) with
 * whatever key there is. Why not, when it can't: the run is offline, or there is no key.
 */
export function liveJudge(provider: JudgeProvider, upstreams: Record<string, string>, env: NodeJS.ProcessEnv = process.env): { headers: Record<string, string> } | { why: string } {
  const upstream = upstreams[provider];
  if (upstream === 'offline') return { why: 'the test runs offline' };
  const name = JUDGE_KEYS[provider].find((k) => env[k]?.trim());
  if (!name && !upstream) return { why: `no key for ${provider} (${JUDGE_KEYS[provider].join(' or ')})` };
  return { headers: name ? authHeaders(provider, name, env[name]!.trim()) : {} };
}

export interface JudgeRunContext {
  sidecar: Sidecar;
  store: Store;
  /** The run the judge's calls are made in. */
  runId: string;
  /** The upstreams the run's calls go to: `offline` for a provider that may not be asked live. */
  upstreams: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  /** The project's redaction rules: what the judge reads has them applied. */
  redact?: readonly Normalizer[];
  /** The project's normalizers: what the judge reads has them applied, as replay matching applies them. */
  normalize?: readonly Normalizer[];
  prices?: Record<string, Price>;
}

/**
 * What a judge check's material comes from, what `evaluateChecks` takes of judged checks, and the
 * verdicts a run already holds: the engine's (checks/recorded.ts), which `shadowlap check` and the
 * dashboard judge recordings by. The CLI's modules import them from here.
 */
export { heldVerdict, judgedOptions, recordedVerdicts, type Judged, type JudgeMaterialSource } from '@shadowlap/engine';

/** A run's calls and output as the material of its judge checks, with the dates matching masks in it under `clock`. */
export function materialOf(store: StoreOf<'recording'>, runId: string, output: string | null, clock: ClockMode | undefined, calls = store.getCalls(runId)): JudgeMaterialSource {
  const ref = matchedClockOf(store, runId, clock);
  return { calls, output, ...(ref !== undefined ? { clock: ref } : {}) };
}

/** How many times a judge's call that may pass is asked again, and how long it waits before each: half a second, then two. */
const RETRIES = 2;
const pause = (attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 500 : 2_000));

/** What a provider's error body says, as ": <message>", or nothing. */
function errorMessage(bytes: Buffer): string {
  try {
    const body = JSON.parse(bytes.toString('utf8')) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof body.error === 'object' ? body.error?.message : typeof body.error === 'string' ? body.error : body.message;
    return typeof m === 'string' && m ? `: ${m.slice(0, 300)}` : '';
  } catch {
    return '';
  }
}

/**
 * Why the recording doesn't answer a check's request, when the judge can't be asked live either:
 * it holds no verdict for the check's question at all; or only one given to an older form of the
 * judge's request; or one given on other material, and where that differs from what the judge
 * would read now (a value that changes every run, which no normalizer masks).
 */
function whyNotAnswered(store: StoreOf<'recording'>, runId: string, j: JudgeCheck, request: { body: unknown }, cannot: string): string {
  const run = store.getRun(runId);
  const recording = run?.parentRunId ? store.getRun(run.parentRunId) : null;
  const ask = judgeAskId(j);
  const held = recording ? store.getCalls(recording.runId).filter((c) => isJudgeCall(c) && c.meta.judge?.ask === ask && c.end?.outcome === 'ok' && c.requestRef) : [];
  const newest = held.at(-1);
  if (!newest) return `no recorded verdict and ${cannot}`;
  if ((newest.meta.judge?.v ?? 1) !== JUDGE_REQUEST_VERSION) return `the recording's verdict was given to an older form of the judge's request, and ${cannot}: record it again with shadowlap test --update`;
  let before: string | null = null;
  try {
    before = materialOfRequest(loadApiRequest(store, newest.requestRef!));
  } catch {
    // unreadable: it says no more than that the material changed
  }
  const now = materialOfRequest(request.body);
  const where = before !== null && now !== null ? `: ${materialDifference(before, now)}` : '';
  return `the recording's verdict was given on other material${where}, and ${cannot}`;
}

/** A judge check's request, made from what it reads, before it is sent. */
export interface PreparedJudge {
  target: { provider: JudgeProvider; model: string };
  request: JudgeRequest;
  material: JudgeMaterial;
}

/**
 * The request a judge check sends about `material`, read from `store` with the project's rules (its
 * redactions, then what matching masks), or why there is none: its model has no provider shadowlap
 * knows, a rule can't be applied (nothing is sent unmasked), or the run holds nothing it reads.
 */
export function prepareJudge(store: Store, j: JudgeCheck, material: JudgeMaterialSource, o: { redact?: readonly Normalizer[] | undefined; normalize?: readonly Normalizer[] | undefined }): PreparedJudge | { why: string } {
  const target = judgeTarget(j.model);
  if (!target) return { why: `shadowlap can't tell which provider serves ${j.model}` };
  let m: ReturnType<typeof judgeMaterialFor>;
  try {
    m = judgeMaterialFor(store, j, material, o);
  } catch (err) {
    // A redaction rule that can't be applied: nothing is sent unmasked.
    return { why: `what it reads could not be made: ${messageOf(err)}` };
  }
  if ('missing' in m) return { why: m.missing };
  return { target, request: judgeRequest(target, j, m), material: m };
}

/** A judge's request as a digest: the same digest is the very same request, which gets the same verdict. */
export function judgeRequestDigest(r: Pick<JudgeRequest, 'provider' | 'path' | 'body'>): string {
  return createHash('sha256').update(canonicalize({ provider: r.provider, path: r.path, body: r.body })).digest('hex').slice(0, 32);
}

/** One judge check, asked through the sidecar: its verdict, or why it has none. */
async function askJudge(j: JudgeCheck, material: JudgeMaterialSource, ctx: JudgeRunContext): Promise<JudgeVerdict | { why: string }> {
  const prepared = prepareJudge(ctx.store, j, material, ctx);
  if ('why' in prepared) return prepared;
  return askPreparedJudge(j, prepared, ctx);
}

/**
 * A judge check's prepared request, asked through the sidecar that has `ctx.runId` open: answered from
 * the run's recording when it holds the very request, else live where the judge can be asked (its
 * key, or an upstream for its provider), else by no one, with why.
 */
export async function askPreparedJudge(j: JudgeCheck, prepared: PreparedJudge, ctx: JudgeRunContext): Promise<JudgeVerdict | { why: string }> {
  const { target, request, material: m } = prepared;
  const live = liveJudge(target.provider, ctx.upstreams, ctx.env);
  const provider = providers.find((p) => p.id === target.provider);
  // Asked live, the judge goes to its provider as the environment names it, or to the provider itself:
  // never to an upstream the run points at a model under test.
  const upstream = ctx.upstreams[target.provider] ?? provider?.upstream;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-shadowlap-scope': JUDGE_SCOPE,
    'x-shadowlap-judge': ctx.sidecar.judgeToken,
    'x-shadowlap-judge-check': encodeURIComponent(j.name),
    'x-shadowlap-judge-ask': judgeAskId(j),
    'x-shadowlap-judge-version': String(JUDGE_REQUEST_VERSION),
    ...request.headers,
    // No way to ask it live: the recording answers, or no one does.
    ...('headers' in live ? { ...live.headers, ...(upstream ? { 'x-shadowlap-judge-upstream': upstream } : {}) } : { 'x-shadowlap-judge-offline': '1' }),
  };
  // A failure that may pass (rate limited, overloaded, a dropped connection) is asked again, twice, as
  // the providers' SDKs do: the sidecar keeps the attempts as one call.
  let res: Response;
  let bytes: Buffer;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${ctx.sidecar.url}/r/${encodeURIComponent(ctx.runId)}/${target.provider}${request.path}`, { method: 'POST', headers, body: JSON.stringify(request.body) });
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt < RETRIES) {
        await pause(attempt);
        continue;
      }
      return { why: `the judge's call failed: ${messageOf(err)}` };
    }
    if (res.status === 503 && bytes.toString('utf8').includes('shadowlap_offline')) return { why: whyNotAnswered(ctx.store, ctx.runId, j, request, 'why' in live ? live.why : 'the test runs offline') };
    if (attempt < RETRIES && (res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500)) {
      await pause(attempt);
      continue;
    }
    break;
  }
  const contentType = res.headers.get('content-type') ?? undefined;
  if (res.status >= 400) return { why: `the judge's call failed: HTTP ${res.status}${errorMessage(bytes)}` };
  const verdict = readVerdict(bytes, contentType, target.provider);
  if ('error' in verdict) return { why: verdict.error };
  const source = res.headers.get('x-shadowlap-origin') === 'replayed' ? 'recording' : 'live';
  const cost = source === 'recording' ? 0 : estimateCost(target.model, provider?.extractUsage(bytes, contentType) ?? undefined, ctx.prices);
  return { ...verdict, source, cost, redactions: m.redactions, normalized: m.normalized, cut: m.cut };
}

/**
 * Asks each judge check about a run, one after another, through the sidecar that has the run open:
 * after its agent exited, before the run ends. What it reads comes from `material`.
 */
export async function askJudges(judges: readonly JudgeCheck[], material: JudgeMaterialSource, ctx: JudgeRunContext): Promise<Judged> {
  const verdicts = new Map<string, JudgeVerdict>();
  const notJudged = new Map<string, string>();
  for (const j of judges) {
    const r = await askJudge(j, material, ctx);
    if ('why' in r) notJudged.set(j.name, r.why);
    else verdicts.set(j.name, r);
  }
  if (verdicts.size) {
    // Each verdict's call in the run, newest last, for the reports to point at.
    const calls = ctx.store.getCalls(ctx.runId).filter(isJudgeCall);
    for (const [name, v] of verdicts) {
      const call = calls.filter((c) => c.meta.judge?.check === name).at(-1);
      if (call) v.callNo = call.callNo;
    }
  }
  return { verdicts, notJudged };
}

/** Judge checks a run's agent didn't finish for: none is judged, and each says why. */
export function unjudged(judges: readonly JudgeCheck[], why: string): Judged {
  return { verdicts: new Map(), notJudged: new Map(judges.map((j) => [j.name, why])) };
}

/** Judge checks an attempt asks none of, as another of its checks failed and no verdict could pass it: each is not applicable, and says why. */
export function notAsked(judges: readonly JudgeCheck[]): Judged {
  return { verdicts: new Map(), notJudged: new Map(), notAsked: new Map(judges.map((j) => [j.name, JUDGE_NOT_ASKED])) };
}

export interface JudgedRun extends Judged {
  /** What the judge's calls made now did and cost; null when none was made. */
  judge: JudgeSummary | null;
  /** The checks whose verdict the run already held, which were not asked again. */
  held: string[];
}

/**
 * Why a run that has ended can't be judged, or null when it can: one that failed or was stopped is
 * never judged by its replays either (judgeAttempt), so a verdict for it would never be read, only
 * paid for.
 */
export function cannotJudge(run: RunRecord): string | null {
  if (run.status === 'completed') return null;
  if (run.status === 'running') return 'the run is still recording';
  return `the run did not complete (${run.status === 'failed' ? 'its agent exited with an error' : 'it was interrupted'}), and no replay of it is judged`;
}

/**
 * Judges a run that has ended, and keeps each judge call in it: a verdict it already holds for the
 * very request is kept and not asked again; every other check is asked through a sidecar that has
 * the run open for its judge alone, live where it can be (`upstreams`), so the run, and a pack of
 * it, holds the verdict from then on. `material` is what the judge reads: the run's own calls, or,
 * for a golden whose clean replay printed its output, the replay's. A run that didn't complete is
 * not judged (cannotJudge).
 */
export async function judgeEndedRun(store: Store, run: RunRecord, judges: readonly JudgeCheck[], o: { material?: JudgeMaterialSource; config: Pick<ShadowlapConfig, 'normalize' | 'redact' | 'prices' | 'clock' | 'http'>; upstreams: Record<string, string>; env?: NodeJS.ProcessEnv }): Promise<JudgedRun> {
  const out: JudgedRun = { verdicts: new Map(), notJudged: new Map(), judge: null, held: [] };
  const cannot = cannotJudge(run);
  if (cannot) return { ...out, notJudged: new Map(judges.map((j) => [j.name, cannot])) };
  const calls = store.getCalls(run.runId);
  const material = o.material ?? materialOf(store, run.runId, null, o.config.clock, calls);
  const ask: JudgeCheck[] = [];
  for (const j of judges) {
    const held = heldVerdict(store, calls, j, { material, redact: o.config.redact, normalize: o.config.normalize, redactions: run.meta?.redactions ?? [] });
    if (held) {
      out.verdicts.set(j.name, held);
      out.held.push(j.name);
      continue;
    }
    // With no recording above it to answer from, a judge that can't be asked live is not asked at
    // all: an unanswered call would only sit in the run, and in its pack.
    const target = judgeTarget(j.model);
    const live = target ? liveJudge(target.provider, o.upstreams, o.env) : null;
    if (!run.parentRunId && live && 'why' in live) out.notJudged.set(j.name, `no recorded verdict and ${live.why}`);
    else ask.push(j);
  }
  if (!ask.length) return out;
  const sidecar = await Sidecar.start({ store, normalizers: o.config.normalize, upstreams: o.upstreams, ...(o.config.prices ? { prices: o.config.prices } : {}), ...(o.config.clock ? { clock: o.config.clock } : {}), ...(o.config.http ? { http: o.config.http } : {}) });
  try {
    sidecar.openForJudge(run.runId);
    const asked = await askJudges(ask, material, { sidecar, store, runId: run.runId, upstreams: o.upstreams, redact: o.config.redact, normalize: o.config.normalize, ...(o.config.prices ? { prices: o.config.prices } : {}), ...(o.env ? { env: o.env } : {}) });
    for (const [k, v] of asked.verdicts) out.verdicts.set(k, v);
    for (const [k, v] of asked.notJudged) out.notJudged.set(k, v);
    out.judge = sidecar.closeForJudge(run.runId);
  } finally {
    await sidecar.close();
  }
  return out;
}
