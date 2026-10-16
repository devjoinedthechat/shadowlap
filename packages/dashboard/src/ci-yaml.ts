/**
 * The workflow steps the two Settings → CI panels show, as pure functions of their settings, so the
 * page can rewrite them as you type and docs/ci.md can show the very same YAML. No imports: the
 * browser bundle uses this file as it is.
 */

/** The GitHub Action this repository publishes. */
export const ACTION = 'devjoinedthechat/shadowlap@main';

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
}

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

/**
 * With push, the second comment: where the bucket's credentials come from. Short-lived ones come
 * from the two `if:` steps `shadowlap store ci` prints, put before this one: the writer's, and a
 * pull request's own, which write only under pr/ (the rest of what it prints is a job of its own:
 * its checkout, read-only contents and test step would keep this one from opening a fix). R2's keys
 * can't be kept to pr/, so only the jobs of your branches get them, and only those push.
 */
const BUCKET_COMMENT: Record<BucketCredentials, string> = {
  oidc: "# and before it, the bucket's credentials: the two if: steps shadowlap store ci prints",
  keys: "# and R2 keys as secrets: they can't be kept to pr/, so pull requests don't push",
};

/**
 * The Fix on failure step. Its job needs contents and pull-requests write permission, which the
 * comment states. Blame and verify run the agent itself live, so the step's env also needs the
 * agent's own provider keys, which the last comment says; the panel can't know which they are.
 * With `push` (Push from CI is on) the action pushes the test runs and each fix it opens to the
 * team store, so the job also needs the bucket's credentials, which a second comment says:
 * short-lived ones (`oidc`) come from the steps `shadowlap store ci` prints, with `id-token: write`
 * among the job's permissions, and the step pushes from every job, a pull request's to its own
 * folder; R2's keys (`keys`) go in the step's env for the jobs of your branches only, as `store ci`
 * gives them, and only those jobs push, since an R2 token can't be kept to a pull request's folder
 * and the pull request's own agent runs in its job. Without `push`, the step is exactly the one it
 * was before.
 */
export function fixOnFailureYaml(s: FixOnFailureSettings): string {
  const repairer = s.repairer.trim() || 'anthropic';
  const push = s.push ?? null;
  const lines = [`# the job needs: permissions: { contents: write, pull-requests: write${push === 'oidc' ? ', id-token: write' : ''} }`];
  if (push) lines.push(BUCKET_COMMENT[push]);
  // The claude-code repairer runs Claude Code in print mode, so the runner needs it installed.
  if (repairer === 'claude-code' || repairer.startsWith('claude-code:')) lines.push('- run: npm install -g @anthropic-ai/claude-code');
  const key = repairerKey(repairer);
  lines.push(
    `- uses: ${ACTION}`,
    '  with:',
    `    recordings: ${scalar(s.recordings ?? 'goldens/*')}`,
    '    fix-on-failure: true',
    `    fix-budget: ${dollars(s.budget)}`,
    `    repairer: ${scalar(repairer)}`,
    ...(push === 'oidc' ? ['    push: true'] : push === 'keys' ? [`    push: \${{ ${NOT_A_PULL_REQUEST} }}`] : []),
    '  env:',
    `    ${key}: \${{ secrets.${key} }}`,
    '    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    // Empty in a pull request's job, which then neither has them nor pushes.
    ...(push === 'keys' ? R2_KEYS.map((k) => `    ${k}: \${{ ${NOT_A_PULL_REQUEST} && secrets.${k} || '' }}`) : []),
    `    ${AGENT_KEYS_COMMENT}`,
  );
  return lines.join('\n');
}

/** What Fix on failure needs, as label and value; with `push`, the bucket's credentials too. */
export function fixOnFailureNeeds(repairer: string, push: BucketCredentials | null = null): Array<[string, string]> {
  const needs: Array<[string, string]> = [
    ['a model key for the repairer', repairerKey(repairer)],
    ['your agent’s provider keys: blame and verify run it live', 'env'],
    ['permission to push a branch', 'contents: write'],
    ['permission to open the pull request', 'pull-requests: write'],
  ];
  if (push === 'oidc') needs.push(['the bucket’s credentials: two shadowlap store ci steps', 'id-token: write']);
  if (push === 'keys') needs.push(['the bucket’s R2 keys as secrets, kept from pull requests’ jobs', 'secrets']);
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
 * The Alerts steps: the action counts the failed goldens without failing the step, Slack is told
 * when any failed, then the job fails.
 */
export function alertsYaml(s: AlertsSettings): string {
  const secret = alertsSecret(s.secret);
  const failed = "steps.goldens.outputs.failed != '0'";
  const cond = failed + (s.onlyMain ? ` && github.ref == 'refs/heads/${s.branch ?? 'main'}'` : '');
  return [
    `- uses: ${ACTION}`,
    '  id: goldens',
    '  with:',
    `    recordings: ${scalar(s.recordings ?? 'goldens/*')}`,
    '    fail-on-divergence: false',
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

/** What Alerts needs, as label and value. */
export function alertsNeeds(secret: string): Array<[string, string]> {
  return [
    ['an incoming webhook from your Slack workspace', 'Slack app'],
    ['its URL as a repository secret', alertsSecret(secret)],
    ['the test step’s outputs, by its id', 'id: goldens'],
  ];
}

/** What counts as a failure, each with its tag. */
export const ALERT_FAILURES: ReadonlyArray<[string, string]> = [
  ['its replay sends a request the recording doesn’t have', 'diverged'],
  ['it tries to call a model live; CI replays offline', 'live call'],
  ['the agent exits with an error', 'exit ≠ 0'],
  ['a check fails, token and cost budgets included', 'check failed'],
];
