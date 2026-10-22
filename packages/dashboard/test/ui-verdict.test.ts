import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { gateResult, Store, type TestResultData } from '@shadowlap/engine';
import { testsView, type GoldenSource } from '../src/tests.js';
import type { Client, TestsView } from '../ui/api.js';
import { dotParts } from '../ui/components/Verdict.js';
import { ActivityCard, NeedsLook } from '../ui/overview/panels.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ActivityItem, NeedsLookRow } from '../ui/types.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Decision 9 on every page: a gate's verdict is its word, its tally and its Wilson bound, broken only
 * after a dot, and its rule is stated once (under Tests' table) or on the line's hover (Needs a look,
 * Activity), never on every row and never cut off mid-figure.
 */

const SPRT = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 20 };
const RULE = 'gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts';

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

/** The text a hover card shows for an element: its title and the line under it. */
const tip = (el: FakeElement): { t: string; s?: string } | null => {
  const raw = el.getAttribute('data-tip');
  return raw ? (JSON.parse(raw) as { t: string; s?: string }) : null;
};

describe('a gate’s verdict line', () => {
  it('breaks only after a dot, each short part kept whole with its dot', () => {
    expect(dotParts('failed · 4 of 8 · rate <= 0.78 (95%) · against 0.94 over the last 10 sessions (47 of 50)')).toEqual([
      { text: 'failed ·', keep: 'whole' },
      { text: '4 of 8 ·', keep: 'whole' },
      { text: 'rate <= 0.78 (95%) ·', keep: 'whole' },
      // Longer than a line can hold whole: it may wrap, between its words.
      { text: 'against 0.94 over the last 10 sessions (47 of 50)', keep: null },
    ]);
    // A narrow column keeps short parts whole, and a longer bound whole but on a phone.
    expect(dotParts('16 of 20 · rate 0.58 to 0.92 (95%)', 18, 24)).toEqual([
      { text: '16 of 20 ·', keep: 'whole' },
      { text: 'rate 0.58 to 0.92 (95%)', keep: 'soft' },
    ]);
  });
});

describe('Needs a look and Activity', () => {
  const gated: NeedsLookRow = { kind: 'test', icon: 'fail', title: 'A test failed: eval-pushy', detail: 'failed · 4 of 8 · rate <= 0.78 (95%)', rule: RULE, action: 'Fix', href: '#/tests', runId: null, fixId: null, at: 1 };
  const plain: NeedsLookRow = { kind: 'unblamed', icon: 'fail', title: 'A run failed: 01M5GRZKRY', detail: 'Write this week’s refund digest · not blamed yet', action: 'Run blame', href: '#/run/01M5GRZKRY', runId: '01M5GRZKRY', fixId: null, at: 2 };

  it('says a gate’s verdict whole, each figure unbroken, with its rule on the row’s hover', async () => {
    r = await render(createElement(NeedsLook, { items: [gated, plain], total: 2 }));
    const [row, other] = r.all('.attn a');
    const d = row!.querySelector('.d')!;
    expect(d.className).toBe('d gv');
    expect(d.textContent).toBe('failed · 4 of 8 · rate <= 0.78 (95%)');
    expect(d.querySelectorAll('.nw').map((s) => s.textContent)).toEqual(['failed ·', '4 of 8 ·', 'rate <= 0.78 (95%)']);
    // The rule is on the hover, under the golden, and in no line.
    expect(tip(row!)?.t).toBe('eval-pushy');
    expect(tip(row!)?.s?.replace(/\u00a0/g, ' ')).toBe(RULE);
    expect(r.document.body.textContent).not.toContain('gate:');
    // A line no gate decided keeps its words as they are, with no hover of a rule.
    expect(other!.querySelector('.d')!.className).toBe('d');
    expect(tip(other!)).toBeNull();
  });

  it('gives a gate’s entry its rule on hover, and leaves an entry with nowhere to go a plain row', async () => {
    const items: ActivityItem[] = [
      { id: 'a', at: 3, kind: 'fail', text: 'Test failed · eval-pushy: failed · 4 of 8 · rate <= 0.78 (95%)', runId: '01M5GRZKRYAAAAAAAAAAAAAAAA', href: '#/run/01M5GRZKRYAAAAAAAAAAAAAAAA', rule: RULE },
      // A preview of a change: no page shows it, so it links nowhere, not back to the Overview.
      { id: 'b', at: 2, kind: 'fork', text: 'Previewed the model claude-haiku-4-5 on 1 run · 1 with a write, stop or judged change' },
      { id: 'c', at: 1, kind: 'rec', text: 'Recorded 9 calls', runId: '01M5GRZK3PG7SR16CB2T3CFE21' },
    ];
    r = await render(createElement(ActivityCard, { items, now: 10, byPerson: false, live: [] }));
    const links = r.all('.feed a');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/run/01M5GRZKRYAAAAAAAAAAAAAAAA', '#/run/01M5GRZK3PG7SR16CB2T3CFE21']);
    expect(tip(links[0]!)?.t).toBe('Test failed · eval-pushy');
    expect(tip(links[0]!)?.s?.replace(/\u00a0/g, ' ')).toBe(RULE);
    expect(links[0]!.querySelector('.w')!.className).toBe('w gv');
    const rows = r.all('.feed .plain');
    expect(rows.map((x) => x.textContent)).toEqual([expect.stringContaining('Previewed the model claude-haiku-4-5 on 1 run')]);
    expect(r.all('.feed a[href="#/"]')).toEqual([]);
  });
});

describe('Tests’ Last result', () => {
  const goldens: GoldenSource[] = [
    { path: 'goldens/escalates', runId: null, packedAt: 1, mode: 'fork', repeat: 1, passes: 1, gate: SPRT, checks: ['issue_refund called 0 times'] },
    { path: 'goldens/flaky', runId: null, packedAt: 1, mode: 'fork', repeat: 1, passes: 1, gate: SPRT, checks: ['issue_refund called 0 times'] },
    { path: 'goldens/plain', runId: null, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] },
  ];
  const result = (outcomes: boolean[]): TestResultData => {
    const g = gateResult(SPRT, outcomes);
    return { mode: 'fork', attempts: { total: outcomes.length, passed: g.passes, required: null, runs: [] }, verdict: g.decision === 'pass' ? 'passed' : g.decision === 'fail' ? 'failed' : 'inconclusive', gate: g };
  };

  function view(): TestsView {
    const store = Store.open(':memory:');
    try {
      const t = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'a1b2c3d', startedAt: 100 });
      store.addTestResult({ sessionId: t.sessionId, golden: 'goldens/escalates', ok: true, runId: null, revision: 'a1b2c3d', at: 101, data: result(Array(12).fill(true)) });
      const unsure = [...Array(16).fill(true), false, false, false, false];
      store.addTestResult({ sessionId: t.sessionId, golden: 'goldens/flaky', ok: false, failure: 'inconclusive', reason: 'inconclusive', runId: null, revision: 'a1b2c3d', at: 102, data: result(unsure) });
      store.addTestResult({ sessionId: t.sessionId, golden: 'goldens/plain', ok: true, runId: null, revision: 'a1b2c3d', at: 103, data: { mode: 'replay' } });
      store.finishTestSession(t.sessionId, { passed: 2, failed: 0, upstreamRequests: 0, endedAt: 110 });
      return testsView(store, goldens) as unknown as TestsView;
    } finally {
      store.close();
    }
  }

  function page(v: TestsView) {
    const client = { tests: () => Promise.resolve(v), jobs: () => Promise.resolve([]) } as unknown as Client;
    const app = { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, registerLayer: () => () => undefined };
    return createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(TestsPage));
  }

  it('shows the verdict word, the tally and the bound with the interval’s bar, and each gate’s rule once under the table', async () => {
    const g = globalThis as { location?: unknown };
    g.location = { hash: '#/tests' };
    try {
      r = await render(page(view()));
      await r.until('the goldens to load', () => r!.all('td.glast').length === 3);
      const [escalates, flaky, plain] = r.all('td.glast');
      expect(escalates!.querySelector('.st')!.textContent).toBe('passed');
      expect(escalates!.querySelector('.rsub')!.textContent).toBe('12 of 12 · rate >= 0.76 (95%)');
      expect(escalates!.querySelectorAll('.rsub .nw').map((s) => s.textContent)).toEqual(['12 of 12 ·', 'rate >= 0.76 (95%)']);
      expect(flaky!.querySelectorAll('.rsub .kc').map((s) => s.textContent)).toEqual(['rate 0.58 to 0.92 (95%)']);
      expect(escalates!.querySelector('.gev .wib')!.className).toBe('wib ok');
      expect(escalates!.querySelector('.gev small')!.textContent).toBe('against .70 and .90');
      expect(flaky!.querySelector('.st')!.textContent).toBe('inconclusive');
      expect(flaky!.querySelector('.rsub')!.textContent).toBe('16 of 20 · rate 0.58 to 0.92 (95%)');
      expect(flaky!.querySelector('.gev .wib')!.className).toBe('wib y');
      // A golden no gate decided: its line as before, and no bar.
      expect(plain!.querySelector('.gev')).toBeNull();
      // The rule, once for both goldens it decided, beside their mode; no row repeats it.
      const rules = r.all('.gfoot p').map((p) => [p.querySelector('.chip')!.textContent, p.children[1]!.textContent]);
      expect(rules.map(([mode, rule]) => [mode, rule!.replace(/\u00a0/g, ' ')])).toEqual([['fork · gate', RULE]]);
      // Each figure keeps its words where the rule wraps.
      expect(rules[0]![1]).toContain('tells\u00a090%+\u00a0from\u00a070%- at\u00a0<=\u00a05%\u00a0risk, up\u00a0to\u00a020\u00a0attempts');
      expect(r.all('table.gt td').filter((td) => td.textContent.includes('gate:'))).toEqual([]);
    } finally {
      delete g.location;
    }
  });
});
