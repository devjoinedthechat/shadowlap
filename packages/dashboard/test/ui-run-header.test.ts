import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScopeBar } from '../ui/run/parts.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { RunDetail } from '../ui/types.js';

/**
 * A run's header says each thing once: the eyebrow what kind of run it is, muted, the id's card (the
 * meta: command, revision, time) why it failed, and the facts how it stands. No chip beside the id says
 * it again: it used to say a failure three times over (*recording · check failed*, FAILED, then the
 * check) and a fork's kind twice (*fork @17*, FORK @17). It is drawn flat, in the mock's DOM order: the
 * title, the about line, the facts, the card, then the buttons, which end in … with Delete run.
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

const header = (run: RunDetail, facts: string | null = null) =>
  renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(RunHeader, { run, call: null, selected: 3, rescued: false, offers: null, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined, labels: run.run.meta?.labels ?? [], setLabels: () => undefined, onMark: () => undefined, facts: facts ? createElement('section', { className: 'metrics' }, facts) : null })));

const part = (html: string, from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const eyebrow = (html: string) => text(part(html, '<div class="eyebrow ek"', '<h1'));
const card = (html: string) => part(html, '<div class="meta"', '<div class="actions"');
/** How often a word is said in the header, outside its buttons (which name actions, not the run's state). */
const said = (html: string, word: RegExp) => (part(html, 'class="rtitle"', 'class="actions"').replace(/<[^>]+>/g, ' ').match(word) ?? []).length;
const FAILED = { status: 'failed', state: { status: 'failed', kind: 'recording', outcome: { kind: 'check-failed', check: 'send_email called 1 time' }, failed: true }, checks: [{ ok: false, label: 'send_email called 1 time', detail: 'called 2 times' }] };

describe('a run’s header', () => {
  it('says a failure once, in the id’s card, never in the eyebrow, with no chip', () => {
    const html = header(detail(FAILED));
    expect(eyebrow(html)).toBe('recording');
    expect(html).not.toContain('class="tag');
    expect(card(html)).toContain('class="mfail"');
    expect(said(html, /\bfailed\b/g)).toBe(1);
  });

  it('makes the id a Tab stop its card describes, the whole id on Copy ID’s card, not in a title', () => {
    const html = header(detail(FAILED));
    expect(html).toContain(`<h1 class="rnm" tabindex="0" aria-describedby="rmeta" data-run="${RUN}">01M5GRX8K4</h1>`);
    expect(card(html)).toMatch(/^<div class="meta" id="rmeta" role="note">/);
    // Its start and its duration are one piece.
    expect(text(part(card(html), '<span class="mwhen">', '<span class="mfail"'))).toMatch(/ 379 ?ms$/);
    expect(part(html, '<button class="linkbtn"', '</button>')).toContain(RUN);
  });

  it('draws it flat, in the mock’s order: title, about line, facts, card, then the buttons', () => {
    const html = header(detail(FAILED), 'calls');
    const at = ['class="rtitle"', 'class="eyebrow ek"', 'class="rabout"', 'class="metrics"', 'class="meta"', 'class="actions"'].map((c) => html.indexOf(c));
    expect(at.every((n) => n > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual([at[0], at[1], at[2], at[3], at[4], at[5]]);
    expect(html).not.toContain('rmain');
  });

  it('ends the buttons in … with Delete run, not a Delete of its own, and names each one that folds', () => {
    const html = header(detail(FAILED));
    const actions = part(html, 'class="actions"', '</section>');
    expect(actions).toMatch(/<button class="btn quiet more" type="button" id="moreBtn" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" data-tip="[^"]*More: Delete[^"]*"><svg aria-hidden="true"><use href="#i-more"><\/use><\/svg><\/button><\/div>$/);
    expect(text(actions)).not.toMatch(/\bDelete\b/);
    expect(actions).toContain('id="shareBtn"');
    expect(actions).toContain('data-fold="replay"');
  });

  it('names a fork once, in the eyebrow', () => {
    const html = header(detail({ parent: true, divergence: 17, state: { status: 'completed', kind: 'fork', outcome: { kind: 'none' }, failed: false } }));
    expect(eyebrow(html)).toBe('fork @17 of 01M5GRX4VY');
    expect(said(html, /fork @17/g)).toBe(1);
  });

  it('leaves how an interrupted run stands to its facts, with no chip', () => {
    const html = header(detail({ parent: true, divergence: 3, status: 'crashed', state: { status: 'crashed', kind: 'fork', outcome: { kind: 'none' }, failed: false } }));
    expect(eyebrow(html)).toBe('fork @3 of 01M5GRX4VY');
    expect(html).not.toContain('class="tag');
  });

  it('gives a clean replay its kind, and a recording in progress says so on its card', () => {
    const clean = header(detail({ parent: true, state: { status: 'completed', kind: 'clean', outcome: { kind: 'clean' }, failed: false } }));
    expect(eyebrow(clean)).toBe('clean replay of 01M5GRX4VY');
    const live = header(detail({ status: 'running', state: { status: 'running', kind: 'recording', outcome: { kind: 'running' }, failed: false } }));
    expect(eyebrow(live)).toBe('recording');
    expect(live).not.toContain('class="tag');
    expect(text(card(live))).toContain('recording…');
    // The eyebrow names only the kind: a replay still being made is a replay, never a recording.
    const replaying = header(detail({ parent: true, status: 'running', state: { status: 'running', kind: 'clean', outcome: { kind: 'running' }, failed: false } }));
    expect(eyebrow(replaying)).toBe('clean replay of 01M5GRX4VY');
  });

  it('opens the trace an import read the run from in the store it came from, after Compare, in a tab of its own', () => {
    const id = '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07';
    const url = `https://cloud.langfuse.com/project/cm1shopproject/traces/${id}`;
    const html = header({ ...detail({ state: { status: 'completed', kind: 'recording', outcome: { kind: 'none' }, failed: false } }), trace: { url, store: 'Langfuse', id } });
    const actions = part(html, '<div class="actions">', '</div>');
    expect(text(actions)).toMatch(/^Compare Open in Langfuse ↗ /);
    const link = /<a [^>]*>Open in Langfuse/.exec(actions)?.[0] ?? '';
    expect(link).toContain(`href="${url}"`);
    expect(link).toContain('target="_blank" rel="noopener noreferrer"');
    expect(JSON.parse(/data-tip="([^"]*)"/.exec(link)![1].replace(/&quot;/g, '"'))).toMatchObject({ t: 'Open in Langfuse', s: `The trace it was imported from, ${id}, on cloud.langfuse.com` });
    expect(header(detail({ state: { status: 'completed', kind: 'recording', outcome: { kind: 'none' }, failed: false } }))).not.toContain('Open in');
  });
});

describe('the run’s agents chips', () => {
  it('say each agent’s word and count apart', () => {
    const calls = [
      { callNo: 1, scope: 'customer', kind: 'api' },
      { callNo: 2, scope: 'agent', kind: 'api' },
      { callNo: 3, scope: 'agent', kind: 'tool' },
    ];
    const run = { run: { runId: '01M781NKXK0SFB6W51R56AKDAE' }, calls } as unknown as RunDetail;
    const html = renderToStaticMarkup(createElement(ScopeBar, { run, scopes: ['agent', 'customer'], scope: 'all', onScope: () => undefined }));
    const words = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]*>/g, ''));
    expect(words).toEqual(['All 3', 'agent 2', 'customer 1']);
  });
});
