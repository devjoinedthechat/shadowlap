import type { BlameStep, CandidateVerdict, FixBundle, FixDetail, FixRow, RepairStep, StepKey, VerifyRow, VerifyStep } from '../types.js';

/**
 * How the Fixes pages read a fix: which rows a filter keeps, which step and verdict a URL opens, the
 * words beside each badge, the run's calls as the Blame step lines them up, the change a repair made
 * cut to what changed, and report.md as blocks. No DOM here: the tests import it.
 */

// ---------------------------------------------------------------------------------------------- the list

export type FixChip = 'all' | 'open' | 'verified';

export const FIX_CHIPS: ReadonlyArray<{ key: FixChip; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'verified', label: 'Verified' },
];

export const isFixChip = (v: string): v is FixChip => v === 'all' || v === 'open' || v === 'verified';

/** Verified keeps applied fixes too, as the counts do. */
export function chipKeeps(chip: FixChip, f: Pick<FixRow, 'status'>): boolean {
  if (chip === 'all') return true;
  return chip === 'open' ? f.status === 'open' : f.status !== 'open';
}

/** The status badge: open in amber, verified and applied in lime, an applied fix that doesn't hold in red. */
export function statusBadge(f: Pick<FixRow, 'status' | 'broken'>): { tone: 'y' | 'ok' | 'no'; text: string } {
  if (f.status === 'open') return { tone: 'y', text: 'open' };
  if (f.status === 'applied' && f.broken) return { tone: 'no', text: 'broken' };
  return { tone: 'ok', text: f.status };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** When a fix was opened: Sep 30, 16:20 (local time). */
export function fixStamp(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A later moment beside an earlier one: only its time on the same day (17:40), else its date too. */
export function laterStamp(ms: number, since: number): string {
  return sameDay(new Date(ms), new Date(since)) ? `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}` : fixStamp(ms);
}

/** A fix's id as the CLI prints it: `fx-` and ten characters. */
export const shortFixId = (fixId: string): string => fixId.slice(0, 13);

/** What the breadcrumb and the eyebrow call a fix: its label, or its short id. */
export function fixName(f: Pick<FixRow, 'label' | 'fixId'>): string {
  return f.label ?? shortFixId(f.fixId);
}

const s = (n: number) => (n === 1 ? '' : 's');

/** "3 failing runs · issue_refund never called with {…}" */
export function failingLine(f: Pick<FixRow, 'failing' | 'check'>): string {
  return `${f.failing} failing run${s(f.failing)} · ${f.check}`;
}

// ---------------------------------------------------------------------------------------------- a fix

const STEPS: readonly StepKey[] = ['blame', 'repair', 'verify'];

/** The step a URL opens: the one it names, else the fix's last finished step. */
export function stepFor(f: Pick<FixDetail, 'defaultStep'>, step: string | null): StepKey {
  return step && (STEPS as readonly string[]).includes(step) ? (step as StepKey) : f.defaultStep;
}

/** The verdict the Verify step shows: the one its URL names (by id or a prefix of it), else the one the fix shows first. */
export function verifyFor(f: Pick<FixDetail, 'verify' | 'defaultVerify'>, sub: string | null): VerifyStep | null {
  const want = sub?.toLowerCase();
  const named = want ? f.verify.find((v) => v.verifyId.toLowerCase() === want || (want.length >= 6 && v.verifyId.toLowerCase().startsWith(want))) : undefined;
  return named ?? f.verify.find((v) => v.verifyId === f.defaultVerify) ?? f.verify[0] ?? null;
}

/** What the page's main button does, if anything: repair an open fix, apply a verified one, finish an apply, or nothing. */
export type FixAction = { kind: 'repair' } | { kind: 'apply'; label: 'Apply the patch' | 'Mark applied' | 'Finish applying' } | { kind: 'applied' } | { kind: 'none'; label: 'Repair from here' | 'Apply the patch'; why: string };

export function fixAction(f: Pick<FixDetail, 'status' | 'actions'>): FixAction {
  if (f.status === 'open') return f.actions.repair ? { kind: 'repair' } : { kind: 'none', label: 'Repair from here', why: 'None of its failing runs is left in the store, so there is nothing to repair from here.' };
  const apply = f.actions.apply;
  if (!apply) return { kind: 'none', label: 'Apply the patch', why: 'No change has been verified for it.' };
  if (f.actions.applied) return apply.pending ? { kind: 'apply', label: 'Finish applying' } : { kind: 'applied' };
  return { kind: 'apply', label: apply.kind === 'mark' ? 'Mark applied' : 'Apply the patch' };
}

/** A job as the working tree's lock reads it: whether it is running, and how it uses the tree. */
export interface TreeJob {
  id: string;
  done: boolean;
  worktree?: { use: 'reads' | 'writes'; doing: string } | null;
}

/**
 * Why an action that uses the working tree as `use` can't start now, as the server would refuse it:
 * a job that changes the tree is running, or, for one that changes it, any job running the agent
 * from it. `verb` is what to do once it is free: "A repair is trying candidates in your working
 * tree: blame once it is done." Null when it can start.
 */
export function treeBusy(jobs: readonly TreeJob[], use: 'reads' | 'writes', verb: string): string | null {
  const j = jobs.find((x) => !x.done && x.worktree && (use === 'writes' || x.worktree.use === 'writes'));
  const doing = j?.worktree?.doing;
  return doing ? `${doing.charAt(0).toUpperCase()}${doing.slice(1)}: ${verb} once it is done.` : null;
}

// ---------------------------------------------------------------------------------------------- blame

export interface CallCell {
  callNo: number;
  /** A model call (a ring) or another call (a dot); `gap` stands for calls left out. */
  kind: 'm' | 't' | 'gap';
  /** Where blame looked: rescued, lost, or the call it blamed. */
  verdict: 'rescued' | 'lost' | 'blamed' | null;
  passes: number;
  attempts: number;
  /** Outside the blame's scope. */
  dim: boolean;
  /** For a gap: how many calls it stands for. */
  skipped?: number;
}

/** Calls the row shows at most before it leaves some out: past this, each would be too narrow to read. */
export const CALL_ROW_MAX = 18;

/**
 * The run's calls as the Blame step lines them up, one cell each, rings for model calls. A long run
 * keeps its model calls only (`toolsLeftOut`); a longer one only the probed calls, the model calls on
 * either side of each, and the first and last, with a gap for each stretch of model calls left out.
 */
export function callRowCells(row: BlameStep['callRow'], max = CALL_ROW_MAX): { cells: CallCell[]; toolsLeftOut: boolean } {
  const cell = (c: BlameStep['callRow'][number]): CallCell => ({ callNo: c.callNo, kind: c.kind === 'api' ? 'm' : 't', verdict: c.verdict, passes: c.passes, attempts: c.attempts, dim: !c.inScope });
  if (row.length <= max) return { cells: row.map(cell), toolsLeftOut: false };
  const models = row.filter((c) => c.kind === 'api' || c.verdict !== null);
  const keep = new Set<number>();
  if (models.length <= max) for (const c of models) keep.add(c.callNo);
  else {
    const add = (i: number) => models[i] && keep.add(models[i]!.callNo);
    add(0);
    add(models.length - 1);
    models.forEach((c, i) => {
      if (c.verdict !== null) [i - 1, i, i + 1].forEach(add);
    });
    // Room left: fill from the start, so the row reads from the beginning.
    for (let i = 0; i < models.length && keep.size < max; i++) add(i);
  }
  const cells: CallCell[] = [];
  const gap = (callNo: number, skipped: number): CallCell => ({ callNo, kind: 'gap', verdict: null, passes: 0, attempts: 0, dim: false, skipped });
  let hiddenModels = 0;
  let hidden = 0;
  for (const c of row) {
    if (!keep.has(c.callNo)) {
      hidden++;
      if (c.kind === 'api') hiddenModels++;
      continue;
    }
    if (hiddenModels) cells.push(gap(c.callNo - 0.5, hidden));
    hiddenModels = 0;
    hidden = 0;
    cells.push(cell(c));
  }
  if (hiddenModels) cells.push(gap(row.at(-1)!.callNo + 0.5, hidden));
  return { cells, toolsLeftOut: true };
}

/** How a probe's verdict reads as a badge: rescued in lime, lost in red, the blamed one in amber. */
export function probeBadge(verdict: BlameStep['probes'][number]['verdict']): 'ok' | 'no' | 'y' {
  return verdict === 'rescued · blamed' ? 'y' : verdict === 'lost' ? 'no' : 'ok';
}

/** "Model call 3 of 4" (in scope agent), or the run alone when blame placed the failure on no call. */
export function blameWhere(b: Pick<BlameStep, 'step' | 'steps' | 'scope'>): string | null {
  if (b.step === null) return null;
  return `Model call ${b.step} of ${b.steps}${b.scope ? ` in scope ${b.scope}` : ''}`;
}

// ---------------------------------------------------------------------------------------------- repair

/** A candidate's badge: accepted in lime, rejected in red, anything else plain. */
export function candidateTone(v: CandidateVerdict): 'ok' | 'no' | 'n' {
  return v === 'accepted' ? 'ok' : v === 'rejected' || v === 'build failed' ? 'no' : 'n';
}

/** The result per role, as a badge: "target 1 of 1", lime when every run held. */
export function roleBadges(roles: RepairStep['roles']): Array<{ text: string; tone: 'ok' | 'no' }> {
  return roles.map((r) => ({ text: `${r.role} ${r.held} of ${r.of}`, tone: r.held === r.of ? 'ok' : 'no' }));
}

/**
 * The change a repair made, cut to what changed: the text before it and after it in the new
 * version, the added text itself, and the old version. A long prompt keeps `context` characters on
 * each side of the change, with an ellipsis where it was cut.
 */
export function changeParts(change: NonNullable<RepairStep['change']>, context = 240): { was: string; head: string; added: string; tail: string } {
  const cut = (text: string, from: number, to: number) => `${from > 0 ? '…' : ''}${text.slice(Math.max(0, from), Math.min(text.length, to))}${to < text.length ? '…' : ''}`;
  if (!change.added) {
    const at = commonPrefix(change.before, change.after);
    return { was: cut(change.before, at - context, at + context + change.removed.length), head: cut(change.after, at - context, at + context), added: '', tail: '' };
  }
  const { at, text } = change.added;
  const end = at + text.length;
  const removedEnd = at + change.removed.length;
  return {
    was: cut(change.before, at - context, removedEnd + context),
    head: at > context ? `…${change.after.slice(at - context, at)}` : change.after.slice(0, at),
    added: text,
    tail: change.after.length - end > context ? `${change.after.slice(end, end + context)}…` : change.after.slice(end),
  };
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ---------------------------------------------------------------------------------------------- verify

/** A run's outcome as a badge: fixed and kept in lime, broken and not fixed in red, unsettled plain. */
export function outcomeTone(o: VerifyRow['outcome']): 'ok' | 'no' | 'n' {
  return o === 'fixed' || o === 'kept' ? 'ok' : o === 'unsettled' ? 'n' : 'no';
}

export function verdictTone(v: VerifyStep['verdict']): 'ok' | 'no' | 'n' {
  return v === 'accepted' ? 'ok' : v === 'rejected' ? 'no' : 'n';
}

/** Tokens per run, as a person reads them: 4,329. */
export const tokens = (n: number): string => Math.round(n).toLocaleString('en-US');

// ---------------------------------------------------------------------------------------------- the Forks view

/** The runs a family view leaves out because a bundle lists them: every attempt but the fork blame rescued a run with, which shows as a fork. */
export function bundledRuns(bundles: readonly FixBundle[]): Set<string> {
  const out = new Set<string>();
  for (const b of bundles) for (const a of b.attempts) if (!a.rescued) out.add(a.runId);
  return out;
}

/** A bundle's icon and the words for it: blame attempts, or a verify accepted or rejected. */
export function bundleGlyph(b: Pick<FixBundle, 'kind' | 'verdict'>): { kind: 'blame' | 'fixok' | 'fixbad' | 'fork'; label: string } {
  if (b.kind === 'blame') return { kind: 'blame', label: 'Blame attempts' };
  if (b.verdict === 'accepted') return { kind: 'fixok', label: 'Verify accepted the change' };
  if (b.verdict === 'rejected') return { kind: 'fixbad', label: 'Verify rejected the change' };
  return { kind: 'fork', label: 'Verify attempts, not settled' };
}

/** The line under a bundle's title: "4 attempts, 2 passed · ≈$0.032", and for a verify the change and how it came out. */
export function bundleLine(b: Pick<FixBundle, 'kind' | 'attempts' | 'passes' | 'spent' | 'change' | 'verdict'>, money: (usd: number) => string): string {
  const n = b.attempts.length;
  return [`${n} attempt${s(n)}, ${b.passes} passed`, ...(b.spent ? [money(b.spent)] : []), ...(b.kind === 'verify' && b.change ? [`${b.change}${b.verdict ? ` ${b.verdict}` : ''}`] : [])].join(' · ');
}

// ---------------------------------------------------------------------------------------------- report.md

export type MdBlock =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'ul'; items: string[] };

const BLOCK_START = /^(#{1,6}\s|```|\s*\||\s*[-*]\s+)/;

/** Splits a table row on its pipes, leaving `\|` inside a cell as a pipe. */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * report.md as blocks the page draws as React elements: headings, paragraphs, code fences, tables and
 * lists, which is all a repair report writes. Never HTML: the text stays text.
 */
export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ kind: 'code', lang: fence[1] ?? '', lines: body });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: 'h', level: h[1]!.length, text: h[2]!.trim() });
      i++;
      continue;
    }
    if (line.trimStart().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('|')) rows.push(cells(lines[i++]!));
      const sep = rows[1]?.every((c) => /^:?-{2,}:?$/.test(c)) ? 1 : -1;
      out.push({ kind: 'table', head: rows[0] ?? [], rows: rows.filter((_, k) => k !== 0 && k !== sep) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, ''));
      out.push({ kind: 'ul', items });
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !BLOCK_START.test(lines[i]!)) para.push(lines[i++]!.trim());
    out.push({ kind: 'p', text: para.join(' ') });
  }
  return out;
}

/** A line of report.md cut where it sets code in backticks. */
export function inlineParts(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const re = /`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ code: false, text: text.slice(at, m.index) });
    out.push({ code: true, text: m[1]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) });
  return out;
}

// ---------------------------------------------------------------------------------------------- the job drawer

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * How a blame, a repair or a fix apply ended, as the drawer's status says it, from the result the
 * command reported: "lost at #5 · exit 0", "no fix found · exit 1", "applied · tests passed · exit 0".
 * Null for any other job, or a result this doesn't know, so the drawer reads the output instead.
 */
export function fixJobStatus(job: { kind?: string; code: number | null; result?: unknown }): { text: string; tone: 'ok' | 'warn' | 'err' } | null {
  const r = job.result;
  if (job.code === null || !isRecord(r)) return null;
  const exit = `exit ${job.code}`;
  const tone = job.code === 0 ? 'ok' : 'err';
  if (job.kind === 'blame') {
    const blamed = isRecord(r.blamed) && typeof r.blamed.callNo === 'number' ? r.blamed.callNo : null;
    if (r.outcome === 'blamed' && blamed !== null) return { text: `lost at #${blamed} · ${exit}`, tone };
    if (r.outcome === 'unrescuable') return { text: `not rescued · ${exit}`, tone: job.code === 0 ? 'warn' : 'err' };
    if (r.outcome === 'stopped') return { text: `stopped early · ${exit}`, tone: 'err' };
    return null;
  }
  if (job.kind === 'repair') {
    if (r.outcome === 'fixed') return { text: `${isRecord(r.error) ? 'fixed, not handed over' : 'fixed'} · ${exit}`, tone };
    if (r.outcome === 'not-fixed') return { text: `no fix found · ${exit}`, tone: 'err' };
    if (r.outcome === 'no-diagnosis') return { text: `nothing to try · ${exit}`, tone: 'err' };
    if (r.outcome === 'stopped') return { text: `stopped · ${exit}`, tone: 'err' };
    return null;
  }
  if (job.kind === 'apply') {
    if (r.status === 'already-applied') return { text: `applied already · ${exit}`, tone };
    if (r.status !== 'applied') return null;
    return { text: `applied${r.tests === 'passed' || r.tests === 'failed' ? ` · tests ${r.tests}` : ''} · ${exit}`, tone: r.tests === 'failed' ? 'err' : tone };
  }
  return null;
}
