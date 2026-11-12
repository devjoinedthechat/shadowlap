import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { testsView, type GoldenSource } from '../src/tests.js';
import type { Client, TestsView } from '../ui/api.js';
import { testsPalette } from '../ui/goldens.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { bannerFor, type BannerInput } from '../ui/run/banner.js';
import { Banner } from '../ui/run/FindingsBar.js';
import { exitWords, presetAttempt, presetWhy } from '../ui/run/preset.js';
import { runFindings } from '../ui/run/findings.js';
import { presetsLine } from '../ui/presets/PresetsFinding.js';
import { presetsMatrix, presetsMeta, presetsReceipt, PresetsResults } from '../ui/presets/PresetsResults.js';
import { ForksView } from '../ui/run/ForksView.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ChaosMatrix, LineageNode, RunDetail } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * An error-path preset's attempt is a fork whose failure Shadowlap injected, so its run alone reads
 * as a healthy fork: its page takes the preset and its verdict from the presets of the session that
 * decided it (`/api/chaos/runs/:id`), for its banner, its status chip and its header's red line, and
 * its family's tree from the lineage, which carries each attempt's verdict. Tests says how a golden's
 * presets came out, and never calls a golden whose presets ran "not run yet".
 */

const REC = '01M5GRZVBY8R1P6XETDBV1Z6N0';
const ATTEMPT = '01M5GRZVY1P4DYJZVXZ6F0KEMM';
const PASSED = '01M5GRZW2G2G43STN6FXX48NAN';
const SECOND = '01M5GRZWPAE7H60Y55J79W68Y5';
const UNSURE = '01M5GRZWTW1SF8QP95NKPCK624';

const WHY = 'the agent exited with code 1 (TimeoutError: list_inbox timed out)';
const matrix: ChaosMatrix = {
  runId: REC,
  golden: 'goldens/list-inbox',
  at: 1,
  counts: { passed: 1, failed: 2, inconclusive: 1, notApplicable: 0 },
  command: 'shadowlap test goldens/list-inbox --chaos',
  rule: null,
  judge: null,
  spent: 0,
  upstreamRequests: 0,
  toolCall: { name: 'list_inbox', callNo: 2 },
  cells: [
    { preset: 'timeout', label: 'tool timeout', verdict: 'failed', callNo: 2, target: { kind: 'tool', name: 'list_inbox' }, passes: 0, attempts: 1, detail: `list_inbox (#2) timed out: ${WHY}`, reason: WHY, runs: [{ runId: ATTEMPT, verdict: 'failed', passed: false, exitCode: 1, reason: WHY }], gate: null, bound: null, spent: 0, upstreamRequests: 0, at: 1, sessionId: 'S' },
    { preset: 'empty', label: 'empty result', verdict: 'passed', callNo: 2, target: { kind: 'tool', name: 'list_inbox' }, passes: 1, attempts: 1, detail: 'list_inbox (#2) answered with nothing: the agent exited 0', reason: null, runs: [{ runId: PASSED, verdict: 'passed', passed: true, exitCode: 0, reason: null }], gate: null, bound: null, spent: 0, upstreamRequests: 0, at: 1, sessionId: 'S' },
    // Decided by its second attempt, kept before attempts kept why: this attempt's exit says it.
    { preset: '429', label: 'provider 429', verdict: 'failed', callNo: 3, target: { kind: 'api', name: 'POST /v1/messages' }, passes: 1, attempts: 2, detail: 'model call #3 failed with HTTP 429: 1 of 2 attempts passed; the agent exited with code 1', reason: 'the agent exited with code 1', runs: [{ runId: '01M5GRZWNNNNNNNNNNNNNNNNNN', verdict: 'passed', passed: true, exitCode: 0, reason: null }, { runId: SECOND, verdict: 'failed', passed: false, exitCode: 1, reason: null }], gate: null, bound: null, spent: 0, upstreamRequests: 0, at: 1, sessionId: 'S' },
    { preset: '500', label: 'provider 500', verdict: 'inconclusive', callNo: 3, target: { kind: 'api', name: 'POST /v1/messages' }, passes: 0, attempts: 1, detail: 'model call #3 failed with HTTP 500: the replay never reached #3, so the preset was never played in', reason: 'the replay never reached #3, so the preset was never played in', runs: [{ runId: UNSURE, verdict: 'inconclusive', passed: false, exitCode: 0, reason: 'the replay never reached #3, so the preset was never played in' }], gate: null, bound: null, spent: 0, upstreamRequests: 0, at: 1, sessionId: 'S' },
  ],
};

describe('a preset’s attempt', () => {
  it('is found among the presets that decided it, as which attempt of its preset, in the preset’s words', () => {
    const p = presetAttempt(matrix, ATTEMPT)!;
    expect(p).toEqual({ label: 'tool timeout', golden: 'goldens/list-inbox', callNo: 2, target: 'list_inbox', verdict: 'failed', attempt: 1, of: 1, played: 'list_inbox (#2) timed out', outcome: WHY, exitCode: 1 });
    expect(presetWhy(p)).toBe('tool timeout preset on goldens/list-inbox, attempt 1 of 1: list_inbox (#2) timed out, played in by the preset');
    // A run's own presets, which no golden made, name none.
    expect(presetWhy({ ...p, golden: null })).toBe('tool timeout, attempt 1 of 1: list_inbox (#2) timed out, played in by the preset');
    // Why it failed is the header's red line, which the banner leaves to it.
    expect(exitWords('failed', p)).toBe(WHY);
    expect(presetWhy(presetAttempt(matrix, PASSED)!)).toBe('empty result preset on goldens/list-inbox, attempt 1 of 1: list_inbox (#2) answered with nothing, played in by the preset');
    // One of several attempts: its place among them, and its own exit when the result kept no why.
    const second = presetAttempt(matrix, SECOND)!;
    expect([second.attempt, second.of, second.outcome, presetWhy(second)]).toEqual([2, 2, 'the agent exited with code 1', 'provider 429 preset on goldens/list-inbox, attempt 2 of 2: model call #3 failed with HTTP 429, played in by the preset']);
    // One that couldn't say claims nothing played in: why goes at the banner's end.
    const unsure = presetAttempt(matrix, UNSURE)!;
    expect([presetWhy(unsure), unsure.outcome]).toEqual(['provider 500 preset on goldens/list-inbox, attempt 1 of 1', 'the replay never reached #3, so the preset was never played in']);
    // A run no preset made has none.
    expect(presetAttempt(matrix, REC)).toBeNull();
    expect(presetAttempt(null, ATTEMPT)).toBeNull();
    // A fork that exited with an error: its code when a preset kept it, else said without one.
    expect(exitWords('failed', { ...p, verdict: 'passed' })).toBe('exited 1');
    expect(exitWords('failed', null)).toBe('exited with an error');
    expect(exitWords('completed', null)).toBeNull();
  });

  const input: BannerInput = {
    status: 'failed',
    type: 'fork',
    divergence: { callNo: 2, type: 'forced', name: 'list_inbox', replayedBefore: 1, reason: 'forced by --fail-at 2=timeout' },
    intervention: { flag: '--fail-at', value: '2=timeout', callNo: 2 },
    interventions: [
      { flag: '--fail-at', value: '2=timeout', callNo: 2 },
      { flag: '--writes', value: 'stub', callNo: null },
    ],
    rescued: null,
    blame: null,
    notRecorded: null,
    checks: [],
    fix: null,
    upstreamRequests: 0,
    outcome: { kind: 'none' },
    failed: false,
  };

  it('leads its banner with its verdict word, then which preset it played in where, in every attempt’s grammar', () => {
    // Without the preset: a healthy fork, which is what the page said.
    expect(bannerFor(input)!.kind).toBe('fork');
    expect(bannerFor({ ...input, preset: presetAttempt(matrix, ATTEMPT) })).toEqual({ kind: 'preset', callNo: 2, verdict: 'failed', why: 'tool timeout preset on goldens/list-inbox, attempt 1 of 1: list_inbox (#2) timed out, played in by the preset · writes stubbed', golden: 'goldens/list-inbox' });
    // One that couldn't say says why at its end, the header having no line for it.
    expect(bannerFor({ ...input, preset: presetAttempt(matrix, UNSURE) })!).toMatchObject({ verdict: 'inconclusive', why: 'provider 500 preset on goldens/list-inbox, attempt 1 of 1 · writes stubbed · the replay never reached #3, so the preset was never played in' });
  });

  it('draws the banner whole: it wraps rather than cut its words, and leaves its verdict to the first fact', () => {
    const run = attemptRun();
    const html = renderToStaticMarkup(
      createElement(AppContext.Provider, { value: appState() }, createElement(Banner, { run, blame: null, rescued: null, checks: [], offers: null, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined, preset: presetAttempt(matrix, ATTEMPT) })),
    );
    expect(html).toContain('<section class="banner fork wrap"><span class="bk">forked at</span><button class="bn" type="button">#2</button>');
    // Its tally kept whole where the line wraps.
    expect(html).toContain('<span class="why">tool timeout preset on goldens/list-inbox, attempt 1\u00a0of\u00a01: list_inbox (#2) timed out, played in by the preset · writes stubbed</span>');
    expect(html).toContain('<a class="more" href="#/tests" title="list-inbox on Tests">Tests →</a>');
    // Never a line cut at the banner's end.
    expect(html).not.toContain('…');
  });

  it('says why its preset failed it in red on the id’s card, with no chip: the first fact says the verdict', () => {
    const run = attemptRun();
    const header = (preset: ReturnType<typeof presetAttempt>) =>
      renderToStaticMarkup(createElement(AppContext.Provider, { value: appState() }, createElement(RunHeader, { run, call: null, selected: 2, rescued: false, offers: null, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined, preset })));
    const failed = header(presetAttempt(matrix, ATTEMPT));
    expect(failed).not.toContain('class="tag');
    expect(failed).toContain(`<span class="mfail">${WHY}</span>`);
    // Before the presets are read: its eyebrow naming it a fork, and that it exited with an error, plainly.
    const plain = header(null);
    expect(plain).not.toContain('class="tag');
    expect(plain).toContain('<span class="ebk">fork @2</span>');
    expect(plain).toContain('<span>exited with an error</span>');
  });
});

/** The failed attempt's page, as the run endpoint serves it. */
function attemptRun(): RunDetail {
  return {
    run: { runId: ATTEMPT, parentRunId: REC, mode: 'replay', status: 'failed', divergence: { type: 'forced', callNo: 2, kind: 'tool', name: 'list_inbox', replayedBefore: 1 }, command: { argv: ['node', 'inbox.mjs'], cwd: '/w' }, codeVersion: null, startedAt: 1, endedAt: 2, meta: { chaos: { preset: 'timeout', callNo: 2, session: 'S', attempt: 1, golden: 'goldens/list-inbox' } } },
    label: 'fork @2',
    about: { text: 'tool timeout #2', from: 'change', change: null },
    source: null,
    summary: { cost: { spent: 0, saved: 0, captured: 0 }, imported: false, durationMs: 100, upstreamRequests: 0, byKind: { api: 1, tool: 1, clock: 0, random: 0 } },
    calls: [],
    intervention: { flag: '--fail-at', value: '2=timeout', callNo: 2 },
    interventions: [
      { flag: '--fail-at', value: '2=timeout', callNo: 2 },
      { flag: '--writes', value: 'stub', callNo: null },
    ],
    parent: { runId: REC, label: 'recording' },
    children: [],
    actions: [],
    fix: null,
    state: { status: 'failed', endedAt: 2, kind: 'fork', outcome: { kind: 'none' }, failed: false, interrupted: false, label: 'fork @2' },
  } as unknown as RunDetail;
}

const appState = () => ({ client: {}, exported: false, meta: null, runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined, jobs: [], live: [], feeds: {}, tick: 0, runsTick: 0 }) as unknown as AppState;

describe('a preset’s attempts in the Forks view', () => {
  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
  });

  it('marks an attempt its preset failed by the verdict the lineage carries, an earlier session’s too', async () => {
    const node = (runId: string, parentRunId: string | null, about: string, status: 'completed' | 'failed', preset?: LineageNode['preset']): LineageNode => ({ runId, parentRunId, depth: parentRunId ? 1 : 0, mode: parentRunId ? 'replay' : 'record', status, label: parentRunId ? 'fork @2' : 'recording', divergence: parentRunId ? { callNo: 2, type: 'forced' } : null, calls: 2, spent: 0, saved: 0, startedAt: parentRunId ? 2 : 1, repeat: null, checks: null, about: { text: about, from: parentRunId ? 'change' : 'user' }, ...(preset ? { preset } : {}) });
    const nodes = [
      node(REC, null, 'Triage the unread threads', 'completed'),
      // The first session's attempt, failed; the presets ran again since, and the second's passed.
      node(ATTEMPT, REC, 'tool timeout #2', 'failed', { label: 'tool timeout', verdict: 'failed', session: 'S1', callNo: 2, golden: 'goldens/list-inbox' }),
      node(PASSED, REC, 'tool timeout #2', 'completed', { label: 'tool timeout', verdict: 'passed', session: 'S1', callNo: 2, golden: 'goldens/list-inbox' }),
      node(UNSURE, REC, 'provider 500 #3', 'completed', { label: 'provider 500', verdict: 'inconclusive', session: 'S1', callNo: 3, golden: 'goldens/list-inbox' }),
    ];
    // No matrix to read: the family's tree goes by the lineage alone.
    const client = { lineage: () => Promise.resolve(nodes), fixBundles: () => Promise.resolve([]), injectionResults: () => Promise.resolve({ results: [] }), runChaos: () => Promise.reject(new Error('not asked')) } as unknown as Client;
    const app = { client, exported: false, meta: null, runs: [], live: [], feeds: {}, tick: 0, runsTick: 0, jobs: [], hasKind: () => true };
    r = await render(createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(ForksView, { runId: REC })));
    await r.until('the family to load', () => r!.all('.fnode .f2').length === 4);
    const [, failed, passed, unsure] = r.all('.fnode .f2');
    expect(failed.querySelector('em')!.textContent).toBe('preset failed');
    expect(failed.textContent.startsWith('preset failed · ')).toBe(true);
    expect(passed.querySelector('em')).toBeNull();
    expect(unsure.querySelector('em.inc')!.textContent).toBe('preset inconclusive');
  });
});

describe('a golden’s presets on Tests', () => {
  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
    delete (globalThis as { location?: unknown }).location;
  });

  function view(): TestsView {
    const store = Store.open(':memory:');
    try {
      const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'inbox.mjs'], cwd: '.' }, startedAt: 1 }).runId;
      store.endRun(rec, 'completed', 2);
      const attempt = store.createRun({ mode: 'replay', parentRunId: rec, command: { argv: ['node', 'inbox.mjs'], cwd: '.' }, startedAt: 3, meta: { chaos: { preset: 'timeout', callNo: 2, session: 'S', attempt: 1, golden: 'goldens/list-inbox' } } }).runId;
      store.endRun(attempt, 'failed', 4);
      store.startChaosSession({ sessionId: 'S', startedAt: 3, command: ['shadowlap', 'test', 'goldens/list-inbox', '--chaos'], presets: ['timeout', 'empty'] });
      store.addChaosResult({ sessionId: 'S', runId: rec, golden: 'goldens/list-inbox', preset: 'timeout', verdict: 'failed', callNo: 2, passes: 0, attempts: 1, at: 5, data: { detail: 'list_inbox (#2) timed out: the agent exited with code 1', reason: 'the agent exited with code 1', runs: [{ runId: attempt, verdict: 'failed', passed: false, exitCode: 1 }] } });
      store.addChaosResult({ sessionId: 'S', runId: rec, golden: 'goldens/list-inbox', preset: 'empty', verdict: 'passed', callNo: 2, passes: 1, attempts: 1, at: 6, data: { detail: 'list_inbox (#2) answered with nothing: the agent exited 0', runs: [] } });
      store.finishChaosSession('S', { passed: 1, failed: 1, inconclusive: 0, upstreamRequests: 0, endedAt: 7 });
      const goldens: GoldenSource[] = [{ path: 'goldens/list-inbox', runId: rec, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
      return testsView(store, goldens);
    } finally {
      store.close();
    }
  }

  it('says its presets failed, which attempt to open, and never that it has not run', async () => {
    const v = view();
    (globalThis as { location?: unknown }).location = { hash: '#/tests' };
    const client = { tests: () => Promise.resolve(v), jobs: () => Promise.resolve([]), injectionSecurity: () => Promise.resolve({ goldens: [], none: [], unread: [] }) } as unknown as Client;
    const app = { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined };
    r = await render(createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(TestsPage)));
    await r.until('the golden to load', () => r!.all('td.glast').length === 1);
    const last = r.one('td.glast');
    expect(last.querySelector('.st')!.textContent).toBe('presets failed');
    expect(last.querySelector('.st')!.className).toBe('st err');
    const line = last.querySelector('a.gpre')!;
    expect(line.textContent).toBe('1 of 2 presets failed: tool timeout #2 · replay not tested yet');
    expect(line.getAttribute('href')).toBe(`#/run/${v.rows[0].presets!.runId}`);
    expect(r.document.body.textContent).not.toContain('not run yet');
    // The palette's hint for it says the same.
    expect(testsPalette(v, { update: false }).find((e) => e.label === 'list-inbox')?.hint).toBe('presets failed');
  });
});

describe('a recording’s presets on its page', () => {
  const about = { text: 'Lists the inbox', from: 'user' as const };

  it('is a finding by its verdict and what came of each preset, weighed as a gate is, after the run’s own', () => {
    expect(presetsLine(matrix)).toBe('tool timeout and provider 429 failed\u00a0· provider 500 inconclusive');
    const passed = { ...matrix, counts: { passed: 2, failed: 0, inconclusive: 0, notApplicable: 1 }, cells: [matrix.cells[1], { ...matrix.cells[1], preset: 'oversized', label: 'oversized result', verdict: 'not-applicable' as const }] };
    expect(presetsLine(passed)).toBe('every preset passed, 1 not applicable');
    const found = runFindings({ own: null, differences: null, notRecorded: null, notes: [], presets: matrix });
    expect(found.map((f) => [f.key, f.sev, f.says])).toEqual([['presets', 2, 'error-path presets failed']]);
    expect(runFindings({ own: null, differences: null, notRecorded: null, notes: [], presets: passed })[0].sev).toBe(0);
  });

  it('lays the recording out against each preset on the shared matrix: where each hit, its tally and the attempt that shows it', () => {
    const m = presetsMatrix(matrix, about);
    expect([m.id, m.label, m.rowInLabel, m.corner]).toEqual([`presets-${REC}`, `Error-path presets on ${REC}`, true, 'run']);
    expect(m.rows).toEqual([{ key: REC, label: REC, chip: 'list-inbox', sub: 'Lists the inbox' }]);
    expect(m.cols.map((c) => [c.label, c.sub])).toEqual([
      ['tool timeout', 'list_inbox (#2) timed out'],
      ['empty result', 'list_inbox (#2) answered with nothing'],
      ['provider 429', 'model call #3 failed with HTTP 429'],
      ['provider 500', 'model call #3 failed with HTTP 500'],
    ]);
    const cell = (key: string) => m.cell(m.rows[0], m.cols.find((c) => c.key === key)!)!;
    // The first attempt that didn't pass, else the last, at the call it hit.
    expect([cell('429').word, cell('429').tally, cell('429').href]).toEqual(['failed', '1 of 2 passed', `#/run/${SECOND}/3`]);
    expect([cell('empty').word, cell('empty').href]).toEqual(['passed', `#/run/${PASSED}/2`]);
    expect(JSON.parse(cell('429').tip!)).toMatchObject({ t: 'provider 429 · failed · 1 of 2 passed', s: 'model call #3 failed with HTTP 429' });
  });

  it('says what ran, where and when, what judged it and what it spent, as the panel draws it', () => {
    expect(presetsMeta({ ...matrix, at: Date.now() }).slice(0, 2)).toEqual(['4 presets', 'at list_inbox (#2) and model call #3']);
    expect(presetsReceipt({ ...matrix, spent: 0.486, upstreamRequests: 132 })).toEqual([{ parts: ['these presets spent ≈$0.486', 'every call before #2 replayed free'] }, { parts: ['132 upstream requests'] }]);
    const html = renderToStaticMarkup(createElement(PresetsResults, { matrix, about }));
    expect(html).toContain('aria-label="Error-path preset results"');
    expect(html).toContain('Run × presets');
    expect(html).toContain('judged on the agent exiting 0 alone: no checks say what an error path must do');
    const judged = renderToStaticMarkup(createElement(PresetsResults, { matrix: { ...matrix, rule: 'gate: tells 90%+ from 50%- at <= 10% risk, up to 6 attempts', judge: { source: 'chaos.expect', checks: ['issue_refund called 0 times'] } }, about }));
    expect(judged).toContain('checks: issue_refund called 0 times');
    expect(judged).toContain('gate: tells');
  });
});
