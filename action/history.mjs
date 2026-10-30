// The GitHub Action's test history: whether to keep the store between jobs in the Actions cache, so a
// gate against a golden's history has a baseline, and where the cache step finds it. It writes the
// step outputs action.yml's cache steps read: keep (true or false), path (the store's files), key
// (one per run, so each run saves what it adds) and restore-keys (this branch's newest, then the
// default branch's). Inputs arrive as environment variables, as for run.mjs.
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refusal } from './events.mjs';
import { annotation, logLine } from './log.mjs';

/** @import { HistoryPlan } from './types.mjs' */

const env = process.env;
/** An input of the action's, as the runner passes it: `INPUT_<NAME>`, trimmed. */
const input = (/** @type {string} */ name, fallback = '') => (env[`INPUT_${name}`] ?? fallback).trim();

/**
 * Whether shadowlap.config.json gives any golden a gate against history.
 * @param {unknown} config
 * @returns {boolean}
 */
export function hasHistoryGate(config) {
  const tests = config && typeof config === 'object' && !Array.isArray(config) ? /** @type {{ tests?: unknown }} */ (config).tests : null;
  if (!tests || typeof tests !== 'object' || Array.isArray(tests)) return false;
  return Object.values(tests).some((/** @type {{ gate?: { baseline?: unknown } } | null} */ t) => t && typeof t === 'object' && t.gate && typeof t.gate === 'object' && t.gate.baseline === 'history');
}

/**
 * A cache key's part from a branch name: what a key allows, and short.
 * @param {string | null | undefined} s
 * @returns {string}
 */
export const keyPart = (s) => String(s || 'none').replace(/[^\w.-]+/g, '-').slice(0, 100);

/**
 * What the cache steps need: keep it for `true`, never for `false`, and for `auto` when a golden has a
 * gate against history; the store's file with its write-ahead log; a key for this run; and the keys to
 * restore from, this branch's newest first, then the default branch's (a branch's first job). On an
 * `event` the action doesn't run on (events.mjs), never, whatever `keep` says, and `refused` says
 * why: such a job tests nothing, and the store in its checkout must not be saved as a branch's history.
 * @param {{ keep: string; workdir: string; store: string; config: unknown; branch: string; defaultBranch: string; runId: string | undefined; attempt: string | undefined; event?: string | undefined }} o
 * @returns {HistoryPlan}
 */
export function historyPlan({ keep, workdir, store, config, branch, defaultBranch, runId, attempt, event }) {
  if (!['auto', 'true', 'false'].includes(keep)) throw new Error(`input keep-history must be auto, true or false, not "${keep}"`);
  const refused = refusal(event);
  const on = !refused && (keep === 'true' || (keep === 'auto' && hasHistoryGate(config)));
  const db = store ? resolve(workdir, store) : join(workdir, '.shadowlap', 'shadowlap.db');
  const prefix = 'shadowlap-history-';
  const restore = [`${prefix}${keyPart(branch)}-`, ...(defaultBranch && defaultBranch !== branch ? [`${prefix}${keyPart(defaultBranch)}-`] : [])];
  return { keep: on, refused, path: [db, `${db}-wal`, `${db}-shm`], key: `${prefix}${keyPart(branch)}-${runId || 'local'}-${attempt || '1'}`, restoreKeys: restore };
}

/**
 * The project's config, or null.
 * @param {string} workdir
 * @returns {unknown}
 */
function readConfig(workdir) {
  try {
    return JSON.parse(readFileSync(join(workdir, 'shadowlap.config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // No config, or one shadowlap test will report: nothing names a gate against history.
    return null;
  }
}

/**
 * Step outputs as GitHub reads them, a value over several lines in a heredoc.
 * @param {Record<string, string | string[]>} outputs
 * @returns {string}
 */
function outputLines(outputs) {
  return Object.entries(outputs)
    .map(([k, v]) => (Array.isArray(v) ? `${k}<<SHADOWLAP_EOF\n${v.join('\n')}\nSHADOWLAP_EOF\n` : `${k}=${v}\n`))
    .join('');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const workdir = resolve(input('WORKING_DIRECTORY', '.') || '.');
  let plan;
  try {
    plan = historyPlan({
      keep: input('KEEP_HISTORY', 'auto').toLowerCase(),
      workdir,
      store: input('STORE'),
      config: readConfig(workdir),
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || '',
      defaultBranch: env.DEFAULT_BRANCH || '',
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      event: env.GITHUB_EVENT_NAME,
    });
  } catch (err) {
    // A config's error can quote the config, which a pull request may change.
    process.stdout.write(`${annotation('error', /** @type {Error} */ (err).message)}\n`);
    process.exit(1);
  }
  const outputs = { keep: String(plan.keep), path: plan.path, key: plan.key, 'restore-keys': plan.restoreKeys };
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, outputLines(outputs));
  process.stdout.write(plan.keep ? `${logLine(`keeping the test history between jobs: ${String(plan.path[0])}`)}\n` : plan.refused ? `${logLine(`not keeping the test history between jobs: ${plan.refused}`)}\n` : 'not keeping the test history between jobs\n');
}
