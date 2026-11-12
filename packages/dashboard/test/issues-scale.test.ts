import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { times, timesOf } from '../../engine/test/timing.js';
import { issueKey } from '../src/issue-keys.js';
import { type IssuesPage, ISSUE_RUNS, ISSUES_READS } from '../src/issues.js';
import { addRun } from './read-model-store.js';

/**
 * Runs › Failed's issues at scale. The page asks for them on every tick, and every moment while the
 * verdicts Failed counts by are worked out, on one of the read pool's threads. One store holds 5,000
 * runs that failed the same way, one issue, read as a page that shows it open asks; another 1,000
 * runs that each failed a way of their own, an issue each, read with each closed, its count alone. A
 * poll appends each run to its issue once and works out who has blamed them from the grouping it
 * keeps, never with a read of the store for each run: what it reads of the store goes by its issues,
 * whose steps it asks, not by their runs. Its CPU time is held against a plain read of every run's
 * row on the same machine.
 */

const ONE_ISSUE = 5000;
const OWN_ISSUES = 1000;
const NOW = Date.UTC(2026, 9, 20, 12);
const failing = (label: string, detail: string) => ({ status: 'failed' as const, ok: false, label, detail });
/** A failure of its own for each run, in words an issue's key keeps: it drops the figures. */
const ownWords = (i: number) => `send_${[i % 26, Math.floor(i / 26) % 26, Math.floor(i / 676)].map((n) => String.fromCharCode(97 + n)).join('')} called at most once`;

let one: Store;
let many: Store;

beforeAll(() => {
  one = Store.open(':memory:');
  one.transaction(() => {
    for (let i = 0; i < ONE_ISSUE; i++) addRun(one, { startedAt: NOW - (i + 1) * 1000, status: 'failed', calls: 'll', meta: { checks: [failing('cost at most $0.05', `cost $0.${10 + (i % 80)}`)] } });
  });
  many = Store.open(':memory:');
  many.transaction(() => {
    for (let i = 0; i < OWN_ISSUES; i++) addRun(many, { startedAt: NOW - (i + 1) * 1000, status: 'failed', calls: 'll', meta: { checks: [failing(ownWords(i), 'called 2 times')] } });
  });
}, 120_000);

afterAll(() => {
  one.close();
  many.close();
});

/** The one issue of `one`: what failed, without its amounts. */
const ONE_KEY = issueKey.failure('fail', 'cost at most $N, but cost $N');
/** A poll of the issues, those named in `open` shown open: the one issue of `one` is, as the page that shows it open asks. */
const read = (store: Store, open: readonly string[] = store === one ? [ONE_KEY] : []) => ISSUES_READS['runs-issues'](store, { kind: 'runs-issues', options: {}, outcome: null, next: null, open }, { whole: true }) as { body: string };

/** The store reads of one run a poll makes, by what it asks. */
function runReads(store: Store): { getRun: number; blamesOfRun: number; linksTo: number } {
  read(store);
  const spies = { getRun: vi.spyOn(store, 'getRun'), blamesOfRun: vi.spyOn(store, 'blamesOfRun'), linksTo: vi.spyOn(store, 'linksTo') };
  try {
    read(store);
    return { getRun: spies.getRun.mock.calls.length, blamesOfRun: spies.blamesOfRun.mock.calls.length, linksTo: spies.linksTo.mock.calls.length };
  } finally {
    for (const s of Object.values(spies)) s.mockRestore();
  }
}

describe('Failed’s issues at scale', () => {
  it(`groups ${ONE_ISSUE.toLocaleString('en-US')} runs that failed the same way as one issue, carrying its newest ${ISSUE_RUNS} while it is open and its count alone while closed, and ${OWN_ISSUES.toLocaleString('en-US')} that failed their own ways an issue each`, () => {
    const page = JSON.parse(read(one).body) as IssuesPage;
    expect(page.issues).toHaveLength(1);
    expect(page.issues[0]).toMatchObject({ key: ONE_KEY, kind: 'failure', count: ONE_ISSUE, notBlamed: ONE_ISSUE, more: expect.any(String) });
    expect(page.issues[0].runs).toHaveLength(ISSUE_RUNS);
    expect((JSON.parse(read(one, []).body) as IssuesPage).issues[0]).toMatchObject({ key: ONE_KEY, count: ONE_ISSUE, runs: null, more: null });
    const body = read(many).body;
    const own = JSON.parse(body) as IssuesPage;
    expect(own.issues).toHaveLength(OWN_ISSUES);
    expect(own.issues.every((x) => x.count === 1 && x.runs === null && x.more === null && x.notBlamed === 1)).toBe(true);
    console.log(`runs-issues, ${OWN_ISSUES} issues, each closed: ${Buffer.byteLength(body).toLocaleString('en-US')} bytes`);
  });

  it('reads the store by its issues, whose steps it asks, never once for each of their runs', () => {
    // One issue: the reads of its step, as few for 5,000 runs as for one.
    const big = runReads(one);
    expect(Math.max(big.getRun, big.blamesOfRun, big.linksTo), JSON.stringify(big)).toBeLessThanOrEqual(5);
    // An issue each: a few for each issue's step.
    const own = runReads(many);
    expect(own.getRun + own.blamesOfRun + own.linksTo, JSON.stringify(own)).toBeLessThanOrEqual(10 * OWN_ISSUES);
  });

  it('answers a poll of one issue within a plain read of every run’s row, and of an issue each within a few reads of each run by its id', () => {
    // Held against this machine, not a number of milliseconds. Of one issue, a poll costs about what a
    // plain read of every run's row does; of 1,000 issues, whose steps it asks, about 15 times what
    // reading each of their runs once by its id does.
    read(one);
    const big = timesOf({ poll: () => read(one), runs: () => one.query('SELECT * FROM runs') });
    console.log(`runs-issues, one issue of ${ONE_ISSUE}: ${big.poll.toFixed(1)} ms CPU a poll; a read of every run ${big.runs.toFixed(1)} ms (${times(big.poll, big.runs)})`);
    expect(big.poll, `a poll of one issue took ${times(big.poll, big.runs)} a read of every run`).toBeLessThan(3 * big.runs);
    const ids = many.query('SELECT run_id FROM runs').map((r) => String(r.run_id));
    read(many);
    const own = timesOf({ poll: () => read(many), each: () => ids.forEach((id) => many.getRun(id)) });
    console.log(`runs-issues, ${OWN_ISSUES} issues: ${own.poll.toFixed(1)} ms CPU a poll; a read of each run by its id ${own.each.toFixed(1)} ms (${times(own.poll, own.each)})`);
    expect(own.poll, `a poll of ${OWN_ISSUES} issues took ${times(own.poll, own.each)} a read of each run by its id`).toBeLessThan(40 * own.each);
  });
});
