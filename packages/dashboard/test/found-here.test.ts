import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordEvent, Store } from '@shadowlap/engine';
import { changeHere, foundHere } from '../src/found-here.js';
import { bisectAnswers, changeOf, type FoundCommit } from '../src/tests-bisect.js';

/**
 * The first bad commit's change as the server reads it back from bisect's answer (tests-bisect.ts),
 * and as every route serves a found commit (found-here.ts): the author only where names are shown,
 * the file's place in the project folder, and the files outside it.
 */

const CHANGE = { file: 'agent/refund.py', files: ['agent/refund.py', 'docs/notes.md'], hunk: '@@ -1,2 +1,2 @@\n a\n-b\n+c', line: 2, cut: false, merge: false };

describe('the change bisect kept', () => {
  it('is read with the answer, and is null for an answer kept before bisect kept one', () => {
    const store = Store.open(':memory:');
    recordEvent(store, { kind: 'bisect.found', ref: 'goldens/old', data: { first: { rev: 'aaaaaaa', subject: 's', author: 'Ravi', date: 'd' }, why: 'w' } });
    recordEvent(store, { kind: 'bisect.found', ref: 'goldens/new', data: { first: { rev: 'bbbbbbb', subject: 's', author: 'Ravi', date: 'd', change: CHANGE }, why: 'w' } });
    const answers = bisectAnswers(store);
    store.close();
    expect(answers.get('goldens/old')![0].answer.found!.change).toBeNull();
    expect(answers.get('goldens/new')![0].answer.found!.change).toEqual({ ...CHANGE, path: null, outside: 0 });
  });

  it('has its types checked and its sizes capped again', () => {
    expect(changeOf({ file: 42 })).toBeNull();
    expect(changeOf('agent.py')).toBeNull();
    expect(changeOf({ file: 'a.py', files: ['a.py', 7, 'b\0c'], hunk: null, line: 3 })).toEqual({ file: 'a.py', files: ['a.py'], hunk: null, line: null, cut: false, merge: false, path: null, outside: 0 });
    const long = changeOf({ file: 'a.py', files: ['a.py'], hunk: ['@@ -1,0 +1,100 @@', ...Array.from({ length: 100 }, (_, i) => `+${i}`)].join('\n'), line: 1, cut: false });
    expect(long).toMatchObject({ cut: true, line: 1 });
    expect(long!.hunk!.split('\n')).toHaveLength(60);
    // The file is among the files, which hold 50 at most.
    expect(changeOf({ file: 'z.py', files: Array.from({ length: 60 }, (_, i) => `f${i}`) })!.files).toHaveLength(50);
    expect(changeOf({ file: 'z.py', files: ['a.py'] })!.files).toEqual(['z.py', 'a.py']);
  });
});

describe('a found commit as the dashboard serves it', () => {
  let repo = '';
  let project = '';
  const found = (over: Partial<FoundCommit> = {}): FoundCommit => ({ rev: 'abc1234', subject: 'Log the total', author: 'Ravi', date: '2026-09-30T10:00:00Z', why: 'exit', untested: [], replays: 3, tokens: 0, at: 1, change: { ...CHANGE, path: null, outside: 0 }, ...over });

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'sl-found-here-')));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    project = join(repo, 'agent');
    mkdirSync(project);
    writeFileSync(join(project, 'refund.py'), 'a\nc\n');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('names its author only where a team store is configured', async () => {
    expect((await foundHere(found(), project)).author).toBe('');
    expect((await foundHere(found(), null)).author).toBe('');
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ store: 's3://northwind-agent-runs/support-agent' }));
    try {
      expect((await foundHere(found(), project)).author).toBe('Ravi');
    } finally {
      rmSync(join(project, 'shadowlap.config.json'));
    }
  });

  it('places its file in the project folder, and counts the files outside it', async () => {
    expect((await foundHere(found(), project)).change).toMatchObject({ path: 'refund.py', outside: 1 });
    // A file outside the folder, or not in the working tree now, has no path to open.
    expect(changeHere({ ...CHANGE, file: 'docs/notes.md', path: null, outside: 0 }, project, repo)).toMatchObject({ path: null, outside: 1 });
    expect(changeHere({ ...CHANGE, file: 'agent/gone.py', path: null, outside: 0 }, project, repo).path).toBeNull();
    // Without a repository to place it in, or a project folder, it has none.
    expect(changeHere({ ...CHANGE, path: null, outside: 0 }, project, null).path).toBeNull();
    expect((await foundHere(found(), null)).change).toMatchObject({ path: null });
  });
});
