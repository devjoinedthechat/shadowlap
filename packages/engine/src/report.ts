import { importedRecording } from './classify.js';
import { wholeInput } from './tokens.js';
import { firstDifference } from './diff.js';
import { isJudgeCall } from './judge-scope.js';
import { normalizeAddCommand } from './volatile.js';
import { loadApiRequest } from './manifest.js';
import { estimateCost, formatUsd, type Price } from './prices.js';
import { safeLine, safeText } from './text.js';
import type { Store } from './store.js';
import type { CallKind, CallRecord, DivergenceReport, JudgeSummary, NotReached, Origin, RunRecord, RunSummary, Usage } from './types.js';

/** The model a call was made with: stored at record time, or supplied by a resolver that can read the request. */
export type ModelResolver = (call: CallRecord) => string | null | undefined;

export interface SummaryOptions {
  prices?: Record<string, Price>;
  modelOf?: ModelResolver;
}

/** Reads the model out of the stored request, for runs recorded before `meta.model` was stored. */
export function storedModelResolver(store: Store): ModelResolver {
  const cache = new Map<string, string | null>();
  return (call) => {
    if (call.kind !== 'api' || !call.requestRef) return null;
    let model = cache.get(call.requestRef);
    if (model === undefined) {
      try {
        const req = loadApiRequest(store, call.requestRef) as { model?: unknown } | null;
        model = typeof req?.model === 'string' ? req.model : (/models\/([^:/?]+):/.exec(call.name)?.[1] ?? null);
      } catch {
        model = null;
      }
      cache.set(call.requestRef, model);
    }
    return model;
  };
}

/**
 * What a run's judge calls did and cost: from the recording at no cost, or live. An imported run's
 * were made somewhere else, as its other calls were, unless `imported` says otherwise: the judge
 * calls `pack` or `test --update` add to a recording that came from a pack are this machine's own,
 * and what they sent upstream and spent was sent and spent here.
 */
export function summarizeJudge(run: RunRecord, calls: readonly CallRecord[], options: SummaryOptions & { imported?: boolean } = {}): JudgeSummary {
  const imported = options.imported ?? importedRecording(run);
  const out: JudgeSummary = { calls: calls.length, replayed: 0, live: 0, notAsked: 0, upstreamRequests: 0, spent: 0, saved: 0, unknownModels: [] };
  for (const c of calls) {
    if (c.origin === 'replayed') out.replayed++;
    else if (c.origin === 'live' && c.end?.meta.offline) out.notAsked++;
    else if (c.origin === 'live') out.live++;
    if (c.origin === 'live' && !imported) out.upstreamRequests += [c.end, ...c.attempts].filter((e) => e && !e.meta.offline && !e.meta.injected && !e.meta.refused).length;
    const u = c.end?.meta.usage;
    if (!u) continue;
    const model = c.end?.meta.model ?? c.meta.model ?? options.modelOf?.(c) ?? null;
    const usd = estimateCost(model, u, options.prices);
    if (usd === null) {
      if (model && !out.unknownModels.includes(model)) out.unknownModels.push(model);
    } else if (c.origin === 'replayed') out.saved += usd;
    else if (c.origin === 'live' && !imported) out.spent += usd;
  }
  return out;
}

/**
 * Builds a run summary from its stored calls. `notReached` comes from the session at run end. The
 * judge's calls (scope `shadowlap:judge`) are summed apart, as `judge`: everything else is the
 * agent's own, so adding a judge check never changes what a run says the agent did or cost.
 */
export function summarizeRun(run: RunRecord, allCalls: CallRecord[], notReached: NotReached[] = [], warnings: string[] = [], options: SummaryOptions = {}): RunSummary {
  const judged = allCalls.filter(isJudgeCall);
  const calls = judged.length ? allCalls.filter((c) => !isJudgeCall(c)) : allCalls;
  const byOrigin: Record<Origin, number> = { live: 0, replayed: 0, blocked: 0, stubbed: 0, overridden: 0 };
  const byKind: Record<CallKind, number> = { api: 0, tool: 0, clock: 0, random: 0 };
  const tokens: Usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const cost = { spent: 0, saved: 0, captured: 0, unknownModels: [] as string[] };
  // A run from a pack or a capture holds calls someone else's process made. Counting them as this
  // store's spend is how importing ten production captures would claim ten times the real cost. A
  // teammate's run pulled from the team store is the team's own: its requests and spend count, as
  // its author made them.
  const imported = importedRecording(run);
  let upstreamRequests = 0;
  let injected = 0;
  let refused = 0;
  for (const c of calls) {
    byOrigin[c.origin] = (byOrigin[c.origin] ?? 0) + 1;
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    // Model calls and tool calls alike: Shadowlap answered them itself (--fail-at), though they count as live.
    if (c.end?.meta.injected) injected++;
    // Answered with the reason it could not be sent (an intervention it could not take, a placeholder key), instead of being sent.
    else if (c.end?.meta.refused) refused++;
    if (c.kind !== 'api') continue;
    // Offline refusals (`shadowlap test`) never reached the provider, and neither did an injected
    // failure or a refused call, which Shadowlap answered itself; an imported run's calls were made
    // somewhere else.
    if (c.origin === 'live' && !imported) upstreamRequests += [c.end, ...c.attempts].filter((e) => e && !e.meta.offline && !e.meta.injected && !e.meta.refused).length;
    const u = c.end?.meta.usage;
    if (!u) continue;
    if (c.origin === 'replayed') {
      tokens.inputTokens += u.inputTokens;
      tokens.outputTokens += u.outputTokens;
      tokens.cacheReadInputTokens! += u.cacheReadInputTokens ?? 0;
      tokens.cacheCreationInputTokens! += u.cacheCreationInputTokens ?? 0;
    }
    const model = c.end?.meta.model ?? c.meta.model ?? options.modelOf?.(c) ?? null;
    const usd = estimateCost(model, u, options.prices);
    if (usd === null) {
      if (model && !cost.unknownModels.includes(model)) cost.unknownModels.push(model);
    } else if (c.origin === 'replayed') cost.saved += usd;
    else if (c.origin === 'live' && imported) cost.captured += usd;
    else if (c.origin === 'live') cost.spent += usd;
  }
  return {
    runId: run.runId,
    mode: run.mode,
    status: run.status,
    total: calls.length,
    byOrigin,
    byKind,
    upstreamRequests,
    injected,
    refused,
    imported,
    tokensNotRespent: tokens,
    cost,
    durationMs: run.endedAt !== null ? run.endedAt - run.startedAt : null,
    notReached,
    warnings,
    divergence: run.divergence,
    ...(judged.length ? { judge: summarizeJudge(run, judged, options) } : {}),
  };
}

/** An estimate in dollars: `≈$0.0004`, and `<$0.001` as it is. */
export function aboutUsd(n: number): string {
  const s = formatUsd(n);
  return s.startsWith('<') ? s : `≈${s}`;
}

/** What a run's judge calls did and cost, part by part: `1 call`, `1 from the recording, free`, `0 upstream requests`. */
export function judgeParts(j: JudgeSummary): string[] {
  const parts = [`${j.calls} call${j.calls === 1 ? '' : 's'}`];
  if (j.replayed) parts.push(`${j.replayed} from the recording, free`);
  if (j.live) parts.push(`${j.live} live${j.spent ? ` (${aboutUsd(j.spent)})` : j.unknownModels.length ? ` (no price for ${j.unknownModels.join(', ')})` : ''}`);
  if (j.notAsked) parts.push(`${j.notAsked} not asked (no recorded verdict, and no way to ask live)`);
  parts.push(`${j.upstreamRequests} upstream request${j.upstreamRequests === 1 ? '' : 's'}`);
  return parts;
}

/** The judge's part of a run, in one line: `judge: 1 call · 1 from the recording, free · 0 upstream requests`. */
export function judgeLine(j: JudgeSummary): string {
  return `judge: ${judgeParts(j).join(' · ')}`;
}

export interface Palette {
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  cyan: (s: string) => string;
}

export const plain: Palette = { green: (s) => s, red: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s, cyan: (s) => s };

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}

/** The end-of-run summary line(s). */
export function formatSummary(s: RunSummary, p: Palette = plain): string {
  const lines: string[] = [];
  const kinds = `${s.byKind.api} api, ${s.byKind.tool} tool` + (s.byKind.clock + s.byKind.random ? `, ${s.byKind.clock + s.byKind.random} clock/random` : '');
  if (s.total === 0) {
    lines.push(`${p.yellow('⚠')} ${s.mode === 'record' ? 'Recorded' : 'Replayed'} ${p.bold(s.runId)}: no calls were made. Did the agent start, and does it use the Shadowlap environment?`);
  } else if (s.mode === 'record') {
    lines.push(`${p.green('●')} Recorded ${p.bold(s.runId)}: ${s.total} calls (${kinds}), ${s.upstreamRequests} upstream requests${s.cost.spent ? `, ≈${formatUsd(s.cost.spent)}` : ''}`);
  } else if (s.divergence?.type === 'ended_early') {
    const d = s.divergence;
    const saved = wholeInput(s.tokensNotRespent);
    lines.push(`${p.red('✗')} Ended early at call ${d.callNo}: ${endedEarlyCount(d)} replayed (${kinds}), ${s.upstreamRequests} upstream requests, ${formatTokens(saved)} input tokens not re-spent`);
  } else if (!s.divergence) {
    const saved = wholeInput(s.tokensNotRespent);
    lines.push(
      `${p.green('✓')} Replay clean: ${s.byOrigin.replayed}/${s.total} calls replayed (${kinds}), ${s.upstreamRequests} upstream requests, ${formatTokens(saved)} input tokens not re-spent${s.cost.saved ? ` (≈${formatUsd(s.cost.saved)})` : ''}`,
    );
  } else {
    const d = s.divergence;
    // An injected failure is stored as live but was answered by Shadowlap (--fail-at), and so was a
    // call an intervention could not be applied to: each is named apart.
    const refused = s.refused ?? 0;
    const live = s.byOrigin.live - s.injected - refused;
    const { blocked, stubbed } = s.byOrigin;
    const writes = blocked + stubbed;
    const fenced = !writes ? '' : blocked && stubbed ? `, ${writes} writes (${blocked} blocked, ${stubbed} stubbed)` : `, ${writes} write${writes === 1 ? '' : 's'} ${blocked ? 'blocked' : 'stubbed'}`;
    lines.push(
      `${p.yellow('⑂')} Forked at call ${d.callNo}: ${d.replayedBefore} calls replayed` +
        (s.byOrigin.overridden ? ` (${s.byOrigin.overridden} overridden)` : '') +
        `, then ${live} live` +
        (s.injected ? `, ${s.injected} injected` : '') +
        (refused ? `, ${refused} refused` : '') +
        fenced +
        `; ${s.upstreamRequests} upstream requests` +
        // What replaying didn't spend again, in the words `show` and the dashboard's receipt use.
        (s.cost.spent || s.cost.saved ? ` (≈${formatUsd(s.cost.spent)} spent, ${formatUsd(s.cost.saved)} not re-spent)` : ''),
    );
  }
  if (s.status === 'failed' || s.status === 'crashed') lines.push(p.red(`  the agent process ${s.status === 'crashed' ? 'was interrupted' : 'exited with an error'}`));
  // The judge's calls are no part of the line above: what they did and cost comes apart.
  if (s.judge) lines.push(p.dim(`  ${judgeLine(s.judge)}`));
  // After a fork the divergence report already covers the recorded call it was compared with. A
  // replay that ended early was compared with none: the calls it never made are all listed.
  const counterpart = s.divergence?.type === 'ended_early' ? undefined : s.divergence?.counterpart?.callNo;
  const unused = s.notReached.filter((n) => n.callNo !== counterpart);
  if (unused.length && s.total > 0) {
    const preview = unused
      .slice(0, 3)
      .map((n) => `#${n.callNo} ${safeLine(n.name)}`)
      .join(', ');
    const what = s.divergence && s.divergence.type !== 'ended_early' ? 'left unused after the fork' : 'not reached';
    lines.push(p.dim(`  ${unused.length} recorded call${unused.length === 1 ? '' : 's'} ${what}: ${preview}${unused.length > 3 ? ', …' : ''}`));
  }
  for (const w of s.warnings) lines.push(p.yellow(`  ! ${safeText(w)}`));
  return lines.join('\n');
}

const MAX_STR = 160;

function renderValue(v: unknown, other?: unknown): string {
  if (typeof v === 'string') {
    let s = v;
    let prefix = '';
    if (typeof other === 'string' && v.length > MAX_STR) {
      const at = firstDifference(v, other);
      const start = Math.max(0, at - 40);
      s = v.slice(start, start + MAX_STR);
      prefix = start > 0 ? '…' : '';
    } else if (v.length > MAX_STR) {
      s = v.slice(0, MAX_STR);
    }
    const suffix = s.length < v.length - (prefix ? 40 : 0) ? '…' : '';
    return JSON.stringify(prefix + s + suffix);
  }
  const json = JSON.stringify(v);
  return json === undefined ? String(v) : json.length > MAX_STR ? json.slice(0, MAX_STR) + '…' : json;
}

/** How much of its recording a replay that ended early made: `10 of 30 recorded calls`. */
export function endedEarlyCount(d: Pick<DivergenceReport, 'replayedBefore' | 'recorded'>): string {
  return d.recorded !== undefined ? `${d.replayedBefore} of ${d.recorded} recorded calls` : `${d.replayedBefore} recorded calls`;
}

/**
 * A divergence in one line, as test, bisect and the recordings report it: `diverged at call 4 (api
 * POST /v1/messages)`, or for a replay that stopped short, `ended early at call 11 (api POST
 * /v1/messages): 10 of 30 recorded calls replayed`.
 */
export function divergenceLine(d: Pick<DivergenceReport, 'type' | 'callNo' | 'kind' | 'name' | 'replayedBefore' | 'recorded'>): string {
  const at = `call ${d.callNo} (${d.kind} ${safeLine(d.name)})`;
  return d.type === 'ended_early' ? `ended early at ${at}: ${endedEarlyCount(d)} replayed` : `diverged at ${at}`;
}

/**
 * What a replay served from its recording before it diverged: `16 calls replayed`, or, given the
 * run's calls, with those an override answered instead named apart (`15 calls replayed and #16
 * overridden`), as the run's page says it and its Calls view shows each call.
 */
export function replayedBeforeWords(d: Pick<DivergenceReport, 'callNo' | 'replayedBefore'>, calls?: ReadonlyArray<Pick<CallRecord, 'callNo' | 'origin'>>): string {
  const over = (calls ?? []).filter((c) => c.origin === 'overridden' && c.callNo < d.callNo).map((c) => `#${c.callNo}`);
  const n = Math.max(0, d.replayedBefore - over.length);
  const replayed = `${n} ${n === 1 ? 'call' : 'calls'} replayed`;
  if (!over.length) return replayed;
  const named = over.length > 1 ? `${over.slice(0, -1).join(', ')} and ${over.at(-1)}` : over[0];
  return `${replayed} and ${named} overridden`;
}

/**
 * The divergence report: the first unmatched call, its closest counterpart, and a structural diff.
 * Given the run's calls, the calls an override answered before it are named apart from those replayed.
 */
export function formatDivergence(d: DivergenceReport, p: Palette = plain, maxEntries = 12, calls?: ReadonlyArray<Pick<CallRecord, 'callNo' | 'origin'>>): string {
  const lines: string[] = [];
  if (d.type === 'ended_early') {
    lines.push(`${p.red('✗')} Ended early at call ${d.callNo} (${d.kind} ${safeLine(d.name)}): ${endedEarlyCount(d)} replayed`);
    lines.push(p.dim(`  every request the agent sent matched, but it stopped before its recording did, without making #${d.callNo}`));
    return lines.join('\n');
  }
  const head = `${p.red('✗')} Diverged at call ${d.callNo} (${d.kind} ${safeLine(d.name)}): ${replayedBeforeWords(d, calls)} before divergence`;
  lines.push(head);
  switch (d.type) {
    case 'forced':
      lines.push(p.dim(`  ${safeLine(d.reason ?? 'forced live by --live-tool or --diverge-at')}`));
      break;
    case 'beyond_recording':
      lines.push(p.dim('  beyond the recording: the agent made more calls than were recorded'));
      break;
    case 'new_call':
      lines.push(p.dim(`  new call: ${safeLine(d.reason ?? 'no recorded counterpart')}`));
      break;
    case 'request_changed': {
      // An intervention's change names its flag.
      if (d.reason) lines.push(p.dim(`  ${safeLine(d.reason)}`));
      if (d.counterpart) lines.push(p.dim(`  compared with run ${shortId(d.counterpart.runId)}, call ${d.counterpart.callNo}`));
      const entries = d.diff ?? [];
      for (const e of entries.slice(0, maxEntries)) {
        const sym = e.op === 'changed' ? '~' : e.op === 'added' ? '+' : '-';
        lines.push(`  ${p.cyan(sym)} ${safeLine(e.path)}`);
        if (e.op !== 'added') lines.push(p.red(`      - ${safeText(renderValue(e.before, e.after))}`));
        if (e.op !== 'removed') lines.push(p.green(`      + ${safeText(renderValue(e.after, e.before))}`));
      }
      if (entries.length > maxEntries) lines.push(p.dim(`  … ${entries.length - maxEntries} more`));
      for (const h of d.hints ?? []) {
        lines.push(p.yellow(`  hint: ${safeLine(h.message)}`));
        // The rule as every other place prints it, with its replacement.
        if (h.normalizer) lines.push(p.yellow(`        ${safeLine(normalizeAddCommand(h.normalizer))}`));
      }
      break;
    }
  }
  return lines.join('\n');
}
