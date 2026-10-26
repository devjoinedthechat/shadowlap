// The pull request comment: one comment of the action's on the pull request, found again by a hidden
// marker and edited in place on every run, with one verdict line per golden, as docs/gating.md has
// every report say a verdict, beside how the golden did on the base branch the last time the test
// history saw it.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { forkPullRequest } from './fix.mjs';
import { pullRequestOf, upsertComment } from './github.mjs';
import { markdownCode, markdownText } from './markdown.mjs';

/** How a result came out, whatever CI made of it; one from before results had a verdict reads as `ok` says. */
const verdictOf = (r) => r?.verdict ?? (r?.ok ? 'passed' : 'failed');
const MARK = { passed: '✅', failed: '❌', inconclusive: '🟡' };

/**
 * Text safe in a Markdown table cell, and anywhere else in the comment: one line, and nothing GitHub
 * renders, links or mentions in it (markdown.mjs). A verdict line carries what a check found in the
 * run, and the fix's title the repairer's words, either of which can be anyone's.
 */
const cell = (s) => markdownText(String(s ?? '')).trim();
/** A golden's name, a branch or a revision as code: backticks in it can't end the span, nor, in a table's `cell`, a pipe the cell. */
const code = (s, cell = false) => markdownCode(String(s ?? ''), { cell });

/**
 * The hidden line the action's comment is found by: one per workflow, job, working directory and set
 * of recordings, so two steps that test different goldens keep a comment each, and a step run again
 * edits its own.
 */
export function commentMarker({ workflow = '', job = '', workdir = '', recordings = '' } = {}) {
  const key = createHash('sha256').update(JSON.stringify([workflow, job, workdir, recordings])).digest('hex').slice(0, 12);
  return `<!-- shadowlap-test-comment ${key} -->`;
}

/** A result's checks by how they came out, as the job summary counts them: `3 checks passed`, `1 of 3 checks failed`. */
function checksTally(checks) {
  if (!Array.isArray(checks) || !checks.length) return null;
  const n = { passed: 0, failed: 0, inconclusive: 0, 'not-applicable': 0 };
  for (const c of checks) {
    const s = c?.status ?? (c?.ok ? 'passed' : 'failed');
    n[s] = (n[s] ?? 0) + 1;
  }
  const noun = (k) => `check${k === 1 ? '' : 's'}`;
  const parts = [];
  if (n.failed) parts.push(`${n.failed} of ${checks.length} ${noun(checks.length)} failed`);
  else if (n.passed) parts.push(`${n.passed} ${noun(n.passed)} passed`);
  const add = (k, word) => k && parts.push(parts.length ? `${k} ${word}` : `${k} ${noun(k)} ${word}`);
  add(n.inconclusive, 'inconclusive');
  add(n['not-applicable'], 'not applicable');
  return parts.join(', ');
}

/**
 * A golden's verdict in one line, as docs/gating.md has every report say one: the verdict word first;
 * for a golden with a gate, its tally, Wilson bound and rule (the gate's own sentence); for one
 * without, how its replay went or why it failed. Never a claimed rate.
 */
export function verdictLine(r) {
  const v = verdictOf(r);
  if (r.gate && typeof r.gate.sentence === 'string') return v === 'passed' ? r.gate.sentence : (r.message ?? r.gate.sentence);
  if (v === 'passed') {
    const how = r.updated ? 'updated' : r.divergence ? `${r.divergence.type === 'ended_early' ? 'ended early' : 'forked'} at call ${r.divergence.callNo}` : 'replayed clean';
    const attempts = r.attempts && r.attempts.total > 1 ? `${r.attempts.passed} of ${r.attempts.total} attempts` : null;
    return ['passed', how, checksTally(r.checks), attempts].filter(Boolean).join(' · ');
  }
  const why = r.message ?? (v === 'inconclusive' ? 'neither passed nor failed' : 'failed');
  return why.startsWith(`${v} `) ? why : `${v} · ${why}`;
}

/** A stored result's verdict, as the test history keeps it (its data's verdict, else ok). */
const storedVerdict = (r) => r?.data?.verdict ?? (r?.ok ? 'passed' : 'failed');

/**
 * The base branch's last session in the test history, or null when the history has none: the newest
 * finished session, other than `current`, whose results name the base branch (`data.branch`), else
 * whose revision is the base branch's commit the pull request names. A session of a dirty tree is no
 * commit's.
 */
export function baseSession(history, { baseRef, baseSha, current }) {
  const sessions = (Array.isArray(history) ? history : []).filter((s) => s && s.sessionId !== current && s.endedAt !== null && Array.isArray(s.results) && s.results.length);
  const pick = (s) => (s ? { sessionId: s.sessionId, revision: s.revision ?? null, startedAt: s.startedAt, results: new Map(s.results.map((r) => [r.golden, r])) } : null);
  const byBranch = baseRef ? sessions.find((s) => s.results.some((r) => r?.data?.branch === baseRef)) : null;
  if (byBranch) return pick(byBranch);
  const byCommit = baseSha ? sessions.find((s) => typeof s.revision === 'string' && !s.revision.includes('+') && s.revision.length >= 7 && baseSha.startsWith(s.revision)) : null;
  return pick(byCommit);
}

/**
 * The store's test history, newest session first, each with its goldens' results, read as SQL from
 * the store's own tables and changing nothing; null when there is no store or it can't be read.
 */
export function readHistory(path, limit = 100) {
  if (!path || path === ':memory:' || !existsSync(path)) return null;
  // node:sqlite says it is experimental when it loads; that one warning is left out, as the CLI does.
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (typeof message === 'string' && message.includes('SQLite is an experimental feature')) return;
    return emit.call(process, warning, ...rest);
  };
  let db = null;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
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
        results: results.all(s.session_id).map((r) => {
          let data = null;
          try {
            data = r.data === null ? null : JSON.parse(String(r.data));
          } catch {
            // a result whose data can't be read keeps its verdict
          }
          return { golden: String(r.golden), ok: !!r.ok, failure: r.failure ?? null, reason: r.reason ?? null, data };
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

/** The longest comment GitHub takes is 65,536 characters; the body stays well under it. */
const LONGEST = 60_000;

/**
 * The comment: the marker, a heading that counts the goldens as the job summary does, a table with
 * each golden's verdict line and, when the history has the base branch's last session, how the golden
 * did there; then the fix pull requests this job opened, and where the details are.
 */
export function commentBody({ report, marker, base = null, baseRef = null, fixes = [], runUrl = null, longest = LONGEST }) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const failed = results.filter((r) => verdictOf(r) === 'failed').length;
  const inconclusive = results.filter((r) => verdictOf(r) === 'inconclusive').length;
  const total = results.length;
  const recordings = `golden${total === 1 ? '' : 's'}`;
  const head = !failed && !inconclusive ? `${total} ${recordings} passed` : !failed ? `${inconclusive} of ${total} ${recordings} ${inconclusive === 1 ? 'is' : 'are'} inconclusive` : `${failed} of ${total} ${recordings} failed${inconclusive ? `, ${inconclusive} inconclusive` : ''}`;
  const where = base ? `On ${code(baseRef ?? 'the base branch', true)}` : null;
  const top = [marker, `### Shadowlap: ${head}`, '', where ? `| | Golden | Verdict | ${where} |` : '| | Golden | Verdict |', where ? '|---|---|---|---|' : '|---|---|---|'];
  const rows = results.map((r) => {
    const name = r.golden ?? r.name;
    const row = `| ${MARK[verdictOf(r)]} | ${code(name, true)} | ${cell(verdictLine(r))} |`;
    if (!base) return row;
    const was = base.results.get(name);
    return `${row} ${was ? `${MARK[storedVerdict(was)] ?? ''} ${storedVerdict(was)}` : 'not tested'} |`;
  });
  const tail = [];
  if (base) tail.push('', `Compared with ${code(baseRef ?? 'the base branch')} as the test history last tested it${base.revision ? `, at ${code(base.revision)}` : ''}.`);
  const opened = (Array.isArray(fixes) ? fixes : []).filter((f) => f?.outcome === 'opened' && f.pr);
  if (opened.length) tail.push('', ...opened.map((f) => `Fix on failure opened ${f.pr} for ${String(f.golden ?? f.name).split(', ').map(code).join(', ')}: ${cell(f.title ?? 'a fix')}.`));
  if (runUrl) tail.push('', `[The job's summary](${runUrl}) has each failure in full.`);
  // Within GitHub's limit: the rows that fit, and how many more the job summary lists.
  let shown = rows.length;
  const size = (n) => [...top, ...rows.slice(0, n), ...(n < rows.length ? [`| | … | ${rows.length - n} more in the job summary |${base ? ' |' : ''}`] : []), ...tail].join('\n').length;
  while (shown > 0 && size(shown) > longest) shown--;
  return [...top, ...rows.slice(0, shown), ...(shown < rows.length ? [`| | … | ${rows.length - shown} more in the job summary |${base ? ' |' : ''}`] : []), ...tail].join('\n') + '\n';
}

/**
 * Keeps the comment on the pull request this job runs for, and says how it went: `{ state, url, why }`,
 * state `created` or `updated`, `skipped` (a pull request from a fork, whose token may not comment;
 * no token), `denied` (the token may not comment), `failed`, or `none` (no pull request). It never
 * fails the job: what didn't go is said in the job summary.
 */
export async function postComment({ env, auth, report, fixes = [], store, recordings, workdir, fetch: fetchFn = globalThis.fetch, read }) {
  const pr = pullRequestOf(env, read);
  if (!pr) return { state: 'none', url: null, why: null };
  if (forkPullRequest(env, read)) return { state: 'skipped', url: null, why: 'a pull request from a fork gets a token from GitHub that may not comment on it' };
  if (!auth?.token) return { state: 'skipped', url: null, why: 'the job has no token to comment with' };
  const base = baseSession(readHistory(store), { baseRef: pr.baseRef, baseSha: pr.baseSha, current: report.session ?? null });
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const marker = commentMarker({ workflow: env.GITHUB_WORKFLOW ?? '', job: env.GITHUB_JOB ?? '', workdir, recordings });
  const body = commentBody({ report, marker, base, baseRef: pr.baseRef, fixes, runUrl });
  return upsertComment({ env, auth, number: pr.number, marker, body, fetch: fetchFn });
}

/** What the job summary says about the comment when it didn't go up; nothing when it did, or there was no pull request. */
export function commentNote(posted) {
  if (!posted || posted.state === 'created' || posted.state === 'updated' || posted.state === 'none') return '';
  return `\nThe pull request comment was not posted: ${markdownText(String(posted.why ?? ''))}.\n`;
}
