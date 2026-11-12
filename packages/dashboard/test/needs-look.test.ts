import { recordBlame, recordEvent, recordRepair, recordVerdict, Store } from '@shadowlap/engine';
import { describe, expect, it } from 'vitest';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { LOOK_GROUPS } from '../src/needs-look/groups.js';
import { LOOK_CAP, type LookSource, type LookWork, needsLook, type NeedsLookRow, ordered, SOURCES } from '../src/needs-look/index.js';
import { overviewSummary } from '../src/overview.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

// Needs a look as a registry: where its rows come from, in which group and order, one line past the
// cap, and the rows only this list has. Overview's tests tell the story the rows make together.

const NOW = Date.UTC(2026, 9, 19, 10);
const golden = (path: string, runId: string): GoldenSource => ({ path, runId, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] });

describe('Needs a look: its registry', () => {
  it('shows its groups in one order, and its sources by group, then by their order in it', () => {
    expect(LOOK_GROUPS.map(([, head]) => head)).toEqual(['Setup', 'Failing', 'Ready to ship', 'Tests', 'Security', 'Housekeeping']);
    expect(ordered(SOURCES).map((s) => `${s.group}:${s.id}`)).toEqual([
      'setup:setup',
      'failing:broken',
      'failing:failedGoldens',
      'failing:presetsFailed',
      'failing:unblamed',
      'failing:openFixes',
      'ship:ready',
      'tests:inconclusiveGoldens',
      'tests:presetsUnsure',
      'tests:coverage',
      'tests:decisions',
      'security:injection',
      'housekeeping:local',
      'housekeeping:retire',
    ]);
  });

  it('refuses two sources with one id', () => {
    const once: LookSource = { id: 'twice', group: 'tests', order: 10, rows: () => [] };
    expect(() => ordered([once, { ...once, order: 20 }])).toThrow('Needs a look has two sources named twice');
  });

  const row = (source: string, i: number): NeedsLookRow => ({ key: `attn:${source}:${i}`, group: 'tests', kind: 'test', icon: 'warn', title: `Row ${i}`, detail: '', step: null, href: '#/tests', runId: null, fixId: null, at: i });
  const many = (id: string, n: number, order = 10): LookSource => ({ id, group: 'tests', order, rows: () => Array.from({ length: n }, (_, i) => row(id, i)) });
  // The sources here read nothing of it.
  const w = {} as LookWork;

  it(`lists ${LOOK_CAP} rows of a source, and one more, then one line for the rest, which the total counts`, () => {
    const whole = needsLook(w, ordered([many('fits', LOOK_CAP + 1)]));
    expect(whole.items).toHaveLength(LOOK_CAP + 1);
    expect(whole.total).toBe(LOOK_CAP + 1);
    const cut = needsLook(w, ordered([many('after', 1, 20), many('long', LOOK_CAP + 3)]));
    expect(cut.items).toHaveLength(LOOK_CAP + 2);
    expect(cut.items[LOOK_CAP]).toMatchObject({ key: 'attn:rest:long', group: 'tests', kind: 'test', icon: 'warn', title: '3 more rows like these', detail: '', href: '#/tests', step: null, more: 3, at: LOOK_CAP });
    expect(cut.items.at(-1)?.key).toBe('attn:after:0');
    expect(cut.total).toBe(LOOK_CAP + 4);
  });
});

describe('Needs a look: the failing runs nobody has blamed', () => {
  it('names one by its id with what it was about, with Run blame, and opens this week’s failed runs', () => {
    const store = Store.open(':memory:');
    try {
      const ask = (text: string) => ({ system: 'You are a support agent.', messages: [{ role: 'user', content: text }] });
      const failed = addRun(store, { startedAt: NOW - 3 * HOUR, status: 'failed', meta: { labels: ['digest'] }, calls: [{ code: 'l', request: ask("Write this week's refund digest and post it to #refunds.") }] });
      const row = overviewSummary(store, { tz: 'UTC', now: NOW }).needsLook.items.find((x) => x.runId === failed);
      // Its label is no name. The page names the run by its id, with its about line on hover.
      expect(row).toMatchObject({
        key: `attn:unblamed:${failed}`,
        group: 'failing',
        kind: 'unblamed',
        title: '1 failing run nobody has blamed',
        about: { text: "Write this week's refund digest and post it to #refunds", from: 'user' },
        // What it failed on, in the words Runs' issues and Fixes' row say it: its agent's exit.
        detail: `${failed.slice(0, 10)} · the agent exited with an error`,
        href: '#/runs?types=failed&from=2026-10-13&to=2026-10-19',
        // Its card names the run it blames, the one run the row stands for.
        step: { of: 'run', runId: failed, step: { label: 'Run blame', sub: `Blames ${failed.slice(0, 10)}: finds the model call that lost it, then joins the fix its failure belongs to` } },
      });
    } finally {
      store.close();
    }
  });

  it('says what the newest failed on as its page does: its first failed check with what it saw', () => {
    const store = Store.open(':memory:');
    try {
      const checks = [{ label: 'send_email called at most 1 time', ok: false, status: 'failed' as const, detail: 'called 2 times' }];
      addRun(store, { startedAt: NOW - 5 * HOUR, status: 'failed', calls: 'l' });
      const newest = addRun(store, { startedAt: NOW - 3 * HOUR, status: 'failed', meta: { checks }, calls: 'l' });
      expect(overviewSummary(store, { tz: 'UTC', now: NOW }).needsLook.items.find((x) => x.kind === 'unblamed')).toMatchObject({ title: '2 failing runs nobody has blamed', detail: `newest ${newest.slice(0, 10)} · send_email called at most 1 time, but called 2 times` });
    } finally {
      store.close();
    }
  });
});

describe('Needs a look: a capture its import judged failed', () => {
  it('counts as a failing run nobody has blamed, as Runs counts it: what its import judged, and Run blame on its page', () => {
    const store = Store.open(':memory:');
    try {
      const judged = { rules: 'r', at: NOW - DAY, verdict: 'failed' as const, why: null, checks: [{ status: 'failed' as const, ok: false, label: 'every issue_refund call: amount <= 100', detail: 'amount was 240' }] };
      const imported = { at: NOW - DAY, from: '/work/cap.jsonl' };
      const capture = addRun(store, { startedAt: NOW - 3 * HOUR, status: 'completed', meta: { imported, covers: ['api'], judged }, calls: 'l' });
      // One its import judged passing is no failure.
      addRun(store, { startedAt: NOW - 2 * HOUR, status: 'completed', meta: { imported, covers: ['api'], judged: { ...judged, verdict: 'passed' as const, checks: [] } }, calls: 'l' });
      const card = `Blames ${capture.slice(0, 10)}: finds the model call that lost it, then joins the fix its failure belongs to`;
      expect(overviewSummary(store, { tz: 'UTC', now: NOW }).needsLook.items.find((x) => x.kind === 'unblamed')).toMatchObject({
        title: '1 failing run nobody has blamed',
        runId: capture,
        detail: `${capture.slice(0, 10)} · every issue_refund call: amount <= 100, but amount was 240`,
        // Its page asks for your command first: the step opens it.
        step: { of: 'link', label: 'Run blame', href: `#/run/${capture}`, title: card },
      });
    } finally {
      store.close();
    }
  });
});

describe('Needs a look: a model the goldens use that retires', () => {
  it('says how the newest migration from it came out and opens it, then the goldens it left to update, and goes once none waits', () => {
    const store = Store.open(':memory:');
    try {
      const sonnet = addRun(store, { startedAt: NOW - DAY, calls: [{ code: 'l', endMeta: { provider: 'anthropic' } }] });
      const goldens = [golden('goldens/refund-flow', sonnet)];
      const migrate = (id: string, at: number, files: boolean) => {
        const passes = { verdict: 'not-run', runs: [{ runId: sonnet, golden: 'goldens/refund-flow', verdict: 'passed', outcome: 'unchanged', verified: false, tally: null }] };
        const data = { migrateId: id, kind: 'migrate', from: ['claude-sonnet-4-5'], to: 'claude-sonnet-5-5', decisions: { runs: [{}] }, passes, set: { fields: [], given: {}, byHand: [] }, configChange: files ? { files: [{ path: 'agent.py', places: 1 }], leftOut: [], review: [] } : null, files: { dir: 'm', patch: files ? 'm/config.patch' : null }, stopReason: null };
        store.putDecisionSession({ sessionId: id, kind: 'migrate', at, change: 'the model claude-sonnet-5-5', actor: null, revision: null, data, runs: [] });
      };
      const row = () => overviewSummary(store, { tz: 'UTC', now: NOW, goldens }).needsLook.items.find((r) => r.kind === 'retire');
      migrate('mg-01M5000000000000000000000A', 1_000, true);
      expect(row()).toMatchObject({ detail: 'checked · the config change is ready', step: null, href: '#/changes/migrate/mg-01M5000000000000000000000A' });
      // The newest migration from it is the one it says: here no file names the model, so nothing is ready to apply.
      migrate('mg-01M5000000000000000000000B', 2_000, false);
      expect(row()).toMatchObject({ detail: 'checked · claude-sonnet-5-5 decided the same in the preview', href: '#/changes/migrate/mg-01M5000000000000000000000B' });
      store.setMigrationApplied('mg-01M5000000000000000000000B', { at: 3_000, by: null, outdated: [{ golden: 'goldens/refund-flow', callNo: 1, path: '$.model' }] });
      expect(row()).toMatchObject({ detail: 'applied · 1 golden to update', step: null });
      const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/refund-flow', '--update'], startedAt: 4_000 });
      store.addTestResult({ sessionId: session.sessionId, golden: 'goldens/refund-flow', ok: true, at: 4_000 });
      expect(row()).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('stands for a migration from the model: Needs a look lists no preview row of it, as it does of one from a model that stays', () => {
    const store = Store.open(':memory:');
    try {
      const sonnet = addRun(store, { startedAt: NOW - DAY, calls: [{ code: 'l', endMeta: { provider: 'anthropic' } }] });
      const goldens = [golden('goldens/refund-flow', sonnet)];
      // A migration whose verify rejected the run it flagged, from the model given.
      const migration = (id: string, at: number, from: string) => {
        const data = { migrateId: id, kind: 'migrate', from: [from], to: 'claude-sonnet-5-5', flagged: [sonnet], decisions: { flagged: [sonnet] }, passes: { verdict: 'rejected', runs: [] } };
        store.putDecisionSession({ sessionId: id, kind: 'migrate', at, change: 'the model claude-sonnet-5-5', actor: null, revision: null, data, runs: [{ runId: sonnet, golden: null, rank: 1, changed: 1, data: { runId: sonnet, golden: null, rank: 1, decisions: [] } }] });
      };
      const previews = () => overviewSummary(store, { tz: 'UTC', now: NOW, goldens }).needsLook.items.filter((r) => r.kind === 'decisions').map((r) => r.key);
      migration('mg-01M5000000000000000000000A', 1_000, 'acme-small-1');
      expect(previews()).toEqual(['attn:decisions:mg-01M5000000000000000000000A']);
      migration('mg-01M5000000000000000000000B', 2_000, 'claude-sonnet-4-5');
      expect(previews()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('names the model, how many goldens use it and when it goes, the soonest first, with Migrate to what replaces it', () => {
    const store = Store.open(':memory:');
    try {
      // A call made through Anthropic's API, with claude-sonnet-4-5 unless it says otherwise.
      const call = (model?: string) => ({ code: 'l', ...(model ? { model } : {}), endMeta: { provider: 'anthropic' } });
      const sonnet = addRun(store, { startedAt: NOW - DAY, calls: [call(), call()] });
      const old = addRun(store, { startedAt: NOW - DAY, calls: [call('claude-3-7-sonnet-20250219')] });
      const preview = addRun(store, { startedAt: NOW - DAY, calls: [call('claude-mythos-preview')] });
      const goldens = [golden('goldens/refund-flow', sonnet), golden('goldens/refund-in-limit', sonnet), golden('goldens/digest', old), golden('goldens/mythos', preview)];
      const rows = overviewSummary(store, { tz: 'UTC', now: NOW, goldens }).needsLook.items.filter((r) => r.kind === 'retire');
      expect(rows.map((r) => [r.title, r.detail])).toEqual([
        ['claude-3-7-sonnet-20250219, used by 1 golden, retired on Feb 19, 2026', 'Anthropic recommends claude-sonnet-5-5'],
        ['claude-sonnet-4-5, used by 2 goldens, retires on Nov 30, 2026', 'in 42 days · Anthropic recommends claude-sonnet-5-5'],
        ['claude-mythos-preview, used by 1 golden, is deprecated', ''],
      ]);
      expect(rows[0]).toMatchObject({ key: 'attn:retire:claude-3-7-sonnet-20250219', group: 'housekeeping', icon: 'retire', href: '#/changes/migrate' });
      expect(rows[1]?.step).toEqual({
        of: 'migrate',
        label: 'Migrate to claude-sonnet-5-5',
        from: ['claude-sonnet-4-5'],
        to: 'claude-sonnet-5-5',
        goldens: ['goldens/refund-flow', 'goldens/refund-in-limit'],
        command: 'shadowlap migrate --to claude-sonnet-5-5 goldens/refund-flow goldens/refund-in-limit --from claude-sonnet-4-5',
      });
      // Nothing to migrate to: no step.
      expect(rows[2]?.step).toBeNull();
      // Advice, keyed by the model: the day it retires (or deprecated, with none) and each golden that calls it.
      expect(rows.map((r) => r.advice)).toEqual([
        { key: 'retire claude-3-7-sonnet-20250219', facts: ['goldens/digest', 'retires 2026-02-19'], until: 'Until a new date or golden, or a migration checks it', dismissed: false },
        { key: 'retire claude-sonnet-4-5', facts: ['goldens/refund-flow', 'goldens/refund-in-limit', 'retires 2026-11-30'], until: 'Until a new date or golden, or a migration checks it', dismissed: false },
        { key: 'retire claude-mythos-preview', facts: ['deprecated', 'goldens/mythos'], until: 'Until a new date or golden, or a migration checks it', dismissed: false },
      ]);
    } finally {
      store.close();
    }
  });

  it('names a model once where its goldens called it through two platforms, with its goldens together', () => {
    const store = Store.open(':memory:');
    try {
      const call = (provider: string) => ({ code: 'l', model: 'gemini-2.0-flash', endMeta: { provider } });
      const api = addRun(store, { startedAt: NOW - DAY, calls: [call('gemini')] });
      const vertex = addRun(store, { startedAt: NOW - DAY, calls: [call('vertex')] });
      const goldens = [golden('goldens/forecast', api), golden('goldens/digest', vertex)];
      const rows = overviewSummary(store, { tz: 'UTC', now: NOW, goldens }).needsLook.items.filter((r) => r.kind === 'retire');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: 'attn:retire:gemini-2.0-flash', title: expect.stringMatching(/^gemini-2\.0-flash, used by 2 goldens, /) });
      expect(rows[0]?.advice).toMatchObject({ key: 'retire gemini-2.0-flash', facts: expect.arrayContaining(['goldens/digest', 'goldens/forecast']) });
    } finally {
      store.close();
    }
  });

  it('names a model once, as the table reads it, where recordings named it with a space or a line break around it', () => {
    const store = Store.open(':memory:');
    try {
      const call = (model: string) => ({ code: 'l', model, endMeta: { provider: 'anthropic' } });
      const goldens = ['claude-sonnet-4-5', 'claude-sonnet-4-5 ', ' claude-sonnet-4-5', 'claude-sonnet-4-5\n'].map((model, i) => golden(`goldens/g${i}`, addRun(store, { startedAt: NOW - DAY, calls: [call(model)] })));
      const rows = overviewSummary(store, { tz: 'UTC', now: NOW, goldens }).needsLook.items.filter((r) => r.kind === 'retire');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        key: 'attn:retire:claude-sonnet-4-5',
        title: 'claude-sonnet-4-5, used by 4 goldens, retires on Nov 30, 2026',
        step: { from: ['claude-sonnet-4-5'], command: 'shadowlap migrate --to claude-sonnet-5-5 goldens/g0 goldens/g1 goldens/g2 goldens/g3 --from claude-sonnet-4-5' },
      });
      expect(rows[0]?.advice).toEqual({ key: 'retire claude-sonnet-4-5', facts: ['goldens/g0', 'goldens/g1', 'goldens/g2', 'goldens/g3', 'retires 2026-11-30'], until: 'Until a new date or golden, or a migration checks it', dismissed: false });
    } finally {
      store.close();
    }
  });

  it('shows a model whose name makes no key, a space inside it, with no Dismiss, rather than failing the list', () => {
    const store = Store.open(':memory:');
    try {
      // A Vertex AI path the table reads past to gemini-2.0-flash.
      const model = 'projects/support agent/locations/us-central1/publishers/google/models/gemini-2.0-flash';
      const run = addRun(store, { startedAt: NOW - DAY, calls: [{ code: 'l', model, endMeta: { provider: 'vertex' } }] });
      const rows = overviewSummary(store, { tz: 'UTC', now: NOW, goldens: [golden('goldens/forecast', run)] }).needsLook.items.filter((r) => r.kind === 'retire');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title.startsWith(`${model}, used by 1 golden, `)).toBe(true);
      expect(rows[0] && 'advice' in rows[0]).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('Needs a look: one cause, one row', () => {
  const GOLDEN = 'goldens/refund-in-limit';
  // A value made anew on every run: its replay diverged on it, so the golden needs a normalizer, not the fix.
  const UUID_CHANGE = { path: '$.metadata.user_id', op: 'changed' as const, before: '3f1c9a2e-5b7d-4e21-9c0a-8d6f2b1e7a43', after: 'b84e07d1-2c9f-4a63-8e15-6f0d3a9c2b78' };

  /** The golden's test replay, failed as `failure` says, in a session of its own. */
  const tested = (store: Store, rec: string, failure: 'exit' | 'diverged', at: number) => {
    const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: at, revision: 'bbbbbbb' }).sessionId;
    const run = addRun(store, { parent: rec, startedAt: at, status: 'failed', calls: failure === 'exit' ? 'rl' : 'r', meta: { test: { golden: GOLDEN, session } } });
    if (failure === 'diverged') store.setDivergence(run, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [UUID_CHANGE] });
    const reason = failure === 'exit' ? 'the agent exited with code 1' : 'diverged at call 1';
    store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure, reason, runId: run, goldenRunId: rec, revision: 'bbbbbbb', at: at + 1 });
    store.finishTestSession(session, { passed: 0, failed: 1, upstreamRequests: 0, endedAt: at + 2 });
    return run;
  };
  const blame = (store: Store, runId: string, at: number) =>
    recordBlame(store, { runId, report: blameReport(runId), expect: EXPECT, scope: null, command: 'c', title: 'refund-in-limit failed', checkText: 'x', at }).fix.fixId;
  const look = (store: Store, rec: string) => {
    const goldens = [golden(GOLDEN, rec)];
    return overviewSummary(store, { tz: 'UTC', now: NOW, goldens, next: { goldens, tests: undefined, normalize: undefined, dir: '/work/project' } }).needsLook.items;
  };
  const stepKey = (x: NeedsLookRow | undefined) => (x?.step?.of === 'run' ? x.step.step.key : (x?.step?.of ?? null));

  it('names a golden an open fix holds on the fix’s row, and a crash’s Find breaking commit leads it', () => {
    const store = Store.open(':memory:');
    try {
      const rec = addRun(store, { startedAt: NOW - DAY, calls: 'lll' });
      const crash = tested(store, rec, 'exit', NOW - 2 * HOUR);
      expect(stepKey(look(store, rec).find((x) => x.kind === 'test'))).toBe('bisect');
      const fixId = blame(store, crash, NOW - HOUR);
      const items = look(store, rec);
      expect(items.find((x) => x.kind === 'test')).toBeUndefined();
      expect(items.find((x) => x.kind === 'open' && x.fixId === fixId)).toMatchObject({
        detail: expect.stringMatching(/ · refund-in-limit fails on Tests$/),
        step: { of: 'run', runId: crash, step: { key: 'bisect', label: 'Find breaking commit…' } },
      });
    } finally {
      store.close();
    }
  });

  it('leads the fix’s row with the crash’s Revert once Find breaking commit named the commit', () => {
    const store = Store.open(':memory:');
    try {
      const rec = addRun(store, { startedAt: NOW - DAY, calls: 'lll' });
      const crash = tested(store, rec, 'exit', NOW - 2 * HOUR);
      const fixId = blame(store, crash, NOW - HOUR);
      recordEvent(store, { kind: 'bisect.found', ref: GOLDEN, at: NOW - HOUR + 1, data: { commit: 'ccccccc', first: { rev: 'ccccccc', subject: 'Log the total', author: 'Ravi', date: '2026-09-30T10:00:00Z' }, why: 'the agent exited with code 1', untested: [], replays: 3, tokens: 0, answered: { at: NOW - 2 * HOUR + 1, ok: false } } });
      expect(look(store, rec).find((x) => x.kind === 'open' && x.fixId === fixId)).toMatchObject({ step: { of: 'run', runId: crash, step: { key: 'revert', label: 'Revert', rev: 'ccccccc', golden: GOLDEN } } });
    } finally {
      store.close();
    }
  });

  it('keeps the row of a golden whose step isn’t its fix’s: a normalizer fixes the test, not the agent', () => {
    const store = Store.open(':memory:');
    try {
      const rec = addRun(store, { startedAt: NOW - DAY, calls: 'lll' });
      const drifted = tested(store, rec, 'diverged', NOW - 2 * HOUR);
      const fixId = blame(store, drifted, NOW - HOUR);
      const items = look(store, rec);
      expect(items.find((x) => x.kind === 'test')).toMatchObject({ key: `attn:failed:${GOLDEN}`, runId: drifted, step: { of: 'run', runId: drifted, step: { key: 'normalizer' } } });
      expect(items.find((x) => x.kind === 'open' && x.fixId === fixId)?.detail).not.toContain('fails on Tests');
    } finally {
      store.close();
    }
  });

  it('holds no golden on a verified fix’s row: the golden keeps its own until the fix is applied', () => {
    const store = Store.open(':memory:');
    try {
      const rec = addRun(store, { startedAt: NOW - DAY, calls: 'lll' });
      const crash = tested(store, rec, 'exit', NOW - 3 * HOUR);
      const fixId = blame(store, crash, NOW - 2 * HOUR);
      const held = makeRun(store, { labels: ['refund-bug'], startedAt: NOW - 3 * HOUR });
      const good = makeRun(store, { labels: ['good'], status: 'completed', startedAt: NOW - 3 * HOUR });
      recordRepair(store, { repairId: 'repair-nl', dir: '.shadowlap/repairs/repair-nl', report: repairReport({ targets: [crash], holdout: [held], good: [good] }), expect: EXPECT, command: 'r', at: NOW - HOUR });
      const items = look(store, rec);
      expect(items.find((x) => x.fixId === fixId && x.kind !== 'test')).toMatchObject({ kind: 'ready', group: 'ship' });
      expect(items.find((x) => x.fixId === fixId && x.kind !== 'test')?.detail).not.toContain('fails on Tests');
      expect(items.find((x) => x.kind === 'test')).toMatchObject({ key: `attn:failed:${GOLDEN}`, runId: crash });
    } finally {
      store.close();
    }
  });
});

describe('Needs a look: a fix’s row, worded and led as its page has it', () => {
  const look = (store: Store) => overviewSummary(store, { tz: 'UTC', now: NOW }).needsLook.items;
  const opened = (store: Store) => {
    const failing = makeRun(store, { labels: ['refund-bug'], startedAt: NOW - 4 * HOUR });
    const fixId = recordBlame(store, { runId: failing, report: blameReport(failing), expect: EXPECT, scope: null, command: 'c', title: 'Refunds above the limit issued without approval', checkText: 'x', at: NOW - 3 * HOUR }).fix.fixId;
    return { failing, fixId };
  };

  it('says a change made by hand, which no repair names, with what verify made of it', () => {
    const store = Store.open(':memory:');
    try {
      const { failing, fixId } = opened(store);
      recordVerdict(store, { report: { ...verifyReport([{ runId: failing, role: 'target', pass: true }]), verdict: 'incomplete' }, expect: EXPECT, command: 'shadowlap verify --fix x', at: NOW - HOUR, fixIds: [fixId] });
      expect(look(store).find((x) => x.fixId === fixId)).toMatchObject({ kind: 'open', detail: expect.stringMatching(/^lost at model call #\d+ · changed by hand, verify inconclusive$/) });
    } finally {
      store.close();
    }
  });

  it('gives a verified fix whose patch `fix apply` refuses no step to apply it with, as its page applies none', () => {
    const lead = (file: string | null) => {
      const store = Store.open(':memory:');
      try {
        const { failing, fixId } = opened(store);
        const held = makeRun(store, { labels: ['refund-bug'], startedAt: NOW - 4 * HOUR });
        const good = makeRun(store, { labels: ['good'], status: 'completed', startedAt: NOW - 4 * HOUR });
        const report = repairReport({ targets: [failing], holdout: [held], good: [good] });
        // A patch whose candidate names a path outside the repository: `fix apply` refuses it.
        if (file) report.candidates.find((c) => c.id === report.accepted)!.file = file;
        recordRepair(store, { repairId: 'repair-nl', dir: '.shadowlap/repairs/repair-nl', report, expect: EXPECT, command: 'r', at: NOW - HOUR });
        const row = look(store).find((x) => x.fixId === fixId);
        expect(row).toMatchObject({ kind: 'ready', group: 'ship' });
        return row!.step;
      } finally {
        store.close();
      }
    };
    expect(lead(null)).toMatchObject({ of: 'fix', lead: { key: 'apply', label: 'Apply fix' } });
    expect(lead('../agent.mjs')).toBeNull();
  });
});

describe('Needs a look: an inconclusive golden', () => {
  it('re-runs one whose injection gate showed too little to say, its card saying why as its run’s page does', () => {
    const store = Store.open(':memory:');
    try {
      const path = 'goldens/refund';
      const rec = addRun(store, { startedAt: NOW - DAY, calls: 'lll' });
      const session = store.startTestSession({ command: ['shadowlap', 'test', path], startedAt: NOW - 2 * HOUR, revision: 'bbbbbbb' }).sessionId;
      const run = addRun(store, { parent: rec, startedAt: NOW - 2 * HOUR, status: 'completed', calls: 'rrr', meta: { test: { golden: path, session } } });
      const injection = { resultId: null, attempts: 6, obeyed: 0, influenced: 0, ignored: 2, inconclusive: 4, allowed: { obeyed: 0, influenced: null }, verdict: 'inconclusive' as const, reason: 'only 2 of 6 attempts decided', skipped: null };
      store.addTestResult({ sessionId: session, golden: path, ok: false, failure: 'injection', reason: 'its injection gate showed too little to say', runId: run, goldenRunId: rec, revision: 'bbbbbbb', at: NOW - HOUR, data: { verdict: 'inconclusive', injection } });
      const goldens = [golden(path, rec)];
      expect(overviewSummary(store, { tz: 'UTC', now: NOW, goldens }).needsLook.items.find((x) => x.kind === 'test')).toMatchObject({
        group: 'tests',
        name: 'refund',
        step: { of: 'rerun', label: 'Re-run test', sub: 'Its injection gate showed too little to say: only 2 of 6 attempts decided', command: expect.stringContaining('test goldens/refund') },
      });
    } finally {
      store.close();
    }
  });
});

describe('Needs a look: a golden whose checks changed since its last test', () => {
  it('leads with Run tests, as its run’s page does, its line saying so, failed or inconclusive', () => {
    const store = Store.open(':memory:');
    try {
      const path = 'goldens/refund';
      const rec = addRun(store, { startedAt: NOW - DAY, calls: 'lll' });
      const tested = (verdict: 'failed' | 'inconclusive', at: number) => {
        const session = store.startTestSession({ command: ['shadowlap', 'test', path], startedAt: at, revision: 'bbbbbbb' }).sessionId;
        const run = addRun(store, { parent: rec, startedAt: at, status: verdict === 'failed' ? 'failed' : 'completed', calls: 'rrr', meta: { test: { golden: path, session } } });
        const check = verdict === 'failed' ? { label: 'issue_refund called 0 times', ok: false, status: 'failed' as const, detail: 'called 1 time' } : { label: 'judge "explains" answers yes', ok: false, status: 'inconclusive' as const, detail: 'not judged: no recorded verdict and the test runs offline' };
        store.addTestResult({ sessionId: session, golden: path, ok: false, failure: 'check', reason: `check ${verdict}: ${check.label}`, runId: run, goldenRunId: rec, revision: 'bbbbbbb', at: at + 1, data: { verdict, checks: [check] } });
        store.finishTestSession(session, { passed: 0, failed: 1, upstreamRequests: 0, endedAt: at + 2 });
        return run;
      };
      // The config holds neither check now: each changed since the test that judged it.
      const goldens = [golden(path, rec)];
      const look = () => overviewSummary(store, { tz: 'UTC', now: NOW, goldens, next: { goldens, tests: undefined, normalize: undefined, dir: '/work/project' } }).needsLook.items.find((x) => x.kind === 'test');
      const failed = tested('failed', NOW - 3 * HOUR);
      expect(look()).toMatchObject({ group: 'failing', detail: expect.stringMatching(/ · checks changed since$/), step: { of: 'run', runId: failed, step: { key: 'run-tests', label: 'Run tests' } } });
      const unsure = tested('inconclusive', NOW - HOUR);
      expect(look()).toMatchObject({ group: 'tests', detail: expect.stringMatching(/ · checks changed since$/), step: { of: 'run', runId: unsure, step: { key: 'run-tests', label: 'Run tests' } } });
    } finally {
      store.close();
    }
  });
});
