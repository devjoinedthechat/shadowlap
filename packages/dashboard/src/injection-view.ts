import { baselineWrites, fillPayload, injectionTemplates, plantInToolResult, plural, proofCall, proofLine, refused, shortRunId as short, strongestVerdict, type AttemptReport, type CallRecord, type CleanReport, type InjectionMark, type InjectionReport, type InjectionVerdict, type PlantReport, type RunRecord, type StoreOf, type TrustSource } from '@shadowlap/engine';
import { commandLine } from './fix-shared.js';
import type { InjectionAgain } from './next-step.js';

/**
 * What the run page draws of a kept injection test, worked out here so the browser copies none of the
 * engine's rules: one result's panel (its untrusted reads by payload, each cell's strongest verdict
 * with the attempt that shows it and its proof, past eight reads each tool's reads summed, the meta,
 * the command and the receipt), what an attempt's page marks (where the payload was planted, the
 * path it went after, the planted text with its canary filled, a clean attempt's writes gone), and
 * what the Forks view files each replay under (lineageInjection).
 */

/** Past this many reads, the matrix gives each tool a row that sums its reads (ui/matrix.ts groupRows). */
export const MANY_READS = 8;

/**
 * A read as the matrix groups it (ui/matrix.ts groupRows): its worst attempt, obeyed (0), influenced
 * (1) or inconclusive (2); else, its attempts having ignored their payloads, whether a payload never
 * ran there (3) or every payload did (4); or no attempt ran there at all (5), as a test stopped at its
 * budget leaves the reads it didn't reach. Unlike a cell's strongest verdict, inconclusive ranks above ignored.
 */
export type ReadWorst = 0 | 1 | 2 | 3 | 4 | 5;

const WORST: Readonly<Record<InjectionVerdict, 0 | 1 | 2 | 4>> = { obeyed: 0, influenced: 1, inconclusive: 2, ignored: 4 };

/** A read's worst (ReadWorst): a read never tried is no read that ignored every payload. */
function readWorst(report: PlantReport, callNo: number): ReadWorst {
  const ran = report.cells.filter((c) => c.read === callNo && c.attempts);
  if (!ran.length) return 5;
  const worst = Math.min(...ran.map((c) => WORST[c.verdict])) as ReadWorst;
  return worst === 4 && report.payloads.some((p) => !ran.some((c) => c.payload === p.id)) ? 3 : worst;
}

/** One cell of the matrix: what its attempts came to, the attempt that shows it and what that rests on. */
export interface InjectionCellView {
  /** The read's call; a tool's summed cell names its first read with this verdict. */
  read: number;
  payload: string;
  verdict: InjectionVerdict;
  /** Of `of` attempts, those that came out as `verdict`. */
  n: number;
  of: number;
  /** The first attempt with the cell's verdict, at the call that shows it; null where gc took its run. */
  attempt: { runId: string; callNo: number | null } | null;
  /** Its proof (proofLine), else why it couldn't say, else that no call after the read carried the canary. */
  line: string;
}

export interface InjectionPanelView {
  /** Each untrusted read planted in, in call order, with its worst attempt, or that none ran there (ReadWorst). */
  rows: Array<{ callNo: number; name: string; from: TrustSource; readAt: number | null; worst: ReadWorst }>;
  cols: Array<{ id: string; title: string; text: string }>;
  cells: InjectionCellView[];
  /** Past eight reads, each tool's reads by payload, summed: null at eight or fewer. */
  tools: Array<{ name: string; reads: number[]; cells: InjectionCellView[] }> | null;
  totals: { attempts: number; obeyed: number; influenced: number; inconclusive: number; ignored: number };
  /** The attempts it planned, each payload at each read planted in, `repeat` times: more than ran where it stopped short. */
  planned: number;
  /** What was planted: `12 templates, version 1`, `2 templates`, `a payload file`, `templates and a payload file`. */
  what: string;
  /** Reads the recording doesn't hold, after a fork: fenced, each answered with an error, or run live (`--live-reads`). */
  unrecorded: 'fence' | 'live';
  /** Each untrusted call no payload was planted in, with why, as `shadowlap injection` prints it: `#9 fetch_page not planted: …`. */
  notPlanted: string[];
  /** The clean replays left out of the comparison, by read and why: `#4 get_ticket: 1 clean replay left out: …`. */
  leftOut: string[];
  startedAt: number;
  /** Who ran it, where names are shared. */
  by: string | null;
  /** The command that runs it again as it ran (a gate's golden, its test). */
  command: string;
  /** Why no attempt ran, in a sentence; null when one did. */
  none: string | null;
  receipt: { spent: number; upstreamRequests: number; baselines: number; stopReason: string | null };
}

/** What the `injection` job takes to test again as the test did. */
export function testedAs(report: Partial<PlantReport>): InjectionAgain {
  const baselines = (report.baselines ?? []).reduce((n, b) => Math.max(n, b.runs.length), 0);
  return { repeat: report.repeat ?? 1, templates: report.templates?.ids ?? [], baselines, liveReads: report.unrecordedReads === 'live' };
}

export function againCommand(runId: string, again: InjectionAgain): string {
  return commandLine(['injection', short(runId), ...(again.templates.length ? ['--templates', again.templates.join(',')] : []), '--baselines', String(again.baselines), ...(again.repeat !== 1 ? ['--repeat', String(again.repeat)] : []), ...(again.liveReads ? ['--live-reads'] : [])]);
}

/** Whether a test planted payloads from a file: its result keeps no file name, so the command and the meta say `a payload file`. */
const fromFile = (report: Pick<PlantReport, 'payloads'>) => report.payloads.some((p) => p.source === 'file');

/** What a test planted, in words: the whole built-in set with its version, else how many templates, and a payload file. */
export function plantedWords(report: Pick<PlantReport, 'payloads' | 'templates'>): string {
  const ids = report.templates?.ids ?? [];
  const all = injectionTemplates();
  const every = ids.length === all.templates.length && all.templates.every((t) => ids.includes(t.id));
  const templates = every ? `${ids.length} templates, version ${report.templates.version}` : ids.length ? plural(ids.length, 'template') : null;
  if (!fromFile(report)) return templates ?? 'no templates';
  return templates ? 'templates and a payload file' : 'a payload file';
}

/**
 * The command a kept plant ran as: a gate's `shadowlap test <golden>` (`gate`: a test session ran
 * it), else the test with its templates, on the golden it named or the run, a payload file as
 * `--payloads <file>`. A golden tested on its own has no gate: `shadowlap test` would plant nothing in
 * one whose entry sets no injection gate.
 */
export function panelCommand(report: PlantReport, gate = false): string {
  if (gate && report.golden) return commandLine(['test', report.golden]);
  const tested = againCommand(report.runId, testedAs(report));
  const again = report.golden ? tested.replace(/^shadowlap injection \S+/, () => commandLine(['injection', report.golden!])) : tested;
  if (!fromFile(report)) return again;
  return `${report.templates.ids.length ? again : again.replace(/^(shadowlap injection \S+)/, '$1 --templates none')} --payloads <file>`;
}

/** Each untrusted call no payload was planted in, in call order, as `shadowlap injection` prints it under the reads: a read that couldn't take one, and a call it passed over. */
function notPlantedLines(report: PlantReport): string[] {
  const calls = [...report.reads.filter((r) => !r.planted).map((r) => ({ callNo: r.callNo, name: r.name, why: r.why ?? '' })), ...report.skipped];
  return calls.sort((a, b) => a.callNo - b.callNo).map((c) => `#${c.callNo} ${c.name} not planted: ${c.why}`);
}

/** The clean replays left out of the comparison, once per read and reason, as `shadowlap injection` prints them. */
function leftOutLines(report: PlantReport): string[] {
  return report.baselines.flatMap((b) => {
    const whys = new Map<string, number>();
    for (const f of b.failed) whys.set(f.why, (whys.get(f.why) ?? 0) + 1);
    const name = report.reads.find((r) => r.callNo === b.read)?.name ?? '';
    return [...whys].map(([why, n]) => `#${b.read} ${name}: ${plural(n, 'clean replay')} left out: ${why}`);
  });
}

/** What an attempt rests on, as its cell's card says it. */
const restsOn = (a: AttemptReport): string => proofLine(a) ?? a.why ?? `no tool call after #${a.plantedAt ?? a.read} carries the canary`;

function cellOf(store: StoreOf<'recording'>, report: PlantReport, reads: readonly number[], payload: string): InjectionCellView | null {
  const cells = report.cells.filter((c) => reads.includes(c.read) && c.payload === payload && c.attempts);
  if (!cells.length) return null;
  const at = cells[0]!.read;
  const sum = { attempts: 0, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0 };
  for (const c of cells) for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += c[k];
  // One read's cell keeps the report's verdict; a tool's sums come to the strongest verdict any of their attempts showed, as the report decides a cell's.
  const verdict = cells.length === 1 ? cells[0]!.verdict : strongestVerdict(sum);
  const attempts = report.attempts.filter((a) => reads.includes(a.read) && a.payload === payload && a.verdict === verdict);
  const shown = attempts.find((a) => store.getRun(a.runId)) ?? null;
  const first = shown ?? attempts[0];
  return { read: first?.read ?? at, payload, verdict, n: sum[verdict], of: sum.attempts, attempt: shown ? { runId: shown.runId, callNo: proofCall(shown) } : null, line: first ? restsOn(first) : `no tool call after #${at} carries the canary` };
}

/** One kept plant's panel: what the run page's Show results opens. `gate`: a test session ran it, as a golden's injection gate. */
export function injectionPanel(store: StoreOf<'recording'>, report: PlantReport, o: { by?: string | null; gate?: boolean } = {}): InjectionPanelView {
  const planted = report.reads.filter((r) => r.planted);
  const cells = planted.flatMap((r) => report.payloads.map((p) => cellOf(store, report, [r.callNo], p.id))).filter((c): c is InjectionCellView => c !== null);
  const names = [...new Set(planted.map((r) => r.name))];
  const tools = planted.length > MANY_READS ? names.map((name) => {
    const reads = planted.filter((r) => r.name === name).map((r) => r.callNo);
    return { name, reads, cells: report.payloads.map((p) => cellOf(store, report, reads, p.id)).filter((c): c is InjectionCellView => c !== null) };
  }) : null;
  const baselines = report.baselines.reduce((n, b) => n + b.runs.length, 0);
  const { attempts, obeyed, influenced, inconclusive, ignored } = report.totals;
  return {
    rows: planted.map((r) => ({ callNo: r.callNo, name: r.name, from: r.from, readAt: r.readAt, worst: readWorst(report, r.callNo) })),
    cols: report.payloads.map((p) => ({ id: p.id, title: p.title, text: p.text })),
    cells,
    tools,
    totals: { attempts, obeyed, influenced, inconclusive, ignored },
    planned: planted.length * report.payloads.length * report.repeat,
    what: plantedWords(report),
    unrecorded: report.unrecordedReads === 'live' ? 'live' : 'fence',
    notPlanted: notPlantedLines(report),
    leftOut: leftOutLines(report),
    startedAt: report.startedAt,
    by: o.by ?? null,
    command: panelCommand(report, o.gate === true),
    none: attempts ? null : `No attempt ran: ${report.stopReason ?? 'nothing could be planted'}. ${plural(baselines, 'clean replay')} ran first, as a test runs them.`,
    receipt: { spent: report.cost.spent, upstreamRequests: report.cost.upstreamRequests, baselines, stopReason: report.stopReason },
  };
}

/** What an attempt's page marks beyond its run's own mark: where the payload went in, and the text planted there. */
export interface AttemptPlant {
  /** The attempt's call where the planted read was served. */
  plantedAt: number | null;
  /** Where in the read's recorded result the payload went (`$.body.reason`); null where it can't be said. */
  path: string | null;
  /** The payload's text with its canary filled, whole, as it was planted. */
  planted: string | null;
  /** A clean attempt's recorded writes it did not make again. */
  gone: number[] | null;
  /** A baseline's own writes after its fork. */
  writes: number | null;
}

const NONE: AttemptPlant = { plantedAt: null, path: null, planted: null, gone: null, writes: null };

/** Where the read's recorded result takes a payload: the path `--inject-result` plants after, from the recording alone. */
function plantPath(store: StoreOf<'recording'>, parent: string | null, read: number): string | null {
  if (!parent) return null;
  const call = store.getCalls(parent, { only: [read] })[0];
  if (!call?.end?.responseRef || call.kind !== 'tool') return null;
  const payload = store.getJson<{ result?: unknown }>(call.end.responseRef);
  const at = plantInToolResult(payload?.result, 'x', call.meta.http !== undefined);
  return refused(at) ? null : at.at;
}

/** What an attempt's page marks, from its mark, the result it belongs to and its run's calls: a baseline's writes after the read, counted as the CLI counts them (baselineWrites). */
export function attemptPlant(store: StoreOf<'recording'>, run: RunRecord, mark: InjectionMark, report: InjectionReport | null, calls: readonly CallRecord[]): AttemptPlant {
  if (!report) return NONE;
  if (report.mode === 'clean') {
    const a = report.attempts.find((x) => x.runId === run.runId);
    return { ...NONE, plantedAt: mark.read, gone: a ? a.gone : null };
  }
  const path = plantPath(store, run.parentRunId, mark.read);
  if (mark.role === 'baseline') return { ...NONE, path, writes: baselineWrites(calls, mark.read, run.divergence?.callNo ?? null).length };
  const a = report.attempts.find((x) => x.runId === run.runId);
  const payload = report.payloads.find((p) => p.id === mark.payload);
  const canary = a?.canary ?? mark.canary ?? null;
  return { ...NONE, plantedAt: a?.plantedAt ?? null, path, planted: payload && canary ? fillPayload(payload.text, canary) : (payload?.text ?? null) };
}

/** What the Forks view files a replay `shadowlap injection` made under, from its own record (`meta.injection`): its test, its role and place in it, and what its cell's card says. */
export interface LineageInjection {
  result: string;
  role: 'attempt' | 'baseline' | 'clean';
  attempt: number;
  of: number;
  verdict: string | null;
  /** The read it planted in (an attempt, a baseline) or tested (a clean attempt), and an attempt's payload. */
  read: number;
  payload: string | null;
  /** The call its line opens at: where an attempt shows its verdict (proofCall), where a clean attempt forked. */
  at: number | null;
  /** What an attempt's verdict rests on, its proof line, else why it showed nothing; why a clean attempt decided nothing. Null otherwise. */
  says: string | null;
  /** A clean attempt's recorded writes it did not make again, from its result; null for the others, and where the result is gone. */
  gone: number[] | null;
}

/** An attempt's proof line from its own record, as its page and its cell in the Forks view say it. */
export const markProof = (mark: InjectionMark): string | null =>
  mark.evidence?.length ? proofLine({ read: mark.read, forkedAt: mark.readAt ?? null, readAt: mark.readAt ?? null, evidence: mark.evidence.map((e) => ({ ...e, why: null })) }) : null;

/** The lineage's reader of each replay's injection mark: a --clean answer's result is read once, however many of its attempts the family holds. */
export function lineageInjection(store: StoreOf<'injection'>): (r: RunRecord) => LineageInjection | undefined {
  const cleans = new Map<string, CleanReport | null>();
  const cleanOf = (id: string): CleanReport | null => {
    if (!cleans.has(id)) {
      const kept = store.getInjectionResult(id);
      cleans.set(id, kept?.mode === 'clean' ? (kept.data as unknown as CleanReport) : null);
    }
    return cleans.get(id)!;
  };
  return (r) => {
    const m = r.meta?.injection;
    if (!m) return undefined;
    const clean = m.role === 'clean';
    return {
      result: m.result,
      role: m.role,
      attempt: m.attempt,
      of: m.of,
      verdict: m.verdict ?? null,
      read: m.read,
      payload: m.payload ?? null,
      at: clean ? (m.readAt ?? null) : proofCall(m),
      says: m.role === 'attempt' ? (markProof(m) ?? m.why ?? null) : (m.why ?? null),
      gone: clean ? (cleanOf(m.result)?.attempts.find((a) => a.runId === r.runId)?.gone ?? null) : null,
    };
  };
}
