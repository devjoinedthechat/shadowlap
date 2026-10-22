import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTION, alertsMessage, alertsNeeds, alertsSecret, alertsYaml, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml, repairerKey, scalar, VERSION } from '../src/ci-yaml.js';

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

describe('the version the steps pin', () => {
  it('is the version of the CLI package, so a version bump moves every step with it', () => {
    expect(VERSION).toBe((JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }).version);
  });
});

describe('the Fix on failure step', () => {
  it('runs the action with fix-on-failure, its budget and repairer, and says what the job needs', () => {
    expect(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code' })).toBe(
      [
        '# the job needs: permissions: { contents: write, pull-requests: write }',
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
    // Short-lived credentials (S3, Cloud Storage, Azure): the two credentials steps store ci prints go
    // before it, and they need id-token; every job pushes, a pull request's to its own folder.
    const oidc = fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'oidc' });
    expect(oidc).toBe(
      [
        '# the job needs: permissions: { contents: write, pull-requests: write, id-token: write }',
        "# and before it, the bucket's credentials: the two if: steps shadowlap store ci prints",
        '- run: npm install -g @anthropic-ai/claude-code',
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
        '    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
        "    # and your agent's own provider keys: blame and verify run it live",
      ].join('\n'),
    );
    // Everything else is as it was: the push lines are added, none changed.
    const added = (yaml: string) => yaml.split('\n').filter((l) => !off.split('\n').includes(l));
    expect(added(oidc)).toEqual(['# the job needs: permissions: { contents: write, pull-requests: write, id-token: write }', "# and before it, the bucket's credentials: the two if: steps shadowlap store ci prints", '    push: true']);
    // Keys in the repository's secrets (R2, which has no OIDC and whose token can't be kept to pr/):
    // only a job that isn't a pull request's gets them, and only it pushes, as store ci has it.
    const keys = fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'keys' });
    expect(keys).toBe(
      [
        '# the job needs: permissions: { contents: write, pull-requests: write }',
        "# and R2 keys as secrets: they can't be kept to pr/, so pull requests don't push",
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
        '    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
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
    expect(fixOnFailureNeeds('claude-code', 'oidc')).toEqual([...fixOnFailureNeeds('claude-code'), ['the bucket’s credentials: two shadowlap store ci steps', 'id-token: write']]);
    expect(fixOnFailureNeeds('anthropic', 'keys')).toEqual([...fixOnFailureNeeds('anthropic'), ['the bucket’s R2 keys as secrets, kept from pull requests’ jobs', 'secrets']]);
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

// A step on a branch runs whatever lands there, in jobs that may hold GH_TOKEN and provider keys, and
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

describe('docs/ci.md', () => {
  it('shows the same steps the dashboard writes', () => {
    const docs = readFileSync(join(ROOT, 'docs', 'ci.md'), 'utf8');
    expect(docs).toContain(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code' }));
    // With Push from CI on: for a store whose CI signs in with short-lived credentials, and for R2.
    expect(docs).toContain(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'oidc' }));
    expect(docs).toContain(fixOnFailureYaml({ budget: '2.00', repairer: 'claude-code', push: 'keys' }));
    expect(docs).toContain(alertsYaml({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' }));
    for (const input of inputs) expect(docs, `docs/ci.md lists the input ${input}`).toContain(`| \`${input}\` |`);
  });
});
