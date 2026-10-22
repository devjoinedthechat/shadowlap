/**
 * The workflow steps the two Settings → CI panels show, as pure functions of their settings, so the
 * page can rewrite them as you type and docs/ci.md can show the very same YAML. No imports: the
 * browser bundle uses this file as it is.
 */

/**
 * The release the steps pin: the action at its tag, and the CLI it installs from npm, which spares
 * the job building it from source. scripts/set-version.mjs sets it with the packages' version.
 */
export const VERSION = '0.1.0';

/** The GitHub Action this repository publishes, at the release's tag. */
export const ACTION = `devjoinedthechat/shadowlap@v${VERSION}`;

/** Where the panels say the steps go. */
export const WORKFLOW_FILE = '.github/workflows/agent.yml';

/** The repairers the Fix on failure panel offers, as `--repairer` takes them. */
export const REPAIRERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'anthropic', label: 'Anthropic API' },
  { value: 'openai:gpt-5', label: 'OpenAI API' },
];

/** Budgets per failing golden the panel offers, in dollars. */
export const FIX_BUDGETS: readonly string[] = ['1.00', '2.00', '5.00'];

/**
 * The steps before the action that make it work in a job of its own: the repository, Node 22.16 or
 * later and not 23 (node-version: 22, as the action's own check asks for, saying so on a runner
 * whose Node is older), and the agent's own dependencies, which only the project knows: a
 * placeholder to make its own.
 */
const SETUP_NODE = ['- uses: actions/setup-node@v7', '  with:', '    node-version: 22'];
const INSTALL = '- run: npm ci && npm run build   # whatever your agent needs to run';
const CHECKOUT = '- uses: actions/checkout@v7';
/**
 * Fix on failure's checkout: the branch itself, which the fix's pull request goes into. A pull
 * request's own job checks out a detached merge commit otherwise, which no fix can be opened against.
 */
const CHECKOUT_BRANCH = [CHECKOUT, '  with:', '    ref: ${{ github.head_ref || github.ref }}'];

/** The secret a key variable is kept in, as the step's env takes it: `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`. */
const keyLine = (key: string) => `    ${key}: \${{ secrets.${key} }}`;

/**
 * How a GitHub Actions job signs in to the team store's bucket, as `shadowlap store ci` writes it:
 * short-lived credentials the job asks the cloud for (`id-token: write`: Amazon S3, Cloud Storage,
 * Azure), or keys kept in the repository's secrets (Cloudflare R2, which has no OIDC).
 */
export type BucketCredentials = 'oidc' | 'keys';

export interface FixOnFailureSettings {
  /** Dollars per failing golden. */
  budget: string;
  /** `claude-code`, `anthropic`, `anthropic:<model>`, `openai:<model>`, `claude-code:<model>`. */
  repairer: string;
  /** The goldens the step replays (default `goldens/*`). */
  recordings?: string;
  /**
   * Push from CI is on for the project (Settings → Store): the step pushes, so each fix it opens
   * reaches the team store too, and the job needs the bucket's credentials, got this way. Absent
   * when it is off: the step is the one it always was.
   */
  push?: BucketCredentials | null;
  /** What an inconclusive golden does to the step (the action's `inconclusive`): `fail`, the default and left out, or `warn`. */
  inconclusive?: 'fail' | 'warn';
  /**
   * The key variables of the providers the project's goldens call (`ANTHROPIC_API_KEY`), which blame
   * and verify run the agent live with, and a golden that forks runs live with: added to the step's
   * env beside the repairer's. Left out when the goldens can't tell, and the step says to add them.
   */
  keys?: readonly string[];
  /** A golden calls a provider whose key isn't named here (its pack can't be read, or Vertex AI's token): the step says to add the agent's keys, after those it names. */
  keysUnknown?: boolean;
  /** shadowlap.config.json can't be read, so whether the step pushes and its goldens' judges are unknown: the step says what is left out. */
  unreadable?: boolean;
}

/** The action's `inconclusive` line, only when it lets inconclusive goldens through. */
const inconclusiveLine = (mode: 'fail' | 'warn' | undefined): string[] => (mode === 'warn' ? ['    inconclusive: warn'] : []);

/**
 * A job that isn't a pull request's: `shadowlap store ci`'s condition for the credentials that write
 * anywhere in the store, which a pull request, able to change the agent and the workflow, never gets.
 */
const NOT_A_PULL_REQUEST = "!startsWith(github.event_name, 'pull_request')";

/** R2's keys, which `shadowlap store ci` reads from the repository's secrets. */
const R2_KEYS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

/** The secret holding the repairer's model key. */
export function repairerKey(repairer: string): 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' {
  return repairer.startsWith('openai') ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
}

/** A dollar amount as the action takes it: `2.00`. */
function dollars(budget: string): string {
  const n = Number(String(budget).replace(/^\$/, ''));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '2.00';
}

/**
 * A value safe on one YAML line: plain when it is made of letters, digits and `_./*:@-` and starts
 * with a letter, digit, `_`, `.` or `/` (a leading `*` is an alias, `@` is reserved); quoted otherwise.
 */
export function scalar(value: string): string {
  return /^[A-Za-z0-9_./][A-Za-z0-9_./*:@-]*$/.test(value) && !/:$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

/** Under the step's env: the keys of the agent's own providers belong there too. */
const AGENT_KEYS_COMMENT = "# and your agent's own provider keys: blame and verify run it live";

/** The config every step reads its goldens and Push from CI from. */
const CONFIG = 'shadowlap.config.json';

/** Under Fix on failure's env, while the config can't be read: what the step can't know without it. */
const FIX_UNREADABLE_COMMENT = `# ${CONFIG} can't be read: push (Push from CI) and the judges' keys are left out`;

/** Under Alerts' env, while the config can't be read: which goldens run live, and so their keys, come from it. */
const ALERTS_UNREADABLE_COMMENT = `# ${CONFIG} can't be read: the keys of the goldens that run live are left out`;

/**
 * With push, where the bucket's credentials come from. Short-lived ones come from the two `if:`
 * steps `shadowlap store ci` prints, which go right before the action (the comment stands in their
 * place): the writer's, and a pull request's own, which write only under pr/ (the rest of what it
 * prints is a job of its own: its checkout, read-only contents and test step would keep this one
 * from opening a fix). R2's keys can't be kept to pr/, so only the jobs of your branches get them,
 * and only those push: a second line under the first comment says so.
 */
const BUCKET_COMMENT: Record<BucketCredentials, string> = {
  oidc: "# here, the bucket's credentials: the two if: steps shadowlap store ci prints",
  keys: "# and R2 keys as secrets: they can't be kept to pr/, so pull requests don't push",
};

/**
 * The Fix on failure steps, as a job of their own runs them: the branch checked out, so the fix's
 * pull request goes into it; Node 22.16 or later; the agent's own dependencies (a placeholder); then
 * the action. Its job needs contents and pull-requests write permission, which the first comment
 * states. Blame and verify run the agent itself live, so the step's env also needs the agent's own
 * provider keys: those the project's goldens call (`keys`), and a comment that says to add them when
 * there are none or a golden's can't be named (`keysUnknown`). While shadowlap.config.json can't be
 * read (`unreadable`), a comment says what the step leaves out. With `push` (Push from CI is on) the action pushes the test runs and each fix it opens to the
 * team store, so the job also needs the bucket's credentials: short-lived ones (`oidc`) come from
 * the steps `shadowlap store ci` prints, which go right before the action, with `id-token: write`
 * among the job's permissions, and the step pushes from every job, a pull request's to its own
 * folder; R2's keys (`keys`) go in the step's env for the jobs of your branches only, as `store ci`
 * gives them, and only those jobs push, since an R2 token can't be kept to a pull request's folder
 * and the pull request's own agent runs in its job.
 */
export function fixOnFailureYaml(s: FixOnFailureSettings): string {
  const repairer = s.repairer.trim() || 'anthropic';
  const push = s.push ?? null;
  const key = repairerKey(repairer);
  const known = (s.keys ?? []).length > 0 && !s.keysUnknown;
  const agentKeys = (s.keys ?? []).filter((k, i, all) => k !== key && all.indexOf(k) === i);
  const lines = [`# the job needs: permissions: { contents: write, pull-requests: write${push === 'oidc' ? ', id-token: write' : ''} }`];
  if (push === 'keys') lines.push(BUCKET_COMMENT.keys);
  lines.push(...CHECKOUT_BRANCH, ...SETUP_NODE, INSTALL);
  // The claude-code repairer runs Claude Code in print mode, so the runner needs it installed.
  if (repairer === 'claude-code' || repairer.startsWith('claude-code:')) lines.push('- run: npm install -g @anthropic-ai/claude-code');
  if (push === 'oidc') lines.push(BUCKET_COMMENT.oidc);
  lines.push(
    `- uses: ${ACTION}`,
    '  with:',
    `    version: ${VERSION}`,
    `    recordings: ${scalar(s.recordings ?? 'goldens/*')}`,
    '    fix-on-failure: true',
    `    fix-budget: ${dollars(s.budget)}`,
    `    repairer: ${scalar(repairer)}`,
    ...inconclusiveLine(s.inconclusive),
    ...(push === 'oidc' ? ['    push: true'] : push === 'keys' ? [`    push: \${{ ${NOT_A_PULL_REQUEST} }}`] : []),
    '  env:',
    keyLine(key),
    '    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    // Empty in a pull request's job, which then neither has them nor pushes.
    ...(push === 'keys' ? R2_KEYS.map((k) => `    ${k}: \${{ ${NOT_A_PULL_REQUEST} && secrets.${k} || '' }}`) : []),
    ...agentKeys.map(keyLine),
    ...(known ? [] : [`    ${AGENT_KEYS_COMMENT}`]),
    ...(s.unreadable ? [`    ${FIX_UNREADABLE_COMMENT}`] : []),
  );
  return lines.join('\n');
}

/** The row every step that runs the action needs: the Node it runs on. */
const NODE_NEED: [string, string] = ['Node 22.16 or later on the runner, not 23', 'node-version: 22'];

/** What a needs row says of the config while it can't be read: the value. */
const UNREADABLE = 'can’t be read';

/** A row of an "it needs" list: what, and the value on the right; amber (`warn`) for what can't be had now. */
export type NeedRow = [string, string, 'warn'?];

/**
 * What Fix on failure needs, as label and value: the agent's provider keys by name when the goldens
 * say which (`keys`); with `push`, the bucket's credentials too; then the branch it opens the fix
 * against, and Node.
 */
export function fixOnFailureNeeds(repairer: string, push: BucketCredentials | null = null, keys: readonly string[] = [], unreadable = false): NeedRow[] {
  const needs: NeedRow[] = [
    ['a model key for the repairer', repairerKey(repairer)],
    ['your agent’s provider keys: blame and verify run it live', keys.length ? [...new Set(keys)].join(', ') : 'env'],
    ['permission to push a branch', 'contents: write'],
    ['permission to open the pull request', 'pull-requests: write'],
  ];
  if (push === 'oidc') needs.push(['the bucket’s credentials: two shadowlap store ci steps', 'id-token: write']);
  if (push === 'keys') needs.push(['the bucket’s R2 keys as secrets, kept from pull requests’ jobs', 'secrets']);
  // Without the config, whether the step pushes, and its goldens' judges, aren't known.
  if (unreadable) needs.push([`Push from CI and the judges’ keys, from ${CONFIG}`, UNREADABLE, 'warn']);
  needs.push(['the branch checked out, for the fix to go into', 'ref: head_ref'], NODE_NEED);
  return needs;
}

/** What Fix on failure never does. */
export function fixOnFailureNever(budget: string): Array<[string, string]> {
  return [
    ['opens a pull request for a divergence; most are intended', 'divergence'],
    ['keeps a fix that verify rejected', 'rejected'],
    ['spends past the budget', `$${dollars(budget)}`],
    ['merges anything: you review every fix', 'merge'],
  ];
}

export interface AlertsSettings {
  /** Post only for the main branch: pull requests stay quiet, their checks already show it. */
  onlyMain: boolean;
  /** The repository secret that holds the Slack webhook URL. */
  secret: string;
  recordings?: string;
  /** The main branch (default `main`). */
  branch?: string;
  /** What an inconclusive golden does: `fail`, the default and left out, counts it in `failed`, so Slack hears of it; `warn` doesn't. */
  inconclusive?: 'fail' | 'warn';
  /**
   * The key variables of the providers the goldens that run live call (one that forks, or has an
   * injection gate): the test step's env. None for goldens that all replay offline.
   */
  keys?: readonly string[];
  /** Goldens that run live call a provider whose key isn't named here (its pack can't be read, or Vertex AI's token): the env says to add the agent's keys. */
  keysUnknown?: boolean;
  /** shadowlap.config.json can't be read, so which goldens run live isn't known: the env says their keys are left out. */
  unreadable?: boolean;
}

/** A secret's name as GitHub allows it: letters, digits and `_`. Empty becomes SLACK_WEBHOOK_URL. */
export function alertsSecret(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9_]/g, '') || 'SLACK_WEBHOOK_URL';
}

/** The message the Alerts step posts, with GitHub's expressions in it; alertsMessage fills them in. */
const ALERT_TEXT = 'Shadowlap: ${{ steps.goldens.outputs.failed }} golden(s) failed on ${{ github.ref_name }}. ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}';

/**
 * The message as Slack shows it, for the panel's preview: the text the workflow posts, for a number
 * of failed goldens on a branch, and the link to the workflow run.
 */
export function alertsMessage(o: { failed: number; branch: string; runUrl: string }): { text: string; link: string } {
  return { text: `Shadowlap: ${o.failed} golden(s) failed on ${o.branch}.`, link: o.runUrl };
}

/**
 * A step's env: its keys, then the comments under them. With no key to name, an `env:` holding only
 * comments is empty, which GitHub refuses, so the comments go under a commented-out `env:` instead,
 * where the keys are to be added.
 */
function envLines(keys: readonly string[], notes: readonly string[]): string[] {
  if (keys.length) return ['  env:', ...keys.map(keyLine), ...notes.map((n) => `    ${n}`)];
  return notes.length ? ['  # env:', ...notes.map((n) => `  #   ${n.replace(/^# /, '')}`)] : [];
}

/**
 * The Alerts steps, as a job of their own runs them: the repository, Node 22.16 or later and the
 * agent's own dependencies (a placeholder), then the action, which counts the failed goldens without
 * failing the step, with the keys of the providers the goldens that run live call, a comment where
 * one of theirs can't be named (`keysUnknown`) and one while shadowlap.config.json can't be read
 * (`unreadable`); Slack is told when any failed, then the job fails.
 */
export function alertsYaml(s: AlertsSettings): string {
  const secret = alertsSecret(s.secret);
  const failed = "steps.goldens.outputs.failed != '0'";
  const cond = failed + (s.onlyMain ? ` && github.ref == 'refs/heads/${s.branch ?? 'main'}'` : '');
  const keys = [...new Set(s.keys ?? [])];
  const notes = [...(s.keysUnknown ? [`# ${keys.length ? 'and ' : ''}your agent's own provider keys: the goldens that run live call them`] : []), ...(s.unreadable ? [ALERTS_UNREADABLE_COMMENT] : [])];
  return [
    CHECKOUT,
    ...SETUP_NODE,
    INSTALL,
    `- uses: ${ACTION}`,
    '  id: goldens',
    '  with:',
    `    version: ${VERSION}`,
    `    recordings: ${scalar(s.recordings ?? 'goldens/*')}`,
    '    fail-on-divergence: false',
    ...inconclusiveLine(s.inconclusive),
    ...envLines(keys, notes),
    '',
    '- name: Tell Slack',
    `  if: ${cond}`,
    '  uses: slackapi/slack-github-action@v4',
    '  with:',
    `    webhook: \${{ secrets.${secret} }}`,
    '    webhook-type: incoming-webhook',
    '    payload: |',
    `      text: "${ALERT_TEXT}"`,
    '',
    '- name: Fail the job',
    `  if: ${failed}`,
    '  run: exit 1',
  ].join('\n');
}

/**
 * The goldens that run live in CI and the keys they need, as a needs row says them: "2 goldens run
 * live (fork) · ANTHROPIC_API_KEY". `count` goldens, for `why` (a fork, an injection gate).
 */
export interface LiveGoldens {
  count: number;
  why: ReadonlyArray<'fork' | 'injection gate'>;
  keys: readonly string[];
  /** How many of them call a provider whose key isn't named here: a pack that can't be read, or Vertex AI, which signs in with a token. */
  unknown: number;
}

/**
 * What Alerts needs, as label and value; with goldens that run live, their providers' keys. While
 * the config can't be read (`unreadable`), which goldens run live isn't known, and a row says so.
 */
export function alertsNeeds(secret: string, live: LiveGoldens | null = null, unreadable = false): NeedRow[] {
  return [
    ['an incoming webhook from your Slack workspace', 'Slack app'],
    ['its URL as a repository secret', alertsSecret(secret)],
    ['the test step’s outputs, by its id', 'id: goldens'],
    ...(live && live.count ? [[`${live.count} ${live.count === 1 ? 'golden runs' : 'goldens run'} live (${live.why.join(', ')})`, live.keys.length ? live.keys.join(', ') : 'their providers’ keys'] as NeedRow] : []),
    ...(unreadable ? [[`which goldens run live, and their keys, from ${CONFIG}`, UNREADABLE, 'warn'] as NeedRow] : []),
    NODE_NEED,
  ];
}

/**
 * What counts as a failure, each with its tag and tone: red for a failure, amber for a golden that
 * can't be decided, which fails it unless `inconclusive` is `warn`, which lets it through (then it
 * isn't listed).
 */
export function alertFailures(inconclusive: 'fail' | 'warn' = 'fail'): Array<[string, string, 'err' | 'warn']> {
  return [
    ['its replay sends a request the recording doesn’t have', 'diverged', 'err'],
    ['it tries a live call where it must replay offline', 'live call', 'err'],
    ['the agent exits with an error', 'exit ≠ 0', 'err'],
    ['a check fails, token and cost budgets included', 'check failed', 'err'],
    ['planted text steers a tool call more often than its injection gate allows', 'injection', 'err'],
    ...(inconclusive === 'warn' ? [] : [['a gate, a judge or an injection test can’t decide', 'inconclusive', 'warn'] as [string, string, 'warn']]),
  ];
}
