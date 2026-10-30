import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { markdownCode as engineCode, markdownFence as engineFence, markdownText as engineText, Store, titleText as engineTitle } from '@shadowlap/engine';
import { HOSTILE, HOSTILE_TITLES } from '../../engine/test/markdown-cases.js';
import { baseSession, commentBody, commentMarker, commentNote, postComment, readHistory, verdictLine } from '../../../action/comment.mjs';
import { branchNote, cannotFix, checksNote, evidenceNote, fixSummary, goldenGate, goldenNote, groupFixes, KEEPS_AT_MOST, leftOutWhy, planFixes, pushLine, pushTarget, repairArgs, repairPlan } from '../../../action/fix.mjs';
import { annotation, commandText, logLine, logLines } from '../../../action/log.mjs';
import { markdownCode, markdownFence, markdownText, titleText } from '../../../action/markdown.mjs';
import { dispatchWorkflow, githubToken, openPullRequest, pullRequestOf, TOKEN_VARIABLES, tokenEnv, upsertComment, withoutTokens, workflowFile } from '../../../action/github.mjs';
import { outputsOf } from '../../../action/run.mjs';
import type { Fetch, ReportResult, StoredSession } from '../../../action/types.mjs';

/**
 * The GitHub Action's logic, function by function, with GitHub's REST API played by a stand-in for
 * fetch that records each call and answers as GitHub does: which token the action speaks with, the
 * workflow it starts on a fix's branch, the comment it keeps on a pull request, what a repair is
 * verified on, and what the pull request and the step's outputs say.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for fetch: `answer` gives each call's status, JSON and headers; every call is kept. */
function github(answer: (call: Call) => { status: number; json?: unknown; headers?: Record<string, string> } | Error) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const call = { method: init.method, url, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const a = answer(call);
    if (a instanceof Error) throw a;
    return { status: a.status, text: async () => (a.json === undefined ? '' : JSON.stringify(a.json)), headers: { get: (name: string) => a.headers?.[name.toLowerCase()] ?? null } };
  };
  return { fetch, calls };
}

const JOB = 'ghs_jobtoken';
const ACTIONS: NodeJS.ProcessEnv = { GITHUB_ACTIONS: 'true', GITHUB_API_URL: 'https://api.github.test', GITHUB_REPOSITORY: 'northwind/agent', GITHUB_WORKFLOW_REF: 'northwind/agent/.github/workflows/ci.yml@refs/heads/main', SHADOWLAP_JOB_TOKEN: JOB };

describe('the token the action speaks to GitHub with', () => {
  it('takes github-token when given, else a GH_TOKEN that is not the job\'s, else the job\'s own, which starts no workflow', () => {
    expect(githubToken({ ...ACTIONS, INPUT_GITHUB_TOKEN: 'github_pat_1' })).toEqual({ token: 'github_pat_1', source: 'input', startsWorkflows: true });
    expect(githubToken({ ...ACTIONS, GH_TOKEN: 'github_pat_2' })).toEqual({ token: 'github_pat_2', source: 'gh-token', startsWorkflows: true });
    // The job's token given back as the input, or as GH_TOKEN, as the docs' steps do, is the job's.
    expect(githubToken({ ...ACTIONS, INPUT_GITHUB_TOKEN: JOB })).toEqual({ token: JOB, source: 'github-token', startsWorkflows: false });
    expect(githubToken({ ...ACTIONS, GH_TOKEN: JOB })).toEqual({ token: JOB, source: 'github-token', startsWorkflows: false });
    expect(githubToken({ ...ACTIONS })).toEqual({ token: JOB, source: 'github-token', startsWorkflows: false });
    expect(githubToken({})).toEqual({ token: null, source: 'none', startsWorkflows: false });
  });

  it('never hands the CLI or the agent the tokens the step was given for GitHub', () => {
    const env = withoutTokens({ ...ACTIONS, INPUT_GITHUB_TOKEN: 'github_pat_1', PATH: '/bin' });
    expect(env).not.toHaveProperty('INPUT_GITHUB_TOKEN');
    expect(env).not.toHaveProperty('SHADOWLAP_JOB_TOKEN');
    expect(env.PATH).toBe('/bin');
  });

  it('keeps every GitHub token the job holds from the CLI and the agent: gh\'s, the OIDC request\'s, and any copy of one under another name', () => {
    const header = (t: string) => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}`;
    const job = {
      ...ACTIONS,
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      INPUT_GITHUB_TOKEN: 'github_pat_input',
      // The docs' old step: the job's own token as GH_TOKEN, and a personal access token as GITHUB_TOKEN.
      GH_TOKEN: JOB,
      GITHUB_TOKEN: 'github_pat_env',
      GH_ENTERPRISE_TOKEN: 'ghe_token_1',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc_request_token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.test/?api-version=2',
      ACTIONS_RUNTIME_TOKEN: 'runtime_token_1',
      // The same tokens again, as a step's own env or a script might hold them.
      MY_TOKEN: JOB,
      AUTH_HEADER: 'Bearer github_pat_input',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: header(JOB),
      // Not a token, though it is short and the same as nothing: kept.
      CI: 'true',
    };
    const cli = withoutTokens(job);
    expect(Object.keys(cli).sort()).toEqual(['ANTHROPIC_API_KEY', 'CI', 'GITHUB_ACTIONS', 'GITHUB_API_URL', 'GITHUB_REPOSITORY', 'GITHUB_WORKFLOW_REF', 'PATH']);
    for (const name of TOKEN_VARIABLES) expect(cli).not.toHaveProperty(name);
    const text = JSON.stringify(cli);
    for (const token of [JOB, 'github_pat_input', 'github_pat_env', 'ghe_token_1', 'oidc_request_token', 'runtime_token_1']) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
    }
    // git's settings go whole with a token among them, as git refuses a count with a key or value missing; without one they stay.
    expect(withoutTokens({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', GH_TOKEN: JOB })).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
    // A token too short to be one GitHub issues is no reason to drop a variable that happens to match it.
    expect(withoutTokens({ GH_TOKEN: 'x', NAME: 'x' })).toEqual({ NAME: 'x' });

    // As the reviewer's harness found it: the documented step's GH_TOKEN, a personal access token as
    // GH_TOKEN, used for the push and handed to the CLI, and the job's token pushed through checkout's header.
    const doc = { SHADOWLAP_JOB_TOKEN: JOB, GH_TOKEN: JOB, INPUT_GITHUB_TOKEN: '' };
    expect(githubToken(doc)).toMatchObject({ token: JOB, source: 'github-token' });
    expect(withoutTokens(doc)).toEqual({});
    const pat = { SHADOWLAP_JOB_TOKEN: JOB, GH_TOKEN: 'github_pat_gh' };
    expect(githubToken(pat)).toMatchObject({ token: 'github_pat_gh', source: 'gh-token' });
    expect(withoutTokens(pat)).toEqual({});
  });

  it("gives git the token's own Authorization header in place of the job's that checkout left, through the environment, and nothing else the token", async () => {
    const auth = githubToken({ ...ACTIONS, INPUT_GITHUB_TOKEN: 'github_pat_1' });
    const env = tokenEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', GITHUB_SERVER_URL: 'https://github.test' }, auth);
    // No GH_TOKEN: the pull request is opened through GitHub's API, not by gh in the checkout.
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_KEY_1: 'http.https://github.test/.extraheader', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'http.https://github.test/.extraheader' });
    expect(Buffer.from(env.GIT_CONFIG_VALUE_2!.replace('AUTHORIZATION: basic ', ''), 'base64').toString()).toBe('x-access-token:github_pat_1');
    // The job's own token goes the same way: the push needs nothing checkout left on the disk.
    const job = tokenEnv({}, githubToken(ACTIONS));
    expect(job).toEqual({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${JOB}`).toString('base64')}` });

    // As git sends it: one Authorization header, the token's, to a server whose header the repository's config sets.
    const seen: string[][] = [];
    const server = createServer((req, res) => {
      const values: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (/^authorization$/i.test(req.rawHeaders[i])) values.push(req.rawHeaders[i + 1]);
      seen.push(values);
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const repo = temp('sl-token-git-');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', `http.${url}/.extraheader`, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${JOB}`).toString('base64')}`], { cwd: repo });
      const gitEnv = tokenEnv({ ...process.env, GITHUB_SERVER_URL: url, GIT_TERMINAL_PROMPT: '0' }, auth);
      await new Promise<void>((resolve) => spawn('git', ['ls-remote', `${url}/northwind/agent.git`], { cwd: repo, env: gitEnv, stdio: 'ignore' }).on('exit', () => resolve()));
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toEqual([`basic ${Buffer.from('x-access-token:github_pat_1').toString('base64')}`]);
      // A checkout with persist-credentials: false leaves no header: the job's token reaches git from its environment alone.
      const bare = temp('sl-token-git-bare-');
      execFileSync('git', ['init', '-q'], { cwd: bare });
      seen.length = 0;
      await new Promise<void>((resolve) => spawn('git', ['ls-remote', `${url}/northwind/agent.git`], { cwd: bare, env: tokenEnv({ ...process.env, GITHUB_SERVER_URL: url, GIT_TERMINAL_PROMPT: '0' }, githubToken(ACTIONS)), stdio: 'ignore' }).on('exit', () => resolve()));
      expect(seen[0]).toEqual([`basic ${Buffer.from(`x-access-token:${JOB}`).toString('base64')}`]);
    } finally {
      server.close();
    }
  });
});

describe('starting the workflow on a fix\'s branch', () => {
  const auth = githubToken(ACTIONS);

  it('dispatches the workflow this job runs in, on the branch, with the job\'s token', async () => {
    expect(workflowFile(ACTIONS)).toBe('ci.yml');
    const gh = github(() => ({ status: 204 }));
    expect(await dispatchWorkflow({ env: ACTIONS, auth, branch: 'shadowlap/fix-refund-flow-t9rb1d', fetch: gh.fetch })).toEqual({ dispatched: true, workflow: 'ci.yml', why: null });
    expect(gh.calls).toEqual([{ method: 'POST', url: 'https://api.github.test/repos/northwind/agent/actions/workflows/ci.yml/dispatches', headers: expect.objectContaining({ authorization: `Bearer ${JOB}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }), body: { ref: 'shadowlap/fix-refund-flow-t9rb1d' } }]);
  });

  it('says why when it can\'t: no workflow_dispatch trigger, no actions: write, GitHub out of reach, or no workflow to name', async () => {
    const said = async (answer: Parameters<typeof github>[0], env = ACTIONS) => (await dispatchWorkflow({ env, auth, branch: 'b', fetch: github(answer).fetch })).why;
    expect(await said(() => ({ status: 422, json: { message: "Workflow does not have 'workflow_dispatch' trigger" } }))).toBe("ci.yml has no workflow_dispatch trigger, which it needs to be started on a branch: GitHub answered 422 (Workflow does not have 'workflow_dispatch' trigger)");
    expect(await said(() => ({ status: 403, json: { message: 'Resource not accessible by integration' } }))).toBe("the job's token may not start it: give the job actions: write (GitHub answered 403 (Resource not accessible by integration))");
    expect(await said(() => new Error('getaddrinfo ENOTFOUND api.github.test'))).toBe('GitHub could not be reached: getaddrinfo ENOTFOUND api.github.test');
    expect(await said(() => ({ status: 204 }), { ...ACTIONS, GITHUB_WORKFLOW_REF: undefined })).toMatch(/^the job did not say which workflow it runs in/);
  });
});

describe("a fix's branch and its pull request", () => {
  it("goes to the repository the workflow runs in, as the runner names it, once the checkout's origin names it too, and nowhere else", () => {
    const repo = temp('sl-push-target-');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:northwind/agent.git'], { cwd: repo });
    const env = { ...process.env, GITHUB_SERVER_URL: 'https://github.test/', GITHUB_REPOSITORY: 'northwind/agent' };
    // The runner's names, not the checkout's URL: a rewrite or a remote the agent changed doesn't move it.
    expect(pushTarget(repo, env)).toEqual({ url: 'https://github.test/northwind/agent.git', why: null });
    expect(pushTarget(repo, { ...env, GITHUB_REPOSITORY: 'Northwind/Agent' })).toEqual({ url: 'https://github.test/Northwind/Agent.git', why: null });
    // A job that checked out another repository opens nothing in this one.
    expect(pushTarget(repo, { ...env, GITHUB_REPOSITORY: 'northwind/other' })).toEqual({ url: null, why: "the checkout's origin is not northwind/other, the repository this workflow runs in, so no fix is pushed from it" });
    // A job that names no repository pushes nothing: the checkout's origin, which the agent could have changed, never stands in.
    const unnamed = "the job doesn't name the repository it runs in (GITHUB_SERVER_URL and GITHUB_REPOSITORY), so no fix is pushed from it: the checkout's origin, which the agent could have changed, is never pushed to in its place";
    expect(pushTarget(repo, { ...process.env, GITHUB_SERVER_URL: undefined, GITHUB_REPOSITORY: undefined })).toEqual({ url: null, why: unnamed });
    expect(pushTarget(repo, { ...env, GITHUB_REPOSITORY: '' })).toEqual({ url: null, why: unnamed });
    expect(pushTarget(repo, { ...env, GITHUB_SERVER_URL: '' })).toEqual({ url: null, why: unnamed });
  });

  it("is opened through GitHub's API with the token, never by gh in the checkout, and says why when GitHub refuses", async () => {
    const auth = githubToken(ACTIONS);
    const ok = github(() => ({ status: 201, json: { number: 7, html_url: 'https://github.test/northwind/agent/pull/7' } }));
    expect(await openPullRequest({ env: ACTIONS, auth, head: 'shadowlap/fix-a', base: 'main', title: 'Escalate refunds', body: 'body', fetch: ok.fetch })).toEqual({ pr: 'https://github.test/northwind/agent/pull/7', why: null });
    expect(ok.calls).toEqual([expect.objectContaining({ method: 'POST', url: 'https://api.github.test/repos/northwind/agent/pulls', body: { title: 'Escalate refunds', head: 'shadowlap/fix-a', base: 'main', body: 'body' } })]);
    expect(ok.calls[0].headers.authorization).toBe(`Bearer ${JOB}`);
    const refused = github(() => ({ status: 422, json: { message: 'Validation Failed' } }));
    expect(await openPullRequest({ env: ACTIONS, auth, head: 'shadowlap/fix-a', base: 'main', title: 't', body: 'b', fetch: refused.fetch })).toEqual({ pr: null, why: 'GitHub answered 422 (Validation Failed)' });
  });

  it("is titled on one line, within GitHub's limit, with a mention, a reference and a workflow command's start split by a character that shows nothing", async () => {
    const auth = githubToken(ACTIONS);
    const titleOf = async (title: string) => {
      const gh = github(() => ({ status: 201, json: { number: 7, html_url: 'https://github.test/northwind/agent/pull/7' } }));
      await openPullRequest({ env: ACTIONS, auth, head: 'shadowlap/fix-a', base: 'main', title, body: 'b', fetch: gh.fetch });
      return (gh.calls[0].body as { title: string }).title;
    };
    // The fix commit's subject, as the repairer wrote it: what GitHub would read in it is split, the rest shows as written.
    expect(await titleOf('Escalate refunds over $500 to @finance-leads, see #12')).toBe('Escalate refunds over $500 to @\u2060finance-leads, see #\u206012');
    expect(await titleOf('::stop-commands::x\nApprove it\u202e')).toBe(':\u2060:stop-commands:\u2060:x Approve it');
    for (const raw of [...HOSTILE, 'a'.repeat(300), '@x '.repeat(200)]) {
      const title = await titleOf(raw);
      expect([...title].length, raw).toBeLessThanOrEqual(256);
      expect(title, raw).not.toMatch(/[\r\n\u202e\u200b]|@[A-Za-z0-9]|#\d|##\[|::|\bGH-\d/i);
    }
  });
});

describe('the pull request comment', () => {
  const auth = githubToken(ACTIONS);
  const marker = commentMarker({ workflow: 'CI', job: 'goldens', workdir: '.', recordings: 'goldens/*' });
  /** Who made a comment, as GitHub's REST API names them: a person, the job's own token's bot, another App's bot. */
  const ALICE = { login: 'alice', id: 1, type: 'User' };
  const ACTIONS_BOT = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
  const comment = (id: number, body: string, user: { login: string; id: number; type: string } = ALICE, app: string | null = null) => ({ id, body, user, performed_via_github_app: app ? { id: 15368, slug: app } : null, html_url: `https://github.test/northwind/agent/pull/12#issuecomment-${id}` });
  /** `GET /user` as GitHub answers it: a personal access token's owner, else 403 for an installation's token (the job's, an App's). */
  const user = (call: Call, owner: { login: string; id: number } | null = null) => (call.url.endsWith('/user') ? (owner ? { status: 200, json: owner } : { status: 403, json: { message: 'Resource not accessible by integration' } }) : null);
  const path = (c: Call) => `${c.method} ${c.url.replace('https://api.github.test/repos/northwind/agent', '').replace('https://api.github.test', '')}`;

  it('is made when the pull request has none, and edited in place when it has one, read a page at a time', async () => {
    const fresh = github((c) => (c.method === 'GET' ? { status: 200, json: [comment(1, 'Looks good')] } : { status: 201, json: comment(9, 'x', ACTIONS_BOT, 'github-actions') }));
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: `${marker}\nbody`, fetch: fresh.fetch })).toEqual({ state: 'created', url: 'https://github.test/northwind/agent/pull/12#issuecomment-9', why: null });
    expect(fresh.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.github.test/repos/northwind/agent/issues/12/comments?per_page=100&page=1', 'POST https://api.github.test/repos/northwind/agent/issues/12/comments']);
    expect(fresh.calls[1].body).toEqual({ body: `${marker}\nbody` });

    // The action's comment on the second page, past a hundred others, and a person's quoting the marker before it.
    const page1 = Array.from({ length: 100 }, (_, i) => comment(100 + i, i === 3 ? `> ${marker} quoted` : 'chat'));
    const kept = github((c) => user(c) ?? (c.method === 'GET' ? { status: 200, json: c.url.endsWith('page=1') ? page1 : [comment(300, `${marker}\nold`, ACTIONS_BOT, 'github-actions')] } : { status: 200, json: comment(300, 'x', ACTIONS_BOT, 'github-actions') }));
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: `${marker}\nnew`, fetch: kept.fetch })).toMatchObject({ state: 'updated', url: 'https://github.test/northwind/agent/pull/12#issuecomment-300' });
    // Who the token is, asked at the first comment that holds the marker (the person's), before the next page.
    expect(kept.calls.map(path)).toEqual(['GET /issues/12/comments?per_page=100&page=1', 'GET /user', 'GET /issues/12/comments?per_page=100&page=2', 'PATCH /issues/comments/300']);
  });

  it('finds its comment in a thread of any length: on the first page, else newest first, past fifty pages', async () => {
    /** A thread of `pages` pages of 100 comments, as GitHub serves it, with its last page named in the Link header; `at` puts the action's comment there. */
    const thread = (pages: number, at: { page: number; id: number } | null) =>
      github((c) => {
        const u = user(c);
        if (u) return u;
        if (c.method !== 'GET') return { status: 200, json: comment(at?.id ?? 1, 'x', ACTIONS_BOT, 'github-actions') };
        const n = Number(/[?&]page=(\d+)/.exec(c.url)![1]);
        const json = Array.from({ length: 100 }, (_, i) => (at && n === at.page && i === 42 ? comment(at.id, `${marker}\nold`, ACTIONS_BOT, 'github-actions') : comment(n * 1000 + i, 'chat')));
        return { status: 200, json, headers: n === 1 ? { link: `<https://api.github.test/repositories/1/issues/12/comments?per_page=100&page=2>; rel="next", <https://api.github.test/repositories/1/issues/12/comments?per_page=100&page=${pages}>; rel="last"` } : {} };
      });
    const pages = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url.includes('/comments')).map((c) => Number(/[?&]page=(\d+)/.exec(c.url)![1]));

    // On page 57 of 60, past the fifty pages read before: found from the newest end, and edited.
    const late = thread(60, { page: 57, id: 57_042 });
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: `${marker}\nnew`, fetch: late.fetch })).toMatchObject({ state: 'updated' });
    expect(late.calls.filter((c) => c.method !== 'GET').map(path)).toEqual(['PATCH /issues/comments/57042']);
    expect(pages(late.calls)).toEqual([1, 60, 59, 58, 57]);

    // On the first page of a long thread, where the first run put it: the first page alone is read.
    const early = thread(400, { page: 1, id: 1_042 });
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: `${marker}\nnew`, fetch: early.fetch })).toMatchObject({ state: 'updated' });
    expect(pages(early.calls)).toEqual([1]);

    // None at all: the first page and the 300 newest are read, then one is made.
    const none = thread(400, null);
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: `${marker}\nnew`, fetch: none.fetch })).toMatchObject({ state: 'created' });
    expect(pages(none.calls)).toEqual([1, ...Array.from({ length: 300 }, (_, i) => 400 - i)]);
  });

  it("never edits a comment the token didn't make, whatever it holds: a person's, or another App's bot's, that plants the marker", async () => {
    // The job's own token: the GitHub Actions bot's comment is its own; a person's and another App's bot's are not.
    const planted = [comment(5, `${marker}\nplanted`), comment(6, `${marker}\nplanted too`, { login: 'other-app[bot]', id: 77, type: 'Bot' }, 'other-app')];
    const theirs = github((c) => user(c) ?? (c.method === 'GET' ? { status: 200, json: planted } : { status: 201, json: comment(8, 'x', ACTIONS_BOT, 'github-actions') }));
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: 'b', fetch: theirs.fetch })).toMatchObject({ state: 'created' });
    expect(theirs.calls.map(path)).toEqual(['GET /issues/12/comments?per_page=100&page=1', 'GET /user', 'POST /issues/12/comments']);

    // A personal access token: its owner's comment, by login and id, and no one else's, a login that differs only in case and id included.
    const pat = githubToken({ ...ACTIONS, INPUT_GITHUB_TOKEN: 'github_pat_1' });
    const owned = [comment(10, `${marker}\nalice`), comment(11, `${marker}\nimpostor`, { login: 'Release-Bot', id: 99, type: 'User' }), comment(12, `${marker}\nmine`, { login: 'release-bot', id: 7, type: 'User' })];
    const mine = github((c) => user(c, { login: 'release-bot', id: 7 }) ?? (c.method === 'GET' ? { status: 200, json: owned } : { status: 200, json: owned[2] }));
    expect(await upsertComment({ env: ACTIONS, auth: pat, number: 12, marker, body: 'b', fetch: mine.fetch })).toMatchObject({ state: 'updated', url: 'https://github.test/northwind/agent/pull/12#issuecomment-12' });
    expect(mine.calls.map(path)).toEqual(['GET /issues/12/comments?per_page=100&page=1', 'GET /user', 'PATCH /issues/comments/12']);
    expect(mine.calls.at(-1)?.headers.authorization).toBe('Bearer github_pat_1');

    // A GitHub App's token, whose owner GitHub names only once it posts: posted again, and the App's earlier comment removed, a person's left.
    const app = githubToken({ ...ACTIONS, INPUT_GITHUB_TOKEN: 'ghs_app_installation_token' });
    const shadow = { login: 'shadow-app[bot]', id: 501, type: 'Bot' };
    const earlier = [comment(20, `${marker}\nolder`, shadow, 'shadow-app'), comment(21, `${marker}\nquoted by a person`), comment(22, `${marker}\nanother App's`, { login: 'other-app[bot]', id: 77, type: 'Bot' }, 'other-app')];
    const replaced = github((c) => user(c) ?? (c.method === 'GET' ? { status: 200, json: earlier } : c.method === 'POST' ? { status: 201, json: comment(23, 'new', shadow, 'shadow-app') } : { status: 204 }));
    expect(await upsertComment({ env: ACTIONS, auth: app, number: 12, marker, body: 'b', fetch: replaced.fetch })).toEqual({ state: 'created', url: 'https://github.test/northwind/agent/pull/12#issuecomment-23', why: null });
    expect(replaced.calls.map(path)).toEqual(['GET /issues/12/comments?per_page=100&page=1', 'GET /user', 'POST /issues/12/comments', 'DELETE /issues/comments/20']);
    // A person's token that GitHub won't name: posted again, and nothing removed.
    const quiet = github((c) => user(c) ?? (c.method === 'GET' ? { status: 200, json: [comment(30, `${marker}\nalice's own`)] } : { status: 201, json: comment(31, 'new') }));
    await upsertComment({ env: ACTIONS, auth: app, number: 12, marker, body: 'b', fetch: quiet.fetch });
    expect(quiet.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST']);
  });

  it('says so quietly when the token may not comment at all, and what GitHub answered otherwise', async () => {
    const denied = github(() => ({ status: 403, json: { message: 'Resource not accessible by integration' } }));
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: 'b', fetch: denied.fetch })).toEqual({ state: 'denied', url: null, why: "the job's token may not comment on the pull request: give the job pull-requests: write (GitHub answered 403 (Resource not accessible by integration))" });
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: 'b', fetch: github(() => ({ status: 502 })).fetch })).toEqual({ state: 'failed', url: null, why: 'GitHub answered 502' });
  });

  /**
   * A test report's result, a golden that replayed clean unless told otherwise. What it is told may
   * be part of what a report holds (a gate's figures and sentence, a divergence's call), as the
   * action reads no more of it.
   */
  const result = (over: Record<string, unknown>): ReportResult => ({ name: 'refund-flow', golden: 'goldens/refund-flow', dir: 'goldens/refund-flow', ok: true, verdict: 'passed', failure: null, message: null, runId: 'R1', runs: [{ runId: 'R1', ok: true, verdict: 'passed' }], ...over });
  const gated = (verdict: 'passed' | 'failed' | 'inconclusive') => ({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80, sentence: `${verdict} · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts` });

  it('says each golden\'s verdict in one line, as every report says it: the verdict word first, a gate\'s tally, bound and rule', () => {
    expect(verdictLine(result({}))).toBe('passed · replayed clean');
    expect(verdictLine(result({ mode: 'fork', divergence: { type: 'request_changed', callNo: 3 }, checks: [{ ok: true, label: 'a', detail: null, status: 'passed' }, { ok: true, label: 'b', detail: null, status: 'passed' }] }))).toBe('passed · forked at call 3 · 2 checks passed');
    expect(verdictLine(result({ gate: gated('passed') }))).toBe('passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts');
    expect(verdictLine(result({ ok: false, verdict: 'failed', gate: gated('failed'), message: 'failed · 3 of 12 · rate <= 0.56 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts' }))).toBe('failed · 3 of 12 · rate <= 0.56 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts');
    expect(verdictLine(result({ ok: false, verdict: 'failed', failure: 'check', message: 'check failed: issue_refund called 0 times, but called 1 time' }))).toBe('failed · check failed: issue_refund called 0 times, but called 1 time');
    expect(verdictLine(result({ ok: false, verdict: 'inconclusive', failure: 'injection', message: 'injection inconclusive: 5 of 5 attempts could not be judged' }))).toBe('inconclusive · injection inconclusive: 5 of 5 attempts could not be judged');
    // A report from before results had a verdict reads as ok says.
    expect(verdictLine({ name: 'x', ok: false, message: 'diverged at call 1 (api POST /v1/messages)' })).toBe('failed · diverged at call 1 (api POST /v1/messages)');
  });

  const session = (sessionId: string, revision: string | null, results: StoredSession['results'], endedAt: number | null = 2): StoredSession => ({ sessionId, startedAt: 1, endedAt, revision, results });
  const stored = (golden: string, verdict: 'passed' | 'failed' | 'inconclusive', data: Record<string, unknown> = {}) => ({ golden, ok: verdict === 'passed', failure: verdict === 'passed' ? null : 'check', reason: null, data: { verdict, ...data } });

  it("compares with the base branch's last session: one that names the branch, else one at the base commit, never this one or a dirty tree's", () => {
    const history = [
      session('S-NOW', 'abc1234', [stored('goldens/refund-flow', 'failed')]),
      session('S-RUNNING', 'f00ba12', [stored('goldens/refund-flow', 'passed')], null),
      session('S-DIRTY', 'e5f6a7b+dirty', [stored('goldens/refund-flow', 'passed')]),
      session('S-FEATURE', '1111111', [stored('goldens/refund-flow', 'passed', { branch: 'feature' })]),
      session('S-MAIN-COMMIT', 'e5f6a7b', [stored('goldens/refund-flow', 'passed')]),
      session('S-MAIN', '2222222', [stored('goldens/refund-flow', 'inconclusive', { branch: 'main' })]),
    ];
    expect(baseSession(history, { baseRef: 'main', baseSha: 'e5f6a7b8c9', current: 'S-NOW' })?.sessionId).toBe('S-MAIN');
    expect(baseSession(history.filter((s) => s.sessionId !== 'S-MAIN'), { baseRef: 'main', baseSha: 'e5f6a7b8c9', current: 'S-NOW' })?.sessionId).toBe('S-MAIN-COMMIT');
    expect(baseSession(history, { baseRef: 'release', baseSha: '9999999999', current: 'S-NOW' })).toBeNull();
    expect(baseSession(null, { baseRef: 'main', baseSha: null, current: null })).toBeNull();
  });

  it('reads the test history from the store as it is, changing nothing, and nothing from a store that is not there', () => {
    const dir = temp('sl-history-');
    const db = join(dir, 'shadowlap.db');
    const store = Store.open(db);
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'e5f6a7b' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/refund-flow', ok: true, revision: 'e5f6a7b', data: { mode: 'replay', verdict: 'passed' } });
    store.finishTestSession(s.sessionId, { passed: 1, failed: 0, upstreamRequests: 0 });
    store.close();
    const history = readHistory(db)!;
    expect(history).toEqual([{ sessionId: s.sessionId, startedAt: s.startedAt, endedAt: expect.any(Number), revision: 'e5f6a7b', results: [{ golden: 'goldens/refund-flow', ok: true, failure: null, reason: null, data: { mode: 'replay', verdict: 'passed' } }] }]);
    expect(readHistory(join(dir, 'none.db'))).toBeNull();
    expect(readHistory(':memory:')).toBeNull();
    expect(readdirSync(dir).filter((f) => f.startsWith('none'))).toEqual([]);
  });

  const report = {
    session: 'S-NOW',
    results: [
      result({ name: 'refund|flow', golden: 'goldens/refund|flow', ok: false, verdict: 'failed', failure: 'check', message: 'check failed: issue_refund called 0 times, but called 1 time' }),
      result({ name: 'triage', golden: 'goldens/triage' }),
      result({ name: 'new-one', golden: 'goldens/new-one', gate: gated('passed') }),
    ],
  };

  it("lists each golden with its verdict line, and how it did on the base branch when the history has its last session there", () => {
    const base = baseSession([session('S-MAIN', 'e5f6a7b', [stored('goldens/refund|flow', 'passed', { branch: 'main' }), stored('goldens/triage', 'failed')])], { baseRef: 'main', baseSha: null, current: 'S-NOW' });
    const body = commentBody({ report, marker, base, baseRef: 'main', fixes: [{ name: 'refund|flow', golden: 'goldens/refund|flow', outcome: 'opened', pr: 'https://github.test/northwind/agent/pull/13', title: 'Escalate refunds above the policy limit', why: null, spent: 1 }], runUrl: 'https://github.test/northwind/agent/actions/runs/7' });
    expect(body.split('\n')).toEqual([
      marker,
      '### Shadowlap: 1 of 3 goldens failed',
      '',
      '| | Golden | Verdict | On `main` |',
      '|---|---|---|---|',
      // A pipe in a golden's name, escaped in its code span as a table needs, would otherwise end the cell.
      '| ❌ | `goldens/refund\\|flow` | failed · check failed: issue_refund called 0 times, but called 1 time | ✅ passed |',
      '| ✅ | `goldens/triage` | passed · replayed clean | ❌ failed |',
      '| ✅ | `goldens/new-one` | passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts | not tested |',
      '',
      'Compared with `main` as the test history last tested it, at `e5f6a7b`.',
      '',
      'Fix on failure opened https://github.test/northwind/agent/pull/13 for `goldens/refund|flow`: Escalate refunds above the policy limit.',
      '',
      "[The job's summary](https://github.test/northwind/agent/actions/runs/7) has each failure in full.",
      '',
    ]);
    // A fix of goldens repaired together names each as code, none of them escaped as a table's cell is.
    const together = commentBody({ report, marker, fixes: [{ name: 'a, b|c', golden: 'goldens/a, goldens/b|c', outcome: 'opened', pr: 'https://github.test/northwind/agent/pull/14', title: 'Ask before refunding', why: null, spent: 1 }] });
    expect(together).toContain('for `goldens/a`, `goldens/b|c`: Ask before refunding.');
    // Without that history, no column for it.
    const alone = commentBody({ report, marker });
    expect(alone).toContain('| | Golden | Verdict |\n|---|---|---|\n');
    expect(alone).not.toContain('On `');
    // Within GitHub's limit: the rows that fit, and how many more the job summary lists.
    const many = { session: 'S', results: Array.from({ length: 400 }, (_, i) => result({ name: `g${i}`, golden: `goldens/golden-number-${i}` })) };
    const cut = commentBody({ report: many, marker, longest: 5_000 });
    expect(cut.length).toBeLessThanOrEqual(5_000);
    expect(cut).toMatch(/\| \| … \| \d+ more in the job summary \|/);
  });

  it('writes the verdict the stored history holds as the text it is, as it writes every other: a job restores that history from a cache', () => {
    const planted = '@octocat approves: ![x](https://evil.example/t.png) <img src=x> [click](https://evil.example) #12 | ok';
    const history = [session('S-MAIN', 'e5f6a7b', [{ ...stored('goldens/refund|flow', 'passed', { branch: 'main' }), data: { verdict: planted, branch: 'main' } }, { ...stored('goldens/triage', 'passed'), data: { verdict: 'constructor' } }])];
    const body = commentBody({ report, marker, base: baseSession(history, { baseRef: 'main', baseSha: null, current: 'S-NOW' }), baseRef: 'main' });
    const rows = body.split('\n').filter((l) => l.startsWith('| ❌') || l.startsWith('| ✅'));
    // With no mark: none is a verdict any report makes, nor is an object's own name one.
    expect(rows[0].endsWith(`|  ${markdownText(planted)} |`)).toBe(true);
    expect(rows[1].endsWith('|  constructor |')).toBe(true);
    // Its pipe ends no cell: each row has its four.
    for (const row of rows) expect(row.split(/(?<!\\)\|/).length, row).toBe(6);
    for (const shown of ['@octocat', '![x]', '<img', '[click]', '#12']) expect(body).not.toContain(shown);
  });

  it('is what docs/ci.md shows', () => {
    const page = readFileSync(join(ROOT, 'docs', 'ci.md'), 'utf8');
    const shown = /As Markdown, before GitHub renders it:\n\n```markdown\n([\s\S]*?)```/.exec(page)?.[1];
    expect(shown).toBeDefined();
    const sample = {
      session: 'S',
      results: [
        result({ name: 'refund-flow', golden: 'goldens/refund-flow', ok: false, verdict: 'failed', failure: 'check', message: 'check failed: issue_refund called 0 times, but called 1 time' }),
        result({ name: 'triage-inbox', golden: 'goldens/triage-inbox' }),
        result({ name: 'refund-gated', golden: 'goldens/refund-gated', gate: gated('passed') }),
      ],
    };
    const base = baseSession([session('M', 'e5f6a7b', [stored('goldens/refund-flow', 'passed', { branch: 'main' }), stored('goldens/triage-inbox', 'passed')])], { baseRef: 'main', baseSha: null, current: 'S' });
    expect(commentBody({ report: sample, marker: shown!.split('\n')[0], base, baseRef: 'main' })).toBe(shown);
  });

  it('is posted on the pull request the job runs for, compared with the base branch from the store, and never on a fork\'s, which may not comment', async () => {
    const dir = temp('sl-comment-');
    const db = join(dir, 'shadowlap.db');
    const store = Store.open(db);
    const s = store.startTestSession({ command: ['shadowlap', 'test'], revision: 'e5f6a7b' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/triage', ok: true, revision: 'e5f6a7b', data: { verdict: 'passed' } });
    store.finishTestSession(s.sessionId, { passed: 1, failed: 0, upstreamRequests: 0 });
    store.close();
    const event = (head: string) => {
      const path = join(dir, `${head.replace('/', '-')}.json`);
      writeFileSync(path, JSON.stringify({ pull_request: { number: 12, head: { repo: { full_name: head } }, base: { ref: 'main', sha: 'e5f6a7b8c9d0', repo: { full_name: 'northwind/agent' } } } }));
      return path;
    };
    const env = { ...ACTIONS, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event('northwind/agent'), GITHUB_SERVER_URL: 'https://github.test', GITHUB_RUN_ID: '7', GITHUB_WORKFLOW: 'CI', GITHUB_JOB: 'goldens' };
    expect(pullRequestOf(env)).toEqual({ number: 12, baseRef: 'main', baseSha: 'e5f6a7b8c9d0' });
    const gh = github((c) => (c.method === 'GET' ? { status: 200, json: [] } : { status: 201, json: { id: 1, html_url: 'https://github.test/c/1' } }));
    const posted = await postComment({ env, auth, report, store: db, recordings: 'goldens/*', workdir: '.', fetch: gh.fetch });
    expect(posted).toEqual({ state: 'created', url: 'https://github.test/c/1', why: null });
    const body = (gh.calls[1].body as { body: string }).body;
    expect(body.startsWith(marker)).toBe(true);
    expect(body).toContain('| ✅ | `goldens/triage` | passed · replayed clean | ✅ passed |');
    expect(body).toContain('as the test history last tested it, at `e5f6a7b`');
    expect(commentNote(posted)).toBe('');

    // A fork's pull request: nothing is asked of GitHub, and the summary says why, without a warning.
    const fork = github(() => ({ status: 500 }));
    const skipped = await postComment({ env: { ...env, GITHUB_EVENT_PATH: event('someone/agent') }, auth, report, store: db, recordings: 'goldens/*', workdir: '.', fetch: fork.fetch });
    expect(skipped).toEqual({ state: 'skipped', url: null, why: 'a pull request from a fork gets a token from GitHub that may not comment on it' });
    expect(fork.calls).toEqual([]);
    expect(commentNote(skipped)).toBe('\nThe pull request comment was not posted: a pull request from a fork gets a token from GitHub that may not comment on it.\n');
    // Not a pull request's job: no comment, and nothing said.
    expect(await postComment({ env: { ...env, GITHUB_EVENT_NAME: 'push' }, auth, report, store: db, recordings: 'goldens/*', workdir: '.', fetch: fork.fetch })).toEqual({ state: 'none', url: null, why: null });
    expect(commentNote({ state: 'none', url: null, why: null })).toBe('');
  });
});

describe('what a fix is verified on', () => {
  const failing = (name: string, expect: Record<string, unknown>, over: Record<string, unknown> = {}): ReportResult => ({ name, golden: `goldens/${name}`, dir: `goldens/${name}`, ok: false, verdict: 'failed', failure: 'check', runId: `${name}-1`, runs: [{ runId: `${name}-1`, ok: false, verdict: 'failed' }, { runId: `${name}-2`, ok: false, verdict: 'failed' }], expect, ...over });
  const passing = (name: string, expect: Record<string, unknown> | null): ReportResult => ({ name, golden: `goldens/${name}`, dir: `goldens/${name}`, ok: true, verdict: 'passed', failure: null, runId: `${name}-1`, runs: [{ runId: `${name}-1`, ok: true, verdict: 'passed' }], expect });
  const NO_REFUND = { tools: { issue_refund: 0 } };
  const NO_EMAIL = { tools: { send_email: 0 } };

  it('holds out every other golden that fails the same check, keeps the goldens that passed it, and shows one failing replay of each', () => {
    const results = [failing('a', NO_REFUND), passing('ok-1', NO_REFUND), failing('b', { tools: { issue_refund: 0 } }), failing('c', NO_REFUND), passing('ok-2', NO_REFUND), passing('other', NO_EMAIL), passing('ok-3', NO_REFUND), passing('ok-4', NO_REFUND), failing('d', NO_EMAIL)];
    const groups = groupFixes(planFixes({ results }));
    expect(groups.map((g) => g.members.map((m) => m.result.name))).toEqual([['a', 'b', 'c'], ['d']]);
    const plan = repairPlan(groups[0].members, results);
    expect(plan).toMatchObject({ fixes: ['a-1', 'c-1'], holdout: ['b-1'], keeps: ['ok-1-1', 'ok-2-1'], goldens: { shown: ['goldens/a', 'goldens/c'], heldOut: ['goldens/b'], kept: ['goldens/ok-1', 'goldens/ok-2'] }, gate: null });
    expect(KEEPS_AT_MOST).toBe(2);
    expect(repairArgs(plan, { db: null, budget: 6, repairer: '', expectFile: '/tmp/expect.json' })).toEqual(['repair', '--fixes', 'a-1', 'c-1', '--holdout', 'b-1', '--keeps', 'ok-1-1', 'ok-2-1', '--expect', '@/tmp/expect.json', '--budget', '6', '--guard', 'block', '--branch', expect.stringMatching(/^shadowlap\/fix-a-/), '--yes', '--json']);
    // The step's network guard, as its test ran under it, and its build for the agent once a fix is in.
    const args = repairArgs(plan, { db: null, budget: 6, repairer: '', expectFile: '/tmp/expect.json', guard: 'warn', build: 'npm run build' });
    expect(args.slice(args.indexOf('--guard'), args.indexOf('--guard') + 4)).toEqual(['--guard', 'warn', '--build', 'npm run build']);
    // A golden alone under its check has nothing to hold out; one that passed the check is still kept.
    expect(repairPlan(groups[1].members, results)).toMatchObject({ fixes: ['d-1'], holdout: [], keeps: ['other-1'], goldens: { shown: ['goldens/d'], heldOut: [], kept: ['goldens/other'] } });
    const lonely = [failing('e', { tools: { delete_thread: 0 } }), ...results];
    expect(repairPlan(groupFixes(planFixes({ results: lonely }))[0].members, lonely)).toMatchObject({ fixes: ['e-1'], holdout: [], keeps: [], goldens: { shown: ['goldens/e'], heldOut: [], kept: [] } });
  });

  it("decides each run by the failing golden's own gate: its figures, its fixed count, or verify's default for one against history", () => {
    const sprt = { kind: 'sprt', good: 0.95, bad: 0.8, risk: 0.01, max: 200, sentence: 'failed · …' };
    expect(goldenGate(failing('a', NO_REFUND, { gate: sprt }))).toEqual({ kind: 'sprt', good: 0.95, bad: 0.8, risk: 0.01, max: 200 });
    expect(goldenGate(failing('a', NO_REFUND, { attempts: { total: 5, passed: 3, required: 4 } }))).toEqual({ kind: 'count', attempts: 5, passes: 4 });
    expect(goldenGate(failing('a', NO_REFUND, { gate: { kind: 'baseline', drop: 0.1 } }))).toEqual({ kind: 'history' });
    expect(goldenGate(failing('a', NO_REFUND))).toBeNull();
    const results = [failing('a', NO_REFUND, { gate: sprt })];
    const plan = repairPlan(groupFixes(planFixes({ results }))[0].members, results);
    expect(repairArgs(plan, { db: null, budget: 2, repairer: 'claude-code', expectFile: '/e.json', gateFile: '/g.json' })).toEqual(expect.arrayContaining(['--gate', '@/g.json']));
    const counted = [failing('a', NO_REFUND, { attempts: { total: 5, passed: 3, required: 4 } })];
    expect(repairArgs(repairPlan(groupFixes(planFixes({ results: counted }))[0].members, counted), { db: null, budget: 2, repairer: '', expectFile: '/e.json' }).join(' ')).toContain('--attempts 5 --passes 4');
  });

  it('says in the pull request what the fix was verified on, and that it was the failing golden alone when it was', () => {
    const alone = evidenceNote({ goldens: { shown: ['goldens/refund-flow'], heldOut: [], kept: [] }, gate: null });
    expect(alone).toContain('Only on `goldens/refund-flow`, whose failing replay was shown to the repairer: no other golden the session tested fails the same check to hold out from it, and none passed it to keep. That the fix holds for a case the repairer did not see is not tested here.');
    const wide = evidenceNote({ goldens: { shown: ['goldens/a'], heldOut: ['goldens/b', 'goldens/c'], kept: ['goldens/ok'] }, gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 } });
    expect(evidenceNote({ goldens: { shown: ['goldens/a'], heldOut: [], kept: [] }, gate: { kind: 'sprt', good: 0.95, bad: 0.8, risk: 0.005, max: 200 } })).toContain("it tells 95%+ from 80%- at <= 0.5% risk, up to 200 attempts.");
    expect(wide).toContain('Shown to the repairer: `goldens/a`, its failing replay.');
    expect(wide).toContain('Held out from it: `goldens/b` and `goldens/c`, which fail the same check, and which the fix repairs too.');
    expect(wide).toContain('Kept: `goldens/ok`, which passed the same check, and still passes it under the fix.');
    expect(wide).toContain("Each was decided by the golden's own gate: it tells 90%+ from 70%- at <= 5% risk, up to 80 attempts.");
    expect(evidenceNote({ goldens: { shown: ['goldens/a'], heldOut: [], kept: ['goldens/ok'] }, gate: { kind: 'history' } })).toContain("verify's default gate");
  });

  it('says how the pull request\'s checks start, and never that they pass', () => {
    const notes = [
      checksNote({ auth: githubToken({ ...ACTIONS, INPUT_GITHUB_TOKEN: 'github_pat_1' }) }),
      checksNote({ auth: githubToken(ACTIONS), dispatch: { dispatched: true, workflow: 'ci.yml', why: null } }),
      checksNote({ auth: githubToken(ACTIONS), dispatch: { dispatched: false, workflow: 'ci.yml', why: 'ci.yml has no workflow_dispatch trigger' } }),
    ];
    expect(notes[0]).toContain('opened with the token the action was given (`github-token`), so GitHub starts its workflows as for any pull request');
    expect(notes[1]).toContain("opened with the job's `GITHUB_TOKEN`, for which GitHub starts no workflow, so the job started `ci.yml` on its branch (`workflow_dispatch`)");
    expect(notes[2]).toContain('the job could not start `ci.yml` on its branch: ci.yml has no workflow_dispatch trigger. No check has run on this branch');
    for (const n of notes) expect(n).not.toMatch(/checks? pass/);
  });

  /** The workflow's repository, as the runner names it, and a checkout of it on a branch. */
  const REPO = { GITHUB_SERVER_URL: 'https://github.test', GITHUB_REPOSITORY: 'northwind/agent' };
  const checkout = (prefix: string, branch: string) => {
    const repo = temp(prefix);
    execFileSync('git', ['init', '-q', '-b', branch], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'agent'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.test/northwind/agent.git'], { cwd: repo });
    return repo;
  };

  it("opens no fix from a fork's pull request, whatever it checked out: its token may not push, and its branch is the fork's", () => {
    const repo = checkout('sl-fix-fork-', 'main');
    const event = join(repo, 'event.json');
    const pr = (head: string) => JSON.stringify({ pull_request: { number: 12, head: { ref: 'main', repo: { full_name: head } }, base: { ref: 'main', repo: { full_name: 'northwind/agent' } } } });
    const env = { ...process.env, ...REPO, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event };
    writeFileSync(event, pr('someone/agent'));
    expect(cannotFix(repo, env)).toBe("a pull request from a fork gets a token from GitHub that may not push a branch, and its branch is the fork's, so no fix is opened from its job");
    writeFileSync(event, pr('northwind/agent'));
    expect(cannotFix(repo, env)).toBeNull();
    // Detached, as a pull request's job is unless it checks out its branch: the checkout that gives it its branch.
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repo });
    expect(cannotFix(repo, env)).toBe('HEAD is detached, so there is no branch to open a fix against: check out the branch itself (on pull requests, actions/checkout with ref: ${{ github.event.pull_request.head.repo.full_name == github.repository && github.head_ref || github.ref }})');
  });

  it('opens no fix from the branch of a fix it opened', () => {
    const repo = checkout('sl-fix-branch-', 'shadowlap/fix-refund-flow-t9rb1d');
    const env = { ...process.env, ...REPO };
    expect(cannotFix(repo, env)).toBe('shadowlap/fix-refund-flow-t9rb1d is the branch of a fix this action opened: its checks say whether the fix holds, and no fix is opened from it');
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: repo });
    expect(cannotFix(repo, env)).toBeNull();
  });

  it("opens no fix from a merge queue's branch, which goes once its group merges or leaves the queue", () => {
    // As actions/checkout checks out a merge_group job's ref.
    const repo = checkout('sl-fix-queue-', 'gh-readonly-queue/main/pr-12-7d1c0b5e9f3a2468ace0bdf13579bdf02468ace0');
    expect(cannotFix(repo, { ...process.env, ...REPO, GITHUB_EVENT_NAME: 'merge_group' })).toBe("gh-readonly-queue/main/pr-12-7d1c0b5e9f3a2468ace0bdf13579bdf02468ace0 is a merge queue's branch, which GitHub deletes once its group merges or leaves the queue, so no fix is opened against it");
  });

  it("opens no fix, before anything is spent, where it couldn't push one: a checkout of another repository, or a job that names none", () => {
    const repo = checkout('sl-fix-origin-', 'main');
    expect(cannotFix(repo, { ...process.env, ...REPO })).toBeNull();
    expect(cannotFix(repo, { ...process.env, ...REPO, GITHUB_REPOSITORY: 'northwind/other' })).toBe("the checkout's origin is not northwind/other, the repository this workflow runs in, so no fix is pushed from it");
    expect(cannotFix(repo, { ...process.env, GITHUB_SERVER_URL: undefined, GITHUB_REPOSITORY: undefined })).toMatch(/^the job doesn't name the repository it runs in \(GITHUB_SERVER_URL and GITHUB_REPOSITORY\), so no fix is pushed from it/);
  });
});

describe("the step's outputs", () => {
  it('names each output once, as action.yml declares them, and counts inconclusive goldens by their verdict', () => {
    const results = [
      { name: 'a', ok: false, verdict: 'failed', failure: 'check' },
      { name: 'b', ok: true, verdict: 'inconclusive', failure: 'inconclusive' },
      { name: 'c', ok: false, verdict: 'inconclusive', failure: 'check' },
      { name: 'd', ok: false, verdict: 'failed', failure: 'diverged' },
    ] as ReportResult[];
    // `inconclusive` in the report counts what it counts; the output is every inconclusive verdict.
    const outputs = outputsOf({ passed: 1, failed: 3, session: 'S', results, inconclusive: 0 } as never, [{ name: 'a', outcome: 'opened', pr: 'https://x/pull/1', why: null, spent: 1 }, { name: 'd', outcome: 'skipped', pr: null, why: 'w', spent: 0 }], { json: '/r.json', markdown: '/r.md', junit: '/j.xml' });
    expect(outputs).toEqual({ passed: 1, failed: 3, inconclusive: 2, diverged: 1, 'checks-failed': 1, session: 'S', fixes: 1, 'fix-prs': 'https://x/pull/1', 'report-json': '/r.json', 'report-markdown': '/r.md', junit: '/j.xml' });
    const yml = readFileSync(join(ROOT, 'action.yml'), 'utf8');
    const declared = [...yml.slice(yml.indexOf('\noutputs:'), yml.indexOf('\nruns:')).matchAll(/^ {2}([a-z-]+):/gm)].map((m) => m[1]);
    expect(Object.keys(outputs).sort()).toEqual([...declared].sort());
  });

  it("are written by scripts that name no key twice in one object, which JavaScript lets the last one win", () => {
    const repeated: string[] = [];
    for (const file of readdirSync(join(ROOT, 'action')).filter((f) => f.endsWith('.mjs'))) {
      const source = ts.createSourceFile(file, readFileSync(join(ROOT, 'action', file), 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isObjectLiteralExpression(node)) {
          const seen = new Set<string>();
          for (const p of node.properties) {
            const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
            if (!name) continue;
            if (seen.has(name)) repeated.push(`${file}: ${name} (line ${source.getLineAndCharacterOfPosition(p.getStart()).line + 1})`);
            seen.add(name);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(repeated).toEqual([]);
  });
});

describe('the inputs in action.yml', () => {
  const yml = readFileSync(join(ROOT, 'action.yml'), 'utf8');

  it('declares github-token, comment, build-from-source and fix-build, and passes the tokens to the step that keeps them from the CLI', () => {
    for (const input of ['github-token:', 'comment:', 'build-from-source:', 'fix-build:']) expect(yml).toContain(`\n  ${input}\n    description:`);
    expect(yml).toContain('INPUT_FIX_BUILD: ${{ inputs.fix-build }}');
    expect(yml).not.toMatch(/GH_TOKEN/);
    expect(yml).toContain("\n  comment:\n    description: On a pull request, keep one comment on it with each golden's verdict line");
    expect(yml).toMatch(/\n {2}comment:\n {4}description: [^\n]*\n {4}default: 'true'\n/);
    expect(yml).toContain('INPUT_GITHUB_TOKEN: ${{ inputs.github-token }}');
    expect(yml).toContain('SHADOWLAP_JOB_TOKEN: ${{ github.token }}');
    expect(yml).toContain('INPUT_COMMENT: ${{ inputs.comment }}');
    // The CLI comes from npm unless the step asks for a source build.
    expect(yml).toContain("id: install\n      if: inputs.build-from-source != 'true'");
    expect(yml).toContain("id: build\n      if: inputs.build-from-source == 'true'");
  });
});

describe("what the Action writes to the job's log", () => {
  // The runner reads a line whose text starts with `::` (or `##[`) as a workflow command: an annotation,
  // add-mask, or stop-commands, which silences the action's own warnings after it.
  const nel = String.fromCharCode(0x85);

  it('keeps what a run, a model, git or GitHub wrote on its one line, and never at the start of one as a command', () => {
    const planted = "refund_blocked: A-1042\n::error::x\n::stop-commands::t";
    expect(commandText(planted)).toBe('refund_blocked: A-1042%0A::error::x%0A::stop-commands::t');
    expect(logLine(`refund-flow: no fix pull request: ${planted}`)).toBe('refund-flow: no fix pull request: refund_blocked: A-1042%0A::error::x%0A::stop-commands::t');
    expect(logLine('100% done\r\n::stop-commands::t')).toBe('100%25 done%0D%0A::stop-commands::t');
    // A line that would itself start one: past the spaces the runner trims, NEL among them.
    expect(logLine('::error::x: no fix pull request')).toBe('%3A:error::x: no fix pull request');
    expect(logLine('  ::add-mask::y')).toBe('  %3A:add-mask::y');
    expect(logLine(`${nel}::warning::y`)).toBe(`${nel}%3A:warning::y`);
    expect(logLine('##[error]w')).toBe('%23#[error]w');
    // The older form is read anywhere in a line: each `##[` is escaped wherever it is; a `::` past the start makes nothing.
    expect(logLine('a :: b ##[ c')).toBe('a :: b %23#[ c');
    expect(logLine('mid ##[error]legacy ##[warning]twice')).toBe('mid %23#[error]legacy %23#[warning]twice');
    // The action's own annotations: its title, what they say as their data.
    expect(annotation('warning', `refund-flow: ${planted}`)).toBe('::warning title=Shadowlap::refund-flow: refund_blocked: A-1042%0A::error::x%0A::stop-commands::t');
    expect(pushLine('refund-flow', { state: 'off', why: planted, pr: null })).toBe('the fix was not sent to the team store: refund_blocked: A-1042%0A::error::x%0A::stop-commands::t');
  });

  it("passes another program's lines on as they are, but none of them as a command", () => {
    expect(logLines('repairing\n::error::x\r\n  ::stop-commands::t\n##[group]g\nlast')).toBe('repairing\n%3A:error::x\r\n  %3A:stop-commands::t\n%23#[group]g\nlast');
    expect(logLines('one\rtwo ::x::')).toBe('one\rtwo ::x::');
    expect(logLines('repair log line\nmid ##[error]legacy mid-line')).toBe('repair log line\nmid %23#[error]legacy mid-line');
  });
});

describe("what the Action posts, in the Markdown GitHub renders", () => {
  it("escapes as the engine's pull request body does, case for case", () => {
    for (const raw of HOSTILE) {
      expect(markdownText(raw), raw).toBe(engineText(raw));
      expect(markdownCode(raw), raw).toBe(engineCode(raw));
      expect(markdownCode(raw, { cell: true }), raw).toBe(engineCode(raw, { cell: true }));
      expect(markdownFence(raw, 'sh'), raw).toBe(engineFence(raw, 'sh'));
    }
  });

  it("titles its fix's pull request as the engine titles repair --pr's, case for case", () => {
    for (const raw of [...HOSTILE, ...HOSTILE_TITLES]) expect(titleText(raw), raw).toBe(engineTitle(raw));
  });

  /** What GitHub would render, link or mention in Markdown, outside fenced blocks and code spans. */
  const live = (md: string) => {
    const text = md.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '').replace(/(`+)[^`]*?\1/g, '');
    return [/!\[|\]\(/, /<img|<svg|<a /i, /@(?:alice|security)/, /https?:\/\//, /(?<!&)#1\b/].filter((re) => re.test(text)).map(String);
  };
  const planted = 'check failed: send_email with {"to":"@alice ![x](https://evil.example/t.png) <img src=x> #1"}';

  it('makes nothing of what a run, the repairer or GitHub wrote, in the comment, the pull request and the job summary', () => {
    const marker = commentMarker({ workflow: 'CI', job: 'goldens', workdir: '.', recordings: 'goldens/*' });
    const report = { session: 'S', results: [{ name: 'refund-flow', golden: 'goldens/refund-flow', dir: 'goldens/refund-flow', ok: false, verdict: 'failed' as const, failure: 'check' as const, message: planted, runId: 'R1', runs: [] }] };
    const fix = { name: 'refund-flow', golden: 'goldens/refund-flow', outcome: 'opened' as const, pr: 'https://github.test/northwind/agent/pull/13', title: 'Ask @security first, see [docs](https://evil.example)', why: null, spent: 1 };
    const comment = commentBody({ report, marker, fixes: [fix] });
    expect(live(comment)).toEqual([String(/https?:\/\//)]);
    // The one link is the pull request's own, which the Action wrote.
    expect(comment.match(/https?:\/\//g)).toHaveLength(1);
    expect(comment).toContain('https://github.test/northwind/agent/pull/13');

    // A run's message reaches a golden's note through refreshGoldens, which escapes it at the source; the notes show the safe why as it is.
    const safe = markdownText(planted);
    const pr = [goldenNote({ state: 'stale', golden: 'goldens/refund-flow', why: `the recording verify accepted does not replay clean on the branch (${safe})` }), branchNote({ goldens: [{ state: 'recorded', golden: 'goldens/a', why: null }], others: { diverging: [], failing: [], unreplayed: [], unchecked: ['goldens/c'], replayed: 0 }, checked: false, why: safe }), checksNote({ auth: githubToken(ACTIONS), dispatch: { dispatched: false, workflow: 'ci.yml', why: planted } })].join('\n');
    expect(live(pr)).toEqual([]);
    // The note on a golden the fix was not verified for carries repair's why for the goldens together, as text.
    const leftOut = goldenNote({ state: 'unfixed', golden: 'goldens/refund-vip', why: leftOutWhy(['goldens/refund-flow', 'goldens/refund-vip'], planted, ['goldens/refund-flow']) });
    expect(leftOut).toContain(`no fix was accepted for \`goldens/refund-flow\` and \`goldens/refund-vip\` together (${safe}), and this one was verified for \`goldens/refund-flow\` alone.`);
    expect(live(leftOut)).toEqual([]);
    // A golden's name is a code span its own backtick can't end.
    expect(leftOutWhy(['goldens/a`b', 'goldens/c'], 'the gate accepted none of the 2 candidates tried', ['goldens/a`b'])).toBe('no fix was accepted for ``goldens/a`b`` and `goldens/c` together (the gate accepted none of the 2 candidates tried), and this one was verified for ``goldens/a`b`` alone');

    // The summary's untrusted leaves: the repairer's title, a fix's why, which can hold a check's label, a run's message or
    // an error repair or GitHub gave, a golden's name, and an external store's or GitHub's error.
    const unfixed = { state: 'unfixed' as const, golden: 'goldens/@alice-[x](https://evil.example)', why: null };
    const summary = fixSummary(
      [
        { ...fix, title: 'Ask @security, see [docs](https://evil.example)', goldenStates: [{ state: 'recorded' as const, golden: 'goldens/refund-flow', why: null }, unfixed] },
        { ...fix, name: 'x', outcome: 'no-fix', pr: null, why: `the repairer could not be asked: ${planted}`, pushed: { state: 'off', why: planted, pr: null } },
        { ...fix, name: 'z', outcome: 'skipped', pr: null, why: `a check is inconclusive (${planted}), which no prompt fix decides` },
        { ...fix, name: 'y', checks: { state: 'not-started', workflow: 'ci.yml', why: planted } },
      ],
      2,
    );
    expect(summary).toContain(`| ➖ | \`z\` | a check is inconclusive (${safe}), which no prompt fix decides |  |`);
    expect(summary).toContain(' · goldens/refund-flow re-recorded · goldens/@<span></span>alice-&#91;x&#93;(https:<span></span>//evil.example) fails the same check');
    // The repairer's title, escaped, is the link text of the fix's own pull request.
    expect(summary).toContain(`[Ask @<span></span>security, see &#91;docs&#93;(https:<span></span>//evil.example)](${fix.pr})`);
    // With the fixes' own pull request links taken out, nothing else renders, links or mentions.
    const ours = summary.replace(/\[([^\]]*)\]\(https:\/\/github\.test\/northwind\/agent\/pull\/13\)/g, '$1');
    expect(live(ours)).toEqual([]);
    expect(commentNote({ state: 'denied', url: null, why: planted })).not.toMatch(/!\[|<img|@alice|(?<!&)#1\b|https?:\/\//);
  });
});
