// GitHub refuses a whole action.yml or workflow file that names a key twice in one mapping ("'x' is
// already defined"), so the Action stops loading for everyone, while a lenient YAML reader keeps the last
// one and nothing else notices. These checks read the files the way GitHub does on that point.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The keys a YAML file repeats within one mapping, as dotted paths (`outputs.inconclusive`,
 * `runs.steps[].name`). Reads what these files use: nested mappings, lists of mappings and block
 * scalars, whose lines are text, not keys.
 */
function repeatedKeys(yml: string): string[] {
  const repeated: string[] = [];
  const frames: { col: number; keys: Set<string>; last: string; path: string }[] = [];
  let scalar = -1;
  for (const raw of yml.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    let col = raw.length - raw.trimStart().length;
    if (scalar >= 0 && col > scalar) continue;
    scalar = -1;
    let rest = raw.trim();
    if (rest.startsWith('- ')) {
      // A list item starts a mapping of its own, two columns in.
      col += 2;
      rest = rest.slice(2).trimStart();
      while (frames.length && frames[frames.length - 1].col >= col) frames.pop();
      const parent = frames[frames.length - 1];
      frames.push({ col, keys: new Set(), last: '', path: `${parent ? parent.path + parent.last : ''}[].` });
    }
    const m = /^([\w.-]+):(?:\s+(.*))?$/.exec(rest);
    if (!m) continue;
    while (frames.length && frames[frames.length - 1].col > col) frames.pop();
    let frame = frames[frames.length - 1];
    if (!frame || frame.col < col) {
      frame = { col, keys: new Set(), last: '', path: frame ? `${frame.path}${frame.last}.` : '' };
      frames.push(frame);
    }
    if (frame.keys.has(m[1])) repeated.push(`${frame.path}${m[1]}`);
    frame.keys.add(m[1]);
    frame.last = m[1]!;
    if (/^[|>][-+0-9]*(\s+#.*)?$/.test(m[2] ?? '')) scalar = col;
  }
  return repeated;
}

const files = ['action.yml', ...readdirSync(join(ROOT, '.github', 'workflows')).filter((f) => f.endsWith('.yml')).map((f) => `.github/workflows/${f}`)];

describe('the YAML files GitHub loads', () => {
  it.each(files)('%s names no key twice in one mapping', (file) => {
    expect(repeatedKeys(readFileSync(join(ROOT, file), 'utf8'))).toEqual([]);
  });

  it('finds a key named twice, in a mapping or in a list item, and not in a block of text', () => {
    const yml = ['outputs:', '  passed: 1', '  run: |', '    passed: 2', '    passed: 3', '  steps:', '    - name: a', '      run: b', '    - name: c', '      name: d', '  passed: 4', ''].join('\n');
    expect(repeatedKeys(yml)).toEqual(['outputs.steps[].name', 'outputs.passed']);
  });
});

const workflows = readdirSync(join(ROOT, '.github', 'workflows')).filter((f) => f.endsWith('.yml'));
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const workflow = (name: string) => read(`.github/workflows/${name}`);

/** The lines of a YAML file that hold something: no blank lines, no comment lines. */
const meaningful = (yml: string) => yml.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith('#'));

/** A top-level key's block: its value on the key's line, then the lines indented under it. */
function topBlock(yml: string, key: string): string[] | null {
  const lines = meaningful(yml);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return null;
  const block = [lines[at].slice(key.length + 1).trim()];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith(' ')) break;
    block.push(l.trim());
  }
  return block.filter(Boolean);
}

/** Each job of a workflow: its own keys (four spaces in) with what follows each on its line, and its whole text. */
function jobsOf(yml: string): Map<string, { keys: Map<string, string>; text: string }> {
  const jobs = new Map<string, { keys: Map<string, string>; text: string }>();
  const lines = meaningful(yml);
  let inJobs = false;
  let job: { keys: Map<string, string>; text: string } | null = null;
  for (const l of lines) {
    if (!l.startsWith(' ')) {
      inJobs = l.startsWith('jobs:');
      continue;
    }
    if (!inJobs) continue;
    const id = /^ {2}([\w-]+):\s*$/.exec(l);
    if (id) {
      job = { keys: new Map(), text: '' };
      jobs.set(id[1], job);
      continue;
    }
    if (!job) continue;
    job.text += `${l}\n`;
    const key = /^ {4}([\w-]+):\s*(.*)$/.exec(l);
    if (key) job.keys.set(key[1], key[2]);
  }
  return jobs;
}


/** Every action a workflow uses, as written after `uses:`, but those of this repository (`./…`). */
const actionsIn = (yml: string) => [...yml.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].map((m) => ({ ref: m[1], comment: m[2].trim() })).filter((u) => !u.ref.startsWith('./'));
const pinned = (ref: string) => /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref);
const firstParty = (ref: string) => /^(actions|github)\//.test(ref);

describe('the actions the workflows use', () => {
  it('pin every action from outside GitHub to a commit, and the release every action it uses', () => {
    for (const file of workflows) {
      for (const { ref } of actionsIn(workflow(file))) if (!firstParty(ref)) expect(pinned(ref), `${file}: ${ref}`).toBe(true);
    }
    const release = actionsIn(workflow('release.yml'));
    expect(release.length).toBeGreaterThan(5);
    for (const { ref, comment } of release) {
      expect(pinned(ref), ref).toBe(true);
      // The release the commit is, for whoever updates it.
      expect(comment, ref).toMatch(/^# v\d+\.\d+\.\d+$/);
    }
  });
});

describe('the release workflow', () => {
  const yml = workflow('release.yml');
  const jobs = jobsOf(yml);
  const permissionsOf = (id: string) => {
    const text = jobs.get(id)!.text;
    const block = /^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(text);
    return block ? block[1].trim().split('\n').map((l) => l.trim()) : [];
  };

  it('runs CI on the tagged commit, and publishes nothing before it and the release checks pass', () => {
    expect(topBlock(yml, 'permissions')).toEqual(['{}']);
    expect(jobs.get('ci')!.keys.get('uses')).toBe('./.github/workflows/ci.yml');
    expect(/^\s+workflow_call:/m.test(workflow('ci.yml'))).toBe(true);
    // CI is the whole of it: lint, the tests (conformance included), the Python SDK on every Python, mypy.
    const ci = jobsOf(workflow('ci.yml'));
    expect([...ci.keys()]).toEqual(expect.arrayContaining(['lint', 'test', 'python-sdk', 'python-sdk-types']));
    expect(ci.get('test')!.text).toContain('testing/conformance/conformance.test.mjs');
    expect(jobs.get('build')!.keys.get('needs')).toBe('[ci, verify]');
    expect(jobs.get('npm')!.keys.get('needs')).toBe('build');
    expect(jobs.get('pypi')!.keys.get('needs')).toBe('build');
  });

  it('asks for each permission in the job that needs it, the tests and the build reading the repository and nothing more', () => {
    for (const id of jobs.keys()) expect(permissionsOf(id).length, `${id} names its permissions`).toBeGreaterThan(0);
    for (const id of ['ci', 'verify', 'build']) expect(permissionsOf(id), id).toEqual(['contents: read']);
    expect(permissionsOf('npm')).toEqual(['id-token: write']);
    expect(permissionsOf('pypi')).toEqual(['id-token: write']);
    expect(permissionsOf('github-release')).toEqual(['contents: write']);
  });

  it('publishes what the tokenless build job made, installing and building nothing where the tokens are', () => {
    for (const id of ['npm', 'pypi']) {
      const text = jobs.get(id)!.text;
      expect(text, id).not.toMatch(/npm ci|npm install|npm run|pip install|python -m build|actions\/checkout/);
      expect(text, id).toContain('actions/download-artifact@');
    }
    const build = jobs.get('build')!.text;
    expect(build).toContain('python -m pip install --require-hashes --no-deps -r .github/release/build-requirements.txt');
    expect(build).toContain('python -m build --no-isolation');
  });

  it('installs the Python build tools by hash, each pinned to one version', () => {
    const requirements = read('.github/release/build-requirements.txt');
    const names = [...requirements.matchAll(/^([\w.-]+)==([\w.]+) \\$/gm)].map((m) => m[1]);
    expect(names).toEqual(expect.arrayContaining(['build', 'setuptools', 'packaging', 'pyproject-hooks']));
    for (const block of requirements.split(/\n(?=[\w.-]+==)/).filter((b) => /^[\w.-]+==/.test(b))) expect(block, block.split('\n')[0]).toMatch(/--hash=sha256:[0-9a-f]{64}/);
  });
});
