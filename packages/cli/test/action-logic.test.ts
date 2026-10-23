import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { cannotFix, checksNote, evidenceNote, goldenGate, groupFixes, KEEPS_AT_MOST, planFixes, repairArgs, repairPlan, type ReportResult } from '../../../action/fix.mjs';
import { dispatchWorkflow, githubToken, tokenEnv, withoutTokens, workflowFile, type Fetch } from '../../../action/github.mjs';
import { outputsOf } from '../../../action/run.mjs';

/**
 * The GitHub Action's logic, function by function, with GitHub's REST API played by a stand-in for
 * fetch that records each call and answers as GitHub does: which token the action speaks with, the
 * workflow it starts on a fix's branch, what a repair is verified on, and what the pull request and
 * the step's outputs say.
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
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (/^authorization$/i.test(req.rawHeaders[i]!)) values.push(req.rawHeaders[i + 1]!);
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

describe('what a fix is verified on', () => {
  const failing = (name: string, expect: Record<string, unknown>, over: Partial<ReportResult> & Record<string, unknown> = {}): ReportResult => ({ name, golden: `goldens/${name}`, dir: `goldens/${name}`, ok: false, verdict: 'failed', failure: 'check', runId: `${name}-1`, runs: [{ runId: `${name}-1`, ok: false, verdict: 'failed' }, { runId: `${name}-2`, ok: false, verdict: 'failed' }], expect, ...over }) as ReportResult;
  const passing = (name: string, expect: Record<string, unknown> | null): ReportResult => ({ name, golden: `goldens/${name}`, dir: `goldens/${name}`, ok: true, verdict: 'passed', failure: null, runId: `${name}-1`, runs: [{ runId: `${name}-1`, ok: true, verdict: 'passed' }], expect });
  const NO_REFUND = { tools: { issue_refund: 0 } };
  const NO_EMAIL = { tools: { send_email: 0 } };

  it('holds out every other golden that fails the same check, keeps the goldens that passed it, and shows one failing replay of each', () => {
    const results = [failing('a', NO_REFUND), passing('ok-1', NO_REFUND), failing('b', { tools: { issue_refund: 0 } }), failing('c', NO_REFUND), passing('ok-2', NO_REFUND), passing('other', NO_EMAIL), passing('ok-3', NO_REFUND), passing('ok-4', NO_REFUND), failing('d', NO_EMAIL)];
    const groups = groupFixes(planFixes({ results }));
    expect(groups.map((g) => g.members.map((m) => m.result.name))).toEqual([['a', 'b', 'c'], ['d']]);
    const plan = repairPlan(groups[0]!.members, results);
    expect(plan).toMatchObject({ fixes: ['a-1', 'c-1'], holdout: ['b-1'], keeps: ['ok-1-1', 'ok-2-1', 'ok-3-1'], goldens: { shown: ['goldens/a', 'goldens/c'], heldOut: ['goldens/b'], kept: ['goldens/ok-1', 'goldens/ok-2', 'goldens/ok-3'] }, gate: null });
    expect(KEEPS_AT_MOST).toBe(3);
    expect(repairArgs(plan, { db: null, budget: 6, repairer: '', expectFile: '/tmp/expect.json' })).toEqual(['repair', '--fixes', 'a-1', 'c-1', '--holdout', 'b-1', '--keeps', 'ok-1-1', 'ok-2-1', 'ok-3-1', '--expect', '@/tmp/expect.json', '--budget', '6', '--branch', expect.stringMatching(/^shadowlap\/fix-a-/), '--yes', '--json']);
    // A golden alone under its check has nothing to hold out; one that passed the check is still kept.
    expect(repairPlan(groups[1]!.members, results)).toMatchObject({ fixes: ['d-1'], holdout: [], keeps: ['other-1'], goldens: { shown: ['goldens/d'], heldOut: [], kept: ['goldens/other'] } });
    const lonely = [failing('e', { tools: { delete_thread: 0 } }), ...results];
    expect(repairPlan(groupFixes(planFixes({ results: lonely }))[0]!.members, lonely)).toMatchObject({ fixes: ['e-1'], holdout: [], keeps: [], goldens: { shown: ['goldens/e'], heldOut: [], kept: [] } });
  });

  it("decides each run by the failing golden's own gate: its figures, its fixed count, or verify's default for one against history", () => {
    const sprt = { kind: 'sprt', good: 0.95, bad: 0.8, risk: 0.01, max: 200, sentence: 'failed · …' };
    expect(goldenGate(failing('a', NO_REFUND, { gate: sprt } as never))).toEqual({ kind: 'sprt', good: 0.95, bad: 0.8, risk: 0.01, max: 200 });
    expect(goldenGate(failing('a', NO_REFUND, { attempts: { total: 5, passed: 3, required: 4 } } as never))).toEqual({ kind: 'count', attempts: 5, passes: 4 });
    expect(goldenGate(failing('a', NO_REFUND, { gate: { kind: 'baseline', drop: 0.1 } } as never))).toEqual({ kind: 'history' });
    expect(goldenGate(failing('a', NO_REFUND))).toBeNull();
    const results = [failing('a', NO_REFUND, { gate: sprt } as never)];
    const plan = repairPlan(groupFixes(planFixes({ results }))[0]!.members, results);
    expect(repairArgs(plan, { db: null, budget: 2, repairer: 'claude-code', expectFile: '/e.json', gateFile: '/g.json' })).toEqual(expect.arrayContaining(['--gate', '@/g.json']));
    const counted = [failing('a', NO_REFUND, { attempts: { total: 5, passed: 3, required: 4 } } as never)];
    expect(repairArgs(repairPlan(groupFixes(planFixes({ results: counted }))[0]!.members, counted), { db: null, budget: 2, repairer: '', expectFile: '/e.json' }).join(' ')).toContain('--attempts 5 --passes 4');
  });

  it('says in the pull request what the fix was verified on, and that it was the failing golden alone when it was', () => {
    const alone = evidenceNote({ goldens: { shown: ['goldens/refund-flow'], heldOut: [], kept: [] }, gate: null });
    expect(alone).toContain('Only on `goldens/refund-flow`, whose failing replay was shown to the repairer: no other golden the session tested fails the same check to hold out from it, and none passed it to keep. That the fix holds for a case the repairer did not see is not tested here.');
    const wide = evidenceNote({ goldens: { shown: ['goldens/a'], heldOut: ['goldens/b', 'goldens/c'], kept: ['goldens/ok'] }, gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 } });
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

  it('declares github-token and build-from-source, and passes the tokens to the step that keeps them from the CLI', () => {
    for (const input of ['github-token:', 'build-from-source:']) expect(yml).toContain(`\n  ${input}\n    description:`);
    expect(yml).toContain('INPUT_GITHUB_TOKEN: ${{ inputs.github-token }}');
    expect(yml).toContain('SHADOWLAP_JOB_TOKEN: ${{ github.token }}');
    // The CLI comes from npm unless the step asks for a source build.
    expect(yml).toContain("id: install\n      if: inputs.build-from-source != 'true'");
    expect(yml).toContain("id: build\n      if: inputs.build-from-source == 'true'");
  });
});

