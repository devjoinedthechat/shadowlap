import { describe, expect, it } from 'vitest';
import { sessionSource } from '../src/baseline-branch.js';
import { parseTests, parseTestSettings } from '../src/checks.js';

/**
 * Where a test session runs, for a gate against history: its branch, whether it runs for a pull
 * request, and the branch baselines come from. CI's variables first, git otherwise, and the config's
 * `tests.baselineBranch` over both.
 */

/** A git that answers as a clone of a repository whose default branch is main, on `branch`. */
const git =
  (o: { branch?: string | null; origin?: string | null } = {}) =>
  (args: string[]): string | null => {
    if (args.join(' ') === 'symbolic-ref --quiet --short HEAD') return o.branch === undefined ? 'feature' : o.branch;
    if (args.join(' ') === 'symbolic-ref --quiet --short refs/remotes/origin/HEAD') return o.origin === undefined ? 'origin/main' : o.origin;
    return null;
  };
const event = (payload: unknown) => () => JSON.stringify(payload);

describe('sessionSource', () => {
  it('reads a push on GitHub Actions: the branch pushed, and the default branch from the event', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main', GITHUB_EVENT_PATH: '/event.json' };
    expect(sessionSource({ cwd: '.', env, git: git({ origin: null }), readFile: event({ repository: { default_branch: 'main' } }) })).toEqual({ branch: 'main', pullRequest: false, baselineBranch: 'main', from: 'GitHub' });
    // A push to another branch: its own sessions are no baseline, the default branch's are.
    expect(sessionSource({ cwd: '.', env: { ...env, GITHUB_REF: 'refs/heads/dev', GITHUB_REF_NAME: 'dev' }, git: git({ origin: null }), readFile: event({ repository: { default_branch: 'main' } }) })).toMatchObject({ branch: 'dev', pullRequest: false, baselineBranch: 'main' });
    // A tag is no branch.
    expect(sessionSource({ cwd: '.', env: { ...env, GITHUB_REF: 'refs/tags/v1.0.0', GITHUB_REF_NAME: 'v1.0.0' }, git: git(), readFile: event({}) })).toMatchObject({ branch: null, baselineBranch: 'main', from: 'git' });
  });

  it('reads a pull request on GitHub Actions: its head branch, never a baseline, against its base branch', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge', GITHUB_REF_NAME: '7/merge', GITHUB_HEAD_REF: 'fix-refunds', GITHUB_BASE_REF: 'main', GITHUB_EVENT_PATH: '/event.json' };
    expect(sessionSource({ cwd: '.', env, git: git(), readFile: event({ pull_request: { number: 7 }, repository: { default_branch: 'main' } }) })).toEqual({ branch: 'fix-refunds', pullRequest: true, baselineBranch: 'main', from: 'pull request' });
    // Into a release branch: that branch's sessions are its baseline.
    expect(sessionSource({ cwd: '.', env: { ...env, GITHUB_BASE_REF: 'release-1' }, git: git(), readFile: event({ repository: { default_branch: 'main' } }) }).baselineBranch).toBe('release-1');
    // pull_request_target runs on the base branch's ref, for a pull request all the same.
    expect(sessionSource({ cwd: '.', env: { ...env, GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main' }, git: git(), readFile: event({ number: 7 }) }).pullRequest).toBe(true);
  });

  it('reads GitLab and Buildkite, merge requests and pull requests included', () => {
    expect(sessionSource({ cwd: '.', env: { GITLAB_CI: 'true', CI_COMMIT_BRANCH: 'main', CI_DEFAULT_BRANCH: 'main' }, git: git({ origin: null }) })).toEqual({ branch: 'main', pullRequest: false, baselineBranch: 'main', from: 'GitLab' });
    expect(sessionSource({ cwd: '.', env: { GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_IID: '12', CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'fix', CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'main', CI_DEFAULT_BRANCH: 'main' }, git: git() })).toMatchObject({ branch: 'fix', pullRequest: true, baselineBranch: 'main' });
    expect(sessionSource({ cwd: '.', env: { BUILDKITE: 'true', BUILDKITE_BRANCH: 'main', BUILDKITE_PULL_REQUEST: 'false', BUILDKITE_PIPELINE_DEFAULT_BRANCH: 'main' }, git: git({ origin: null }) })).toEqual({ branch: 'main', pullRequest: false, baselineBranch: 'main', from: 'Buildkite' });
    expect(sessionSource({ cwd: '.', env: { BUILDKITE: 'true', BUILDKITE_BRANCH: 'fix', BUILDKITE_PULL_REQUEST: '42', BUILDKITE_PULL_REQUEST_BASE_BRANCH: 'main' }, git: git() })).toMatchObject({ branch: 'fix', pullRequest: true, baselineBranch: 'main' });
  });

  it('reads git outside CI: the branch checked out, and origin/HEAD', () => {
    expect(sessionSource({ cwd: '.', env: {}, git: git({ branch: 'main' }) })).toEqual({ branch: 'main', pullRequest: false, baselineBranch: 'main', from: 'git' });
    // A detached checkout, and a clone with no origin/HEAD: nothing to tell, and no baseline.
    expect(sessionSource({ cwd: '.', env: {}, git: git({ branch: null, origin: null }) })).toEqual({ branch: null, pullRequest: false, baselineBranch: null, from: null });
    // SHADOWLAP_PR marks a pull request's job in any CI, or none.
    expect(sessionSource({ cwd: '.', env: { SHADOWLAP_PR: '9' }, git: git({ branch: 'main' }) }).pullRequest).toBe(true);
  });

  it('takes the baseline branch from the config over everything else', () => {
    expect(sessionSource({ cwd: '.', env: { GITLAB_CI: 'true', CI_COMMIT_BRANCH: 'trunk', CI_DEFAULT_BRANCH: 'main' }, configured: 'trunk', git: git() })).toEqual({ branch: 'trunk', pullRequest: false, baselineBranch: 'trunk', from: 'config' });
    expect(sessionSource({ cwd: '.', env: {}, configured: 'develop', git: git({ branch: 'develop', origin: null }) })).toMatchObject({ baselineBranch: 'develop', from: 'config' });
  });
});

describe('the session settings under tests', () => {
  it('reads suiteRisk and baselineBranch, and leaves them out of the recordings', () => {
    const tests = { suiteRisk: 0.1, baselineBranch: 'main', 'goldens/a': { fork: true, gate: {} } };
    expect(parseTestSettings(tests)).toEqual({ suiteRisk: 0.1, baselineBranch: 'main' });
    expect(parseTests(tests).map((e) => e.recording)).toEqual(['goldens/a']);
    expect(parseTestSettings({ 'goldens/a': {} })).toEqual({});
  });

  it('says what is wrong with them', () => {
    expect(() => parseTests({ suiteRisk: 0.5 })).toThrow('tests.suiteRisk must be a number above 0 and below 0.5, such as 0.05');
    expect(() => parseTests({ suiteRisk: '5%' })).toThrow('tests.suiteRisk must be a number');
    expect(() => parseTests({ baselineBranch: '' })).toThrow('tests.baselineBranch must be a branch name, such as "main"');
    expect(() => parseTests({ baselineBranch: 'my branch' })).toThrow('tests.baselineBranch must be a branch name');
  });
});
