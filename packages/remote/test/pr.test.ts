import { describe, expect, it } from 'vitest';
import { parseStoreUrl, pullRequestFolders, pullRequestJob, pullRequestLocation, StoreUrlError } from '@shadowlap/remote';
import { MemoryStore } from './fakes/memory.js';

/**
 * Pull requests' CI jobs, recognised from the CI's own variables, and their folders in the store:
 * pr/<number>/ under the store's folder, where whatever such a job writes goes.
 */

const noFile = (path: string): string => {
  throw new Error(`no file ${path}`);
};

describe("a pull request's CI job", () => {
  it('is recognised on GitHub Actions by its event, with the number from the ref', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/42/merge' };
    expect(pullRequestJob(env, { readFile: noFile })).toEqual({ number: '42', source: 'GitHub Actions (pull_request)' });
    for (const event of ['pull_request_review', 'pull_request_review_comment']) expect(pullRequestJob({ ...env, GITHUB_EVENT_NAME: event }, { readFile: noFile })!.number).toBe('42');
  });

  it("reads the number of a pull_request_target job from the event, since it runs on the base branch", () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: '/github/event.json' };
    const read = (path: string) => (path === '/github/event.json' ? JSON.stringify({ number: 9, pull_request: { number: 9, title: 'x' } }) : noFile(path));
    expect(pullRequestJob(env, { readFile: read })).toEqual({ number: '9', source: 'GitHub Actions (pull_request_target)' });
    // Without a readable event, it is still a pull request's job: one whose number isn't known.
    expect(pullRequestJob(env, { readFile: noFile })).toEqual({ number: null, source: 'GitHub Actions (pull_request_target)' });
    expect(pullRequestJob({ ...env, GITHUB_EVENT_PATH: '/github/event.json' }, { readFile: () => '{"pull_request":{"number":"9; rm -rf /"}}' })!.number).toBeNull();
  });

  it("is not a push to a branch, a schedule, or a person's machine", () => {
    expect(pullRequestJob({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }, { readFile: noFile })).toBeNull();
    expect(pullRequestJob({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule' }, { readFile: noFile })).toBeNull();
    expect(pullRequestJob({ GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'push', CI_COMMIT_BRANCH: 'main' })).toBeNull();
    expect(pullRequestJob({})).toBeNull();
  });

  it('is recognised on GitLab by a merge request pipeline, with its IID', () => {
    expect(pullRequestJob({ GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_IID: '7' })).toEqual({ number: '7', source: 'a GitLab merge request pipeline' });
    expect(pullRequestJob({ GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'merge_request_event' })).toEqual({ number: null, source: 'a GitLab merge request pipeline' });
    expect(pullRequestJob({ GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'external_pull_request_event', CI_EXTERNAL_PULL_REQUEST_IID: '12' })!.number).toBe('12');
  });

  it('is named by SHADOWLAP_PR on any CI, and only by a number', () => {
    expect(pullRequestJob({ BUILDKITE: 'true', SHADOWLAP_PR: '314' })).toEqual({ number: '314', source: 'SHADOWLAP_PR' });
    expect(pullRequestJob({ SHADOWLAP_PR: '../main' })).toEqual({ number: null, source: 'SHADOWLAP_PR' });
    expect(pullRequestJob({ SHADOWLAP_PR: '0' })!.number).toBeNull();
    // Set, it wins over what the CI says.
    expect(pullRequestJob({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/42/merge', SHADOWLAP_PR: '43' })!.number).toBe('43');
  });
});

describe("a pull request's folder in the store", () => {
  it("is pr/<number>/ under the store's folder, with everything else about the store kept", () => {
    const loc = parseStoreUrl('s3://northwind-agent-runs/support-agent?region=eu-central-1&endpoint=https://minio.internal:9000');
    expect(pullRequestLocation(loc, '42')).toEqual({ ...loc, prefix: 'support-agent/pr/42', url: 's3://northwind-agent-runs/support-agent/pr/42' });
    const root = parseStoreUrl('az://northwindruns/agent-runs');
    expect(pullRequestLocation(root, '7')).toMatchObject({ account: 'northwindruns', bucket: 'agent-runs', prefix: 'pr/7', url: 'az://northwindruns/agent-runs/pr/7' });
    expect(() => pullRequestLocation(loc, '../../x')).toThrow(StoreUrlError);
  });

  it('is found by the index segments under it, in number order', async () => {
    const remote = new MemoryStore(parseStoreUrl('s3://agent-runs/team'));
    for (const key of ['pr/10/index/01J.json', 'pr/10/blobs/abc', 'pr/9/index/01K.json', 'pr/9/index/01L.json', 'pr/11/blobs/only-blobs', 'pr/x/index/01M.json', 'index/01N.json', 'runs/A/run.json']) {
      remote.objects.set(key, { body: Buffer.from('{}'), version: 'v', contentType: 'application/json' });
    }
    expect(await pullRequestFolders(remote)).toEqual(['9', '10']);
    expect(remote.log.filter((l) => l.op === 'list').map((l) => l.key)).toEqual(['pr/']);
  });
});
