import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACK_FORMAT, Store, type RunRecord } from '@shadowlap/engine';
import { RunBuilder, text, toolUse, user } from '../../engine/test/run-fixtures.js';
import { PRESETS_READS, presetsRowPrice, type PresetsPlan, type PresetsPlanJob } from '../src/presets-plan.js';
import { withPresetsEntries } from '../src/presets-entries.js';
import type { PresetsSummary } from '../src/chaos.js';
import type { GoldenRow } from '../src/tests.js';
import { estimateOf, pricingOf } from '../src/pricing.js';
import type { OutcomeWork } from '../src/run-outcome.js';

/**
 * Run error-path presets…'s plan, the pooled read its dialog asks: the recording and golden the
 * presets run on, the tools they can hit, what judges and decides them, the command someone else
 * recorded, and what the picks bill, each worked out as the CLI would run them.
 */

/** A refund agent's recording: it reads the order (#2), then refunds (#4). */
function recording(store: Store, meta: RunRecord['meta'] = {}): string {
  const b = RunBuilder.start(store, { meta });
  b.model({ messages: [user('refund order 7')] }, [toolUse('lookup_order', { id: 7 }, 'a')]);
  b.tool('lookup_order', { id: 7 }, { amount: 40 }, { effect: 'read' });
  b.model({ messages: [user('refund order 7')] }, [toolUse('issue_refund', { id: 7 }, 'b')]);
  b.tool('issue_refund', { id: 7 }, { ok: true }, { effect: 'write' });
  b.model({ messages: [user('refund order 7')] }, [text('refunded')]);
  return b.end();
}

/** The config's version is its bytes' hash: a thread keeps what it parsed under it. */
const work = (tests: Record<string, unknown>, goldens: OutcomeWork['goldens'] = []): OutcomeWork => ({ version: JSON.stringify(tests), tests, dir: '/project', goldens });

async function plan(store: Store, job: Omit<PresetsPlanJob, 'kind' | 'shared'> & { shared?: boolean }): Promise<PresetsPlan> {
  const a = await PRESETS_READS['presets-plan'](store, { kind: 'presets-plan', shared: false, ...job }, { whole: true });
  expect(a.status, String(a.body)).toBe(200);
  return JSON.parse(String(a.body)) as PresetsPlan;
}

describe("Run error-path presets…'s plan", () => {
  it("prefills a run's own failed write limit, and runs the defaults judged on the exit alone", async () => {
    const store = Store.open(':memory:');
    try {
      // Its --expect said no refund, and it refunded: the field starts with that bound.
      const run = recording(store, { expect: { tools: { issue_refund: 0 } } });
      const p = await plan(store, { runId: run, work: work({}) });
      expect(p).toMatchObject({
        target: run,
        golden: null,
        presets: ['timeout', 'empty', 'malformed', 'oversized', '429', '500'],
        choices: [{ name: 'lookup_order', callNo: 2, effect: 'read' }, { name: 'issue_refund', callNo: 4, effect: 'write' }],
        tool: 'lookup_order',
        at: { tool: { callNo: 2, name: 'lookup_order' }, model: { callNo: 3 } },
        judge: { source: 'exit', checks: [], from: null },
        expect: '{"tools":{"issue_refund":"<= 0"}}',
        gate: { repeat: 1, passes: 1 },
        rule: '1 of 1 attempt must pass',
        runsHere: null,
      });
      // Another tool moves where the tool presets hit, and the model call after it.
      expect((await plan(store, { runId: run, work: work({}), tool: 'issue_refund' })).at).toMatchObject({ tool: { callNo: 4, name: 'issue_refund' }, model: { callNo: 5 } });
      // A bound that held asks nothing new: no prefill.
      const held = recording(store, { expect: { tools: { issue_refund: '<= 1' } } });
      expect((await plan(store, { runId: held, work: work({}) })).expect).toBeNull();
    } finally {
      store.close();
    }
  });

  it("runs a golden's recording as its golden: its presets, its write limits and its gate", async () => {
    const store = Store.open(':memory:');
    try {
      const rec = recording(store);
      const goldens = [{ path: 'goldens/refund', runId: rec, packedAt: null }];
      const entry = { expect: { tools: { issue_refund: '<= 1', lookup_order: 1 } }, repeat: 3, passes: 2 };
      const p = await plan(store, { runId: rec, work: work({ 'goldens/refund': entry }, goldens) });
      expect(p).toMatchObject({ target: rec, golden: 'goldens/refund', judge: { source: 'write-limits', checks: ['issue_refund called at most 1 time'], from: "the write limits of the golden's expect" }, expect: null, gate: { repeat: 3, passes: 2 }, rule: '2 of 3 attempts must pass' });
      // Its chaos.gate decides, and its presets are the ones the command runs.
      const gated = await plan(store, { runId: rec, work: work({ 'goldens/refund': { ...entry, chaos: { presets: ['429', 'timeout'], gate: { good: 0.9, bad: 0.7, risk: 0.05, max: 20 } } } }, goldens) });
      expect(gated).toMatchObject({ presets: ['timeout', '429'], gate: { good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, rule: 'tells 90%+ from 70%- at <= 5% risk, up to 20 attempts' });
      expect(gated.estimate).toMatchObject({ kind: 'presets' });
      // The fork menu's row bills what the dialog first asks: its presets under its gate.
      const row = presetsRowPrice(store, store.getRun(rec)!, work({ 'goldens/refund': { ...entry, chaos: { presets: ['429', 'timeout'], gate: { good: 0.9, bad: 0.7, risk: 0.05, max: 20 } } } }, goldens));
      expect(JSON.parse(JSON.stringify(await estimateOf(row!, pricingOf(store, undefined))))).toEqual(gated.estimate);
      // "chaos": false leaves it out of test --chaos: its presets run as a run's.
      expect((await plan(store, { runId: rec, work: work({ 'goldens/refund': { ...entry, chaos: false } }, goldens) })).golden).toBeNull();
      // A pack the repository doesn't track runs its recorded command here, read from the pack beside the server.
      const project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-presets-plan-')));
      try {
        mkdirSync(join(project, 'goldens', 'refund'), { recursive: true });
        writeFileSync(join(project, 'goldens', 'refund', 'run.json'), JSON.stringify({ format: PACK_FORMAT, runs: [{ runId: rec, command: { argv: ['node', 'refund.mjs'] } }] }));
        const sent = { ...work({ 'goldens/refund': entry }, goldens), dir: project };
        expect((await plan(store, { runId: rec, work: sent })).runsHere).toEqual({ command: 'node refund.mjs', from: "a pack this repository doesn't track", by: null });
        // Once the repository tracks it, it runs as one of the project's own.
        execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'ignore' });
        execFileSync('git', ['add', '-f', '--', 'goldens/refund/run.json'], { cwd: project, stdio: 'ignore' });
        expect((await plan(store, { runId: rec, work: sent })).runsHere).toBeNull();
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    } finally {
      store.close();
    }
  });

  it("judges a test's replay by its golden's entry, and by --expect alone once the field has checks", async () => {
    const store = Store.open(':memory:');
    try {
      // A replay a test made of the golden is tied to its entry (meta.test.golden).
      const rec = recording(store, { test: { golden: 'goldens/refund', session: 'T1' } });
      const tests = { 'goldens/refund': { expect: { tools: { issue_refund: '<= 1' } }, repeat: 2, passes: 2 } };
      expect(await plan(store, { runId: rec, work: work(tests) })).toMatchObject({ golden: null, judge: { source: 'write-limits' }, gate: { repeat: 2, passes: 2 } });
      expect(await plan(store, { runId: rec, work: work(tests), expect: true })).toMatchObject({ golden: null, judge: { source: '--expect' }, gate: { repeat: 1, passes: 1 } });
    } finally {
      store.close();
    }
  });

  it('names the command someone else recorded, and who, only where names show', async () => {
    const store = Store.open(':memory:');
    try {
      const run = recording(store, { imported: { at: 1, from: 'prod.har' }, author: 'dana@example.com' });
      expect((await plan(store, { runId: run, work: work({}) })).runsHere).toMatchObject({ from: 'an imported pack', by: null });
      expect((await plan(store, { runId: run, work: work({}), shared: true })).runsHere).toMatchObject({ from: 'an imported pack', by: 'dana@example.com' });
      expect((await PRESETS_READS['presets-plan'](store, { kind: 'presets-plan', runId: 'nope', work: null, shared: false }, { whole: true })).status).toBe(404);
    } finally {
      store.close();
    }
  });
});

describe('a golden whose tests entry sets its error-path presets, on Tests', () => {
  const row = (path: string, o: Partial<GoldenRow> = {}) => ({ path, source: { kind: 'run', runId: `R-${path}` }, presets: null, ...o }) as unknown as GoldenRow;
  const flags = (tests: Record<string, unknown>, rows: GoldenRow[]) => withPresetsEntries({ rows }, work(tests)).rows.map((r) => [r.path, r.presetsEntry ?? false]);

  it('is flagged, through the entry its folder matches, until its presets have run', () => {
    const rows = [row('goldens/inbox'), row('goldens/refund-a'), row('goldens/off'), row('goldens/plain'), row('goldens/ran', { presets: {} as PresetsSummary }), row('goldens/pack', { source: { kind: 'pack', packedAt: 1 } })];
    const tests = {
      'goldens/inbox': { chaos: { presets: ['timeout'] } },
      'goldens/refund-*': { chaos: {} },
      'goldens/off': { chaos: false },
      'goldens/plain': { expect: { tools: { issue_refund: 0 } } },
      'goldens/ran': { chaos: {} },
      'goldens/pack': { chaos: {} },
    };
    expect(flags(tests, rows)).toEqual([
      ['goldens/inbox', true],
      ['goldens/refund-a', true],
      ['goldens/off', false],
      ['goldens/plain', false],
      ['goldens/ran', false],
      ['goldens/pack', false],
    ]);
    // An entry the CLI would refuse refuses the config, as every command reads it: nothing is offered.
    expect(flags({ ...tests, 'goldens/bad': { chaos: { presets: ['no-such-preset'] } } }, rows).filter(([, f]) => f)).toEqual([]);
    // Outside a project, nothing is read.
    expect(withPresetsEntries({ rows }, null).rows).toBe(rows);
  });
});
