import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pullRequestJob } from '@shadowlap/remote';

/**
 * Where a test session runs, for a gate against history: the branch it tests, whether it runs for a
 * pull request, and the branch a baseline comes from. A baseline is a golden's past results that
 * passed on that branch, outside any pull request (gate-history.ts), so a regression that lands on a
 * branch, or that a pull request brings, never becomes the standard it is judged by.
 *
 * Each comes from CI's own variables where the session runs in CI, and from git otherwise; the
 * baseline branch from `tests.baselineBranch` in shadowlap.config.json first. Read once per session.
 */

export interface SessionSource {
  /** The branch the session tests; null when none can be told (a tag, a detached checkout outside CI). */
  branch: string | null;
  /** It runs for a pull or merge request: its results are never part of a baseline. */
  pullRequest: boolean;
  /** The branch baselines come from; null when none can be told, and then no result is a baseline. */
  baselineBranch: string | null;
  /** Where `baselineBranch` came from, as a note says it. */
  from: 'config' | 'pull request' | 'GitHub' | 'GitLab' | 'Buildkite' | 'git' | null;
}

export interface SourceOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** `tests.baselineBranch` from the config. */
  configured?: string | null;
  /** Runs git in `cwd` and returns what it printed, trimmed, or null when it failed: tests pass their own. */
  git?: (args: string[]) => string | null;
  /** Reads a CI event payload (GITHUB_EVENT_PATH): tests pass their own. */
  readFile?: (path: string) => string;
}

const set = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);

function runGit(cwd: string): (args: string[]) => string | null {
  return (args) => {
    try {
      return set(execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).toString());
    } catch {
      return null;
    }
  };
}

/** The default branch a GitHub event names (`repository.default_branch`), push and pull request events alike. */
function githubDefault(env: NodeJS.ProcessEnv, read: (path: string) => string): string | null {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    const event = JSON.parse(read(path)) as { repository?: { default_branch?: unknown } };
    const v = event.repository?.default_branch;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The session's branch, pull request and baseline branch. In CI:
 * - GitHub Actions: a pull request's head branch (`GITHUB_HEAD_REF`) and its base (`GITHUB_BASE_REF`)
 *   as the baseline branch; otherwise the branch pushed (`GITHUB_REF_NAME` under `refs/heads/`), with
 *   the repository's default branch from the event payload as the baseline branch.
 * - GitLab CI: a merge request's source and target branches; otherwise `CI_COMMIT_BRANCH` and
 *   `CI_DEFAULT_BRANCH`.
 * - Buildkite: `BUILDKITE_BRANCH`, a pull request's base branch, `BUILDKITE_PIPELINE_DEFAULT_BRANCH`.
 * Elsewhere, git: the branch checked out, and `origin/HEAD` (the remote's default branch, which a
 * clone sets) as the baseline branch. `tests.baselineBranch` overrides the baseline branch anywhere.
 */
export function sessionSource(o: SourceOptions): SessionSource {
  const env = o.env ?? process.env;
  const git = o.git ?? runGit(o.cwd);
  const read = o.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const job = pullRequestJob(env, { readFile: read });
  const buildkitePr = !!env.BUILDKITE && !!set(env.BUILDKITE_PULL_REQUEST) && env.BUILDKITE_PULL_REQUEST !== 'false';
  const pullRequest = job !== null || buildkitePr;
  let branch: string | null = null;
  let detected: string | null = null;
  let from: SessionSource['from'] = null;
  if (env.GITHUB_ACTIONS && env.GITHUB_ACTIONS !== 'false') {
    branch = pullRequest ? set(env.GITHUB_HEAD_REF) : (env.GITHUB_REF ?? '').startsWith('refs/heads/') ? set(env.GITHUB_REF_NAME) : null;
    const base = pullRequest ? set(env.GITHUB_BASE_REF) : null;
    detected = base ?? githubDefault(env, read);
    from = base ? 'pull request' : detected ? 'GitHub' : null;
  } else if (env.GITLAB_CI && env.GITLAB_CI !== 'false') {
    branch = pullRequest ? set(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME) : set(env.CI_COMMIT_BRANCH);
    const base = pullRequest ? set(env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME) : null;
    detected = base ?? set(env.CI_DEFAULT_BRANCH);
    from = base ? 'pull request' : detected ? 'GitLab' : null;
  } else if (env.BUILDKITE && env.BUILDKITE !== 'false') {
    branch = set(env.BUILDKITE_BRANCH);
    const base = pullRequest ? set(env.BUILDKITE_PULL_REQUEST_BASE_BRANCH) : null;
    detected = base ?? set(env.BUILDKITE_PIPELINE_DEFAULT_BRANCH);
    from = base ? 'pull request' : detected ? 'Buildkite' : null;
  }
  // Outside those, or where they left something out, git says.
  if (!branch && !(env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE)) branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!detected) {
    const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    detected = head ? head.replace(/^origin\//, '') : null;
    if (detected) from = 'git';
  }
  const configured = set(o.configured ?? undefined);
  return { branch, pullRequest, baselineBranch: configured ?? detected, from: configured ? 'config' : from };
}

/** What `test` says under a golden whose gate against history has no baseline branch to take sessions from. */
export const NO_BASELINE_BRANCH =
  'no baseline branch is known here (not CI, and no origin/HEAD), so no session counts towards its baseline: set "baselineBranch" under "tests" in shadowlap.config.json, such as "main"';
