import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTION, alertsMessage, alertsNeeds, alertsSecret, alertsYaml, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml, repairerKey, scalar } from '../src/ci-yaml.js';

/** The workflow steps behind Settings → CI, checked against the action they use and the docs that show them. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const actionYml = readFileSync(join(ROOT, 'action.yml'), 'utf8');
const keysOf = (from: string, to: string) => [...actionYml.slice(actionYml.indexOf(`\n${from}:`), actionYml.indexOf(`\n${to}:`)).matchAll(/^ {2}([a-z-]+):/gm)].map((m) => m[1]!);
const inputs = keysOf('inputs', 'outputs');
const outputs = keysOf('outputs', 'runs');
/** The keys a generated step passes under `with:` to this repository's action. */
const withKeys = (yaml: string) => {
  const step = yaml.slice(yaml.indexOf(`uses: ${ACTION}`));
  const keys: string[] = [];
  for (const line of step.slice(step.indexOf('  with:\n') + '  with:\n'.length).split('\n')) {
    const m = /^ {4}([a-z-]+):/.exec(line);
    if (!m) break;
    keys.push(m[1]!);
  }
  return keys;
};

describe('the Fix on failure step', () => {
  it('runs the action with fix-on-failure, its budget and repairer, and says what the job needs', () => {
    expect(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code' })).toBe(
      [
        '# the job needs: permissions: { contents: write, pull-requests: write }',
        '- run: npm install -g @anthropic-ai/claude-code',
        '- uses: devjoinedthechat/shadowlap@main',
        '  with:',
        '    recordings: goldens/*',
        '    fix-on-failure: true',
        '    fix-budget: 2.00',
        '    repairer: claude-code',
        '  env:',
        '    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
        '    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
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
      ['permission to open the pull request', 'pull-requests: write'],
    ]);
    expect(fixOnFailureNever('1.00').map((x) => x[1])).toEqual(['divergence', 'rejected', '$1.00', 'merge']);
  });

  it('pushes too when Push from CI is on, saying the job needs the bucket’s credentials; off, it is the step it was', () => {
    const off = fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code' });
    // Off is the step before push existed, byte for byte, left out or said.
    expect(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: null })).toBe(off);
    // Short-lived credentials (S3, Cloud Storage, Azure): the steps store ci prints go first, and they need id-token.
    const oidc = fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'oidc' });
    expect(oidc).toBe(
      [
        '# the job needs: permissions: { contents: write, pull-requests: write, id-token: write }',
        "# and the bucket's credentials first: the steps shadowlap store ci prints",
        '- run: npm install -g @anthropic-ai/claude-code',
        '- uses: devjoinedthechat/shadowlap@main',
        '  with:',
        '    recordings: goldens/*',
        '    fix-on-failure: true',
        '    fix-budget: 2.00',
        '    repairer: claude-code',
        '    push: true',
        '  env:',
        '    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
        '    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
        "    # and your agent's own provider keys: blame and verify run it live",
      ].join('\n'),
    );
    // Everything else is as it was: the push lines are added, none changed.
    const added = oidc.split('\n').filter((l) => !off.split('\n').includes(l));
    expect(added).toEqual(['# the job needs: permissions: { contents: write, pull-requests: write, id-token: write }', "# and the bucket's credentials first: the steps shadowlap store ci prints", '    push: true']);
    // Keys in the repository's secrets (R2, which has no OIDC): no id-token, and they go in the step's env.
    const keys = fixOnFailureYaml({ budget: '5', repairer: 'openai:gpt-5', push: 'keys' });
    expect(keys.split('\n').slice(0, 2)).toEqual(['# the job needs: permissions: { contents: write, pull-requests: write }', "# and the bucket's keys in this step's env: shadowlap store ci prints them"]);
    expect(keys).toContain('    repairer: openai:gpt-5\n    push: true\n  env:\n    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}\n');
    // What it needs names the bucket's credentials, after what the step needs without push.
    expect(fixOnFailureNeeds('claude-code', 'oidc')).toEqual([...fixOnFailureNeeds('claude-code'), ['the bucket’s credentials, from shadowlap store ci', 'id-token: write']]);
    expect(fixOnFailureNeeds('anthropic', 'keys').at(-1)).toEqual(['the bucket’s keys, from shadowlap store ci', 'secrets']);
    expect(fixOnFailureNeeds('anthropic', null)).toEqual(fixOnFailureNeeds('anthropic'));
  });

  it('passes only inputs the action has', () => {
    expect(withKeys(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic' }))).toEqual(['recordings', 'fix-on-failure', 'fix-budget', 'repairer']);
    expect(withKeys(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic', push: 'oidc' }))).toEqual(['recordings', 'fix-on-failure', 'fix-budget', 'repairer', 'push']);
    for (const push of [null, 'oidc', 'keys'] as const) for (const key of withKeys(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic', push }))) expect(inputs).toContain(key);
    expect(outputs).toEqual(expect.arrayContaining(['passed', 'failed', 'diverged', 'checks-failed', 'session', 'fixes', 'fix-prs']));
  });
});

describe('the Alerts steps', () => {
  it('post the failed count to Slack, only for main when asked, then fail the job', () => {
    const yaml = alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' });
    expect(yaml).toContain("  if: steps.goldens.outputs.failed != '0' && github.ref == 'refs/heads/main'\n  uses: slackapi/slack-github-action@v2");
    expect(yaml).toContain('    recordings: goldens/*\n    fail-on-divergence: false\n');
    expect(yaml).toContain('    webhook: ${{ secrets.SLACK_WEBHOOK_URL }}\n    webhook-type: incoming-webhook\n');
    expect(yaml.trimEnd().endsWith("- name: Fail the job\n  if: steps.goldens.outputs.failed != '0'\n  run: exit 1")).toBe(true);
    const everywhere = alertsYaml({ onlyMain: false, secret: 'team-hook!' });
    expect(everywhere).not.toContain('github.ref ==');
    expect(everywhere).toContain('${{ secrets.teamhook }}');
    for (const key of withKeys(yaml)) expect(inputs).toContain(key);
    expect(yaml).toContain('steps.goldens.outputs.failed');
    expect(outputs).toContain('failed');
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
    const posted = /text: "(.*)"/.exec(alertsYaml({ onlyMain: true, secret: 'X' }))![1]!
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

describe('docs/ci.md', () => {
  it('shows the same steps the dashboard writes', () => {
    const docs = readFileSync(join(ROOT, 'docs', 'ci.md'), 'utf8');
    expect(docs).toContain(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code' }));
    // With Push from CI on, for a store whose CI signs in with short-lived credentials.
    expect(docs).toContain(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'oidc' }));
    expect(docs).toContain(alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' }));
    for (const input of inputs) expect(docs, `docs/ci.md lists the input ${input}`).toContain(`| \`${input}\` |`);
  });
});
