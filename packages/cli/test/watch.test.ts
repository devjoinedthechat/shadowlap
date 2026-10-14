import { describe, expect, it } from 'vitest';
import { isIgnored } from '../src/watch.js';

describe('--watch ignores', () => {
  it('skips generated, hidden and vendored paths', () => {
    // Shadowlap writes its own store while replaying; watching it would loop forever.
    for (const path of [
      '.shadowlap/shadowlap.db',
      '.shadowlap/shadowlap.db-wal',
      'node_modules/ai/index.js',
      '.git/index',
      '.venv/lib/python3.12/site-packages/x.py',
      'src/__pycache__/agent.cpython-312.pyc',
      'coverage/lcov.info',
      'packages/cli/node_modules/x/y.js',
      '.DS_Store',
    ]) {
      expect(isIgnored(path), path).toBe(true);
    }
  });

  // fs.watch reports a backslash path on Windows and a forward-slash one everywhere else, and a
  // test that writes paths portably uses forward slashes on both. Windows has to read either.
  it.runIf(process.platform === 'win32')('skips the backslash paths Windows reports', () => {
    for (const path of ['node_modules\\ai\\index.js', '.shadowlap\\shadowlap.db', 'packages\\cli\\node_modules\\x\\y.js']) {
      expect(isIgnored(path), path).toBe(true);
    }
    for (const path of ['src\\agent.ts', 'goldens\\run\\run.json']) {
      expect(isIgnored(path), path).toBe(false);
    }
  });

  it('watches source, including build output an edit produces', () => {
    // `dist/` is how a TypeScript agent's change actually reaches the replay.
    for (const path of ['agent.py', 'src/agent.ts', 'dist/agent.js', 'prompts/system.md', 'goldens/run/run.json']) {
      expect(isIgnored(path), path).toBe(false);
    }
  });
});
