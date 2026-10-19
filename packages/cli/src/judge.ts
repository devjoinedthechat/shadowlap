import { canonicalize, estimateCost, isJudgeCall, JUDGE_SCOPE, judgeAskId, judgeMaterial, judgeRequest, judgeTarget, loadApiRequest, readVerdict, type CallRecord, type JudgeProvider, type JudgeSummary, type Normalizer, type Price, type RunRecord, type Store } from '@shadowlap/engine';
import { providers, Sidecar } from '@shadowlap/sidecar';
import type { ShadowlapConfig } from './config.js';
import type { JudgeCheck } from './judge-check.js';
import type { JudgedEntry } from './judge-results.js';

/**
 * Judge checks at runtime. After the agent exits, each judge check's question goes through the
 * sidecar in the scope `shadowlap:judge`, as one model request, so its call is stored in the run
 * like any other: a clean replay sends the same request and is answered from the recording, free
 * and the same verdict every time; a fork, whose material changed, asks the judge live and records
 * it. Where the judge can't be asked live (no key, a test that runs offline), a request the
 * recording doesn't hold is answered by no one, and the check is inconclusive, never passed.
 *
 * `pack` and `test --update` judge a run that has ended: its judge calls are added to it
 * (Sidecar.openForJudge), so the pack carries them and every replay of it is judged for free.
 */

/** The environment variables a provider's key is read from, in order. */
export const JUDGE_KEYS: Record<JudgeProvider, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

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
  prices?: Record<string, Price>;
}

/** What the material of a judge check comes from: a run's calls, and what its agent printed (null for a recording, which keeps none). */
export interface JudgeMaterialSource {
  calls: CallRecord[];
  output: string | null;
}

export interface Judged {
  /** The checks that got a verdict, by name: what `evaluateChecks` takes as `judgeVerdicts`. */
  verdicts: Map<string, JudgedEntry>;
  /** Why each other check got none. */
  notJudged: Map<string, string>;
}

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

/** One judge check, asked through the sidecar: its verdict, or why it has none. */
async function askJudge(j: JudgeCheck, material: JudgeMaterialSource, ctx: JudgeRunContext): Promise<JudgedEntry | { why: string }> {
  const target = judgeTarget(j.model);
  if (!target) return { why: `Shadowlap can't tell which provider serves ${j.model}` };
  const m = judgeMaterial(ctx.store, material.calls, j.of, { output: material.output, redact: ctx.redact ?? [] });
  if ('missing' in m) return { why: m.missing };
  const request = judgeRequest(target, j, m);
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
    ...request.headers,
    // No way to ask it live: the recording answers, or no one does.
    ...('headers' in live ? { ...live.headers, ...(upstream ? { 'x-shadowlap-judge-upstream': upstream } : {}) } : { 'x-shadowlap-judge-offline': '1' }),
  };
  let res: Response;
  try {
    res = await fetch(`${ctx.sidecar.url}/r/${encodeURIComponent(ctx.runId)}/${target.provider}${request.path}`, { method: 'POST', headers, body: JSON.stringify(request.body) });
  } catch (err) {
    return { why: `the judge's call failed: ${(err as Error).message}` };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? undefined;
  if (res.status === 503 && bytes.toString('utf8').includes('shadowlap_offline')) return { why: `no recorded verdict and ${'why' in live ? live.why : 'the test runs offline'}` };
  if (res.status >= 400) return { why: `the judge's call failed: HTTP ${res.status}${errorMessage(bytes)}` };
  const verdict = readVerdict(bytes, contentType, target.provider);
  if ('error' in verdict) return { why: verdict.error };
  const source = res.headers.get('x-shadowlap-origin') === 'replayed' ? 'recording' : 'live';
  const cost = source === 'recording' ? 0 : estimateCost(target.model, provider?.extractUsage(bytes, contentType) ?? undefined, ctx.prices);
  return { ...verdict, source, cost, redactions: m.redactions, cut: m.cut };
}

/**
 * Asks each judge check about a run, one after another, through the sidecar that has the run open:
 * after its agent exited, before the run ends. What it reads comes from `material`.
 */
export async function askJudges(judges: readonly JudgeCheck[], material: JudgeMaterialSource, ctx: JudgeRunContext): Promise<Judged> {
  const verdicts = new Map<string, JudgedEntry>();
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

/**
 * The verdict a run already holds for a judge check: its own judge call for the same ask (question,
 * what it reads, model), the newest that got one. With `material`, only a call that sent the very
 * request the check would send now, so a pack never keeps a verdict its replays would not ask for.
 */
export function heldVerdict(store: Store, calls: readonly CallRecord[], j: JudgeCheck, o: { material?: JudgeMaterialSource; redact?: readonly Normalizer[] } = {}): (JudgedEntry & { callNo: number }) | null {
  const ask = judgeAskId(j);
  const target = judgeTarget(j.model);
  let wanted: string | null = null;
  if (o.material && target) {
    const m = judgeMaterial(store, o.material.calls, j.of, { output: o.material.output, redact: o.redact ?? [] });
    if ('missing' in m) return null;
    wanted = canonicalize(judgeRequest(target, j, m).body);
  }
  for (const c of [...calls].reverse()) {
    if (!isJudgeCall(c) || c.meta.judge?.ask !== ask || c.end?.outcome !== 'ok' || !c.end.responseRef) continue;
    if (wanted !== null) {
      let sent: unknown;
      try {
        sent = c.requestRef ? loadApiRequest(store, c.requestRef) : null;
      } catch {
        continue;
      }
      if (canonicalize(sent) !== wanted) continue;
    }
    const provider = c.end.meta.provider ?? c.meta.provider;
    const verdict = readVerdict(store.getBlob(c.end.responseRef), c.end.meta.headers?.['content-type'], typeof provider === 'string' ? provider : undefined);
    if ('error' in verdict) continue;
    return { ...verdict, source: 'recording', cost: 0, callNo: c.callNo };
  }
  return null;
}

/** Every judge check a run already holds a verdict for, as `evaluateChecks` takes them; the rest have no recorded verdict. */
export function recordedVerdicts(store: Store, calls: readonly CallRecord[], judges: readonly JudgeCheck[]): Judged {
  const out: Judged = { verdicts: new Map(), notJudged: new Map() };
  for (const j of judges) {
    const held = heldVerdict(store, calls, j);
    if (held) out.verdicts.set(j.name, held);
    else out.notJudged.set(j.name, j.of === 'output' ? 'no recorded verdict, and a recording keeps no output to judge' : 'no recorded verdict');
  }
  return out;
}

export interface JudgedRun extends Judged {
  /** What the judge's calls made now did and cost; null when none was made. */
  judge: JudgeSummary | null;
  /** The checks whose verdict the run already held, which were not asked again. */
  held: string[];
}

/**
 * Judges a run that has ended, and keeps each judge call in it: a verdict it already holds for the
 * very request is kept and not asked again; every other check is asked through a sidecar that has
 * the run open for its judge alone, live where it can be (`upstreams`), so the run, and a pack of
 * it, holds the verdict from then on. `material` is what the judge reads: the run's own calls, or,
 * for a golden whose clean replay printed its output, the replay's.
 */
export async function judgeEndedRun(store: Store, run: RunRecord, judges: readonly JudgeCheck[], o: { material?: JudgeMaterialSource; config: Pick<ShadowlapConfig, 'normalize' | 'redact' | 'prices' | 'clock' | 'http'>; upstreams: Record<string, string>; env?: NodeJS.ProcessEnv }): Promise<JudgedRun> {
  const calls = store.getCalls(run.runId);
  const material = o.material ?? { calls, output: null };
  const out: JudgedRun = { verdicts: new Map(), notJudged: new Map(), judge: null, held: [] };
  const ask: JudgeCheck[] = [];
  for (const j of judges) {
    const held = heldVerdict(store, calls, j, { material, redact: o.config.redact });
    if (held) {
      out.verdicts.set(j.name, held);
      out.held.push(j.name);
    } else ask.push(j);
  }
  if (!ask.length) return out;
  const sidecar = await Sidecar.start({ store, normalizers: o.config.normalize, upstreams: o.upstreams, ...(o.config.prices ? { prices: o.config.prices } : {}), ...(o.config.clock ? { clock: o.config.clock } : {}), ...(o.config.http ? { http: o.config.http } : {}) });
  try {
    sidecar.openForJudge(run.runId);
    const asked = await askJudges(ask, material, { sidecar, store, runId: run.runId, upstreams: o.upstreams, redact: o.config.redact, ...(o.config.prices ? { prices: o.config.prices } : {}), ...(o.env ? { env: o.env } : {}) });
    for (const [k, v] of asked.verdicts) out.verdicts.set(k, v);
    for (const [k, v] of asked.notJudged) out.notJudged.set(k, v);
    out.judge = sidecar.closeForJudge(run.runId);
  } finally {
    await sidecar.close();
  }
  return out;
}
