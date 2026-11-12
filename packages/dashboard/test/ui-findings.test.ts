import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { glued, wholeTallies } from '../ui/format.js';
import type { Banner as BannerView } from '../ui/run/banner.js';
import { bannerSeverity, runFindings } from '../ui/run/findings.js';
import { Banner, FindingsBar, forgetOpenFindings } from '../ui/run/FindingsBar.js';
import type { RunNote } from '../ui/run/notes.js';
import { loadNotesPart } from '../ui/run/notes-part.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { RunDetail } from '../ui/types.js';
import type { ForkDifferences } from '../src/fork-differences.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A run's findings, one bar under its header (findings.ts, FindingsBar.tsx): the most telling first,
 * whole, with `N findings` opening the rest in place and a card listing them while it is closed; a
 * lone finding with more under it opens that with `Details`; whether a run's bar is open is kept for
 * the session.
 */

const REC = '01M5JEQWA2QMJ3NYD1C687WP08';
const OTHER = '01M5JEQXRGBX1QXGW0X8A3ZB4C';

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  forgetOpenFindings();
});

const app = { client: { jobs: () => Promise.resolve([]) } as unknown as Client, exported: false, actionsOff: null, runs: [], jobs: [], live: [], feeds: {}, toast: () => undefined, guard: (fn: () => void) => fn(), watchJob: () => undefined, hasKind: () => true } as unknown as AppState;

function detail(o: { runId?: string; notRecorded?: RunDetail['notRecorded']; failed?: boolean; divergence?: unknown; intervention?: unknown } = {}): RunDetail {
  return {
    run: { runId: o.runId ?? REC, parentRunId: o.divergence ? OTHER : null, mode: o.divergence ? 'replay' : 'record', status: 'completed', divergence: o.divergence ?? null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: {} },
    intervention: o.intervention ?? null,
    summary: { upstreamRequests: 5, byKind: { api: 5, tool: 4, clock: 0, random: 0 }, cost: { spent: 0.0037, saved: 0, captured: 0, unknownModels: [] }, imported: false },
    calls: [],
    actions: [],
    children: [],
    parent: null,
    source: null,
    fix: null,
    notRecorded: o.notRecorded ?? null,
    state: { status: 'completed', kind: 'recording', outcome: { kind: o.failed ? 'check' : 'none' }, failed: !!o.failed, interrupted: false, label: 'recording' },
  } as unknown as RunDetail;
}

const FAILED_CHECK = { label: 'send_email called 0 times', ok: false, status: 'failed', detail: 'called 1 time' };

const props = (run: RunDetail, checks: unknown[] = []) => ({ run, blame: null, rescued: null, checks: checks as never, offers: null, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined });

const NOTE: RunNote = { kind: 'unrecorded', tone: 'err', label: 'not recorded', parts: ['The model called a tool Shadowlap did not record: ', { code: 'Bash' }, '.'], tools: [{ name: 'Bash', count: 2, firstCallNo: 5, effect: 'write', why: 'it runs a command' }] };

describe('the order of a run’s findings', () => {
  const failed: BannerView = { kind: 'failed', why: 'check failed: send_email · not blamed yet', fix: null, blamed: false };
  const unrecorded: BannerView = { kind: 'not-recorded', why: '1 tool wasn’t wrapped' };
  const differences = { runId: REC, parentRunId: OTHER, from: 5, changes: [], writes: [] } as unknown as ForkDifferences;
  const note = (tone: RunNote['tone'], label: string): RunNote => ({ kind: 'preload', tone, label, parts: [label] });

  it('puts a failure first, then what needs a look, then the rest, each weight in the order they come', () => {
    const found = runFindings({ own: failed, differences, notRecorded: unrecorded, notes: [note('n', 'extra reads'), note('warn', 'no preload')] });
    expect(found.map((f) => [f.says, f.sev])).toEqual([
      ['failed', 2],
      ['not recorded', 2],
      ['no preload', 1],
      ['What the fork did differently', 0],
      ['extra reads', 0],
    ]);
    // What has more to show once the bar opens: the fork's changes, a note's tools or hint.
    expect(found.filter((f) => f.body).map((f) => f.key)).toEqual(['differences']);
  });

  it('weighs a check that couldn’t be judged as one to look at, and the fork’s differences only once they have come', () => {
    expect(bannerSeverity({ kind: 'checks', checks: [{ label: 'judge', text: 'judge · inconclusive', status: 'inconclusive' }], why: null })).toBe(1);
    expect(bannerSeverity({ kind: 'checks', checks: [{ label: 'judge', text: 'judge · 5 of 5' }], why: null })).toBe(0);
    // A check's chip wraps only after its separator, never before its dot nor inside its tally.
    expect(glued(wholeTallies('judge · 5 of 5'))).toBe('judge\u00a0· 5\u00a0of\u00a05');
    expect(wholeTallies('stopped at #19 · 18 of 30 calls')).toBe('stopped at #19 · 18\u00a0of\u00a030 calls');
    expect(runFindings({ own: null, differences: null, notRecorded: null, notes: [] })).toEqual([]);
  });
});

describe('the findings bar', () => {
  it('draws the most telling whole, with N findings at its end opening the rest, the focus staying on it', async () => {
    const run = detail({ failed: true, notRecorded: { tools: ['Bash'], hosts: [] } });
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, props(run, [FAILED_CHECK]))));
    const bar = page.one('#findings');
    expect(bar.className).toBe('findings');
    const sections = page.all('#findings > section');
    expect(sections.map((s) => s.className)).toEqual(['banner blame', 'banner blame fx']);
    // The toggle is the first finding's last part, and its card lists the others in their weight's colour.
    const more = page.one('.findings .fmore');
    expect(sections[0].childNodes.at(-1)).toBe(more);
    expect(more.textContent).toBe('2 findings');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.getAttribute('aria-controls')).toBe('findings');
    expect(JSON.parse(more.getAttribute('data-tip')!)).toEqual({ t: 'Also found', rows: [['not recorded', '', 'var(--cq-red)']] });
    await page.click(more);
    expect(page.one('#findings').className).toBe('findings open');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(more.getAttribute('data-tip')).toBe(null);
    expect(page.focused()).toBe(more);
  });

  it('keeps a run’s bar open for the session, and another run’s closed', async () => {
    const run = detail({ failed: true, notRecorded: { tools: ['Bash'], hosts: [] } });
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, props(run, [FAILED_CHECK]))));
    await page.click(page.one('.fmore'));
    await page.unmount();
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, props(run, [FAILED_CHECK]))));
    expect(page.one('#findings').className).toBe('findings open');
    await page.unmount();
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, props(detail({ runId: OTHER, failed: true, notRecorded: { tools: ['Bash'], hosts: [] } }), [FAILED_CHECK]))));
    expect(page.one('#findings').className).toBe('findings');
  });

  it('opens a lone finding’s tools with Details, and draws nothing for a run that found nothing', async () => {
    // A note draws once its part is in, as a page loads it where the run has one (notes-part.ts).
    await loadNotesPart();
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(FindingsBar, { ...props(detail()), notes: [NOTE] })));
    const more = page.one('.findings .rnote .fmore');
    expect(more.textContent).toBe('Details');
    expect(more.getAttribute('data-tip')).toBe(null);
    expect(page.one('.rnote .fbody .rntools code').textContent).toBe('Bash');
    await page.unmount();
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(FindingsBar, { ...props(detail()), notes: [] })));
    expect(page.all('#findings')).toEqual([]);
  });
});

describe('a fork’s finding', () => {
  it('names the path its request changed at, and a --fail-at fork, whose request changed nothing, none', async () => {
    const changed = { callNo: 17, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 16, diff: [{ path: '$.messages[16].content' }, { path: '$.model' }] };
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, props(detail({ divergence: changed })))));
    expect(page.one('.findings .banner.fork .bk').textContent).toBe('forked at');
    expect(page.one('.findings .banner.fork .path').textContent).toBe('~ $.messages[16].content');
    await page.unmount();
    const failAt = { callNo: 19, type: 'forced', reason: 'forced live by --fail-at 19=529', name: 'POST /v1/messages', replayedBefore: 18 };
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, props(detail({ divergence: failAt, intervention: { flag: '--fail-at', value: '19=529', callNo: 19 } })))));
    expect(page.all('.findings .banner.fork code')[0].textContent).toBe('POST /v1/messages');
    expect(page.all('.findings .banner.fork .path')).toEqual([]);
  });
});

describe('a finding’s words', () => {
  it('leads a failure in ink with no label, marks the glossary’s words, and links the fork that rescued the run', async () => {
    const run = detail({ failed: true });
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, props(run, [FAILED_CHECK]))));
    // The outcome says check failed: the finding leads with the check, and how its blame stands after it.
    expect(page.all('.findings .banner .bk')).toHaveLength(0);
    expect(page.one('.findings .banner.blame .why .lead').textContent).toBe('send_email called 0 times, but called 1 time');
    await page.unmount();
    const blame = { callNo: 1, outcome: 'blamed', modelCall: { k: 1, m: 2 }, confidence: 'high', rescuedRunId: OTHER, scope: null };
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, { ...props(run, [FAILED_CHECK]), blame: blame as never })));
    expect(page.one('.findings .banner .bk .term').getAttribute('data-term')).toBe('lost');
    expect(page.byText('.findings .banner .end a', 'Rescued fork →').getAttribute('href')).toBe(`#/run/${OTHER}`);
  });
});

describe('a blame that placed the failure on no call', () => {
  it('says how it stands as its label, amber while it needs a look, red where no call rescues the run', async () => {
    const run = detail({ failed: true });
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, { ...props(run, [FAILED_CHECK]), blame: { callNo: null, outcome: 'stopped' } as never })));
    expect(page.one('.findings .banner.inc .bk').textContent).toBe('stopped');
    expect(page.one('.findings .banner.inc .why').textContent).toBe('check failed: send_email called 0 times, but called 1 time\u00a0· before it found the call');
    await page.unmount();
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, { ...props(run, [FAILED_CHECK]), blame: { callNo: null, outcome: 'unrescuable' } as never })));
    expect(page.one('.findings .banner.blame .bk').textContent).toBe('not rescued');
  });
});
