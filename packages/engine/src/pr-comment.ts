import { decisionLine, decisionsHeadline, percentChange, type DecisionRun, type DecisionsReport } from './decisions.js';
import { markdownCode, markdownText } from './markdown.js';
import { aboutUsd } from './prices.js';
import type { InjectionGateData } from './store/tests.js';
import { sessionTally } from './verdict-words.js';
import { plural } from './words.js';

/**
 * The pull request comment the GitHub Action keeps on a pull request, in words and as the Markdown it
 * posts: a heading that counts what passed, a table with each golden's verdict line (worst first) and,
 * with the test history's last session on the base branch, how each did there; then the decisions the
 * branch changes at rank 1 and 2 (when the job asked `decisions --from-code`), a run's cost before and
 * after, each golden's injection gate, the fix pull requests the job opened, and where the details are.
 *
 * Settings → CI previews it from the store with the same words, so Copy Markdown copies what the
 * Action posts. action/comment.mjs is this module as plain JavaScript, since the Action imports
 * nothing but Node's own modules and its own files; the two are held to the same cases. No DOM, no Node.
 */

/** A golden's result as the comment reads it: the JSON report's (the Action's) or the store's (the dashboard's). */
export interface CommentResult {
  /** The pack directory's name, when `golden` is missing (a report made before results named their golden). */
  name?: string;
  /** The golden as the test history names it. */
  golden?: string;
  /** Whether CI let it through: how it came out, for a result made before results had a verdict. */
  ok?: boolean;
  verdict?: string | null;
  /** One line: why it failed. */
  message?: string | null;
  gate?: { sentence?: unknown } | null;
  updated?: unknown;
  divergence?: { type: string; callNo: number } | null;
  attempts?: { total: number; passed: number } | null;
  checks?: ReadonlyArray<{ ok?: boolean; status?: string }> | null;
  injection?: InjectionGateData | null;
}

/** The test history's last session on the base branch: its revision, and each golden's result there. */
export interface CommentBase {
  revision: string | null;
  results: ReadonlyMap<string, { ok?: boolean; data?: { verdict?: unknown } | null }>;
}

/** A fix pull request the job opened (the Action's fix on failure). */
export interface CommentFix {
  name?: string;
  golden?: string | null;
  outcome: string;
  pr?: string | null;
  title?: string | null;
}

/** What the decisions part reads of a `decisions --from-code` report: its counts, the runs it flags, and its runs. */
export type CommentDecisionsSource = Pick<DecisionsReport, 'counts' | 'flagged'> & { runs: ReadonlyArray<Pick<DecisionRun, 'runId' | 'golden' | 'refused' | 'decisions'>> };

/** The parts of one comment. Without a marker, a base, fixes or a job's address, it is the preview's. */
export interface CommentParts {
  /** The hidden line the Action finds its comment by; none in a preview. */
  marker?: string | null;
  results: readonly CommentResult[];
  base?: CommentBase | null;
  baseRef?: string | null;
  decisions?: CommentDecisionsSource | null;
  costPerRun?: { before: number | null; after: number | null } | null;
  fixes?: readonly CommentFix[];
  /** The job's page, whose summary has each failure in full. */
  runUrl?: string | null;
  /** The longest the body may be: GitHub takes 65,536 characters, and the body stays well under it. */
  longest?: number;
}

/** After the decisions' sentence in the comment: what it was asked of. */
export const PR_DECISIONS_SUFFIX = ', under the prompt and tools this pull request sends';

/**
 * Under the decisions the comment and a revision's page list: the short form of the line every
 * decisions report carries (JUDGED_IN_RECORDED_STATE), its first clause and its last sentence.
 */
export const JUDGED_IN_RECORDED_STATE_SHORT = "Later steps are judged in the recorded run's state: shadowlap verify runs it end to end.";

/** The longest comment GitHub takes is 65,536 characters; the body stays well under it. */
const LONGEST = 60_000;
/** A call in the comment's Markdown: whole as any call is, cut only where one would outgrow the comment. */
const CALL_WIDTH = 1_000;

const MARK: Record<string, string> = { passed: '✅', failed: '❌', inconclusive: '🟡' };
/** A verdict's mark; none for one no report makes, as a stored history could hold, an object's own names among them. */
const markOf = (verdict: string): string => (Object.hasOwn(MARK, verdict) ? String(MARK[verdict]) : '');
/** The decisions' marks as the comment's: ✗ a run flagged, ! a change in reads or text only, ✓ the same. */
const DECISION_MARK: Record<string, string> = { '✗': '❌', '!': '🟡', '✓': '✅' };

/** Text safe in a Markdown table cell, and anywhere else in the comment: a verdict line carries what a check found in the run, anyone's words. */
const cell = (s: unknown): string => markdownText(String(s ?? '')).trim();
/** A golden's name, a branch, a revision or a call as code: backticks in it can't end the span, nor, in a table's `cell`, a pipe the cell. */
const code = (s: unknown, inCell = false): string => markdownCode(String(s ?? ''), { cell: inCell });

/** How a result came out, whatever CI made of it; one from before results had a verdict reads as `ok` says. */
export const commentVerdict = (r: Pick<CommentResult, 'verdict' | 'ok'> | null | undefined): string => r?.verdict ?? (r?.ok ? 'passed' : 'failed');
/** A golden's name in the comment: the golden as the test history names it, else its pack's. */
const nameOf = (r: CommentResult): string => String(r.golden ?? r.name ?? '');

/** A result's checks by how they came out, as the job summary counts them: `3 checks passed`, `1 of 3 checks failed`. */
function checksTally(checks: CommentResult['checks']): string | null {
  if (!Array.isArray(checks) || !checks.length) return null;
  const n: Record<string, number> = { passed: 0, failed: 0, inconclusive: 0, 'not-applicable': 0 };
  for (const c of checks as ReadonlyArray<{ ok?: boolean; status?: string } | null>) {
    const s = c?.status ?? (c?.ok ? 'passed' : 'failed');
    n[s] = (n[s] ?? 0) + 1;
  }
  const noun = (k: number) => `check${k === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (n.failed) parts.push(`${n.failed} of ${checks.length} ${noun(checks.length)} failed`);
  else if (n.passed) parts.push(`${n.passed} ${noun(n.passed)} passed`);
  const add = (k: number | undefined, word: string) => k && parts.push(parts.length ? `${k} ${word}` : `${k} ${noun(k)} ${word}`);
  add(n.inconclusive, 'inconclusive');
  add(n['not-applicable'], 'not applicable');
  return parts.join(', ');
}

/**
 * A golden's verdict in one line, as docs/gating.md has every report say one: the verdict word first;
 * for a golden with a gate, its tally, Wilson bound and rule (the gate's own sentence); for one
 * without, how its replay went or why it failed. Never a claimed rate.
 */
export function commentVerdictLine(r: CommentResult): string {
  const v = commentVerdict(r);
  if (r.gate && typeof r.gate.sentence === 'string') return v === 'passed' ? r.gate.sentence : (r.message ?? r.gate.sentence);
  if (v === 'passed') {
    const how = r.updated ? 'updated' : r.divergence ? `${r.divergence.type === 'ended_early' ? 'ended early' : 'forked'} at call ${r.divergence.callNo}` : 'replayed clean';
    const attempts = r.attempts && r.attempts.total > 1 ? `${r.attempts.passed} of ${r.attempts.total} attempts` : null;
    return ['passed', how, checksTally(r.checks), attempts].filter(Boolean).join(' · ');
  }
  const why = r.message ?? (v === 'inconclusive' ? 'neither passed nor failed' : 'failed');
  return why.startsWith(`${v} `) ? why : `${v} · ${why}`;
}

/** The comment's heading, counting what passed as every tally on a page does: `2 of 7 goldens passed · 3 failed, 2 inconclusive`. */
export function commentHead(results: readonly CommentResult[]): string {
  const of = (v: string) => results.filter((r) => commentVerdict(r) === v).length;
  const failed = results.length - of('passed') - of('inconclusive');
  return sessionTally(of('passed'), failed, of('inconclusive'));
}

const WORST_FIRST: Record<string, number> = { failed: 0, inconclusive: 1, passed: 2 };
/** The results worst first: failed, then inconclusive, then passed, each in the session's order, so the rows a long comment drops are never failures. */
export function worstFirst<R extends CommentResult>(results: readonly R[]): R[] {
  const rank = (r: R) => WORST_FIRST[commentVerdict(r)] ?? 0;
  return results.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

/** Each golden's row, worst first: its verdict, its name and its verdict line. */
export function commentRows(results: readonly CommentResult[]): Array<{ verdict: string; golden: string; line: string }> {
  return worstFirst(results).map((r) => ({ verdict: commentVerdict(r), golden: nameOf(r), line: commentVerdictLine(r) }));
}

/**
 * An injection gate's attempts by what they did: `6 attempts · 0 obeyed · 0 influenced · 6 ignored`,
 * and `· 2 inconclusive` with any. With `limits`, what the gate allows after each count it limits:
 * `0 obeyed (at most 0 allowed)`, and influenced's when it has one.
 */
export function injectionTally(d: Pick<InjectionGateData, 'attempts' | 'obeyed' | 'influenced' | 'ignored' | 'inconclusive' | 'allowed'>, limits = false): string {
  const obeyed = limits ? ` (at most ${d.allowed.obeyed} allowed)` : '';
  const influenced = limits && d.allowed.influenced !== null ? ` (at most ${d.allowed.influenced} allowed)` : '';
  return `${plural(d.attempts, 'attempt')} · ${d.obeyed} obeyed${obeyed} · ${d.influenced} influenced${influenced} · ${d.ignored} ignored${d.inconclusive ? ` · ${d.inconclusive} inconclusive` : ''}`;
}

/**
 * A golden's injection gate in one line, its verdict first: `passed · 6 attempts · 0 obeyed (at most
 * 0 allowed) · 0 influenced · 6 ignored`. A gate with no attempts says its verdict alone (why is the
 * golden's own line); one that didn't run (the golden failed, or is inconclusive, first) has none.
 */
export function injectionGateLine(d: InjectionGateData | null | undefined): string | null {
  if (!d || !d.verdict) return null;
  return d.attempts ? `${d.verdict} · ${injectionTally(d, true)}` : d.verdict;
}

/** Each golden's injection gate that ran, in the rows' order: its verdict, its name, the result kept for it, its line, and the line after its verdict (null with no attempts). */
export function commentInjection(results: readonly CommentResult[]): Array<{ verdict: string; golden: string; resultId: string | null; line: string; tally: string | null }> {
  return worstFirst(results).flatMap((r) => {
    const line = injectionGateLine(r.injection);
    return line && r.injection ? [{ verdict: String(r.injection.verdict), golden: nameOf(r), resultId: r.injection.resultId ?? null, line, tally: r.injection.attempts ? injectionTally(r.injection, true) : null }] : [];
  });
}

/** A run's cost before and after, as estimates: `≈$0.041 → ≈$0.043 (+5%)`; null without both sides. */
export function costPerRunLine(cost: { before: number | null; after: number | null } | null | undefined): string | null {
  if (!cost || typeof cost.before !== 'number' || typeof cost.after !== 'number') return null;
  return `${aboutUsd(cost.before)} → ${aboutUsd(cost.after)} (${percentChange(cost.before, cost.after)})`;
}

/** One step a flagged golden decides differently at rank 1 or 2: its golden, its call, what changed, and the recorded and the new decision. */
export interface CommentDecision {
  rank: number;
  golden: string;
  callNo: number;
  detail: string;
  recorded: string;
  now: string;
}

/**
 * The decisions the branch changes: the headline's mark and sentence (decisionsHeadline, counted in
 * goldens), and each rank 1 and 2 step of the goldens it flags, in the report's order, the most
 * consequential first. The comment says the sentence with PR_DECISIONS_SUFFIX after it, and
 * JUDGED_IN_RECORDED_STATE_SHORT under the steps.
 */
export function commentDecisions(r: CommentDecisionsSource, width = CALL_WIDTH): { mark: '✗' | '!' | '✓'; sentence: string; rows: CommentDecision[] } {
  const h = decisionsHeadline(r, 'golden');
  const flagged = new Set(r.flagged);
  const rows = r.runs
    .filter((run) => flagged.has(run.runId))
    .flatMap((run) =>
      run.decisions
        .filter((s) => s.majority !== null && s.majority <= 2)
        .map((s) => {
          const acted = s.changes.filter((c) => c.rank <= 2);
          return { rank: s.majority!, golden: run.golden ?? run.runId, callNo: s.callNo, detail: (acted.length ? acted : s.changes).map((c) => c.detail).join('; '), recorded: decisionLine(s.recorded, width), now: decisionLine(s.now, width) };
        }),
    );
  return { mark: h.mark, sentence: `${h.lead}${h.rest}`, rows };
}

/** The decisions part as the comment's Markdown: its heading, its sentence, each step with its recorded and new decision, and the note. */
function decisionsMarkdown(source: CommentDecisionsSource | null | undefined): string[] {
  if (!source || !Array.isArray(source.runs) || !source.counts) return [];
  const d = commentDecisions(source);
  const lines = ['', '#### Decisions', '', `${DECISION_MARK[d.mark] ?? ''} ${d.sentence}${PR_DECISIONS_SUFFIX}`];
  if (!d.rows.length) return lines;
  lines.push('');
  for (const x of d.rows) lines.push(`- rank ${x.rank} · ${code(x.golden)} #${x.callNo} · ${cell(x.detail)}`, `  - recorded ${code(x.recorded)}`, `  - now ${code(x.now)}`);
  return [...lines, '', JUDGED_IN_RECORDED_STATE_SHORT];
}

/** The parts after the table: the cost per run, each injection gate's line, the fixes opened, and where each failure is in full. */
function tailMarkdown(parts: CommentParts, rows: readonly CommentResult[]): string[] {
  const lines: string[] = [];
  const cost = costPerRunLine(parts.costPerRun);
  if (cost) lines.push('', `Cost per run: ${cost}`);
  const injection = commentInjection(rows);
  if (injection.length) lines.push('', '#### Injection', '', ...injection.map((x) => `${markOf(x.verdict)} ${code(x.golden)} · ${cell(x.line)}`));
  const opened = (parts.fixes ?? []).filter((f) => f.outcome === 'opened' && f.pr);
  if (opened.length) lines.push('', ...opened.map((f) => `Fix on failure opened ${String(f.pr)} for ${String(f.golden ?? f.name).split(', ').map((g) => code(g)).join(', ')}: ${cell(f.title ?? 'a fix')}.`));
  if (parts.runUrl) lines.push('', `[The job's summary](${parts.runUrl}) has each failure in full.`);
  return lines;
}

/** A stored result's verdict, as the test history keeps it (its data's verdict, else ok). */
const storedVerdict = (r: { ok?: boolean; data?: { verdict?: unknown } | null }): string => String(r.data?.verdict ?? (r.ok ? 'passed' : 'failed'));

/**
 * The comment's Markdown: the marker (when given), the heading, the table with each golden's verdict
 * line, worst first, and how each did on the base branch when there is its last session; then the
 * decisions, the cost per run, the injection gates, the fixes and the job summary's line, each when
 * there is one. Within `longest`: the rows that fit, and how many more the job summary lists.
 */
export function commentMarkdown(parts: CommentParts): string {
  const results = worstFirst(parts.results);
  const base = parts.base ?? null;
  const where = base ? `On ${code(parts.baseRef ?? 'the base branch', true)}` : null;
  const top = [...(parts.marker ? [parts.marker] : []), `### Shadowlap: ${commentHead(results)}`, '', where ? `| | Golden | Verdict | ${where} |` : '| | Golden | Verdict |', where ? '|---|---|---|---|' : '|---|---|---|'];
  const rows = results.map((r) => {
    const row = `| ${markOf(commentVerdict(r))} | ${code(nameOf(r), true)} | ${cell(commentVerdictLine(r))} |`;
    if (!base) return row;
    // What the stored history says is text, as every other line is: it comes from a cache a job restored.
    const was = base.results.get(nameOf(r));
    return `${row} ${was ? `${markOf(storedVerdict(was))} ${cell(storedVerdict(was))}` : 'not tested'} |`;
  });
  const compared = base ? ['', `Compared with ${code(parts.baseRef ?? 'the base branch')} as the test history last tested it${base.revision ? `, at ${code(base.revision)}` : ''}.`] : [];
  const tail = [...compared, ...decisionsMarkdown(parts.decisions), ...tailMarkdown(parts, results)];
  const more = (n: number) => (n < rows.length ? [`| | … | ${rows.length - n} more in the job summary |${base ? ' |' : ''}`] : []);
  const body = (n: number) => [...top, ...rows.slice(0, n), ...more(n), ...tail].join('\n');
  const longest = parts.longest ?? LONGEST;
  let shown = rows.length;
  while (shown > 0 && body(shown).length > longest) shown--;
  return `${body(shown)}\n`;
}
