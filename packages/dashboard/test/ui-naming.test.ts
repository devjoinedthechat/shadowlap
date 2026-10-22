import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunHeader } from '../ui/run/RunHeader.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { RunDetail, RunListItem } from '../ui/types.js';

/**
 * A run is named by its id everywhere, with one quiet line that says what it was about (decision
 * 10): each place that names a run draws its id, in mono and whole, and its about line where it has
 * room, as the line the fitter fits (about.ts), with all of it on hover.
 */

const app = (over: Partial<AppState> = {}): AppState =>
  ({
    client: {},
    exported: false,
    meta: null,
    runs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    refresh: () => undefined,
    registerLayer: () => () => undefined,
    jobs: [],
    live: [],
    feeds: {},
    tick: 0,
    runsTick: 0,
    ...over,
  }) as unknown as AppState;

const inApp = (el: ReactElement, over: Partial<AppState> = {}) => renderToStaticMarkup(createElement(AppContext.Provider, { value: app(over) }, el));

const REC = '01M5GRX4VY5XKQ0MRGD13QZKZN';
const FORK = '01M5GRX8K406H4KHQ7DEKYWTSZ';

function detail(over: { runId?: string; parent?: string | null; about?: RunDetail['about']; divergence?: number | null; labels?: string[]; source?: string | null; status?: string; kind?: string; failed?: boolean } = {}): RunDetail {
  const runId = over.runId ?? FORK;
  const parent = over.parent === undefined ? REC : over.parent;
  const d = over.divergence === undefined ? 17 : over.divergence;
  return {
    run: { runId, parentRunId: parent, mode: parent ? 'replay' : 'record', status: over.status ?? 'completed', divergence: d ? { type: 'request_changed', callNo: d, kind: 'api', name: 'POST /v1/messages', replayedBefore: d - 1 } : null, command: { argv: ['node', 'refund_agent.mjs', 'T-8812'], cwd: '/work' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: { labels: over.labels ?? ['what-if'] } },
    label: d ? `fork @${d}` : 'recording',
    about: over.about === undefined ? { text: 'override #16', from: 'change', change: { flag: '--override', callNo: 16, forkAt: 17 } } : over.about,
    source: over.source ?? null,
    summary: { cost: { spent: 0.01, saved: 0, captured: 0 }, imported: false, durationMs: 379, upstreamRequests: 8, byKind: { api: 1, tool: 1, clock: 0, random: 0 } },
    calls: [],
    parent: parent ? { runId: parent, label: 'recording' } : null,
    children: [],
    actions: [],
    fix: null,
    state: { status: over.status ?? 'completed', endedAt: 2, kind: over.kind ?? (d ? 'fork' : 'recording'), outcome: { kind: over.failed ? 'check-failed' : 'none' }, failed: !!over.failed, interrupted: false, label: d ? `fork @${d}` : 'recording' },
  } as unknown as RunDetail;
}

const header = (run: RunDetail, runs: RunListItem[] = []) => inApp(createElement(RunHeader, { run, call: null, selected: 17, rescued: false, offers: null, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined }), { runs });

describe('a run’s page names it by its id, with its about line under it', () => {
  it('heads the page with the id in mono, the about line under it and the labels after it', () => {
    const html = header(detail());
    expect(html).toMatch(/<h1 class="rnm" title="01M5GRX8K406H4KHQ7DEKYWTSZ">01M5GRX8K4<\/h1>/);
    const about = html.slice(html.indexOf('class="rabout"'));
    expect(about).toMatch(/^class="rabout"><span class="rab" data-about="override #16" data-from="change" title="override #16">override #16<\/span><span class="labelbar">/);
    expect(about).toContain('what-if');
  });

  it('names only the kind in the eyebrow: the parent is in the crumbs, and a phone reads it after the kind', () => {
    const html = header(detail(), [{ runId: REC, about: { text: 'Ticket T-8812 arrived damaged', from: 'user' } } as RunListItem]);
    const eyebrow = html.slice(html.indexOf('class="eyebrow'), html.indexOf('class="rtitle"'));
    expect(eyebrow).toContain('<span class="ebk">fork @17</span>');
    expect(eyebrow).toContain(`<span class="ebp"><span class="ebof">of</span><a href="#/run/${REC}" title="Ticket T-8812 arrived damaged"><code>01M5GRX4VY</code></a></span>`);
  });

  it('gives a clean replay, whose about line says what the eyebrow does, no line of its own: its labels sit after Copy ID', () => {
    const html = header(detail({ divergence: null, about: { text: 'clean replay', from: 'nothing', change: null }, kind: 'clean' }));
    expect(html).not.toContain('class="rabout"');
    expect(html).not.toContain('data-about');
    const title = html.slice(html.indexOf('class="rtitle"'), html.indexOf('class="meta"'));
    expect(title).toContain('class="labelbar"');
  });

  it('leaves out of an import’s meta line the file its about line names', () => {
    const html = header(detail({ parent: null, divergence: null, source: 'refund-A-1077.har', about: { text: 'refund-A-1077.har', from: 'source' }, kind: 'capture' }));
    expect(html).toContain('data-about="refund-A-1077.har"');
    expect(html.slice(html.indexOf('class="meta"'))).not.toContain('refund-A-1077.har');
  });

  it('shows the id alone for a run an older server sends no about line for', () => {
    const html = header(detail({ about: null }));
    expect(html).toContain('<h1 class="rnm"');
    expect(html).not.toContain('class="rabout"');
  });
});
