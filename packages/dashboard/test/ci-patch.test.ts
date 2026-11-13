import { diffLines, readWorkflow } from '@shadowlap/engine';
import { ciStep, parseStoreUrl } from '@shadowlap/remote';
import { describe, expect, it } from 'vitest';
import { patchWorkflow } from '../src/ci-patch.js';
import { VERSION, workflowFile, type WorkflowFileSettings } from '../src/ci-yaml.js';

const credentials = ciStep('github', parseStoreUrl('s3://team-runs/support-agent?region=eu-west-1'), { version: VERSION }).credentials!;

/** Each switch and what the config gives, in turn: enough settings to cross every owned block with every other. */
const SETTINGS: Array<[string, WorkflowFileSettings]> = [
  ['plain', { fix: null, alerts: null }],
  ['comment off', { fix: null, alerts: null, comment: false }],
  ['decisions', { fix: null, alerts: null, decisions: true, keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], liveKeys: ['ANTHROPIC_API_KEY'] }],
  ['decisions with fix and alerts', { fix: { budget: '2.00', repairer: 'claude-code' }, alerts: { onlyMain: true, secret: 'SLACK_WEBHOOK_URL', branch: 'main' }, decisions: true, keys: ['OPENAI_API_KEY'], keysUnknown: true }],
  ['fix', { fix: { budget: '2.00', repairer: 'claude-code' }, alerts: null, keys: ['ANTHROPIC_API_KEY'] }],
  ['fix, openai, keys unknown', { fix: { budget: '5.00', repairer: 'openai:gpt-5' }, alerts: null, keys: ['ANTHROPIC_API_KEY'], keysUnknown: true }],
  ['alerts', { fix: null, alerts: { onlyMain: true, secret: 'SLACK_WEBHOOK_URL', branch: 'main' } }],
  ['alerts for every branch, warn', { fix: null, alerts: { onlyMain: false, secret: 'TEAM_HOOK', branch: 'main' }, inconclusive: 'warn' }],
  ['fix and alerts', { fix: { budget: '1.00', repairer: 'anthropic' }, alerts: { onlyMain: true, secret: 'SLACK_WEBHOOK_URL', branch: 'main' }, keys: ['OPENAI_API_KEY'] }],
  ['push oidc', { fix: null, alerts: null, push: 'oidc', credentials }],
  ['push oidc with fix', { fix: { budget: '2.00', repairer: 'claude-code' }, alerts: null, push: 'oidc', credentials, keys: ['ANTHROPIC_API_KEY'] }],
  ['push r2', { fix: null, alerts: { onlyMain: true, secret: 'SLACK_WEBHOOK_URL', branch: 'main' }, push: 'keys' }],
  ['live goldens', { fix: null, alerts: null, liveKeys: ['GEMINI_API_KEY'], liveKeysUnknown: true }],
  ['unreadable', { fix: null, alerts: null, liveKeysUnknown: true, unreadable: true, comment: false }],
];

const patched = (file: string, base: WorkflowFileSettings, want: WorkflowFileSettings) => {
  const out = patchWorkflow(file, workflowFile(base), workflowFile(want));
  if ('problem' in out) throw new Error(out.problem);
  return out.text;
};

describe('patchWorkflow', () => {
  it.each(SETTINGS)('changes nothing in a file just written for the same switches (%s)', (_, s) => {
    expect(patched(workflowFile(s), s, s)).toBe(workflowFile(s));
  });

  it('turns any file the switches wrote into the one they build now, for every pair of settings', () => {
    // Exactly, but for keys both kept in their place: an env key already there keeps its line.
    const moved = (out: string, want: string) => {
      const d = diffLines(out, want).lines;
      const of = (op: string) => d.filter((l) => l.op === op).map((l) => l.text).sort();
      return of('-').join('\n') === of('+').join('\n');
    };
    for (const [from, a] of SETTINGS) for (const [to, b] of SETTINGS) expect(`${from} → ${to}: ${moved(patched(workflowFile(a), a, b), workflowFile(b))}`).toBe(`${from} → ${to}: true`);
    expect(patched(workflowFile(SETTINGS[0][1]), SETTINGS[0][1], SETTINGS[6][1])).toBe(workflowFile(SETTINGS[6][1]));
  });

  it('keeps the person’s own lines: their build, inputs, env, steps, jobs and filled-in role ARNs', () => {
    const a: WorkflowFileSettings = { fix: null, alerts: null, push: 'oidc', credentials };
    const theirs = workflowFile(a)
      .replace('npm ci && npm run build   # whatever your agent needs to run', 'pnpm install && pnpm build')
      .replace(/<account-id>/g, '123456789012')
      .replace('          recordings: goldens/*\n', '          recordings: goldens/*\n          keep-history: true\n          working-directory: agent\n')
      .replace('        env:\n', '        env:\n          MY_TOKEN: ${{ secrets.MY_TOKEN }}\n')
      .concat('      - uses: actions/upload-artifact@v5\n        with:\n          path: report.json\n\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n');
    const withEnv = theirs.includes('MY_TOKEN') ? theirs : theirs.replace('          push: true\n', '          push: true\n        env:\n          MY_TOKEN: ${{ secrets.MY_TOKEN }}\n');
    const b: WorkflowFileSettings = { ...a, fix: { budget: '2.00', repairer: 'claude-code' }, alerts: { onlyMain: true, secret: 'SLACK_WEBHOOK_URL', branch: 'main' }, keys: ['ANTHROPIC_API_KEY'] };
    const out = patched(withEnv, a, b);
    for (const own of ['pnpm install && pnpm build', 'arn:aws:iam::123456789012:role/shadowlap-ci', 'keep-history: true', 'working-directory: agent', 'MY_TOKEN: ${{ secrets.MY_TOKEN }}', 'actions/upload-artifact@v5', '  lint:', 'npm run lint']) expect(out).toContain(own);
    // and the switches' lines are there: what a fix and Slack need
    for (const theirsNow of ['  workflow_dispatch:', '  actions: write', 'fix-on-failure: true', 'npm install -g @anthropic-ai/claude-code', '- name: Tell Slack', '- name: Fail the job']) expect(out).toContain(theirsNow);
    // nothing of theirs was taken out
    expect(diffLines(withEnv, out).lines.filter((l) => l.op === '-').map((l) => l.text)).toEqual(['  contents: read', '          persist-credentials: false'].filter((t) => !out.includes(t)));
    // turned back, the file is theirs again
    expect(patched(out, b, a)).toBe(withEnv);
  });

  it('writes an input already there with its line kept, and leaves the inputs it doesn’t write', () => {
    const a: WorkflowFileSettings = { fix: null, alerts: null };
    const theirs = workflowFile(a).replace('          recordings: goldens/*\n', '          recordings: goldens/* # every golden\n          comment: true\n');
    const out = patched(theirs, a, { ...a, comment: false });
    expect(out).toContain('          recordings: goldens/* # every golden\n          comment: false\n');
    expect(patched(theirs, a, a)).toBe(theirs);
  });

  it('patches a file with its own indentation and compact steps', () => {
    const text = ['name: ci', 'on:', '    pull_request:', 'jobs:', '    test:', '        runs-on: ubuntu-latest', '        steps:', '        - uses: actions/checkout@v7', '        - uses: devjoinedthechat/shadowlap@v0.0.9', '          with:', '              version: 0.0.9', ''].join('\n');
    const out = patched(text, { fix: null, alerts: null }, { fix: { budget: '2.00', repairer: 'anthropic' }, alerts: null });
    expect(out).toContain('    pull_request:\n    workflow_dispatch:\n');
    expect(out).toContain('        - uses: actions/checkout@v7\n          with:\n            ref: ${{');
    expect(out).toContain(`        - uses: devjoinedthechat/shadowlap@v${VERSION}\n          id: goldens\n          with:\n              version: ${VERSION}\n              recordings: goldens/*\n              fix-on-failure: true`);
    // The file sets no permissions: its job gets the ones the switches need, at its own indent.
    expect(out).toContain('    test:\n        permissions:\n          contents: write\n          pull-requests: write\n          actions: write\n        runs-on: ubuntu-latest\n');
    expect(readWorkflow(out)).toMatchObject({ problem: null, count: 1, action: { id: 'goldens', inputs: { 'fix-on-failure': 'true', repairer: 'anthropic' } } });
  });

  it('gives the action’s job the permissions the switches need when the file sets none, so its other jobs keep their token', () => {
    const release = '  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n';
    const text = ['name: ci', 'on:', '  pull_request:', 'jobs:', '  test:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v7', '      - uses: devjoinedthechat/shadowlap@v0.0.9', '        with:', '          version: 0.0.9', ''].join('\n') + release;
    const plain: WorkflowFileSettings = { fix: null, alerts: null };
    const fix: WorkflowFileSettings = { fix: { budget: '2.00', repairer: 'anthropic' }, alerts: null };
    const out = patched(text, plain, fix);
    expect(out).toContain('  test:\n    permissions:\n      contents: write\n      pull-requests: write\n      actions: write\n    runs-on: ubuntu-latest\n');
    // None for the whole file, and the release job as it was.
    expect(out).not.toMatch(/^permissions:/m);
    expect(out.endsWith(release)).toBe(true);
    // Read back, the job's block is the switches': set in place, the other job still left alone.
    const back = patched(out, fix, plain);
    expect(back).toContain('  test:\n    permissions:\n      contents: read\n      pull-requests: write\n    runs-on: ubuntu-latest\n');
    expect(back).not.toMatch(/^permissions:/m);
    expect(back.endsWith(release)).toBe(true);
  });

  describe('with permissions set for the whole file and a second job', () => {
    const block = 'permissions: # least privilege\n  contents: read\n  # for the cloud login\n  id-token: write\n';
    const release = '  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n';
    const file = (permissions: string) =>
      ['name: ci', 'on:', '  pull_request:', ''].join('\n') + permissions + ['jobs:', '  test:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v7', `      - uses: devjoinedthechat/shadowlap@v${VERSION}`, '        id: goldens', '        with:', `          version: ${VERSION}`, '          recordings: goldens/*', '          comment: false', ''].join('\n') + release;
    const off: WorkflowFileSettings = { fix: null, alerts: null, comment: false };
    const on: WorkflowFileSettings = { fix: null, alerts: null };

    it('gives the action’s job a copy of the file’s block, every key, value and comment, with the switches’ keys in, and leaves the file’s and the other job as they were', () => {
      const out = patched(file(block), off, on);
      // A job's block takes the file's place for it: both of the file's scopes, with the comment's pull-requests: write.
      expect(out).toContain('  test:\n    permissions: # least privilege\n      contents: read\n      pull-requests: write\n      # for the cloud login\n      id-token: write\n    runs-on: ubuntu-latest\n');
      expect(out).toContain(`\n${block}jobs:\n`);
      expect(out.endsWith(release)).toBe(true);
      expect(out).not.toContain('comment: false');
      // Fix on failure's keys go in the job's block, now its own: patched in place, the file's still as it was.
      const fix = patched(out, on, { ...on, fix: { budget: '2.00', repairer: 'anthropic' } });
      expect(fix).toContain('  test:\n    permissions: # least privilege\n      contents: write\n      pull-requests: write\n      actions: write\n      # for the cloud login\n      id-token: write\n    runs-on: ubuntu-latest\n');
      expect(fix).toContain(`\n${block}jobs:\n`);
      expect(fix.endsWith(release)).toBe(true);
      // Turned back, the job's block says just what the file's does, so it goes: the file is as it was.
      expect(patched(out, on, off)).toBe(file(block));
    });

    it('gives the job no block while the file’s already holds what the switches need', () => {
      const enough = block.replace('  contents: read\n', '  contents: read\n  pull-requests: write\n');
      const theirs = file(enough).replace('          comment: false\n', '');
      expect(patched(file(enough), off, on)).toBe(theirs);
      // So it reads as the workflow the switches build.
      expect(patched(theirs, on, on)).toBe(theirs);
    });

    it.each(['read-all', '{}'])('offers Copy for a file whose permissions are %s on one line', (value) => {
      expect(patchWorkflow(file(`permissions: ${value}\n`), workflowFile(off), workflowFile(on))).toEqual({ problem: 'sets its permissions on one line, so the ones the switches need can’t be added' });
    });

    it('needs nothing under a file’s permissions: write-all', () => {
      expect(patched(file('permissions: write-all\n'), off, on)).toBe(file('permissions: write-all\n').replace('          comment: false\n', ''));
    });
  });

  it('keeps a checkout ref of the person’s own and a workflow_dispatch with inputs', () => {
    const text = workflowFile({ fix: null, alerts: null }).replace('          persist-credentials: false', '          ref: release\n          persist-credentials: false').replace('  pull_request:\n', '  pull_request:\n  workflow_dispatch:\n    inputs:\n      why:\n        type: string\n');
    const fix: WorkflowFileSettings = { fix: { budget: '2.00', repairer: 'anthropic' }, alerts: null };
    const on = patched(text, { fix: null, alerts: null }, fix);
    expect(on).toContain('      why:');
    expect(patched(on, fix, { fix: null, alerts: null })).toContain('  workflow_dispatch:\n    inputs:');
  });

  it.each([
    ['two action steps', (t: string) => t.replace('      - name: Tell Slack', '      - uses: devjoinedthechat/shadowlap@v0.0.9\n\n      - name: Tell Slack'), 'has 2 steps that use the Shadowlap action, so Write file can’t tell which one the switches are for'],
    ['no action step', (t: string) => t.replace(/devjoinedthechat\/shadowlap@v[\d.]+/, 'someone/else@v1'), 'has no step that uses the Shadowlap action'],
    ['triggers on one line', (t: string) => t.replace(/on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n/, 'on: [push, pull_request]\n'), 'names its triggers on one line, so workflow_dispatch: can’t be added to them'],
    ['permissions on one line', (t: string) => t.replace(/permissions:\n( {2}.*\n)+/, 'permissions: read-all\n'), 'sets its permissions on one line, so the ones the switches need can’t be added'],
    ['tabs', (t: string) => t.replace('        id: goldens', '\tid: goldens'), 'indents with tabs, which YAML doesn’t allow'],
  ])('says why it can’t patch a file with %s', (_, edit, problem) => {
    const alerts: WorkflowFileSettings = { fix: null, alerts: { onlyMain: true, secret: 'SLACK_WEBHOOK_URL', branch: 'main' } };
    const fix: WorkflowFileSettings = { ...alerts, fix: { budget: '2.00', repairer: 'anthropic' } };
    expect(patchWorkflow(edit(workflowFile(alerts)), workflowFile(alerts), workflowFile(fix))).toEqual({ problem });
  });

  it('takes a file whose triggers are on one line while no switch needs workflow_dispatch:', () => {
    const s: WorkflowFileSettings = { fix: null, alerts: null };
    const text = workflowFile(s).replace(/on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n/, 'on: [push, pull_request]\n');
    expect(patched(text, s, { ...s, comment: false })).toContain('          comment: false\n');
  });
});

describe('workflowFile', () => {
  it('is a whole workflow: its triggers, the permissions the parts need, then one job of the steps', () => {
    const text = workflowFile({ fix: { budget: '2.00', repairer: 'claude-code' }, alerts: { onlyMain: true, secret: 'SLACK_WEBHOOK_URL', branch: 'trunk' }, push: 'oidc', credentials, branch: 'trunk', keys: ['ANTHROPIC_API_KEY'] });
    expect(text.startsWith('name: agent\non:\n  push:\n    branches: [trunk]\n  pull_request:\n  workflow_dispatch:\n\npermissions:\n  contents: write\n  pull-requests: write\n  actions: write\n  id-token: write\n\njobs:\n  goldens:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n')).toBe(true);
    expect(text.endsWith("        run: exit 1\n")).toBe(true);
    // the bucket's sign-in steps where the comment stood, the writer's and a pull request's own
    expect(text).not.toContain('# here, the bucket');
    expect(text).toContain("      - if: ${{ !startsWith(github.event_name, 'pull_request') }}\n        uses: aws-actions/configure-aws-credentials@v6\n");
    expect(text).toContain("      # a pull request's own credentials, which write only under pr/; a fork's job gets none\n");
    expect(text).toContain("      - name: Tell Slack\n        if: steps.goldens.outputs.failed != '0' && github.ref == 'refs/heads/trunk'\n");
    expect(readWorkflow(text)).toMatchObject({ problem: null, count: 1, action: { id: 'goldens', inputs: { version: VERSION, 'fix-on-failure': 'true', push: 'true' } }, slack: { secret: 'SLACK_WEBHOOK_URL', branch: 'trunk' } });
  });

  it('keeps no comment on a pull request when the comment is off, and asks no permission for it', () => {
    const text = workflowFile({ fix: null, alerts: null, comment: false, recordings: 'goldens/* allow' });
    expect(text).toContain("          recordings: 'goldens/* allow'\n          comment: false\n");
    expect(text).toContain('permissions:\n  contents: read\n\njobs:');
    // a fix's pull request needs it whatever the comment does
    expect(workflowFile({ fix: { budget: '2.00', repairer: 'anthropic' }, alerts: null, comment: false })).toContain('  contents: write\n  pull-requests: write\n  actions: write\n');
  });

  it('says where R2’s keys stop under the permissions, and pushes only from your branches', () => {
    const text = workflowFile({ fix: null, alerts: null, push: 'keys' });
    expect(text).toContain("permissions:\n  contents: read\n  pull-requests: write\n  # and R2 keys as secrets: they can't be kept to pr/, so pull requests don't push\n\njobs:");
    expect(text).toContain("          push: ${{ !startsWith(github.event_name, 'pull_request') }}\n        env:\n          R2_ACCESS_KEY_ID:");
  });
});
