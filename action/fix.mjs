// Fix on failure: when a golden fails an outcome check in CI, run `shadowlap repair` on the failing
// replay (it blames it, asks the repairer for prompt fixes and keeps one only when verify accepts
// it), within a budget per golden, and open a pull request with the patch and the report. Never for
// a divergence: most divergences are intended changes, and a golden update is a person's call. It
// never merges anything. Goldens that fail the same check are one failure, as the store keeps them
// (one fix), so they get one repair over all their failing replays and one pull request. When no
// patch fixes them all, each is repaired on its own, within what the group has left, until one fix
// is accepted: its pull request names the others, which it is not verified for.
//
// A fix changes what the agent sends, so a golden that must replay exactly would diverge on the
// fix's own branch and fail the pull request's checks. Before the branch is pushed, each fixed
// golden is re-recorded on it: the recording verify accepted takes the place of its pack, once it
// replays clean with the fix applied. Every other golden the session tested is replayed there too,
// and the pull request names the ones the fix leaves diverging, with the command that updates them.
//
// With the push input (the dashboard's Settings → CI writes it when Push from CI is on), each fix
// whose pull request opened goes to the team store too, for teammates' Fixes page. That comes after
// the pull request, so it never keeps one from opening, and a push that can't happen warns in the
// log and the job summary, with why, and never fails the job.
//
// The fix is verified on more than the golden that failed: every other golden failing the same check
// is held out from the repairer, and goldens that passed under it are kept, each decided by the gate
// of the golden that failed. The pull request says what it was verified on, and how its checks start:
// GitHub starts none for a pull request the job's GITHUB_TOKEN opened, so without a github-token the
// action starts this workflow on the fix's branch itself, and the pull request says whether it could.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dispatchWorkflow, githubToken, tokenEnv } from './github.mjs';
import { markdownCode, markdownFence, markdownText } from './markdown.mjs';

/** Why a failed golden gets no fix attempt, by the kind of failure `shadowlap test --json` reports. */
const NOT_FIXED = {
  diverged: 'diverged: never fixed automatically, because most divergences are intended. Update the golden or add a normalizer',
  exit: 'the agent exited with an error, which is not an outcome check',
  'no-calls': 'the replay made no calls, which is not an outcome check',
  error: 'it could not be replayed',
  inconclusive: 'its verdict is inconclusive, neither passed nor failed: more attempts settle it, not a fix',
  injection: 'its injection gate failed: the agent obeyed text planted in what it reads, which is fixed in its prompt or its code, not by a fix on failure. shadowlap injection <golden> --html report.html shows every attempt',
};

/** Why a golden whose injection gate is inconclusive gets no fix: it showed too little to say, which no fix changes. */
const INJECTION_INCONCLUSIVE = 'its injection gate is inconclusive, neither passed nor failed: it showed too little to say, as its reason says, and a fix on failure changes none of that. shadowlap injection <golden> --html report.html shows every attempt';

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

/**
 * The checks of a golden that could not be decided (a judge check with no verdict, a condition that
 * can't be read). A prompt fix decides none of them, and while one stays so no replay of the golden
 * passes, so its verify could never accept a fix. A result kept before results had a status has none.
 */
function inconclusiveChecks(checks) {
  return (Array.isArray(checks) ? checks : []).filter((c) => c && !c.ok && c.status === 'inconclusive');
}

/**
 * Why a golden with checks that could not be decided gets no fix: a judge check that was not judged
 * gets its verdict recorded, and any other is given what decides it.
 */
function undecidedSkip(r, undecided) {
  if (undecided.every((c) => c.judge)) {
    const names = undecided.map((c) => String(c.judge.name ?? c.label));
    const one = names.length === 1;
    return `its judge check${one ? '' : 's'} ${names.join(', ')} ${one ? 'was' : 'were'} not judged, which no prompt fix changes: record ${one ? 'its verdict' : 'their verdicts'} with shadowlap test ${r.dir ?? r.golden} --update`;
  }
  const one = undecided.length === 1;
  return `${one ? 'a check is' : `${undecided.length} checks are`} inconclusive (${undecided.map((c) => String(c.label)).join('; ')}), which no prompt fix decides, and no replay passes while ${one ? 'it is' : 'they are'}: give ${one ? 'it' : 'them'} what decides ${one ? 'it' : 'them'} (a verdict for a judge, a value a condition can read)`;
}

/** The failed goldens of a test report, each with the fix it gets or why it gets none. */
export function planFixes(report) {
  return report.results
    .filter((r) => !r.ok)
    .map((r) => {
      // A check that could not be decided, whatever else failed: no replay passes while it stays so.
      const undecided = inconclusiveChecks(r.checks);
      if (undecided.length && (r.failure === 'check' || r.failure === 'inconclusive')) return { result: r, skip: undecidedSkip(r, undecided) };
      // An injection gate that showed too little to say is inconclusive, never one the agent failed.
      if (r.failure === 'injection' && verdictOf(r) === 'inconclusive') return { result: r, skip: INJECTION_INCONCLUSIVE };
      if (r.failure !== 'check') return { result: r, skip: NOT_FIXED[r.failure] ?? 'not an outcome check' };
      if (!r.expect) return { result: r, skip: 'its checks are not under "tests" in shadowlap.config.json' };
      const unpriced = unpricedOnly(r.checks);
      if (unpriced) return { result: r, skip: `it fails only because ${unpriced.join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} no price, which no prompt fix changes: add ${unpriced.length === 1 ? 'it' : 'them'} under "prices" in shadowlap.config.json` };
      // A replay a check could not decide neither failed nor passed: a fix is not verified on it either way.
      const failing = (r.runs ?? []).filter((x) => verdictOf(x) === 'failed').map((x) => x.runId);
      if (!failing.length) return { result: r, skip: 'no failing replay was kept' };
      return { result: r, skip: null, fixes: failing, keeps: (r.runs ?? []).filter((x) => verdictOf(x) === 'passed').map((x) => x.runId) };
    });
}

/** Canonical JSON: keys sorted, so the same check written in another order is the same check. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * The failed goldens that get a fix attempt, grouped into the fixes their failures join. A test's
 * replays carry no labels, so a failing replay joins the fix with its check (compared canonically,
 * as the store compares it), and goldens that fail the same check are one failure: they are repaired
 * together, with every failing replay a target and every passing one kept, so one patch has to fix
 * them all, and they get one pull request. Each group is a plan of its own (the first golden names
 * its branch), with `members` the goldens in it, in the report's order.
 */
export function groupFixes(plans) {
  const groups = new Map();
  for (const p of plans) {
    if (p.skip) continue;
    const key = canonical(p.result.expect);
    const g = groups.get(key);
    if (!g) groups.set(key, { result: p.result, skip: null, fixes: [...p.fixes], keeps: [...p.keeps], members: [p] });
    else {
      g.members.push(p);
      g.fixes.push(...p.fixes);
      g.keeps.push(...p.keeps);
    }
  }
  return [...groups.values()];
}

/** A branch name for a golden's fix that no other run of the workflow uses: `shadowlap/fix-refund-flow-7k2q1x`. */
export function branchName(result) {
  const slug = (result.golden ?? result.name).toLowerCase().replace(/^goldens\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'golden';
  return `shadowlap/fix-${slug}-${(result.runId ?? '').slice(-6).toLowerCase() || Date.now().toString(36)}`;
}

/**
 * Goldens that passed under the same check that a repair keeps, at most. Each runs live under every
 * candidate, as many attempts as the gate asks (12 at the least for the default gate), within the
 * failing goldens' budget, so two say a fix breaks no good run without trebling what verify costs.
 */
export const KEEPS_AT_MOST = 2;

/**
 * A golden's own gate, as repair takes it: an SPRT gate's figures (`--gate`), a fixed count's attempts
 * and passes (`--attempts`, `--passes`), `history` for a gate against history, which verify doesn't
 * take, or null for a golden one replay decides, whose candidates verify's default gate decides.
 */
export function goldenGate(r) {
  const g = r?.gate;
  if (g && g.kind === 'sprt' && [g.good, g.bad, g.risk, g.max].every((x) => typeof x === 'number' && Number.isFinite(x))) return { kind: 'sprt', good: g.good, bad: g.bad, risk: g.risk, max: g.max };
  if (g && g.kind === 'baseline') return { kind: 'history' };
  const a = r?.attempts;
  if (!g && a && typeof a.required === 'number' && a.total > 1) return { kind: 'count', attempts: a.total, passes: a.required };
  return null;
}

/** A passing replay of a golden the session passed: one its result names as passed. */
const passingRun = (r) => (r.runs ?? []).find((x) => verdictOf(x) === 'passed')?.runId ?? (r.ok && r.runId ? r.runId : null);

/**
 * What one repair of goldens that fail the same check is given (`members`, in the report's order),
 * from the session's `results`: one failing replay of each golden, since verify replays it under a
 * candidate as many times as the gate asks and every replay of a golden is the same case; every
 * other golden held out from the repairer (the first, third, … shown to it, the second, fourth, …
 * held out), so the fix must hold for goldens it was not written against; and up to KEEPS_AT_MOST
 * goldens the session passed under the same check, which must keep passing. Each run is decided by
 * the gate of the first golden. A golden alone has nothing held out, which the pull request says.
 */
export function repairPlan(members, results = []) {
  const first = members[0].result;
  const failing = (m) => (m.fixes ?? [])[0];
  const shown = members.filter((m, i) => i % 2 === 0 && failing(m));
  const held = members.filter((m, i) => i % 2 === 1 && failing(m));
  const key = canonical(first.expect);
  const own = new Set(members.map((m) => dirOf(m.result)));
  const kept = results.filter((r) => r && verdictOf(r) === 'passed' && r.expect && canonical(r.expect) === key && !own.has(dirOf(r)) && passingRun(r)).slice(0, KEEPS_AT_MOST);
  return {
    result: first,
    fixes: shown.map(failing),
    holdout: held.map(failing),
    keeps: kept.map(passingRun),
    gate: goldenGate(first),
    goldens: { shown: shown.map((m) => dirOf(m.result)), heldOut: held.map((m) => dirOf(m.result)), kept: kept.map(dirOf) },
  };
}

/**
 * The arguments for `shadowlap repair` on a plan: its failing runs, those held out, those kept, the
 * check, and the golden's gate (`gateFile` holds an SPRT gate's figures). Blame and verify run the
 * agent live under the step's network guard (`guard`), as its test did, and with `build` (the
 * fix-build input) each candidate's worktree is built once the candidate is in it. It commits the
 * fix it keeps to a new branch; the branch is pushed and the pull request opened here, once the
 * golden is re-recorded on it.
 */
export function repairArgs(plan, { db, budget, repairer, expectFile, gateFile = null, guard = 'block', build = '' }) {
  const gate = plan.gate ?? null;
  return [
    ...(db ? ['--db', db] : []),
    'repair',
    '--fixes',
    ...plan.fixes,
    ...(plan.holdout?.length ? ['--holdout', ...plan.holdout] : []),
    ...(plan.keeps.length ? ['--keeps', ...plan.keeps] : []),
    '--expect',
    `@${expectFile}`,
    ...(gate?.kind === 'sprt' && gateFile ? ['--gate', `@${gateFile}`] : gate?.kind === 'count' ? ['--attempts', String(gate.attempts), '--passes', String(gate.passes)] : []),
    '--budget',
    String(budget),
    ...(repairer ? ['--repairer', repairer] : []),
    '--guard',
    guard,
    ...(build ? ['--build', build] : []),
    '--branch',
    branchName(plan.result),
    '--yes',
    '--json',
  ];
}

/**
 * What the pull request says the fix was verified on: the goldens shown to the repairer, those held
 * out from it, those kept, and the gate each was decided by; or, verified on the failing golden
 * alone, exactly that.
 */
export function evidenceNote({ goldens, gate }) {
  const code = (dirs) => listed(dirs.map((d) => markdownCode(d)));
  const parts = ['### What the fix was verified on\n'];
  const one = goldens.shown.length === 1;
  if (!goldens.heldOut.length && !goldens.kept.length) {
    parts.push(`Only on ${code(goldens.shown)}, whose failing replay${one ? ' was' : 's were'} shown to the repairer: no other golden the session tested fails the same check to hold out from it, and none passed it to keep. That the fix holds for a case the repairer did not see is not tested here.\n`);
  } else {
    parts.push(`Shown to the repairer: ${code(goldens.shown)}, ${one ? 'its' : 'their'} failing replay${one ? '' : 's'}.`);
    if (goldens.heldOut.length) parts.push(`Held out from it: ${code(goldens.heldOut)}, which fail${goldens.heldOut.length === 1 ? 's' : ''} the same check, and which the fix repairs too.`);
    else parts.push('Held out from it: nothing, as no other golden the session tested fails the same check.');
    if (goldens.kept.length) parts.push(`Kept: ${code(goldens.kept)}, which passed the same check, and still pass${goldens.kept.length === 1 ? 'es' : ''} it under the fix.`);
    parts.push('');
  }
  const pct = (x) => `${+(x * 100).toFixed(2)}%`;
  if (gate?.kind === 'sprt') parts.push(`Each was decided by the golden's own gate: it tells ${pct(gate.good)}+ from ${pct(gate.bad)}- at <= ${pct(gate.risk)} risk, up to ${gate.max} attempts.\n`);
  else if (gate?.kind === 'count') parts.push(`Each was decided by the golden's own count: ${gate.passes} of ${gate.attempts} attempts must pass.\n`);
  else if (gate?.kind === 'history') parts.push("The golden's gate is against its history, which verify doesn't take, so each was decided by verify's default gate.\n");
  return parts.join('\n');
}

/**
 * What the pull request says about its own checks, never that they pass: GitHub starts them for a
 * pull request the action opened with a github-token; for one the job's GITHUB_TOKEN opened it starts
 * none, so the action started this workflow on the branch, or says it could not and what to do.
 */
export function checksNote({ auth, dispatch = null }) {
  if (auth?.startsWorkflows) return `### Its checks\n\nThis pull request was opened with the token the action was given${auth.source === 'input' ? ' (`github-token`)' : ' (`GH_TOKEN`)'}, so GitHub starts its workflows as for any pull request.\n`;
  const start = 'give the action a `github-token` (a GitHub App\'s token or a personal access token), and the next fix pull request starts them itself';
  if (dispatch?.dispatched) return `### Its checks\n\nThis pull request was opened with the job's \`GITHUB_TOKEN\`, for which GitHub starts no workflow, so the job started ${markdownCode(dispatch.workflow)} on its branch (\`workflow_dispatch\`); that run checks this branch. Other workflows that run on pull requests have not started: ${start}.\n`;
  // Why it could not, in GitHub's own words, as text: none of it renders.
  return `### Its checks\n\nThis pull request was opened with the job's \`GITHUB_TOKEN\`, for which GitHub starts no workflow, and the job could not start ${dispatch?.workflow ? markdownCode(dispatch.workflow) : 'its workflow'} on its branch: ${markdownText(dispatch?.why ?? 'it was not asked to')}. No check has run on this branch: push a commit to it, or close and reopen this pull request, to start them; or ${start}.\n`;
}

const run = (cmd, args, cwd, env, input) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });

/** git, failing loudly: its stdout, or an error in git's own words. */
function git(cwd, args, env, input) {
  const r = run('git', args, cwd, env, input);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}

/** The checkout's ref that gives a pull request's job its branch when it is one of this repository's (docs/ci.md). */
const BRANCH_REF = '${{ github.event.pull_request.head.repo.full_name == github.repository && github.head_ref || github.ref }}';

/**
 * Why fixes can't be opened from this checkout, or null. A pull request needs a branch to target;
 * a pull request's own workflow checks out a detached merge commit unless told otherwise. A pull
 * request from a fork gets a token from GitHub that may not push a branch, and its branch is the
 * fork's, so it gets no fix whatever is checked out.
 */
export function cannotFix(workdir, env, read) {
  if (forkPullRequest(env, read)) return "a pull request from a fork gets a token from GitHub that may not push a branch, and its branch is the fork's, so no fix is opened from its job";
  const head = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], workdir, env);
  if (head.status !== 0) return 'the working directory is not a git repository';
  const branch = head.stdout.trim();
  if (branch === 'HEAD') return `HEAD is detached, so there is no branch to open a fix against: check out the branch itself (on pull requests, actions/checkout with ref: ${BRANCH_REF})`;
  // The workflow this action started on a fix's branch, or a fix's own pull request: its checks say
  // whether the fix holds, and a fix of the fix would stack one pull request on another.
  if (branch.startsWith('shadowlap/fix-')) return `${branch} is the branch of a fix this action opened: its checks say whether the fix holds, and no fix is opened from it`;
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

/** A golden's folder as the reports name it: forward slashes, no trailing one. */
const dirOf = (r) => String(r?.dir ?? r?.golden ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/** Names in a sentence: `a`, `a and b`, `a, b and c`. */
const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Runs the fix-build command in `cwd`: whether it passed, and the last lines it printed. */
function runBuild(build, cwd, env) {
  const r = spawnSync(build, { cwd, env, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' · ');
  return { ok: r.status === 0, tail: tail || `exit ${String(r.status ?? r.signal)}` };
}

/**
 * The branch, tried in the working tree, where the agent's dependencies are, as verify ran it: each
 * golden in `swaps` gets the recording verify accepted in place of its pack entries, the patch is
 * applied, the agent is built with `build` (the fix-build input) when there is one, `shadowlap test`
 * replays `dirs` (their checks included), and everything is put back, the build run again so what it
 * makes is the working tree's own. Returns each folder's result, or why the test could not run, and
 * a warning when the build after the fix came out failed.
 */
function replayOnBranch({ cli, workdir, root, swaps, dirs, patch, guard, build = '', env, scratch }) {
  const aside = join(scratch, 'golden-aside');
  const moved = [];
  let applied = false;
  // What it found: the finally below can still add the warning to it once it has been returned.
  const out = { why: null, results: new Map(), warning: null };
  try {
    swaps.forEach((swap, i) => {
      const dir = resolve(workdir, swap.golden);
      const keep = join(aside, String(i));
      mkdirSync(keep, { recursive: true });
      for (const e of PACK_ENTRIES) {
        if (!present(join(dir, e))) continue;
        move(join(dir, e), join(keep, e));
        moved.push({ dir, keep, e });
      }
      for (const e of PACK_ENTRIES) if (present(join(swap.pack, e))) cpSync(join(swap.pack, e), join(dir, e), { recursive: true });
    });
    const apply = run('git', ['apply', '--whitespace=nowarn', patch], root, env);
    if (apply.status !== 0) return Object.assign(out, { why: `the fix does not apply to the working tree: ${(apply.stderr ?? '').trim()}` });
    applied = true;
    if (build) {
      const b = runBuild(build, workdir, env);
      if (!b.ok) return Object.assign(out, { why: `${build} failed with the fix in place: ${b.tail}` });
    }
    const json = join(scratch, 'branch-test.json');
    rmSync(json, { force: true });
    const t = run(process.execPath, [cli, '--db', ':memory:', 'test', ...dirs, '--json', json, '--guard', guard], workdir, env);
    let report = null;
    try {
      report = JSON.parse(readFileSync(json, 'utf8'));
    } catch {
      // no report: its output says why
    }
    if (!Array.isArray(report?.results)) return Object.assign(out, { why: `shadowlap test did not finish on the branch: ${`${t.stderr ?? ''}`.trim().split('\n').at(-1) || `exit ${String(t.status ?? t.signal)}`}` });
    return Object.assign(out, { results: new Map(report.results.map((r) => [dirOf(r), r])) });
  } finally {
    // The goldens go back whatever happens to the patch, and a patch that won't come out is said.
    const back = applied ? run('git', ['apply', '-R', '--whitespace=nowarn', patch], root, env) : null;
    for (const swap of swaps) for (const e of PACK_ENTRIES) rmSync(join(resolve(workdir, swap.golden), e), { recursive: true, force: true });
    for (const m of moved) move(join(m.keep, m.e), join(m.dir, m.e));
    rmSync(aside, { recursive: true, force: true });
    // eslint-disable-next-line no-unsafe-finally -- a fix left in the working tree is said over the result, which the caller would otherwise trust
    if (back && back.status !== 0) throw new Error(`the fix could not be taken back out of the working tree: ${(back.stderr ?? '').trim()}`);
    // What the build made with the fix in place is made again without it, for the steps after this one.
    if (back && build) {
      const b = runBuild(build, workdir, env);
      if (!b.ok) out.warning = `${build} failed once the fix was taken back out of the working tree, so what it built there may still be the fix's: ${b.tail}`;
    }
  }
}

/**
 * The branch's fix commit made again with each golden's pack replaced by the recording in `packs`
 * (a golden's other files stay), so the pull request is one commit: the fix and the recordings that
 * prove it. HEAD and the working tree stay as they are.
 */
function commitGoldens({ root, branch, packs, env, scratch }) {
  const head = git(root, ['rev-parse', '--verify', `refs/heads/${branch}`], env).trim();
  const [subject, , ...rest] = git(root, ['log', '-1', '--format=%B', head], env).replace(/\s+$/, '').split('\n');
  const [an, ae, ad] = git(root, ['log', '-1', '--format=%an%x00%ae%x00%aI', head], env).trim().split('\0');
  const index = join(scratch, 'golden-index');
  const ienv = { ...env, GIT_INDEX_FILE: index };
  git(root, ['read-tree', head], ienv);
  for (const { golden, pack } of packs) {
    git(root, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...PACK_ENTRIES.map((e) => `${golden}/${e}`)], ienv);
    for (const f of filesUnder(pack)) {
      const blob = git(root, ['hash-object', '-w', join(pack, f)], env).trim();
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${golden}/${f}`], ienv);
    }
  }
  const tree = git(root, ['write-tree'], ienv).trim();
  const body = rest.join('\n').trim();
  const names = packs.map((p) => p.golden);
  const what = names.length === 1 ? `${names[0]} is re-recorded under the fix, from the run verify accepted: the prompt it sends changed, so the recording made before the fix would diverge here.` : `${listed(names)} are re-recorded under the fix, from the runs verify accepted: the prompt they send changed, so the recordings made before the fix would diverge here.`;
  const message = `${String(subject)}\n\n${body ? `${body}\n\n` : ''}${what}\n`;
  const commit = git(root, ['commit-tree', tree, '-p', `${head}^`, '-F', '-'], { ...env, GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad }, message).trim();
  git(root, ['update-ref', `refs/heads/${branch}`, commit, head], env);
  rmSync(index, { force: true });
}

/**
 * The goldens on the fix's branch, and the other goldens the session tested. Each of the fix's own
 * goldens (`members`, the plans repaired together) that may fork passes on its checks from wherever
 * it diverges, so it needs nothing. One that must replay exactly gets the recording verify accepted
 * for one of its failing replays (repair packs one of each fixed run) in place of its pack, once that
 * replays clean with the fix applied, which is what the pull request's own CI runs; otherwise it stays
 * as it was, and the pull request says how to update it. Every other golden in `results` that must
 * replay exactly is replayed with the fix too: one that passed before and fails now is `diverging`,
 * one that failed before too is `failing`; one that may fork runs live from where it diverges, so it
 * is not replayed here (`unreplayed`). `checked` says whether the replay ran; when it couldn't,
 * `why` says why and the other goldens it would have replayed are `unchecked`. Goldens in `unfixed`
 * fail the same check, and the fix was verified without them (`unfixedWhy` says how it came to
 * that): each is `unfixed`, as it was, and the pull request says how to see whether the fix repairs
 * it too.
 */
export function refreshGoldens({ cli, workdir, members, unfixed = [], unfixedWhy = null, results = [], repair, guard = 'block', build = '', env, scratch }) {
  const goldens = [];
  const candidates = [];
  const recordings = repair.output?.goldens ?? [];
  const usable = !!repair.output?.patch && !!repair.output?.branch;
  for (const m of members) {
    const golden = dirOf(m.result);
    if (m.result.mode === 'fork') {
      goldens.push({ state: 'fork', golden, why: null });
      continue;
    }
    // The recording of one of this golden's failing replays: repair names each by its run's short id.
    const mine = recordings.find((g) => (m.fixes ?? []).some((id) => String(g).replace(/\\/g, '/').endsWith(`/${String(id).slice(0, 10)}`)));
    const recorded = mine ?? (members.length === 1 ? recordings[0] : undefined);
    const state = { state: 'stale', golden, why: recorded && usable ? null : 'repair kept no recording of the fixed run' };
    goldens.push(state);
    if (recorded && usable) candidates.push({ golden, recorded, state });
  }
  // Goldens that fail the same check, which the fix was not verified for: named, never re-recorded.
  for (const u of unfixed) goldens.push({ state: 'unfixed', golden: dirOf(u.result), why: unfixedWhy, ...(u.result.mode === 'fork' ? { fork: true } : {}) });
  const own = new Set([...members, ...unfixed].map((m) => dirOf(m.result)));
  const others = results.filter((r) => dirOf(r) && !own.has(dirOf(r)));
  const replayed = others.filter((r) => r.mode !== 'fork');
  const out = { goldens, others: { diverging: [], failing: [], inconclusive: [], unsettled: [], unreplayed: others.filter((r) => r.mode === 'fork').map(dirOf), unchecked: [], replayed: 0 }, checked: false, why: null, warning: null };
  if (!usable || (!candidates.length && !replayed.length)) {
    out.checked = usable;
    return out;
  }
  // Nothing was re-recorded, and when the replay itself never ran, nothing is known of the others either.
  const cannot = (why) => {
    for (const c of candidates) if (c.state.state !== 'recorded') c.state.why ??= why;
    if (out.checked) return;
    out.why = why;
    out.others.unchecked = replayed.map(dirOf);
  };
  try {
    const root = realpathSync(git(workdir, ['rev-parse', '--show-toplevel'], env).trim());
    const swaps = [];
    for (const c of candidates) {
      const inRoot = relative(root, realpathSync(resolve(workdir, c.golden))).split(sep).join('/');
      if (!inRoot || inRoot.startsWith('..') || isAbsolute(inRoot)) c.state.why = `${c.golden} is not inside the repository`;
      else swaps.push({ ...c, inRoot, pack: resolve(workdir, c.recorded) });
    }
    const dirs = [...swaps.map((c) => c.golden), ...replayed.map(dirOf)];
    if (!dirs.length) return out;
    const tried = replayOnBranch({ cli, workdir, root, swaps, dirs, patch: resolve(workdir, repair.output.patch), guard, build, env, scratch });
    out.warning = tried.warning;
    if (tried.why) {
      // tried.why can carry the agent's output: escaped here, so branchNote shows it as it is.
      cannot(markdownText(tried.why));
      return out;
    }
    const clean = [];
    for (const c of swaps) {
      const t = tried.results.get(c.golden);
      // The run's own name and message, which can be anyone's words: escaped here, so goldenNote shows the why as it is.
      const said = t?.message ? ` (${markdownText(t.name)}: ${markdownText(t.message)})` : '';
      if (t && verdictOf(t) === 'passed') clean.push(c);
      else c.state.why = t && verdictOf(t) === 'inconclusive' ? `the recording verify accepted is inconclusive on the branch, neither passed nor failed${said}` : `the recording verify accepted does not replay clean on the branch${said}`;
    }
    for (const r of replayed) {
      const where = otherOnBranch(r, tried.results.get(dirOf(r)));
      if (where) out.others[where].push(dirOf(r));
    }
    out.others.replayed = replayed.length;
    out.checked = true;
    if (clean.length) {
      commitGoldens({ root, branch: repair.output.branch, packs: clean.map((c) => ({ golden: c.inRoot, pack: c.pack })), env, scratch });
      for (const c of clean) Object.assign(c.state, { state: 'recorded', why: null });
    }
  } catch (err) {
    cannot(markdownText(err.message.split('\n')[0]));
  }
  return out;
}

/** How a test report's result came out, whatever CI made of it; a result from before results had a verdict reads as `ok` says. */
const verdictOf = (r) => r.verdict ?? (r.ok ? 'passed' : 'failed');

/**
 * How another golden the session tested fares on a fix's branch, from its result in the session
 * (`before`) and on the branch (`now`): null when it passes there; `inconclusive` when it is neither
 * passed nor failed there, which says nothing of the fix; else, failing there, `diverging` when it
 * passed before, `failing` when it failed before too, and `unsettled` when it was inconclusive before.
 */
export function otherOnBranch(before, now) {
  const is = now ? verdictOf(now) : 'failed';
  if (is === 'passed') return null;
  if (is === 'inconclusive') return 'inconclusive';
  const was = verdictOf(before);
  return was === 'passed' ? 'diverging' : was === 'failed' ? 'failing' : 'unsettled';
}

/**
 * What the pull request says about one of the fix's goldens. Why it is as it is can hold what a check
 * found in a run, or a command's output: it is text, in which nothing renders (markdown.mjs).
 */
export function goldenNote(g) {
  const name = markdownCode(g.golden);
  const update = markdownFence(`shadowlap test ${g.golden} --update`, 'sh');
  if (g.state === 'unfixed') {
    const head = `${name} fails the same check, but this fix is not verified for it${g.why ? `: ${g.why}` : ''}.`;
    if (g.fork) return `${head} It may fork, so on this branch it runs live from where it diverges, and its checks say whether the fix repairs it too.\n`;
    return `${head} It still holds the recording made before the fix, so it diverges on this branch. Re-recording it here keeps the new recording only when it passes its checks, which says whether the fix repairs it too; if it fails them, it is left as it is, and it needs a fix of its own:\n\n${update}\n`;
  }
  if (g.state === 'recorded') return `${name} is re-recorded under the fix: the recording verify accepted replaces its pack in this branch, and it replays clean here. Review the new recording like any other change to a golden.\n`;
  if (g.state === 'fork') return `${name} may fork, so it passes on its checks with the fix as it is.\n`;
  return `${name} still holds the recording made before the fix, which sends the old prompt, so it diverges on this branch. Re-record it here and commit the change:\n\n${update}\n\nIt was not re-recorded automatically: ${String(g.why ?? '')}.\n`;
}

/**
 * What the pull request says, after repair's report, about the goldens on its branch: each of the
 * fix's own, the other goldens the fix leaves diverging (with the command that re-records them), and
 * that its own checks pass only when every golden replayed there replays clean.
 */
export function branchNote({ goldens, others = { diverging: [], failing: [], inconclusive: [], unsettled: [], unreplayed: [], unchecked: [], replayed: 0 }, checked = false, why = null }) {
  const code = (dirs) => listed(dirs.map((d) => markdownCode(d)));
  const parts = [`### The golden${goldens.length === 1 ? '' : 's'}\n`, ...goldens.map(goldenNote)];
  const d = others.diverging;
  if (d.length) parts.push(`The fix changes what the agent sends, so ${d.length === 1 ? 'another golden, which passed before it, diverges' : `${d.length} other goldens, which passed before it, diverge`} on this branch: ${code(d)}. Re-record ${d.length === 1 ? 'it' : 'them'} here once the change is what you meant, and commit the change:\n\n${markdownFence(`shadowlap test ${d.join(' ')} --update`, 'sh')}\n`);
  if (others.failing.length) parts.push(`${code(others.failing)} failed before the fix too, and ${others.failing.length === 1 ? 'fails' : 'fail'} on this branch as well.\n`);
  // Neither passed nor failed: never counted as a golden the fix broke, nor as one that replays clean.
  const unsettled = others.unsettled ?? [];
  if (unsettled.length) parts.push(`${code(unsettled)} ${unsettled.length === 1 ? 'was' : 'were'} inconclusive before the fix, and ${unsettled.length === 1 ? 'fails' : 'fail'} on this branch.\n`);
  const inconclusive = others.inconclusive ?? [];
  if (inconclusive.length) parts.push(`${code(inconclusive)} ${inconclusive.length === 1 ? 'is' : 'are'} inconclusive on this branch, neither passed nor failed, so whether the fix changes ${inconclusive.length === 1 ? 'it' : 'them'} is not known: run ${markdownCode(`shadowlap test ${inconclusive.join(' ')}`)} on it to see why.\n`);
  const unchecked = others.unchecked ?? [];
  if (unchecked.length) parts.push(`${code(unchecked)} could not be replayed under the fix here${why ? ` (${why})` : ''}, so whether ${unchecked.length === 1 ? 'it diverges' : 'they diverge'} on this branch is not known: run ${markdownCode(`shadowlap test ${unchecked.join(' ')}`)} on it to see.\n`);
  if (others.unreplayed.length) parts.push(`${code(others.unreplayed)} may fork, so ${others.unreplayed.length === 1 ? 'it was' : 'they were'} not replayed here: ${others.unreplayed.length === 1 ? 'it runs' : 'they run'} live from where ${others.unreplayed.length === 1 ? 'it diverges' : 'they diverge'}, and ${others.unreplayed.length === 1 ? 'its' : 'their'} checks decide.\n`);
  const replayed = goldens.filter((g) => g.state === 'recorded').length + (checked ? others.replayed : 0);
  const clean = checked && !goldens.some((g) => g.state === 'stale' || g.state === 'unfixed') && !d.length && !others.failing.length && !unsettled.length && !inconclusive.length && !unchecked.length;
  const forks = others.unreplayed.length || goldens.some((g) => g.state === 'fork');
  // What this job saw, never what the pull request's own checks will say: they run elsewhere, later.
  if (clean && replayed) parts.push(forks ? 'Every golden this job replayed exactly replays clean on this branch.\n' : 'Every golden this job tested replays clean on this branch: `shadowlap test` passed on it here.\n');
  return parts.join('\n');
}

/** Pushes a fix's branch to origin: `{ ok, why }`. */
function pushBranch(root, branch, env) {
  const push = run('git', ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], root, env);
  return push.status === 0 ? { ok: true, why: null } : { ok: false, why: `git push origin ${branch} failed: ${(push.stderr || push.error?.message || '').trim()}` };
}

/** Opens the pushed branch's pull request into the branch checked out, titled by the fix commit. */
function createPullRequest(root, branch, bodyFile, env) {
  const base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], env).trim();
  const title = git(root, ['log', '-1', '--format=%s', `refs/heads/${branch}`], env).trim();
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
    const said = pushError(r.stderr) || r.error?.message || `shadowlap push exited ${String(r.status ?? r.signal)}`;
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

/**
 * Why goldens repaired together, then one at a time, got no fix: once when every try ended the same
 * way, else each try's own reason.
 */
function triedWhy(together, alone, members) {
  if (alone.length === members && alone.every((a) => a.why === together)) return `together and each on its own: ${together}`;
  return [`together: ${together}`, ...alone.map((a) => `${a.golden} on its own: ${a.why}`)].join(' · ');
}

/** Whether a repair that kept no fix leaves one for a repair of fewer goldens to find: it ran to its end, with a repairer to ask. */
const worthSplitting = (repair) => !!repair && (repair.outcome === 'not-fixed' || repair.outcome === 'no-diagnosis') && !repair.noRepairer;

/**
 * Runs repair for each failed check, one fix at a time (goldens that fail the same check together,
 * within their budgets added up), and says how each went. When no patch fixes all the goldens of a
 * group, each is repaired on its own, in the report's order, within what the group has left, until
 * one fix is accepted: that fix gets the group's one pull request, which names the goldens it was
 * not verified for, and no other. Repair runs the agent under the step's `guard`, and with `build`
 * (the fix-build input) builds it once a candidate is in. `auth` is the token the branch is pushed
 * and the pull request opened with (githubToken); with the job's own GITHUB_TOKEN, the workflow is
 * started on the branch between the two, through `fetch`.
 */
export async function runFixes({ cli, db, workdir, report, budget, repairer, guard = 'block', build = '', push = false, env, auth = githubToken(env), fetch: fetchFn = globalThis.fetch, log = () => {} }) {
  const plans = planFixes(report);
  const blocked = plans.some((x) => !x.skip) ? cannotFix(workdir, env) : null;
  const groups = groupFixes(plans);
  const scratch = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'shadowlap-fix-'));
  const fixEnv = repairEnv(workdir, env);
  const out = [];
  // The fixes this job's pushes reported sending: a later push leaves out one an earlier sent, as it is there.
  const sentInJob = new Set();
  let repairs = 0;
  try {
    for (const plan of plans) {
      const r = plan.result;
      if (plan.skip || blocked) {
        out.push({ golden: r.golden ?? r.name, name: r.name, outcome: 'skipped', why: plan.skip ?? blocked, pr: null, title: null, spent: 0, verify: null, goldenState: null });
        continue;
      }
      // A golden repaired with the first one of its group is reported with it.
      const group = groups.find((g) => g.members[0] === plan);
      if (!group) continue;
      const names = group.members.map((m) => m.result.name).join(', ');
      const goldenOf = (m) => m.result.golden ?? m.result.name;
      const goldens = group.members.map(goldenOf);
      const allowed = Number(budget) * group.members.length;
      /** One repair, of the group or one of its goldens, within `within` dollars: what it was given, reported and spent. */
      const attempt = (target, within, line) => {
        const plan = repairPlan(target.members ?? [target], report.results);
        const n = repairs++;
        const expectFile = join(scratch, `${n}-expect.json`);
        writeFileSync(expectFile, JSON.stringify(r.expect));
        const gateFile = plan.gate?.kind === 'sprt' ? join(scratch, `${n}-gate.json`) : null;
        if (gateFile) writeFileSync(gateFile, JSON.stringify({ good: plan.gate.good, bad: plan.gate.bad, risk: plan.gate.risk, max: plan.gate.max }));
        log(line);
        const res = run(process.execPath, [cli, ...repairArgs(plan, { db, budget: within, repairer, expectFile, gateFile, guard, build })], workdir, fixEnv);
        if (res.stderr) process.stderr.write(res.stderr);
        let repair = null;
        try {
          repair = JSON.parse(res.stdout);
        } catch {
          // no report: stderr says why
        }
        const spent = repair?.cost ? (repair.cost.blame ?? 0) + (repair.cost.repairer ?? 0) + (repair.cost.verify ?? 0) : 0;
        const why = repair?.why ?? repair?.error?.message ?? (`${res.stderr ?? ''}`.trim().split('\n').at(-1) || `repair exited ${String(res.status ?? res.signal)}`);
        return { repair, spent, why, fixed: repair?.outcome === 'fixed' && !!repair.output?.branch, plan };
      };
      const together = attempt(group, allowed, `shadowlap repair for ${listed(goldens)}${goldens.length > 1 ? ', which fail the same check' : ''}: blame, repair and verify, within $${allowed.toFixed(2)}`);
      let spent = together.spent;
      let chosen = together.fixed ? { attempt: together, members: group.members } : null;
      // No patch fixed them all: one that fixes one of them is still a fix, and the group's one pull request.
      const alone = [];
      if (!chosen && group.members.length > 1 && worthSplitting(together.repair) && spent < allowed) {
        log(`no fix was accepted for ${listed(goldens)} together (${together.why}), so each is repaired on its own, until a fix is accepted for one`);
        for (const m of group.members) {
          const left = Number((allowed - spent).toFixed(6));
          if (left <= 0) break;
          const tried = attempt(m, left, `shadowlap repair for ${goldenOf(m)} on its own: blame, repair and verify, within the $${left.toFixed(2)} left`);
          spent += tried.spent;
          alone.push({ member: m, tried });
          if (tried.fixed) {
            chosen = { attempt: tried, members: [m] };
            break;
          }
          if (!worthSplitting(tried.repair)) break;
        }
      }
      const last = chosen?.attempt ?? alone.at(-1)?.tried ?? together;
      const repair = last.repair;
      const accepted = repair?.candidates?.find((c) => c.id === repair.accepted) ?? null;
      const runs = accepted?.verify?.runs ?? [];
      // Each run as verify --json prints it (outcome fixed or kept); a CLI from before that printed the verdict.
      const passed = (x) => (typeof x.outcome === 'string' ? x.outcome === 'fixed' || x.outcome === 'kept' : x.verdict === 'pass');
      const count = (role) => {
        const of = runs.filter((x) => x.role === role);
        return of.length ? `${role === 'holdout' ? 'held-out' : role} ${of.filter(passed).length} of ${of.length}` : null;
      };
      const verify = accepted ? ['target', 'holdout', 'good'].map(count).filter(Boolean).join(' · ') : null;
      const base = { golden: goldens.join(', '), name: names, budget: allowed };
      if (chosen) {
        const branch = repair.output.branch;
        const leftOut = group.members.filter((m) => !chosen.members.includes(m));
        const unfixedWhy = leftOut.length ? `no fix was accepted for ${listed(goldens.map((g) => `\`${g}\``))} together (${together.why}), and this one was verified for ${listed(chosen.members.map((m) => `\`${goldenOf(m)}\``))} alone` : null;
        const branchState = refreshGoldens({ cli, workdir, members: chosen.members, unfixed: leftOut, unfixedWhy, results: report.results, repair, guard, build, env: fixEnv, scratch });
        if (branchState.warning) log(`::warning title=Shadowlap::${commandText(`${names}: ${branchState.warning}`)}`);
        for (const g of branchState.goldens) {
          if (g.state === 'recorded') log(`${g.golden} re-recorded on ${branch}`);
          else if (g.state === 'stale') log(`${g.golden} not re-recorded on ${branch}: ${String(g.why)}`);
          else if (g.state === 'unfixed') log(`${g.golden} fails the same check, and the fix on ${branch} is not verified for it${g.fork ? '' : `: see whether it fixes it too with shadowlap test ${g.golden} --update on the branch`}`);
          else log(`${g.golden} may fork: left as it is`);
        }
        const diverging = branchState.others.diverging;
        if (diverging.length) log(`${diverging.join(' ')} ${diverging.length === 1 ? 'diverges' : 'diverge'} on ${branch} under the fix: re-record with shadowlap test ${diverging.join(' ')} --update on the branch`);
        // The body is kept beside repair's report, to be read after the job.
        const reportFile = resolve(workdir, repair.output.report ?? join(repair.output.dir ?? '.', 'report.md'));
        const bodyFile = join(dirname(reportFile), 'pull-request.md');
        // Pushed with the token the pull request is opened with. With the job's own GITHUB_TOKEN,
        // GitHub starts no workflow for either, so this one is started on the branch in between,
        // and the body says which happened.
        const root = realpathSync(git(workdir, ['rev-parse', '--show-toplevel'], fixEnv).trim());
        const ghEnv = tokenEnv(fixEnv, auth);
        const onOrigin = pushBranch(root, branch, ghEnv);
        let opened = { pr: null, why: onOrigin.why };
        let checks = null;
        if (onOrigin.ok) {
          const dispatch = auth.startsWorkflows ? null : await dispatchWorkflow({ env, auth, branch, fetch: fetchFn });
          checks = auth.startsWorkflows ? { state: 'token', workflow: null, why: null } : dispatch.dispatched ? { state: 'dispatched', workflow: dispatch.workflow, why: null } : { state: 'not-started', workflow: dispatch.workflow, why: dispatch.why };
          if (dispatch && !dispatch.dispatched) log(`::warning title=Shadowlap::${commandText(`${names}: the fix's pull request has no check started: ${String(dispatch.why)}. Give the action a github-token, or let the workflow be started on a branch (workflow_dispatch, and actions: write)`)}`);
          writeFileSync(bodyFile, `${existsSync(reportFile) ? readFileSync(reportFile, 'utf8').replace(/\s+$/, '') : ''}\n\n${branchNote(branchState)}\n${evidenceNote(chosen.attempt.plan)}\n${checksNote({ auth, dispatch })}`);
          opened = createPullRequest(root, branch, bodyFile, ghEnv);
        }
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
          log(pushLine(names, pushed));
        }
        const onBranch = { goldenState: branchState.goldens.length === 1 ? branchState.goldens[0] : null, goldenStates: branchState.goldens, others: branchState.others, verifiedOn: chosen.attempt.plan.goldens };
        if (opened.pr) out.push({ ...base, outcome: 'opened', why: null, pr: opened.pr, branch, title: accepted?.strategy ?? null, spent, verify, ...onBranch, pushed, checks });
        else out.push({ ...base, outcome: 'not-opened', why: opened.why, pr: null, branch, title: null, spent, verify, ...onBranch });
      } else {
        // Once the budget is spent, that is why there is no fix, whatever was learned by then.
        const spentAll = spent >= allowed;
        const why =
          repair?.outcome === 'fixed'
            ? 'a fix was accepted, but no branch was made for it'
            : spentAll
              ? `the budget of $${allowed.toFixed(2)} is spent`
              : alone.length
                ? triedWhy(together.why, alone.map((a) => ({ golden: goldenOf(a.member), why: a.tried.why })), group.members.length)
                : last.why;
        out.push({ ...base, outcome: repair?.outcome === 'fixed' ? 'not-opened' : 'no-fix', why, pr: null, title: null, spent, verify, goldenState: null });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return out;
}

/**
 * Text safe in the job summary's table, for what Shadowlap counts itself (verify's tally): a stray
 * pipe escaped, a line break and control characters flattened. A fix's why and a golden's name are
 * plain text that can hold anyone's words (a check's label, a run's message, an error a repair or
 * GitHub gave), so they go in through markdownText, and the repairer's title too.
 */
const cell = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\|/g, '\\|');

/** What the summary says about the goldens on a fix's branch: its own, re-recorded or not, and the others it leaves diverging. */
function goldenCell(f) {
  const states = (f.goldenStates ?? (f.goldenState ? [f.goldenState] : [])).filter((g) => g && g.state !== 'fork');
  const recorded = states.filter((g) => g.state === 'recorded');
  const stale = states.filter((g) => g.state === 'stale');
  const unfixed = states.filter((g) => g.state === 'unfixed');
  const update = (dirs) => `run ${markdownCode(`shadowlap test ${dirs.join(' ')} --update`, { cell: true })} on the branch`;
  const parts = [];
  // By name when the goldens on the branch fare differently.
  const named = [recorded, stale, unfixed].filter((x) => x.length).length > 1;
  const which = (gs) => (named ? gs.map((g) => markdownText(g.golden)).join(', ') : `golden${gs.length === 1 ? '' : 's'}`);
  if (recorded.length) parts.push(`${which(recorded)} re-recorded`);
  if (stale.length) parts.push(`${which(stale)} not re-recorded: ${update(stale.map((g) => g.golden))}`);
  if (unfixed.length) {
    const replays = unfixed.filter((g) => !g.fork);
    parts.push(`${unfixed.map((g) => markdownText(g.golden)).join(', ')} ${unfixed.length === 1 ? 'fails' : 'fail'} the same check, not verified under the fix${replays.length ? `: ${update(replays.map((g) => g.golden))}, which keeps a recording only when it passes` : ''}`);
  }
  const d = f.others?.diverging ?? [];
  if (d.length) parts.push(`${d.length} other golden${d.length === 1 ? ' diverges' : 's diverge'}: ${update(d)}`);
  const u = f.others?.unchecked ?? [];
  if (u.length) parts.push(`${u.length} other golden${u.length === 1 ? '' : 's'} not replayed under the fix`);
  const i = f.others?.inconclusive ?? [];
  if (i.length) parts.push(`${i.length} other golden${i.length === 1 ? '' : 's'} inconclusive under the fix`);
  return parts.map((x) => ` · ${x}`).join('');
}

/** What the summary says about a fix and the team store, with push: in it, kept to a pull request's folder, or not (a warning when it couldn't go). */
function pushCell(p) {
  if (!p) return '';
  if (p.state === 'sent') return ' · in the team store';
  if (p.state === 'pr') return ` · not on the team's Fixes page: a pull request's job writes only to its own folder, ${markdownCode(`pr/${p.pr}/`, { cell: true })}`;
  if (p.state === 'off') return ` · not in the team store: ${markdownText(p.why)}`;
  return ' · ⚠️ not in the team store';
}

/** What the summary says about a fix pull request's checks: started by its token, started on its branch, or not started (a warning). */
function checksCell(c) {
  if (!c) return '';
  if (c.state === 'token') return ' · its workflows start as for any pull request';
  if (c.state === 'dispatched') return ` · ${markdownCode(c.workflow, { cell: true })} started on its branch`;
  return ' · ⚠️ no check started on its branch';
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
        ? `[${markdownText(f.title ?? 'fix')}](${f.pr})${f.verify ? ` · verify: ${cell(f.verify)}` : ''}${goldenCell(f)}${checksCell(f.checks)}${pushCell(f.pushed)}`
        : f.outcome === 'skipped'
          ? markdownText(String(f.why ?? ''))
          : `no fix: ${markdownText(String(f.why ?? ''))}${goldenCell(f)}`;
    const icon = f.outcome === 'opened' ? '✅' : f.outcome === 'skipped' ? '➖' : '❌';
    lines.push(`| ${icon} | ${markdownCode(f.name, { cell: true })} | ${what} | ${f.outcome === 'skipped' ? '' : `$${f.spent.toFixed(2)} of $${Number(f.budget ?? budget).toFixed(2)}`} |`);
  }
  // A push that couldn't happen: each fix with why, under the table where the reasons have room.
  const unsent = fixes.filter((f) => f.pushed?.state === 'failed');
  if (unsent.length) {
    const one = unsent.length === 1;
    lines.push('', `⚠️ ${one ? 'A fix' : `${unsent.length} fixes`} couldn't go to the team store, so teammates won't see ${one ? 'it' : 'them'} on their Fixes page. ${one ? 'Its pull request is' : 'Their pull requests are'} open all the same.`, '');
    for (const f of unsent) lines.push(`- ${markdownCode(f.name)}: ${markdownText(String(f.pushed.why ?? ''))}`);
  }
  // A pull request whose checks never started: why, and what starts them.
  const unchecked = fixes.filter((f) => f.outcome === 'opened' && f.checks?.state === 'not-started');
  if (unchecked.length) {
    lines.push('', `⚠️ No check started on ${unchecked.length === 1 ? 'a fix pull request' : `${unchecked.length} fix pull requests`}: GitHub starts no workflow for one the job's \`GITHUB_TOKEN\` opens, and the job couldn't start it on the branch. Give the action a \`github-token\` (a GitHub App's token or a personal access token), or let the workflow be started on a branch: a \`workflow_dispatch:\` trigger, and \`actions: write\` in the job's permissions.`, '');
    for (const f of unchecked) lines.push(`- ${markdownCode(f.name)}: ${markdownText(String(f.checks.why ?? ''))}`);
  }
  lines.push('', 'Each pull request carries the patch verify accepted, its report and, for a golden that must replay exactly, the golden re-recorded under the fix. Nothing is merged: review each one like any other change.');
  return lines.join('\n') + '\n';
}
