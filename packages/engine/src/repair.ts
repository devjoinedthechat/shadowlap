import { formatUsd } from './prices.js';
import type { Palette } from './report.js';
import { plain } from './report.js';
import { safeLine } from './text.js';
import { footprintDelta, outcomeOf, type VerifiedRun, type VerifyReport } from './verify.js';

/**
 * The deterministic half of `shadowlap repair`. A model proposes fixes; everything that decides whether
 * one is applied, and whether it is kept, is here or in the verify gate, so the model never grades
 * its own work.
 *
 * A fix is a rewrite of one **anchor**: a span of the text the agent sends the model (its system
 * prompt, a tool description) that appears exactly once, verbatim, in the project's source. The
 * repairer may only rewrite anchors, so every candidate can be applied where the text lives, and a
 * patch is one contiguous change a reviewer can read.
 *
 * Fixes written while reading failed runs tend to fit those runs: "if the order is A-1042, escalate".
 * **Case details** are the ids, amounts and addresses that appear in the failing runs but not in the
 * good ones or in the prompt itself; a candidate that brings one in is rejected before anything runs.
 */

/** A text the agent sends the model that a fix may rewrite. */
export interface Surface {
  /** `system prompt`, or `tool <name>` for a tool description. */
  label: string;
  text: string;
}

export interface SourceFile {
  /** Relative to the project root, with forward slashes. */
  path: string;
  content: string;
}

export interface Anchor {
  id: number;
  surface: string;
  text: string;
  file: string;
  /** Where the text starts in the file. */
  offset: number;
}

/** Spans worth anchoring, largest first: the whole text, its lines, the sentences of each line. */
function spansOf(text: string): string[] {
  const out: string[] = [text.trim()];
  for (const line of text.split('\n')) {
    const l = line.trim();
    out.push(l);
    for (const sentence of l.split(/(?<=[.!?])\s+/)) out.push(sentence.trim());
  }
  return [...new Set(out)].filter((s) => s.length >= 12);
}

function occurrences(haystack: string, needle: string, limit = 2): number[] {
  const at: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1 && at.length < limit; i = haystack.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/**
 * The spans of each surface that appear exactly once across the project's files. A span inside a
 * larger anchored span of the same surface is left out: rewriting the larger one covers it.
 */
export function findAnchors(surfaces: readonly Surface[], files: readonly SourceFile[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const surface of surfaces) {
    const taken: string[] = [];
    for (const span of spansOf(surface.text)) {
      if (taken.some((t) => t.includes(span))) continue;
      let found: { file: string; offset: number } | null = null;
      let count = 0;
      for (const f of files) {
        const at = occurrences(f.content, span);
        count += at.length;
        if (count > 1) break;
        if (at.length === 1) found = { file: f.path, offset: at[0]! };
      }
      if (count !== 1 || !found) continue;
      taken.push(span);
      if (!anchors.some((a) => a.file === found.file && a.offset === found.offset && a.text === span)) anchors.push({ id: anchors.length + 1, surface: surface.label, text: span, ...found });
    }
  }
  return anchors;
}

/** Ids, amounts and email addresses in a text, lower-cased: what a case is made of. */
export function caseDetails(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) out.add(m[0].toLowerCase());
  // An id: letters and digits run together, such as A-1042, INC_7731 or ord9f2.
  for (const m of text.matchAll(/\b[A-Za-z]+[-_]?\d[\w-]*|\b\d+[A-Za-z][\w-]*/g)) out.add(m[0].toLowerCase());
  // An amount or number of two digits or more: 240, $1,250.00. Single digits are too common to mean a case.
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, '').replace(/\.0+$/, '');
    if (n.replace(/\D/g, '').length >= 2) out.add(n);
  }
  return out;
}

/** Case details of the failing runs that neither the good runs nor the agent's own prompt contain. */
export function forbiddenDetails(failing: readonly string[], allowed: readonly string[]): Set<string> {
  const ok = new Set<string>();
  for (const t of allowed) for (const d of caseDetails(t)) ok.add(d);
  const out = new Set<string>();
  for (const t of failing) for (const d of caseDetails(t)) if (!ok.has(d)) out.add(d);
  return out;
}

/** A file whose text is prose, not code: Markdown and plain text, where a prompt often lives. */
export function isProse(path: string): boolean {
  return /\.(md|markdown|mdx|txt|rst|prompt)$/i.test(path);
}

/** A rewrite the repairer proposed, as it proposed it. */
export interface ProposedEdit {
  anchor: number;
  replace: string;
  strategy: string;
  why: string;
}

export type EditCheck = { ok: true } | { ok: false; reason: string };

/** Whether a proposed rewrite may be tried at all. */
export function checkEdit(edit: ProposedEdit, anchors: readonly Anchor[], forbidden: ReadonlySet<string>): EditCheck {
  const anchor = anchors.find((a) => a.id === edit.anchor);
  if (!anchor) return { ok: false, reason: `anchor ${edit.anchor} does not exist` };
  const replace = edit.replace.trim();
  if (!replace) return { ok: false, reason: 'the replacement is empty' };
  if (replace === anchor.text) return { ok: false, reason: 'the replacement is the text it replaces' };
  // A one-line span stays one line. In code it sits in a string, which quotes and backslashes would
  // end or escape; in a prose file (a Markdown policy) they are just punctuation.
  if (/[\n\r]/.test(replace) && !/[\n\r]/.test(anchor.text)) return { ok: false, reason: 'the replacement spans several lines, and the text it replaces is one' };
  if (!isProse(anchor.file) && /["'`\\]/.test(replace) && !/["'`\\]/.test(anchor.text)) return { ok: false, reason: 'the replacement has quotes or backslashes, which could break the string in code it goes into' };
  if (replace.length > Math.max(600, anchor.text.length * 4)) return { ok: false, reason: `the replacement is ${replace.length} characters, far longer than the ${anchor.text.length} it replaces` };
  const before = caseDetails(anchor.text);
  const brought = [...caseDetails(replace)].filter((d) => forbidden.has(d) && !before.has(d));
  if (brought.length) {
    // As written in the replacement, and without the parts of a detail already named (1042 of A-1042).
    const shown = brought.filter((d) => !brought.some((o) => o !== d && o.includes(d))).map((d) => replace.slice(replace.toLowerCase().indexOf(d)).slice(0, d.length) || d);
    return { ok: false, reason: `it mentions ${shown.join(', ')}, which only the failing runs contain: a fix has to hold for cases it has not seen` };
  }
  return { ok: true };
}

/** Characters a rewrite changes: what differs between the text and its replacement, past their common start and end. */
export function editSize(before: string, after: string): number {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return before.length - p - s + (after.length - p - s);
}

/** A file with one span replaced. Throws when the span is not where the anchor says, rather than guess. */
export function applyEdit(content: string, at: { offset: number; text: string }, replace: string): string {
  if (content.slice(at.offset, at.offset + at.text.length) !== at.text) throw new Error('the file changed since its text was anchored');
  return content.slice(0, at.offset) + replace + content.slice(at.offset + at.text.length);
}

/**
 * A unified diff of one file, as `git apply` reads it: one hunk around the lines that differ, with
 * three lines of context. Enough for a rewrite of one span, which is all a repair makes.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const split = (s: string) => {
    const lines = s.split('\n');
    const eol = lines.at(-1) === '';
    if (eol) lines.pop();
    return { lines, eol };
  };
  const a = split(before);
  const b = split(after);
  let p = 0;
  while (p < a.lines.length && p < b.lines.length && a.lines[p] === b.lines[p]) p++;
  let s = 0;
  while (s < a.lines.length - p && s < b.lines.length - p && a.lines[a.lines.length - 1 - s] === b.lines[b.lines.length - 1 - s]) s++;
  // A change in the final newline alone moves no line; take the last line into the change.
  if (p === a.lines.length && p === b.lines.length) {
    p = Math.max(0, a.lines.length - 1);
    s = 0;
  }
  const start = Math.max(0, p - context);
  const aEnd = Math.min(a.lines.length, a.lines.length - s + context);
  const bEnd = Math.min(b.lines.length, b.lines.length - s + context);
  const out: string[] = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start + 1},${aEnd - start} +${start + 1},${bEnd - start} @@`];
  const noEol = '\\ No newline at end of file';
  const push = (prefix: string, line: string, last: boolean, eol: boolean) => {
    out.push(prefix + line);
    if (last && !eol) out.push(noEol);
  };
  for (let i = start; i < p; i++) push(' ', a.lines[i]!, false, true);
  for (let i = p; i < a.lines.length - s; i++) push('-', a.lines[i]!, i === a.lines.length - 1, a.eol);
  for (let i = p; i < b.lines.length - s; i++) push('+', b.lines[i]!, i === b.lines.length - 1, b.eol);
  for (let i = a.lines.length - s; i < aEnd; i++) push(' ', a.lines[i]!, i === a.lines.length - 1, a.eol && b.eol);
  return out.join('\n') + '\n';
}

// ---- The report ------------------------------------------------------------------------------

export type CandidateState = 'invalid' | 'untried' | 'build-failed' | 'rejected' | 'incomplete' | 'accepted';

export interface RepairCandidate {
  id: number;
  /** `repairer`: proposed by the model; `model`: a switch to the model that rescued the runs, which needs no model to propose. */
  source: 'repairer' | 'model';
  strategy: string;
  why: string;
  surface: string;
  file: string;
  /** Where `before` starts in the file: the edit is made there, not wherever the text happens to appear. */
  offset: number;
  before: string;
  after: string;
  size: number;
  state: CandidateState;
  /** Why it was not kept, for every state but `accepted`. */
  reason: string | null;
  verify: VerifyReport | null;
}

export interface RepairTarget {
  runId: string;
  /**
   * What its blame found: where the run was lost (`blamed`), that no model call rescued it, that the
   * search stopped, that the run passed the check when replayed so there was no failure to blame
   * (`passes`: it is not a failing run, whatever `--fixes` said), or that blame couldn't run (`note`
   * says why).
   */
  outcome: 'blamed' | 'unrescuable' | 'stopped' | 'passes' | 'error';
  callNo: number | null;
  step: number | null;
  steps: number;
  rescuedRunId: string | null;
  /** The model that rescued the run, when resampling the recorded one did not. */
  rescuedBy: string | null;
  /** The blame stored on the run was used rather than run again. */
  reused: boolean;
  /** What the agent answered at the blamed call, in the recording and in the rescued fork. */
  recorded: string | null;
  rescued: string | null;
  note: string | null;
}

export type RepairOutcome = 'fixed' | 'not-fixed' | 'no-diagnosis' | 'stopped';

export interface RepairReport {
  outcome: RepairOutcome;
  /** Why it is not fixed, for every outcome but `fixed`. */
  why: string | null;
  targets: RepairTarget[];
  holdout: string[];
  good: string[];
  /** Held-out runs were taken from the failing runs given, because none were named. */
  heldOutAutomatically: boolean;
  oracle: string[];
  /** Who proposed the candidates: null when no repairer answered. */
  repairer: { provider: string; model: string; served: string | null; cost: number | null } | null;
  /**
   * Why no repairer proposed candidates when nothing cheaper was accepted, in a few words
   * ({@link NO_REPAIRER}): none is configured, it had nothing it could rewrite, or it could not be
   * asked (`the repairer could not be asked: claude was not found`). One of `warnings` says it at
   * length, with what to do. Null when the repairer answered, or when nothing called for it: a fix
   * that needs no model was accepted, no failing run was rescued, or the repair stopped first.
   * Reports written before it was added lack it: read it with {@link noRepairerOf}.
   */
  noRepairer?: string | null;
  diagnosis: string | null;
  anchors: number;
  candidates: RepairCandidate[];
  /** The accepted candidate's id. */
  accepted: number | null;
  patch: string | null;
  cost: { blame: number; repairer: number | null; verify: number };
  /**
   * What write tools did after a fork, in every replay blame and verify made: stubbed (the agent
   * carried on as if the write succeeded) or blocked. Reports written before it was kept lack it.
   */
  writes?: 'stub' | 'block';
  /**
   * With `--branch`: tracked files that had uncommitted changes when the fix was handed over. Verify
   * replayed the working tree with them; the branch is HEAD with the fix, without them. Absent when
   * there were none, or no branch was asked for.
   */
  uncommitted?: string[];
  output: { dir: string | null; patch: string | null; report: string | null; goldens: string[]; applied: boolean; branch: string | null; pr: string | null };
  warnings: string[];
}

/** What `noRepairer` says. The warning that says it at length, with what to do, starts with it. */
export const NO_REPAIRER = {
  unconfigured: 'no repairer is configured',
  nothingToRewrite: 'the repairer had nothing it could rewrite',
  /** Followed by what went wrong, in a few words: `the repairer could not be asked: claude was not found`. */
  notAsked: 'the repairer could not be asked',
} as const;

/**
 * Why no repairer proposed candidates for a repair, or null: in a few words (its `noRepairer`, or,
 * in a report kept before there was one, what its warnings say), and the warning that says it at
 * length, with what to do. A repair whose repairer answered, and one that needed none (a fix that
 * needs no model was accepted), give null.
 */
export function noRepairerOf(r: Pick<RepairReport, 'noRepairer' | 'repairer' | 'warnings'>): { text: string; warning: string | null } | null {
  const warnings = Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string') : [];
  // The warning starts with it; in an older report, one about nothing to rewrite ends with it.
  const said = (text: string) => ({ text, warning: warnings.find((w) => w.startsWith(text) || w.endsWith(text)) ?? null });
  if (typeof r.noRepairer === 'string' && r.noRepairer.trim()) return said(r.noRepairer);
  if (r.noRepairer !== undefined || r.repairer) return null;
  for (const w of warnings) {
    // `the repairer could not be asked: <what went wrong>: <what to do>`, kept to what went wrong.
    if (w.startsWith(`${NO_REPAIRER.notAsked}: `)) return { text: `${NO_REPAIRER.notAsked}: ${w.slice(NO_REPAIRER.notAsked.length + 2).split(': ')[0]}`, warning: w };
    if (w.startsWith(NO_REPAIRER.unconfigured)) return { text: NO_REPAIRER.unconfigured, warning: w };
    if (w.endsWith(NO_REPAIRER.nothingToRewrite)) return { text: NO_REPAIRER.nothingToRewrite, warning: w };
  }
  return null;
}

const short = (id: string) => id.slice(0, 10);

const one = (s: string, n = 90) => {
  const line = safeLine(s).replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** What a fix's report says when verify replayed uncommitted changes that its branch doesn't hold. */
function uncommittedNote(files: readonly string[]): string {
  const named = files.slice(0, 5).map((f) => `\`${one(f, 120)}\``).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');
  return `The runs were replayed on a working tree with uncommitted changes to ${named}. The branch holds HEAD with the fix, without them, so check that it passes as committed.`;
}

/** The commit title for a candidate: its strategy, as a sentence without a full stop. */
export function commitTitle(c: Pick<RepairCandidate, 'strategy'>): string {
  const t = one(c.strategy, 72).replace(/[.\s]+$/, '');
  return t ? t[0]!.toUpperCase() + t.slice(1) : 'Repair the agent instructions';
}

function verifiedLine(v: VerifyReport): string {
  const count = (role: VerifiedRun['role']) => {
    const of = v.runs.filter((x) => x.role === role);
    return { of: of.length, ok: of.filter((x) => x.verdict === 'pass').length };
  };
  const t = count('target');
  const h = count('holdout');
  const g = count('good');
  const parts = [t.of ? `fixes ${t.ok} of ${t.of} target run${t.of === 1 ? '' : 's'}` : '', h.of ? `${h.ok} of ${h.of} held-out` : '', g.of ? `keeps ${g.ok} of ${g.of} good` : ''].filter(Boolean);
  return `${parts.join(', ')}, each at ${v.needed} of ${v.attemptsPerRun} attempts`;
}

export function formatRepair(r: RepairReport, p: Palette = plain): string {
  const lines: string[] = [];
  const accepted = r.candidates.find((c) => c.id === r.accepted) ?? null;
  if (r.outcome === 'fixed' && accepted) {
    lines.push(`${p.green('✓')} ${p.bold(`Fixed: ${commitTitle(accepted)}`)}`);
    lines.push(`  ${p.dim(`${safeLine(accepted.file)} · ${safeLine(accepted.surface)}`)}`);
    lines.push(`  ${p.red(`- ${one(accepted.before, 200)}`)}`, `  ${p.green(`+ ${one(accepted.after, 200)}`)}`);
    if (accepted.verify) lines.push('', `  Verified: ${verifiedLine(accepted.verify)}`);
  } else {
    const head = r.outcome === 'stopped' ? `${p.yellow('!')} ${p.bold('Stopped')}` : r.outcome === 'no-diagnosis' ? `${p.yellow('!')} ${p.bold('No fix to try')}` : `${p.red('✗')} ${p.bold('Not fixed')}`;
    lines.push(`${head}${r.why ? `: ${safeLine(r.why)}` : ''}`);
  }

  if (r.targets.length) {
    lines.push('', `  ${p.bold('Where the failing runs were lost')}`);
    for (const t of r.targets) {
      const where =
        t.outcome === 'blamed' && t.callNo !== null
          ? `model call #${t.callNo} (${t.step} of ${t.steps})${t.rescuedBy ? `, rescued by ${safeLine(t.rescuedBy)}` : ''}${t.reused ? p.dim(' · from an earlier blame') : ''}`
          : t.outcome === 'unrescuable'
            ? 'not rescued from any model call'
            : safeLine(t.note ?? t.outcome);
      lines.push(`    ${short(t.runId)}  ${where}`);
    }
  }
  if (r.diagnosis) lines.push('', `  ${p.bold('Diagnosis')} ${p.dim(`(${r.repairer ? safeLine(r.repairer.served ?? r.repairer.model) : 'repairer'})`)}`, `    ${one(r.diagnosis, 300)}`);

  if (r.candidates.length) {
    lines.push('', `  ${p.bold('Candidates')} ${p.dim('(tried smallest first; the first the gate accepts is kept)')}`);
    const w = Math.max(...r.candidates.map((c) => c.state.length));
    for (const c of r.candidates) {
      const state = c.state === 'accepted' ? p.green(c.state.padEnd(w)) : c.state === 'untried' ? p.dim(c.state.padEnd(w)) : p.yellow(c.state.padEnd(w));
      lines.push(`    ${String(c.id).padStart(2)}  ${state}  ${one(`${c.surface}: ${c.after}`, 80)}`);
      if (c.reason) lines.push(`        ${p.dim(one(c.reason, 150))}`);
    }
  }

  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `  ${p.yellow('!')} ${safeLine(w)}`));

  const repairer = r.repairer ? ` · repairer ${r.repairer.cost === null ? `(no price for ${safeLine(r.repairer.served ?? r.repairer.model)})` : `≈${formatUsd(r.repairer.cost)}`}` : '';
  lines.push('', p.dim(`  cost: blame ≈${formatUsd(r.cost.blame)}${repairer} · verify ≈${formatUsd(r.cost.verify)}`));
  if (r.output.patch) lines.push(p.dim(`  patch: ${safeLine(r.output.patch)}${r.output.applied ? ' (applied to the working tree)' : `   apply it: git apply ${safeLine(r.output.patch)}`}`));
  if (r.output.report) lines.push(p.dim(`  report: ${safeLine(r.output.report)}`));
  if (r.output.goldens.length) lines.push(p.dim(`  recordings of the fixed runs, for shadowlap test: ${r.output.goldens.map(safeLine).join(' ')}`));
  if (r.output.branch) lines.push(p.dim(`  branch: ${safeLine(r.output.branch)}`));
  if (r.output.pr) lines.push(p.dim(`  pull request: ${safeLine(r.output.pr)}`));
  return lines.join('\n');
}

const cell = (s: string) => one(s, 160).replace(/\|/g, '\\|');

/** The report as Markdown, for a pull request: the change, why it was needed, and the evidence that it holds. */
export function repairMarkdown(r: RepairReport): string {
  const accepted = r.candidates.find((c) => c.id === r.accepted) ?? null;
  const out: string[] = [];
  if (accepted) {
    out.push(`## ${commitTitle(accepted)}`, '');
    if (accepted.why.trim()) out.push(one(accepted.why, 600), '');
    out.push(`A change to the ${accepted.surface} in \`${accepted.file}\`:`, '', '```diff', `- ${one(accepted.before, 400)}`, `+ ${one(accepted.after, 400)}`, '```', '');
  } else {
    out.push(`## Not fixed${r.why ? `: ${one(r.why, 200)}` : ''}`, '');
  }

  out.push('### What failed', '', `A run passes when ${r.oracle.map((o) => one(o, 120)).join('; ')}.`, '');
  if (r.targets.length) {
    out.push('Each failing run was lost at the model call below: the last one whose answer, asked again, lets the run pass (`shadowlap blame`).', '');
    out.push('| Run | Lost at | What the agent did there | What a passing run did |', '|---|---|---|---|');
    for (const t of r.targets) {
      const at = t.outcome === 'blamed' && t.callNo !== null ? `model call #${t.callNo} (${t.step} of ${t.steps})` : t.outcome === 'unrescuable' ? 'not rescued from any model call' : t.outcome === 'passes' ? 'passes when replayed' : t.outcome;
      out.push(`| \`${short(t.runId)}\` | ${cell(at)} | ${cell(t.recorded ?? '')} | ${cell(t.rescued ? `${t.rescued}${t.rescuedBy ? ` (${t.rescuedBy})` : ''}` : '')} |`);
    }
  } else {
    // Found out before blame ran, as a repairer that can't sign in is.
    out.push(`No failing run was blamed${r.noRepairer ? `: ${one(r.noRepairer, 200)}` : ''}.`);
  }
  if (r.diagnosis) out.push('', `The repairer's diagnosis: ${one(r.diagnosis, 600)}`);
  out.push('');

  if (accepted?.verify) {
    const v = accepted.verify;
    out.push('### Evidence', '', `\`shadowlap verify\` replayed every run under the change: it ${verifiedLine(v)}.${r.holdout.length ? ' The held-out runs were never shown to the repairer.' : ''}`, '');
    out.push('| Role | Run | Outcome | Attempts |', '|---|---|---|---|');
    for (const x of v.runs) out.push(`| ${x.role === 'holdout' ? 'held-out' : x.role} | \`${short(x.runId)}\` | ${outcomeOf(x)} | ${x.deterministic ? 'clean replay' : `${x.passes} of ${x.attempts.length} passed`} |`);
    const d = footprintDelta(v.runs);
    if (d) out.push('', `Per run, as it would run live: ${Math.round(d.recorded.inputTokens).toLocaleString('en-US')} → ${Math.round(d.now.inputTokens).toLocaleString('en-US')} input tokens${d.recorded.cost !== null && d.now.cost !== null ? `, ≈${formatUsd(d.recorded.cost)} → ≈${formatUsd(d.now.cost)}` : ''}.`);
    if (r.uncommitted?.length) out.push('', `**${uncommittedNote(r.uncommitted)}**`);
    out.push('');
  }

  if (r.candidates.length > 1 || !accepted) {
    out.push('### Candidates', '', '| # | Change | Result |', '|---|---|---|');
    for (const c of r.candidates) out.push(`| ${c.id} | ${cell(`${c.surface}: ${c.after}`)} | ${c.state}${c.reason ? `: ${cell(c.reason)}` : ''} |`);
    out.push('');
  }

  const repairer = r.repairer ? `, the repairer (${r.repairer.served ?? r.repairer.model}) ${r.repairer.cost === null ? 'at no known price' : `≈${formatUsd(r.repairer.cost)}`}` : '';
  // The write policy the replays ran under, when the report kept it: an older report says nothing it can't know.
  const writes = r.writes === 'block' ? ' Writes were blocked in every replay.' : r.writes === 'stub' ? ' Writes were stubbed in every replay.' : '';
  out.push(`Cost: blame ≈${formatUsd(r.cost.blame)}${repairer}, verification ≈${formatUsd(r.cost.verify)}.${writes}`);
  return out.join('\n') + '\n';
}
