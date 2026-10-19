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
  inconclusive: 'its verdict is inconclusive, neither passed nor failed: more attempts settle it, not a fix',
  injection: 'its injection gate failed: the agent obeyed text planted in what it reads, which is fixed in its prompt or its code, or the gate showed too little to say, and its reason says why; a fix on failure fixes neither. shadowlap injection <golden> --html report.html shows every attempt',
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
      if (r.failure !== 'check') return { result: r, skip: NOT_FIXED[r.failure] ?? 'not an outcome check' };
      if (!r.expect) return { result: r, skip: 'its checks are not under "tests" in shadowlap.config.json' };
      const unpriced = unpricedOnly(r.checks);
      if (unpriced) return { result: r, skip: `it fails only because ${unpriced.join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} no price, which no prompt fix changes: add ${unpriced.length === 1 ? 'it' : 'them'} under "prices" in shadowlap.config.json` };
      const failing = (r.runs ?? []).filter((x) => !x.ok).map((x) => x.runId);
      if (!failing.length) return { result: r, skip: 'no failing replay was kept' };
      return { result: r, skip: null, fixes: failing, keeps: (r.runs ?? []).filter((x) => x.ok).map((x) => x.runId) };
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

/** A golden's folder as the reports name it: forward slashes, no trailing one. */
const dirOf = (r) => String(r?.dir ?? r?.golden ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/** Names in a sentence: `a`, `a and b`, `a, b and c`. */
const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * The branch, tried in the working tree, where the agent's dependencies are, as verify ran it: each
 * golden in `swaps` gets the recording verify accepted in place of its pack entries, the patch is
 * applied, `shadowlap test` replays `dirs` (their checks included), and everything is put back.
 * Returns each folder's result, or why the test could not run.
 */
function replayOnBranch({ cli, workdir, root, swaps, dirs, patch, guard, env, scratch }) {
  const aside = join(scratch, 'golden-aside');
  const moved = [];
  let applied = false;
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
    if (apply.status !== 0) return { why: `the fix does not apply to the working tree: ${(apply.stderr ?? '').trim()}`, results: new Map() };
    applied = true;
    const json = join(scratch, 'branch-test.json');
    rmSync(json, { force: true });
    const t = run(process.execPath, [cli, '--db', ':memory:', 'test', ...dirs, '--json', json, '--guard', guard], workdir, env);
    let report = null;
    try {
      report = JSON.parse(readFileSync(json, 'utf8'));
    } catch {
      // no report: its output says why
    }
    if (!Array.isArray(report?.results)) return { why: `shadowlap test did not finish on the branch: ${`${t.stderr ?? ''}`.trim().split('\n').at(-1) || `exit ${t.status}`}`, results: new Map() };
    return { why: null, results: new Map(report.results.map((r) => [dirOf(r), r])) };
  } finally {
    // The goldens go back whatever happens to the patch, and a patch that won't come out is said.
    const back = applied ? run('git', ['apply', '-R', '--whitespace=nowarn', patch], root, env) : null;
    for (const swap of swaps) for (const e of PACK_ENTRIES) rmSync(join(resolve(workdir, swap.golden), e), { recursive: true, force: true });
    for (const m of moved) move(join(m.keep, m.e), join(m.dir, m.e));
    rmSync(aside, { recursive: true, force: true });
    if (back && back.status !== 0) throw new Error(`the fix could not be taken back out of the working tree: ${(back.stderr ?? '').trim()}`);
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
  const message = `${subject}\n\n${body ? `${body}\n\n` : ''}${what}\n`;
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
export function refreshGoldens({ cli, workdir, members, unfixed = [], unfixedWhy = null, results = [], repair, guard = 'block', env, scratch }) {
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
  const out = { goldens, others: { diverging: [], failing: [], inconclusive: [], unsettled: [], unreplayed: others.filter((r) => r.mode === 'fork').map(dirOf), unchecked: [], replayed: 0 }, checked: false, why: null };
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
    const tried = replayOnBranch({ cli, workdir, root, swaps, dirs, patch: resolve(workdir, repair.output.patch), guard, env, scratch });
    if (tried.why) {
      cannot(tried.why);
      return out;
    }
    const clean = [];
    for (const c of swaps) {
      const t = tried.results.get(c.golden);
      const said = t?.message ? ` (${t.name}: ${t.message})` : '';
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
    cannot(err.message.split('\n')[0]);
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

/** What the pull request says about one of the fix's goldens. */
export function goldenNote(g) {
  if (g.state === 'unfixed') {
    const head = `\`${g.golden}\` fails the same check, but this fix is not verified for it${g.why ? `: ${g.why}` : ''}.`;
    if (g.fork) return `${head} It may fork, so on this branch it runs live from where it diverges, and its checks say whether the fix repairs it too.\n`;
    return `${head} It still holds the recording made before the fix, so it diverges on this branch. Re-recording it here keeps the new recording only when it passes its checks, which says whether the fix repairs it too; if it fails them, it is left as it is, and it needs a fix of its own:\n\n\`\`\`sh\nshadowlap test ${g.golden} --update\n\`\`\`\n`;
  }
  if (g.state === 'recorded') return `\`${g.golden}\` is re-recorded under the fix: the recording verify accepted replaces its pack in this branch, and it replays clean here. Review the new recording like any other change to a golden.\n`;
  if (g.state === 'fork') return `\`${g.golden}\` may fork, so it passes on its checks with the fix as it is.\n`;
  return `\`${g.golden}\` still holds the recording made before the fix, which sends the old prompt, so it diverges on this branch. Re-record it here and commit the change:\n\n\`\`\`sh\nshadowlap test ${g.golden} --update\n\`\`\`\n\nIt was not re-recorded automatically: ${g.why}.\n`;
}

/**
 * What the pull request says, after repair's report, about the goldens on its branch: each of the
 * fix's own, the other goldens the fix leaves diverging (with the command that re-records them), and
 * that its own checks pass only when every golden replayed there replays clean.
 */
export function branchNote({ goldens, others = { diverging: [], failing: [], inconclusive: [], unsettled: [], unreplayed: [], unchecked: [], replayed: 0 }, checked = false, why = null }) {
  const code = (dirs) => listed(dirs.map((d) => `\`${d}\``));
  const parts = [`### The golden${goldens.length === 1 ? '' : 's'}\n`, ...goldens.map(goldenNote)];
  const d = others.diverging;
  if (d.length) parts.push(`The fix changes what the agent sends, so ${d.length === 1 ? 'another golden, which passed before it, diverges' : `${d.length} other goldens, which passed before it, diverge`} on this branch: ${code(d)}. Re-record ${d.length === 1 ? 'it' : 'them'} here once the change is what you meant, and commit the change:\n\n\`\`\`sh\nshadowlap test ${d.join(' ')} --update\n\`\`\`\n`);
  if (others.failing.length) parts.push(`${code(others.failing)} failed before the fix too, and ${others.failing.length === 1 ? 'fails' : 'fail'} on this branch as well.\n`);
  // Neither passed nor failed: never counted as a golden the fix broke, nor as one that replays clean.
  const unsettled = others.unsettled ?? [];
  if (unsettled.length) parts.push(`${code(unsettled)} ${unsettled.length === 1 ? 'was' : 'were'} inconclusive before the fix, and ${unsettled.length === 1 ? 'fails' : 'fail'} on this branch.\n`);
  const inconclusive = others.inconclusive ?? [];
  if (inconclusive.length) parts.push(`${code(inconclusive)} ${inconclusive.length === 1 ? 'is' : 'are'} inconclusive on this branch, neither passed nor failed, so whether the fix changes ${inconclusive.length === 1 ? 'it' : 'them'} is not known: run \`shadowlap test ${inconclusive.join(' ')}\` on it to see why.\n`);
  const unchecked = others.unchecked ?? [];
  if (unchecked.length) parts.push(`${code(unchecked)} could not be replayed under the fix here${why ? ` (${why})` : ''}, so whether ${unchecked.length === 1 ? 'it diverges' : 'they diverge'} on this branch is not known: run \`shadowlap test ${unchecked.join(' ')}\` on it to see.\n`);
  if (others.unreplayed.length) parts.push(`${code(others.unreplayed)} may fork, so ${others.unreplayed.length === 1 ? 'it was' : 'they were'} not replayed here: ${others.unreplayed.length === 1 ? 'it runs' : 'they run'} live from where ${others.unreplayed.length === 1 ? 'it diverges' : 'they diverge'}, and ${others.unreplayed.length === 1 ? 'its' : 'their'} checks decide.\n`);
  const replayed = goldens.filter((g) => g.state === 'recorded').length + (checked ? others.replayed : 0);
  const clean = checked && !goldens.some((g) => g.state === 'stale' || g.state === 'unfixed') && !d.length && !others.failing.length && !unsettled.length && !inconclusive.length && !unchecked.length;
  const forks = others.unreplayed.length || goldens.some((g) => g.state === 'fork');
  if (clean && replayed) parts.push(forks ? 'Every golden this job replayed exactly replays clean on this branch.\n' : "Every golden this job tested replays clean on this branch, so this pull request's own checks pass.\n");
  return parts.join('\n');
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
 * not verified for, and no other.
 */
export function runFixes({ cli, db, workdir, report, budget, repairer, guard = 'block', push = false, env, log = () => {} }) {
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
      /** One repair, of the group or one of its goldens, within `within` dollars: what it reported and spent. */
      const attempt = (target, within, line) => {
        const expectFile = join(scratch, `${repairs++}-expect.json`);
        writeFileSync(expectFile, JSON.stringify(r.expect));
        log(line);
        const res = run(process.execPath, [cli, ...repairArgs(target, { db, budget: within, repairer, expectFile })], workdir, fixEnv);
        if (res.stderr) process.stderr.write(res.stderr);
        let repair = null;
        try {
          repair = JSON.parse(res.stdout);
        } catch {
          // no report: stderr says why
        }
        const spent = repair?.cost ? (repair.cost.blame ?? 0) + (repair.cost.repairer ?? 0) + (repair.cost.verify ?? 0) : 0;
        const why = repair?.why ?? repair?.error?.message ?? (`${res.stderr ?? ''}`.trim().split('\n').at(-1) || `repair exited ${res.status}`);
        return { repair, spent, why, fixed: repair?.outcome === 'fixed' && !!repair.output?.branch };
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
        const branchState = refreshGoldens({ cli, workdir, members: chosen.members, unfixed: leftOut, unfixedWhy, results: report.results, repair, guard, env: fixEnv, scratch });
        for (const g of branchState.goldens) {
          if (g.state === 'recorded') log(`${g.golden} re-recorded on ${branch}`);
          else if (g.state === 'stale') log(`${g.golden} not re-recorded on ${branch}: ${g.why}`);
          else if (g.state === 'unfixed') log(`${g.golden} fails the same check, and the fix on ${branch} is not verified for it${g.fork ? '' : `: see whether it fixes it too with shadowlap test ${g.golden} --update on the branch`}`);
          else log(`${g.golden} may fork: left as it is`);
        }
        const diverging = branchState.others.diverging;
        if (diverging.length) log(`${diverging.join(' ')} ${diverging.length === 1 ? 'diverges' : 'diverge'} on ${branch} under the fix: re-record with shadowlap test ${diverging.join(' ')} --update on the branch`);
        // The body is kept beside repair's report, to be read after the job.
        const reportFile = resolve(workdir, repair.output.report ?? join(repair.output.dir ?? '.', 'report.md'));
        const bodyFile = join(dirname(reportFile), 'pull-request.md');
        writeFileSync(bodyFile, `${existsSync(reportFile) ? readFileSync(reportFile, 'utf8').replace(/\s+$/, '') : ''}\n\n${branchNote(branchState)}`);
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
          log(pushLine(names, pushed));
        }
        const onBranch = { goldenState: branchState.goldens.length === 1 ? branchState.goldens[0] : null, goldenStates: branchState.goldens, others: branchState.others };
        if (opened.pr) out.push({ ...base, outcome: 'opened', why: null, pr: opened.pr, branch, title: accepted?.strategy ?? null, spent, verify, ...onBranch, pushed });
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

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** What the summary says about the goldens on a fix's branch: its own, re-recorded or not, and the others it leaves diverging. */
function goldenCell(f) {
  const states = (f.goldenStates ?? (f.goldenState ? [f.goldenState] : [])).filter((g) => g && g.state !== 'fork');
  const recorded = states.filter((g) => g.state === 'recorded');
  const stale = states.filter((g) => g.state === 'stale');
  const unfixed = states.filter((g) => g.state === 'unfixed');
  const update = (dirs) => `run \`shadowlap test ${dirs.map(cell).join(' ')} --update\` on the branch`;
  const parts = [];
  // By name when the goldens on the branch fare differently.
  const named = [recorded, stale, unfixed].filter((x) => x.length).length > 1;
  const which = (gs) => (named ? gs.map((g) => cell(g.golden)).join(', ') : `golden${gs.length === 1 ? '' : 's'}`);
  if (recorded.length) parts.push(`${which(recorded)} re-recorded`);
  if (stale.length) parts.push(`${which(stale)} not re-recorded: ${update(stale.map((g) => g.golden))}`);
  if (unfixed.length) {
    const replays = unfixed.filter((g) => !g.fork);
    parts.push(`${unfixed.map((g) => cell(g.golden)).join(', ')} ${unfixed.length === 1 ? 'fails' : 'fail'} the same check, not verified under the fix${replays.length ? `: ${update(replays.map((g) => g.golden))}, which keeps a recording only when it passes` : ''}`);
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
        ? `[${cell(f.title ?? 'fix')}](${f.pr})${f.verify ? ` · verify: ${cell(f.verify)}` : ''}${goldenCell(f)}${pushCell(f.pushed)}`
        : f.outcome === 'skipped'
          ? cell(f.why)
          : `no fix: ${cell(f.why)}${goldenCell(f)}`;
    const icon = f.outcome === 'opened' ? '✅' : f.outcome === 'skipped' ? '➖' : '❌';
    lines.push(`| ${icon} | \`${cell(f.name)}\` | ${what} | ${f.outcome === 'skipped' ? '' : `$${f.spent.toFixed(2)} of $${Number(f.budget ?? budget).toFixed(2)}`} |`);
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
