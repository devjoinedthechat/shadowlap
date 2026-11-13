// The pull request comment's Decisions part, with the decisions input: `shadowlap decisions
// --from-code` asks each golden's model calls again under the prompt and tools the pull request
// sends, and keeps its session with the test session's comment (--test-session), where Settings → CI
// and the revision's page read it. It asks the goldens' models, so it runs only for a pull request
// the action comments on, and it never fails the job: what went wrong is a line in the log.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logLine } from './log.mjs';

/** @import { CommentDecisionsSource, DecisionsAsk, DecisionsJson } from './types.mjs' */

/**
 * The report decisions printed, or null when it printed none that reads as JSON.
 * @param {string} path
 * @returns {DecisionsJson | null}
 */
function readReport(path) {
  try {
    const json = /** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8')));
    return json && typeof json === 'object' ? /** @type {DecisionsJson} */ (json) : null;
  } catch {
    return null;
  }
}

/**
 * The arguments the decisions run takes: the store the test ran with, the recordings, the working
 * tree's prompt and tools, a report as JSON, an inconclusive step as a warning, and the test session
 * that keeps the part.
 * @param {Pick<DecisionsAsk, 'cli' | 'db' | 'packs'>} ask
 * @param {string} session
 * @returns {string[]}
 */
export function decisionsArgs({ cli, db, packs }, session) {
  return [cli, ...(db ? ['--db', db] : []), 'decisions', ...packs, '--from-code', '--json', '--inconclusive', 'warn', '--test-session', session];
}

/**
 * The comment's decisions for the test session `session`: `shadowlap decisions --from-code`'s report,
 * or null when the input is off or no report came of it, which the log says. The report goes to a
 * file of its own, since one over many goldens outgrows what a pipe is read into.
 * @param {DecisionsAsk} ask
 * @param {string} session
 * @returns {CommentDecisionsSource | null}
 */
export function askDecisions(ask, session) {
  if (!ask.on) return null;
  const log = ask.log ?? ((/** @type {string} */ line) => void process.stdout.write(`${line}\n`));
  const path = join(ask.out, 'shadowlap-decisions.json');
  log(logLine(`shadowlap decisions ${ask.packs.join(' ')} --from-code`));
  const fd = openSync(path, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, decisionsArgs(ask, session), { cwd: ask.cwd, env: ask.env, stdio: ['ignore', fd, 'inherit'] });
  } finally {
    closeSync(fd);
  }
  const report = readReport(path);
  if (report && Array.isArray(report.runs) && Array.isArray(report.flagged) && report.counts) return /** @type {CommentDecisionsSource} */ (report);
  // A refusal prints its message in the report; a run that stopped prints nothing.
  log(logLine(`the pull request comment has no decisions: ${report?.error?.message ?? `shadowlap decisions did not finish (exit ${String(r.status ?? r.signal)}); its output is above`}`));
  return null;
}
