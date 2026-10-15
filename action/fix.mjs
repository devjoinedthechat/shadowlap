// Fix on failure: when a golden fails an outcome check in CI, run `shadowlap repair` on the failing
// replay (it blames it, asks the repairer for prompt fixes and keeps one only when verify accepts
// it), within a budget per golden, and open a pull request with the patch and the report. Never for
// a divergence: most divergences are intended changes, and a golden update is a person's call. It
// never merges anything.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Why a failed golden gets no fix attempt, by the kind of failure `shadowlap test --json` reports. */
const NOT_FIXED = {
  diverged: 'diverged: never fixed automatically, because most divergences are intended. Update the golden or add a normalizer',
  exit: 'the agent exited with an error, which is not an outcome check',
  'no-calls': 'the replay made no calls, which is not an outcome check',
  error: 'it could not be replayed',
};

/** The failed goldens of a test report, each with the fix it gets or why it gets none. */
export function planFixes(report) {
  return report.results
    .filter((r) => !r.ok)
    .map((r) => {
      if (r.failure !== 'check') return { result: r, skip: NOT_FIXED[r.failure] ?? 'not an outcome check' };
      if (!r.expect) return { result: r, skip: 'its checks are not under "tests" in shadowlap.config.json' };
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

/** The arguments for `shadowlap repair` on one failed golden. */
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
    '--pr',
    '--yes',
    '--json',
  ];
}

const run = (cmd, args, cwd, env) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

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

/** Runs repair for each failed check, one golden at a time, and says how each went. */
export function runFixes({ cli, db, workdir, report, budget, repairer, env, log = () => {} }) {
  const plans = planFixes(report);
  const blocked = plans.some((x) => !x.skip) ? cannotFix(workdir, env) : null;
  const scratch = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'shadowlap-fix-'));
  const fixEnv = repairEnv(workdir, env);
  const out = [];
  try {
    for (const plan of plans) {
      const r = plan.result;
      if (plan.skip || blocked) {
        out.push({ golden: r.golden ?? r.name, name: r.name, outcome: 'skipped', why: plan.skip ?? blocked, pr: null, title: null, spent: 0, verify: null });
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
      const count = (role) => {
        const of = runs.filter((x) => x.role === role);
        return of.length ? `${role === 'holdout' ? 'held-out' : role} ${of.filter((x) => x.verdict === 'pass').length} of ${of.length}` : null;
      };
      const verify = accepted ? ['target', 'holdout', 'good'].map(count).filter(Boolean).join(' · ') : null;
      if (repair?.outcome === 'fixed' && repair.output?.pr) {
        out.push({ golden: r.golden ?? r.name, name: r.name, outcome: 'opened', why: null, pr: repair.output.pr, branch: repair.output.branch, title: accepted?.strategy ?? null, spent, verify });
      } else {
        // Once the budget is spent, that is why there is no fix, whatever was learned by then.
        const spentAll = spent >= Number(budget);
        const why =
          repair?.outcome === 'fixed'
            ? 'a fix was accepted, but the pull request was not opened'
            : spentAll
              ? `the budget of $${Number(budget).toFixed(2)} is spent`
              : (repair?.why ?? repair?.error?.message ?? (`${res.stderr ?? ''}`.trim().split('\n').at(-1) || `repair exited ${res.status}`));
        out.push({ golden: r.golden ?? r.name, name: r.name, outcome: repair?.outcome === 'fixed' ? 'not-opened' : 'no-fix', why, pr: null, title: null, spent, verify });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return out;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

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
        ? `[${cell(f.title ?? 'fix')}](${f.pr})${f.verify ? ` · verify: ${cell(f.verify)}` : ''}`
        : f.outcome === 'skipped'
          ? cell(f.why)
          : `no fix: ${cell(f.why)}`;
    const icon = f.outcome === 'opened' ? '✅' : f.outcome === 'skipped' ? '➖' : '❌';
    lines.push(`| ${icon} | \`${cell(f.name)}\` | ${what} | ${f.outcome === 'skipped' ? '' : `$${f.spent.toFixed(2)} of $${Number(budget).toFixed(2)}`} |`);
  }
  lines.push('', 'Each pull request carries the patch verify accepted and its report. Nothing is merged: review each one like any other change.');
  return lines.join('\n') + '\n';
}
