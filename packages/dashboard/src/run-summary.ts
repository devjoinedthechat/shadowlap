import { estimateCost, importedRecording, JUDGE_SCOPE, shortModel, type CallRecord, type JudgeSummary, type ModelResolver, type Origin, type Price, type RunRecord, type RunSummary, type StoreOf, type Usage } from '@shadowlap/engine';

/**
 * What a run's page says of the whole run, worked out in SQL over its call events without reading
 * them into JavaScript: its summary (the engine's `summarizeRun`, the same numbers, the judge's calls
 * apart), every call's origin for the strip, its models' names, and how many model calls blame
 * stepped through. Reading a run of 20,000 calls whole takes a quarter of a second or more, most of
 * it building records nothing on the first page shows; this is one pass over its events, so a long
 * run's first page reads only the calls it shows (api.ts `runDetail`).
 *
 * Each call's flags are read as the summary reads them, by JavaScript's truthiness of the stored
 * value; the costs are priced from tokens summed per model, which is what pricing each call and
 * summing comes to (prices are per token).
 */

/** JavaScript's truthiness of the JSON value at `path` of the column `col`, as a reader of the parsed object sees it. */
const truthy = (col: string, path: string) =>
  `(CASE json_type(${col}, '${path}') WHEN 'true' THEN 1 WHEN 'integer' THEN json_extract(${col}, '${path}') != 0 WHEN 'real' THEN json_extract(${col}, '${path}') != 0 WHEN 'text' THEN length(json_extract(${col}, '${path}')) > 0 WHEN 'object' THEN 1 WHEN 'array' THEN 1 ELSE 0 END)`;

/**
 * One row per call: what the summary reads of it and of its final answer. With one max() in the
 * row, SQLite takes the other columns of the answers from the answer it found it in, the final one
 * (the highest attempt); a call with no answer yet has none. `clean` counts its answers that reached
 * a provider: neither refused offline, nor injected, nor refused.
 */
const CALLS = `
SELECT s.call_no AS n, s.kind AS kind, s.origin AS origin, s.name AS name, s.request_ref AS req,
       CASE WHEN json_extract(s.meta, '$.scope') = '${JUDGE_SCOPE}' THEN 1 ELSE 0 END AS judge,
       CASE WHEN json_type(s.meta, '$.extraRead') = 'true' THEN 1 ELSE 0 END AS extra,
       TOTAL(CASE WHEN e.attempt IS NOT NULL AND NOT ${truthy('e.meta', '$.injected')} AND NOT ${truthy('e.meta', '$.refused')} AND NOT ${truthy('e.meta', '$.offline')} THEN 1 ELSE 0 END) AS clean,
       MAX(e.attempt) AS last,
       COALESCE(json_extract(e.meta, '$.model'), json_extract(s.meta, '$.model')) AS model,
       e.outcome AS outcome,
       CASE WHEN json_type(e.meta, '$.injected') = 'true' THEN 1 ELSE 0 END AS strict,
       ${truthy('e.meta', '$.injected')} AS injected, ${truthy('e.meta', '$.refused')} AS refused, ${truthy('e.meta', '$.offline')} AS offline,
       ${truthy('e.meta', '$.usage')} AS used,
       json_extract(e.meta, '$.usage.inputTokens') AS ti, json_extract(e.meta, '$.usage.outputTokens') AS tout,
       json_extract(e.meta, '$.usage.cacheReadInputTokens') AS tcr, json_extract(e.meta, '$.usage.cacheCreationInputTokens') AS tcw
FROM call_events s LEFT JOIN call_events e ON e.run_id = s.run_id AND e.call_no = s.call_no AND e.phase = 'end'
WHERE s.run_id = ? AND s.phase = 'start'
GROUP BY s.call_no`;

/** A call's character on the strip (the engine's `displayOrigin` and `ORIGIN_CODE`). */
const CODE = `CASE WHEN strict = 1 THEN 'i' WHEN outcome = 'error' AND origin NOT IN ('blocked', 'stubbed') THEN 'f'
  ELSE CASE origin WHEN 'replayed' THEN 'r' WHEN 'live' THEN 'l' WHEN 'overridden' THEN 'o' WHEN 'blocked' THEN 'b' WHEN 'stubbed' THEN 's' END END`;

/**
 * The calls grouped by what the summary tells apart, in one statement over the calls read once: the
 * strip's characters (`origins`), the groups of calls that name a model or need none, the model
 * calls that name none, one each, whose model is read from their request, and the agent's extra
 * reads, one each (a replay's plain read answered live, `meta.extraRead`).
 */
const FACTS_SQL = `
WITH calls AS MATERIALIZED (${CALLS})
SELECT 'origins' AS what, group_concat(${CODE}, '' ORDER BY n) AS origins, NULL AS kind, NULL AS origin, NULL AS judge, NULL AS model,
       NULL AS injected, NULL AS refused, NULL AS offline, NULL AS used, NULL AS calls, NULL AS clean, NULL AS first,
       NULL AS ti, NULL AS tout, NULL AS tcr, NULL AS tcw, NULL AS name, NULL AS req FROM calls
UNION ALL
SELECT 'group', NULL, kind, origin, judge, model, injected, refused, offline, used, COUNT(*), TOTAL(clean), MIN(n),
       TOTAL(ti), TOTAL(tout), TOTAL(tcr), TOTAL(tcw), NULL, NULL
FROM calls WHERE model IS NOT NULL OR kind != 'api'
GROUP BY kind, origin, judge, model, injected, refused, offline, used
UNION ALL
SELECT 'unnamed', NULL, kind, origin, judge, NULL, injected, refused, offline, used, 1, clean, n, ti, tout, tcr, tcw, name, req
FROM calls WHERE model IS NULL AND kind = 'api'
UNION ALL
SELECT 'extra', NULL, kind, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, n, NULL, NULL, NULL, NULL, name, NULL
FROM calls WHERE extra = 1 AND judge = 0`;

/**
 * The agent's model calls that were answered in a blame's scope: how many, how many come up to the
 * blamed call (it included), and whether it is one of them. Bound, in order: the blamed call twice,
 * the run, then the scope four times (null for every scope).
 */
const STEPS_SQL = `
SELECT COUNT(*) AS m, TOTAL(s.call_no <= ?) AS k, TOTAL(s.call_no = ?) AS hit
FROM call_events s
WHERE s.run_id = ? AND s.phase = 'start' AND s.kind = 'api'
  AND EXISTS (SELECT 1 FROM call_events e WHERE e.run_id = s.run_id AND e.call_no = s.call_no AND e.phase = 'end')
  AND (json_extract(s.meta, '$.scope') IS NULL OR json_extract(s.meta, '$.scope') != '${JUDGE_SCOPE}')
  AND (? IS NULL OR (json_type(s.meta, '$.scope') = 'text' AND (json_extract(s.meta, '$.scope') = ? OR substr(json_extract(s.meta, '$.scope'), 1, length(?) + 1) = ? || '/')))`;

/** Calls alike in all the summary reads of them: how many, how many of their answers reached a provider, their final answers' usage summed. */
interface Group {
  kind: string;
  origin: string;
  judge: boolean;
  model: string | null;
  injected: boolean;
  refused: boolean;
  offline: boolean;
  used: boolean;
  calls: number;
  clean: number;
  first: number;
  usage: Usage;
}

function groupOf(r: Record<string, unknown>, model: string | null): Group {
  return {
    kind: String(r.kind),
    origin: String(r.origin),
    judge: Number(r.judge) === 1,
    model,
    injected: Number(r.injected) === 1,
    refused: Number(r.refused) === 1,
    offline: Number(r.offline) === 1,
    used: Number(r.used) === 1,
    calls: Number(r.calls),
    clean: Number(r.clean),
    first: Number(r.first),
    usage: { inputTokens: Number(r.ti) || 0, outputTokens: Number(r.tout) || 0, cacheReadInputTokens: Number(r.tcr) || 0, cacheCreationInputTokens: Number(r.tcw) || 0 },
  };
}

const add = (into: Usage, u: Usage) => {
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
  into.cacheReadInputTokens = (into.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0);
  into.cacheCreationInputTokens = (into.cacheCreationInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
};

/** Models with usage and no price, in the order of the first call that named each: of model calls alone (`api`), as the agent's summary counts them, or of any (the judge's). */
function unknownIn(groups: readonly Group[], prices: Record<string, Price> | undefined, o: { api: boolean }): string[] {
  const firsts = new Map<string, number>();
  for (const g of groups) {
    if (!g.used || !g.model || (o.api && g.kind !== 'api') || estimateCost(g.model, g.usage, prices) !== null) continue;
    firsts.set(g.model, Math.min(firsts.get(g.model) ?? Infinity, g.first));
  }
  return [...firsts].sort((a, b) => a[1] - b[1]).map(([m]) => m);
}

export interface RunWholeFacts {
  summary: RunSummary;
  /** Every call the run has, the judge's among them. */
  calls: number;
  /** One character per call, in call order (r replayed, l live, o overridden, i injected, f failed, b blocked, s stubbed). */
  origins: string;
  /** Each model the run's model calls name, by the short name their rows carry, as the run page names it. */
  models: Record<string, string>;
}

/**
 * The run's summary, origins and models, as `summarizeRun`, the strip and the run page work them out
 * from every call, read in SQL. `name` gives a model as the page names it (run-page.ts `modelName`).
 */
export function runWholeFacts(store: StoreOf<'readModels'>, run: RunRecord, o: { prices?: Record<string, Price>; modelOf: ModelResolver; name: (model: string) => string }): RunWholeFacts {
  let origins = '';
  const groups: Group[] = [];
  const extraReads: RunSummary['extraReads'] = [];
  for (const r of store.query(FACTS_SQL, run.runId)) {
    if (r.what === 'origins') origins = typeof r.origins === 'string' ? r.origins : '';
    else if (r.what === 'extra') extraReads.push({ callNo: Number(r.first), kind: r.kind as CallRecord['kind'], name: String(r.name) });
    else if (r.what === 'group') groups.push(groupOf(r, typeof r.model === 'string' || typeof r.model === 'number' ? String(r.model) : null));
    else {
      // A model call that names no model: read from its request, as the summary reads it (`modelOf`).
      const call = { kind: 'api', name: String(r.name), requestRef: typeof r.req === 'string' ? r.req : null, meta: {} } as unknown as CallRecord;
      groups.push(groupOf(r, o.modelOf(call) ?? null));
    }
  }
  const imported = importedRecording(run);
  const agent = groups.filter((g) => !g.judge);
  const judged = groups.filter((g) => g.judge);
  const byOrigin: Record<Origin, number> = { live: 0, replayed: 0, blocked: 0, stubbed: 0, overridden: 0 };
  const byKind: RunSummary['byKind'] = { api: 0, tool: 0, clock: 0, random: 0 };
  const tokens: Usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const cost = { spent: 0, saved: 0, captured: 0, unknownModels: unknownIn(agent, o.prices, { api: true }) };
  let total = 0;
  let upstreamRequests = 0;
  let injected = 0;
  let refused = 0;
  for (const g of agent) {
    total += g.calls;
    byOrigin[g.origin as Origin] = (byOrigin[g.origin as Origin] ?? 0) + g.calls;
    byKind[g.kind as keyof RunSummary['byKind']] = (byKind[g.kind as keyof RunSummary['byKind']] ?? 0) + g.calls;
    if (g.injected) injected += g.calls;
    else if (g.refused) refused += g.calls;
    if (g.kind !== 'api') continue;
    if (g.origin === 'live' && !imported) upstreamRequests += g.clean;
    if (!g.used) continue;
    if (g.origin === 'replayed') add(tokens, g.usage);
    const usd = estimateCost(g.model, g.usage, o.prices);
    if (usd === null) continue;
    if (g.origin === 'replayed') cost.saved += usd;
    else if (g.origin === 'live' && imported) cost.captured += usd;
    else if (g.origin === 'live') cost.spent += usd;
  }
  const summary: RunSummary = {
    runId: run.runId,
    mode: run.mode,
    status: run.status,
    total,
    byOrigin,
    byKind,
    upstreamRequests,
    injected,
    refused,
    imported,
    tokensNotRespent: tokens,
    cost,
    durationMs: run.endedAt !== null ? run.endedAt - run.startedAt : null,
    notReached: [],
    // Answered live while the replay went on, in call order, as the summary lists them.
    extraReads: extraReads.sort((a, b) => a.callNo - b.callNo),
    warnings: [],
    divergence: run.divergence,
    ...(judged.length ? { judge: judgeOf(judged, imported, o.prices) } : {}),
  };
  // As run-page.ts names them: the first call of each short name in call order gives its full one.
  const models: Record<string, string> = {};
  for (const g of groups.filter((x) => x.kind === 'api' && x.model).sort((a, b) => a.first - b.first)) {
    const short = shortModel(g.model);
    if (short && !(short in models)) models[short] = o.name(g.model!);
  }
  return { summary, calls: groups.reduce((n, g) => n + g.calls, 0), origins, models };
}

function judgeOf(groups: readonly Group[], imported: boolean, prices: Record<string, Price> | undefined): JudgeSummary {
  const out: JudgeSummary = { calls: 0, replayed: 0, live: 0, notAsked: 0, upstreamRequests: 0, spent: 0, saved: 0, unknownModels: unknownIn(groups, prices, { api: false }) };
  for (const g of groups) {
    out.calls += g.calls;
    if (g.origin === 'replayed') out.replayed += g.calls;
    else if (g.origin === 'live' && g.offline) out.notAsked += g.calls;
    else if (g.origin === 'live') out.live += g.calls;
    if (g.origin === 'live' && !imported) out.upstreamRequests += g.clean;
    if (!g.used) continue;
    const usd = estimateCost(g.model, g.usage, prices);
    if (usd === null) continue;
    if (g.origin === 'replayed') out.saved += usd;
    else if (g.origin === 'live' && !imported) out.spent += usd;
  }
  return out;
}

/**
 * Where blame's call stands among the agent's model calls that were answered in its scope (the run
 * page's "model call k of m"), read in SQL; null when the call is not one of them.
 */
export function blameStep(store: StoreOf<'readModels'>, runId: string, callNo: number, scope: string | null): { k: number; m: number } | null {
  const within = scope || null;
  const row = store.query(STEPS_SQL, callNo, callNo, runId, within, within, within, within)[0];
  return row && Number(row.hit) > 0 ? { k: Number(row.k), m: Number(row.m) } : null;
}
