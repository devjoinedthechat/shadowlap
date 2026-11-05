import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGate, Store, type StoredCheck } from '@shadowlap/engine';
import { testsView, type GoldenSource } from '../src/tests.js';
import type { Client, TestsView } from '../ui/api.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { AppContext, type AppState } from '../ui/state.js';
import { sheet } from './css-sheet.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Tests tells the truth about checks, CI and judges: each check is marked by how the golden's last
 * result came out on it (no tick on one that failed, none at all before a result), the page says CI
 * replays goldens offline and runs those marked fork live, with the one documented command, and a
 * judge a replay golden couldn't ask offline is settled by Update golden, which asks first. The
 * table keeps Last result on screen at every width, by the container queries the mock's .gtw has.
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
  return found[0];
}
const all = (el: FakeElement, selector: string) => el.querySelectorAll(selector);

/** The checks of a golden's row, as the Checks column shows them: each one's class, mark and words. */
function checks(page: Rendered, name: string) {
  const tr = page.all('table.gt tbody tr').find((row) => all(row, 'code')[0].textContent === name)!;
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

  it('marks no check added to the config since the last test, and says so under it', async () => {
    const page = await open([], GOLDENS.map((x) => (x.path === 'goldens/passes' ? { ...x, checks: [...x.checks, 'send_email called 0 times'] } : x)));
    expect(checks(page, 'passes')).toEqual([
      { cls: 'ck passed', mark: '✓', words: 'escalate called once' },
      { cls: 'ck', mark: null, words: 'send_email never calledadded since its last test' },
    ]);
  });

  it('says CI runs replay goldens offline and fork goldens live, with the one command docs/gating.md has, to copy', async () => {
    const page = await open();
    expect(page.one('.ph p').textContent).toBe('Every golden CI runs, and how it did at each revision.');
    expect(page.all('button').map((b) => b.textContent.trim())).not.toContain('Copy CI command');
    const ci = page.all('section.panel').find((s) => all(s, 'h2').some((h) => h.textContent === 'In CI'))!;
    expect(ci.textContent).toContain('Replay goldens run offline and need no key. A golden marked fork runs live from where it forks, and needs the providers’ keys. A divergence, a non-zero exit, no calls, or a check or gate that fails or can’t decide fails a golden.');
    expect(ci.textContent).not.toContain('throwaway store');
    expect(one(ci, '.cmdline').textContent).toBe(`$shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`);
    // It wraps between its words only.
    expect(all(ci, '.cmdline.words span')).toHaveLength(8);
    expect(all(ci, 'button').map((b) => b.textContent.trim())).toEqual(['Copy']);
    // budget has a gate against history: CI must keep the store between runs.
    expect(ci.textContent).toContain('A gate against history needs the store kept between runs: the Action’s keep-history does it, or cache .shadowlap/shadowlap.db.');
    expect(page.document.body.textContent).toContain('A golden whose checks say what the agent must do is also a task a model can be scored on.');
  });

  it('says an injection test runs live too, and needs the keys, when a golden has one', async () => {
    const page = await open([], GOLDENS.map((x) => (x.path === 'goldens/passes' ? { ...x, injection: true } : x)));
    const ci = page.all('section.panel').find((s) => all(s, 'h2').some((h) => h.textContent === 'In CI'))!;
    expect(all(ci, 'p.muted')[0].textContent).toBe('Replay goldens run offline and need no key. A golden marked fork runs live from where it forks, and an injection test from each payload it plants: both need the providers’ keys. A divergence, a non-zero exit, no calls, or a check or gate that fails or can’t decide fails a golden.');
  });

  it('settles a judge a replay golden couldn\'t ask offline with Update golden, which asks first and names its command', async () => {
    const started: Array<{ kind: string; fields: Record<string, unknown> }> = [];
    const page = await open(started);
    const panel = page.all('section.gpanel').find((s) => one(s, 'h2').textContent === 'judged')!;
    expect(panel.textContent).not.toContain('a key to ask');
    expect(one(panel, 'p.hintx').textContent).toContain('Update golden asks it once, live, and keeps its verdict in the pack');
    await page.click(all(panel, 'button').find((b) => b.textContent.trim() === 'Update golden')!);
    expect(started).toEqual([]);
    const dialog = page.one('.dialog');
    expect(all(dialog, 'h2, h3')[0].textContent).toBe('Update judged?');
    expect(dialog.textContent).toContain('nothing is re-recorded');
    // No card and no Diverged list: nothing diverged, and the title names the golden.
    expect(all(dialog, '.rmp, .ondisk.first')).toHaveLength(0);
    expect(all(dialog, '.ondisk.steps li span').map((s) => s.textContent)).toEqual(['Replayed offline, as recorded', 'Its judge asked once, live', 'Its verdict kept in the pack', 'You review the change']);
    expect(one(dialog, '.cmdline').textContent).toBe('$shadowlap test goldens/judged --update');
    await page.click(page.byText('.dialog button', 'Update golden'));
    expect(started).toEqual([{ kind: 'test-update', fields: { golden: 'goldens/judged' } }]);
  });

  it('names what a row opens with a real link to the same place, and a row that opens nothing with none', async () => {
    const page = await open();
    const rows = page.all('table.gt tbody tr');
    const opening = rows.filter((row) => row.className !== 'still');
    expect(opening.length).toBeGreaterThan(0);
    for (const row of rows) expect(all(row, 'code.gn a.rowa')).toHaveLength(row.className === 'still' ? 0 : 1);
    expect(one(opening[0], 'code.gn a.rowa').getAttribute('href')).toMatch(/^#\/run\//);
  });

  it('lays the table out as the mock does: mode and source under the name, a strip for phones, revisions that give way, Last result last', async () => {
    const page = await open();
    expect(page.one('section.panel.gtw .tscroll table.t.gt')).toBeTruthy();
    expect(page.all('table.gt thead th').map((th) => th.className)).toEqual(['gg', 'gck', 'hist', 'glast']);
    const row = page.all('table.gt tbody tr')[0];
    expect(all(row, 'td').map((td) => td.className)).toEqual(['gg', 'chk gck', 'hist', 'glast']);
    expect(one(row, 'td.gg .gmeta .chip').textContent).toBe('replay');
    expect(all(row, 'td.gg .gmeta .gstrip i')).toHaveLength(1);
    // The checks are under the name too, for a narrow panel to show instead of their column.
    expect(one(row, 'td.gg .chk.gin').textContent).toBe(one(row, 'td.gck').textContent);
    // The column is named, and its revisions are numbered from the newest, which keeps its place longest.
    expect(page.all('table.gt th.hist span').map((s) => [s.className, s.textContent])).toEqual([
      ['hn', 'By revision'],
      ['r0', 'd2e8a1f'],
    ]);
  });
});

describe('the Tests page\'s styles', () => {
  const css = sheet();

  it('put no tick before a check whatever its result, Training\'s criteria included', () => {
    expect(css).not.toMatch(/\.chk span::before/);
    expect(css).toMatch(/table\.gt \.chk \.ck\.failed \.cm \{ color: var\(--err\); \}/);
    expect(css).toMatch(/table\.gt \.chk \.ck\.inconclusive \.cm \{ color: var\(--warn\); \}/);
  });

  it('fit the table to its panel by its own width, keeping Last result a fixed width', () => {
    expect(css).toMatch(/\.gtw \{ container-type: inline-size; \}/);
    expect(css).toMatch(/\.gtw \.tscroll table\.gt \{ min-width: 0; \}/);
    expect(css).toMatch(/\.gtw table\.gt th\.glast \{ width: 250px; \}/);
    expect(css).toMatch(/@container \(max-width: 1000px\) \{\s*\.gtw table\.gt \.hist \.r3, \.gtw table\.gt \.hist \.r4, \.gtw table\.gt \.hist \.r5 \{ display: none; \}/);
    expect(css).toMatch(/@container \(max-width: 820px\) \{\s*\.gtw table\.gt th\.gck, \.gtw table\.gt td\.gck \{ display: none; \}\s*\.gtw table\.gt \.chk\.gin \{ display: block; \}/);
    expect(css).toMatch(/@container \(max-width: 640px\) \{\s*\.gtw table\.gt th\.hist, \.gtw table\.gt td\.hist \{ display: none; \}\s*\.gtw table\.gt \.gstrip \{ display: inline-flex; \}\s*\.gtw table\.gt td\.glast \{ min-width: 0; width: 46%; \}/);
    // The viewport rule that hid revisions by the window's width, not the table's, is gone.
    expect(css).not.toMatch(/td\.hist i:nth-last-child/);
  });

  it('wrap a cell without leaving a word alone on its last line, as the mock\'s do', () => {
    expect(css).toMatch(/\ntable\.gt td \{ text-wrap: pretty; \}/);
  });
});
