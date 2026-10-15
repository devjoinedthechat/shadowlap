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

export interface FixOnFailureSettings {
  /** Dollars per failing golden. */
  budget: string;
  /** `claude-code`, `anthropic`, `anthropic:<model>`, `openai:<model>`, `claude-code:<model>`. */
  repairer: string;
  /** The goldens the step replays (default `goldens/*`). */
  recordings?: string;
}

/** The secret holding the repairer's model key. */
export function repairerKey(repairer: string): 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' {
  return repairer.startsWith('openai') ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
}

/** A dollar amount as the action takes it: `2.00`. */
function dollars(budget: string): string {
  const n = Number(String(budget).replace(/^\$/, ''));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '2.00';
}

/** A value safe on one YAML line: anything outside a plain scalar's alphabet is quoted. */
function scalar(value: string): string {
  return /^[A-Za-z0-9_./*:@-]+$/.test(value) && !/^[-:]|:$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

/** The Fix on failure step. Its job needs contents and pull-requests write permission, which the comment states. */
export function fixOnFailureYaml(s: FixOnFailureSettings): string {
  const repairer = s.repairer.trim() || 'anthropic';
  const lines = ['# the job needs: permissions: { contents: write, pull-requests: write }'];
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
    '  env:',
    `    ${key}: \${{ secrets.${key} }}`,
    '    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  );
  return lines.join('\n');
}

/** What Fix on failure needs, as label and value. */
export function fixOnFailureNeeds(repairer: string): Array<[string, string]> {
  return [
    ['a model key for the repairer', repairerKey(repairer)],
    ['permission to push a branch', 'contents: write'],
    ['permission to open the pull request', 'pull-requests: write'],
  ];
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
    '  uses: slackapi/slack-github-action@v2',
    '  with:',
    `    webhook: \${{ secrets.${secret} }}`,
    '    webhook-type: incoming-webhook',
    '    payload: |',
    '      text: "Shadowlap: ${{ steps.goldens.outputs.failed }} golden(s) failed on ${{ github.ref_name }}. ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"',
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
