import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordRepair, recordVerdict, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { providers } from '@shadowlap/sidecar';
import { ciFixBranch, ciTeamStore, ciWorkflows, CI_DEFAULTS, fixPreview, gitFacts, goldenProviders, liveGoldens, parseCiOptions, PROVIDER_KEYS, verifyLine } from '../src/ci-workflows.js';
import { workflowFile } from '../src/ci-yaml.js';
import { readTeamStoreInput } from '../src/team-store.js';

/**
 * Settings → CI's read model: the panels' options from a query string, the pull request a fix in
 * this store would be, what the project's git files say about its repository and branch, and the
 * team store's Push from CI, which the Fix on failure step follows.
 */
let store: Store;
let dirs: string[] = [];
beforeEach(() => {
  store = Store.open(':memory:');
  dirs = [];
});
afterEach(() => {
  store.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sl-ci-'));
  dirs.push(d);
  return d;
};

describe('the panels\' options', () => {
  it('take their defaults, and what the query string gives', () => {
    expect(parseCiOptions(new URLSearchParams())).toEqual(CI_DEFAULTS);
    expect(parseCiOptions(new URLSearchParams('fix=true&budget=$1&repairer=anthropic:claude-opus-5-5&onlyMain=0&secret=HOOK'))).toEqual({ comment: true, fix: true, alerts: true, budget: '1.00', repairer: 'anthropic:claude-opus-5-5', onlyMain: false, secret: 'HOOK' });
    // The pull request comment is a switch too, on unless the query or the repository's file turns it off.
    expect(parseCiOptions(new URLSearchParams('comment=off'))).toEqual({ ...CI_DEFAULTS, comment: false });
    expect(parseCiOptions(new URLSearchParams('comment=maybe'))).toEqual({ error: 'comment is on or off' });
    expect(parseCiOptions(new URLSearchParams('fix=on'), { ...CI_DEFAULTS, comment: false, budget: '3.00' })).toEqual({ ...CI_DEFAULTS, comment: false, budget: '3.00', fix: true });
    // Slack alerts are a part of the workflow that can be left out.
    expect(parseCiOptions(new URLSearchParams('alerts=off'))).toMatchObject({ alerts: false });
    expect(parseCiOptions(new URLSearchParams('alerts=maybe'))).toEqual({ error: 'alerts is on or off' });
    // What an inconclusive golden does to the step: fail it, the default, or warn.
    expect(parseCiOptions(new URLSearchParams('inconclusive=warn'))).toMatchObject({ inconclusive: 'warn' });
    expect(parseCiOptions(new URLSearchParams('inconclusive=maybe'))).toEqual({ error: 'inconclusive is fail or warn' });
    // An empty secret is the default one; a name with other characters keeps what GitHub allows.
    expect(parseCiOptions(new URLSearchParams('secret=')).valueOf()).toMatchObject({ secret: 'SLACK_WEBHOOK_URL' });
    expect(parseCiOptions(new URLSearchParams('secret=my-hook!'))).toMatchObject({ secret: 'myhook' });
    expect(parseCiOptions(new URLSearchParams('budget=0'))).toEqual({ error: 'budget is an amount in dollars, such as 2.00' });
    expect(parseCiOptions(new URLSearchParams('repairer=gemini'))).toMatchObject({ error: expect.stringMatching(/^repairer is/) });
    expect(parseCiOptions(new URLSearchParams('onlyMain=sometimes'))).toEqual({ error: 'onlyMain is on or off' });
  });
});

describe('the pull request a fix opens', () => {
  it('is the newest verified fix in the store: its title, branch, verify\'s counts, blame, change and cost', () => {
    const failing = makeRun(store, { labels: ['refund-bug'], calls: ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] });
    const held = makeRun(store, { labels: ['refund-bug'] });
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    expect(fixPreview(store, '2.00')).toBeNull();
    recordBlame(store, { runId: failing, report: blameReport(failing), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: true }, { runId: held, role: 'holdout', pass: true }, { runId: good, role: 'good', pass: true }]), expect: EXPECT, command: 'shadowlap verify', at: 2_000 });
    recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [failing], holdout: [held], good: [good] }), expect: EXPECT, command: 'shadowlap repair', at: 3_000 });
    const pr = fixPreview(store, '2.00')!;
    // As CI opens it: verify's line as the body says it, the rule once; where the run was lost as the body's table has it.
    expect(pr).toMatchObject({ example: false, author: 'github-actions', base: 'main', verify: 'fixes 1 of 1 target run, 1 of 1 held-out, keeps 1 of 1 good, each at 4 of 5 attempts', blame: 'lost at model call #5 (3 of 4)' });
    // Not a golden's fix: CI names the branch after the golden that failed, which this one has none of.
    expect(pr.branch).toBe('shadowlap/fix-<golden>-…');
    expect(pr.fixId).toMatch(/^fx-/);
    expect(pr.title.length).toBeGreaterThan(0);
    expect(pr.spent).toMatch(/^≈\$\d+\.\d\d of \$2\.00$/);
    // The panel's budget is the one it shows, whatever the preview was made with.
    const view = ciWorkflows({ ...CI_DEFAULTS, budget: '5.00' }, { preview: pr, failing: 0, at: null, repository: null, branch: null });
    expect(view.fixOnFailure.preview.spent).toMatch(/ of \$5\.00$/);
    expect(view.alerts.message.text).toBe('Shadowlap: 1 golden(s) failed on main.');
    expect(view.alerts.message.link).toBe('github.com/owner/repo/actions/runs/…');
    // What fails a golden in red; a gate, judge or injection test that can't decide in amber, never red.
    expect(view.alerts.failures.map((r) => [r.value, r.tone])).toEqual([
      ['diverged', 'err'],
      ['live call', 'err'],
      ['exit ≠ 0', 'err'],
      ['check failed', 'err'],
      ['injection', 'err'],
      ['inconclusive', 'warn'],
    ]);
  });

  it('says a run blame found lost gradually around two calls was, as the body\'s Lost at column has it, never at the first', () => {
    const failing = makeRun(store, { labels: ['refund-bug'], calls: ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] });
    const range = { from: 5, to: 7, fromStep: 3, toStep: 4, gradual: true as const };
    recordBlame(store, { runId: failing, report: { ...blameReport(failing), range }, expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    recordVerdict(store, { report: verifyReport([{ runId: failing, role: 'target', pass: true }]), expect: EXPECT, command: 'shadowlap verify', at: 2_000 });
    const report = repairReport({ targets: [failing] });
    recordRepair(store, { repairId: 'repair-gradual1', dir: '.shadowlap/repairs/repair-gradual1', report: { ...report, targets: report.targets.map((t) => ({ ...t, range })) }, expect: EXPECT, command: 'shadowlap repair', at: 3_000 });
    expect(fixPreview(store, '2.00')?.blame).toBe('lost gradually, around model calls #5 and #7 (3 and 4 of 4)');
  });

  it('names the branch after the golden whose test replay failed, as the action does, and the example the same way', () => {
    expect(ciFixBranch('goldens/refund-over-limit')).toBe('shadowlap/fix-refund-over-limit-…');
    expect(ciFixBranch('goldens/Refund Flow (EU)')).toBe('shadowlap/fix-refund-flow-eu-…');
    expect(ciFixBranch('tests/goldens/a')).toBe('shadowlap/fix-tests-goldens-a-…');
    expect(ciFixBranch(null)).toBe('shadowlap/fix-<golden>-…');
    const failing = makeRun(store, { labels: [], calls: ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'], meta: { test: { golden: 'goldens/refund-over-limit', session: 'S1' } } });
    recordBlame(store, { runId: failing, report: blameReport(failing), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
    recordRepair(store, { repairId: 'repair-golden01', dir: '.shadowlap/repairs/repair-golden01', report: repairReport({ targets: [failing] }), expect: EXPECT, command: 'shadowlap repair', at: 3_000 });
    expect(fixPreview(store, '2.00')?.branch).toBe('shadowlap/fix-refund-over-limit-…');
    const example = ciWorkflows(CI_DEFAULTS, { preview: null, failing: 0, at: null, repository: null, branch: null }).fixOnFailure.preview;
    expect(example).toMatchObject({ example: true, branch: 'shadowlap/fix-refund-limit-…', blame: 'lost at model call #5 (3 of 5)', verify: 'fixes 3 of 3 target runs, 2 of 2 held-out, keeps 5 of 5 good, each failing run by its gate, which tells 90%+ from 70%- at <= 5% risk, and each good one against its baseline, which tells no drop from one of 10+ points at <= 5% risk' });
    // Each rule once, never a claimed rate.
    expect(example.verify).not.toMatch(/at least|passes/);
  });

  it('words verify\'s line by role, as the pull request\'s body does', () => {
    expect(verifyLine([{ role: 'target', held: 3, of: 3 }, { role: 'held-out', held: 2, of: 2 }, { role: 'good', held: 5, of: 5 }], 'each by its gate, which tells 90%+ from 70%- at <= 5% risk')).toBe('fixes 3 of 3 target runs, 2 of 2 held-out, keeps 5 of 5 good, each by its gate, which tells 90%+ from 70%- at <= 5% risk');
    expect(verifyLine([{ role: 'target', held: 1, of: 1 }], null)).toBe('fixes 1 of 1 target run');
    expect(verifyLine([], 'each at 4 of 5 attempts')).toBeNull();
  });
});

describe('the goldens that run live in CI', () => {
  /** A pack whose calls went to these providers, as `shadowlap pack` writes calls.jsonl. */
  const pack = (root: string, path: string, called: string[]) => {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, 'run.json'), '{}');
    writeFileSync(join(root, path, 'calls.jsonl'), called.map((p, i) => JSON.stringify({ runId: 'R', callNo: i + 1, kind: 'api', meta: { provider: p }, end: { meta: { provider: p } } })).join('\n') + '\n');
  };

  it('reads which providers each golden calls, and which run live: a fork, an injection gate, a forking golden’s judges', () => {
    const root = tmp();
    pack(root, 'goldens/refund-over-limit', ['anthropic', 'anthropic']);
    pack(root, 'goldens/refund-in-limit', ['openai']);
    pack(root, 'goldens/triage', ['gemini']);
    pack(root, 'goldens/bedrock-agent', ['bedrock']);
    const g = goldenProviders(root, [
      { path: 'goldens/refund-over-limit', mode: 'fork', judges: ['openai:gpt-5.5', 'claude-haiku-4-5'] },
      { path: 'goldens/refund-in-limit', mode: 'replay', judges: ['gemini-3-flash'] },
      { path: 'goldens/triage', mode: 'replay', injection: true },
      { path: 'goldens/bedrock-agent', mode: 'replay' },
      { path: 'goldens/gone', mode: 'fork' },
    ]);
    expect(g).toEqual([
      // Its judges are asked live where it forks: their providers' keys too.
      { path: 'goldens/refund-over-limit', live: ['fork'], keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], known: true },
      // A replay golden's judge reads its verdict from the recording: no key for it.
      { path: 'goldens/refund-in-limit', live: [], keys: ['OPENAI_API_KEY'], known: true },
      { path: 'goldens/triage', live: ['injection gate'], keys: ['GEMINI_API_KEY'], known: true },
      { path: 'goldens/bedrock-agent', live: [], keys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], known: true },
      // A pack that can't be read calls nothing here, and its keys aren't known.
      { path: 'goldens/gone', live: ['fork'], keys: [], known: false },
    ]);
    expect(liveGoldens(g)).toEqual({ count: 3, why: ['fork', 'injection gate'], keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'], unknown: 1 });
    expect(liveGoldens(g.filter((x) => !x.live.length))).toBeNull();
    // Vertex AI signs in with a token, and a judge whose provider can't be told: no key to name for either.
    pack(root, 'goldens/vertex', ['vertex']);
    pack(root, 'goldens/judged', ['anthropic']);
    expect(goldenProviders(root, [{ path: 'goldens/vertex', mode: 'fork' }, { path: 'goldens/judged', mode: 'fork', judges: ['some-house-model'] }, { path: 'goldens/judged', mode: 'replay', judges: ['some-house-model'] }]).map((x) => [x.keys, x.known])).toEqual([
      [[], false],
      [['ANTHROPIC_API_KEY'], false],
      // A replay golden's judge isn't asked live.
      [['ANTHROPIC_API_KEY'], true],
    ]);
  });

  it('gives Alerts the live goldens’ keys and a needs row, and Fix on failure every golden’s, by name', () => {
    const goldens = [
      { path: 'goldens/refund-flow-budget', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'], known: true },
      { path: 'goldens/refund-over-limit', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'], known: true },
      { path: 'goldens/list-inbox', live: [], keys: ['OPENAI_API_KEY'], known: true },
    ];
    const view = ciWorkflows({ ...CI_DEFAULTS, repairer: 'anthropic' }, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens });
    // The two fork goldens would fail without it, and Slack hear of it on every run.
    expect(view.workflow.text).toBe(workflowFile({ fix: null, alerts: { onlyMain: true, secret: 'SLACK_WEBHOOK_URL', branch: 'main' }, push: null, comment: true, recordings: 'goldens/*', keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], keysUnknown: false, liveKeys: ['ANTHROPIC_API_KEY'], liveKeysUnknown: false, unreadable: false, branch: 'main', credentials: null }));
    expect(view.workflow.text).toContain('          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
    expect(view.workflow.text).not.toContain('OPENAI_API_KEY');
    expect(view.alerts.needs).toContainEqual({ label: '2 goldens run live (fork)', value: 'ANTHROPIC_API_KEY' });
    // Blame and verify run any golden's agent live: every provider's key, by name, beside the repairer's.
    const fixed = ciWorkflows({ ...CI_DEFAULTS, fix: true, repairer: 'anthropic' }, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens });
    expect(fixed.workflow.text).toContain('          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}');
    expect(view.fixOnFailure.needs[1]).toEqual({ label: 'your agent’s provider keys: blame and verify run it live', value: 'ANTHROPIC_API_KEY, OPENAI_API_KEY' });
    // Nothing known of the goldens: the steps as the docs show them.
    const unknown = ciWorkflows(CI_DEFAULTS, { preview: null, failing: 0, at: null, repository: null, branch: null });
    expect(unknown.workflow.text).not.toMatch(/^ +env:/m);
    // The comment's row is the Pull request comment panel's, never Alerts'.
    expect(unknown.alerts.needs.map((r) => r.value)).toEqual(['Slack app', 'SLACK_WEBHOOK_URL', 'id: goldens', 'node-version: 22']);
    expect(unknown.comment.needs).toEqual([{ label: 'permission to keep the action’s comment on a pull request', value: 'pull-requests: write' }]);
    expect(unknown.configError).toBeNull();
    // A golden that runs live whose keys can't be named: Alerts' env says to add them, as Fix on failure's does.
    const vertex = ciWorkflows(CI_DEFAULTS, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens: [{ path: 'goldens/vertex', live: ['fork'], keys: [], known: false }] });
    expect(vertex.workflow.text).toContain("        # env:\n        #   your agent's own provider keys: the goldens that run live call them\n");
    expect(vertex.alerts.needs).toContainEqual({ label: '1 golden runs live (fork)', value: 'their providers’ keys' });
    const vertexFix = ciWorkflows({ ...CI_DEFAULTS, fix: true }, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens: [{ path: 'goldens/vertex', live: ['fork'], keys: [], known: false }] });
    expect(vertexFix.workflow.text).toContain("# and your agent's own provider keys: blame and verify run it live");
  });

  it('says what the steps leave out, and why, while shadowlap.config.json can’t be read', () => {
    const configError = 'shadowlap.config.json: not valid JSON (Unexpected end of JSON input)';
    // As the CLI lists them then: every golden replays, and no store is named.
    const goldens = [{ path: 'goldens/refund-over-limit', live: [], keys: ['ANTHROPIC_API_KEY'], known: true }];
    const view = ciWorkflows({ ...CI_DEFAULTS, fix: true }, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens, teamStore: { store: null }, configError });
    expect(view.configError).toBe(configError);
    expect(view.workflow.text).toContain("shadowlap.config.json can't be read");
    // Write file waits for it: recordings and Push from CI come from it.
    expect(view.problem).toBe('Write file writes only at a repository’s root, where GitHub reads .github/workflows/, and this project folder isn’t one.');
    expect(ciWorkflows({ ...CI_DEFAULTS, fix: true }, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens, teamStore: { store: null }, configError, root: true }).problem).toBe('shadowlap.config.json can’t be read: fix it before writing the workflow');
    expect(view.alerts.needs).toContainEqual({ label: 'which goldens run live, and their keys, from shadowlap.config.json', value: 'can’t be read', tone: 'warn' });
    expect(view.workflow.text).toContain("# shadowlap.config.json can't be read: push (Push from CI) and the judges' keys are left out");
    expect(view.fixOnFailure.needs).toContainEqual({ label: 'Push from CI and the judges’ keys, from shadowlap.config.json', value: 'can’t be read', tone: 'warn' });
    // Not "None yet": whether there is a store isn't known.
    expect(view.fixOnFailure.teamStore).toEqual({ push: false, name: null, credentials: null, note: 'shadowlap.config.json can’t be read, so whether fixes go to a team store isn’t known until it is fixed.', lands: [] });
  });

  it('says what fails a golden, the injection gate included, and in amber what can’t be decided while it fails one', () => {
    const fail = ciWorkflows(CI_DEFAULTS, { preview: null, failing: 0, at: null, repository: null, branch: null }).alerts;
    expect(fail.inconclusive).toBe('fail');
    expect(fail.failures.map((r) => [r.value, r.tone])).toEqual([['diverged', 'err'], ['live call', 'err'], ['exit ≠ 0', 'err'], ['check failed', 'err'], ['injection', 'err'], ['inconclusive', 'warn']]);
    const warn = ciWorkflows({ ...CI_DEFAULTS, inconclusive: 'warn' }, { preview: null, failing: 0, at: null, repository: null, branch: null });
    expect(warn.alerts.inconclusive).toBe('warn');
    expect(warn.alerts.failures.map((r) => r.value)).not.toContain('inconclusive');
    expect(warn.workflow.text).toContain('          inconclusive: warn\n');
  });

  it('names each provider’s key as the sidecar asks for it', () => {
    for (const p of providers) {
      if (!p.keys) expect(PROVIDER_KEYS[p.id], p.id).toBeUndefined();
      else expect(PROVIDER_KEYS[p.id].join(' and '), p.id).toBe(p.keys.set);
    }
  });
});

describe('your workflow', () => {
  const context = { preview: null, failing: 0, at: null, repository: null, branch: null };
  const goldens = [
    { path: 'goldens/refund-flow', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'], known: true },
    { path: 'goldens/triage', live: [], keys: ['OPENAI_API_KEY'], known: true },
  ];

  it('is one job, from the switches: the action once, then a fix and Slack where they are on', () => {
    const plain = ciWorkflows({ ...CI_DEFAULTS, alerts: false }, { ...context, goldens }).workflow;
    expect(plain).toMatchObject({ fix: false, alerts: false });
    expect(plain.text).toBe(workflowFile({ fix: null, alerts: null, push: null, comment: true, recordings: 'goldens/*', keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], keysUnknown: false, liveKeys: ['ANTHROPIC_API_KEY'], liveKeysUnknown: false, unreadable: false, branch: 'main', credentials: null }));
    // Only the golden that runs live needs its key without a fix; with one, every golden's.
    expect(plain.text).toContain('          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
    expect(plain.text).not.toContain('OPENAI_API_KEY');
    // No repository file: every line of it is added, and it is never the same.
    expect(plain.lines.every((l) => l.op === '+')).toBe(true);
    expect([plain.added, plain.removed, plain.same]).toEqual([plain.lines.length, 0, false]);
    const both = ciWorkflows({ ...CI_DEFAULTS, fix: true }, { ...context, goldens });
    expect(both.workflow.text.match(/- uses: devjoinedthechat\/shadowlap@/g)).toHaveLength(1);
    expect(both.workflow.text).toContain('          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}');
    // Each panel lists what it needs: the comment's row is its own panel's.
    expect(both.fixOnFailure.needs.map((r) => r.value)).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'contents: write', 'pull-requests: write', 'node-version: 22']));
    expect(both.alerts.needs.map((r) => r.value)).toEqual(expect.arrayContaining(['Slack app', 'id: goldens', 'node-version: 22']));
    expect(both.alerts.failures.map((r) => r.value)).toContain('inconclusive');
  });

  it('pushes the test runs while Push from CI is on, a fix or not, needing the bucket’s credentials once', () => {
    const store = { store: 's3://northwind-agent-runs/support-agent?region=eu-central-1' };
    const w = ciWorkflows(CI_DEFAULTS, { ...context, teamStore: store }).workflow;
    expect(w.text).toContain('          push: true\n');
    expect(w.text).toContain('\npermissions:\n  contents: read\n  pull-requests: write\n  id-token: write\n');
    // The bucket's two sign-in steps are in the file itself, before the action.
    expect(w.text.match(/aws-actions\/configure-aws-credentials@/g)).toHaveLength(2);
    const fixed = ciWorkflows({ ...CI_DEFAULTS, fix: true }, { ...context, teamStore: store }).fixOnFailure;
    expect(fixed.needs.filter((r) => r.value === 'id-token: write')).toHaveLength(1);
    expect(ciWorkflows(CI_DEFAULTS, { ...context, teamStore: { ...store, ciPush: false } }).workflow.text).not.toMatch(/^ {10}push:/m);
  });
});

describe('the team store Fix on failure follows', () => {
  const context = { preview: null, failing: 0, at: null, repository: null, branch: null };
  // The file without a push: what Push from CI off, or no store, leaves.
  const plain = ciWorkflows(CI_DEFAULTS, { preview: null, failing: 0, at: null, repository: null, branch: null }).workflow.text;

  it('pushes when Push from CI is on, and says so: what it needs and what lands', () => {
    const f = ciWorkflows({ ...CI_DEFAULTS, fix: true }, { ...context, teamStore: { store: 's3://northwind-agent-runs/support-agent?region=eu-central-1' } }).fixOnFailure;
    expect(f.teamStore).toEqual({
      push: true,
      name: 'northwind-agent-runs/support-agent',
      credentials: 'oidc',
      note: 'Follows Push from CI: on, so the test runs, and fixes from your branches, go there too.',
      lands: [
        { label: 'each test run and the session’s report', value: 'test --push' },
        { label: 'the fix and its runs, on teammates’ Fixes page once they pull', value: 'from CI' },
        // A pull request's own credentials write only to its folder, and it sends no fixes.
        { label: 'from a pull request’s job, only its runs, in its own folder', value: 'pr/<n>/' },
      ],
    });
    expect(ciWorkflows({ ...CI_DEFAULTS, fix: true }, { ...context, teamStore: { store: 's3://northwind-agent-runs/support-agent?region=eu-central-1' } }).workflow.text).toContain('\n          push: true\n');
    expect(f.needs).toContainEqual({ label: 'the bucket’s credentials: the two sign-in steps in Your workflow', value: 'id-token: write' });
    // The panel's options never turn it on or off: there is no switch for it here.
    expect(Object.keys(CI_DEFAULTS)).not.toContain('push');
    // R2 has no OIDC, and its keys can't be kept to pr/: only your branches' jobs get them, and push.
    const r2view = ciWorkflows(CI_DEFAULTS, { ...context, teamStore: { store: 'r2://0123456789abcdef0123456789abcdef/agent-runs/support-agent', ciPush: true } });
    const r2 = r2view.fixOnFailure;
    expect(r2.teamStore).toMatchObject({ push: true, credentials: 'keys' });
    expect(r2view.workflow.text).toContain("\n          push: ${{ !startsWith(github.event_name, 'pull_request') }}\n");
    expect(r2.needs).toContainEqual({ label: 'the bucket’s R2 keys as secrets, kept from pull requests’ jobs', value: 'secrets' });
    expect(r2.teamStore.lands.at(-1)).toEqual({ label: 'from a pull request’s job, nothing: R2 keys can’t be kept to pr/', value: 'no push' });
  });

  it('leaves the step as it was when Push from CI is off, or there is no store to push to', () => {
    const offView = ciWorkflows(CI_DEFAULTS, { ...context, teamStore: { store: 's3://northwind-agent-runs/support-agent', ciPush: false } });
    const off = offView.fixOnFailure;
    expect(offView.workflow.text).toBe(plain);
    expect(off.teamStore).toEqual({ push: false, name: 'northwind-agent-runs/support-agent', credentials: 'oidc', note: 'Follows Push from CI: off, so test runs and fixes stay in GitHub.', lands: [] });
    expect(off.needs.map((r) => r.value)).toEqual(['ANTHROPIC_API_KEY', 'env', 'contents: write', 'pull-requests: write', 'actions: write', 'workflow_dispatch:', 'ref: head_ref', 'node-version: 22']);
    // No project, no store, or one that isn't a store URL: nothing to push to.
    for (const teamStore of [undefined, null, { store: null }, { store: 'ftp://nowhere/runs' }]) {
      const noneView = ciWorkflows(CI_DEFAULTS, { ...context, ...(teamStore === undefined ? {} : { teamStore }) });
      const none = noneView.fixOnFailure;
      expect(noneView.workflow.text).toBe(plain);
      expect(none.teamStore).toEqual({ push: false, name: null, credentials: null, note: 'None yet, so test runs and fixes stay in GitHub. With one, this follows Push from CI.', lands: [] });
    }
  });

  it('reads Push from CI from shadowlap.config.json as Settings → Store reads it', () => {
    const project = tmp();
    const read = () => ciTeamStore(readTeamStoreInput({ cwd: project, env: {}, home: project }));
    expect(read().push).toBe(false);
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ store: 'gs://northwind-agent-runs/support-agent' }));
    // On unless the config turns it off, as the Store tab's switch shows it.
    expect(read()).toMatchObject({ push: true, credentials: 'oidc', name: 'northwind-agent-runs/support-agent' });
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ store: 'gs://northwind-agent-runs/support-agent', ciPush: false }));
    expect(read()).toMatchObject({ push: false, name: 'northwind-agent-runs/support-agent' });
    // A config that can't be read names no store, as Settings → Store has it.
    writeFileSync(join(project, 'shadowlap.config.json'), '{ "store": ');
    expect(read()).toMatchObject({ push: false, name: null });
  });
});

describe('the project\'s git facts', () => {
  it('reads the GitHub repository from origin and the branch checked out, in a worktree too', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(repo, '.git', 'config'), '[remote "upstream"]\n\turl = https://example.com/x.git\n[remote "origin"]\n\turl = https://github.com/acme/support-agent\n');
    expect(gitFacts(repo)).toEqual({ repository: 'acme/support-agent', branch: 'main', defaultBranch: null, root: true });
    // A worktree: its .git is a file naming its folder, whose commondir leads to the shared config.
    const wt = tmp();
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/fix-refund-limit\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    expect(gitFacts(wt)).toEqual({ repository: 'acme/support-agent', branch: 'fix-refund-limit', defaultBranch: null, root: true });
    // No git, a detached HEAD, a remote elsewhere: nothing made up.
    expect(gitFacts(tmp())).toEqual({ repository: null, branch: null, defaultBranch: null, root: false });
    expect(gitFacts(null)).toEqual({ repository: null, branch: null, defaultBranch: null, root: false });
    writeFileSync(join(repo, '.git', 'HEAD'), '3f1c9a2e5b7d4e219c0a8d6f2b1e7a43aa001122\n');
    writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@gitlab.com:acme/support-agent.git\n');
    // Detached on a GitLab remote: nothing of GitHub's to tell, but the folder is still its repository's root.
    expect(gitFacts(repo)).toEqual({ repository: null, branch: null, defaultBranch: null, root: true });
  });

  it('reads the default branch from origin’s HEAD, else main or master, in a worktree too', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/fix-refund-limit\n');
    writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/support-agent\n');
    // A branch called master, packed: the default.
    writeFileSync(join(repo, '.git', 'packed-refs'), '# pack-refs with: peeled fully-peeled sorted\n3f1c9a2e5b7d4e219c0a8d6f2b1e7a43aa001122 refs/heads/master\n');
    expect(gitFacts(repo).defaultBranch).toBe('master');
    // A main beside it wins; what origin's HEAD names wins over both.
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), '3f1c9a2e5b7d4e219c0a8d6f2b1e7a43aa001122\n');
    expect(gitFacts(repo).defaultBranch).toBe('main');
    mkdirSync(join(repo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    writeFileSync(join(repo, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/trunk\n');
    expect(gitFacts(repo)).toEqual({ repository: 'acme/support-agent', branch: 'fix-refund-limit', defaultBranch: 'trunk', root: true });
    // A worktree reads the repository it belongs to.
    mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    const wt = tmp();
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/other\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    expect(gitFacts(wt).defaultBranch).toBe('trunk');
  });

  it('posts alerts for the default branch and opens fix pull requests into it', () => {
    const view = ciWorkflows(CI_DEFAULTS, { preview: null, failing: 2, at: null, repository: 'acme/support-agent', branch: 'feature', defaultBranch: 'master' });
    expect(view.alerts).toMatchObject({ onlyMain: true, branch: 'master' });
    expect(view.workflow.text).toContain("&& github.ref == 'refs/heads/master'");
    // The push trigger names it too.
    expect(view.workflow.text).toContain('  push:\n    branches: [master]\n');
    expect(view.alerts.message.text).toBe('Shadowlap: 2 golden(s) failed on master.');
    expect(view.fixOnFailure.preview.base).toBe('master');
    // Off: the branch checked out, unless it is the default one.
    expect(ciWorkflows({ ...CI_DEFAULTS, onlyMain: false }, { preview: null, failing: 0, at: null, repository: null, branch: 'feature', defaultBranch: 'master' }).alerts.message.text).toBe('Shadowlap: 1 golden(s) failed on feature.');
    // Unknown: main, as before.
    expect(ciWorkflows(CI_DEFAULTS, { preview: null, failing: 0, at: null, repository: null, branch: null }).alerts.branch).toBe('main');
  });
});
