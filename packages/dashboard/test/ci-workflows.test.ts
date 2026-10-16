import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordRepair, recordVerdict, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { ciTeamStore, ciWorkflows, CI_DEFAULTS, fixPreview, gitFacts, parseCiOptions } from '../src/ci-workflows.js';
import { fixOnFailureYaml } from '../src/ci-yaml.js';
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
    expect(parseCiOptions(new URLSearchParams('fix=true&budget=$1&repairer=anthropic:claude-opus-5-5&onlyMain=0&secret=HOOK'))).toEqual({ fix: true, budget: '1.00', repairer: 'anthropic:claude-opus-5-5', onlyMain: false, secret: 'HOOK' });
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
    expect(pr).toMatchObject({ example: false, author: 'github-actions', base: 'main', verify: 'target 1 of 1 · held-out 1 of 1 · good 1 of 1' });
    expect(pr.fixId).toMatch(/^fx-/);
    expect(pr.title.length).toBeGreaterThan(0);
    expect(pr.blame).toMatch(/^lost at model call #\d+ · confidence (high|medium|low)$/);
    expect(pr.spent).toMatch(/^≈\$\d+\.\d\d of \$2\.00$/);
    // The panel's budget is the one it shows, whatever the preview was made with.
    const view = ciWorkflows({ ...CI_DEFAULTS, budget: '5.00' }, { preview: pr, failing: 0, at: null, repository: null, branch: null });
    expect(view.fixOnFailure.preview.spent).toMatch(/ of \$5\.00$/);
    expect(view.alerts.message.text).toBe('Shadowlap: 1 golden(s) failed on main.');
    expect(view.alerts.message.link).toBe('github.com/owner/repo/actions/runs/…');
  });
});

describe('the team store Fix on failure follows', () => {
  const context = { preview: null, failing: 0, at: null, repository: null, branch: null };
  const plain = fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code' });

  it('pushes when Push from CI is on, and says so: what it needs and what lands', () => {
    const f = ciWorkflows({ ...CI_DEFAULTS, fix: true }, { ...context, teamStore: { store: 's3://northwind-agent-runs/support-agent?region=eu-central-1' } }).fixOnFailure;
    expect(f.teamStore).toEqual({
      push: true,
      name: 'northwind-agent-runs/support-agent',
      credentials: 'oidc',
      note: 'Follows Push from CI: on, so fixes from your branches go there too.',
      lands: [
        { label: 'the fix and its runs, on teammates’ Fixes page once they pull', value: 'from CI' },
        // A pull request's own credentials write only to its folder, and it sends no fixes.
        { label: 'from a pull request’s job, only its runs, in its own folder', value: 'pr/<n>/' },
      ],
    });
    expect(f.yaml).toBe(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'oidc' }));
    expect(f.yaml).toContain('\n    push: true\n');
    expect(f.needs.at(-1)).toEqual({ label: 'the bucket’s credentials: two shadowlap store ci steps', value: 'id-token: write' });
    // The panel's options never turn it on or off: there is no switch for it here.
    expect(Object.keys(CI_DEFAULTS)).not.toContain('push');
    // R2 has no OIDC, and its keys can't be kept to pr/: only your branches' jobs get them, and push.
    const r2 = ciWorkflows(CI_DEFAULTS, { ...context, teamStore: { store: 'r2://0123456789abcdef0123456789abcdef/agent-runs/support-agent', ciPush: true } }).fixOnFailure;
    expect(r2.teamStore).toMatchObject({ push: true, credentials: 'keys' });
    expect(r2.yaml).toBe(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'keys' }));
    expect(r2.yaml).toContain("\n    push: ${{ !startsWith(github.event_name, 'pull_request') }}\n");
    expect(r2.needs.at(-1)).toEqual({ label: 'the bucket’s R2 keys as secrets, kept from pull requests’ jobs', value: 'secrets' });
    expect(r2.teamStore.lands.at(-1)).toEqual({ label: 'from a pull request’s job, nothing: R2 keys can’t be kept to pr/', value: 'no push' });
  });

  it('leaves the step as it was when Push from CI is off, or there is no store to push to', () => {
    const off = ciWorkflows(CI_DEFAULTS, { ...context, teamStore: { store: 's3://northwind-agent-runs/support-agent', ciPush: false } }).fixOnFailure;
    expect(off.yaml).toBe(plain);
    expect(off.teamStore).toEqual({ push: false, name: 'northwind-agent-runs/support-agent', credentials: 'oidc', note: 'Follows Push from CI: off, so fixes stay in GitHub.', lands: [] });
    expect(off.needs.map((r) => r.value)).toEqual(['ANTHROPIC_API_KEY', 'env', 'contents: write', 'pull-requests: write']);
    // No project, no store, or one that isn't a store URL: nothing to push to.
    for (const teamStore of [undefined, null, { store: null }, { store: 'ftp://nowhere/runs' }]) {
      const none = ciWorkflows(CI_DEFAULTS, { ...context, ...(teamStore === undefined ? {} : { teamStore }) }).fixOnFailure;
      expect(none.yaml).toBe(plain);
      expect(none.teamStore).toEqual({ push: false, name: null, credentials: null, note: 'None yet, so fixes stay in GitHub. With one, this follows Push from CI.', lands: [] });
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
    expect(gitFacts(repo)).toEqual({ repository: 'acme/support-agent', branch: 'main', defaultBranch: null });
    // A worktree: its .git is a file naming its folder, whose commondir leads to the shared config.
    const wt = tmp();
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/fix-refund-limit\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    expect(gitFacts(wt)).toEqual({ repository: 'acme/support-agent', branch: 'fix-refund-limit', defaultBranch: null });
    // No git, a detached HEAD, a remote elsewhere: nothing made up.
    expect(gitFacts(tmp())).toEqual({ repository: null, branch: null, defaultBranch: null });
    expect(gitFacts(null)).toEqual({ repository: null, branch: null, defaultBranch: null });
    writeFileSync(join(repo, '.git', 'HEAD'), '3f1c9a2e5b7d4e219c0a8d6f2b1e7a43aa001122\n');
    writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@gitlab.com:acme/support-agent.git\n');
    expect(gitFacts(repo)).toEqual({ repository: null, branch: null, defaultBranch: null });
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
    expect(gitFacts(repo)).toEqual({ repository: 'acme/support-agent', branch: 'fix-refund-limit', defaultBranch: 'trunk' });
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
    expect(view.alerts.yaml).toContain("&& github.ref == 'refs/heads/master'");
    expect(view.alerts.message.text).toBe('Shadowlap: 2 golden(s) failed on master.');
    expect(view.fixOnFailure.preview.base).toBe('master');
    // Off: the branch checked out, unless it is the default one.
    expect(ciWorkflows({ ...CI_DEFAULTS, onlyMain: false }, { preview: null, failing: 0, at: null, repository: null, branch: 'feature', defaultBranch: 'master' }).alerts.message.text).toBe('Shadowlap: 1 golden(s) failed on feature.');
    // Unknown: main, as before.
    expect(ciWorkflows(CI_DEFAULTS, { preview: null, failing: 0, at: null, repository: null, branch: null }).alerts.branch).toBe('main');
  });
});
