import { Store } from '@shadowlap/engine';
import { describe, expect, it } from 'vitest';
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
        detail: `${failed.slice(0, 10)} · failed`,
        href: '#/runs?types=failed&from=2026-10-13&to=2026-10-19',
        // Its card names the run it blames, the one run the row stands for.
        step: { of: 'run', runId: failed, step: { label: 'Run blame', sub: `Blames ${failed.slice(0, 10)}: finds the model call that lost it, then joins the fix its failure belongs to` } },
      });
    } finally {
      store.close();
    }
  });
});

describe('Needs a look: a model the goldens use that retires', () => {
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
      expect(rows[0]).toMatchObject({ key: 'attn:retire:claude-3-7-sonnet-20250219', group: 'housekeeping', icon: 'retire', href: '#/changes' });
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
    } finally {
      store.close();
    }
  });
});
