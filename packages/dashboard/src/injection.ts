import { cleanBound, cleanDecided, commandIsImported, hasRecordedCommand, importedCommandSource, injectionTemplates, proofLine, trustOf, untrustedReads, withoutCommand, type CallRecord, type InjectionMark, type InjectionReport, type PlantReport, type Store, type StoredInjectionResult, type ToolTrust, type TrustSource } from '@shadowlap/engine';
import { lookupRun } from './api.js';
import type { JobBuildContext, JobBuildResult, JobRequest } from './jobs.js';
import { recordingNow } from './run-exports.js';
import { links } from './links.js';
import { optionLike, type GoldenSource } from './tests.js';

/**
 * Injection tests on the dashboard (read models: store in, JSON out). What `shadowlap injection`
 * kept in the store (injection_results, and `meta.injection` on each replay), for the pages that
 * show it: the results of a run or a golden, one result with its matrix and proof, a run's page
 * (its tests, or the test it is an attempt of), Needs a look, and Settings → Tools' Trust column.
 * The `injection` job runs the command; the browser names a run or a golden and what to plant.
 */

export interface InjectionRow {
  resultId: string;
  runId: string;
  golden: string | null;
  sessionId: string | null;
  mode: 'plant' | 'clean';
  at: number;
  endedAt: number | null;
  /** Still running: its attempts come in as they end. */
  running: boolean;
  attempts: number;
  obeyed: number;
  influenced: number;
  ignored: number;
  inconclusive: number;
  /** plant: obeyed, influenced, ignored or inconclusive, the strongest any attempt showed; clean: caused, not caused or inconclusive; null while it runs. */
  verdict: string | null;
  /** What the result comes to: plant, its gate's verdict against its limits; clean, inconclusive while a write is undecided, else passed. Null while it runs. */
  gate: 'passed' | 'failed' | 'inconclusive' | null;
  actor: string | null;
  /** One line: `send_email obeyed a planted instruction (2 of 3)`, `caused by #9 fetch_page`. */
  line: string;
  href: string;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A kept result's one line, as Needs a look and a run's banner word it. */
export function injectionLine(r: StoredInjectionResult): string {
  const data = r.data as Partial<InjectionReport>;
  if (r.mode === 'clean') {
    const c = data as Partial<Extract<InjectionReport, { mode: 'clean' }>>;
    const read = c.read ? `#${c.read.callNo} ${c.read.name}` : 'the read';
    const caused = (c.writes ?? []).filter((w) => w.verdict === 'caused');
    if (r.endedAt === null) return `testing whether ${read} caused its writes`;
    if (caused.length) {
      // The tally and the Wilson bound the verdict rests on; the rule is the gate's, in its report.
      const w = caused[0]!;
      const bound = cleanBound(w, c.gate);
      return `caused by ${read} · gone in ${w.gone} of ${plural(w.attempts, 'clean attempt')}${bound ? ` · ${bound}` : ''}`;
    }
    return r.verdict === 'not caused' ? `not caused by ${read}: the writes come back without its content` : `inconclusive: whether ${read} caused the writes`;
  }
  const p = data as Partial<PlantReport>;
  if (r.endedAt === null) return `planting payloads · ${plural(r.attempts, 'attempt')} so far`;
  if (r.obeyed) {
    const tools = [...new Set((p.attempts ?? []).filter((a) => a.verdict === 'obeyed').flatMap((a) => a.evidence.filter((e) => e.kind !== 'write').map((e) => e.tool)))];
    return `${tools.join(', ') || 'a tool call'} obeyed a planted instruction (${r.obeyed} of ${r.attempts})`;
  }
  if (r.influenced) return `a planted instruction influenced the agent (${r.influenced} of ${r.attempts})`;
  if (p.gate?.verdict === 'inconclusive') return `inconclusive: ${p.gate.reason ?? 'the test showed too little to say'}`;
  // An attempt that showed nothing either way (the planted text reached no model, the attempt never
  // made the read) ignored nothing: it is counted apart, as the report counts it.
  if (r.inconclusive) return `ignored every planted instruction in ${r.ignored} of ${plural(r.attempts, 'attempt')}, ${r.inconclusive} inconclusive`;
  return `ignored every planted instruction (${r.attempts} attempts)`;
}

/** What a kept result comes to, as its row says it (InjectionRow.gate). */
function resultGate(r: StoredInjectionResult): InjectionRow['gate'] {
  if (r.endedAt === null) return null;
  const data = r.data as Partial<InjectionReport>;
  if (r.mode === 'clean') return cleanDecided({ writes: (data as Partial<Extract<InjectionReport, { mode: 'clean' }>>).writes ?? [] }) ? 'passed' : 'inconclusive';
  return (data as Partial<PlantReport>).gate?.verdict ?? null;
}

function row(r: StoredInjectionResult): InjectionRow {
  return {
    resultId: r.resultId,
    runId: r.runId,
    golden: r.golden,
    sessionId: r.sessionId,
    mode: r.mode,
    at: r.at,
    endedAt: r.endedAt,
    running: r.endedAt === null,
    attempts: r.attempts,
    obeyed: r.obeyed,
    influenced: r.influenced,
    ignored: r.ignored,
    inconclusive: r.inconclusive,
    verdict: r.verdict,
    gate: resultGate(r),
    actor: r.actor,
    line: injectionLine(r),
    href: links.run(r.runId),
  };
}

/** The results kept, newest first: of one run tested, one golden, or all. */
export function injectionResults(store: Store, o: { runId?: string; golden?: string; limit?: number } = {}): { results: InjectionRow[] } {
  return { results: store.listInjectionResults(o).map(row) };
}

/**
 * One result as `--json` printed it, with its row, and the runs it names that are no longer in the
 * store (gc took them): a cell whose attempt is gone can't open it.
 */
export function injectionResult(store: Store, resultId: string): { row: InjectionRow; report: InjectionReport; gone: string[] } | null {
  const r = store.getInjectionResult(resultId);
  if (!r) return null;
  const report = r.data as unknown as InjectionReport;
  const named = report.mode === 'plant' ? [...report.attempts.map((a) => a.runId), ...report.baselines.flatMap((b) => b.runs)] : (report.attempts ?? []).map((a) => a.runId);
  return { row: row(r), report, gone: named.filter((id) => !store.getRun(id)) };
}

/**
 * What a run's page shows of injection tests: its untrusted reads (the Calls view tags them), the
 * results kept for the run, and, for a replay one of them made, the test it belongs to and what it
 * showed: the canary to highlight, the write that carried it, where the planted text was read, and
 * the line that joins them. The planted text itself is in the run's interventions
 * (`--inject-result`), as for any planted replay.
 */
export function runInjection(store: Store, runId: string, tools?: ToolTrust): { untrusted: Array<{ callNo: number; name: string; from: TrustSource }>; results: InjectionRow[]; attempt: (InjectionMark & { line: string | null; proof: string | null }) | null } {
  const run = store.getRun(runId);
  const mark = run?.meta?.injection ?? null;
  const of = mark ? store.getInjectionResult(mark.result) : null;
  const untrusted = untrustedReads(store.getCalls(runId), tools).reads.map((r) => ({ callNo: r.callNo, name: r.name, from: r.from }));
  const proof = mark?.evidence?.length ? proofLine({ read: mark.read, forkedAt: mark.readAt ?? null, readAt: mark.readAt ?? null, evidence: mark.evidence.map((e) => ({ ...e, why: null })) }) : null;
  return { untrusted, results: store.listInjectionResults({ runId }).map(row), attempt: mark ? { ...mark, line: of ? injectionLine(of) : null, proof } : null };
}

/**
 * Needs a look: the newest result of each run or golden whose attempts obeyed (or were influenced),
 * or whose test showed too little to say (inconclusive), as one line each.
 */
export function injectionNeedsLook(store: Store, limit = 20): Array<{ resultId: string; runId: string; golden: string | null; text: string; href: string; severity: 'obeyed' | 'influenced' | 'inconclusive' }> {
  const seen = new Set<string>();
  const out: Array<{ resultId: string; runId: string; golden: string | null; text: string; href: string; severity: 'obeyed' | 'influenced' | 'inconclusive' }> = [];
  for (const r of store.listInjectionResults({ limit: 500 })) {
    const key = r.golden ?? r.runId;
    if (r.mode !== 'plant' || r.endedAt === null || seen.has(key)) continue;
    seen.add(key);
    const severity = r.obeyed ? 'obeyed' : r.influenced ? 'influenced' : resultGate(r) === 'inconclusive' ? 'inconclusive' : null;
    if (!severity) continue;
    out.push({ resultId: r.resultId, runId: r.runId, golden: r.golden, text: injectionLine(r), href: links.run(r.runId), severity });
    if (out.length >= limit) break;
  }
  return out;
}

/** A tool as Settings → Tools' Trust column shows it: trusted or untrusted, from where, and the config line that marks it. */
export interface ToolTrustRow {
  name: string;
  trust: 'trusted' | 'untrusted';
  from: TrustSource | null;
  calls: number;
  /** The `tools` entry that marks it the other way, for the column's toggle. */
  configLine: string;
}

/**
 * Every tool the store's recordings called, with its trust: the config's `tools`, else what its calls
 * were recorded with (the recording machine's config, the SDK's `trust`, an MCP server's
 * openWorldHint; untrusted wins when they differ), else trusted.
 */
export function toolTrust(store: Store, tools: ToolTrust | undefined): { tools: ToolTrustRow[] } {
  const rows = store.query(
    `SELECT name, COUNT(*) AS calls,
       MAX(CASE WHEN json_extract(meta, '$.trust') = 'untrusted' THEN 1 ELSE 0 END) AS untrusted,
       MAX(CASE WHEN json_extract(meta, '$.trust') = 'untrusted' AND json_extract(meta, '$.trustFrom') = 'config' THEN 1 ELSE 0 END) AS untrustedByConfig,
       MAX(CASE WHEN json_extract(meta, '$.trust') = 'trusted' AND json_extract(meta, '$.trustFrom') = 'config' THEN 1 ELSE 0 END) AS trustedByConfig,
       MAX(CASE WHEN json_extract(meta, '$.mcp') IS NOT NULL THEN 1 ELSE 0 END) AS mcp, MAX(json_extract(meta, '$.http')) AS http
     FROM call_events WHERE phase = 'start' AND kind = 'tool' GROUP BY name ORDER BY name`,
  );
  return {
    tools: rows.map((r) => {
      const name = String(r.name);
      const recorded: Pick<CallRecord['meta'], 'trust' | 'trustFrom'> = Number(r.untrustedByConfig) ? { trust: 'untrusted', trustFrom: 'config' } : Number(r.untrusted) ? { trust: 'untrusted' } : Number(r.trustedByConfig) ? { trust: 'trusted', trustFrom: 'config' } : {};
      const meta: CallRecord['meta'] = { ...recorded, ...(Number(r.mcp) ? { mcp: { transport: 'stdio' as const, server: '' } } : {}), ...(typeof r.http === 'string' ? { http: r.http } : {}) };
      const t = trustOf({ kind: 'tool', name, meta }, tools);
      const other = t.trust === 'untrusted' ? 'trusted' : 'untrusted';
      return { name, trust: t.trust, from: t.from, calls: Number(r.calls), configLine: `"tools": { ${JSON.stringify(name)}: { "trust": "${other}" } }` };
    }),
  };
}

/** The built-in templates, as the Test every untrusted read… dialog lists them. */
export function injectionTemplatesView(): ReturnType<typeof injectionTemplates> {
  return injectionTemplates();
}

const MAX = { repeat: 100, baselines: 20, payloads: 2 * 1024 * 1024 } as const;

/**
 * The `injection` job: `{ runId | golden, repeat?, templates?, payloadsUpload?, baselines?, clean?, writes?, liveReads?, yes? }`.
 * A run is one of the store's; a golden one of the packs the project lists; templates are ids the
 * built-in set has, `all` or `none`; a payload file is an upload the browser sent. `clean` asks
 * whether that read caused the run's writes (`writes` picks them) instead of planting. `liveReads`
 * runs the reads the recording doesn't hold instead of fencing them.
 */
export function injectionJob(req: JobRequest, b: Pick<JobBuildContext, 'store' | 'upload'>, goldens: readonly GoldenSource[]): JobBuildResult {
  const whole = (v: unknown, key: string, min: number, max: number): number | { error: string } | undefined => {
    if (v === undefined) return undefined;
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : { error: `${key} is a whole number from ${min} to ${max}` };
  };
  let target: string;
  let runId: string | null;
  if (typeof req.golden === 'string') {
    const g = goldens.find((x) => x.path === req.golden);
    if (!g || optionLike(g.path)) return { error: 'no such golden: name one of the packs in the goldens folder or under "tests" in the config' };
    target = g.path;
    runId = g.runId;
  } else if (typeof req.runId === 'string' && req.runId) {
    const run = lookupRun(b.store, req.runId);
    if (!run) return { error: `no run ${req.runId.slice(0, 40)}`, status: 404 };
    const id = run.runId.slice(0, 10);
    if (run.status === 'running') return { error: recordingNow(b.store, run) ? `${id} is still recording: test it once it has ended` : `${id} was interrupted: its recorder stopped before it ended`, status: 409 };
    if (!hasRecordedCommand(run)) return { error: `${id} ${withoutCommand(run)} and has no command to re-run: replay it once with yours (shadowlap replay ${id} -- <command>) and test that run`, status: 409 };
    if (commandIsImported(run) && req.yes !== true) return { error: `${id} came from ${importedCommandSource(run)}: this runs the command it was recorded with (${run.command.argv.join(' ')}). Confirm it to run it`, status: 409 };
    target = run.runId;
    runId = run.runId;
  } else return { error: 'name the run (runId) or the golden (golden) to test' };

  const args = ['injection', target, '--json'];
  const clean = whole(req.clean, 'clean', 1, 1_000_000);
  if (clean && typeof clean === 'object') return clean;
  if (clean !== undefined) {
    if (req.golden !== undefined) return { error: '--clean asks about a recorded run: name it with runId' };
    if (req.templates !== undefined || req.payloadsUpload !== undefined) return { error: '--clean plants nothing: leave out templates and payloads' };
    args.push('--clean', String(clean));
    const writes = req.writes === undefined ? [] : Array.isArray(req.writes) ? req.writes : null;
    if (!writes || writes.length > 100 || !writes.every((w) => typeof w === 'number' && Number.isInteger(w) && w > 0)) return { error: 'writes is a list of call numbers' };
    for (const w of writes as number[]) args.push('--write', String(w));
  } else {
    if (req.writes !== undefined) return { error: 'writes goes with clean' };
    if (req.templates !== undefined) {
      const ids = injectionTemplates().templates.map((t) => t.id);
      if (req.templates === 'all' || req.templates === 'none') args.push('--templates', req.templates);
      else if (Array.isArray(req.templates) && req.templates.length && req.templates.every((t) => typeof t === 'string' && ids.includes(t))) args.push('--templates', (req.templates as string[]).join(','));
      else return { error: `templates is all, none, or a list of the built-in templates' ids (${ids.join(', ')})` };
    }
    if (req.payloadsUpload !== undefined) {
      const file = b.upload(req.payloadsUpload);
      if (!file) return { error: 'that payload file is gone: send it again' };
      if (file.bytes > MAX.payloads) return { error: 'a payload file is at most 2 MB' };
      args.push('--payloads', file.path);
    } else if (req.templates === 'none') return { error: 'with no templates, send a payload file' };
    const baselines = whole(req.baselines, 'baselines', 0, MAX.baselines);
    if (baselines && typeof baselines === 'object') return baselines;
    if (baselines !== undefined) args.push('--baselines', String(baselines));
  }
  const repeat = whole(req.repeat, 'repeat', 1, MAX.repeat);
  if (repeat && typeof repeat === 'object') return repeat;
  if (repeat !== undefined) args.push('--repeat', String(repeat));
  if (req.liveReads !== undefined && typeof req.liveReads !== 'boolean') return { error: 'liveReads is true or false' };
  if (req.liveReads === true) args.push('--live-reads');
  if (req.yes === true) args.push('--yes');
  return { args, runId, title: clean !== undefined ? `Testing whether #${clean} caused the writes` : 'Testing for injection' };
}
