import { readFileSync } from 'node:fs';
import type { ObjectStore } from './object-store.js';
import { StoreUrlError, type StoreLocation } from './url.js';

/**
 * Pull requests' CI jobs. Whoever opens a pull request decides what its CI job runs, so nothing such
 * a job writes is trusted with the team's runs: it goes to the pull request's own folder, pr/<number>/
 * under the store's folder, laid out like the store itself. A pull leaves those folders out unless
 * asked (--include-pr), a run brought from one never goes back into the store's own runs, and what
 * a pull request's folder says about a run already here is never taken. That keeps the poisoning of
 * shared build caches by pull requests (CVE-2025-36852) out of the run store.
 *
 * The CLI only puts a pull request's runs in their place. What stops a job from writing anywhere
 * else is the cloud: the pull-request policy `shadowlap store policy` prints, on credentials that
 * only pull requests' jobs get (`shadowlap store ci` prints the step).
 */

/** The folder under the store's folder that holds one folder per pull request. */
export const PR_FOLDER = 'pr';

export interface PullRequestJob {
  /** The pull or merge request's number; null when the job is one but no number could be found. */
  number: string | null;
  /** How the job was recognised, in words: `GitHub Actions (pull_request)`, `SHADOWLAP_PR`. */
  source: string;
}

const NUMBER = /^[1-9][0-9]{0,11}$/;
/** The GitHub Actions events that run for a pull request, with what it changed checked out or at hand. */
const GITHUB_PR_EVENTS = new Set(['pull_request', 'pull_request_target', 'pull_request_review', 'pull_request_review_comment']);

function numberOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && NUMBER.test(value)) return value;
  return null;
}

/** The number in a GitHub event payload: `pull_request.number`, or `number` at the top. */
function eventNumber(path: string | undefined, read: (path: string) => string): string | null {
  if (!path) return null;
  try {
    const event = JSON.parse(read(path)) as { pull_request?: { number?: unknown }; number?: unknown };
    return numberOf(event.pull_request?.number) ?? numberOf(event.number);
  } catch {
    return null;
  }
}

/**
 * The pull request this process runs a CI job for, or null when it runs for none (a person's
 * machine, or CI on a branch). `SHADOWLAP_PR` names one in any CI; GitHub Actions' pull_request
 * events and GitLab's merge request pipelines are recognised by their own variables.
 */
export function pullRequestJob(env: NodeJS.ProcessEnv = process.env, options: { readFile?: (path: string) => string } = {}): PullRequestJob | null {
  const named = env.SHADOWLAP_PR?.trim();
  if (named) return { number: NUMBER.test(named) ? named : null, source: 'SHADOWLAP_PR' };
  const event = env.GITHUB_EVENT_NAME ?? '';
  if (env.GITHUB_ACTIONS && env.GITHUB_ACTIONS !== 'false' && GITHUB_PR_EVENTS.has(event)) {
    // pull_request runs on refs/pull/<number>/merge; pull_request_target runs on the base branch,
    // and the number is in the event's payload.
    const fromRef = /^refs\/pull\/([0-9]+)\/(?:merge|head)$/.exec(env.GITHUB_REF ?? '')?.[1] ?? null;
    const number = numberOf(fromRef) ?? eventNumber(env.GITHUB_EVENT_PATH, options.readFile ?? ((p) => readFileSync(p, 'utf8')));
    return { number, source: `GitHub Actions (${event})` };
  }
  if (env.GITLAB_CI && env.GITLAB_CI !== 'false') {
    if (env.CI_PIPELINE_SOURCE === 'merge_request_event' || env.CI_MERGE_REQUEST_IID) return { number: numberOf(env.CI_MERGE_REQUEST_IID), source: 'a GitLab merge request pipeline' };
    if (env.CI_PIPELINE_SOURCE === 'external_pull_request_event') return { number: numberOf(env.CI_EXTERNAL_PULL_REQUEST_IID), source: 'a GitLab pipeline for an external pull request' };
  }
  return null;
}

/** A pull request's own folder in the store: pr/<number>/ under the store's folder. */
export function pullRequestLocation(loc: StoreLocation, number: string): StoreLocation {
  if (!NUMBER.test(number)) throw new StoreUrlError(`"${number}" isn't a pull request's number`);
  const folder = `${PR_FOLDER}/${number}`;
  return { ...loc, prefix: loc.prefix ? `${loc.prefix}/${folder}` : folder, url: `${loc.url}/${folder}` };
}

/**
 * The pull requests whose jobs pushed runs to the store, by the index segments in their folders, in
 * number order. It lists everything under pr/, so it costs a listing of every pull request's
 * objects; only `pull --include-pr` asks.
 */
export async function pullRequestFolders(remote: ObjectStore): Promise<string[]> {
  const found = new Set<string>();
  for await (const o of remote.list(`${PR_FOLDER}/`)) {
    const m = /^pr\/([0-9]+)\/index\/[^/]+\.json$/.exec(o.key);
    if (m && NUMBER.test(m[1]!)) found.add(m[1]!);
  }
  return [...found].sort((a, b) => Number(a) - Number(b));
}
