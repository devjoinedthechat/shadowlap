import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gateResult, Store, type TestResultData } from '@shadowlap/engine';
import { historyCells, olderThanTree, treeNow, withRevisionFacts } from '../src/tests-history.js';
import { testsView, type GoldenSource } from '../src/tests.js';

/**
 * A golden's history on Tests (src/tests-history.ts): each cell's tally and the bound its gate put on
 * the pass rate, and where a gate against history failed it for a drop, the baseline it compared and
 * which of the sessions it pooled are the table's own columns, read once per result. And what git
 * says of the revisions: each commit's subject, its author only where names show, and whether the
 * working tree has moved on since the session the verdict names.
 */

const T0 = Date.UTC(2026, 9, 20, 10, 0);
const HOUR = 60 * 60 * 1000;
const sprt = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 20 };
const history = { kind: 'baseline' as const, drop: 0.15, risk: 0.05, window: 10, min: 3, max: 40 };

const GOLDENS: GoldenSource[] = [
  { path: 'goldens/escalates', runId: null, packedAt: T0, mode: 'fork', repeat: 1, passes: 1, gate: sprt, checks: [] },
  { path: 'goldens/drops', runId: null, packedAt: T0, mode: 'fork', repeat: 1, passes: 1, gate: history, checks: [] },
  { path: 'goldens/plain', runId: null, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] },
];

/** A result of a gated golden, kept as a session on the baseline branch keeps it. */
function gated(gate: typeof sprt | typeof history, outcomes: boolean[], o: { history?: { passes: number; attempts: number; sessions: number } } = {}): TestResultData {
  const g = gateResult(gate, outcomes, { history: o.history ?? null });
  const verdict = g.decision === 'pass' ? 'passed' : g.decision === 'fail' ? 'failed' : 'inconclusive';
  return { mode: 'fork', attempts: { total: outcomes.length, passed: g.passes, required: null, runs: [] }, verdict, gate: g, branch: 'main', pullRequest: false, baselineBranch: 'main' };
}

const PLAIN: TestResultData = { mode: 'replay', verdict: 'passed', calls: { total: 8, replayed: 8, live: 0, blocked: 0, stubbed: 0 } };

/** Four sessions, each at a revision of its own: the drop comes in the last, after three that passed 3 of 3. */
function store(): Store {
  const s = Store.open(':memory:');
  const revisions = ['a1b2c3d', 'b2c3d4e', 'c3d4e5f', 'd4e5f6a'];
  revisions.forEach((revision, i) => {
    const at = T0 + i * HOUR;
    const session = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision, actor: 'ci', startedAt: at });
    const last = i === revisions.length - 1;
    const results: Array<{ golden: string; ok: boolean; data: TestResultData }> = [
      { golden: 'goldens/escalates', ok: true, data: gated(sprt, Array(12).fill(true)) },
      { golden: 'goldens/drops', ok: !last, data: last ? gated(history, [false, false, false], { history: { passes: 9, attempts: 9, sessions: 3 } }) : gated(history, [true, true, true]) },
      { golden: 'goldens/plain', ok: true, data: PLAIN },
    ];
    results.forEach((r, j) => s.addTestResult({ sessionId: session.sessionId, golden: r.golden, ok: r.ok, ...(r.ok ? {} : { failure: 'check' as const }), reason: r.ok ? null : 'failed: its pass rate dropped', runId: null, revision, at: at + j + 1, data: r.data }));
    s.finishTestSession(session.sessionId, { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, upstreamRequests: 0, endedAt: at + 100 });
  });
  return s;
}

describe('a golden\'s history', () => {
  it('gives a gated cell its tally and the bound its gate put on the pass rate, and a replay none', () => {
    const s = store();
    const view = testsView(s, GOLDENS, { revisions: 3 });
    const [escalates, drops, plain] = view.rows;
    expect(view.revisions).toEqual(['b2c3d4e', 'c3d4e5f', 'd4e5f6a']);
    expect(escalates.history.map((c) => [c.rate, c.bound])).toEqual(Array(3).fill([{ passes: 12, attempts: 12 }, 'rate >= 0.73 (95%)']));
    expect(drops.history.at(-1)).toMatchObject({ verdict: 'failed', rate: { passes: 0, attempts: 3 }, bound: 'rate <= 0.71 (95%)', dropped: true });
    expect(plain.history.map((c) => [c.verdict, c.bound, c.drop])).toEqual(Array(3).fill(['passed', null, null]));
    s.close();
  });

  it('says what a drop was against, and which of the sessions its gate pooled are columns here', () => {
    const s = store();
    const view = testsView(s, GOLDENS, { revisions: 3 });
    const drops = view.rows[1];
    // The kept baseline (9 of 9 over 3 sessions); of those sessions, the two before the drop in the
    // table's three columns, 6 of 6 between them. The oldest session is pooled but no column here.
    expect(drops.history.at(-1)!.drop).toEqual({ baseline: 1, history: { passes: 9, attempts: 9, sessions: 3 }, here: { sessions: 2, passes: 6, attempts: 6 } });
    // The cells that didn't drop say nothing of a drop.
    expect(drops.history.slice(0, 2).map((c) => [c.dropped, c.drop])).toEqual([
      [false, null],
      [false, null],
    ]);
    s.close();
  });

  it('reads a drop\'s pooled sessions once per result, however often the screen is read', () => {
    const s = store();
    let reads = 0;
    const counted = new Proxy(s, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (key !== 'listTestResults' || typeof value !== 'function') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        return (f: Parameters<Store['listTestResults']>[0]) => {
          if (f?.golden === 'goldens/drops') reads++;
          return s.listTestResults(f);
        };
      },
    });
    const results = s.listTestResults({ golden: 'goldens/drops', limit: 10 });
    const sessions = new Set(results.map((r) => r.sessionId));
    const reads0 = reads;
    const cells = () => historyCells(counted, results, ['d4e5f6a'], { columnOf: (r) => r.revision, columns: sessions, note: () => null, runId: () => null });
    expect(cells()[0].drop).toMatchObject({ here: { sessions: 3, passes: 9, attempts: 9 } });
    expect(reads).toBe(reads0 + 1);
    expect(cells()[0].drop).toMatchObject({ here: { sessions: 3 } });
    expect(reads).toBe(reads0 + 1);
    s.close();
  });
});

describe('the revisions as git has them', () => {
  it('names each revision\'s commit by its subject, a tested-dirty one by the commit under it, and its author only where names show', () => {
    const view = { revisions: ['a1b2c3d', 'b2c3d4e+dirty', null] };
    const subjects = new Map([
      ['a1b2c3d', 'Tighten refund wording'],
      ['b2c3d4e', 'Escalate refunds above the limit'],
    ]);
    const authors = new Map([['a1b2c3d', 'dana@northwind.example']]);
    expect(withRevisionFacts(view, subjects, authors, false).revisionFacts).toEqual([
      { rev: 'a1b2c3d', subject: 'Tighten refund wording', by: null },
      { rev: 'b2c3d4e+dirty', subject: 'Escalate refunds above the limit', by: null },
      { rev: null, subject: null, by: null },
    ]);
    expect(withRevisionFacts(view, subjects, authors, true).revisionFacts[0]).toEqual({ rev: 'a1b2c3d', subject: 'Tighten refund wording', by: 'dana@northwind.example' });
  });

  it('calls a verdict older than the working tree only for an ended session of a clean commit, once the tree has changed', () => {
    const ended = { revision: 'a1b2c3d', endedAt: T0 };
    expect(olderThanTree(ended, { dirty: true, later: false })).toBe(true);
    expect(olderThanTree(ended, { dirty: false, later: true })).toBe(true);
    expect(olderThanTree(ended, { dirty: false, later: false })).toBe(false);
    // Still running, tested with changes on top, no revision, or git couldn't say: never.
    expect(olderThanTree({ ...ended, endedAt: null }, { dirty: true, later: true })).toBe(false);
    expect(olderThanTree({ ...ended, revision: 'a1b2c3d+dirty' }, { dirty: true, later: true })).toBe(false);
    expect(olderThanTree({ ...ended, revision: null }, { dirty: true, later: true })).toBe(false);
    expect(olderThanTree(ended, null)).toBe(false);
    expect(olderThanTree(null, { dirty: true, later: true })).toBe(false);
  });

  it('asks git whether the tree has a tracked change or a later commit, and keeps its word a few seconds', async () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-tests-tree-')));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=dana@northwind.example', '-c', 'user.name=Dana', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).toString().trim();
      git('init', '-q', '.');
      writeFileSync(join(repo, 'shadowlap.config.json'), '{}\n');
      git('add', '-A');
      git('commit', '-qm', 'Start');
      const first = git('rev-parse', '--short', 'HEAD');
      expect(await treeNow(repo, first, 1000)).toEqual({ dirty: false, later: false });
      // A normalizer added: a tracked file changed. Kept for a few seconds, then asked again.
      writeFileSync(join(repo, 'shadowlap.config.json'), '{"normalize":[]}\n');
      expect(await treeNow(repo, first, 2000)).toEqual({ dirty: false, later: false });
      expect(await treeNow(repo, first, 7000)).toEqual({ dirty: true, later: false });
      // Committed: the tree is clean, at a later commit.
      git('commit', '-qam', 'Add a normalizer');
      expect(await treeNow(repo, first, 13_000)).toEqual({ dirty: false, later: true });
      // A file git doesn't track changes nothing; a name that is no commit, git can't say.
      writeFileSync(join(repo, 'notes.txt'), 'scratch\n');
      expect(await treeNow(repo, git('rev-parse', '--short', 'HEAD'), 19_000)).toEqual({ dirty: false, later: false });
      expect(await treeNow(repo, 'deadbeef', 25_000)).toBeNull();
      expect(await treeNow(repo, 'HEAD~1', 31_000)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
