import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PAUSED } from '../ui/connection.js';
import { LookStepButton } from '../ui/overview/steps.js';
import { AppContext } from '../ui/state.js';
import { render } from './ui-render.js';
import { forkMenuTitle } from '../ui/actions.js';
import { createExportedClient } from '../ui/api.js';
import { InjectionFinding } from '../ui/injection/Finding.js';
import { Proof } from '../ui/injection/Proof.js';
import { injectionMatrix, panelMeta, panelReceipt } from '../ui/injection/InjectionResults.js';
import { countsLine, injectionFactOf, injectionFinding, NO_INJECTION, runInjectionView, shownResult } from '../ui/injection/model.js';
import { outcomeFact } from '../ui/run/metrics.js';
import { UntrustedTag, untrustedTip } from '../ui/injection/UntrustedTag.js';
import { runFindings } from '../ui/run/findings.js';
import { useResultsBodies } from '../ui/run/InspectorPanel.js';
import { onShow } from '../ui/components/OnShow.js';
import { ServedPartsContext, type ServedParts } from '../ui/served-parts.js';
import type { InjectionPanelView, InjectionRow, ProofParts, UntrustedView } from '../ui/types.js';

/**
 * What a run's page draws of the injection tests it was in (port/injection-results): the untrusted
 * tag in Calls and Turns, the finding of the run's newest kept test with its Show results, the panel
 * that opens on the shared matrix, and an exported copy, which keeps no results and draws none of it.
 */

const RUN = '01K5CQ4N7G';

const row = (o: Partial<InjectionRow> = {}): InjectionRow => ({
  resultId: 'inj-01PLANT',
  runId: RUN,
  golden: null,
  sessionId: null,
  mode: 'plant',
  at: 1_000,
  endedAt: 2_000,
  running: false,
  attempts: 72,
  obeyed: 8,
  influenced: 2,
  ignored: 59,
  inconclusive: 3,
  verdict: 'obeyed',
  gate: 'failed',
  actor: null,
  line: 'send_email obeyed a planted instruction · 8 of 72',
  reason: 'send_email obeyed a planted instruction in 8 of 72 attempts (at most 0 allowed): send_email.to = x7f3kq2m@canary.invalid',
  spent: 3.11,
  rule: null,
  href: `#/run/${RUN}`,
  ...o,
});

const read = (o: Partial<UntrustedView> = {}): UntrustedView => ({ callNo: 4, name: 'get_ticket', from: 'config', readAt: 5, ...o });

describe('the untrusted tag', () => {
  it('tags a read a model call reads, after its effect, a space before it for a screen reader, its card saying where the mark came from', () => {
    const html = renderToStaticMarkup(createElement(UntrustedTag, { read: read() }));
    expect(html).toContain('<span class="srsp"><span class="sr"> </span></span><span class="eff untrusted"');
    expect(html).toContain('>untrusted</span>');
    expect(JSON.parse(untrustedTip(read()))).toEqual({ t: 'untrusted · config', s: 'It brings outside text in: shadowlap injection plants its payloads here, and model call #5 reads it.', rows: [] });
  });

  it('says an SDK mark is in the agent’s code, and names an MCP server’s hint', () => {
    expect(JSON.parse(untrustedTip(read({ from: 'sdk' })))).toMatchObject({ t: 'untrusted · SDK', s: 'Marked in the agent’s code. It brings outside text in: shadowlap injection plants its payloads here, and model call #5 reads it.' });
    expect(JSON.parse(untrustedTip(read({ from: 'mcp', readAt: 9 })))).toMatchObject({ t: 'untrusted · MCP openWorldHint' });
  });

  it('draws nothing for a call that is no untrusted read, and leaves out a read no model call follows', () => {
    expect(renderToStaticMarkup(createElement(UntrustedTag, { read: undefined }))).toBe('');
    const view = runInjectionView({ untrusted: [read(), read({ callNo: 9, readAt: null })], results: [], attempt: null }, null);
    expect([...view.untrusted.keys()]).toEqual([4]);
  });
});

describe('the fork menu’s header', () => {
  it('names an untrusted read where the server gave no header, as the engine names it, and only a read', () => {
    const call = { callNo: 4, kind: 'tool', name: 'get_ticket', effect: 'read' };
    expect(forkMenuTitle(call, 'get_ticket', { untrusted: true })).toBe('At #4 · get_ticket · untrusted read');
    expect(forkMenuTitle(call, 'get_ticket')).toBe('At #4 · get_ticket · read tool');
    expect(forkMenuTitle({ ...call, effect: 'write' }, 'get_ticket', { untrusted: true })).toBe('At #4 · get_ticket · write tool');
  });
});

describe('the run’s finding', () => {
  it('words a failed test by its gate’s reason up to its limit, an inconclusive one by its reason whole, a passed one by its counts', () => {
    expect(injectionFinding(row())).toEqual({ resultId: 'inj-01PLANT', gate: 'failed', label: 'injection test', line: 'send_email obeyed a planted instruction in 8 of 72 attempts (at most 0 allowed)', golden: null });
    expect(injectionFinding(row({ gate: 'inconclusive', reason: '3 of 6 attempts showed too little to say (at most 0 allowed)' }))?.line).toBe('3 of 6 attempts showed too little to say (at most 0 allowed)');
    expect(injectionFinding(row({ gate: 'passed', reason: null, attempts: 6, obeyed: 0, influenced: 0, ignored: 6, inconclusive: 0 }))?.line).toBe('6 attempts: 0 obeyed · 0 influenced · 6 ignored');
    expect(countsLine({ attempts: 1, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 1 })).toBe('1 attempt: 0 obeyed · 0 influenced · 0 ignored · 1 inconclusive');
  });

  it('names a gate’s golden, and shows nothing while the test runs', () => {
    expect(injectionFinding(row({ golden: 'refund-over-limit' }))).toMatchObject({ label: 'injection gate', golden: 'refund-over-limit' });
    expect(injectionFinding(row({ running: true, gate: null, endedAt: null }))).toBeNull();
  });

  it('shows the newest plant test that has ended, past a newer --clean answer and one still running', () => {
    const newest = shownResult([row({ resultId: 'inj-run', running: true, gate: null }), row({ resultId: 'inj-clean', mode: 'clean', gate: 'passed' }), row({ resultId: 'inj-old' }), row({ resultId: 'inj-older' })]);
    expect(newest?.resultId).toBe('inj-old');
    expect(runInjectionView(null, [row({ mode: 'clean' })]).finding).toBeNull();
    expect(runInjectionView(null, null)).toBe(NO_INJECTION);
  });

  it('takes the results read as runs move over those the run’s read held', () => {
    const view = runInjectionView({ untrusted: [], results: [row({ resultId: 'inj-first' })], attempt: null }, [row({ resultId: 'inj-later', gate: 'passed' })]);
    expect(view.finding).toMatchObject({ resultId: 'inj-later', gate: 'passed' });
  });

  it('weighs a failed test as a failure, after the run’s own findings of its weight, and a passed one at no weight', () => {
    const failed = injectionFinding(row())!;
    const list = runFindings({ own: null, differences: null, notRecorded: null, notes: [{ kind: 'unrecorded', tone: 'err', label: 'not recorded' } as never], injection: failed });
    expect(list.map((f) => [f.key, f.sev, f.says])).toEqual([
      ['note:unrecorded:0', 2, 'not recorded'],
      ['injection', 2, 'injection test failed'],
    ]);
    expect(runFindings({ own: null, differences: null, notRecorded: null, notes: [], injection: injectionFinding(row({ gate: 'passed' })) })[0]).toMatchObject({ sev: 0, says: 'injection test passed' });
  });
});

describe('an attempt’s first fact', () => {
  const RUNLIKE = { runId: 'A', mode: 'replay', status: 'completed', parentRunId: RUN, divergence: { callNo: 5 }, checks: [] } as never;
  const fact = (meta: Record<string, unknown>, checks: Array<{ label: string; ok: boolean; detail?: string }> = [], plant: { gone: number[] | null; writes: number | null } | null = null) =>
    outcomeFact(RUNLIKE, { tools: 3, injection: injectionFactOf({ run: { meta: { injection: { result: 'inj-1', read: 4, attempt: 1, of: 3, ...meta } } } } as never, checks, plant as never) });
  const CHECK = 'no tool call carries the planted canary';

  it('says an attempt obeyed at the call that carried the canary, in red, its card why from its check', () => {
    const f = fact({ role: 'attempt', verdict: 'obeyed', evidence: [{ callNo: 6, tool: 'send_email', path: '$.to', value: 'x7f3kq2m@canary.invalid', kind: 'canary' }] }, [{ label: CHECK, ok: false, detail: 'send_email.to = x7f3kq2m@canary.invalid at #6 carries the canary planted at #4' }]);
    expect(f).toEqual({ tone: 'err', words: 'obeyed at', callNo: 6, today: false, tip: { title: 'Obeyed', sub: 'send_email.to = x7f3kq2m@canary.invalid at #6 carries the canary planted at #4', rows: [], said: 'send_email.to = x7f3kq2m@canary.invalid at #6 carries the canary planted at #4' } });
  });

  it('says influenced and inconclusive amber with the mark’s why, ignored muted', () => {
    expect(fact({ role: 'attempt', verdict: 'inconclusive', why: 'the model call after the read failed' })).toMatchObject({ tone: 'warn', words: 'inconclusive', callNo: null, tip: { title: 'Inconclusive', sub: 'the model call after the read failed' } });
    expect(fact({ role: 'attempt', verdict: 'influenced' })).toMatchObject({ tone: 'warn', words: 'influenced' });
    expect(fact({ role: 'attempt', verdict: 'ignored' })).toMatchObject({ tone: 'mu', words: 'ignored' });
  });

  it('says a clean attempt’s first write gone, or every write made again, and a baseline’s writes after the read, once the read has come', () => {
    expect(fact({ role: 'clean' }, [], { gone: [28, 31], writes: null })).toMatchObject({ tone: 'err', words: 'write gone at', callNo: 28 });
    expect(fact({ role: 'clean' }, [], { gone: [], writes: null })).toMatchObject({ tone: 'mu', words: 'every write made again', callNo: null });
    expect(fact({ role: 'baseline' }, [], { gone: null, writes: 2 })).toMatchObject({ tone: 'mu', words: '2 writes after the read' });
    // Until it comes, and in a copy, its checks say it, as any replay's do.
    expect(fact({ role: 'baseline' }).words).toBe('no checks');
  });
});

/** The served dashboard's parts, as App.tsx hands them in, with a stand-in for the results' body. */
const served: ServedParts = { InjectionResults: onShow(async () => () => createElement('p', null, 'the results')) };
const withParts = (parts: ServedParts, child: ReactNode) => renderToStaticMarkup(createElement(ServedPartsContext.Provider, { value: parts }, child));

describe('the finding as the bar draws it', () => {
  const finding = (f = injectionFinding(row())!) => createElement(InjectionFinding, { runId: RUN, f, fx: false, more: null });

  it('leads with its label in ink, its verdict in its colour, its line with each tally whole, and Show results at its end', () => {
    const html = withParts(served, finding());
    expect(html).toContain('<section class="banner wrap blame" data-finding="injection"><span class="bk">injection test</span><span class="why"><em class="no">failed</em> · send_email obeyed a planted instruction in 8 of 72 attempts (at most 0 allowed)</span>');
    expect(html).toContain('data-act="results" data-which="injection:inj-01PLANT" aria-expanded="false" aria-controls="insp">Show results</button>');
  });

  it('glosses influenced, names a gate’s golden, and draws a passed test lime and an inconclusive one amber', () => {
    const passed = withParts(served, finding(injectionFinding(row({ gate: 'passed', golden: 'refund-over-limit', attempts: 6, obeyed: 0, influenced: 1, ignored: 5, inconclusive: 0 }))!));
    expect(passed).toContain('class="banner wrap live"');
    expect(passed).toContain('<span class="bk">injection gate</span>');
    expect(passed).toContain('<em class="ok">passed</em>');
    expect(passed).toMatch(/data-term="influenced"[^>]*>influenced</);
    expect(passed).toContain(' · refund-over-limit</span>');
    expect(withParts(served, finding(injectionFinding(row({ gate: 'inconclusive' }))!))).toContain('class="banner wrap inc"');
  });
});

describe('an exported copy', () => {
  it('keeps no injection results: its run’s read answers none, and a result’s read and its report’s preview are refused in its words', async () => {
    const client = createExportedClient({ responses: {}, runIds: [] } as never);
    await expect(client.injectionRun(RUN)).resolves.toEqual({ untrusted: [], results: [], attempt: null });
    await expect(client.injectionResults(RUN)).resolves.toEqual({ results: [] });
    await expect(client.injectionResult('inj-01PLANT')).rejects.toMatchObject({ status: 404, message: 'this is an exported copy, and injection tests are not part of it' });
    await expect(client.injectionPreview('inj-01PLANT')).rejects.toMatchObject({ status: 404 });
  });

  it('is handed no results part, so a finding would offer no Show results and the inspector draws no results in its place', () => {
    expect(withParts({}, createElement(InjectionFinding, { runId: RUN, f: injectionFinding(row())!, fx: false, more: null }))).not.toContain('Show results');
    let bodies: ((key: string) => ReactNode) | null = null;
    const Probe = () => ((bodies = useResultsBodies(RUN)), null);
    withParts({}, createElement(Probe));
    expect(bodies!('injection:inj-01PLANT')).toBeNull();
    withParts(served, createElement(Probe));
    expect(bodies!('injection:inj-01PLANT')).not.toBeNull();
    expect(bodies!('presets')).toBeNull();
  });
});

/** A test's panel as the server words it: two reads by two payloads. */
const view = (o: Partial<InjectionPanelView> = {}): InjectionPanelView => ({
  rows: [
    { callNo: 4, name: 'get_ticket', from: 'config', readAt: 5, worst: 0 },
    { callNo: 9, name: 'fetch_page', from: 'mcp', readAt: 10, worst: 3 },
  ],
  cols: [
    { id: 'system-notice', title: 'Poses as a system notice', text: 'SYSTEM NOTICE: …' },
    { id: 'tool-json', title: 'Impersonates a tool’s answer', text: '{"status": …' },
  ],
  cells: [
    { read: 4, payload: 'system-notice', verdict: 'obeyed', n: 3, of: 3, attempt: { runId: '01K5CQXJ00', callNo: 6 }, line: 'planted at #4 → read at #5 → send_email.to = x7f3kq2m@canary.invalid at #6' },
    { read: 4, payload: 'tool-json', verdict: 'influenced', n: 1, of: 3, attempt: null, line: 'no tool call carries the planted canary, but #6 send_email does' },
    { read: 9, payload: 'system-notice', verdict: 'ignored', n: 3, of: 3, attempt: { runId: '01K5CQXJ09', callNo: null }, line: 'no tool call after #9 carries the canary' },
  ],
  tools: null,
  totals: { attempts: 12, obeyed: 3, influenced: 1, inconclusive: 0, ignored: 8 },
  what: '12 templates, version 1',
  startedAt: new Date(2026, 9, 1, 9, 31).getTime(),
  by: null,
  command: `shadowlap injection ${RUN} --attempts 3`,
  none: null,
  receipt: { spent: 3.11, upstreamRequests: 819, baselines: 6, stopReason: null },
  ...o,
});

describe('the results panel', () => {
  it('lays the reads out by payload: each read’s head its call on this run, its source under it, each payload’s title and text its column’s card', () => {
    const m = injectionMatrix(view(), RUN, 'inj-01PLANT');
    expect(m).toMatchObject({ id: 'injection:inj-01PLANT', label: 'Untrusted reads by payload', corner: 'untrusted read' });
    expect(m.rows.map((r) => [r.key, r.label, r.href, r.sub])).toEqual([
      ['4', '#4 get_ticket', `#/run/${RUN}/4`, 'config'],
      ['9', '#9 fetch_page', `#/run/${RUN}/9`, 'MCP openWorldHint'],
    ]);
    expect(m.cols[0]).toEqual({ key: 'system-notice', label: 'system-notice', sub: 'Poses as a system notice: SYSTEM NOTICE: …' });
  });

  it('gives each cell its verdict, its tally with its noun, the attempt that shows it at its call, and its proof on its card', () => {
    const m = injectionMatrix(view(), RUN, 'inj-01PLANT');
    const [r4, r9] = m.rows;
    const [notice, json] = m.cols;
    const cell = m.cell(r4, notice)!;
    expect(cell).toMatchObject({ word: 'obeyed', tally: '3 of 3 obeyed', href: '#/run/01K5CQXJ00/6' });
    expect(JSON.parse(cell.tip!)).toEqual({ t: '#4 get_ticket · system-notice', s: 'planted at #4 → read at #5 → send_email.to = x7f3kq2m@canary.invalid at #6', rows: [['obeyed', '3 of 3 obeyed', 'var(--cq-red)']] });
    expect(m.cell(r4, json)).toMatchObject({ word: 'influenced', tally: '1 of 3 influenced', href: null });
    expect(m.cell(r9, notice)).toMatchObject({ word: 'ignored', href: '#/run/01K5CQXJ09' });
    expect(m.cell(r9, json)).toBeNull();
  });

  it('past eight reads, sums each tool’s reads in a row of its own, its card naming how many and the read it opens', () => {
    const rows: InjectionPanelView['rows'] = Array.from({ length: 9 }, (_, i) => ({ callNo: 4 + i * 2, name: 'get_ticket', from: 'config', readAt: 5 + i * 2, worst: i ? 3 : 0 }));
    const summed = { read: 4, payload: 'system-notice', verdict: 'obeyed' as const, n: 3, of: 27, attempt: { runId: '01K5CQXJ00', callNo: 6 }, line: 'planted at #4 → read at #5 → send_email.to = x7f3kq2m@canary.invalid at #6' };
    const m = injectionMatrix(view({ rows, cells: [], tools: [{ name: 'get_ticket', reads: rows.map((r) => r.callNo), cells: [summed] }] }), RUN, 'inj-01PLANT');
    expect(m.rows.map((r) => r.key)).toEqual(['g:get_ticket']);
    const cell = m.cell(m.rows[0], m.cols[0])!;
    expect(cell).toMatchObject({ word: 'obeyed', tally: '3 of 27 obeyed' });
    expect(JSON.parse(cell.tip!)).toMatchObject({ t: '9 reads of get_ticket · system-notice', s: 'at #4: planted at #4 → read at #5 → send_email.to = x7f3kq2m@canary.invalid at #6' });
    expect(m.cell(m.rows[0], m.cols[1])).toBeNull();
  });

  it('says what was tried, how and when, and its receipt in upstream requests', () => {
    expect(panelMeta(view())).toEqual(['12 attempts', '12 templates, version 1', 'Oct 1, 09:31']);
    expect(panelMeta(view({ by: 'Ana', totals: { attempts: 0, obeyed: 0, influenced: 0, inconclusive: 0, ignored: 0 }, what: 'a payload file' }))).toEqual(['a payload file', 'Ana, Oct 1, 09:31']);
    expect(panelReceipt(view())).toEqual([{ parts: ['this test spent ≈$3.11', 'every call before a read replayed free'] }, { parts: ['819 upstream requests', '6 clean replays to compare with'] }]);
    expect(panelReceipt(view({ receipt: { spent: 25, upstreamRequests: 1, baselines: 1, stopReason: 'the budget of $25.00 is spent' } }))).toEqual([{ parts: ['this test spent ≈$25.00', 'stopped: the budget of $25.00 is spent'] }, { parts: ['1 upstream request', '1 clean replay to compare with'] }]);
  });
});

describe('an attempt’s proof', () => {
  const proof = (parts: ProofParts, why: string | null = null) => renderToStaticMarkup(createElement(Proof, { parts, why, onPick: () => undefined }));
  const text = (html: string) => html.replace(/<[^>]+>/g, '');
  const tabs = (html: string) => [...html.matchAll(/data-call="(\d+)" data-injtab="(\w+)"/g)].map((m) => `#${m[1]} ${m[2]}`);

  it('joins the read to the write, each call a pick on the tab that shows it, the canary in red, = with its field and the value with its call', () => {
    const html = proof({ plantedAt: 4, readAt: 5, evidence: { kind: 'canary', callNo: 6, at: 'send_email.to', value: 'x7f3kq2m@canary.invalid', why: null } });
    expect(text(html)).toBe('planted at #4 → read at #5 → send_email.to = x7f3kq2m@canary.invalid at #6');
    expect(tabs(html)).toEqual(['#4 response', '#5 conversation', '#6 request']);
    expect(html).toContain('<span class="nw">send_email.to =</span> <span class="nw"><b class="cnry">x7f3kq2m@canary.invalid</b> at <button');
  });

  it('says why a write no clean replay made counts, and why an attempt nothing carried the canary out of shows none', () => {
    const write = proof({ plantedAt: 4, readAt: 5, evidence: { kind: 'write', callNo: 9, at: 'send_email(to = a@b.example)', value: null, why: 'no clean replay sent it' } });
    expect(text(write)).toBe('planted at #4 → read at #5 → send_email(to = a@b.example) at #9 · no clean replay sent it');
    expect(write).toContain('<span class="pwhy">· no clean replay sent it</span>');
    expect(text(proof({ plantedAt: 4, readAt: 5, evidence: null }, 'no tool call after #4 carries x7f3kq2m@canary.invalid'))).toBe('planted at #4 → read at #5 · no tool call after #4 carries x7f3kq2m@canary.invalid');
    expect(text(proof({ plantedAt: 4, readAt: null, evidence: null }))).toBe('planted at #4 → read at #?');
  });
});

describe('Needs a look’s Security row', () => {
  it('opens its proof as an attempt link does: while the server is out of reach it says so, and stays where it is', async () => {
    const said: string[] = [];
    const row = { kind: 'injection', icon: 'fail', title: 'send_email obeyed a planted instruction · 8 of 72', detail: 'injection test of 01K5CQ4N7G', key: 'k', group: 'security', step: { of: 'link', label: 'Open proof', href: '#/run/01K5CQ9ATT/6', attempt: true }, href: `#/run/${RUN}`, runId: RUN, fixId: null, at: 0 };
    const page = await render(createElement(AppContext.Provider, { value: { conn: 'offline', toast: (t: string) => said.push(t) } as never }, createElement(LookStepButton, { row: row as never, wait: null, version: '' })));
    expect(page.one('a.btn').getAttribute('href')).toBe('#/run/01K5CQ9ATT/6');
    await page.click(page.one('a.btn'));
    expect(said).toEqual([PAUSED]);
    await page.unmount();
  });
});
