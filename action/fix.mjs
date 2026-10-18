// Fix on failure: when a golden fails an outcome check in CI, run `shadowlap repair` on the failing
// replay (it blames it, asks the repairer for prompt fixes and keeps one only when verify accepts
// it), within a budget per golden, and open a pull request with the patch and the report. Never for
// a divergence: most divergences are intended changes, and a golden update is a person's call. It
// never merges anything.
//
// A fix changes what the agent sends, so a golden that must replay exactly would diverge on the
// fix's own branch and fail the pull request's checks. Before the branch is pushed, that golden is
// re-recorded on it: the recording verify accepted takes the place of its pack, once it replays
// clean with the fix applied.
//
// With the push input (the dashboard's Settings → CI writes it when Push from CI is on), each fix
// whose pull request opened goes to the team store too, for teammates' Fixes page. That comes after
// the pull request, so it never keeps one from opening, and a push that can't happen warns in the
// log and the job summary, with why, and never fails the job.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Why a failed golden gets no fix attempt, by the kind of failure `shadowlap test --json` reports. */
const NOT_FIXED = {
  diverged: 'diverged: never fixed automatically, because most divergences are intended. Update the golden or add a normalizer',
  exit: 'the agent exited with an error, which is not an outcome check',
  'no-calls': 'the replay made no calls, which is not an outcome check',
  error: 'it could not be replayed',
};

/**
 * The models with no price, when a cost check that couldn't be judged for want of one is the only
 * check that failed (`shadowlap test` words it "no price for <models>; add it under "prices" …").
 */
function unpricedOnly(checks) {
  const failed = (Array.isArray(checks) ? checks : []).filter((c) => c && !c.ok);
  const models = failed.map((c) => /^no price for (.+?); add it under "prices"/.exec(String(c.detail ?? ''))?.[1]);
  if (!failed.length || !models.every(Boolean)) return null;
  return [...new Set(models.flatMap((m) => m.split(', ')))];
}

/** The failed goldens of a test report, each with the fix it gets or why it gets none. */
export function planFixes(report) {
  return report.results
    .filter((r) => !r.ok)
    .map((r) => {
      if (r.failure !== 'check') return { result: r, skip: NOT_FIXED[r.failure] ?? 'not an outcome check' };
      if (!r.expect) return { result: r, skip: 'its checks are not under "tests" in shadowlap.config.json' };
      const unpriced = unpricedOnly(r.checks);
      if (unpriced) return { result: r, skip: `it fails only because ${unpriced.join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} no price, which no prompt fix changes: add ${unpriced.length === 1 ? 'it' : 'them'} under "prices" in shadowlap.config.json` };
      const failing = (r.runs ?? []).filter((x) => !x.ok).map((x) => x.runId);
      if (!failing.length) return { result: r, skip: 'no failing replay was kept' };
      return { result: r, skip: null, fixes: failing, keeps: (r.runs ?? []).filter((x) => x.ok).map((x) => x.runId) };
    });
}

/** A branch name for a golden's fix that no other run of the workflow uses: `shadowlap/fix-refund-flow-7k2q1x`. */
export function branchName(result) {
  const slug = (result.golden ?? result.name).toLowerCase().replace(/^goldens\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'golden';
  return `shadowlap/fix-${slug}-${(result.runId ?? '').slice(-6).toLowerCase() || Date.now().toString(36)}`;
}

/**
 * The arguments for `shadowlap repair` on one failed golden. It commits the fix it keeps to a new
 * branch; the branch is pushed and the pull request opened here, once the golden is re-recorded on it.
 */
export function repairArgs(plan, { db, budget, repairer, expectFile }) {
  return [
    ...(db ? ['--db', db] : []),
    'repair',
    '--fixes',
    ...plan.fixes,
    ...(plan.keeps.length ? ['--keeps', ...plan.keeps] : []),
    '--expect',
    `@${expectFile}`,
    '--budget',
    String(budget),
    ...(repairer ? ['--repairer', repairer] : []),
    '--branch',
    branchName(plan.result),
    '--yes',
    '--json',
  ];
}

const run = (cmd, args, cwd, env, input) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });

/** git, failing loudly: its stdout, or an error in git's own words. */
function git(cwd, args, env, input) {
  const r = run('git', args, cwd, env, input);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}

/**
 * Why fixes can't be opened from this checkout, or null. A pull request needs a branch to target;
 * a pull request's own workflow checks out a detached merge commit unless told otherwise.
 */
export function cannotFix(workdir, env) {
  const head = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], workdir, env);
  if (head.status !== 0) return 'the working directory is not a git repository';
  if (head.stdout.trim() === 'HEAD') return 'HEAD is detached, so there is no branch to open a fix against: check out the branch itself (on pull requests, actions/checkout with ref: ${{ github.head_ref }})';
  return null;
}

/**
 * The environment for repair: GitHub's own bot as the committer when git has no identity, as on a
 * fresh runner, so the fix commit can be made.
 */
export function repairEnv(workdir, env) {
  const email = run('git', ['config', 'user.email'], workdir, env).stdout.trim();
  if (email || !env.GITHUB_ACTIONS) return env;
  const name = 'github-actions[bot]';
  const address = '41898282+github-actions[bot]@users.noreply.github.com';
  return { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: address, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: address };
}

/** What a pack is made of, as `shadowlap pack` writes it; anything else in a golden's folder is the user's. */
const PACK_ENTRIES = ['blobs', 'calls.jsonl', 'run.json'];

const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** A rename, or across filesystems a copy and a removal. */
function move(from, to) {
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Every file under a directory, as paths relative to it with forward slashes. */
function filesUnder(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, rel) : [rel];
  });
}

/**
 * Replays the recording verify accepted as the golden, with the fix applied, in the working tree,
 * where the agent's dependencies are, as verify itself ran it: the golden's pack entries are swapped
 * for the recording's, the patch applied, `shadowlap test` run on the golden (its checks included),
 * and both put back. Returns null when it replays clean, or why not.
 */
function replaysClean({ cli, workdir, root, golden, pack, patch, guard, env, scratch }) {
  const dir = resolve(workdir, golden);
  const aside = join(scratch, 'golden-aside');
  mkdirSync(aside, { recursive: true });
  const moved = [];
  let applied = false;
  try {
    for (const e of PACK_ENTRIES) {
      if (!present(join(dir, e))) continue;
      move(join(dir, e), join(aside, e));
      moved.push(e);
    }
    for (const e of PACK_ENTRIES) if (present(join(pack, e))) cpSync(join(pack, e), join(dir, e), { recursive: true });
    const apply = run('git', ['apply', '--whitespace=nowarn', patch], root, env);
    if (apply.status !== 0) return `the fix does not apply to the working tree: ${(apply.stderr ?? '').trim()}`;
    applied = true;
    const t = run(process.execPath, [cli, '--db', ':memory:', 'test', golden, '--guard', guard], workdir, env);
    if (t.status === 0) return null;
    const failed = /✗ [^\n]*/.exec(t.stdout ?? '')?.[0];
    return `the recording verify accepted does not replay clean on the branch${failed ? ` (${failed.slice(2)})` : ''}`;
  } finally {
    // The golden goes back whatever happens to the patch, and a patch that won't come out is said.
    const back = applied ? run('git', ['apply', '-R', '--whitespace=nowarn', patch], root, env) : null;
    for (const e of PACK_ENTRIES) rmSync(join(dir, e), { recursive: true, force: true });
    for (const e of moved) move(join(aside, e), join(dir, e));
    rmSync(aside, { recursive: true, force: true });
    if (back && back.status !== 0) throw new Error(`the fix could not be taken back out of the working tree: ${(back.stderr ?? '').trim()}`);
  }
}

/**
 * The branch's fix commit made again with the golden's pack replaced by `pack` (the golden's other
 * files stay), so the pull request is one commit: the fix and the recording that proves it. HEAD and
 * the working tree stay as they are.
 */
function commitGolden({ root, branch, golden, pack, env, scratch }) {
  const head = git(root, ['rev-parse', '--verify', `refs/heads/${branch}`], env).trim();
  const [subject, , ...rest] = git(root, ['log', '-1', '--format=%B', head], env).replace(/\s+$/, '').split('\n');
  const [an, ae, ad] = git(root, ['log', '-1', '--format=%an%x00%ae%x00%aI', head], env).trim().split('\0');
  const index = join(scratch, 'golden-index');
  const ienv = { ...env, GIT_INDEX_FILE: index };
  git(root, ['read-tree', head], ienv);
  git(root, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...PACK_ENTRIES.map((e) => `${golden}/${e}`)], ienv);
  for (const f of filesUnder(pack)) {
    const blob = git(root, ['hash-object', '-w', join(pack, f)], env).trim();
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${golden}/${f}`], ienv);
  }
  const tree = git(root, ['write-tree'], ienv).trim();
  const body = rest.join('\n').trim();
  const message = `${subject}\n\n${body ? `${body}\n\n` : ''}${golden} is re-recorded under the fix, from the run verify accepted: the prompt it sends changed, so the recording made before the fix would diverge here.\n`;
  const commit = git(root, ['commit-tree', tree, '-p', `${head}^`, '-F', '-'], { ...env, GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad }, message).trim();
  git(root, ['update-ref', `refs/heads/${branch}`, commit, head], env);
  rmSync(index, { force: true });
}

/**
 * The golden on the fix's branch. A golden marked `fork` passes on its checks from wherever it
 * diverges, so it needs nothing. One that must replay exactly gets the recording verify accepted
 * (repair packs one of each fixed run) in place of its pack, once that replays clean with the fix
 * applied, which is what the pull request's own CI runs. Otherwise it stays as it was, and the pull
 * request says how to update it.
 */
export function refreshGolden({ cli, workdir, result, repair, guard = 'block', env, scratch }) {
  const golden = (result.dir ?? result.golden ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (result.mode === 'fork') return { state: 'fork', golden, why: null };
  const stale = (why) => ({ state: 'stale', golden, why });
  const recorded = repair.output?.goldens?.[0];
  if (!recorded || !repair.output?.patch || !repair.output?.branch) return stale('repair kept no recording of the fixed run');
  try {
    const root = realpathSync(git(workdir, ['rev-parse', '--show-toplevel'], env).trim());
    const inRoot = relative(root, realpathSync(resolve(workdir, golden))).split(sep).join('/');
    if (!inRoot || inRoot.startsWith('..') || isAbsolute(inRoot)) return stale(`${golden} is not inside the repository`);
    const pack = resolve(workdir, recorded);
    const why = replaysClean({ cli, workdir, root, golden, pack, patch: resolve(workdir, repair.output.patch), guard, env, scratch });
    if (why) return stale(why);
    commitGolden({ root, branch: repair.output.branch, golden: inRoot, pack, env, scratch });
    return { state: 'recorded', golden, why: null };
  } catch (err) {
    return stale(err.message.split('\n')[0]);
  }
}

/** What the pull request says about the golden, after repair's report. */
export function goldenNote(g) {
  if (g.state === 'recorded') return `### The golden\n\n\`${g.golden}\` is re-recorded under the fix: the recording verify accepted replaces its pack in this branch, and it replays clean here, so this pull request's own checks pass. Review the new recording like any other change to a golden.\n`;
  if (g.state === 'fork') return `### The golden\n\n\`${g.golden}\` may fork, so it passes on its checks with the fix as it is.\n`;
  return `### The golden\n\n\`${g.golden}\` still holds the recording made before the fix, which sends the old prompt, so it diverges on this branch. Re-record it here and commit the change:\n\n\`\`\`sh\nshadowlap test ${g.golden} --update\n\`\`\`\n\nIt was not re-recorded automatically: ${g.why}.\n`;
}

/** Pushes the branch and opens its pull request into the branch checked out, titled by the fix commit. */
function openPullRequest(root, branch, bodyFile, env) {
  const base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], env).trim();
  const title = git(root, ['log', '-1', '--format=%s', `refs/heads/${branch}`], env).trim();
  const push = run('git', ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], root, env);
  if (push.status !== 0) return { pr: null, why: `git push origin ${branch} failed: ${(push.stderr || push.error?.message || '').trim()}` };
  const gh = run('gh', ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body-file', bodyFile], root, env);
  if (gh.error || gh.status !== 0) return { pr: null, why: `gh pr create failed: ${(gh.stderr || gh.error?.message || '').trim()}; the branch ${branch} is pushed, so it can be opened by hand` };
  return { pr: gh.stdout.trim().split('\n').at(-1) ?? '', why: null };
}

/** Why a fix stays out of the team store when the team turned pushing from CI off: their choice, not a failure. */
const PUSH_OFF = 'Push from CI is off ("ciPush": false in shadowlap.config.json)';

/**
 * Why the fixes CI opens can't go to the team store, or null when they can: none is set in
 * shadowlap.config.json, or the team turned pushing from CI off (`"ciPush": false`).
 */
export function cannotPush(workdir) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(join(workdir, 'shadowlap.config.json'), 'utf8'));
  } catch {
    // no config, or one shadowlap itself refuses: no store either way
  }
  if (typeof config.store !== 'string' || !config.store) return 'no team store is set in shadowlap.config.json (shadowlap store set <url>)';
  if (config.ciPush === false) return PUSH_OFF;
  return null;
}

/**
 * Whether GitHub runs this job for a pull request from a fork, which it gives no secrets and no cloud
 * sign-in, so nothing can reach the team store's bucket: the pull request's head is another
 * repository than its base, or one deleted since. `pull_request_target` runs as the base repository,
 * with its secrets, so it isn't counted.
 */
export function forkPullRequest(env, read = (path) => readFileSync(path, 'utf8')) {
  const event = env.GITHUB_EVENT_NAME ?? '';
  if (!env.GITHUB_ACTIONS || env.GITHUB_ACTIONS === 'false' || !event.startsWith('pull_request') || event === 'pull_request_target' || !env.GITHUB_EVENT_PATH) return false;
  try {
    const pr = JSON.parse(read(env.GITHUB_EVENT_PATH)).pull_request;
    if (!pr || typeof pr !== 'object') return false;
    if (pr.head && pr.head.repo === null) return true;
    const head = pr.head?.repo?.full_name;
    const base = pr.base?.repo?.full_name;
    return typeof head === 'string' && typeof base === 'string' && head.toLowerCase() !== base.toLowerCase();
  } catch {
    return false;
  }
}

/** What `shadowlap push` said went wrong: its `✗` line, the error itself, else the last thing it said. */
function pushError(stderr) {
  const lines = `${stderr ?? ''}`
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const said = lines.find((l) => l.startsWith('✗ '));
  return said ? said.slice(2).trim() : (lines.at(-1) ?? '');
}

/**
 * Sends the fix CI opened to the team store, with the runs it is about and the ones blame, repair and
 * verify made (`shadowlap push --all`: this job's runs), so a teammate's pull brings it to their Fixes
 * page as "from CI · PR #138". It runs once the fix's pull request is open, so nothing here keeps that
 * from opening, and it never throws or fails the job. How it went:
 *
 *   sent    push reported sending the fix: this push, or an earlier one in the same job (`sentInJob`,
 *           which the caller keeps across the job and this push's report is added to)
 *   pr      a pull request's job, which writes only to the pull request's own folder (pr/<number>/)
 *           and sends no fixes: the job's runs went there, and the fix stays off the team's Fixes page
 *   off     the team turned pushing from CI off
 *   failed  it couldn't happen, or push didn't say it did, and why: no team store set, no credentials
 *           for the bucket (a pull request from a fork gets none), the store out of reach, the fix
 *           refused, runs that stayed in the job, a fix repair didn't name or push didn't mention…
 *
 * Only push's own word puts a fix in the store: its report lists the fixes it sent and those that
 * couldn't go (`fixes`, held to docs/cli.md by the CLI's JSON contract test), and a report without
 * that list, or one that leaves the fix out, is a warning, never "in the team store".
 */
export function pushFix({ cli, db, workdir, env, fixIds = [], sentInJob = new Set(), read }) {
  const failed = (why) => ({ state: 'failed', why, pr: null });
  const why = cannotPush(workdir);
  if (why) return { state: why === PUSH_OFF ? 'off' : 'failed', why, pr: null };
  const r = run(process.execPath, [cli, ...(db ? ['--db', db] : []), 'push', '--all', '--json'], workdir, env);
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // no report: stderr says why
  }
  if (r.status !== 0 || !out || typeof out !== 'object') {
    const said = pushError(r.stderr) || r.error?.message || `shadowlap push exited ${r.status ?? r.signal}`;
    return failed(forkPullRequest(env, read) ? `a pull request from a fork, whose job GitHub gives no secrets: ${said}` : said);
  }
  if (out.pullRequest) return { state: 'pr', why: null, pr: String(out.pullRequest) };
  const fixes = out.fixes;
  if (!fixes || typeof fixes !== 'object' || !Array.isArray(fixes.sent) || !Array.isArray(fixes.failed)) return failed("shadowlap push didn't say which fixes it sent");
  for (const id of fixes.sent) if (typeof id === 'string') sentInJob.add(id);
  if (!fixIds.length) return failed("repair named no fix, so there was none for push to send");
  const refused = fixes.failed.find((f) => fixIds.includes(f?.fixId));
  if (refused) return failed(`the store didn't take the fix: ${refused.reason}`);
  if (fixIds.every((id) => sentInJob.has(id))) return { state: 'sent', why: null, pr: null };
  // A fix goes once one of its runs is in the store: runs that stayed here may have kept it here too.
  const stayed = Array.isArray(out.refused) ? out.refused[0] : null;
  return failed(stayed ? `runs stayed in the job, so the fix may have too: ${stayed.reason}` : "shadowlap push didn't report sending it");
}

/** A workflow command's message on one line, as GitHub reads it: `%`, CR and LF escaped. */
const commandText = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** What the job's log says about a fix's push: one that couldn't happen is a warning, with why. */
export function pushLine(name, pushed) {
  if (pushed.state === 'sent') return 'the fix was sent to the team store';
  if (pushed.state === 'pr') return `the fix's runs went to pull request ${pushed.pr}'s own folder in the team store; a pull request's job sends no fixes, so this one stays off the team's Fixes page`;
  if (pushed.state === 'off') return `the fix was not sent to the team store: ${pushed.why}`;
  return `::warning title=Shadowlap::${commandText(`${name}: the fix is not in the team store, so teammates won't see it on their Fixes page: ${String(pushed.why ?? '').replace(/[\s.]+$/, '')}. Its pull request is open all the same.`)}`;
}

/** Runs repair for each failed check, one golden at a time, and says how each went. */
export function runFixes({ cli, db, workdir, report, budget, repairer, guard = 'block', push = false, env, log = () => {} }) {
  const plans = planFixes(report);
  const blocked = plans.some((x) => !x.skip) ? cannotFix(workdir, env) : null;
  const scratch = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'shadowlap-fix-'));
  const fixEnv = repairEnv(workdir, env);
  const out = [];
  // The fixes this job's pushes reported sending: a later push leaves out one an earlier sent, as it is there.
  const sentInJob = new Set();
  try {
    for (const plan of plans) {
      const r = plan.result;
      if (plan.skip || blocked) {
        out.push({ golden: r.golden ?? r.name, name: r.name, outcome: 'skipped', why: plan.skip ?? blocked, pr: null, title: null, spent: 0, verify: null, goldenState: null });
        continue;
      }
      const expectFile = join(scratch, `${out.length}-expect.json`);
      writeFileSync(expectFile, JSON.stringify(r.expect));
      log(`shadowlap repair for ${r.golden ?? r.name}: blame, repair and verify, within $${Number(budget).toFixed(2)}`);
      const res = run(process.execPath, [cli, ...repairArgs(plan, { db, budget, repairer, expectFile })], workdir, fixEnv);
      if (res.stderr) process.stderr.write(res.stderr);
      let repair = null;
      try {
        repair = JSON.parse(res.stdout);
      } catch {
        // no report: stderr says why
      }
      const spent = repair?.cost ? (repair.cost.blame ?? 0) + (repair.cost.repairer ?? 0) + (repair.cost.verify ?? 0) : 0;
      const accepted = repair?.candidates?.find((c) => c.id === repair.accepted) ?? null;
      const runs = accepted?.verify?.runs ?? [];
      // Each run as verify --json prints it (outcome fixed or kept); a CLI from before that printed the verdict.
      const passed = (x) => (typeof x.outcome === 'string' ? x.outcome === 'fixed' || x.outcome === 'kept' : x.verdict === 'pass');
      const count = (role) => {
        const of = runs.filter((x) => x.role === role);
        return of.length ? `${role === 'holdout' ? 'held-out' : role} ${of.filter(passed).length} of ${of.length}` : null;
      };
      const verify = accepted ? ['target', 'holdout', 'good'].map(count).filter(Boolean).join(' · ') : null;
      if (repair?.outcome === 'fixed' && repair.output?.branch) {
        const branch = repair.output.branch;
        const g = refreshGolden({ cli, workdir, result: r, repair, guard, env: fixEnv, scratch });
        log(g.state === 'recorded' ? `${g.golden} re-recorded on ${branch}` : g.state === 'stale' ? `${g.golden} not re-recorded on ${branch}: ${g.why}` : `${g.golden} may fork: left as it is`);
        // The body is kept beside repair's report, to be read after the job.
        const reportFile = resolve(workdir, repair.output.report ?? join(repair.output.dir ?? '.', 'report.md'));
        const bodyFile = join(dirname(reportFile), 'pull-request.md');
        writeFileSync(bodyFile, `${existsSync(reportFile) ? readFileSync(reportFile, 'utf8').replace(/\s+$/, '') : ''}\n\n${goldenNote(g)}`);
        const opened = openPullRequest(realpathSync(git(workdir, ['rev-parse', '--show-toplevel'], fixEnv).trim()), branch, bodyFile, fixEnv);
        // The fix records where it went, so the dashboard shows "from CI · PR #138" and follows its state.
        if (opened.pr) for (const f of repair.fixes ?? []) if (typeof f?.fixId === 'string') run(process.execPath, [cli, ...(db ? ['--db', db] : []), 'fix', 'pr', f.fixId, opened.pr], workdir, fixEnv);
        // With push, the fix goes to the team store, so it reaches teammates rather than ending with the job.
        // Its pull request is open by now; a push that can't happen warns, and the job goes on.
        let pushed = null;
        if (opened.pr && push) {
          const fixIds = (repair.fixes ?? []).map((f) => f?.fixId).filter((id) => typeof id === 'string');
          try {
            pushed = pushFix({ cli, db, workdir, env: fixEnv, fixIds, sentInJob });
          } catch (err) {
            pushed = { state: 'failed', why: err instanceof Error ? err.message : String(err), pr: null };
          }
          log(pushLine(r.name, pushed));
        }
        if (opened.pr) out.push({ golden: r.golden ?? r.name, name: r.name, outcome: 'opened', why: null, pr: opened.pr, branch, title: accepted?.strategy ?? null, spent, verify, goldenState: g, pushed });
        else out.push({ golden: r.golden ?? r.name, name: r.name, outcome: 'not-opened', why: opened.why, pr: null, branch, title: null, spent, verify, goldenState: g });
      } else {
        // Once the budget is spent, that is why there is no fix, whatever was learned by then.
        const spentAll = spent >= Number(budget);
        const why =
          repair?.outcome === 'fixed'
            ? 'a fix was accepted, but no branch was made for it'
            : spentAll
              ? `the budget of $${Number(budget).toFixed(2)} is spent`
              : (repair?.why ?? repair?.error?.message ?? (`${res.stderr ?? ''}`.trim().split('\n').at(-1) || `repair exited ${res.status}`));
        out.push({ golden: r.golden ?? r.name, name: r.name, outcome: repair?.outcome === 'fixed' ? 'not-opened' : 'no-fix', why, pr: null, title: null, spent, verify, goldenState: null });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return out;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** What the summary says about the golden on a fix's branch. */
function goldenCell(g) {
  if (!g || g.state === 'fork') return '';
  return g.state === 'recorded' ? ' · golden re-recorded' : ` · golden not re-recorded: run \`shadowlap test ${cell(g.golden)} --update\` on the branch`;
}

/** What the summary says about a fix and the team store, with push: in it, kept to a pull request's folder, or not (a warning when it couldn't go). */
function pushCell(p) {
  if (!p) return '';
  if (p.state === 'sent') return ' · in the team store';
  if (p.state === 'pr') return ` · not on the team's Fixes page: a pull request's job writes only to its own folder, \`pr/${cell(p.pr)}/\``;
  if (p.state === 'off') return ` · not in the team store: ${cell(p.why)}`;
  return ' · ⚠️ not in the team store';
}

/** The fixes for the job summary. */
export function fixSummary(fixes, budget) {
  if (!fixes.length) return '';
  const opened = fixes.filter((f) => f.outcome === 'opened').length;
  const lines = [
    `### Shadowlap: ${opened ? `${opened} fix pull request${opened === 1 ? '' : 's'} opened` : 'no fix pull request opened'}`,
    '',
    '| | Golden | Fix | Spent |',
    '|---|---|---|---:|',
  ];
  for (const f of fixes) {
    const what =
      f.outcome === 'opened'
        ? `[${cell(f.title ?? 'fix')}](${f.pr})${f.verify ? ` · verify: ${cell(f.verify)}` : ''}${goldenCell(f.goldenState)}${pushCell(f.pushed)}`
        : f.outcome === 'skipped'
          ? cell(f.why)
          : `no fix: ${cell(f.why)}${goldenCell(f.goldenState)}`;
    const icon = f.outcome === 'opened' ? '✅' : f.outcome === 'skipped' ? '➖' : '❌';
    lines.push(`| ${icon} | \`${cell(f.name)}\` | ${what} | ${f.outcome === 'skipped' ? '' : `$${f.spent.toFixed(2)} of $${Number(budget).toFixed(2)}`} |`);
  }
  // A push that couldn't happen: each fix with why, under the table where the reasons have room.
  const unsent = fixes.filter((f) => f.pushed?.state === 'failed');
  if (unsent.length) {
    const one = unsent.length === 1;
    lines.push('', `⚠️ ${one ? 'A fix' : `${unsent.length} fixes`} couldn't go to the team store, so teammates won't see ${one ? 'it' : 'them'} on their Fixes page. ${one ? 'Its pull request is' : 'Their pull requests are'} open all the same.`, '');
    for (const f of unsent) lines.push(`- \`${String(f.name).replace(/`/g, "'")}\`: ${String(f.pushed.why ?? '').replace(/\s*\r?\n\s*/g, ' ')}`);
  }
  lines.push('', 'Each pull request carries the patch verify accepted, its report and, for a golden that must replay exactly, the golden re-recorded under the fix. Nothing is merged: review each one like any other change.');
  return lines.join('\n') + '\n';
}
