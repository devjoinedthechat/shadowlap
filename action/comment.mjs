// The pull request comment: one comment of the action's on the pull request, found again by a hidden
// marker and edited in place on every run, with one verdict line per golden, as docs/gating.md has
// every report say a verdict, beside how the golden did on the base branch the last time the test
// history saw it; then the decisions the branch changes, a run's cost before and after, each golden's
// injection gate, the fixes the job opened and where each failure is in full.
//
// Its words and its Markdown are the engine's packages/engine/src/pr-comment.ts, as plain
// JavaScript, since the action imports nothing but Node's own modules and its own files: the two are
// held to the same cases, so what Settings → CI previews and copies is what the action posts.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { askDecisions } from './decisions.mjs';
import { forkPullRequest } from './fix.mjs';
import { pullRequestOf, upsertComment } from './github.mjs';
import { markdownCode, markdownText } from './markdown.mjs';

/** @import { BaseSession, CommentDecision, CommentDecisionsSource, CommentParts, CommentResult, DecisionsAsk, DecisionView, Fetch, FixOutcome, GitHubAuth, InjectionGateData, Posted, ReportResult, StoredResult, StoredSession } from './types.mjs' */

/** How a result came out, whatever CI made of it; one from before results had a verdict reads as `ok` says. */
const commentVerdict = (/** @type {Pick<CommentResult, 'verdict' | 'ok'> | null | undefined} */ r) => r?.verdict ?? (r?.ok ? 'passed' : 'failed');
/** A golden's name in the comment: the golden as the test history names it, else its pack's. */
const nameOf = (/** @type {CommentResult} */ r) => String(r.golden ?? r.name ?? '');
/** @type {Record<string, string>} */
const MARK = { passed: '✅', failed: '❌', inconclusive: '🟡' };
/** A verdict's mark; none for one no report makes, as a stored history could hold, an object's own names among them. */
const markOf = (/** @type {string} */ verdict) => (Object.hasOwn(MARK, verdict) ? String(MARK[verdict]) : '');
/**
 * The decisions' marks as the comment's: ✗ a golden flagged, ! a change in reads or text only, ✓ the same.
 * @type {Record<string, string>}
 */
const DECISION_MARK = { '✗': '❌', '!': '🟡', '✓': '✅' };

/** The longest comment GitHub takes is 65,536 characters; the body stays well under it. */
const LONGEST = 60_000;
/** A call in the comment's Markdown: whole as any call is, cut only where one would outgrow the comment. */
const CALL_WIDTH = 1_000;
/** After the decisions' sentence in the comment: what it was asked of. */
export const PR_DECISIONS_SUFFIX = ', under the prompt and tools this pull request sends';
/** Under the decisions the comment lists: the short form of the line every decisions report carries. */
export const JUDGED_IN_RECORDED_STATE_SHORT = "Later steps are judged in the recorded run's state: shadowlap verify runs it end to end.";
/** The comment's last line: where each failure is in full, its first words (FOOT_LINKED) linked to the job's page. */
export const COMMENT_FOOT = "The job's summary has each failure in full.";
const FOOT_LINKED = "The job's summary";

/**
 * Text safe in a Markdown table cell, and anywhere else in the comment: one line, and nothing GitHub
 * renders, links or mentions in it (markdown.mjs). A verdict line carries what a check found in the
 * run, and the fix's title the repairer's words, either of which can be anyone's.
 * @param {unknown} s
 */
const cell = (s) => markdownText(String(s ?? '')).trim();
/** A golden's name, a branch or a revision as code: backticks in it can't end the span, nor, in a table's `cell`, a pipe the cell. */
const code = (/** @type {unknown} */ s, cell = false) => markdownCode(String(s ?? ''), { cell });

/**
 * The hidden line the action's comment is found by: one per workflow, job, working directory and set
 * of recordings, so two steps that test different goldens keep a comment each, and a step run again
 * edits its own.
 * @param {{ workflow?: string; job?: string; workdir?: string; recordings?: string }} [o]
 * @returns {string}
 */
export function commentMarker({ workflow = '', job = '', workdir = '', recordings = '' } = {}) {
  const key = createHash('sha256').update(JSON.stringify([workflow, job, workdir, recordings])).digest('hex').slice(0, 12);
  return `<!-- shadowlap-test-comment ${key} -->`;
}

/**
 * A result's checks by how they came out, as the job summary counts them: `3 checks passed`, `1 of 3 checks failed`.
 * @param {CommentResult['checks']} checks
 * @returns {string | null}
 */
function checksTally(checks) {
  if (!Array.isArray(checks) || !checks.length) return null;
  /** @type {Record<string, number>} */
  const n = { passed: 0, failed: 0, inconclusive: 0, 'not-applicable': 0 };
  for (const c of /** @type {ReadonlyArray<{ ok?: boolean; status?: string } | null>} */ (checks)) {
    const s = c?.status ?? (c?.ok ? 'passed' : 'failed');
    n[s] = (n[s] ?? 0) + 1;
  }
  const noun = (/** @type {number} */ k) => `check${k === 1 ? '' : 's'}`;
  /** @type {string[]} */
  const parts = [];
  if (n.failed) parts.push(`${n.failed} of ${checks.length} ${noun(checks.length)} failed`);
  else if (n.passed) parts.push(`${n.passed} ${noun(n.passed)} passed`);
  const add = (/** @type {number | undefined} */ k, /** @type {string} */ word) => k && parts.push(parts.length ? `${k} ${word}` : `${k} ${noun(k)} ${word}`);
  add(n.inconclusive, 'inconclusive');
  add(n['not-applicable'], 'not applicable');
  return parts.join(', ');
}

/**
 * A golden's verdict in one line, as docs/gating.md has every report say one: the verdict word first;
 * for a golden with a gate, its tally, Wilson bound and rule (the gate's own sentence); for one
 * without, how its replay went or why it failed. Never a claimed rate.
 * @param {CommentResult} r
 * @returns {string}
 */
export function commentVerdictLine(r) {
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

/**
 * The comment's heading, counting what passed as every tally on a page does: `2 of 7 goldens passed ·
 * 3 failed, 2 inconclusive`, or `7 of 7 goldens passed` (verdict-words.ts' sessionTally).
 * @param {readonly CommentResult[]} results
 * @returns {string}
 */
export function commentHead(results) {
  const of = (/** @type {string} */ v) => results.filter((r) => commentVerdict(r) === v).length;
  const passed = of('passed');
  const inconclusive = of('inconclusive');
  const failed = results.length - passed - inconclusive;
  const notPassed = [failed ? `${failed} failed` : '', inconclusive ? `${inconclusive} inconclusive` : ''].filter(Boolean).join(', ');
  return `${passed} of ${results.length} golden${results.length === 1 ? '' : 's'} passed${notPassed ? ` · ${notPassed}` : ''}`;
}

/** @type {Record<string, number>} */
const WORST_FIRST = { failed: 0, inconclusive: 1, passed: 2 };
/**
 * The results worst first: failed, then inconclusive, then passed, each in the session's order, so the rows a long comment drops are never failures.
 * @template {CommentResult} R
 * @param {readonly R[]} results
 * @returns {R[]}
 */
export function worstFirst(results) {
  const rank = (/** @type {R} */ r) => WORST_FIRST[commentVerdict(r)] ?? 0;
  return results.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

/**
 * An injection gate's attempts by what they did, with what the gate allows after each count it
 * limits: `6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored`, and
 * `· 2 inconclusive` with any.
 * @param {InjectionGateData} d
 * @returns {string}
 */
function injectionTally(d) {
  const influenced = d.allowed.influenced !== null ? ` (at most ${d.allowed.influenced} allowed)` : '';
  return `${d.attempts} attempt${d.attempts === 1 ? '' : 's'} · ${d.obeyed} obeyed (at most ${d.allowed.obeyed} allowed) · ${d.influenced} influenced${influenced} · ${d.ignored} ignored${d.inconclusive ? ` · ${d.inconclusive} inconclusive` : ''}`;
}

/**
 * Each golden's injection gate that ran, in the rows' order, its verdict first: a gate with no
 * attempts says its verdict alone (why is the golden's own line); one that didn't run has none.
 * @param {readonly CommentResult[]} results
 * @returns {Array<{ verdict: string; golden: string; line: string }>}
 */
function commentInjection(results) {
  return results.flatMap((r) => {
    const d = r.injection;
    if (!d || !d.verdict) return [];
    return [{ verdict: String(d.verdict), golden: nameOf(r), line: d.attempts ? `${d.verdict} · ${injectionTally(d)}` : d.verdict }];
  });
}

/**
 * An estimate in dollars, `≈$0.041`, and `<$0.001` as it is (prices.ts' aboutUsd).
 * @param {number} n
 * @returns {string}
 */
function aboutUsd(n) {
  const s = n === 0 ? '$0' : n < 0.001 ? '<$0.001' : n < 0.01 ? `$${n.toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString('en-US')}`;
  return s.startsWith('<') ? s : `≈${s}`;
}

/**
 * How far a cost moved, in words (decisions.ts' percentChange): `+5%`, `−50%`, `about the same`, `the same`, `new` (from nothing).
 * @param {number} a
 * @param {number} b
 * @returns {string}
 */
function percentChange(a, b) {
  if (a === 0) return b === 0 ? 'the same' : 'new';
  const n = Math.round((Math.abs(b - a) / a) * 100);
  return n === 0 ? 'about the same' : `${b >= a ? '+' : '−'}${n}%`;
}

/**
 * A run's cost before and after, as estimates: `≈$0.041 → ≈$0.043 (+5%)`; null without both sides.
 * @param {CommentParts['costPerRun']} cost
 * @returns {string | null}
 */
function costPerRunLine(cost) {
  if (!cost || typeof cost.before !== 'number' || typeof cost.after !== 'number') return null;
  return `${aboutUsd(cost.before)} → ${aboutUsd(cost.after)} (${percentChange(cost.before, cost.after)})`;
}

/** Control and format characters but tabs and line breaks, and line and paragraph separators: what text.ts' safeLine shows as escapes. */
const HIDDEN_EXCEPT_LAYOUT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Recorded text on one line, each hidden character, tab and line break shown as its escape (text.ts' safeLine).
 * @param {string} s
 * @returns {string}
 */
function safeLine(s) {
  const escape = (/** @type {string} */ ch) => {
    const point = /** @type {number} */ (ch.codePointAt(0));
    if (point <= 0xff) return `\\x${point.toString(16).padStart(2, '0')}`;
    return point <= 0xffff ? `\\u${point.toString(16).padStart(4, '0')}` : `\\u{${point.toString(16)}}`;
  };
  return s.replace(HIDDEN_EXCEPT_LAYOUT, escape).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/** @type {Record<DecisionView['stop'], string>} */
const STOP_WORDS = { tools: 'calls tools', answer: 'answers and stops', limit: 'is cut off at its output limit', refused: 'refuses', paused: 'pauses its turn', other: 'ends its turn' };

/**
 * A decision in one line, its tool calls or how it ended, each call's arguments cut at `width` (decisions.ts' decisionLine and callLine).
 * @param {DecisionView | null} d
 * @param {number} width
 * @returns {string}
 */
function decisionLine(d, width) {
  if (!d) return 'no answer';
  const call = (/** @type {string} */ name, /** @type {unknown} */ args, /** @type {number} */ w) => {
    const json = args === null || args === undefined ? '' : JSON.stringify(args);
    const shown = json.length > w ? `${json.slice(0, w - 1)}…` : json;
    return safeLine(`${name}(${shown === '{}' ? '' : shown})`);
  };
  if (d.tools.length) return d.tools.map((t) => call(t.name, t.args, Math.max(24, Math.floor(width / d.tools.length)))).join(' + ');
  const said = d.text ? `: "${safeLine(d.text.length > width ? `${d.text.slice(0, width - 1)}…` : d.text)}"` : '';
  return `${STOP_WORDS[d.stop]}${said}`;
}

/**
 * What the flagged goldens do, for the headline: decide a write or when to stop differently, are
 * judged otherwise (a judge check comes out otherwise for what a text-only step says), or both.
 * @param {CommentDecisionsSource} r
 * @returns {string}
 */
function flaggedFor(r) {
  const flagging = r.runs.filter((x) => r.flagged.includes(x.runId)).flatMap((x) => x.decisions.filter((s) => s.majority !== null && s.majority <= 2));
  const judged = flagging.some((s) => s.changes.some((c) => c.kind === 'judge'));
  const acted = flagging.some((s) => s.changes.some((c) => c.rank <= 2 && c.kind !== 'judge')) || !judged;
  const one = r.flagged.length === 1;
  const otherwise = `${one ? 'is' : 'are'} judged otherwise`;
  return acted ? `decide${one ? 's' : ''} a write or when to stop differently${judged ? `, or ${otherwise}` : ''}` : otherwise;
}

/**
 * The decisions' headline counted in goldens, its mark and its sentence: decisions.ts'
 * decisionsHeadline with the unit golden, its lead and rest.
 * @param {CommentDecisionsSource} r
 * @returns {{ mark: string; sentence: string }}
 */
function decisionsHeadline(r) {
  const changed = r.counts[1] + r.counts[2] + r.counts[3] + r.counts[4] + r.counts[5];
  const refused = r.runs.filter((x) => x.refused).length;
  const of = `${r.runs.length} golden${r.runs.length === 1 ? '' : 's'}`;
  if (changed + r.counts.same === 0) {
    if (refused) return { mark: '!', sentence: `${refused} of ${of} could not be asked` };
    return r.counts.notAsked ? { mark: '!', sentence: 'No step was answered' } : { mark: '✓', sentence: 'Nothing to ask' };
  }
  if (r.flagged.length) return { mark: '✗', sentence: `${r.flagged.length} of ${of} ${flaggedFor(r)}` };
  if (changed) return { mark: '!', sentence: 'No write and no stop changes' };
  return { mark: refused ? '!' : '✓', sentence: 'The same decisions at every step asked' };
}

/**
 * The decisions the branch changes: the headline, and each rank 1 and 2 step of the goldens it flags,
 * in the report's order, the most consequential first.
 * @param {CommentDecisionsSource} r
 * @returns {{ mark: string; sentence: string; rows: CommentDecision[] }}
 */
function commentDecisions(r) {
  const flagged = new Set(r.flagged);
  const rows = r.runs
    .filter((run) => flagged.has(run.runId))
    .flatMap((run) =>
      run.decisions
        .filter((s) => s.majority !== null && s.majority <= 2)
        .map((s) => {
          const acted = s.changes.filter((c) => c.rank <= 2);
          return { rank: Number(s.majority), golden: run.golden ?? run.runId, callNo: s.callNo, detail: (acted.length ? acted : s.changes).map((c) => c.detail).join('; '), recorded: decisionLine(s.recorded, CALL_WIDTH), now: decisionLine(s.now, CALL_WIDTH) };
        }),
    );
  return { ...decisionsHeadline(r), rows };
}

/**
 * The decisions part as the comment's Markdown: its heading, its sentence, each step with its recorded and new decision, and the note.
 * @param {CommentDecisionsSource | null | undefined} source
 * @returns {string[]}
 */
function decisionsMarkdown(source) {
  if (!source || !Array.isArray(source.runs) || !source.counts) return [];
  const d = commentDecisions(source);
  const lines = ['', '#### Decisions', '', `${DECISION_MARK[d.mark] ?? ''} ${d.sentence}${PR_DECISIONS_SUFFIX}`];
  if (!d.rows.length) return lines;
  lines.push('');
  for (const x of d.rows) lines.push(`- rank ${x.rank} · ${code(x.golden)} #${x.callNo} · ${cell(x.detail)}`, `  - recorded ${code(x.recorded)}`, `  - now ${code(x.now)}`);
  return [...lines, '', JUDGED_IN_RECORDED_STATE_SHORT];
}

/**
 * The parts after the table: the cost per run, each injection gate's line, the fixes opened, and where each failure is in full.
 * @param {CommentParts} parts
 * @param {readonly CommentResult[]} rows
 * @returns {string[]}
 */
function tailMarkdown(parts, rows) {
  /** @type {string[]} */
  const lines = [];
  const cost = costPerRunLine(parts.costPerRun);
  if (cost) lines.push('', `Cost per run: ${cost}`);
  const injection = commentInjection(rows);
  if (injection.length) lines.push('', '#### Injection', '', ...injection.map((x) => `${markOf(x.verdict)} ${code(x.golden)} · ${cell(x.line)}`));
  const opened = (parts.fixes ?? []).filter((f) => f.outcome === 'opened' && f.pr);
  if (opened.length) lines.push('', ...opened.map((f) => `Fix on failure opened ${String(f.pr)} for ${String(f.golden ?? f.name).split(', ').map((g) => code(g)).join(', ')}: ${cell(f.title ?? 'a fix')}.`));
  if (parts.runUrl) lines.push('', `[${FOOT_LINKED}](${parts.runUrl})${COMMENT_FOOT.slice(FOOT_LINKED.length)}`);
  return lines;
}

/** A stored result's verdict, as the test history keeps it (its data's verdict, else ok). */
const storedVerdict = (/** @type {{ ok?: boolean; data?: { verdict?: unknown } | null }} */ r) => String(r.data?.verdict ?? (r.ok ? 'passed' : 'failed'));

/**
 * The base branch's last session in the test history, or null when the history has none: the newest
 * finished session, other than `current`, whose results name the base branch (`data.branch`), else
 * whose revision is the base branch's commit the pull request names. A session of a dirty tree is no
 * commit's.
 * @param {StoredSession[] | null} history
 * @param {{ baseRef: string | null; baseSha: string | null; current: string | null }} o
 * @returns {BaseSession | null}
 */
export function baseSession(history, { baseRef, baseSha, current }) {
  const sessions = (Array.isArray(history) ? history : []).filter((s) => s && s.sessionId !== current && s.endedAt !== null && Array.isArray(s.results) && s.results.length);
  const pick = (/** @type {StoredSession | null | undefined} */ s) => (s ? { sessionId: s.sessionId, revision: s.revision ?? null, startedAt: s.startedAt, results: new Map(s.results.map((r) => [r.golden, r])) } : null);
  const byBranch = baseRef ? sessions.find((s) => s.results.some((r) => r?.data?.branch === baseRef)) : null;
  if (byBranch) return pick(byBranch);
  const byCommit = baseSha ? sessions.find((s) => typeof s.revision === 'string' && !s.revision.includes('+') && s.revision.length >= 7 && baseSha.startsWith(s.revision)) : null;
  return pick(byCommit);
}

/**
 * The store's test history, newest session first, each with its goldens' results, read as SQL from
 * the store's own tables and changing nothing; null when there is no store or it can't be read.
 * @param {string | null} path
 * @param {number} [limit]
 * @returns {StoredSession[] | null}
 */
export function readHistory(path, limit = 100) {
  if (!path || path === ':memory:' || !existsSync(path)) return null;
  // node:sqlite says it is experimental when it loads; that one warning is left out, as the CLI does.
  const emit = process.emitWarning;
  process.emitWarning = (/** @type {string | Error} */ warning, /** @type {unknown[]} */ ...rest) => {
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (typeof message === 'string' && message.includes('SQLite is an experimental feature')) return;
    Reflect.apply(emit, process, [warning, ...rest]);
  };
  let db = null;
  try {
    const { DatabaseSync } = /** @type {typeof import('node:sqlite')} */ (createRequire(import.meta.url)('node:sqlite'));
    db = new DatabaseSync(path);
    const results = db.prepare('SELECT golden, ok, failure, reason, data FROM test_results WHERE session_id = ?');
    return db
      .prepare('SELECT session_id, started_at, ended_at, revision FROM test_sessions ORDER BY started_at DESC, session_id DESC LIMIT ?')
      .all(limit)
      .map((s) => ({
        sessionId: String(s.session_id),
        startedAt: Number(s.started_at),
        endedAt: s.ended_at === null ? null : Number(s.ended_at),
        revision: s.revision === null ? null : String(s.revision),
        results: results.all(/** @type {import('node:sqlite').SQLInputValue} */ (s.session_id)).map((r) => {
          /** @type {Record<string, unknown> | null} */
          let data = null;
          try {
            data = r.data === null ? null : JSON.parse(String(r.data));
          } catch {
            // a result whose data can't be read keeps its verdict
          }
          return { golden: String(r.golden), ok: !!r.ok, failure: /** @type {string | null} */ (r.failure ?? null), reason: /** @type {string | null} */ (r.reason ?? null), data };
        }),
      }));
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // closed
    }
    process.emitWarning = emit;
  }
}

/**
 * The comment's Markdown (pr-comment.ts' commentMarkdown): the marker (when given), the heading, the
 * table with each golden's verdict line, worst first, and how each did on the base branch when there
 * is its last session; then the decisions, the cost per run, the injection gates, the fixes and the
 * job summary's line, each when there is one. Within `longest`: the rows that fit, and how many more
 * the job summary lists.
 * @param {CommentParts} parts
 * @returns {string}
 */
export function commentMarkdown(parts) {
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
  const more = (/** @type {number} */ n) => (n < rows.length ? [`| | … | ${rows.length - n} more in the job summary |${base ? ' |' : ''}`] : []);
  const body = (/** @type {number} */ n) => [...top, ...rows.slice(0, n), ...more(n), ...tail].join('\n');
  const longest = parts.longest ?? LONGEST;
  let shown = rows.length;
  while (shown > 0 && body(shown).length > longest) shown--;
  return `${body(shown)}\n`;
}

/**
 * The comment on a test report: its results and its cost per run, under the marker, beside the base
 * branch's last session, with the decisions part, the fixes opened and the job's page when given.
 * @param {{ report: { session?: string | null; results: ReportResult[]; costPerRun?: CommentParts['costPerRun'] }; marker: string; base?: BaseSession | null; baseRef?: string | null; decisions?: CommentDecisionsSource | null; fixes?: FixOutcome[]; runUrl?: string | null; longest?: number }} o
 * @returns {string}
 */
export function commentBody({ report, marker, base = null, baseRef = null, decisions = null, fixes = [], runUrl = null, longest = LONGEST }) {
  const results = Array.isArray(report?.results) ? report.results : [];
  return commentMarkdown({ marker, results, base, baseRef, decisions, costPerRun: report?.costPerRun ?? null, fixes: Array.isArray(fixes) ? fixes.filter(Boolean) : [], runUrl, longest });
}

/**
 * Keeps the comment on the pull request this job runs for, and says how it went: `{ state, url, why }`,
 * state `created` or `updated`, `skipped` (a pull request from a fork, whose token may not comment;
 * no token), `denied` (the token may not comment), `failed`, or `none` (no pull request). With
 * `decisions` (the decisions input), it first asks `shadowlap decisions --from-code` for the comment's
 * Decisions part (decisions.mjs), only for a pull request it can comment on. It never fails the job:
 * what didn't go is said in the job summary.
 * @param {{ env: NodeJS.ProcessEnv; auth: GitHubAuth | null | undefined; report: { session?: string | null; results: ReportResult[]; costPerRun?: CommentParts['costPerRun'] }; fixes?: FixOutcome[]; decisions?: DecisionsAsk | null; store: string | null; recordings: string; workdir: string; fetch?: Fetch; read?: (path: string) => string }} o
 * @returns {Promise<Posted>}
 */
export async function postComment({ env, auth, report, fixes = [], decisions = null, store, recordings, workdir, fetch: fetchFn = globalThis.fetch, read }) {
  const pr = pullRequestOf(env, read);
  if (!pr) return { state: 'none', url: null, why: null };
  if (forkPullRequest(env, read)) return { state: 'skipped', url: null, why: 'a pull request from a fork gets a token from GitHub that may not comment on it' };
  if (!auth?.token) return { state: 'skipped', url: null, why: 'the job has no token to comment with' };
  const base = baseSession(readHistory(store), { baseRef: pr.baseRef, baseSha: pr.baseSha, current: report.session ?? null });
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const marker = commentMarker({ workflow: env.GITHUB_WORKFLOW ?? '', job: env.GITHUB_JOB ?? '', workdir, recordings });
  const asked = decisions && report.session ? askDecisions(decisions, report.session) : null;
  const body = commentBody({ report, marker, base, baseRef: pr.baseRef, decisions: asked, fixes, runUrl });
  return upsertComment({ env, auth, number: pr.number, marker, body, fetch: fetchFn });
}

/**
 * What the job summary says about the comment when it didn't go up; nothing when it did, or there was no pull request.
 * @param {Posted | null} posted
 * @returns {string}
 */
export function commentNote(posted) {
  if (!posted || posted.state === 'created' || posted.state === 'updated' || posted.state === 'none') return '';
  return `\nThe pull request comment was not posted: ${markdownText(String(posted.why ?? ''))}.\n`;
}
