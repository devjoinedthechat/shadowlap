import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunHeader } from '../ui/run/RunHeader.js';
import { headerStatus } from '../ui/runs.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { RunDetail } from '../ui/types.js';

/**
 * A run's header says each thing once: the eyebrow what kind of run it is, the chip beside the id how
 * it stands (in progress, failed, inconclusive, interrupted, or nothing when all is well), and the
 * meta line why it failed. It used to say a failure three times over (*recording · check failed*,
 * FAILED, then the check) and a fork's kind twice (*fork @17*, FORK @17).
 */

const app = { client: {}, exported: false, meta: null, runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined, jobs: [], live: [], feeds: {}, tick: 0, runsTick: 0 } as unknown as AppState;

const REC = '01M5GRX4VY5XKQ0MRGD13QZKZN';
const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';

type State = { status: string; kind: string; outcome: Record<string, unknown>; failed: boolean };

function detail(o: { parent?: boolean; status?: string; divergence?: number | null; state: State; checks?: Array<{ ok: boolean; label: string; detail?: string }> }): RunDetail {
  const d = o.divergence ?? null;
  return {
    run: { runId: RUN, parentRunId: o.parent ? REC : null, mode: o.parent ? 'replay' : 'record', status: o.status ?? 'completed', divergence: d ? { type: 'request_changed', callNo: d, kind: 'api', name: 'POST /v1/messages', replayedBefore: d - 1 } : null, command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: { labels: [], ...(o.checks ? { checks: o.checks } : {}) } },
    label: d ? `fork @${d}` : 'recording',
    about: { text: 'Order A-1150: the customer asks for a refund', from: 'user' },
    source: null,
    summary: { cost: { spent: 0.01, saved: 0, captured: 0 }, imported: false, durationMs: 379, upstreamRequests: 8, byKind: { api: 2, tool: 1, clock: 0, random: 0 } },
    calls: [],
    parent: o.parent ? { runId: REC, label: 'recording' } : null,
    children: [],
    actions: [],
    fix: null,
    state: { ...o.state, interrupted: o.state.status === 'crashed' && !o.state.failed, endedAt: 2, label: d ? `fork @${d}` : 'recording' },
  } as unknown as RunDetail;
}

const header = (run: RunDetail) =>
  renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(RunHeader, { run, call: null, selected: 3, rescued: false, offers: null, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined, labels: run.run.meta?.labels ?? [], setLabels: () => undefined, onMark: () => undefined })));

const part = (html: string, from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const eyebrow = (html: string) => text(part(html, '<div class="eyebrow', '<div class="rtitle"'));
const chips = (html: string) => [...part(html, 'class="rtitle"', 'class="meta"').matchAll(/<span class="tag[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
/** How often a word is said in the header, outside its buttons (which name actions, not the run's state). */
const said = (html: string, word: RegExp) => (part(html, 'class="rmain"', 'class="actions"').replace(/<[^>]+>/g, ' ').match(word) ?? []).length;

describe('a run’s header', () => {
  it('says a failure once in the chip, and why in the meta line, never in the eyebrow', () => {
    const html = header(detail({ status: 'failed', state: { status: 'failed', kind: 'recording', outcome: { kind: 'check-failed', check: 'send_email called 1 time' }, failed: true }, checks: [{ ok: false, label: 'send_email called 1 time', detail: 'called 2 times' }] }));
    expect(eyebrow(html)).toBe('recording');
    expect(chips(html)).toEqual(['failed']);
    expect(html).toContain('class="bad"');
    // The chip, and the check the meta line names: `check failed: send_email …`.
    expect(said(html, /\bfailed\b/g)).toBe(2);
  });

  it('names a fork once, in the eyebrow, with no chip when nothing needs a look', () => {
    const html = header(detail({ parent: true, divergence: 17, state: { status: 'completed', kind: 'fork', outcome: { kind: 'none' }, failed: false } }));
    expect(eyebrow(html)).toBe('fork @17 of 01M5GRX4VY');
    expect(chips(html)).toEqual([]);
    expect(said(html, /fork @17/g)).toBe(1);
  });

  it('says a run that stopped is interrupted once, in a neutral chip', () => {
    const html = header(detail({ parent: true, divergence: 3, status: 'crashed', state: { status: 'crashed', kind: 'fork', outcome: { kind: 'none' }, failed: false } }));
    expect(eyebrow(html)).toBe('fork @3 of 01M5GRX4VY');
    expect(html).toContain('<span class="tag">interrupted</span>');
    expect(said(html, /interrupted/g)).toBe(1);
  });

  it('gives a clean replay its kind and no chip, and a recording in progress its chip', () => {
    const clean = header(detail({ parent: true, state: { status: 'completed', kind: 'clean', outcome: { kind: 'clean' }, failed: false } }));
    expect(eyebrow(clean)).toBe('clean replay of 01M5GRX4VY');
    expect(chips(clean)).toEqual([]);
    const live = header(detail({ status: 'running', state: { status: 'running', kind: 'recording', outcome: { kind: 'running' }, failed: false } }));
    expect(eyebrow(live)).toBe('recording');
    expect(chips(live)).toEqual(['in progress']);
  });

  it('marks a run whose check could not be decided inconclusive, in amber', () => {
    expect(headerStatus({ runId: RUN, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: '', codeVersion: null, startedAt: 1, calls: 3, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], kind: 'recording', outcome: { kind: 'inconclusive' }, failed: false })).toEqual({ cls: 'inc', text: 'inconclusive' });
  });
});
