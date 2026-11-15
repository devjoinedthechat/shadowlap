import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_WORKFLOW, NO_WORKFLOW, WorkflowConflictError, WorkflowFileError, diffLines, findWorkflow, parseWorkflow, readWorkflow, readWorkflowFile, scalarValue, splitComment, workflowSteps, workflowVersion, writeWorkflow } from '../src/workflow-file.js';

/** A workflow as Settings → CI writes it, with Fix on failure and Alerts on. */
const FILE = [
  'name: agent',
  '',
  'on:',
  '  push:',
  '    branches: [main]',
  '  pull_request:',
  '  workflow_dispatch:',
  '',
  'permissions:',
  '  contents: write',
  '  pull-requests: write',
  '  actions: write',
  '',
  'jobs:',
  '  goldens:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v7',
  '        with:',
  '          ref: ${{ github.head_ref || github.ref }}',
  '          persist-credentials: false',
  '      - run: npm ci && npm run build   # whatever your agent needs to run',
  '      - uses: devjoinedthechat/shadowlap@v0.1.0',
  '        id: goldens',
  '        with:',
  '          version: 0.1.0',
  "          recordings: 'goldens/* allow'",
  '          comment: false',
  '          fail-on-divergence: false',
  '          inconclusive: warn   # let a young gate through',
  '          fix-on-failure: true',
  '          fix-budget: "5.00"',
  '          repairer: claude-code',
  "          push: ${{ !startsWith(github.event_name, 'pull_request') }}",
  '        env:',
  '          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
  "          # and your agent's own provider keys: blame and verify run it live",
  '',
  '      - name: Tell Slack',
  "        if: steps.goldens.outputs.failed != '0' && github.ref == 'refs/heads/trunk'",
  '        uses: slackapi/slack-github-action@v4',
  '        with:',
  '          webhook: ${{ secrets.TEAM_HOOK }}',
  '          webhook-type: incoming-webhook',
  '          payload: |',
  '            text: "shadowlap: ${{ steps.goldens.outputs.failed }} golden(s) failed"',
  '',
  '      - name: Fail the job',
  "        if: steps.goldens.outputs.failed != '0'",
  '        run: exit 1',
  '',
].join('\n');

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'sl-workflow-'));
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const put = (path: string, text: string) => {
  mkdirSync(join(project, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(project, path), text);
};

describe('readWorkflow', () => {
  it('reads the action step’s inputs, its id and env, and the Slack step’s secret and branch', () => {
    const read = readWorkflow(FILE);
    expect(read.problem).toBeNull();
    expect(read.count).toBe(1);
    expect(read.action).toEqual({
      index: 2,
      job: 'goldens',
      ref: 'v0.1.0',
      id: 'goldens',
      // main's own quoting undone, a comment no part of the value, an expression kept as written
      inputs: { version: '0.1.0', recordings: 'goldens/* allow', comment: 'false', 'fail-on-divergence': 'false', inconclusive: 'warn', 'fix-on-failure': 'true', 'fix-budget': '5.00', repairer: 'claude-code', push: "${{ !startsWith(github.event_name, 'pull_request') }}" },
      env: ['ANTHROPIC_API_KEY'],
      envValues: { ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}' },
    });
    expect(read.slack).toEqual({ secret: 'TEAM_HOOK', branch: 'trunk' });
  });

  it('reads a plain test step, with no Slack step and a commented-out env', () => {
    const text = ['jobs:', '  test:', '    steps:', '    - uses: actions/checkout@v7', '    - uses: "devjoinedthechat/shadowlap@main"', '      with:', '        version: 0.1.0', '      # env:', '      #   ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}'].join('\n');
    const read = readWorkflow(text);
    expect(read.action).toMatchObject({ job: 'test', ref: 'main', id: null, inputs: { version: '0.1.0' }, env: [] });
    expect(read.slack).toBeNull();
  });

  it('reads the Slack step only in the action’s own job, and a Slack step with no branch in its if', () => {
    const text = FILE.replace(" && github.ref == 'refs/heads/trunk'", '');
    expect(readWorkflow(text).slack).toEqual({ secret: 'TEAM_HOOK', branch: null });
    const other = ['jobs:', '  a:', '    steps:', '      - uses: devjoinedthechat/shadowlap@v0.1.0', '  b:', '    steps:', '      - uses: slackapi/slack-github-action@v4'].join('\n');
    expect(readWorkflow(other).slack).toBeNull();
  });

  it('counts every step that uses the action and reads the first', () => {
    const two = FILE.replace('      - name: Fail the job', '      - uses: devjoinedthechat/shadowlap@v0.0.9\n      - name: Fail the job');
    const read = readWorkflow(two);
    expect(read.count).toBe(2);
    expect(read.action?.ref).toBe('v0.1.0');
  });

  it('has no action step in a workflow that never uses it, nor in the repository’s own ./ action', () => {
    expect(readWorkflow('jobs:\n  a:\n    steps:\n      - uses: ./\n').action).toBeNull();
    expect(readWorkflow('').action).toBeNull();
  });

  it('keeps a block of lines from reading as keys, and reads a key in quotes', () => {
    const text = ['"on":', '  push:', 'jobs:', '  a:', '    steps:', '      - run: |', '          echo "uses: devjoinedthechat/shadowlap@v1"', '      - uses: devjoinedthechat/shadowlap@v2'].join('\n');
    const doc = parseWorkflow(text);
    expect(doc.lines[0].key).toBe('on');
    expect(doc.lines[6].kind).toBe('text');
    expect(readWorkflow(doc)).toMatchObject({ count: 1, action: { ref: 'v2' } });
  });

  it.each([
    ['tabs', FILE.replace('        id: goldens', '\t\tid: goldens'), 'indents with tabs, which YAML doesn’t allow'],
    ['braces', FILE.replace(/ {8}with:\n {10}version: 0\.1\.0/, '        with: { version: 0.1.0 }\n        with2:\n          version: 0.1.0'), 'has a shadowlap step whose with: is written on one line in braces or brackets'],
    ['an alias', FILE.replace('          comment: false', '          comment: *off'), 'has a shadowlap step whose with: comment uses a YAML anchor or alias'],
    ['an anchor', FILE.replace('          comment: false', '          comment: &off false'), 'has a shadowlap step whose with: comment uses a YAML anchor or alias'],
    ['a block of lines', FILE.replace("          recordings: 'goldens/* allow'", '          recordings: |\n            goldens/*'), 'has a shadowlap step whose with: recordings is a block of lines (| or >)'],
    ['a value over lines', FILE.replace("          recordings: 'goldens/* allow'", '          recordings: goldens/a\n            goldens/b'), 'has a shadowlap step whose with: holds a value over several lines'],
    ['an env in braces', FILE.replace('        env:\n', '        env: {}\n        env2:\n'), 'has a shadowlap step whose env: is written on one line in braces or brackets'],
  ])('refuses %s, saying why', (_, text, problem) => {
    const read = readWorkflow(text);
    expect(read.problem).toBe(problem);
    expect(read.action).toBeNull();
  });

  it('takes Slack’s payload block, which main writes itself, and a comment indented under an input', () => {
    expect(readWorkflow(FILE.replace('          fix-on-failure: true', '          fix-on-failure: true\n            # deeper')).problem).toBeNull();
  });
});

describe('the line reader', () => {
  it('splits a value from its comment, quotes kept apart', () => {
    expect(splitComment("'a # b' # c")).toEqual({ scalar: "'a # b'", comment: '# c' });
    expect(splitComment('npm ci   # build')).toEqual({ scalar: 'npm ci', comment: '# build' });
    expect(splitComment('a#b')).toEqual({ scalar: 'a#b', comment: '' });
    expect(scalarValue("'it''s'")).toBe("it's");
    expect(scalarValue('"say \\"hi\\""')).toBe('say "hi"');
    expect(scalarValue('${{ secrets.X }}  # the key')).toBe('${{ secrets.X }}');
  });

  it('gives each step the blank and comment lines before it, and keeps a comment indented under a step with it', () => {
    const doc = parseWorkflow(FILE);
    const steps = workflowSteps(doc);
    expect(steps.map((s) => doc.lines[s.dash].raw.trim())).toEqual(['- uses: actions/checkout@v7', '- run: npm ci && npm run build   # whatever your agent needs to run', '- uses: devjoinedthechat/shadowlap@v0.1.0', '- name: Tell Slack', '- name: Fail the job']);
    const action = steps[2];
    // its env's comment is its own; the blank line after it goes with Tell Slack
    expect(doc.lines[action.end - 1].raw).toContain("# and your agent's own provider keys");
    expect(steps[3].start).toBe(action.end);
    expect(doc.lines[steps[3].start].kind).toBe('blank');
    expect(Object.keys(action.keys)).toEqual(['uses', 'id', 'with', 'env']);
  });

  it('keeps the line endings and whether the text ends with one', () => {
    const doc = parseWorkflow('a: 1\r\nb: 2\r\n');
    expect(doc.eol).toBe('\r\n');
    expect(doc.finalNewline).toBe(true);
    expect(doc.lines.map((l) => l.key)).toEqual(['a', 'b']);
    expect(parseWorkflow('a: 1').finalNewline).toBe(false);
  });
});

describe('diffLines', () => {
  it('finds nothing to change in the same text, its last newline and line endings aside', () => {
    const d = diffLines(FILE, FILE.replace(/\n/g, '\r\n').replace(/\r\n$/, ''));
    expect(d).toMatchObject({ added: 0, removed: 0 });
    expect(d.lines.every((l) => l.op === ' ')).toBe(true);
  });

  it('diffs a missing file as every line added', () => {
    const d = diffLines('', 'a\nb\n');
    expect(d).toEqual({ lines: [{ op: '+', text: 'a' }, { op: '+', text: 'b' }], added: 2, removed: 0 });
  });

  it('marks an added input, and takes a line out before the one that replaces it', () => {
    const after = FILE.replace('          comment: false\n', '').replace('fix-budget: "5.00"', 'fix-budget: 2.00').replace('          repairer: claude-code', '          repairer: claude-code\n          push: true');
    const d = diffLines(FILE, after);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(2);
    const changed = d.lines.filter((l) => l.op !== ' ');
    expect(changed).toEqual([
      { op: '-', text: '          comment: false' },
      { op: '-', text: '          fix-budget: "5.00"' },
      { op: '+', text: '          fix-budget: 2.00' },
      { op: '+', text: '          push: true' },
    ]);
  });

  it('shows a moved line as taken out and added', () => {
    const d = diffLines('a\nb\nc', 'b\nc\na');
    expect(d).toEqual({ lines: [{ op: '-', text: 'a' }, { op: ' ', text: 'b' }, { op: ' ', text: 'c' }, { op: '+', text: 'a' }], added: 1, removed: 1 });
  });
});

describe('findWorkflow', () => {
  it('reads agent.yml, or names it as absent where a write puts it', () => {
    expect(findWorkflow(project)).toEqual({ path: AGENT_WORKFLOW, exists: false, version: NO_WORKFLOW, text: '', problem: null });
    put(AGENT_WORKFLOW, FILE);
    const found = findWorkflow(project);
    expect(found).toMatchObject({ path: AGENT_WORKFLOW, exists: true, text: FILE, problem: null });
    expect(found.version).toBe(workflowVersion(FILE));
  });

  it('finds another workflow that uses the action, by name, when there is no agent.yml', () => {
    put('.github/workflows/a-lint.yml', 'jobs:\n  a:\n    steps:\n      - run: npm run lint\n');
    put('.github/workflows/tests.yaml', FILE);
    put('.github/workflows/z.yml', FILE);
    expect(findWorkflow(project).path).toBe('.github/workflows/tests.yaml');
  });

  it('says why a file can’t be read: too big, or a link out of the project', () => {
    put(AGENT_WORKFLOW, `# ${'x'.repeat(300 * 1024)}\n`);
    expect(findWorkflow(project)).toMatchObject({ exists: true, text: '', problem: 'is 301 KB, more than the 256 KB Settings reads' });
    rmSync(join(project, AGENT_WORKFLOW));
    const outside = mkdtempSync(join(tmpdir(), 'sl-outside-'));
    try {
      writeFileSync(join(outside, 'agent.yml'), FILE);
      symlinkSync(join(outside, 'agent.yml'), join(project, AGENT_WORKFLOW));
      expect(readWorkflowFile(project, AGENT_WORKFLOW)).toMatchObject({ exists: true, text: '', problem: 'leads out of the project folder' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('writeWorkflow', () => {
  const left = () => readdirSync(join(project, '.github', 'workflows')).sort();

  it('makes .github/workflows/ for a new file and leaves only the file there', () => {
    const { version } = writeWorkflow(project, AGENT_WORKFLOW, FILE, { expect: NO_WORKFLOW });
    expect(readFileSync(join(project, AGENT_WORKFLOW), 'utf8')).toBe(FILE);
    expect(version).toBe(workflowVersion(FILE));
    expect(left()).toEqual(['agent.yml']);
    expect(statSync(join(project, AGENT_WORKFLOW)).mode & 0o777).toBe(0o644);
  });

  it('replaces a file read at its version, keeping its mode, and refuses one changed since', () => {
    put(AGENT_WORKFLOW, 'old\n');
    chmodSync(join(project, AGENT_WORKFLOW), 0o664);
    const read = findWorkflow(project);
    writeWorkflow(project, AGENT_WORKFLOW, FILE, { expect: read.version });
    expect(statSync(join(project, AGENT_WORKFLOW)).mode & 0o777).toBe(0o664);
    // the page still shows the old file: its write changes nothing
    expect(() => writeWorkflow(project, AGENT_WORKFLOW, 'new\n', { expect: read.version })).toThrow(WorkflowConflictError);
    expect(() => writeWorkflow(project, AGENT_WORKFLOW, 'new\n', { expect: read.version })).toThrow(`${AGENT_WORKFLOW} changed since it was read`);
    expect(readFileSync(join(project, AGENT_WORKFLOW), 'utf8')).toBe(FILE);
    expect(left()).toEqual(['agent.yml']);
  });

  it('refuses a file that appeared since an absent read', () => {
    put(AGENT_WORKFLOW, 'theirs\n');
    expect(() => writeWorkflow(project, AGENT_WORKFLOW, FILE, { expect: NO_WORKFLOW })).toThrow(WorkflowConflictError);
    expect(readFileSync(join(project, AGENT_WORKFLOW), 'utf8')).toBe('theirs\n');
  });

  it('removes the file it made, for an Undo, only at the version it wrote', () => {
    const { version } = writeWorkflow(project, AGENT_WORKFLOW, FILE, { expect: NO_WORKFLOW });
    expect(() => writeWorkflow(project, AGENT_WORKFLOW, null, { expect: NO_WORKFLOW })).toThrow(WorkflowConflictError);
    expect(writeWorkflow(project, AGENT_WORKFLOW, null, { expect: version })).toEqual({ version: NO_WORKFLOW });
    expect(existsSync(join(project, AGENT_WORKFLOW))).toBe(false);
  });

  it('refuses a link out of the project, a folder that leads out, and a path outside .github/workflows/', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sl-outside-'));
    try {
      writeFileSync(join(outside, 'agent.yml'), 'theirs\n');
      mkdirSync(join(project, '.github', 'workflows'), { recursive: true });
      symlinkSync(join(outside, 'agent.yml'), join(project, AGENT_WORKFLOW));
      expect(() => writeWorkflow(project, AGENT_WORKFLOW, FILE, { expect: workflowVersion('theirs\n') })).toThrow(WorkflowFileError);
      expect(readFileSync(join(outside, 'agent.yml'), 'utf8')).toBe('theirs\n');
      rmSync(join(project, '.github'), { recursive: true });
      symlinkSync(outside, join(project, '.github'));
      expect(() => writeWorkflow(project, AGENT_WORKFLOW, FILE, { expect: NO_WORKFLOW })).toThrow('leads out of the project folder');
      expect(readdirSync(outside)).toEqual(['agent.yml']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(() => writeWorkflow(project, '../agent.yml', FILE, { expect: NO_WORKFLOW })).toThrow(WorkflowFileError);
    expect(() => writeWorkflow(project, '.github/agent.yml', FILE, { expect: NO_WORKFLOW })).toThrow('is not a workflow file in .github/workflows/');
  });

  it('writes through a link that stays inside the project', () => {
    mkdirSync(join(project, 'ci'));
    writeFileSync(join(project, 'ci', 'agent.yml'), 'old\n');
    mkdirSync(join(project, '.github', 'workflows'), { recursive: true });
    symlinkSync(join(project, 'ci', 'agent.yml'), join(project, AGENT_WORKFLOW));
    writeWorkflow(project, AGENT_WORKFLOW, FILE, { expect: workflowVersion('old\n') });
    expect(readFileSync(join(project, 'ci', 'agent.yml'), 'utf8')).toBe(FILE);
    expect(readdirSync(join(project, 'ci'))).toEqual(['agent.yml']);
  });
});
