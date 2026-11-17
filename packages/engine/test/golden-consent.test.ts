import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { goldenNeedsConsent, goldensNeedingConsent, packHeadRun, packRun, Store, trackedPacks, unpackRun } from '../src/index.js';

/**
 * Which goldens run their recorded command only after a yes: one this machine recorded, with the
 * command the store holds for it, and one the project's git repository tracks, run as they are; any
 * other came from a pack someone sent. A pack that reuses the id of a run recorded here, with a
 * command of its own, is one of those.
 */
let root = '';
let project = '';
let store: Store;
let mine = '';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Packs `runId` from `from` into `dir` (under the project unless absolute), its command replaced by `argv` when given. */
function pack(from: Store, runId: string, dir: string, argv?: string[]): string {
  const abs = isAbsolute(dir) ? dir : join(project, dir);
  packRun(from, runId, abs);
  if (argv) {
    const manifest = JSON.parse(readFileSync(join(abs, 'run.json'), 'utf8')) as { runs: Array<{ command: { argv: string[] } }> };
    manifest.runs.at(-1)!.command.argv = argv;
    writeFileSync(join(abs, 'run.json'), JSON.stringify(manifest));
  }
  return dir;
}

function recorded(s: Store, argv: string[]): string {
  const run = s.createRun({ mode: 'record', command: { argv, cwd: project } });
  s.endRun(run.runId, 'completed');
  return run.runId;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-golden-consent-')));
  project = join(root, 'project');
  mkdirSync(project);
  store = Store.open(':memory:');
  mine = recorded(store, ['node', 'agent.mjs']);
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('goldensNeedingConsent', () => {
  it('asks nothing of a golden this machine recorded, with the command it was recorded with', () => {
    pack(store, mine, 'goldens/own');
    expect(goldensNeedingConsent(store, ['goldens/own'], project)).toEqual([]);
  });

  it('asks of a pack that reuses the id of a run recorded here, with a command of its own', () => {
    pack(store, mine, 'goldens/reused', ['node', '-e', 'console.log(1)']);
    expect(goldensNeedingConsent(store, ['goldens/reused'], project)).toEqual([{ dir: 'goldens/reused', runId: mine, argv: ['node', '-e', 'console.log(1)'] }]);
  });

  it('asks of a run someone else recorded, before its pack is brought in and after', () => {
    const theirs = Store.open(':memory:');
    try {
      const id = recorded(theirs, ['node', 'their-agent.mjs']);
      pack(theirs, id, 'goldens/sent');
      expect(goldensNeedingConsent(store, ['goldens/sent'], project)).toEqual([{ dir: 'goldens/sent', runId: id, argv: ['node', 'their-agent.mjs'] }]);
      // Brought into this store, it is marked as a pack's: still someone else's.
      unpackRun(store, join(project, 'goldens/sent'));
      expect(goldensNeedingConsent(store, ['goldens/sent'], project).map((g) => g.dir)).toEqual(['goldens/sent']);
    } finally {
      theirs.close();
    }
  });

  it('asks nothing of a pack the repository tracks, and asks of one it does not, or one outside it', () => {
    const theirs = Store.open(':memory:');
    try {
      const id = recorded(theirs, ['node', 'their-agent.mjs']);
      pack(theirs, id, 'goldens/tracked');
      pack(theirs, id, 'goldens/added-not');
      const outside = pack(theirs, id, join(root, 'downloads', 'pack'));
      git(project, ['init', '-q']);
      git(project, ['add', '-f', '--', 'goldens/tracked/run.json']);
      // The one outside makes git refuse the whole list: each is asked of on its own.
      expect(trackedPacks(['goldens/tracked', 'goldens/added-not', outside], project)).toEqual(new Set(['goldens/tracked']));
      expect(goldensNeedingConsent(store, ['goldens/tracked', 'goldens/added-not', outside], project).map((g) => g.dir)).toEqual(['goldens/added-not', outside]);
    } finally {
      theirs.close();
    }
  });

  it('tracks nothing where the project is no git repository', () => {
    pack(store, mine, 'goldens/own');
    expect(trackedPacks(['goldens/own'], project)).toEqual(new Set());
  });

  it("leaves a folder it can't read as a pack for the command, which refuses it", () => {
    mkdirSync(join(project, 'goldens', 'broken'), { recursive: true });
    writeFileSync(join(project, 'goldens', 'broken', 'run.json'), '{"format":"something-else","runs":[]}');
    expect(packHeadRun(join(project, 'goldens', 'broken'))).toBeNull();
    expect(packHeadRun(join(project, 'goldens', 'missing'))).toBeNull();
    expect(goldensNeedingConsent(store, ['goldens/broken', 'goldens/missing'], project)).toEqual([]);
  });
});

describe('goldenNeedsConsent', () => {
  it("reads the golden's run as its import marks it, and the repository's index", () => {
    pack(store, mine, 'goldens/own');
    expect(goldenNeedsConsent(store.getRun(mine)!, join(project, 'goldens/own'), project)).toBe(false);
    const marked = { ...store.getRun(mine)!, meta: { commandFromImport: true } };
    expect(goldenNeedsConsent(marked, join(project, 'goldens/own'), project)).toBe(true);
    git(project, ['init', '-q']);
    git(project, ['add', '-f', '--', 'goldens/own/run.json']);
    expect(goldenNeedsConsent(marked, join(project, 'goldens/own'), project)).toBe(false);
  });
});
