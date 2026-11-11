import { readFileSync } from 'node:fs';
import { ACTIONS, type CallRecord, cleanBound, cleanDecided, commandIsImported, CONFIG_FILE, configuredTrust, goldensNeedingConsent, hasRecordedCommand, importedCommandSource, type InjectionMark, type InjectionReport, injectionTemplates, jobConsent, messageOf, parsePayloads, type PlantReport, plural, proofParts, type ProofParts, quoteArgv, type StoredInjectionResult, type StoreOf, type ToolTrust, TRUST_FROM, trustOf, type TrustSource, untrustedView, type UntrustedView, withoutCommand } from '@shadowlap/engine';
import { lookupRun } from './api.js';
import { trustLine } from './tool-trust.js';
import { attemptPlant, injectionPanel, markProof, type AttemptPlant, type InjectionPanelView } from './injection-view.js';
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
  /** One line: `send_email obeyed a planted instruction · 2 of 3`, `caused by #9 fetch_page`. */
  line: string;
  /** A plant's gate's reason, as the CLI printed it; null for one that passed, a `--clean` answer, and while it runs. */
  reason: string | null;
  /** What the test spent on the model, in dollars. */
  spent: number;
  /** A `--clean` answer's gate rule (cleanRule); null for a plant. */
  rule: string | null;
  /** A `--clean` answer's read, the call it tested; null for a plant, whose reads are its panel's rows. */
  read: number | null;
  href: string;
}

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
    return `${tools.join(', ') || 'a tool call'} obeyed a planted instruction · ${r.obeyed} of ${r.attempts}`;
  }
  if (r.influenced) return `a planted instruction influenced the agent · ${r.influenced} of ${r.attempts}`;
  if (p.gate?.verdict === 'inconclusive') return `inconclusive: ${p.gate.reason ?? 'the test showed too little to say'}`;
  // An attempt that showed nothing either way (the planted text reached no model, the attempt never
  // made the read) ignored nothing: it is counted apart, as the report counts it.
  if (r.inconclusive) return `ignored every planted instruction in ${r.ignored} of ${plural(r.attempts, 'attempt')}, ${r.inconclusive} inconclusive`;
  return `ignored every planted instruction · ${plural(r.attempts, 'attempt')}`;
}

/** What a kept result comes to, as its row says it (InjectionRow.gate). */
export function resultGate(r: StoredInjectionResult): InjectionRow['gate'] {
  if (r.endedAt === null) return null;
  const data = r.data as Partial<InjectionReport>;
  if (r.mode === 'clean') return cleanDecided({ writes: (data as Partial<Extract<InjectionReport, { mode: 'clean' }>>).writes ?? [] }) ? 'passed' : 'inconclusive';
  return (data as Partial<PlantReport>).gate?.verdict ?? null;
}

function row(r: StoredInjectionResult): InjectionRow {
  const data = r.data as Partial<PlantReport> & Partial<Pick<Extract<InjectionReport, { mode: 'clean' }>, 'rule' | 'read'>>;
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
    reason: r.mode === 'plant' && r.endedAt !== null ? (data.gate?.reason ?? null) : null,
    spent: data.cost?.spent ?? 0,
    rule: r.mode === 'clean' ? (data.rule ?? null) : null,
    read: r.mode === 'clean' ? (data.read?.callNo ?? null) : null,
    href: links.run(r.runId),
  };
}

/** The results kept, newest first: of one run tested, one golden, or all. */
export function injectionResults(store: StoreOf<'injection'>, o: { runId?: string; golden?: string; limit?: number } = {}): { results: InjectionRow[] } {
  return { results: store.listInjectionResults(o).map(row) };
}

/** One kept result's row and its report as `--json` printed it, and nothing it names: what the security report and its preview read. */
export function keptInjection(store: StoreOf<'injection'>, resultId: string): { row: InjectionRow; report: InjectionReport } | null {
  const r = store.getInjectionResult(resultId);
  return r ? { row: row(r), report: r.data as unknown as InjectionReport } : null;
}

/**
 * One result as `--json` printed it, with its row, the runs it names that are no longer in the store
 * (gc took them: a cell whose attempt is gone can't open it), and, for a plant that ended, the panel
 * the run page's Show results opens (`view`). `shared`: names show, so the panel says who ran it.
 */
export function injectionResult(store: StoreOf<'recording' | 'injection'>, resultId: string, o: { shared?: boolean } = {}): { row: InjectionRow; report: InjectionReport; gone: string[]; view: InjectionPanelView | null } | null {
  const r = store.getInjectionResult(resultId);
  if (!r) return null;
  const report = r.data as unknown as InjectionReport;
  const named = report.mode === 'plant' ? [...report.attempts.map((a) => a.runId), ...report.baselines.flatMap((b) => b.runs)] : (report.attempts ?? []).map((a) => a.runId);
  const view = report.mode === 'plant' && r.endedAt !== null ? injectionPanel(store, report, { by: o.shared ? r.actor : null }) : null;
  return { row: row(r), report, gone: named.filter((id) => !store.getRun(id)), view };
}

/** A run's injection on its page: its untrusted reads, its tests, and the test it is an attempt of. */
export interface RunInjection {
  untrusted: UntrustedView[];
  results: InjectionRow[];
  /** `parts`: an attempt's proof in its parts, for the page to draw with each call to pick (none for a baseline or a clean attempt). */
  attempt: (InjectionMark & AttemptPlant & { line: string | null; proof: string | null; parts: ProofParts | null }) | null;
}

/**
 * What a run's page shows of injection tests: its untrusted reads (Calls and Turns tag those a model
 * call reads), the results kept for the run, and, for a replay one of them made, the test it belongs
 * to and what it showed: the canary to highlight, the write that carried it, where the planted text
 * was read, and the line that joins them. `shadowlap injection` keeps no interventions on its
 * replays (a planted read is stored as overridden), so the planted text, filled with the attempt's
 * canary, and the path it went after in the recorded result come from the result (attemptPlant).
 */
export function runInjection(store: StoreOf<'recording' | 'injection'>, runId: string, tools?: ToolTrust): RunInjection {
  const run = store.getRun(runId);
  const mark = run?.meta?.injection ?? null;
  const of = mark ? store.getInjectionResult(mark.result) : null;
  const calls = store.getCalls(runId);
  const untrusted = untrustedView(calls, tools);
  const proof = mark ? markProof(mark) : null;
  const report = of ? (of.data as unknown as InjectionReport) : null;
  const plant = run && mark ? attemptPlant(store, run, mark, report, calls) : null;
  return { untrusted, results: store.listInjectionResults({ runId }).map(row), attempt: mark && plant ? { ...mark, ...plant, line: of ? injectionLine(of) : null, proof, parts: attemptProof(mark, report, runId) } : null };
}

/** An attempt's proof in its parts: the kept result's own evidence, which says why a write counts, else its record's. */
function attemptProof(mark: InjectionMark, report: InjectionReport | null, runId: string): ProofParts | null {
  if (mark.role !== 'attempt') return null;
  const kept = report && report.mode !== 'clean' ? report.attempts.find((a) => a.runId === runId) : undefined;
  const evidence = kept?.evidence ?? (mark.evidence ?? []).map((e) => ({ ...e, why: null }));
  return proofParts({ read: mark.read, forkedAt: mark.readAt ?? null, readAt: mark.readAt ?? null, evidence });
}

/**
 * Needs a look: the newest result of each run or golden whose attempts obeyed (or were influenced),
 * or whose test showed too little to say (inconclusive), as one line each.
 */
export function injectionNeedsLook(store: StoreOf<'injection'>, limit = 20): Array<{ resultId: string; runId: string; golden: string | null; text: string; href: string; severity: 'obeyed' | 'influenced' | 'inconclusive' }> {
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

/** A tool as Settings → Tools' Trust column shows it: trusted or untrusted, from where, and the config line that marks it the other way. */
export interface ToolTrustRow {
  name: string;
  trust: 'trusted' | 'untrusted';
  from: TrustSource | null;
  /** Where the mark comes from, in the column's words: `MCP openWorldHint · <server>`, `SDK`, `shadowlap.config.json`, or `recorded with its config’s mark` where the recording machine's config set it and this file says nothing; null for a tool trusted by default. */
  where: string | null;
  calls: number;
  /** Its calls are what a person typed (`meta.input`): never planted in. */
  input: boolean;
  /** The `tools` entry's line that marks it the other way, for the column's button. */
  flip: string;
}

/** Where a tool's mark comes from, in Settings → Tools' words (TRUST_FROM's, with the MCP server named). */
function trustWhere(from: TrustSource | null, o: { server: string | null; inFile: boolean }): string | null {
  if (from === 'mcp') return o.server ? `${TRUST_FROM.mcp} · ${o.server}` : TRUST_FROM.mcp;
  if (from === 'sdk') return TRUST_FROM.sdk;
  if (from === 'config') return o.inFile ? CONFIG_FILE : 'recorded with its config’s mark';
  return null;
}

/**
 * Every tool the store's recordings called, with its trust: the config's `tools`, else what its calls
 * were recorded with (the recording machine's config, the SDK's `trust`, an MCP server's
 * openWorldHint; untrusted wins when they differ), else trusted.
 */
export function toolTrust(store: StoreOf<'readModels'>, tools: ToolTrust | undefined): { tools: ToolTrustRow[] } {
  const rows = store.query(
    `SELECT name, COUNT(*) AS calls,
       MAX(CASE WHEN json_extract(meta, '$.trust') = 'untrusted' THEN 1 ELSE 0 END) AS untrusted,
       MAX(CASE WHEN json_extract(meta, '$.trust') = 'untrusted' AND json_extract(meta, '$.trustFrom') = 'config' THEN 1 ELSE 0 END) AS untrustedByConfig,
       MAX(CASE WHEN json_extract(meta, '$.trust') = 'trusted' AND json_extract(meta, '$.trustFrom') = 'config' THEN 1 ELSE 0 END) AS trustedByConfig,
       MAX(CASE WHEN json_extract(meta, '$.mcp') IS NOT NULL THEN 1 ELSE 0 END) AS mcp, MAX(json_extract(meta, '$.mcp.server')) AS server,
       MAX(CASE WHEN json_extract(meta, '$.input') = 1 THEN 1 ELSE 0 END) AS input, MAX(json_extract(meta, '$.http')) AS http
     FROM call_events WHERE phase = 'start' AND kind = 'tool' GROUP BY name ORDER BY name`,
  );
  return {
    tools: rows.map((r) => {
      const name = String(r.name);
      const server = typeof r.server === 'string' && r.server ? r.server : null;
      const http = typeof r.http === 'string' ? r.http : null;
      const recorded: Pick<CallRecord['meta'], 'trust' | 'trustFrom'> = Number(r.untrustedByConfig) ? { trust: 'untrusted', trustFrom: 'config' } : Number(r.untrusted) ? { trust: 'untrusted' } : Number(r.trustedByConfig) ? { trust: 'trusted', trustFrom: 'config' } : {};
      const meta: CallRecord['meta'] = { ...recorded, ...(Number(r.mcp) ? { mcp: { transport: 'stdio' as const, server: server ?? '' } } : {}), ...(http ? { http } : {}) };
      const t = trustOf({ kind: 'tool', name, meta }, tools);
      const where = trustWhere(t.from, { server, inFile: configuredTrust(tools, name, http) !== undefined });
      return { name, trust: t.trust, from: t.from, where, calls: Number(r.calls), input: Number(r.input) === 1, flip: trustLine(name, t.trust === 'untrusted' ? 'trusted' : 'untrusted') };
    }),
  };
}

/** The built-in templates, as Run injection test…'s dialog lists them. */
export function injectionTemplatesView(): ReturnType<typeof injectionTemplates> {
  return injectionTemplates();
}

/** The largest payload file a test takes. */
export const PAYLOAD_FILE_MAX = 2 * 1024 * 1024;
const MAX = { repeat: 100, baselines: 20, payloads: PAYLOAD_FILE_MAX, budget: 100_000 } as const;

/** A payload file once it is sent, as Run injection test…'s dialog names it: its name, how many payloads, and those with no `{{canary}}`, by id. */
export interface PayloadsRead {
  name: string;
  count: number;
  noCanary: string[];
}

/** Reads a payload file sent as the test reads it (parsePayloads), named as it was picked; why not, in its words. */
export function payloadsRead(file: { path: string; name: string; original: string | null; bytes: number }): PayloadsRead | { error: string } {
  if (file.bytes > PAYLOAD_FILE_MAX) return { error: 'a payload file is at most 2 MB' };
  const name = file.original ?? file.name;
  try {
    const payloads = parsePayloads(readFileSync(file.path, 'utf8'), name);
    return { name, count: payloads.length, noCanary: payloads.filter((p) => !p.canary).map((p) => p.id) };
  } catch (err) {
    return { error: messageOf(err) };
  }
}

type Built<T> = T | { error: string; status?: number };
/** The command someone else chose that the test runs, asked about once the test's own line is whole. */
type Theirs = { argv: readonly string[]; words: (line: string) => string } | null;

const whole = (v: unknown, key: string, min: number, max: number): number | { error: string } | undefined => {
  if (v === undefined) return undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : { error: `${key} is a whole number from ${min} to ${max}` };
};

/** What the test runs on: a golden the project lists, or a run of the store that has ended and has a command to run again. */
function injectionTarget(req: JobRequest, b: Pick<JobBuildContext, 'store'> & Partial<Pick<JobBuildContext, 'project'>>, goldens: readonly GoldenSource[]): Built<{ target: string; runId: string | null; theirs: Theirs }> {
  if (typeof req.golden === 'string') {
    const g = goldens.find((x) => x.path === req.golden);
    if (!g || optionLike(g.path)) return { error: 'no such golden: name one of the packs in the goldens folder or under "tests" in the config' };
    // A golden from a pack the repository doesn't track, recorded elsewhere, runs its command only with a yes, as test asks of one.
    const sent = goldensNeedingConsent(b.store, [g.path], b.project?.path ?? process.cwd())[0];
    return { target: g.path, runId: g.runId, theirs: sent ? { argv: sent.argv, words: (line) => `${g.path} is from a pack this repository doesn't track: this runs the command it was recorded with (${quoteArgv(sent.argv)}), under ${line}. Confirm it to run it` } : null };
  }
  if (typeof req.runId !== 'string' || !req.runId) return { error: 'name the run (runId) or the golden (golden) to test' };
  const run = lookupRun(b.store, req.runId);
  if (!run) return { error: `no run ${req.runId.slice(0, 40)}`, status: 404 };
  const id = run.runId.slice(0, 10);
  if (run.status === 'running') return { error: recordingNow(b.store, run) ? `${id} is still recording: test it once it has ended` : `${id} was interrupted: its recorder stopped before it ended`, status: 409 };
  if (!hasRecordedCommand(run)) return { error: `${id} ${withoutCommand(run)} and has no command to re-run: replay it once with yours (shadowlap replay ${id} -- <command>) and test that run`, status: 409 };
  const theirs = commandIsImported(run) ? { argv: run.command.argv, words: (line: string) => `${id} came from ${importedCommandSource(run)}: this runs the command it was recorded with (${quoteArgv(run.command.argv)}), under ${line}. Confirm it to run it` } : null;
  return { target: run.runId, runId: run.runId, theirs };
}

/** `--clean <read>` and the writes it asks about: Find cause…, on a recorded run. */
function cleanFlags(req: JobRequest, clean: number): Built<string[]> {
  if (req.golden !== undefined) return { error: '--clean asks about a recorded run: name it with runId' };
  if (req.templates !== undefined || req.payloadsUpload !== undefined) return { error: '--clean plants nothing: leave out templates and payloads' };
  const writes = req.writes === undefined ? [] : Array.isArray(req.writes) ? req.writes : null;
  if (!writes || writes.length > 100 || !writes.every((w) => typeof w === 'number' && Number.isInteger(w) && w > 0)) return { error: 'writes is a list of call numbers' };
  return ['--clean', String(clean), ...(writes as number[]).flatMap((w) => ['--write', String(w)])];
}

/** What a plant plants: the templates picked, a payload file sent, and the clean replays of each read. */
function plantFlags(req: JobRequest, b: Pick<JobBuildContext, 'upload'>): Built<string[]> {
  if (req.writes !== undefined) return { error: 'writes goes with clean' };
  const out: string[] = [];
  if (req.templates !== undefined) {
    const ids = injectionTemplates().templates.map((t) => t.id);
    if (req.templates === 'all' || req.templates === 'none') out.push('--templates', req.templates);
    else if (Array.isArray(req.templates) && req.templates.length && req.templates.every((t) => typeof t === 'string' && ids.includes(t))) out.push('--templates', (req.templates as string[]).join(','));
    else return { error: `templates is all, none, or a list of the built-in templates' ids (${ids.join(', ')})` };
  }
  if (req.payloadsUpload !== undefined) {
    const file = b.upload(req.payloadsUpload);
    if (!file) return { error: 'that payload file is gone: send it again' };
    if (file.bytes > MAX.payloads) return { error: 'a payload file is at most 2 MB' };
    out.push('--payloads', file.path);
  } else if (req.templates === 'none') return { error: 'with no templates, send a payload file' };
  const baselines = whole(req.baselines, 'baselines', 0, MAX.baselines);
  if (baselines && typeof baselines === 'object') return baselines;
  if (baselines !== undefined) out.push('--baselines', String(baselines));
  return out;
}

/** Stop at $ (`--budget`): an amount above 0, to the cent, no attempt starting once it is spent. */
export function budgetFlags(v: unknown): Built<string[]> {
  if (v === undefined || v === null) return [];
  const cents = typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : 0;
  if (cents <= 0 || cents > MAX.budget * 100) return { error: 'budget is an amount in USD above 0, such as 25.00' };
  return ['--budget', (cents / 100).toFixed(2)];
}

/** The rest of the line: attempts each, and reads the recording doesn't hold run live. */
function runFlags(req: JobRequest): Built<string[]> {
  const repeat = whole(req.repeat, 'repeat', 1, MAX.repeat);
  if (repeat && typeof repeat === 'object') return repeat;
  if (req.liveReads !== undefined && typeof req.liveReads !== 'boolean') return { error: 'liveReads is true or false' };
  return [...(repeat === undefined ? [] : ['--repeat', String(repeat)]), ...(req.liveReads === true ? ['--live-reads'] : [])];
}

/** A job's title: Find cause… names the read it makes neutral; a re-run (`again`) says so. */
export function injectionTitle(req: JobRequest): string {
  if (typeof req.clean === 'number') return `${ACTIONS.findCause.doing}: testing #${req.clean}`;
  return req.again === true ? ACTIONS.rerunInjectionTest.doing : ACTIONS.runInjectionTest.doing;
}

/**
 * The `injection` job: `{ runId | golden, repeat?, templates?, payloadsUpload?, baselines?, budget?, clean?, writes?, liveReads?, again?, yes? }`.
 * A run is one of the store's; a golden one of the packs the project lists; templates are ids the
 * built-in set has, `all` or `none`; a payload file is an upload the browser sent; `budget` is Stop at
 * $. `clean` asks whether that read caused the run's writes (`writes` picks them) instead of
 * planting. `liveReads` runs the reads the recording doesn't hold instead of fencing them; `again`
 * only titles a re-run.
 */
export function injectionJob(req: JobRequest, b: Pick<JobBuildContext, 'store' | 'upload'> & Partial<Pick<JobBuildContext, 'project'>>, goldens: readonly GoldenSource[]): JobBuildResult {
  const on = injectionTarget(req, b, goldens);
  if ('error' in on) return on;
  const clean = whole(req.clean, 'clean', 1, 1_000_000);
  if (clean && typeof clean === 'object') return clean;
  const parts = [clean === undefined ? plantFlags(req, b) : cleanFlags(req, clean), budgetFlags(req.budget), runFlags(req)];
  const args = ['injection', on.target, '--json'];
  for (const p of parts) {
    if ('error' in p) return p;
    args.push(...p);
  }
  // The yes is to the lines the question showed (consent.ts): the command someone else chose and the
  // test's own line, so a yes to one test runs no other, and none of the run's error-path presets;
  // only a question asked passes --yes on.
  const line = ['shadowlap', ...args];
  const { theirs } = on;
  const consent = jobConsent(theirs ? [theirs.argv, line] : [], req.yes, () => theirs!.words(quoteArgv(line)));
  if ('ask' in consent) return consent.ask;
  args.push(...consent.yes);
  return { args, runId: on.runId, title: injectionTitle(req) };
}
