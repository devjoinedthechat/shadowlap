import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

export interface AuthorOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Reads a git config value; injectable for tests. Returns null when unset or outside git. */
  gitConfig?: (key: string, cwd: string) => string | null;
  /** The OS user name; injectable for tests. */
  osUser?: () => string | null;
}

/** CI providers recognised by their standard environment variables. */
const CI_VARS: Array<[string, string]> = [
  ['GITHUB_ACTIONS', 'github'],
  ['GITLAB_CI', 'gitlab'],
  ['BUILDKITE', 'buildkite'],
  ['CIRCLECI', 'circleci'],
  ['JENKINS_URL', 'jenkins'],
  ['TF_BUILD', 'azure'],
  ['BITBUCKET_BUILD_NUMBER', 'bitbucket'],
];

function defaultGitConfig(key: string, cwd: string): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', key], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function defaultOsUser(): string | null {
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
}

/** The CI provider a process runs under, or null outside CI. */
export function ciProvider(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const [name, provider] of CI_VARS) if (env[name]) return provider;
  return env.CI && env.CI !== 'false' && env.CI !== '0' ? 'ci' : null;
}

/**
 * Who made a run or took an action: `SHADOWLAP_AUTHOR` when set; `ci` in CI (CI is its own author);
 * otherwise git's user.email for the project, then the OS user. Null when none is known. Nothing
 * here leaves the machine: it is stored with the run and shown in the dashboard and activity feed.
 */
export function resolveAuthor(options: AuthorOptions = {}): string | null {
  const env = options.env ?? process.env;
  const explicit = env.SHADOWLAP_AUTHOR?.trim();
  if (explicit) return explicit.slice(0, 200);
  if (ciProvider(env)) return 'ci';
  const git = options.gitConfig ?? defaultGitConfig;
  const email = git('user.email', options.cwd ?? process.cwd());
  if (email) return email.slice(0, 200);
  return (options.osUser ?? defaultOsUser)();
}
