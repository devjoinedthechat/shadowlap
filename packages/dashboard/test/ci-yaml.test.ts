import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTION, alertsNeeds, alertsSecret, alertsYaml, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml, repairerKey, scalar } from '../src/ci-yaml.js';

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
      ['permission to push a branch', 'contents: write'],
      ['permission to open the pull request', 'pull-requests: write'],
    ]);
    expect(fixOnFailureNever('1.00').map((x) => x[1])).toEqual(['divergence', 'rejected', '$1.00', 'merge']);
  });

  it('passes only inputs the action has', () => {
    expect(withKeys(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic' }))).toEqual(['recordings', 'fix-on-failure', 'fix-budget', 'repairer']);
    for (const key of withKeys(fixOnFailureYaml({ budget: '2.00', repairer: 'anthropic' }))) expect(inputs).toContain(key);
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
    expect(docs).toContain(alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' }));
    for (const input of inputs) expect(docs, `docs/ci.md lists the input ${input}`).toContain(`| \`${input}\` |`);
  });
});
