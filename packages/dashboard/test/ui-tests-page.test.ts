import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGate, Store, type StoredCheck } from '@shadowlap/engine';
import { testsView, type GoldenSource } from '../src/tests.js';
import type { Client, TestsView } from '../ui/api.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Tests tells the truth about checks and CI: each check is marked by how the golden's last result
 * came out on it (no tick on one that failed, none at all before a result), and the page says CI
 * replays goldens offline and runs those marked fork live, with the one documented command.
 */

const T0 = Date.UTC(2026, 9, 20, 10, 0);
const JUDGE = 'judge "explains-escalation" answers yes';
const passed = (label: string): StoredCheck => ({ ok: true, status: 'passed', label, detail: null });

const golden = (path: string, checks: string[], over: Partial<GoldenSource> = {}): GoldenSource => ({ path, runId: null, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks, ...over });
const GOLDENS: GoldenSource[] = [
  golden('goldens/passes', ['escalate called 1 time']),
  golden('goldens/refunds', ['issue_refund called 1 time', 'send_email called 1 time']),
  golden('goldens/judged', ['escalate called 1 time', JUDGE]),
  golden('goldens/budget', ['at most 29000 input tokens'], { mode: 'fork', gate: parseGate({ baseline: 'history' }, 'gate') }),
];

function view(goldens: GoldenSource[]): TestsView {
  const s = Store.open(':memory:');
  const session = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', startedAt: T0 });
  const result = (golden: string, ok: boolean, data: NonNullable<Parameters<Store['addTestResult']>[0]['data']>, failure?: 'check' | 'inconclusive') => s.addTestResult({ sessionId: session.sessionId, golden, ok, ...(failure ? { failure } : {}), reason: ok ? null : 'failed', runId: null, revision: 'd2e8a1f', at: T0 + 1, data });
  result('goldens/passes', true, { mode: 'replay', verdict: 'passed', checks: [passed('escalate called 1 time')] });
  result('goldens/refunds', false, { mode: 'replay', verdict: 'failed', checks: [{ ok: false, status: 'failed', label: 'issue_refund called 1 time', detail: 'called 0 times; tools called: add_note' }, { ok: false, status: 'failed', label: 'send_email called 1 time', detail: 'called 0 times; tools called: add_note' }] }, 'check');
  const judge = { name: 'explains-escalation', model: 'claude-haiku-4-5', of: 'answer' as const, verdict: null, source: null, cost: null, redactions: 0, cut: 0 };
  result('goldens/judged', false, { mode: 'replay', verdict: 'inconclusive', checks: [passed('escalate called 1 time'), { ok: false, status: 'inconclusive', label: JUDGE, detail: 'not judged: no recorded verdict and the test runs offline', judge }] }, 'inconclusive');
  s.finishTestSession(session.sessionId, { passed: 1, failed: 1, upstreamRequests: 0, endedAt: T0 + 100 });
  const v = testsView(s, goldens);
  s.close();
  return v;
}

function page(started: Array<{ kind: string; fields: Record<string, unknown> }>, goldens: GoldenSource[]) {
  const v = view(goldens);
  const client = {
    tests: () => Promise.resolve(v),
    jobs: () => Promise.resolve([]),
    startJob: (kind: string, fields: Record<string, unknown>) => {
      started.push({ kind, fields });
      return Promise.resolve({ id: 'j1' });
    },
  } as unknown as Client;
  const app = {
    client,
    exported: false,
    meta: null,
    tick: 0,
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    registerLayer: () => () => undefined,
  };
  return createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(TestsPage));
}

const g = globalThis as { location?: unknown };
let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  delete g.location;
});

async function open(started: Array<{ kind: string; fields: Record<string, unknown> }> = [], goldens = GOLDENS) {
  g.location = { hash: '#/tests' };
  r = await render(page(started, goldens));
  await r.until('the goldens to load', () => r!.all('table.gt tbody tr').length === goldens.length);
  return r;
}

/** The one element under `el` the selector matches. */
function one(el: FakeElement, selector: string): FakeElement {
  const found = el.querySelectorAll(selector);
  if (found.length !== 1) throw new Error(`${found.length} elements match ${selector}`);
  return found[0]!;
}
const all = (el: FakeElement, selector: string) => el.querySelectorAll(selector);

/** The checks of a golden's row, as the Checks column shows them: each one's class, mark and words. */
function checks(page: Rendered, name: string) {
  const tr = page.all('table.gt tbody tr').find((row) => all(row, 'code')[0]!.textContent === name)!;
  return all(one(tr, 'td.chk'), '.ck').map((ck) => ({ cls: ck.className, mark: all(ck, 'b.cm')[0]?.textContent ?? null, words: one(ck, '.cw').textContent }));
}

describe('the Tests page', () => {
  it('marks each check by its last status: no tick on one that failed or couldn\'t be decided, none before a result', async () => {
    const page = await open();
    expect(checks(page, 'passes')).toEqual([{ cls: 'ck passed', mark: '✓', words: 'escalate called once' }]);
    expect(checks(page, 'refunds')).toEqual([
      { cls: 'ck failed', mark: '✗', words: 'issue_refund called oncecalled 0 times; tools called: add_note' },
      { cls: 'ck failed', mark: '✗', words: 'send_email called oncecalled 0 times; tools called: add_note' },
    ]);
    expect(checks(page, 'judged')[1]).toEqual({ cls: 'ck inconclusive', mark: '?', words: `${JUDGE}not judged: no recorded verdict and the test runs offline` });
    expect(checks(page, 'budget')).toEqual([{ cls: 'ck', mark: null, words: 'input tokens ≤ 29,000' }]);
    // Each mark says its status to a screen reader.
    expect(page.all('table.gt td.chk b.cm').map((b) => b.getAttribute('aria-label'))).toEqual(['passed', 'failed', 'failed', 'passed', 'inconclusive']);
  });

  it('says CI runs replay goldens offline and fork goldens live, with the one command docs/gating.md has, to copy', async () => {
    const page = await open();
    expect(page.one('.ph p').textContent).toBe('Every golden CI runs, and how it did at each revision.');
    expect(page.all('button').map((b) => b.textContent.trim())).not.toContain('Copy CI command');
    const ci = page.all('section.panel').find((s) => all(s, 'h2').some((h) => h.textContent === 'In CI'))!;
    expect(ci.textContent).toContain('Replay goldens run offline and need no key. A golden marked fork runs live from where it forks, and needs the providers’ keys. A divergence, a non-zero exit, no calls, or a check or gate that fails or can’t decide fails a golden.');
    expect(ci.textContent).not.toContain('throwaway store');
    expect(one(ci, '.cmdline').textContent).toBe(`$shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`);
    expect(all(ci, 'button').map((b) => b.textContent.trim())).toEqual(['Copy']);
    // budget has a gate against history: CI must keep the store between runs.
    expect(ci.textContent).toContain('A gate against history needs the store kept between runs: the Action’s keep-history does it, or cache .shadowlap/shadowlap.db.');
    expect(page.document.body.textContent).toContain('A golden whose checks say what the agent must do is also a task a model can be scored on.');
  });

  it('says an injection test runs live too, and needs the keys, when a golden has one', async () => {
    const page = await open([], GOLDENS.map((x) => (x.path === 'goldens/passes' ? { ...x, injection: true } : x)));
    const ci = page.all('section.panel').find((s) => all(s, 'h2').some((h) => h.textContent === 'In CI'))!;
    expect(all(ci, 'p.muted')[0]!.textContent).toBe('Replay goldens run offline and need no key. A golden marked fork runs live from where it forks, and an injection test from each payload it plants: both need the providers’ keys. A divergence, a non-zero exit, no calls, or a check or gate that fails or can’t decide fails a golden.');
  });
});

describe('the Tests page\'s styles', () => {
  const css = readFileSync(new URL('../ui/app.css', import.meta.url), 'utf8');

  it('put no tick before a check whatever its result, Training\'s criteria included', () => {
    expect(css).not.toMatch(/\.chk span::before/);
    expect(css).toMatch(/table\.gt \.chk \.ck\.failed \.cm \{ color: var\(--err\); \}/);
    expect(css).toMatch(/table\.gt \.chk \.ck\.inconclusive \.cm \{ color: var\(--warn\); \}/);
  });
});
