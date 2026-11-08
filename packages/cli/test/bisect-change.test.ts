import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTests } from '@shadowlap/engine';
import { commitChange, hunkOf, MAX_HUNK_BYTES, MAX_HUNK_LINES, pickFile, type ChangeScope } from '../src/bisect-change.js';
import { physicalPath } from '../src/real-path.js';

/** The first bad commit's change, as `shadowlap bisect` keeps it with its answer (E27). */
describe("the first bad commit's hunk", () => {
  it('counts the line to open in the new file: deleted lines before the first addition never move it', () => {
    const diff = ['diff --git a/agent.mjs b/agent.mjs', 'index 1..2 100644', '--- a/agent.mjs', '+++ b/agent.mjs', '@@ -10,6 +10,5 @@ export function run() {', ' const a = 1;', '-const b = 2;', '-const c = 3;', ' const d = 4;', '+const e = 5;', ' return a;', ''].join('\n');
    expect(hunkOf(diff)).toEqual({ hunk: diff.split('\n').slice(4, -1).join('\n'), line: 12, cut: false });
  });

  it('opens the second hunk where the first only deletes, and the start of a hunk that adds nothing', () => {
    const two = ['@@ -1,3 +1,2 @@', ' a', '-b', ' c', '@@ -20,2 +19,3 @@', ' t', '+u', ' v'].join('\n');
    expect(hunkOf(two).line).toBe(20);
    expect(hunkOf(['@@ -5,2 +4,0 @@', '-x', '-y'].join('\n')).line).toBe(4);
    expect(hunkOf(['@@ -1,2 +0,0 @@', '-x', '-y'].join('\n')).line).toBe(1);
  });

  it('keeps no hunk for a deleted or binary file', () => {
    expect(hunkOf(['diff --git a/x b/x', 'deleted file mode 100644', 'index 1..0', '--- a/x', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone'].join('\n'))).toEqual({ hunk: null, line: null, cut: false });
    expect(hunkOf(['diff --git a/logo.png b/logo.png', 'index 1..2 100644', 'Binary files a/logo.png and b/logo.png differ'].join('\n'))).toEqual({ hunk: null, line: null, cut: false });
  });

  it('cuts a long hunk at a line, to its bounds, and says so', () => {
    const long = ['@@ -1,0 +1,200 @@', ...Array.from({ length: 200 }, (_, i) => `+line ${i}`)].join('\n');
    const kept = hunkOf(long);
    expect(kept).toMatchObject({ line: 1, cut: true });
    expect(kept.hunk!.split('\n')).toHaveLength(MAX_HUNK_LINES);
    const wide = ['@@ -1,0 +1,3 @@', `+${'x'.repeat(3000)}`, `+${'y'.repeat(3000)}`, '+z'].join('\n');
    const cut = hunkOf(wide);
    expect(cut.cut).toBe(true);
    expect(Buffer.byteLength(cut.hunk!)).toBeLessThanOrEqual(MAX_HUNK_BYTES);
    expect(cut.hunk!.split('\n')).toHaveLength(2);
  });
});

describe('the file the answer opens', () => {
  const root = '/repo';
  const scope = (over: Partial<ChangeScope> = {}): ChangeScope => ({ inRepo: 'agent', projectDir: '/repo', tests: [], golden: null, ...over });

  it("is the first changed file under the agent's folder that isn't a golden or the config", () => {
    const tests = parseTests({ 'goldens/*': {} });
    expect(pickFile(['README.md', 'agent/goldens/x/run.json', 'agent/main.mjs'], root, scope({ projectDir: '/repo/agent', tests: parseTests({ 'goldens/*': {} }) }))).toBe('agent/main.mjs');
    expect(pickFile(['agent/shadowlap.config.json', 'agent/prompt.txt'], root, scope())).toBe('agent/prompt.txt');
    expect(pickFile(['goldens/a/run.json', 'src/a.ts'], root, scope({ inRepo: '', tests }))).toBe('src/a.ts');
    // The golden searched is a pack folder whether or not the config names it.
    expect(pickFile(['packs/mine/run.json', 'src/a.ts'], root, scope({ inRepo: '', golden: 'packs/mine' }))).toBe('src/a.ts');
  });

  it('is the first file when none fits', () => {
    expect(pickFile(['README.md', 'docs/x.md'], root, scope())).toBe('README.md');
  });

  it('passes over a file the commit deleted for one still there, which has a change to show', () => {
    expect(pickFile(['agent/old.py', 'agent/new.py'], root, scope(), new Set(['agent/old.py']))).toBe('agent/new.py');
    // Still before a file that can't have broken it, and before none at all.
    expect(pickFile(['README.md', 'agent/old.py'], root, scope(), new Set(['agent/old.py']))).toBe('agent/old.py');
    expect(pickFile(['docs/gone.md', 'README.md'], root, scope(), new Set(['docs/gone.md']))).toBe('README.md');
  });
});

describe('a commit read from git', () => {
  let repo = '';
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const step = (name: string, files: Record<string, string | Buffer | null>) => {
    for (const [f, content] of Object.entries(files)) {
      if (content === null) rmSync(join(repo, f));
      else {
        mkdirSync(join(repo, f, '..'), { recursive: true });
        writeFileSync(join(repo, f), content);
      }
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', name]);
    return git(['rev-parse', 'HEAD']);
  };
  const scope = (): ChangeScope => ({ inRepo: '', projectDir: repo, tests: parseTests({ 'goldens/*': {} }), golden: null });

  beforeAll(() => {
    repo = physicalPath(mkdtempSync(join(tmpdir(), 'sl-bisect-change-')));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    step('Start', { 'agent.mjs': 'const a = 1;\nconst b = 2;\nexport default a + b;\n', 'goldens/g/run.json': '{}\n' });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  it('keeps the file, the files, the hunk against the first parent and the line, skipping the golden', () => {
    const rev = step('Change the sum', { 'agent.mjs': 'const a = 1;\nexport default a + 3;\n', 'goldens/g/run.json': '{"v":2}\n' });
    expect(commitChange(repo, rev, scope())).toEqual({ file: 'agent.mjs', files: ['agent.mjs', 'goldens/g/run.json'], hunk: '@@ -1,3 +1,2 @@\n const a = 1;\n-const b = 2;\n-export default a + b;\n+export default a + 3;', line: 2, cut: false, merge: false });
  });

  it("diffs a merge against its first parent, and marks it, so it reverts with -m 1", () => {
    git(['checkout', '-q', '-b', 'feature']);
    step('Feature', { 'prompt.txt': 'Be brief.\n' });
    git(['checkout', '-q', 'main']);
    step('Main', { 'NOTES.md': 'main\n' });
    git(['merge', '-q', '--no-ff', 'feature', '-m', 'Merge feature']);
    const merge = git(['rev-parse', 'HEAD']);
    expect(commitChange(repo, merge, scope())).toEqual({ file: 'prompt.txt', files: ['prompt.txt'], hunk: '@@ -0,0 +1 @@\n+Be brief.', line: 1, cut: false, merge: true });
  });

  it('keeps no hunk for a binary file, nor for a deleted one', () => {
    const binary = step('Add a logo', { 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0, 255]) });
    expect(commitChange(repo, binary, scope())).toMatchObject({ file: 'logo.png', hunk: null, line: null });
    const gone = step('Drop the prompt', { 'prompt.txt': null });
    expect(commitChange(repo, gone, scope())).toMatchObject({ file: 'prompt.txt', hunk: null, line: null });
  });

  it('opens a file the commit changed over one it deleted', () => {
    step('Add the notes', { 'a-notes.txt': 'one\n' });
    const rev = step('Drop the notes, change the sum', { 'a-notes.txt': null, 'agent.mjs': 'const a = 1;\nexport default a + 4;\n' });
    expect(commitChange(repo, rev, scope())).toMatchObject({ file: 'agent.mjs', files: ['a-notes.txt', 'agent.mjs'], line: 2 });
  });

  it('is null where git has nothing to say, never an error', () => {
    expect(commitChange(repo, 'f'.repeat(40), scope())).toBeNull();
    const empty = (git(['commit', '-q', '--allow-empty', '-m', 'Nothing']), git(['rev-parse', 'HEAD']));
    expect(commitChange(repo, empty, scope())).toBeNull();
  });
});
