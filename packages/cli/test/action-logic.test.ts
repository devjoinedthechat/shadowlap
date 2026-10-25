import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { baseSession, commentBody, commentMarker, commentNote, postComment, readHistory, verdictLine, type StoredSession } from '../../../action/comment.mjs';
import { cannotFix, checksNote, evidenceNote, goldenGate, groupFixes, KEEPS_AT_MOST, planFixes, repairArgs, repairPlan, type ReportResult } from '../../../action/fix.mjs';
import { dispatchWorkflow, githubToken, pullRequestOf, tokenEnv, upsertComment, withoutTokens, workflowFile, type Fetch } from '../../../action/github.mjs';
import { outputsOf } from '../../../action/run.mjs';

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

/** A stand-in for fetch: `answer` gives each call's status and JSON; every call is kept. */
function github(answer: (call: Call) => { status: number; json?: unknown } | Error) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const call = { method: init.method, url, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const a = answer(call);
    if (a instanceof Error) throw a;
    return { status: a.status, text: async () => (a.json === undefined ? '' : JSON.stringify(a.json)) };
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

  it("gives git the token's own Authorization header in place of the job's that checkout left, through the environment, and gh the token", async () => {
    const auth = githubToken({ ...ACTIONS, INPUT_GITHUB_TOKEN: 'github_pat_1' });
    const env = tokenEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', GITHUB_SERVER_URL: 'https://github.test' }, auth);
    expect(env).toMatchObject({ GH_TOKEN: 'github_pat_1', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_KEY_1: 'http.https://github.test/.extraheader', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'http.https://github.test/.extraheader' });
    expect(Buffer.from(env.GIT_CONFIG_VALUE_2!.replace('AUTHORIZATION: basic ', ''), 'base64').toString()).toBe('x-access-token:github_pat_1');
    // The job's own token is what checkout left already: only gh is given it.
    const job = tokenEnv({}, githubToken(ACTIONS));
    expect(job).toEqual({ GH_TOKEN: JOB });

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

describe('the pull request comment', () => {
  const auth = githubToken(ACTIONS);
  const marker = commentMarker({ workflow: 'CI', job: 'goldens', workdir: '.', recordings: 'goldens/*' });
  const comment = (id: number, body: string, type = 'User') => ({ id, body, user: { type }, html_url: `https://github.test/northwind/agent/pull/12#issuecomment-${id}` });

  it('is found by a hidden marker, one per workflow, job, folder and set of recordings', () => {
    expect(marker).toMatch(/^<!-- shadowlap-test-comment [0-9a-f]{12} -->$/);
    expect(commentMarker({ workflow: 'CI', job: 'goldens', workdir: '.', recordings: 'goldens/*' })).toBe(marker);
    expect(commentMarker({ workflow: 'CI', job: 'goldens', workdir: '.', recordings: 'goldens/refund-*' })).not.toBe(marker);
  });

  it('is made when the pull request has none, and edited in place when it has one, read a page at a time', async () => {
    const fresh = github((c) => (c.method === 'GET' ? { status: 200, json: [comment(1, 'Looks good')] } : { status: 201, json: comment(9, 'x') }));
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: `${marker}\nbody`, fetch: fresh.fetch })).toEqual({ state: 'created', url: 'https://github.test/northwind/agent/pull/12#issuecomment-9', why: null });
    expect(fresh.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.github.test/repos/northwind/agent/issues/12/comments?per_page=100&page=1', 'POST https://api.github.test/repos/northwind/agent/issues/12/comments']);
    expect(fresh.calls[1].body).toEqual({ body: `${marker}\nbody` });

    // The action's comment on the second page, past a hundred others, and a person's quoting the marker before it.
    const page1 = Array.from({ length: 100 }, (_, i) => comment(100 + i, i === 3 ? `> ${marker} quoted` : 'chat'));
    const kept = github((c) => (c.method === 'GET' ? { status: 200, json: c.url.endsWith('page=1') ? page1 : [comment(300, `${marker}\nold`, 'Bot')] } : { status: 200, json: comment(300, 'x', 'Bot') }));
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: `${marker}\nnew`, fetch: kept.fetch })).toMatchObject({ state: 'updated', url: 'https://github.test/northwind/agent/pull/12#issuecomment-300' });
    expect(kept.calls.map((c) => `${c.method} ${c.url.replace('https://api.github.test/repos/northwind/agent', '')}`)).toEqual(['GET /issues/12/comments?per_page=100&page=1', 'GET /issues/12/comments?per_page=100&page=2', 'PATCH /issues/comments/300']);
  });

  it('is a new one when the comment with the marker is one the token may not edit, and says so quietly when it may not comment at all', async () => {
    const theirs = github((c) => (c.method === 'GET' ? { status: 200, json: [comment(5, `quoting ${marker}`)] } : c.method === 'PATCH' ? { status: 403, json: { message: 'Forbidden' } } : { status: 201, json: comment(6, 'x', 'Bot') }));
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: 'b', fetch: theirs.fetch })).toMatchObject({ state: 'created' });
    expect(theirs.calls.map((c) => c.method)).toEqual(['GET', 'PATCH', 'POST']);
    const denied = github(() => ({ status: 403, json: { message: 'Resource not accessible by integration' } }));
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: 'b', fetch: denied.fetch })).toEqual({ state: 'denied', url: null, why: "the job's token may not comment on the pull request: give the job pull-requests: write (GitHub answered 403 (Resource not accessible by integration))" });
    expect(await upsertComment({ env: ACTIONS, auth, number: 12, marker, body: 'b', fetch: github(() => ({ status: 502 })).fetch })).toEqual({ state: 'failed', url: null, why: 'GitHub answered 502' });
  });

  /** A test report's result, a golden that replayed clean unless told otherwise. */
  const result = (over: Partial<ReportResult> & Record<string, unknown>): ReportResult => ({ name: 'refund-flow', golden: 'goldens/refund-flow', dir: 'goldens/refund-flow', ok: true, verdict: 'passed', failure: null, message: null, runId: 'R1', runs: [{ runId: 'R1', ok: true, verdict: 'passed' }], ...over });
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
      '| ❌ | `goldens/refund|flow` | failed · check failed: issue_refund called 0 times, but called 1 time | ✅ passed |',
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
  const failing = (name: string, expect: Record<string, unknown>, over: Partial<ReportResult> & Record<string, unknown> = {}): ReportResult => ({ name, golden: `goldens/${name}`, dir: `goldens/${name}`, ok: false, verdict: 'failed', failure: 'check', runId: `${name}-1`, runs: [{ runId: `${name}-1`, ok: false, verdict: 'failed' }, { runId: `${name}-2`, ok: false, verdict: 'failed' }], expect, ...over });
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
    expect(repairArgs(plan, { db: null, budget: 6, repairer: '', expectFile: '/tmp/expect.json' })).toEqual(['repair', '--fixes', 'a-1', 'c-1', '--holdout', 'b-1', '--keeps', 'ok-1-1', 'ok-2-1', '--expect', '@/tmp/expect.json', '--budget', '6', '--branch', expect.stringMatching(/^shadowlap\/fix-a-/), '--yes', '--json']);
    // A golden alone under its check has nothing to hold out; one that passed the check is still kept.
    expect(repairPlan(groups[1].members, results)).toMatchObject({ fixes: ['d-1'], holdout: [], keeps: ['other-1'], goldens: { shown: ['goldens/d'], heldOut: [], kept: ['goldens/other'] } });
    const lonely = [failing('e', { tools: { delete_thread: 0 } }), ...results];
    expect(repairPlan(groupFixes(planFixes({ results: lonely }))[0].members, lonely)).toMatchObject({ fixes: ['e-1'], holdout: [], keeps: [], goldens: { shown: ['goldens/e'], heldOut: [], kept: [] } });
  });

  it("decides each run by the failing golden's own gate: its figures, its fixed count, or verify's default for one against history", () => {
    const sprt = { kind: 'sprt', good: 0.95, bad: 0.8, risk: 0.01, max: 200, sentence: 'failed · …' };
    expect(goldenGate(failing('a', NO_REFUND, { gate: sprt }))).toEqual({ kind: 'sprt', good: 0.95, bad: 0.8, risk: 0.01, max: 200 });
    expect(goldenGate(failing('a', NO_REFUND, { attempts: { total: 5, passed: 3, required: 4 } }))).toEqual({ kind: 'count', attempts: 5, passes: 4 });
    expect(goldenGate(failing('a', NO_REFUND, { gate: { kind: 'baseline', drop: 0.1 } } as never))).toEqual({ kind: 'history' });
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

  it('opens no fix from the branch of a fix it opened', () => {
    const repo = temp('sl-fix-branch-');
    execFileSync('git', ['init', '-q', '-b', 'shadowlap/fix-refund-flow-t9rb1d'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'the fix'], { cwd: repo });
    expect(cannotFix(repo, process.env)).toBe('shadowlap/fix-refund-flow-t9rb1d is the branch of a fix this action opened: its checks say whether the fix holds, and no fix is opened from it');
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: repo });
    expect(cannotFix(repo, process.env)).toBeNull();
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

  it('declares github-token, comment and build-from-source, and passes the tokens to the step that keeps them from the CLI', () => {
    for (const input of ['github-token:', 'comment:', 'build-from-source:']) expect(yml).toContain(`\n  ${input}\n    description:`);
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

