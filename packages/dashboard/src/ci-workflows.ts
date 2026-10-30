import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { judgeTarget, lostAround, lostWords, type StoreOf } from '@shadowlap/engine';
import { ciStep, parseStoreUrl, shortStoreName, type CiStepKeys, type StoreLocation } from '@shadowlap/remote';
import { ACTION, alertFailures, alertsMessage, alertsNeeds, alertsSecret, alertsYaml, FIX_BUDGETS, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml, REPAIRERS, VERSION, WORKFLOW_FILE, workflowNeeds, workflowYaml, type BucketCredentials, type LiveGoldens } from './ci-yaml.js';
import { fixDetail, fixList, type FixDetail } from './fixes.js';
import type { TeamStoreInput } from './team-store.js';

/**
 * The read model behind Settings → CI (`GET /api/ci/workflows`): your workflow, one job in which the
 * action runs the goldens once and the parts turned on follow it (a fix pull request, Slack), what
 * it needs, and for each part a preview of what lands, for the options the panels are set to. The
 * YAML comes from ci-yaml.ts, as docs/ci.md shows it; nothing here is stored, since the steps go
 * into the repository's own workflow file. Whether the step pushes is none of its options: it
 * follows Push from CI, read from shadowlap.config.json as Settings → Store reads it.
 */

export interface CiWorkflowOptions {
  /** Fix on failure is on: when it is off, the panel dims its settings and a failed check just fails the build. */
  fix: boolean;
  /** Alerts are on: the workflow tells Slack, then fails the job; off, its panel dims and the test step fails the job itself. */
  alerts: boolean;
  /** Dollars per failing golden: `2.00`. */
  budget: string;
  /** As `repair --repairer` takes it: `claude-code`, `anthropic`, `openai:gpt-5`. */
  repairer: string;
  /** Alerts post only for the main branch. */
  onlyMain: boolean;
  /** The repository secret that holds the Slack webhook URL. */
  secret: string;
  /** What an inconclusive golden does to the steps: fail them (the default, when absent), or warn and let it through. */
  inconclusive?: 'fail' | 'warn';
}

export const CI_DEFAULTS: CiWorkflowOptions = { fix: false, alerts: true, budget: '2.00', repairer: 'claude-code', onlyMain: true, secret: 'SLACK_WEBHOOK_URL' };

/** A row of an "it needs" or "it never" list, or a failure with its tag: what it is, and the value on the right. */
export interface CiListRow {
  label: string;
  value: string;
  /** Its dot: red for what fails a golden, amber for what can’t be decided or read (none for a plain row). */
  tone?: 'err' | 'warn';
}

/** The pull request a fix opens, as GitHub shows it: from the newest verified fix in this store, or an example. */
export interface PullRequestPreview {
  title: string;
  /** Who opens it: the workflow's token. */
  author: string;
  base: string;
  branch: string;
  /**
   * As the pull request's body says it: `fixes 3 of 3 target runs, 2 of 2 held-out, keeps 5 of 5
   * good, each failing run by its gate, which tells 90%+ from 70%- at <= 5% risk, and each good one
   * against its baseline, which tells no drop from one of 10+ points at <= 5% risk`, each rule stated once.
   */
  verify: string | null;
  /** Where the failing run was lost, as the body's table has it: `lost at model call #5 (3 of 5)`. */
  blame: string | null;
  /** The file the fix changes and its lines: `prompts/refund.md +1 −0`. */
  change: string | null;
  /** What it cost of the budget: `≈$0.84 of $2.00`. */
  spent: string;
  /** Where it comes from: a fix verified here, or none yet (then the rows are an example). */
  fixId: string | null;
  example: boolean;
}

/**
 * The team store as Fix on failure follows it: Push from CI, as Settings → Store shows it. On, the
 * step pushes, so each fix it opens lands on teammates' Fixes page too; the panel says what it
 * follows, how that stands, and where it is set. The CI tab has no switch of its own for it.
 */
export interface CiTeamStore {
  /** Push from CI is on: shadowlap.config.json names a team store and its `ciPush` isn't false. The step pushes then. */
  push: boolean;
  /** The store by its short name, `northwind-agent-runs/support-agent`; null when the config names none. */
  name: string | null;
  /** How the job signs in to the store's bucket, as `shadowlap store ci` writes it; null without a store. */
  credentials: BucketCredentials | null;
  /** The panel's line about it: that it follows Push from CI, and how that is set now. */
  note: string;
  /** What lands in the team store when the step pushes; empty when it doesn't. */
  lands: CiListRow[];
}

export interface CiWorkflowsView {
  /** Where the steps go: `.github/workflows/agent.yml`. */
  file: string;
  action: string;
  /**
   * Your workflow: one job, the action once (`id: goldens`), then the parts turned on (`fix`,
   * `alerts`), pushing to the team store when Push from CI is on; what it needs for what is on, and
   * what fails a golden in it.
   */
  workflow: {
    fix: boolean;
    alerts: boolean;
    yaml: string;
    needs: CiListRow[];
    failures: CiListRow[];
  };
  fixOnFailure: {
    on: boolean;
    budget: string;
    repairer: string;
    budgets: Array<{ value: string; label: string }>;
    repairers: Array<{ value: string; label: string }>;
    /** What the panel says while it is off. */
    offNote: string;
    /** Its step as a job of its own, as docs/ci.md shows it, and what that needs. */
    yaml: string;
    needs: CiListRow[];
    never: CiListRow[];
    preview: PullRequestPreview;
    /** Push from CI, which the step follows: on, it pushes, and each fix reaches the team store too. */
    teamStore: CiTeamStore;
  };
  alerts: {
    on: boolean;
    /** What the panel says while it is off. */
    offNote: string;
    onlyMain: boolean;
    /** The repository's default branch, which "only for the main branch" means: `main`, `master`, or what origin names. */
    branch: string;
    /** The secret's name as GitHub allows it (letters, digits and `_`). */
    secret: string;
    /** Its steps as a job of their own, as docs/ci.md shows them, and what they need. */
    yaml: string;
    needs: CiListRow[];
    /** What counts as a failure, each with its tag, and its tone. */
    failures: CiListRow[];
    /** What an inconclusive golden does to the steps: fails them (counted in `failed`), or warns. */
    inconclusive: 'fail' | 'warn';
    /** The message as Slack shows it. */
    message: { app: string; text: string; link: string; at: number | null };
  };
  /** The goldens the steps replay: the project's, as `recordings` takes them. */
  recordings: string;
  /** `owner/repo` from the project's git remote, or null. */
  repository: string | null;
  /**
   * Why shadowlap.config.json can't be read, as Settings' other tabs say it; null when it reads. The
   * steps then can't tell which goldens run live or whether Fix on failure pushes: each says what it
   * leaves out, and a needs row says why.
   */
  configError: string | null;
}

const BOOL: Record<string, boolean> = { on: true, off: false, true: true, false: false, '1': true, '0': false, yes: true, no: false };
const REPAIRER = /^(claude-code|anthropic|openai)(:[A-Za-z0-9._\-/]{1,80})?$/;

/** The panels' options from the query string; anything left out takes its default. */
export function parseCiOptions(q: URLSearchParams): CiWorkflowOptions | { error: string } {
  const out: CiWorkflowOptions = { ...CI_DEFAULTS };
  for (const [key, name] of [['fix', 'fix'], ['alerts', 'alerts'], ['onlyMain', 'onlyMain']] as const) {
    const raw = q.get(key);
    if (raw === null || raw === '') continue;
    const v = BOOL[raw.toLowerCase()];
    if (v === undefined) return { error: `${name} is on or off` };
    out[key] = v;
  }
  const budget = q.get('budget');
  if (budget !== null && budget !== '') {
    const n = Number(budget.replace(/^\$/, ''));
    if (!Number.isFinite(n) || n <= 0 || n > 1000) return { error: 'budget is an amount in dollars, such as 2.00' };
    out.budget = n.toFixed(2);
  }
  const repairer = q.get('repairer');
  if (repairer !== null && repairer !== '') {
    if (!REPAIRER.test(repairer)) return { error: 'repairer is claude-code, anthropic or openai, with :<model> after it if you like' };
    out.repairer = repairer;
  }
  const secret = q.get('secret');
  if (secret !== null) out.secret = alertsSecret(secret.slice(0, 100));
  const inconclusive = q.get('inconclusive');
  if (inconclusive !== null && inconclusive !== '') {
    if (inconclusive !== 'fail' && inconclusive !== 'warn') return { error: 'inconclusive is fail or warn' };
    out.inconclusive = inconclusive;
  }
  return out;
}

const dollars = (n: number) => `$${n.toFixed(2)}`;
const rows = (list: ReadonlyArray<readonly [string, string, ('err' | 'warn')?]>): CiListRow[] => list.map(([label, value, tone]) => ({ label, value, ...(tone ? { tone } : {}) }));

/**
 * The branch CI opens a golden's fix on, as the action names it (action/fix.mjs, branchName): the
 * golden's folder without `goldens/`, then the end of the failing replay's id, which only CI's own
 * run has: `shadowlap/fix-refund-over-limit-…`. `<golden>` when the fix isn't a golden's.
 */
export function ciFixBranch(golden: string | null): string {
  const slug = golden ? golden.toLowerCase().replace(/^goldens\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'golden' : '<golden>';
  return `shadowlap/fix-${slug}-…`;
}

/**
 * Verify's line in the pull request's body (repair's report.md): the runs it fixed and kept, by
 * role, then how each was decided, its gate's rule stated once.
 */
export function verifyLine(roles: ReadonlyArray<{ role: 'target' | 'held-out' | 'good'; held: number; of: number }>, rule: string | null): string | null {
  const of = (role: string) => roles.find((r) => r.role === role);
  const t = of('target');
  const h = of('held-out');
  const g = of('good');
  const counts = [t ? `fixes ${t.held} of ${t.of} target run${t.of === 1 ? '' : 's'}` : '', h ? `${h.held} of ${h.of} held-out` : '', g ? `keeps ${g.held} of ${g.of} good` : ''].filter(Boolean).join(', ');
  return counts ? `${counts}${rule ? `, ${rule}` : ''}` : null;
}

/** The example a panel shows before any fix was verified here: the mock's own, as CI opens it, into the repository's default branch. */
function examplePreview(budget: string, base: string): PullRequestPreview {
  return {
    title: 'Escalate refunds above the policy limit',
    author: 'github-actions',
    base,
    branch: ciFixBranch('goldens/refund-limit'),
    verify: 'fixes 3 of 3 target runs, 2 of 2 held-out, keeps 5 of 5 good, each failing run by its gate, which tells 90%+ from 70%- at <= 5% risk, and each good one against its baseline, which tells no drop from one of 10+ points at <= 5% risk',
    blame: 'lost at model call #5 (3 of 5)',
    change: 'prompts/refund.md +1 −0',
    spent: `≈$0.84 of $${budget}`,
    fixId: null,
    example: true,
  };
}

/** A failing run's place as the pull request's Lost at column has it (repair's targetWhere): at a model call, or gradually around, or between, two. */
const LOST_PLACE = /^(?:model call #\d+ \(\d+ of \d+\)|(?:gradually, around|between) model calls #\d+ and #\d+ \(\d+ and \d+ of \d+\))/;

/**
 * Where blame found the fix's first failing run lost, as the pull request's Lost at column has it
 * (who rescued it is a column of its own there): `lost at model call #5 (3 of 5)`, `lost gradually,
 * around model calls #17 and #18 (17 and 18 of 30)`; from the fix's blame when its repair placed none.
 */
function lostLine(fix: FixDetail): string | null {
  const place = fix.repair?.lost.map((l) => LOST_PLACE.exec(l.at)?.[0]).find((x): x is string => !!x);
  if (place) return `lost ${place.startsWith('model call') ? 'at ' : ''}${place}`;
  const b = fix.blame;
  if (!b?.lostAt) return null;
  const range = b.evidence.range;
  return `${lostWords(b.lostAt, range, 'calls')}${b.step && !lostAround(range) ? ` (${b.step} of ${b.steps})` : ''}`;
}

/**
 * The pull request the newest verified fix in this store would be, opened by CI as the action opens
 * one: its commit title, the branch CI names after the golden that failed (the golden one of the
 * fix's failing runs is a test replay of), verify's line as the body says it, where blame found the
 * first failing run was lost, the file it changes and what it cost. Null when no fix here has an
 * accepted repair.
 */
export function fixPreview(store: StoreOf<'recording' | 'readModels' | 'activity' | 'fixes' | 'team'>, budget: string): PullRequestPreview | null {
  const verified = fixList(store, { status: 'verified' }).fixes.sort((a, b) => (b.verifiedAt ?? 0) - (a.verifiedAt ?? 0));
  for (const row of verified) {
    const fix = fixDetail(store, row.fixId);
    const repair = fix?.repair;
    if (!fix || !repair?.accepted) continue;
    const spent = repair.cost.blame + (repair.cost.repairer ?? 0) + repair.cost.verify + (repair.cost.judge ?? 0);
    const patch = repair.files.find((f) => f.name === 'fix.patch')?.note.replace(/^1 file · /, '') ?? null;
    const golden = fix.failingRuns.map((r) => store.getRun(r.runId)?.meta?.test?.golden).find((g): g is string => typeof g === 'string') ?? null;
    return {
      title: repair.title,
      author: 'github-actions',
      base: 'main',
      branch: ciFixBranch(golden),
      verify: verifyLine(repair.roles, repair.rule),
      blame: lostLine(fix),
      change: repair.change ? `${repair.change.file}${patch ? ` ${patch}` : ''}` : patch,
      spent: `≈${dollars(spent)} of $${budget}`,
      fixId: fix.fixId,
      example: false,
    };
  }
  return null;
}

/**
 * Push from CI as Settings → Store shows it, from the same reading of shadowlap.config.json
 * (readTeamStoreInput): on when the config names a team store, as a store URL, and its `ciPush`
 * isn't false. A project with no store, or one whose URL can't be used, has none to push to.
 * Fixes reach teammates from the jobs of your branches: a pull request's job writes only its runs,
 * to its own folder, with short-lived credentials, and with R2's keys, which can't be kept to that
 * folder, nothing at all.
 */
export function ciTeamStore(input: Pick<TeamStoreInput, 'store' | 'ciPush'> | null, unreadable = false): CiTeamStore {
  // The config names the store: while it can't be read, there is no telling whether the step pushes.
  if (unreadable) return { push: false, name: null, credentials: null, note: 'shadowlap.config.json can’t be read, so whether fixes go to a team store isn’t known until it is fixed.', lands: [] };
  let loc: StoreLocation | null;
  try {
    loc = input?.store ? parseStoreUrl(input.store) : null;
  } catch {
    loc = null;
  }
  if (!loc) return { push: false, name: null, credentials: null, note: 'None yet, so test runs and fixes stay in GitHub. With one, this follows Push from CI.', lands: [] };
  const push = input?.ciPush !== false;
  const credentials: BucketCredentials = ciStep('github', loc, { version: VERSION }).oidc ? 'oidc' : 'keys';
  return {
    push,
    name: shortStoreName(loc),
    credentials,
    note: push ? 'Follows Push from CI: on, so the test runs, and fixes from your branches, go there too.' : 'Follows Push from CI: off, so test runs and fixes stay in GitHub.',
    lands: push
      ? [
          { label: 'each test run and the session’s report', value: 'test --push' },
          { label: 'the fix and its runs, on teammates’ Fixes page once they pull', value: 'from CI' },
          credentials === 'oidc' ? { label: 'from a pull request’s job, only its runs, in its own folder', value: 'pr/<n>/' } : { label: 'from a pull request’s job, nothing: R2 keys can’t be kept to pr/', value: 'no push' },
        ]
      : [],
  };
}

/** Where the project's git metadata is: its `.git` folder, or the one a worktree's `.git` file names. */
function gitDir(project: string): string | null {
  const dotGit = join(project, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    return m ? resolve(project, m[1]!.trim()) : null;
  } catch {
    return null;
  }
}

/**
 * The repository's default branch, which pull requests go into and "only for the main branch" means:
 * what origin's HEAD names (`refs/remotes/origin/HEAD`, as a clone or `git remote set-head` leaves
 * it), else `main` or `master` when the repository has one, else null.
 */
function defaultBranchOf(common: string): string | null {
  try {
    const m = /^ref:\s*refs\/remotes\/[^/\s]+\/(\S+)\s*$/m.exec(readFileSync(join(common, 'refs', 'remotes', 'origin', 'HEAD'), 'utf8'));
    if (m) return m[1]!;
  } catch {
    // no HEAD of origin's to read
  }
  let packed = '';
  try {
    packed = readFileSync(join(common, 'packed-refs'), 'utf8');
  } catch {
    // nothing packed
  }
  const lines = packed.split(/\r?\n/);
  const has = (ref: string) => existsSync(join(common, ...ref.split('/'))) || lines.some((l) => l.endsWith(` ${ref}`));
  for (const b of ['main', 'master']) if (has(`refs/remotes/origin/${b}`) || has(`refs/heads/${b}`)) return b;
  return null;
}

/**
 * The project's GitHub repository (`owner/repo`, from the `origin` remote, else the first remote on
 * github.com), the branch checked out, and the repository's default branch, read from its git files
 * without running git. Nulls when one can't be told.
 */
export function gitFacts(project: string | null): { repository: string | null; branch: string | null; defaultBranch: string | null } {
  if (!project) return { repository: null, branch: null, defaultBranch: null };
  const dir = gitDir(project);
  if (!dir) return { repository: null, branch: null, defaultBranch: null };
  let branch: string | null = null;
  try {
    branch = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(dir, 'HEAD'), 'utf8'))?.[1]?.trim() ?? null;
  } catch {
    // no HEAD to read
  }
  // A worktree keeps its config in the repository it belongs to.
  let common = dir;
  try {
    const c = readFileSync(join(dir, 'commondir'), 'utf8').trim();
    common = isAbsolute(c) ? c : resolve(dir, c);
  } catch {
    // not a worktree
  }
  let repository: string | null = null;
  try {
    const config = readFileSync(join(common, 'config'), 'utf8');
    const remotes = [...config.matchAll(/\[remote "([^"]+)"\]([^[]*)/g)].map((m) => ({ name: m[1]!, url: /^\s*url\s*=\s*(.+)$/m.exec(m[2]!)?.[1]?.trim() ?? '' }));
    const onGithub = (url: string) => /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
    const origin = remotes.find((r) => r.name === 'origin' && onGithub(r.url));
    const any = origin ?? remotes.find((r) => onGithub(r.url));
    repository = any ? onGithub(any.url) : null;
  } catch {
    // no config to read
  }
  return { repository, branch, defaultBranch: defaultBranchOf(common) };
}

/**
 * A golden as the CI steps need it: whether it runs live in CI, and the keys its agent calls with.
 * A golden that may fork runs live from where it diverges (a gate's golden is one), and its judges
 * are asked live there; one with an injection gate runs live from the call that reads the payload.
 * Any golden's agent runs live under blame and verify, so Fix on failure needs every golden's keys.
 */
export interface GoldenProviders {
  /** Its pack folder: `goldens/refund-flow`. */
  path: string;
  /** Why it runs live in CI; empty when it replays offline. */
  live: Array<'fork' | 'injection gate'>;
  /** The key variables of the providers its recording called, and of its judges' when it forks. */
  keys: string[];
  /**
   * Its keys are all named in `keys`: its pack's calls were read, and each provider it calls (and,
   * where it forks, each judge's) takes its key from a variable. False for a pack that can't be
   * read, Vertex AI (which signs in with a token) or a judge whose provider can't be told.
   */
  known: boolean;
}

/** The goldens that run live in CI, as a needs row says them, with the keys they need; null when none does. */
export function liveGoldens(goldens: readonly GoldenProviders[]): LiveGoldens | null {
  const live = goldens.filter((g) => g.live.length);
  if (!live.length) return null;
  const why = (['fork', 'injection gate'] as const).filter((w) => live.some((g) => g.live.includes(w)));
  return { count: live.length, why, keys: [...new Set(live.flatMap((g) => g.keys))], unknown: live.filter((g) => !g.known).length };
}

/**
 * The keys the store's CI step needs for the project's goldens that run live (`ciStep`'s `keys` and
 * `keysUnknown`), as Settings → CI's Alerts step has them: the step runs the same goldens.
 */
export function liveKeys(project: string, goldens: ReadonlyArray<{ path: string; mode: 'replay' | 'fork'; injection?: boolean; judges?: readonly string[] }>): CiStepKeys {
  const live = liveGoldens(goldenProviders(project, goldens));
  return live ? { keys: live.keys, ...(live.unknown ? { keysUnknown: true } : {}) } : {};
}

/**
 * The variable each provider's key is read from, as the sidecar names it for a replay that would go
 * live without one (`keys.set`); Bedrock's two. Vertex AI signs in with a token, so it has none.
 */
export const PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  bedrock: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  'ai-gateway': ['AI_GATEWAY_API_KEY'],
};

/** The providers a pack's recording called, by its calls.jsonl, kept while the file is the same. */
const calledBy = new Map<string, { mtimeMs: number; size: number; providers: string[] }>();
/** A pack's calls are read up to this much: a golden is small, and what is left out changes nothing here. */
const CALLS_READ = 8 * 1024 * 1024;

/** The providers a pack's recording called, or null when its calls can't be read. */
function packProviders(dir: string): string[] | null {
  const file = join(dir, 'calls.jsonl');
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  const kept = calledBy.get(file);
  if (kept && kept.mtimeMs === st.mtimeMs && kept.size === st.size) return kept.providers;
  let text: string;
  try {
    text = st.size > CALLS_READ ? readFileSync(file).subarray(0, CALLS_READ).toString('utf8') : readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const providers = [...new Set([...text.matchAll(/"provider":"([a-z-]+)"/g)].map((m) => m[1]!))].filter((p) => p in PROVIDER_KEYS || p === 'vertex');
  calledBy.set(file, { mtimeMs: st.mtimeMs, size: st.size, providers });
  return providers;
}

/**
 * The project's goldens as the CI steps need them (`GoldenProviders`), from the goldens Tests lists
 * (their mode, injection gate and judges, from the config's `tests`) and the providers each pack's
 * recording called. A pack that can't be read calls nothing here, and its keys aren't known.
 */
export function goldenProviders(project: string, goldens: ReadonlyArray<{ path: string; mode: 'replay' | 'fork'; injection?: boolean; judges?: readonly string[] }>): GoldenProviders[] {
  return goldens.map((g) => {
    const live: GoldenProviders['live'] = [...(g.mode === 'fork' ? (['fork'] as const) : []), ...(g.injection ? (['injection gate'] as const) : [])];
    const called = packProviders(resolve(project, g.path));
    const providers = new Set(called ?? []);
    let known = called !== null;
    // A judge with no verdict for a new answer is asked live: only where the golden forks.
    if (g.mode === 'fork')
      for (const j of g.judges ?? []) {
        const p = judgeTarget(j)?.provider;
        if (p) providers.add(p);
        else known = false;
      }
    if ([...providers].some((p) => !PROVIDER_KEYS[p])) known = false;
    return { path: g.path, live, keys: [...providers].flatMap((p) => PROVIDER_KEYS[p] ?? []), known };
  });
}

/**
 * Both panels for the options given. `context` is what the store and the project say: the pull
 * request preview (null: the example), the goldens failing now (the Slack message's count, 1 when
 * none fail), when the tests last ran, the repository, the branch checked out and the default
 * branch (`main` when it can't be told), the goldens the steps replay, and the team store and
 * Push from CI as the config has them (readTeamStoreInput; none when left out).
 */
export function ciWorkflows(
  o: CiWorkflowOptions,
  context: {
    preview: PullRequestPreview | null;
    failing: number;
    at: number | null;
    repository: string | null;
    branch: string | null;
    defaultBranch?: string | null;
    recordings?: string;
    teamStore?: Pick<TeamStoreInput, 'store' | 'ciPush'> | null;
    /** What the goldens call, and which run live in CI (`goldenProviders`); unknown when left out. */
    goldens?: readonly GoldenProviders[] | null;
    /** Why shadowlap.config.json can't be read (its goldens' `tests`, its store and Push from CI with it), or null. */
    configError?: string | null;
  },
): CiWorkflowsView {
  const recordings = context.recordings ?? 'goldens/*';
  const goldens = context.goldens ?? null;
  const configError = context.configError ?? null;
  const unreadable = configError !== null;
  // The keys every golden's agent calls with, for blame and verify; those of the goldens that run live, for the test step itself.
  const keys = goldens ? [...new Set(goldens.flatMap((g) => g.keys))] : [];
  const keysUnknown = !!goldens?.some((g) => !g.known);
  const live = goldens ? liveGoldens(goldens) : null;
  const inconclusive = o.inconclusive ?? 'fail';
  const main = context.defaultBranch || 'main';
  const branch = o.onlyMain ? main : context.branch && context.branch !== main ? context.branch : 'your-branch';
  const repo = context.repository ?? 'owner/repo';
  const message = alertsMessage({ failed: Math.max(1, context.failing), branch, runUrl: `github.com/${repo}/actions/runs/…` });
  // With Push from CI on, the step pushes too and needs the bucket's credentials; off, it is as it was.
  const teamStore = ciTeamStore(context.teamStore ?? null, unreadable);
  const push = teamStore.push ? teamStore.credentials : null;
  const fixNeeds = fixOnFailureNeeds(o.repairer, push, keys, unreadable);
  const alertNeeds = alertsNeeds(o.secret, live, unreadable);
  return {
    file: WORKFLOW_FILE,
    action: ACTION,
    workflow: {
      fix: o.fix,
      alerts: o.alerts,
      yaml: workflowYaml({
        fix: o.fix ? { budget: o.budget, repairer: o.repairer } : null,
        alerts: o.alerts ? { onlyMain: o.onlyMain, secret: o.secret, branch: main } : null,
        push,
        recordings,
        ...(o.inconclusive ? { inconclusive: o.inconclusive } : {}),
        keys,
        keysUnknown,
        liveKeys: live?.keys ?? [],
        liveKeysUnknown: !!live?.unknown,
        unreadable,
      }),
      // What the parts turned on need; the goldens that run live need their keys whichever is on.
      needs: rows(workflowNeeds({ fix: o.fix ? fixNeeds : null, alerts: o.alerts ? alertNeeds : alertNeeds.filter((r) => /runs? live|which goldens/.test(r[0])), push })),
      failures: rows(alertFailures(inconclusive)),
    },
    fixOnFailure: {
      on: o.fix,
      budget: o.budget,
      repairer: o.repairer,
      budgets: FIX_BUDGETS.map((b) => ({ value: b, label: `$${Number(b)}` })),
      repairers: REPAIRERS.map((r) => ({ ...r })),
      offNote: 'Off: a failed check fails the build, and nobody opens a fix.',
      yaml: fixOnFailureYaml({ budget: o.budget, repairer: o.repairer, recordings, push, ...(o.inconclusive ? { inconclusive: o.inconclusive } : {}), ...(keys.length ? { keys } : {}), ...(keysUnknown ? { keysUnknown } : {}), ...(unreadable ? { unreadable } : {}) }),
      needs: rows(fixNeeds),
      never: rows(fixOnFailureNever(o.budget)),
      preview: context.preview ? { ...context.preview, base: main, spent: context.preview.spent.replace(/ of \$[\d.]+$/, ` of $${o.budget}`) } : examplePreview(o.budget, main),
      teamStore,
    },
    alerts: {
      on: o.alerts,
      offNote: 'Off: Slack hears nothing, and a failed golden fails the build.',
      onlyMain: o.onlyMain,
      branch: main,
      secret: alertsSecret(o.secret),
      yaml: alertsYaml({ onlyMain: o.onlyMain, secret: o.secret, recordings, branch: main, ...(o.inconclusive ? { inconclusive: o.inconclusive } : {}), ...(live?.keys.length ? { keys: live.keys } : {}), ...(live?.unknown ? { keysUnknown: true } : {}), ...(unreadable ? { unreadable } : {}) }),
      needs: rows(alertNeeds),
      failures: rows(alertFailures(inconclusive)),
      inconclusive,
      message: { app: 'GitHub Actions', text: message.text, link: message.link, at: context.at },
    },
    recordings,
    repository: context.repository,
    configError,
  };
}
