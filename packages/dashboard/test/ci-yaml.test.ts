import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTION, alertFailures, DISPATCH_COMMENT, alertsMessage, alertsNeeds, alertsSecret, alertsYaml, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml, repairerKey, scalar, VERSION, workflowNeeds, workflowYaml } from '../src/ci-yaml.js';

/** The workflow steps behind Settings → CI, checked against the action they use and the docs that show them. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const actionYml = readFileSync(join(ROOT, 'action.yml'), 'utf8');
const keysOf = (from: string, to: string) => [...actionYml.slice(actionYml.indexOf(`\n${from}:`), actionYml.indexOf(`\n${to}:`)).matchAll(/^ {2}([a-z-]+):/gm)].map((m) => m[1]);
const inputs = keysOf('inputs', 'outputs');
const outputs = keysOf('outputs', 'runs');
/** The keys a generated step passes under `with:` to this repository's action. */
const withKeys = (yaml: string) => {
  const step = yaml.slice(yaml.indexOf(`uses: ${ACTION}`));
  const keys: string[] = [];
  for (const line of step.slice(step.indexOf('  with:\n') + '  with:\n'.length).split('\n')) {
    const m = /^ {4}([a-z-]+):/.exec(line);
    if (!m) break;
    keys.push(m[1]);
  }
  return keys;
};

describe('the version the steps pin', () => {
  it('is the version of the CLI package, so a version bump moves every step with it', () => {
    expect(VERSION).toBe((JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }).version);
  });
});

/** What every step needs before the action in a job of its own: Node 22.16 or later, and the agent's dependencies. */
const SETUP = ['- uses: actions/setup-node@v7', '  with:', '    node-version: 22', '- run: npm ci && npm run build   # whatever your agent needs to run'];
/** Fix on failure's checkout: the branch itself, which its pull request goes into; the job's token left off the disk. */
const BRANCH = ['- uses: actions/checkout@v7', '  with:', '    ref: ${{ github.head_ref || github.ref }}', '    persist-credentials: false'];
/** Every other checkout: the job's token left off the disk, where the agent could read it. */
const CHECKOUT = ['- uses: actions/checkout@v7', '  with:', '    persist-credentials: false'];

describe('the Fix on failure step', () => {
  it('runs the action with fix-on-failure, its budget and repairer, and says what the job needs', () => {
    expect(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code' })).toBe(
      [
        '# the job needs: permissions: { contents: write, pull-requests: write, actions: write }',
        "# and workflow_dispatch: under the workflow's on:, so a fix's pull request gets its checks",
        ...BRANCH,
        ...SETUP,
        '- run: npm install -g @anthropic-ai/claude-code',
        `- uses: devjoinedthechat/shadowlap@v${VERSION}`,
        '  with:',
        `    version: ${VERSION}`,
        '    recordings: goldens/*',
        '    fix-on-failure: true',
        '    fix-budget: 2.00',
        '    repairer: claude-code',
        '  env:',
        '    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
        "    # and your agent's own provider keys: blame and verify run it live",
      ].join('\n'),
    );
    const openai = fixOnFailureYaml({ budget: '$5', repairer: 'openai:gpt-5' });
    expect(openai).not.toContain('npm install');
    expect(openai).toContain('    fix-budget: 5.00\n    repairer: openai:gpt-5\n');
    expect(openai).toContain('    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}');
    expect(fixOnFailureYaml({ budget: 'lots', repairer: 'anthropic' })).toContain('    fix-budget: 2.00\n    repairer: anthropic\n');
    expect(repairerKey('claude-code:claude-opus-5-5')).toBe('ANTHROPIC_API_KEY');
    expect(fixOnFailureNeeds('openai:gpt-5')).toEqual([
      ['a model key for the repairer', 'OPENAI_API_KEY'],
      // Blame and verify run the agent itself live, whatever the repairer.
      ['your agent’s provider keys: blame and verify run it live', 'env'],
      ['permission to push a branch', 'contents: write'],
      // The pull request, the action's comment on it, and its checks: GitHub starts none for the job's own token, so the action starts the workflow on the branch.
      ['permission to open the pull request and keep its comment', 'pull-requests: write'],
      ['permission to start the pull request’s checks', 'actions: write'],
      ['the trigger they start from, under the workflow’s on:', 'workflow_dispatch:'],
      // As handed over, in a job of its own: a branch to open the fix against, and the Node the action needs.
      ['the branch checked out, for the fix to go into', 'ref: head_ref'],
      ['Node 22.16 or later on the runner, not 23', 'node-version: 22'],
    ]);
    expect(fixOnFailureNever('1.00').map((x) => x[1])).toEqual(['divergence', 'rejected', '$1.00', 'merge']);
  });

  it('pushes too when Push from CI is on, saying the job needs the bucket’s credentials; off, it is the step it was', () => {
    const off = fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code' });
    // Off is the step before push existed, byte for byte, left out or said.
    expect(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: null })).toBe(off);
    // Short-lived credentials (S3, Cloud Storage, Azure): the two credentials steps store ci prints go
    // before it, and they need id-token; every job pushes, a pull request's to its own folder.
    const oidc = fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'oidc' });
    expect(oidc).toBe(
      [
        '# the job needs: permissions: { contents: write, pull-requests: write, actions: write, id-token: write }',
        "# and workflow_dispatch: under the workflow's on:, so a fix's pull request gets its checks",
        ...BRANCH,
        ...SETUP,
        '- run: npm install -g @anthropic-ai/claude-code',
        "# here, the bucket's credentials: the two if: steps shadowlap store ci prints",
        `- uses: devjoinedthechat/shadowlap@v${VERSION}`,
        '  with:',
        `    version: ${VERSION}`,
        '    recordings: goldens/*',
        '    fix-on-failure: true',
        '    fix-budget: 2.00',
        '    repairer: claude-code',
        '    push: true',
        '  env:',
        '    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
        "    # and your agent's own provider keys: blame and verify run it live",
      ].join('\n'),
    );
    // Everything else is as it was: the push lines are added, none changed.
    const added = (yaml: string) => yaml.split('\n').filter((l) => !off.split('\n').includes(l));
    expect(added(oidc)).toEqual(['# the job needs: permissions: { contents: write, pull-requests: write, actions: write, id-token: write }', "# here, the bucket's credentials: the two if: steps shadowlap store ci prints", '    push: true']);
    // The credentials steps go right before the action, after the checkout and the rest.
    expect(oidc.indexOf("# here, the bucket's credentials")).toBe(oidc.indexOf(`\n- uses: ${ACTION}`) - "# here, the bucket's credentials: the two if: steps shadowlap store ci prints".length);
    // Keys in the repository's secrets (R2, which has no OIDC and whose token can't be kept to pr/):
    // only a job that isn't a pull request's gets them, and only it pushes, as store ci has it.
    const keys = fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'keys' });
    expect(keys).toBe(
      [
        '# the job needs: permissions: { contents: write, pull-requests: write, actions: write }',
        "# and workflow_dispatch: under the workflow's on:, so a fix's pull request gets its checks",
        "# and R2 keys as secrets: they can't be kept to pr/, so pull requests don't push",
        ...BRANCH,
        ...SETUP,
        '- run: npm install -g @anthropic-ai/claude-code',
        `- uses: devjoinedthechat/shadowlap@v${VERSION}`,
        '  with:',
        `    version: ${VERSION}`,
        '    recordings: goldens/*',
        '    fix-on-failure: true',
        '    fix-budget: 2.00',
        '    repairer: claude-code',
        "    push: ${{ !startsWith(github.event_name, 'pull_request') }}",
        '  env:',
        '    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
        "    R2_ACCESS_KEY_ID: ${{ !startsWith(github.event_name, 'pull_request') && secrets.R2_ACCESS_KEY_ID || '' }}",
        "    R2_SECRET_ACCESS_KEY: ${{ !startsWith(github.event_name, 'pull_request') && secrets.R2_SECRET_ACCESS_KEY || '' }}",
        "    # and your agent's own provider keys: blame and verify run it live",
      ].join('\n'),
    );
    expect(added(keys)).toEqual([
      "# and R2 keys as secrets: they can't be kept to pr/, so pull requests don't push",
      "    push: ${{ !startsWith(github.event_name, 'pull_request') }}",
      "    R2_ACCESS_KEY_ID: ${{ !startsWith(github.event_name, 'pull_request') && secrets.R2_ACCESS_KEY_ID || '' }}",
      "    R2_SECRET_ACCESS_KEY: ${{ !startsWith(github.event_name, 'pull_request') && secrets.R2_SECRET_ACCESS_KEY || '' }}",
    ]);
    // The same condition store ci puts on the step that holds R2's keys and pushes.
    const writerIf = "${{ !startsWith(github.event_name, 'pull_request') }}";
    expect(keys).toContain(`    push: ${writerIf}\n`);
    expect(fixOnFailureYaml({ budget: '5', repairer: 'openai:gpt-5', push: 'keys' })).toContain(`    repairer: openai:gpt-5\n    push: ${writerIf}\n  env:\n    OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}\n`);
    // What it needs names the bucket's credentials, after what the step needs without push.
    const plainNeeds = fixOnFailureNeeds('claude-code');
    expect(fixOnFailureNeeds('claude-code', 'oidc')).toEqual([...plainNeeds.slice(0, 6), ['the bucket’s credentials: two shadowlap store ci steps', 'id-token: write'], ...plainNeeds.slice(6)]);
    expect(fixOnFailureNeeds('anthropic', 'keys')).toEqual([...fixOnFailureNeeds('anthropic').slice(0, 6), ['the bucket’s R2 keys as secrets, kept from pull requests’ jobs', 'secrets'], ...plainNeeds.slice(6)]);
    expect(fixOnFailureNeeds('anthropic', null)).toEqual(fixOnFailureNeeds('anthropic'));
  });

  it('is YAML a workflow reads as written, its expressions left whole for GitHub', () => {
    // A plain scalar may hold ${{ }}, quotes, && and ||: none of them starts one, and no `: ` or ` #` is inside.
    for (const push of [null, 'oidc', 'keys'] as const) {
      for (const line of fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push }).split('\n')) {
        const value = /^\s*(?:- )?[a-zA-Z_-]+: (.*)$/.exec(line)?.[1];
        if (!value?.startsWith('${{')) continue;
        expect(value.endsWith('}}'), line).toBe(true);
        expect(value, line).not.toMatch(/: | #/);
      }
    }
  });

  it('names the agent’s provider keys the goldens call, beside the repairer’s, once each', () => {
    // An agent on OpenAI with the anthropic repairer: both keys, by name, and no comment to add them.
    const both = fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic', keys: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] });
    expect(both).toContain('  env:\n    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}');
    expect(both.match(/ANTHROPIC_API_KEY:/g)).toHaveLength(1);
    expect(both.match(/OPENAI_API_KEY:/g)).toHaveLength(1);
    expect(both).not.toContain("# and your agent's own provider keys");
    expect(both.trimEnd().endsWith('OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}')).toBe(true);
    // Its repairer's key alone: nothing to add, and nothing to say.
    expect(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', keys: ['ANTHROPIC_API_KEY'] }).trimEnd().endsWith('  env:\n    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}')).toBe(true);
    // Goldens that tell nothing: the comment says to add them.
    expect(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic', keys: [] })).toBe(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic' }));
    expect(fixOnFailureNeeds('anthropic', null, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])[1]).toEqual(['your agent’s provider keys: blame and verify run it live', 'OPENAI_API_KEY, ANTHROPIC_API_KEY']);
  });

  it('works as a job of its own: the branch, Node 22 and the agent’s dependencies before the action', () => {
    const yaml = fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic' });
    const steps = yaml.split('\n').filter((l) => l.startsWith('- '));
    expect(steps).toEqual(['- uses: actions/checkout@v7', '- uses: actions/setup-node@v7', '- run: npm ci && npm run build   # whatever your agent needs to run', `- uses: ${ACTION}`]);
    // The branch: a pull request's own job checks out a detached merge commit, which no fix can go into.
    expect(yaml).toContain(`${BRANCH.join('\n')}\n`);
  });

  it('passes only inputs the action has', () => {
    expect(withKeys(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic' }))).toEqual(['version', 'recordings', 'fix-on-failure', 'fix-budget', 'repairer']);
    expect(withKeys(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic', push: 'oidc' }))).toEqual(['version', 'recordings', 'fix-on-failure', 'fix-budget', 'repairer', 'push']);
    expect(withKeys(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic', push: 'keys' }))).toEqual(['version', 'recordings', 'fix-on-failure', 'fix-budget', 'repairer', 'push']);
    for (const push of [null, 'oidc', 'keys'] as const) for (const key of withKeys(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic', push }))) expect(inputs).toContain(key);
    // Inconclusive goldens let through: the action's own input, written only when it isn't the default.
    expect(withKeys(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic', inconclusive: 'warn' }))).toEqual(['version', 'recordings', 'fix-on-failure', 'fix-budget', 'repairer', 'inconclusive']);
    expect(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic', inconclusive: 'fail' })).toBe(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic' }));
    expect(inputs).toEqual(expect.arrayContaining(['inconclusive', 'max-attempts', 'keep-history']));
    expect(outputs).toContain('inconclusive');
    expect(outputs).toEqual(expect.arrayContaining(['passed', 'failed', 'diverged', 'checks-failed', 'session', 'fixes', 'fix-prs']));
  });
});

describe('your workflow', () => {
  const fix = { budget: '2.00', repairer: 'claude-code' };
  const alerts = { onlyMain: true, secret: 'SLACK_WEBHOOK_URL' };
  const steps = (yaml: string) => yaml.split('\n').filter((l) => l.startsWith('- '));

  it('runs the goldens once, in one job, whatever is turned on: one checkout, one Node, the action once with its id', () => {
    for (const push of [null, 'oidc', 'keys'] as const)
      for (const f of [null, fix])
        for (const a of [null, alerts]) {
          const all = steps(workflowYaml({ fix: f, alerts: a, push, keys: ['ANTHROPIC_API_KEY'] }));
          expect(all.filter((l) => l.startsWith('- uses: actions/checkout@'))).toHaveLength(1);
          expect(all.filter((l) => l.startsWith('- uses: actions/setup-node@'))).toHaveLength(1);
          expect(all.filter((l) => l === `- uses: ${ACTION}`)).toHaveLength(1);
          expect(workflowYaml({ fix: f, alerts: a, push })).toContain(`- uses: ${ACTION}\n  id: goldens\n  with:\n`);
        }
  });

  it('is the Alerts steps when only Slack is on, and the plain test step when nothing is', () => {
    expect(workflowYaml({ fix: null, alerts })).toBe(alertsYaml(alerts));
    const plain = workflowYaml({ fix: null, alerts: null });
    expect(steps(plain)).toEqual(['- uses: actions/checkout@v7', '- uses: actions/setup-node@v7', '- run: npm ci && npm run build   # whatever your agent needs to run', `- uses: ${ACTION}`]);
    // It fails the job itself: no count to read, nothing after it.
    expect(plain).not.toContain('fail-on-divergence');
    // On a pull request the action keeps a comment there, which needs pull-requests: write; it opens no fix, so it reads the repository and starts nothing.
    expect(plain.split('\n')[0]).toBe('# the job needs: permissions: { contents: read, pull-requests: write }');
    expect(plain).not.toContain('workflow_dispatch');
    expect(alertsYaml(alerts).split('\n')[0]).toBe('# the job needs: permissions: { contents: read, pull-requests: write }');
    expect(workflowNeeds({ fix: null, alerts: null, push: null })).toEqual([
      ['permission to keep the action’s comment on a pull request', 'pull-requests: write'],
      ['Node 22.16 or later on the runner, not 23', 'node-version: 22'],
    ]);
    expect(alertsNeeds('SLACK_WEBHOOK_URL')).toContainEqual(['permission to keep the action’s comment on a pull request', 'pull-requests: write']);
  });

  it('opens a fix and tells Slack from the same step, the fix’s branch checked out and its keys in its env', () => {
    const yaml = workflowYaml({ fix, alerts, keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] });
    expect(yaml.split('\n').slice(0, 2)).toEqual(['# the job needs: permissions: { contents: write, pull-requests: write, actions: write }', DISPATCH_COMMENT]);
    expect(yaml).toContain(`${BRANCH.join('\n')}\n`);
    expect(yaml).toContain('- run: npm install -g @anthropic-ai/claude-code\n');
    expect(withKeys(yaml)).toEqual(['version', 'recordings', 'fail-on-divergence', 'fix-on-failure', 'fix-budget', 'repairer']);
    expect(yaml).toContain('  env:\n    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}\n\n- name: Tell Slack\n');
    expect(steps(yaml).slice(-2)).toEqual(['- name: Tell Slack', '- name: Fail the job']);
  });

  it('pushes from the same step while Push from CI is on, with the bucket’s credentials, a fix or not', () => {
    const oidc = workflowYaml({ fix: null, alerts: null, push: 'oidc', liveKeys: ['ANTHROPIC_API_KEY'] });
    expect(oidc.split('\n')[0]).toBe('# the job needs: permissions: { contents: read, pull-requests: write, id-token: write }');
    expect(oidc).toContain("# here, the bucket's credentials: the two if: steps shadowlap store ci prints\n- uses: ");
    expect(withKeys(oidc)).toEqual(['version', 'recordings', 'push']);
    expect(oidc).toContain('  env:\n    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
    const r2 = workflowYaml({ fix: null, alerts, push: 'keys' });
    expect(r2.split('\n').slice(0, 2)).toEqual(['# the job needs: permissions: { contents: read, pull-requests: write }', "# and R2 keys as secrets: they can't be kept to pr/, so pull requests don't push"]);
    expect(r2).toContain("    push: ${{ !startsWith(github.event_name, 'pull_request') }}\n  env:\n    R2_ACCESS_KEY_ID: ${{ !startsWith(github.event_name, 'pull_request') && secrets.R2_ACCESS_KEY_ID || '' }}\n");
    expect(workflowYaml({ fix, alerts: null, push: 'oidc' }).split('\n')[0]).toBe('# the job needs: permissions: { contents: write, pull-requests: write, actions: write, id-token: write }');
    for (const push of [null, 'oidc', 'keys'] as const) for (const key of withKeys(workflowYaml({ fix, alerts, push, inconclusive: 'warn' }))) expect(inputs).toContain(key);
  });

  it('is YAML a workflow reads as written, its expressions left whole for GitHub', () => {
    for (const push of [null, 'oidc', 'keys'] as const)
      for (const line of workflowYaml({ fix, alerts, push }).split('\n')) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        expect(line, line).toMatch(/^(?: {2})*(?:- )?(?:[a-z-]+:(?: .*)?|[A-Z0-9_]+: .*|text: .*|exit 1)$|^ {6}text: /);
      }
  });

  it('needs what each part turned on needs, once each, then Node', () => {
    const needs = workflowNeeds({ fix: fixOnFailureNeeds('claude-code', 'oidc', ['ANTHROPIC_API_KEY']), alerts: alertsNeeds('SLACK_WEBHOOK_URL'), push: 'oidc' });
    expect(needs.filter((r) => r[1] === 'id-token: write')).toHaveLength(1);
    expect(needs.at(-1)).toEqual(['Node 22.16 or later on the runner, not 23', 'node-version: 22']);
    expect(needs.filter((r) => r[1] === 'node-version: 22')).toHaveLength(1);
    expect(needs.map((r) => r[1])).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'contents: write', 'Slack app', 'id: goldens']));
    // Neither part on, with Push from CI: the bucket's credentials alone.
    expect(workflowNeeds({ fix: null, alerts: null, push: 'keys' })).toEqual([
      ['permission to keep the action’s comment on a pull request', 'pull-requests: write'],
      ['the bucket’s R2 keys as secrets, kept from pull requests’ jobs', 'secrets'],
      ['Node 22.16 or later on the runner, not 23', 'node-version: 22'],
    ]);
    // With a fix on, its own rows give pull-requests: write once.
    expect(needs.filter((r) => r[1] === 'pull-requests: write')).toHaveLength(1);
  });
});

describe('the Alerts steps', () => {
  it('post the failed count to Slack, only for main when asked, then fail the job', () => {
    const yaml = alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' });
    expect(yaml).toContain("  if: steps.goldens.outputs.failed != '0' && github.ref == 'refs/heads/main'\n  uses: slackapi/slack-github-action@v4");
    expect(yaml).toContain('    recordings: goldens/*\n    fail-on-divergence: false\n');
    expect(yaml).toContain('    webhook: ${{ secrets.SLACK_WEBHOOK_URL }}\n    webhook-type: incoming-webhook\n');
    expect(yaml.trimEnd().endsWith("- name: Fail the job\n  if: steps.goldens.outputs.failed != '0'\n  run: exit 1")).toBe(true);
    const everywhere = alertsYaml({ onlyMain: false, secret: 'team-hook!' });
    expect(everywhere).not.toContain('github.ref ==');
    expect(everywhere).toContain('${{ secrets.teamhook }}');
    for (const key of withKeys(yaml)) expect(inputs).toContain(key);
    // With inconclusive goldens let through, the failed count Slack hears of leaves them out.
    const warned = alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL', inconclusive: 'warn' });
    expect(warned).toContain('    fail-on-divergence: false\n    inconclusive: warn\n');
    for (const key of withKeys(warned)) expect(inputs).toContain(key);
    expect(yaml).toContain('steps.goldens.outputs.failed');
    expect(outputs).toContain('failed');
  });

  it('work as a job of their own, with the keys of the providers the goldens that run live call', () => {
    const yaml = alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' });
    expect(yaml.startsWith(['# the job needs: permissions: { contents: read, pull-requests: write }', ...CHECKOUT, ...SETUP, `- uses: ${ACTION}`].join('\n'))).toBe(true);
    // Every golden replays offline: no key, no env.
    expect(yaml).not.toContain('  env:');
    // Two goldens fork: their provider's key goes to the test step, or they fail and Slack hears of it on every run.
    const live = alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL', keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'] });
    expect(live).toContain('    fail-on-divergence: false\n  env:\n    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n\n- name: Tell Slack');
    for (const key of withKeys(live)) expect(inputs).toContain(key);
    expect(alertsNeeds('SLACK_WEBHOOK_URL', { count: 2, why: ['fork'], keys: ['ANTHROPIC_API_KEY'], unknown: 0 })).toEqual([
      ['an incoming webhook from your Slack workspace', 'Slack app'],
      ['its URL as a repository secret', 'SLACK_WEBHOOK_URL'],
      ['the test step’s outputs, by its id', 'id: goldens'],
      ['2 goldens run live (fork)', 'ANTHROPIC_API_KEY'],
      ['permission to keep the action’s comment on a pull request', 'pull-requests: write'],
      ['Node 22.16 or later on the runner, not 23', 'node-version: 22'],
    ]);
    expect(alertsNeeds('X', { count: 1, why: ['fork', 'injection gate'], keys: ['OPENAI_API_KEY', 'GEMINI_API_KEY'], unknown: 0 })[3]).toEqual(['1 golden runs live (fork, injection gate)', 'OPENAI_API_KEY, GEMINI_API_KEY']);
    expect(alertsNeeds('X').map((r) => r[1])).toEqual(['Slack app', 'X', 'id: goldens', 'pull-requests: write', 'node-version: 22']);
  });

  it('say so in the env, as Fix on failure does, when a golden that runs live calls a provider whose key isn’t named', () => {
    // A pack that can't be read, or Vertex AI's token: nothing to name, so a comment says to add the agent's keys,
    // under an env commented out, as GitHub refuses an env that holds nothing.
    expect(alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL', keysUnknown: true })).toContain("    fail-on-divergence: false\n  # env:\n  #   your agent's own provider keys: the goldens that run live call them\n\n- name: Tell Slack");
    // Beside the keys that are known, after them.
    expect(alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL', keys: ['ANTHROPIC_API_KEY'], keysUnknown: true })).toContain(
      "  env:\n    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n    # and your agent's own provider keys: the goldens that run live call them\n\n",
    );
    expect(alertsNeeds('X', { count: 1, why: ['fork'], keys: [], unknown: 1 })[3]).toEqual(['1 golden runs live (fork)', 'their providers’ keys']);
  });

  it('say what they leave out while shadowlap.config.json can’t be read, in the env and an amber needs row', () => {
    const alerts = alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL', unreadable: true });
    expect(alerts).toContain("    fail-on-divergence: false\n  # env:\n  #   shadowlap.config.json can't be read: the keys of the goldens that run live are left out\n\n");
    expect(alerts).not.toContain('  env:');
    expect(alertsNeeds('X', null, true).at(-2)).toEqual(['which goldens run live, and their keys, from shadowlap.config.json', 'can’t be read', 'warn']);
    const fix = fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic', keys: ['ANTHROPIC_API_KEY'], unreadable: true });
    expect(fix.endsWith("    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n    # shadowlap.config.json can't be read: push (Push from CI) and the judges' keys are left out")).toBe(true);
    expect(fix).not.toContain('push:');
    expect(fixOnFailureNeeds('anthropic', null, ['ANTHROPIC_API_KEY'], true)).toContainEqual(['Push from CI and the judges’ keys, from shadowlap.config.json', 'can’t be read', 'warn']);
    // Read, nothing changes.
    expect(alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL', unreadable: false })).toBe(alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' }));
  });

  it('say what fails a golden: the injection gate too, and in amber what can’t be decided, unless it warns', () => {
    const fail = alertFailures('fail');
    expect(fail.map((r) => [r[1], r[2]])).toEqual([
      ['diverged', 'err'],
      ['live call', 'err'],
      ['exit ≠ 0', 'err'],
      ['check failed', 'err'],
      ['injection', 'err'],
      ['inconclusive', 'warn'],
    ]);
    expect(fail.at(-1)![0]).toBe('a gate, a judge or an injection test can’t decide');
    expect(alertFailures()).toEqual(fail);
    // Warn lets them through: they no longer fail a golden.
    expect(alertFailures('warn').map((r) => r[1])).toEqual(['diverged', 'live call', 'exit ≠ 0', 'check failed', 'injection']);
  });

  it('quotes a value YAML would read as something else', () => {
    expect(['goldens/*', 'openai:gpt-5', 'claude-code', './goldens/*'].map(scalar)).toEqual(['goldens/*', 'openai:gpt-5', 'claude-code', './goldens/*']);
    expect(['*', '*/flow', '@g', '-x', 'a: b', "it's", 'key:', '#x'].map(scalar)).toEqual(["'*'", "'*/flow'", "'@g'", "'-x'", "'a: b'", "'it''s'", "'key:'", "'#x'"]);
    expect(alertsYaml({ onlyMain: false, secret: 'X', recordings: '*' })).toContain("    recordings: '*'\n");
  });

  it('previews the message the step posts, as Slack shows it', () => {
    const preview = alertsMessage({ failed: 1, branch: 'main', runUrl: 'https://github.com/acme/agent/actions/runs/42' });
    expect(preview).toEqual({ text: 'Shadowlap: 1 golden(s) failed on main.', link: 'https://github.com/acme/agent/actions/runs/42' });
    // The same words the workflow posts, with GitHub's values filled in.
    const posted = /text: "(.*)"/.exec(alertsYaml({ onlyMain: true, secret: 'X' }))![1]
      .replace('${{ steps.goldens.outputs.failed }}', '1')
      .replace('${{ github.ref_name }}', 'main')
      .replace('${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}', 'https://github.com/acme/agent/actions/runs/42');
    expect(posted).toBe(`${preview.text} ${preview.link}`);
  });

  it('keeps a secret name to what GitHub allows, and says what it needs', () => {
    expect(alertsSecret(' MY-HOOK 2 ')).toBe('MYHOOK2');
    expect(alertsSecret('$$')).toBe('SLACK_WEBHOOK_URL');
    expect(alertsNeeds('OPS_HOOK')[1]).toEqual(['its URL as a repository secret', 'OPS_HOOK']);
  });
});

// A step on a branch runs whatever lands there, in jobs that may hold the job's token and provider keys, and
// one with no version builds the CLI on every run: every step pins the release the packages are at.
describe('the release the steps pin', () => {
  it('is the packages’ version: the action’s tag and the CLI it installs, on every page that shows the step', () => {
    const version = (JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }).version;
    expect(VERSION).toBe(version);
    expect(ACTION).toBe(`devjoinedthechat/shadowlap@v${version}`);
    expect(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic' })).toContain(`  with:\n    version: ${version}\n`);
    expect(alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' })).toContain(`  with:\n    version: ${version}\n`);
    for (const page of ['README.md', 'docs/ci.md', 'packages/cli/README.md']) {
      const text = readFileSync(join(ROOT, page), 'utf8');
      const pins = [...text.matchAll(/devjoinedthechat\/shadowlap@([^\s`'"]+)/g)].map((m) => m[1]);
      expect(pins.length, page).toBeGreaterThan(0);
      expect([...new Set(pins)], page).toEqual([`v${version}`]);
      expect([...new Set([...text.matchAll(/(?<![\w-])version: (\d+\.\d+\.\d+[^\s`]*)/g)].map((m) => m[1]))], page).toEqual([version]);
      // The CLI a step installs itself, as the recipe that keeps a failed replay does.
      const installs = [...text.matchAll(/(?<![\w/-])shadowlap@([^\s`'"]+)/g)].map((m) => m[1]);
      expect(installs.filter((v) => v !== version), page).toEqual([]);
    }
  });
});

describe('the job’s tokens in the steps', () => {
  /** Every step Settings → CI can write, whatever is turned on. */
  const every = () => {
    const out: string[] = [];
    for (const push of [null, 'oidc', 'keys'] as const) {
      for (const repairer of ['claude-code', 'anthropic', 'openai:gpt-5']) {
        out.push(fixOnFailureYaml({ budget: '2.00', repairer, push }), fixOnFailureYaml({ budget: '2.00', repairer, push, keys: ['OPENAI_API_KEY'], unreadable: true }));
        for (const alerts of [null, { onlyMain: true, secret: 'SLACK_WEBHOOK_URL' }]) out.push(workflowYaml({ fix: { budget: '2.00', repairer }, alerts, push }), workflowYaml({ fix: null, alerts, push, liveKeys: ['ANTHROPIC_API_KEY'] }));
      }
    }
    out.push(alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' }), alertsYaml({ onlyMain: false, secret: 'X', keys: ['ANTHROPIC_API_KEY'], keysUnknown: true }));
    return out;
  };

  it('give the job’s token to no step’s env: the action takes it itself, and keeps it from the agent', () => {
    for (const yaml of every()) {
      expect(yaml).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|github\.token/);
      // The agent's keys, the repairer's and R2's are what the env holds.
      for (const line of yaml.split('\n').filter((l) => /^ {4}[A-Z0-9_]+: /.test(l))) expect(line).toMatch(/^ {4}(ANTHROPIC_API_KEY|OPENAI_API_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY): /);
    }
  });

  /** The checkout step's lines under its `- uses:`. */
  const checkoutOf = (yaml: string) => {
    const lines = yaml.split('\n');
    const at = lines.indexOf('- uses: actions/checkout@v7');
    return lines.slice(at + 1, lines.findIndex((l, i) => i > at && l.startsWith('- ')));
  };

  it('check out with the job’s token left off the disk, where the agent would find it', () => {
    for (const yaml of every()) expect(checkoutOf(yaml), yaml).toContain('    persist-credentials: false');
  });

});

describe('docs/ci.md', () => {
  it('shows the same steps the dashboard writes', () => {
    const docs = readFileSync(join(ROOT, 'docs', 'ci.md'), 'utf8');
    expect(docs).toContain(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code' }));
    // With Push from CI on: for a store whose CI signs in with short-lived credentials, and for R2.
    expect(docs).toContain(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'oidc' }));
    expect(docs).toContain(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'keys' }));
    expect(docs).toContain(alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' }));
    expect(docs).toContain(workflowYaml({ fix: { budget: '2.00', repairer: 'claude-code' }, alerts: { onlyMain: true, secret: 'SLACK_WEBHOOK_URL' }, push: 'oidc' }));
    for (const input of inputs) expect(docs, `docs/ci.md lists the input ${input}`).toContain(`| \`${input}\` |`);
  });
});
