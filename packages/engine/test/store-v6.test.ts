import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkKey, recordBlame, SCHEMA_VERSION, Store, type MigrationApplied, type StoredFix, type TestSessionPullRequest } from '../src/index.js';
import { blameReport, EXPECT, makeRun, ORACLE } from './fix-fixtures.js';

/**
 * Store schema v6, what the dashboard's pages keep, added in one step: the advice put away
 * (dismissals), each check a fix has had (fix_checks), the pull request a CI test session ran for and
 * what its comment carried, a migration's applied state, and the 'tests' and 'dismissals' counters.
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { all(...a: unknown[]): Array<Record<string, unknown>>; run(...a: unknown[]): unknown }; close(): void } };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const storePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-store-v6-'));
  dirs.push(dir);
  return join(dir, 'shadowlap.db');
};

const blame = (store: Store, runId: string, o: { expect?: unknown; at?: number; actor?: string } = {}) =>
  recordBlame(store, { runId, report: blameReport(runId), expect: o.expect === undefined ? EXPECT : o.expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: 'Refunds above the limit issued without approval', checkText: 'issue_refund with {"amount":240} called 0 times', at: o.at ?? 2_000, ...(o.actor ? { actor: o.actor } : {}), ci: null }).fix;

const EMAIL = { tools: { send_email: 1 } };
const emailCheck: StoredFix['check'] = { expect: EMAIL, key: checkKey(EMAIL), oracle: ['the agent exits 0', 'send_email called 1 time'], text: 'send_email called 1 time' };
const migration = (sessionId: string, at = 3_000) => ({ sessionId, kind: 'migrate' as const, at, change: 'the model claude-sonnet-5-5', actor: 'dana@northwind.example', revision: 'd2e8a1f', data: { to: 'claude-sonnet-5-5' }, runs: [{ runId: '01RUNA', golden: 'goldens/refund-in-limit', rank: 3, changed: 1, data: { runId: '01RUNA' } }] });
const APPLIED: MigrationApplied = { at: 4_000, by: 'dana@northwind.example', outdated: [{ golden: 'goldens/refund-flow-budget', callNo: 3, path: '$.model' }] };

/** The store at `path` taken back to what a v5 build kept: none of v6's tables, columns, triggers or counters, and its version. */
function asVersion5(path: string): void {
  const raw = new DatabaseSync(path);
  const triggers = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'change_counts_test_%' OR name LIKE 'change_counts_fix_checks_%' OR name LIKE 'change_counts_dismissals_%')`).all().map((r) => String(r.name));
  expect(triggers).toHaveLength(12);
  for (const name of triggers) raw.exec(`DROP TRIGGER ${name}`);
  raw.exec(`DROP TABLE dismissals; DROP TABLE fix_checks`);
  raw.exec(`ALTER TABLE test_sessions DROP COLUMN pull_request; ALTER TABLE test_sessions DROP COLUMN comment; ALTER TABLE decision_sessions DROP COLUMN applied`);
  raw.exec(`DELETE FROM change_counts WHERE name IN ('tests', 'dismissals'); UPDATE meta SET value = '5' WHERE key = 'schema_version'`);
  raw.close();
}

describe('store schema v6', () => {
  it('upgrades a v5 store in place: its fixes take the check they have as their first, and nothing else changes', () => {
    expect(SCHEMA_VERSION).toBe(6);
    const path = storePath();
    const first = Store.open(path);
    const opened = blame(first, makeRun(first), { at: 2_000, actor: 'dana@northwind.example' });
    // A fix whose blame named nobody.
    const nobody = blame(first, makeRun(first), { expect: EMAIL, at: 2_500 });
    const session = first.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', owner: null });
    first.addTestResult({ sessionId: session.sessionId, golden: 'goldens/refund-in-limit', ok: true });
    first.finishTestSession(session.sessionId, { passed: 1, failed: 0, upstreamRequests: 0 });
    first.putDecisionSession(migration('mg-01M50000000000000000000001'));
    first.close();
    asVersion5(path);

    const second = Store.open(path);
    expect(second.schemaVersion()).toBe(6);
    // What a v5 build kept reads back as it was.
    expect(second.listFixes().map((f) => f.check.key)).toEqual([checkKey(EMAIL), checkKey(EXPECT)]);
    // Each fix's check is its first, from when the fix was opened, by whoever opened it.
    expect(second.fixChecks(opened.fixId)).toEqual([{ fixId: opened.fixId, position: 0, at: 2_000, actor: 'dana@northwind.example', check: { expect: EXPECT, key: checkKey(EXPECT), oracle: ORACLE, text: 'issue_refund with {"amount":240} called 0 times' } }]);
    expect(second.fixChecks(nobody.fixId)).toMatchObject([{ position: 0, at: 2_500, actor: null, check: { key: checkKey(EMAIL) } }]);
    // A session kept before ran for no pull request and kept no comment; a migration kept before was never applied.
    expect(second.getTestSession(session.sessionId)).toMatchObject({ revision: 'd2e8a1f', passed: 1, pullRequest: null, comment: null });
    expect(second.getDecisionSession('mg-01M50000000000000000000001')).toMatchObject({ change: 'the model claude-sonnet-5-5', applied: null });
    expect(second.listDismissals()).toEqual([]);
    expect(second.changeCounts()).toMatchObject({ tests: 0, dismissals: 0 });
    // What v6 keeps, kept from now on.
    second.setTestSessionPullRequest(session.sessionId, { number: 142, url: 'https://github.com/northwind/support-agent/pull/142', source: 'GitHub Actions (pull_request)' });
    expect(second.changeCounts().tests).toBeGreaterThan(0);
    second.setMigrationApplied('mg-01M50000000000000000000001', APPLIED);
    second.putDismissal({ key: 'coverage', facts: ['3f9a2c1d5e8b7a60'] });
    expect(second.setFixCheck(opened.fixId, emailCheck, { at: 5_000, actor: 'maya@northwind.example' })).toBe(true);
    second.close();

    // Opened again, nothing is added twice, and what was kept reads back.
    const third = Store.open(path);
    expect(third.schemaVersion()).toBe(6);
    expect(third.fixChecks(opened.fixId).map((c) => [c.position, c.check.key, c.actor])).toEqual([
      [0, checkKey(EXPECT), 'dana@northwind.example'],
      [1, checkKey(EMAIL), 'maya@northwind.example'],
    ]);
    expect(third.fixChecks(nobody.fixId)).toHaveLength(1);
    expect(third.getTestSession(session.sessionId)?.pullRequest).toEqual({ number: 142, url: 'https://github.com/northwind/support-agent/pull/142', source: 'GitHub Actions (pull_request)' });
    expect(third.getDecisionSession('mg-01M50000000000000000000001')?.applied).toEqual(APPLIED);
    expect(third.listDismissals().map((d) => d.key)).toEqual(['coverage']);
    third.close();
  });

  it("upgrades a v5 store whose fixes keep data that doesn't read as JSON, or none, or no author in words: their first checks name nobody", () => {
    const path = storePath();
    const first = Store.open(path);
    // Five fixes, each opened by someone; the first four come to keep data no author can be read from.
    const kept = ['not json', null, '[1,2]', '{"openedBy":7}', JSON.stringify({ openedBy: 'dana@northwind.example' })];
    const fixes = kept.map((_, i): StoredFix => ({ fixId: `fx-01M3RZ0000000000000000V5D${i}`, title: `Fix ${i}`, labels: [], check: emailCheck, status: 'open', openedAt: 1_000 + i, verifiedAt: null, appliedAt: null, data: { openedBy: 'dana@northwind.example' } }));
    for (const fix of fixes) first.insertFix(fix);
    first.close();
    asVersion5(path);
    const raw = new DatabaseSync(path);
    fixes.forEach((fix, i) => raw.prepare(`UPDATE fixes SET data = ? WHERE fix_id = ?`).run(kept[i], fix.fixId));
    raw.close();

    // Data that doesn't read as JSON never reaches json_type, which would refuse it and the store with it.
    const second = Store.open(path);
    expect(second.schemaVersion()).toBe(6);
    expect(fixes.map((fix) => second.fixChecks(fix.fixId))).toEqual(fixes.map((fix, i) => [{ fixId: fix.fixId, position: 0, at: fix.openedAt, actor: i === 4 ? 'dana@northwind.example' : null, check: emailCheck }]));
    second.close();
  });

  it('refuses a store a newer Shadowlap wrote, as it always has', () => {
    const path = storePath();
    Store.open(path).close();
    const raw = new DatabaseSync(path);
    raw.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
    raw.close();
    expect(() => Store.open(path)).toThrow(`${path} was written by a newer Shadowlap (store schema v7; this build understands v6). Upgrade Shadowlap, or point --db at another store.`);
    expect(() => Store.openReadOnly(path)).toThrow('this build understands v6');
  });
});

describe('a test session: the pull request it ran for, and what its comment carried', () => {
  it('keeps the pull request a session ran for, from its start or named later', () => {
    const store = Store.open(':memory:');
    const pr = { number: 142, url: 'https://github.com/northwind/support-agent/pull/142', source: 'GitHub Actions (pull_request)' };
    const ci = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', pullRequest: pr, owner: null });
    expect(ci.pullRequest).toEqual(pr);
    expect(store.getTestSession(ci.sessionId)?.pullRequest).toEqual(pr);
    expect(store.listTestSessions()[0]).toMatchObject({ sessionId: ci.sessionId, pullRequest: pr, comment: null });
    // A session on a person's machine runs for none; one named later, without a number or a page, as SHADOWLAP_PR may.
    const here = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], owner: null });
    expect(here.pullRequest).toBeNull();
    store.setTestSessionPullRequest(here.sessionId, { number: null, url: null, source: 'SHADOWLAP_PR' });
    expect(store.getTestSession(here.sessionId)?.pullRequest).toEqual({ number: null, url: null, source: 'SHADOWLAP_PR' });
    store.setTestSessionPullRequest(here.sessionId, null);
    expect(store.getTestSession(here.sessionId)?.pullRequest).toBeNull();
    expect(() => store.setTestSessionPullRequest('01NOSESSION', pr)).toThrow('unknown test session 01NOSESSION');
    // Kept as it reads back, from its start and named later: a number that is no pull request's, and
    // a page that is no web page's address, are none.
    const odd = { number: 0, url: 'javascript:alert(1)', source: 'SHADOWLAP_PR' };
    const started = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], pullRequest: odd, owner: null });
    expect(started.pullRequest).toEqual({ number: null, url: null, source: 'SHADOWLAP_PR' });
    expect(store.getTestSession(started.sessionId)?.pullRequest).toEqual(started.pullRequest);
    store.setTestSessionPullRequest(here.sessionId, { ...odd, number: 7 });
    expect(store.getTestSession(here.sessionId)?.pullRequest).toEqual({ number: 7, url: null, source: 'SHADOWLAP_PR' });
    const raw = (store as unknown as { db: { prepare(sql: string): { get(...a: unknown[]): Record<string, unknown> | undefined } } }).db;
    expect(raw.prepare(`SELECT pull_request FROM test_sessions WHERE session_id = ?`).get(here.sessionId)?.pull_request).toBe(JSON.stringify({ number: 7, url: null, source: 'SHADOWLAP_PR' }));
    store.close();
  });

  it("keeps each part of a session's comment beside the parts kept already, and takes one out with null", () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], owner: null });
    store.setTestSessionComment(s.sessionId, { decisions: 'dc-01M50000000000000000000001' });
    expect(store.getTestSession(s.sessionId)?.comment).toEqual({ decisions: 'dc-01M50000000000000000000001', costPerRun: null });
    // A part kept by a job after the first leaves the first one's.
    store.setTestSessionComment(s.sessionId, { costPerRun: { before: 0.029, after: 0.031 } });
    expect(store.getTestSession(s.sessionId)?.comment).toEqual({ decisions: 'dc-01M50000000000000000000001', costPerRun: { before: 0.029, after: 0.031 } });
    store.setTestSessionComment(s.sessionId, { costPerRun: { before: null, after: 0.034 } });
    expect(store.getTestSession(s.sessionId)?.comment?.costPerRun).toEqual({ before: null, after: 0.034 });
    // Taken out one by one, until the session keeps none.
    store.setTestSessionComment(s.sessionId, { decisions: null });
    expect(store.getTestSession(s.sessionId)?.comment).toEqual({ decisions: null, costPerRun: { before: null, after: 0.034 } });
    store.setTestSessionComment(s.sessionId, { costPerRun: null });
    expect(store.getTestSession(s.sessionId)?.comment).toBeNull();
    expect(() => store.setTestSessionComment('01NOSESSION', { decisions: 'dc-x' })).toThrow('unknown test session 01NOSESSION');
    store.close();
  });

  it('reads a pull request or a comment kept in any other shape as none, part by part', () => {
    const store = Store.open(':memory:');
    const raw = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    const s = store.startTestSession({ command: ['shadowlap', 'test'], owner: null });
    const keep = (pr: unknown, comment: unknown) => raw.prepare(`UPDATE test_sessions SET pull_request = ?, comment = ? WHERE session_id = ?`).run(pr, comment, s.sessionId);
    keep(JSON.stringify({ number: 0, url: 7, source: 'GitHub Actions (pull_request)' }), JSON.stringify({ decisions: 3, costPerRun: { before: 'a lot', after: 0.03 } }));
    expect(store.getTestSession(s.sessionId)).toMatchObject({ pullRequest: { number: null, url: null, source: 'GitHub Actions (pull_request)' }, comment: { decisions: null, costPerRun: { before: null, after: 0.03 } } });
    keep(JSON.stringify({ number: 142 }), JSON.stringify([]));
    expect(store.getTestSession(s.sessionId)).toMatchObject({ pullRequest: null, comment: null });
    // A page that is no web page's address is none: it never reaches a link.
    keep(JSON.stringify({ number: 142, url: 'javascript:alert(1)', source: 'SHADOWLAP_PR' }), null);
    expect(store.getTestSession(s.sessionId)?.pullRequest).toEqual({ number: 142, url: null, source: 'SHADOWLAP_PR' });
    // A state that is none of open, merged and closed is none, and so is when it was said; a time that is no number is none.
    keep(JSON.stringify({ number: 142, url: null, source: 'SHADOWLAP_PR', state: 'reopened', at: 5_000 }), null);
    expect(store.getTestSession(s.sessionId)?.pullRequest).toEqual({ number: 142, url: null, source: 'SHADOWLAP_PR' });
    keep(JSON.stringify({ number: 142, url: null, source: 'SHADOWLAP_PR', state: 'merged', at: 'yesterday' }), null);
    expect(store.getTestSession(s.sessionId)?.pullRequest).toEqual({ number: 142, url: null, source: 'SHADOWLAP_PR', state: 'merged' });
    keep('not json', 'not json');
    expect(store.getTestSession(s.sessionId)).toMatchObject({ pullRequest: null, comment: null });
    // A comment that doesn't read never stops a part being kept: it is none, and the part takes its place.
    store.setTestSessionComment(s.sessionId, { decisions: 'dc-01M50000000000000000000001' });
    expect(store.getTestSession(s.sessionId)?.comment).toEqual({ decisions: 'dc-01M50000000000000000000001', costPerRun: null });
    store.close();
  });

  it('tells every session that ran for a pull request where it stands, by its page or, where one names none, by its number', () => {
    const store = Store.open(':memory:');
    const raw = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    const page = 'https://github.com/northwind/support-agent/pull/142';
    const start = (pullRequest: TestSessionPullRequest | null) => store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], pullRequest, owner: null }).sessionId;
    const pr = (sessionId: string) => store.getTestSession(sessionId)?.pullRequest ?? null;
    const counter = () => store.changeCounts().tests;
    // Two sessions ran for #142 named by its page, and one by its number alone, as SHADOWLAP_PR names it.
    const pushed = start({ number: 142, url: page, source: 'GitHub Actions (pull_request)' });
    const again = start({ number: 142, url: page, source: 'GitHub Actions (pull_request)' });
    const numbered = start({ number: 142, url: null, source: 'SHADOWLAP_PR' });
    // Another repository's #142, another pull request, one named by neither, and one that ran for none.
    const elsewhere = start({ number: 142, url: 'https://github.com/northwind/billing/pull/142', source: 'GitHub Actions (pull_request)' });
    const other = start({ number: 141, url: 'https://github.com/northwind/support-agent/pull/141', source: 'GitHub Actions (pull_request)' });
    const unnamed = start({ number: null, url: null, source: 'SHADOWLAP_PR' });
    const none = start(null);
    // Kept in shapes that read as no pull request: never told, and never in the way of the others.
    const broken = start(null);
    raw.prepare(`UPDATE test_sessions SET pull_request = 'not json' WHERE session_id = ?`).run(broken);
    const sourceless = start(null);
    raw.prepare(`UPDATE test_sessions SET pull_request = ? WHERE session_id = ?`).run(JSON.stringify({ number: 142, url: page }), sourceless);
    // One kept with a page that is no web page's address reads as named by its number alone, and is told as one.
    const scripted = start(null);
    raw.prepare(`UPDATE test_sessions SET pull_request = ? WHERE session_id = ?`).run(JSON.stringify({ number: 142, url: 'javascript:alert(1)', source: 'SHADOWLAP_PR' }), scripted);

    let before = counter();
    expect(store.setTestPullRequestState({ number: 142, url: page }, 'open', 5_000)).toBe(4);
    expect(counter()).toBe(before + 4);
    expect(pr(pushed)).toEqual({ number: 142, url: page, source: 'GitHub Actions (pull_request)', state: 'open', at: 5_000 });
    expect([again, numbered].map(pr)).toMatchObject([{ state: 'open', at: 5_000 }, { url: null, state: 'open', at: 5_000 }]);
    expect(pr(scripted)).toEqual({ number: 142, url: null, source: 'SHADOWLAP_PR', state: 'open', at: 5_000 });
    for (const id of [elsewhere, other, unnamed]) expect(pr(id)).not.toHaveProperty('state');
    expect([none, broken, sourceless].map(pr)).toEqual([null, null, null]);
    // Told the same again: nothing is written, and when it was first said stays.
    before = counter();
    expect(store.setTestPullRequestState({ number: 142, url: page }, 'open', 6_000)).toBe(0);
    expect(counter()).toBe(before);
    expect(pr(pushed)?.at).toBe(5_000);

    // By its page alone, a session that names only its number isn't told; by its number alone, each session with it is.
    expect(store.setTestPullRequestState({ url: page }, 'merged', 7_000)).toBe(2);
    expect([pushed, again, numbered, scripted].map((id) => pr(id)?.state)).toEqual(['merged', 'merged', 'open', 'open']);
    expect(store.setTestPullRequestState({ number: 142 }, 'merged', 8_000)).toBe(3);
    expect([pushed, numbered, scripted, elsewhere].map((id) => [pr(id)?.state, pr(id)?.at])).toEqual([
      ['merged', 7_000],
      ['merged', 8_000],
      ['merged', 8_000],
      ['merged', 8_000],
    ]);
    expect(pr(other)).not.toHaveProperty('state');
    // Neither a number nor a page names no pull request; a state that is none of the three is refused.
    expect(store.setTestPullRequestState({}, 'closed')).toBe(0);
    expect(store.setTestPullRequestState({ number: 0, url: 'javascript:alert(1)' }, 'closed')).toBe(0);
    expect(() => store.setTestPullRequestState({ number: 142 }, 'reopened' as unknown as 'open')).toThrow("reopened is no pull request's state");
    store.close();
  });

  it('keeps where a pull request stands as it reads back, in a store opened again, beside what a later build kept with it', () => {
    const path = storePath();
    const store = Store.open(path);
    const page = 'https://github.com/northwind/support-agent/pull/142';
    // Named with where it stands from the session's start, as a job that knows it may.
    const named = { number: 142, url: page, source: 'GitHub Actions (pull_request)', state: 'open' as const, at: 4_000 };
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], pullRequest: named, owner: null });
    expect(s.pullRequest).toEqual(named);
    expect(store.getTestSession(s.sessionId)?.pullRequest).toEqual(named);
    const raw = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): Record<string, unknown> | undefined } } }).db;
    raw.prepare(`UPDATE test_sessions SET pull_request = json_set(pull_request, '$.title', 'Hold refunds over the limit') WHERE session_id = ?`).run(s.sessionId);
    expect(store.setTestPullRequestState({ number: 142, url: page }, 'merged', 9_000)).toBe(1);
    // What a later build kept beside it stays.
    expect(JSON.parse(String(raw.prepare(`SELECT pull_request FROM test_sessions WHERE session_id = ?`).get(s.sessionId)?.pull_request))).toEqual({ ...named, state: 'merged', at: 9_000, title: 'Hold refunds over the limit' });
    store.close();

    const reopened = Store.open(path);
    expect(reopened.getTestSession(s.sessionId)?.pullRequest).toEqual({ ...named, state: 'merged', at: 9_000 });
    expect(reopened.listTestSessions().map((x) => x.pullRequest?.state)).toEqual(['merged']);
    // Named again later, it is as it reads back: where it stands with it.
    reopened.setTestSessionPullRequest(s.sessionId, { ...named, state: 'closed', at: 'soon' as unknown as number });
    expect(reopened.getTestSession(s.sessionId)?.pullRequest).toEqual({ number: 142, url: page, source: 'GitHub Actions (pull_request)', state: 'closed' });
    reopened.close();
  });

  it('moves the tests counter on every write to a session or a result, and nothing else does', () => {
    const store = Store.open(':memory:');
    const tests = () => store.changeCounts().tests;
    expect(tests()).toBe(0);
    let last = tests();
    const moved = () => {
      const now = tests();
      const did = now > last;
      last = now;
      return did;
    };
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], owner: null });
    expect(moved()).toBe(true);
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/refund-in-limit', ok: true });
    expect(moved()).toBe(true);
    // A result kept again for the same golden replaces the first, and moves it too.
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/refund-in-limit', ok: false, failure: 'check' });
    expect(moved()).toBe(true);
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    expect(moved()).toBe(true);
    store.setTestSessionPullRequest(s.sessionId, { number: 7, url: null, source: 'SHADOWLAP_PR' });
    expect(moved()).toBe(true);
    store.setTestSessionComment(s.sessionId, { decisions: 'dc-01M50000000000000000000001' });
    expect(moved()).toBe(true);
    // A run, a fix and a decision session are no test session.
    const run = makeRun(store);
    blame(store, run);
    store.putDecisionSession(migration('mg-01M50000000000000000000002'));
    expect(moved()).toBe(false);
    store.close();
  });
});

describe("a migration's applied state", () => {
  it('keeps what applying did on the migration, keeps it when the session is kept again, and takes it away', () => {
    const store = Store.open(':memory:');
    store.putDecisionSession(migration('mg-01M50000000000000000000001'));
    store.putDecisionSession({ ...migration('dc-01M50000000000000000000002'), kind: 'decisions' });
    expect(store.getDecisionSession('mg-01M50000000000000000000001')?.applied).toBeNull();
    const before = store.changeCounts().decisions;
    store.setMigrationApplied('mg-01M50000000000000000000001', APPLIED);
    expect(store.changeCounts().decisions).toBeGreaterThan(before);
    expect(store.getDecisionSession('mg-01M50000000000000000000001')?.applied).toEqual(APPLIED);
    expect(store.listDecisionSessions().map((s) => [s.sessionId, s.applied])).toEqual([
      ['mg-01M50000000000000000000001', APPLIED],
      ['dc-01M50000000000000000000002', null],
    ]);
    // A verify of its runs keeps the session again: still applied.
    store.putDecisionSession({ ...migration('mg-01M50000000000000000000001'), data: { to: 'claude-sonnet-5-5', verified: true } });
    expect(store.getDecisionSession('mg-01M50000000000000000000001')).toMatchObject({ data: { verified: true }, applied: APPLIED });
    // A decisions session is no migration, and one that isn't kept has nothing to apply.
    expect(() => store.setMigrationApplied('dc-01M50000000000000000000002', APPLIED)).toThrow('no migration dc-01M50000000000000000000002');
    expect(() => store.setMigrationApplied('mg-01M5NONE', APPLIED)).toThrow('no migration mg-01M5NONE');
    store.setMigrationApplied('mg-01M50000000000000000000001', null);
    expect(store.getDecisionSession('mg-01M50000000000000000000001')?.applied).toBeNull();
    store.close();
  });

  it('reads an applied state kept in another shape without the goldens that are none', () => {
    const store = Store.open(':memory:');
    const raw = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    store.putDecisionSession(migration('mg-01M50000000000000000000001'));
    const keep = (applied: unknown) => raw.prepare(`UPDATE decision_sessions SET applied = ? WHERE session_id = 'mg-01M50000000000000000000001'`).run(JSON.stringify(applied));
    keep({ at: 4_000, by: 5, outdated: [{ golden: 'goldens/a', callNo: 3, path: '$.model' }, { golden: 'goldens/b', callNo: 0, path: '$.model' }, { golden: 'goldens/c', callNo: 2 }, 'goldens/d'] });
    expect(store.getDecisionSession('mg-01M50000000000000000000001')?.applied).toEqual({ at: 4_000, by: null, outdated: [{ golden: 'goldens/a', callNo: 3, path: '$.model' }] });
    keep({ by: 'dana@northwind.example', outdated: [] });
    expect(store.getDecisionSession('mg-01M50000000000000000000001')?.applied).toBeNull();
    store.close();
  });
});

describe('each check a fix has had', () => {
  it('starts a fix with the check its first blame was made under, and adds each it is given after it', () => {
    const store = Store.open(':memory:');
    const fix = blame(store, makeRun(store), { at: 2_000, actor: 'dana@northwind.example' });
    expect(store.fixChecks(fix.fixId)).toEqual([{ fixId: fix.fixId, position: 0, at: 2_000, actor: 'dana@northwind.example', check: fix.check }]);

    const before = store.changeCounts().fixes;
    expect(store.setFixCheck(fix.fixId, emailCheck, { at: 3_000, actor: 'maya@northwind.example' })).toBe(true);
    expect(store.changeCounts().fixes).toBeGreaterThan(before);
    // The fix has it now; only its check changed.
    expect(store.getFix(fix.fixId)).toMatchObject({ check: emailCheck, status: 'open', title: 'Refunds above the limit issued without approval', openedAt: 2_000 });
    expect(store.fixChecks(fix.fixId).map((c) => [c.position, c.at, c.actor, c.check])).toEqual([
      [0, 2_000, 'dana@northwind.example', fix.check],
      [1, 3_000, 'maya@northwind.example', emailCheck],
    ]);

    // The check it has already: nothing is written.
    const unchanged = store.changeCounts().fixes;
    expect(store.setFixCheck(fix.fixId, { ...emailCheck, text: 'the same check in other words' })).toBe(false);
    expect(store.changeCounts().fixes).toBe(unchanged);
    expect(store.fixChecks(fix.fixId)).toHaveLength(2);
    // Back to its first: a third entry, so what was made under each keeps it.
    const now = Date.now();
    expect(store.setFixCheck(fix.fixId, fix.check)).toBe(true);
    const third = store.fixChecks(fix.fixId)[2];
    expect(third).toMatchObject({ position: 2, actor: null, check: fix.check });
    expect(third.at).toBeGreaterThanOrEqual(now);
    expect(store.getFix(fix.fixId)?.check).toEqual(fix.check);

    expect(() => store.setFixCheck('fx-NOSUCHFIX', emailCheck)).toThrow('unknown fix fx-NOSUCHFIX');
    expect(store.fixChecks('fx-NOSUCHFIX')).toEqual([]);
    store.close();
  });

  it('gives a fix kept inside a transaction, as a pull keeps one, its check as its first', () => {
    const store = Store.open(':memory:');
    const fix: StoredFix = { fixId: 'fx-01M3RZ0000000000000000PULL', title: 'Pulled', labels: [], check: emailCheck, status: 'verified', openedAt: 1_000, verifiedAt: 1_500, appliedAt: null, data: { openedBy: 'jonas@northwind.example' } };
    store.transaction(() => store.insertFix(fix));
    expect(store.fixChecks(fix.fixId)).toEqual([{ fixId: fix.fixId, position: 0, at: 1_000, actor: 'jonas@northwind.example', check: emailCheck }]);
    // A fix kept twice is refused whole: neither it nor a second first check is kept.
    expect(() => store.insertFix({ ...fix, check: { ...emailCheck, key: 'check:other' } })).toThrow();
    expect(store.fixChecks(fix.fixId)).toHaveLength(1);
    store.close();
  });
});
