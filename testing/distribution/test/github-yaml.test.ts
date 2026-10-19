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
      while (frames.length && frames[frames.length - 1]!.col >= col) frames.pop();
      const parent = frames[frames.length - 1];
      frames.push({ col, keys: new Set(), last: '', path: `${parent ? parent.path + parent.last : ''}[].` });
    }
    const m = /^([\w.-]+):(?:\s+(.*))?$/.exec(rest);
    if (!m) continue;
    while (frames.length && frames[frames.length - 1]!.col > col) frames.pop();
    let frame = frames[frames.length - 1];
    if (!frame || frame.col < col) {
      frame = { col, keys: new Set(), last: '', path: frame ? `${frame.path}${frame.last}.` : '' };
      frames.push(frame);
    }
    if (frame.keys.has(m[1]!)) repeated.push(`${frame.path}${m[1]}`);
    frame.keys.add(m[1]!);
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
