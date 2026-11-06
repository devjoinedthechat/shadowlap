import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunMetrics } from '../ui/run/parts.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { RunDetail } from '../ui/types.js';

/**
 * Every kind of run's header, as the design's table of them has it (the spec's 3.1): the eyebrow that
 * names its kind, its facts with how it came out first, and its buttons, plain in the design's order,
 * the lime step last before … . The step is the server's (src/next-step.ts, tested there); what the
 * header draws around it is pinned here, one kind at a time.
 */

const app = { client: {}, exported: false, meta: null, runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined, jobs: [], live: [], feeds: {}, tick: 0, runsTick: 0 } as unknown as AppState;

const REC = '01K5CQ5D2W00000000000000AA';
const RUN = '01K5CQ4R1T00000000000000BB';
const CHECK = { ok: false, label: 'send_email called 1 time', detail: 'called 2 times', status: 'failed', callNo: 6 };
const BLAME = { key: 'blame', label: 'Run blame', offer: { from: 'run', expect: CHECK.label, failed: [CHECK.label] } };
const PASSED = { ok: true, label: 'issue_refund called 0 times', status: 'passed' };

interface Kind {
  kind: string;
  status?: string;
  parent?: boolean;
  divergence?: number | null;
  divergenceType?: string;
  meta?: Record<string, unknown>;
  checks?: unknown[];
  outcome?: Record<string, unknown>;
  failed?: boolean;
  interrupted?: boolean;
  next?: Record<string, unknown> | null;
  imported?: boolean;
  calls?: number;
  saved?: number;
  exitCode?: number;
}

function detail(k: Kind): RunDetail {
  const d = k.divergence ?? null;
  const status = k.status ?? 'completed';
  const calls = k.calls ?? 12;
  return {
    run: {
      runId: RUN,
      parentRunId: k.parent ? REC : null,
      mode: k.parent ? 'replay' : 'record',
      status,
      divergence: d ? { type: k.divergenceType ?? 'request_changed', callNo: d, kind: 'api', name: 'POST /v1/messages', replayedBefore: d - 1 } : null,
      command: { argv: ['node', 'agent.mjs'], cwd: '/work' },
      codeVersion: 'd2e8a1f',
      startedAt: 1,
      endedAt: status === 'running' ? null : 2,
      meta: { labels: [], ...(k.checks ? { checks: k.checks } : {}), ...k.meta },
    },
    label: k.kind,
    about: null,
    source: null,
    summary: { total: calls, cost: { spent: 0.0123, saved: k.saved ?? 0, captured: k.imported ? 0.0123 : 0 }, imported: !!k.imported, durationMs: 4200, upstreamRequests: k.parent ? 2 : 8, tokensNotRespent: { inputTokens: k.saved ? 4100 : 0, outputTokens: 0 }, byKind: { api: 8, tool: 4, clock: 0, random: 0 } },
    callsTotal: calls,
    calls: [],
    parent: k.parent ? { runId: REC, label: 'recording' } : null,
    children: [],
    // What a replay brings, as the server words it for each: a recording's own, a replay's of its recording, a capture's with your command.
    actions: k.status === 'running' ? [] : [{ key: 'r', label: 'Replay' }, ...(k.next?.key === 'rule' ? [{ key: 'n', label: 'Add normalizer' }] : [])],
    replay: { key: 'replay', label: k.imported ? 'Replay with your command…' : k.parent ? 'Replay recording' : 'Replay' },
    fix: null,
    ...(k.exitCode ? { exitCode: k.exitCode } : {}),
    ...(k.next ? { next: k.next } : {}),
    state: { status, kind: k.kind, outcome: k.outcome ?? { kind: 'none' }, failed: !!k.failed, interrupted: !!k.interrupted, endedAt: 2, label: k.kind },
  } as unknown as RunDetail;
}

const menu = { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never;
function header(run: RunDetail, rescued = false): string {
  const facts = createElement(RunMetrics, { run, judged: null, notWaitedMs: run.run.parentRunId ? 3100 : null, notWaitedUnknown: 0, rescued });
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(RunHeader, { run, call: null, selected: 3, rescued, offers: null, forkMenu: menu, onAction: () => undefined, onFindCommit: () => undefined, labels: [], setLabels: () => undefined, onMark: () => undefined, facts })));
}

const part = (html: string, from: string, to: string) => html.slice(html.indexOf(from), to ? html.indexOf(to, html.indexOf(from)) : undefined);
const text = (html: string) => html.replace(/<span class="tip"[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
/** What the header says it is, its facts in order, and its buttons in order: a lime one marked `*`, one that is off `(off)`. */
function read(html: string): { eyebrow: string; facts: string[]; buttons: string[] } {
  const eyebrow = text(part(html, '<div class="eyebrow ek"', '<h1'));
  const facts = [...part(html, 'class="metrics"', 'class="meta"').matchAll(/<(?:span|button|a) class="metric[^"]*"[^>]*>([\s\S]*?)<\/(?:span|button|a)>(?=<(?:span|button|a) class="metric|<\/section>)/g)].map((m) => text(m[1]));
  const actions = part(html, 'class="actions"', '');
  const buttons = [...actions.matchAll(/<(button|a) ([^>]*)>([\s\S]*?)<\/\1>/g)]
    .filter((m) => !/role="menuitem"|class="[^"]*\bdz\b/.test(m[2]))
    .map((m) => `${/class="btn lime/.test(m[2]) ? '*' : ''}${text(m[3]) || (/aria-label="([^"]+)"/.exec(m[2])?.[1] ?? '')}${/ disabled=""|aria-disabled="true"/.test(m[2]) ? ' (off)' : ''}`);
  return { eyebrow, facts, buttons };
}

/**
 * Each kind, as the table has it: the run, the eyebrow, its facts (a fact's words, then what its
 * hover's words a screen reader hears after a colon), and its buttons, a lime one marked `*`, one that
 * is off `(off)`, ending in … . A recording still recording can neither be compared, forked nor
 * replayed yet; a failure's step is Run blame, or Open fix once a fix holds it; a recording that passed
 * with no golden leads with Pack as golden… (Q10, as port/next-step built it), Replay plain beside it;
 * a fork, a rescued fork and every attempt lead with Compare with parent; a test replay with what its
 * outcome asks for, a crash's Run blame beside Find breaking commit; an interrupted run as its kind.
 */
const KINDS: Array<[string, [Kind, boolean?], string, string, string]> = [
  // recording
  ['recording', [{ kind: 'recording', status: 'running', outcome: { kind: 'running' }, next: { key: 'replay', label: 'Replay', off: 'Replay once it finishes recording' } }], 'recording', 'in progress : It is judged once it finishes. · 12 calls so far · ≈$0.012 spent', 'Compare (off) · Share · Fork at #3 (off) · *Replay (off) · More actions'],
  // failed
  ['failed', [{ kind: 'recording', status: 'failed', checks: [CHECK], outcome: { kind: 'check-failed', check: CHECK.label }, failed: true, next: BLAME }], 'recording', 'check failed : send_email called 1 time · 12 calls · ≈$0.012 spent', 'Compare (off) · Share · Replay · Fork at #3 · *Run blame · More actions'],
  // fix
  ['fix', [{ kind: 'recording', status: 'failed', checks: [CHECK], outcome: { kind: 'check-failed', check: CHECK.label }, failed: true, next: { key: 'fix', label: 'Open fix', href: '#/fixes/fx-1' } }], 'recording', 'check failed : send_email called 1 time · 12 calls · ≈$0.012 spent', 'Compare (off) · Share · Replay · Fork at #3 · *Open fix · More actions'],
  // unpacked
  ['unpacked', [{ kind: 'recording', next: { key: 'pack', label: 'Pack as golden…', runId: RUN, folder: 'goldens/refund-over-limit' } }], 'recording', 'no checks · 12 calls · ≈$0.012 spent', 'Compare (off) · Share · Replay · Fork at #3 · *Pack as golden… · More actions'],
  // golden
  ['golden', [{ kind: 'recording', checks: [PASSED, PASSED], outcome: { kind: 'passed', checks: 2 }, next: { key: 'replay', label: 'Replay' } }], 'recording', '2 checks passed · 12 calls · ≈$0.012 spent', 'Compare (off) · Share · Fork at #3 · *Replay · More actions'],
  // clean
  ['clean', [{ kind: 'clean', parent: true, saved: 0.0098, outcome: { kind: 'clean' }, next: { key: 'replay', label: 'Replay recording' } }], 'clean replay of 01K5CQ5D2W', 'no checks · 12 calls · ≈$0.012 spent · $0.0098 not re-spent · 3.1 s not waited', 'Compare with parent · Share · Fork at #3 · *Replay recording · More actions'],
  // fork
  ['fork', [{ kind: 'fork', parent: true, divergence: 17, next: { key: 'compare', label: 'Compare with parent', href: `#/compare/${REC}/${RUN}` } }], 'fork @17 of 01K5CQ5D2W', 'no checks · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Share · Replay recording · Fork at #3 · *Compare with parent · More actions'],
  // forkFailed
  ['forkFailed', [{ kind: 'fork', parent: true, divergence: 3, status: 'failed', checks: [CHECK], outcome: { kind: 'check-failed', check: CHECK.label }, failed: true, next: BLAME }], 'fork @3 of 01K5CQ5D2W', 'check failed : send_email called 1 time · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Compare with parent · Share · Replay recording · Fork at #3 · *Run blame · More actions'],
  // rescued
  ['rescued', [{ kind: 'fork', parent: true, divergence: 9, divergenceType: 'forced', meta: { probe: { of: REC, callNo: 9, passed: true } }, next: { key: 'compare', label: 'Compare with parent', href: `#/compare/${REC}/${RUN}` } }, true], 'rescued fork of 01K5CQ5D2W', 'passed · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Share · Replay recording · Fork at #3 · *Compare with parent · More actions'],
  // test
  ['test', [{ kind: 'test', parent: true, meta: { test: { golden: 'goldens/refund-over-limit', session: 'S1' } }, checks: [PASSED], outcome: { kind: 'passed', checks: 1 }, next: { key: 'replay', label: 'Replay recording' } }], 'test replay of 01K5CQ5D2W', '1 check passed · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Compare with parent · Share · Fork at #3 · *Replay recording · More actions'],
  // diverged
  ['diverged', [{ kind: 'test', parent: true, divergence: 1, status: 'failed', meta: { test: { golden: 'goldens/refund-over-limit', session: 'S1' } }, outcome: { kind: 'diverged', callNo: 1 }, failed: true, next: { key: 'rule', label: 'Add normalizer and re-run', rules: [{ path: '$.metadata.user_id', type: 'uuid' }] } }], 'test replay of 01K5CQ5D2W', 'diverged at #1 : A request changed. · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Compare with parent · Share · Replay recording · Fork at #3 · *Add normalizer and re-run · More actions'],
  // crash
  ['crash', [{ kind: 'test', parent: true, status: 'failed', meta: { test: { golden: 'goldens/refund-over-limit', session: 'S1' } }, exitCode: 1, outcome: { kind: 'check-failed', check: null }, failed: true, next: { key: 'bisect', label: 'Find breaking commit', blame: BLAME } }], 'test replay of 01K5CQ5D2W', 'exited 1 · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Compare with parent · Share · Replay recording · Run blame · Fork at #3 · *Find breaking commit · More actions'],
  // inconclusive
  ['inconclusive', [{ kind: 'test', parent: true, meta: { test: { golden: 'goldens/refund-over-limit', session: 'S1' } }, checks: [{ ok: false, label: 'judge "explains-escalation"', status: 'inconclusive' }], outcome: { kind: 'inconclusive', check: 'judge "explains-escalation"' }, next: { key: 'update-golden', label: 'Update golden' } }], 'test replay of 01K5CQ5D2W', 'inconclusive : judge &quot;explains-escalation&quot; · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Compare with parent · Share · Replay recording · Fork at #3 · *Update golden · More actions'],
  // capture
  ['capture', [{ kind: 'capture', imported: true, status: 'failed', checks: [CHECK], outcome: { kind: 'check-failed', check: CHECK.label }, failed: true, meta: { imported: { from: 'langfuse', file: 'trace.json' } }, next: BLAME }], 'capture', 'check failed : send_email called 1 time · 12 calls · $0.012 as captured', 'Compare (off) · Share · Replay with your command… · Fork at #3 · *Run blame · More actions'],
  // probe
  ['probe', [{ kind: 'fork', parent: true, divergence: 5, divergenceType: 'forced', meta: { probe: { of: REC, callNo: 5, passed: true, verdict: 'passed' }, repeat: { group: 'g-5', attempt: 2, of: 20 } }, next: { key: 'compare', label: 'Compare with parent', href: `#/compare/${REC}/${RUN}` } }], 'blame attempt of 01K5CQ5D2W', 'passed · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Share · Replay recording · Fork at #3 · *Compare with parent · More actions'],
  // verify
  ['verify', [{ kind: 'fork', parent: true, divergence: 1, meta: { verify: { role: 'target', passed: true, verdict: 'passed' }, repeat: { group: 'v', attempt: 4, of: 80 } }, next: { key: 'compare', label: 'Compare with parent', href: `#/compare/${REC}/${RUN}` } }], 'verify attempt of 01K5CQ5D2W', 'passed · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Share · Replay recording · Fork at #3 · *Compare with parent · More actions'],
  // repeat
  ['repeat', [{ kind: 'fork', parent: true, divergence: 17, meta: { repeat: { group: 'r', attempt: 3, of: 5 } }, next: { key: 'compare', label: 'Compare with parent', href: `#/compare/${REC}/${RUN}` } }], 'repeat attempt of 01K5CQ5D2W', 'passed · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Share · Replay recording · Fork at #3 · *Compare with parent · More actions'],
  // testAttempt
  ['testAttempt', [{ kind: 'test', parent: true, divergence: 3, meta: { test: { golden: 'goldens/refund-over-limit', session: 'S1', attempt: 2, of: REC } }, checks: [PASSED], outcome: { kind: 'passed', checks: 1 }, next: { key: 'compare', label: 'Compare with parent', href: `#/compare/${REC}/${RUN}` } }], 'test attempt of 01K5CQ5D2W', 'passed · 12 calls · ≈$0.012 spent · 3.1 s not waited', 'Share · Replay recording · Fork at #3 · *Compare with parent · More actions'],
  // interrupted
  ['interrupted', [{ kind: 'recording', status: 'crashed', interrupted: true, next: { key: 'replay', label: 'Replay' } }], 'recording', 'interrupted : Ctrl-C, a kill or a crash: it stopped, and did not fail. · 12 calls · ≈$0.012 spent', 'Compare (off) · Share · Fork at #3 · *Replay · More actions'],
  // replay
  ['replay', [{ kind: 'replay', parent: true, calls: 0, next: { key: 'replay', label: 'Replay recording' } }], 'replay of 01K5CQ5D2W', 'no checks · 0 calls · ≈$0.012 spent · 3.1 s not waited', 'Compare with parent · Share · Fork at #3 · *Replay recording · More actions'],
];

describe('every kind of run’s header', () => {
  it.each(KINDS)('reads as the design’s table has it: %s', (_name, [kind, rescued], eyebrow, facts, buttons) => {
    const got = read(header(detail(kind), !!rescued));
    expect(got.eyebrow).toBe(eyebrow);
    expect(got.facts.join(' · ')).toBe(facts);
    expect(got.buttons.join(' · ')).toBe(buttons);
  });
});
