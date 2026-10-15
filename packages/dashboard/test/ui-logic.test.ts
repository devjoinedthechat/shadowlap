import { describe, expect, it } from 'vitest';
import { forkMenu, forkMenuTitle, menuFlag, menuLabel, type ActionLike } from '../ui/actions.js';
import { backoffSeconds, isUnreachable } from '../ui/backoff.js';
import { cacheMisses, cacheReadShare, steadyCacheNote, type UsageCall } from '../ui/cache.js';
import { approx, compactPath, dur, durLong, ktok, money, projectOfStore, tildePath, whenShort } from '../ui/format.js';
import { jobStatus, jobTitle, lastLine, lineTone } from '../ui/jobs.js';
import { displayOrigin, parseOrigins } from '../ui/origins.js';
import { highlight, limitRecorded, matchPalette, snippetParts, type PaletteEntry } from '../ui/palette.js';
import { callDetail, modelCallOf, resultLine, ticksFor, timelineOf, timeOf, tokensText, turnsOf, type CallLike } from '../ui/run/calls.js';
import { indexCalls, notWaited, recordedDuration, type DurationCall } from '../ui/recorded.js';
import { GO_KEYS, href, nextView, parseRoute, readTokenLink, routeHref } from '../ui/route.js';
import { compareTarget, defaultComparePair, isFailed, matchesChip, matchesText, runOutcome, runSubline, runTree, runType, sideLine, sortRuns, type RunLike } from '../ui/runs.js';
import { inScope, scopeCount, scopesOf } from '../ui/scopes.js';
import { binCalls, gridCells, miniCells, stripCells, type StripItem } from '../ui/strip.js';

describe('routes', () => {
  it('reads every page, a run at a call in a view, and the old call links', () => {
    expect(parseRoute('')).toEqual({ page: 'overview' });
    expect(parseRoute('#/')).toEqual({ page: 'overview' });
    expect(parseRoute('#/runs')).toEqual({ page: 'runs' });
    expect(parseRoute('#/run/01K5CQ4P2R')).toEqual({ page: 'run', id: '01K5CQ4P2R', call: null, view: null });
    expect(parseRoute('#/run/01K5CQ4P2R/17')).toEqual({ page: 'run', id: '01K5CQ4P2R', call: 17, view: null });
    expect(parseRoute('#/run/01K5CQ4P2R/17/context')).toEqual({ page: 'run', id: '01K5CQ4P2R', call: 17, view: 'context' });
    expect(parseRoute('#/run/01K5CQ4P2R/timeline')).toEqual({ page: 'run', id: '01K5CQ4P2R', call: null, view: 'timeline' });
    // The CLI has printed #/run/<id>/call/<n> links; they keep opening the call.
    expect(parseRoute('#/run/01K5CQ4P2R/call/9')).toEqual({ page: 'run', id: '01K5CQ4P2R', call: 9, view: null });
    expect(parseRoute('#/run/01K5CQ4P2R/0')).toMatchObject({ call: null });
    expect(parseRoute('#/run/not a run')).toMatchObject({ page: 'notfound' });
    expect(parseRoute('#/compare')).toEqual({ page: 'compare', a: null, b: null });
    expect(parseRoute('#/compare/01AAA/01BBB')).toEqual({ page: 'compare', a: '01AAA', b: '01BBB' });
    expect(parseRoute('#/fixes/fx-12/verify/vf-3')).toEqual({ page: 'fixes', id: 'fx-12', step: 'verify', sub: 'vf-3' });
    expect(parseRoute('#/training/tasks')).toEqual({ page: 'training', tab: 'tasks' });
    expect(parseRoute('#/training')).toEqual({ page: 'training', tab: 'pairs' });
    expect(parseRoute('#/settings/redaction')).toEqual({ page: 'settings', tab: 'redaction' });
    expect(parseRoute('#/releases/v2.4.0')).toEqual({ page: 'releases', id: 'v2.4.0' });
    expect(parseRoute('#/new')).toEqual({ page: 'new' });
    expect(parseRoute('#/setup')).toEqual({ page: 'setup' });
    expect(parseRoute('#/nowhere')).toEqual({ page: 'notfound', path: 'nowhere' });
    expect(parseRoute('#/run/%E0%A4%A')).toMatchObject({ page: 'notfound' });
  });

  it('writes routes back the way it reads them, Calls being the default view', () => {
    expect(href.run('01K5CQ4P2R', 17)).toBe('#/run/01K5CQ4P2R/17');
    expect(href.run('01K5CQ4P2R', 17, 'calls')).toBe('#/run/01K5CQ4P2R/17');
    expect(href.run('01K5CQ4P2R', 17, 'forks')).toBe('#/run/01K5CQ4P2R/17/forks');
    expect(href.run('01K5CQ4P2R', null, 'context')).toBe('#/run/01K5CQ4P2R/context');
    for (const h of ['#/', '#/runs', '#/run/01K5CQ4P2R/3/turns', '#/compare/01A/01B', '#/compare', '#/fixes/fx-1/repair', '#/tests', '#/training/tasks', '#/settings/project', '#/new', '#/setup', '#/releases/v1']) {
      expect(routeHref(parseRoute(h))).toBe(h);
    }
  });

  it('keeps the deep link the CLI prints: a token, then the view to open', () => {
    expect(readTokenLink('#token=abc_DEF-1&open=/run/01K5CQ4P2R/call/17')).toEqual({ token: 'abc_DEF-1', open: '#/run/01K5CQ4P2R/call/17' });
    expect(readTokenLink('#token=abc')).toEqual({ token: 'abc', open: '#/' });
    expect(readTokenLink('#/runs')).toBeNull();
    expect(parseRoute(readTokenLink('#token=t&open=/run/01K5CQ4P2R/call/17')!.open)).toMatchObject({ page: 'run', call: 17 });
  });

  it('has a g-key for every page and cycles the five views without Provenance', () => {
    expect(Object.keys(GO_KEYS).sort()).toEqual(['a', 'c', 'f', 'o', 'r', 's', 't']);
    expect(nextView('calls')).toBe('turns');
    expect(nextView('forks')).toBe('calls');
    expect(nextView('provenance')).toBe('calls');
    expect(nextView(null)).toBe('turns');
  });
});

describe('palette', () => {
  const run = (label: string, hint: string): PaletteEntry => ({ group: 'Runs', label, hint });
  const items: PaletteEntry[] = [
    { group: 'Go to', label: 'Overview', hint: '' },
    { group: 'Go to', label: 'Runs', hint: '' },
    { group: 'Actions', label: 'Keyboard shortcuts', hint: '?' },
    run('01K5CQ6L0P', 'recording · python refund_agent.py'),
    run('01K5CQ3W6H', 'recording · node agent.mjs'),
    run('01K5CQ4V5K', 'test · shadowlap test goldens/refund'),
    run('01K5CQ4N7G', 'recording · python refund_agent.py · refund-flow'),
    run('01K5CQ4N9A', 'replay · python refund_agent.py'),
    run('01K5CQ4R1T', 'fork @17 · python refund_agent.py'),
    { group: 'Fixes', label: 'Confirmation email sent twice', hint: 'email · open' },
    { group: 'Projects', label: 'Switch to invoice-bot', hint: '~/code/invoice-bot' },
    { group: 'This run', label: 'Replay 01K5CQ4P2R', hint: 'shadowlap replay' },
  ];

  it('lists This run, Go to, Actions, the five newest runs and Projects when nothing is typed', () => {
    const shown = matchPalette(items, '  ');
    expect(shown.map((x) => x.group)).toEqual(['This run', 'Go to', 'Go to', 'Actions', 'Runs', 'Runs', 'Runs', 'Runs', 'Runs', 'Projects']);
    expect(shown.filter((x) => x.group === 'Runs').map((x) => x.label)).toEqual(['01K5CQ6L0P', '01K5CQ3W6H', '01K5CQ4V5K', '01K5CQ4N7G', '01K5CQ4N9A']);
  });

  it('needs every typed word in the label or the hint, and ranks a label that starts with the first word', () => {
    expect(matchPalette(items, 'refund fork').map((x) => x.label)).toEqual(['01K5CQ4R1T']);
    expect(matchPalette(items, 'RUNS').map((x) => x.label)).toEqual(['Runs']);
    expect(matchPalette(items, 'email').map((x) => x.label)).toEqual(['Confirmation email sent twice']);
    expect(matchPalette(items, 'r').slice(0, 3).map((x) => x.label)).toEqual(['Replay 01K5CQ4P2R', 'Runs', 'Overview']);
    expect(matchPalette(items, 'nothing like this')).toEqual([]);
  });

  it('keeps at most six hits from recorded data, two per run', () => {
    const hits = ['a', 'a', 'a', 'b', 'c', 'c', 'd', 'e', 'f'].map((runId, i) => ({ runId, i }));
    expect(limitRecorded(hits).map((h) => h.i)).toEqual([0, 1, 3, 4, 5, 6]);
  });

  it('marks the first typed word and the server’s matches', () => {
    expect(highlight('Keyboard shortcuts', 'short')).toEqual(['Keyboard ', 'short', 'cuts']);
    expect(highlight('Runs', 'zzz')).toBeNull();
    expect(snippetParts('the \u0001refund\u0002 policy says\n\u0001refund\u0002s')).toEqual([
      { text: 'the ', match: false },
      { text: 'refund', match: true },
      { text: ' policy says ', match: false },
      { text: 'refund', match: true },
      { text: 's', match: false },
    ]);
  });
});

describe('strip', () => {
  const calls = (origins: string): StripItem[] => [...origins].map((ch, i) => ({ n: i + 1, origin: parseOrigins(ch)![0]! }));

  it('keeps one cell per call up to the limit, with the fork and the lost call marked', () => {
    const cells = stripCells(calls('rrrrlb'), { selected: 5, forkAt: 5, lostAt: null });
    expect(cells).toHaveLength(6);
    expect(cells[4]).toMatchObject({ first: 5, last: 5, origin: 'live', selected: true, mark: 'fork' });
    expect(stripCells(calls('rrl'), { selected: null, forkAt: null, lostAt: 2 })[1]).toMatchObject({ mark: 'lost' });
  });

  it('groups past 360 calls: a range takes its most notable origin and counts each origin', () => {
    const many = calls('r'.repeat(905) + 'b' + 'r'.repeat(294));
    const cells = stripCells(many, { selected: 1, forkAt: null, lostAt: null });
    expect(cells).toHaveLength(300);
    const blocked = cells.find((c) => c.first <= 906 && c.last >= 906)!;
    expect(blocked).toMatchObject({ origin: 'block', target: 906, counts: { rep: 3, block: 1 } });
    expect(cells[0]).toMatchObject({ first: 1, last: 4, selected: true, target: 1 });
  });

  it('opens the fork inside a range before the selection, and dims ranges outside the scope', () => {
    const many = calls('r'.repeat(400) + 'l'.repeat(400));
    const cells = stripCells(many, { selected: 402, forkAt: 401, lostAt: null, inScope: (n) => n <= 400 });
    const at = cells.find((c) => c.first <= 401 && c.last >= 401)!;
    expect(at).toMatchObject({ target: 401, mark: 'fork', dim: false });
    expect(cells.at(-1)).toMatchObject({ dim: true });
  });

  it('ranks the rarest origin highest and leaves short runs alone', () => {
    expect(binCalls(calls('rl'), 360)).toBeNull();
    expect(binCalls(calls('rlsboif'), 1)![0]).toMatchObject({ origin: 'fail', notable: 7, size: 7 });
    expect(miniCells(parseOrigins('rrrr')!, 60)).toEqual(['rep', 'rep', 'rep', 'rep']);
    expect(miniCells(parseOrigins('r'.repeat(119) + 'b')!, 60)).toHaveLength(60);
    expect(miniCells(parseOrigins('r'.repeat(119) + 'b')!, 60).at(-1)).toBe('block');
  });

  it('reads origins as a compact string or as names, and refuses anything else', () => {
    expect(parseOrigins('rlobsif')).toEqual(['rep', 'live', 'over', 'block', 'stub', 'inject', 'fail']);
    expect(parseOrigins(['replayed', 'live', 'injected'])).toEqual(['rep', 'live', 'inject']);
    expect(parseOrigins('rx')).toBeNull();
    expect(parseOrigins(undefined)).toBeNull();
    expect(displayOrigin({ origin: 'live', outcome: 'error' })).toBe('fail');
    expect(displayOrigin({ origin: 'blocked', outcome: 'error' })).toBe('block');
    expect(displayOrigin({ origin: 'injected', outcome: 'error' })).toBe('inject');
    expect(displayOrigin({ origin: 'replayed', outcome: 'ok' })).toBe('rep');
  });
});

describe('recorded duration', () => {
  const c = (callNo: number, origin: string, latencyMs: number | null, replayedFrom?: number): DurationCall => ({ callNo, origin, latencyMs, ...(replayedFrom ? { replayedFrom } : {}) });
  const recording = indexCalls([c(1, 'live', 2400), c(2, 'live', 410), c(3, 'live', 3900)]);
  const replay = indexCalls([c(1, 'replayed', 2, 1), c(2, 'replayed', 1, 2), c(3, 'live', 3100)]);

  it('takes a live call’s own time, and a replayed call’s from the run it was recorded in', () => {
    expect(recordedDuration(c(3, 'live', 3100), [])).toBe(3100);
    expect(recordedDuration(c(2, 'replayed', 1, 2), [recording])).toBe(410);
  });

  it('follows a replay of a replay back to the recording, by the call it was replayed from', () => {
    expect(recordedDuration(c(1, 'replayed', 1, 1), [replay, recording])).toBe(2400);
    // A replay of the replay's live call: that call's own time.
    expect(recordedDuration(c(3, 'replayed', 1, 3), [replay, recording])).toBe(3100);
    expect(recordedDuration(c(1, 'replayed', 1, 1), [replay])).toBeNull();
    expect(recordedDuration({ callNo: 1, origin: 'replayed', latencyMs: 1, recordedMs: 999 }, [])).toBe(999);
  });

  it('sums the time not waited and counts what it could not find', () => {
    expect(notWaited([c(1, 'replayed', 2, 1), c(2, 'replayed', 1, 2), c(3, 'live', 100)], [recording])).toEqual({ ms: 2810, unknown: 0 });
    expect(notWaited([c(1, 'replayed', 2, 1), c(9, 'replayed', 1, 9)], [recording])).toEqual({ ms: 2400, unknown: 1 });
  });
});

describe('cache misses', () => {
  const m = (callNo: number, cacheRead: number, input: number, cacheWrite = 0, scope?: string, conversation?: number): UsageCall => ({
    callNo,
    kind: 'api',
    usage: { input, output: 50, cacheRead, cacheWrite },
    ...(scope ? { scope } : {}),
    ...(conversation ? { conversation } : {}),
  });

  it('flags a call that read less than the previous call’s whole input, by 1,024 tokens or more', () => {
    const calls = [m(1, 0, 200, 3000), m(3, 3000, 100, 400), m(5, 3400, 80, 300), m(17, 1200, 2700, 500), m(19, 4400, 60, 200)];
    expect(cacheMisses(calls)).toEqual([{ callNo: 17, tokens: 3780 - 1200 }]);
  });

  it('ignores small gaps and judges each scope and conversation on its own', () => {
    expect(cacheMisses([m(1, 0, 2000), m(2, 1500, 600)])).toEqual([]);
    const scoped = [m(1, 0, 5000, 0, 'customer'), m(2, 0, 4000, 0, 'agent'), m(3, 5000, 100, 0, 'customer'), m(4, 4000, 100, 0, 'agent')];
    expect(cacheMisses(scoped)).toEqual([]);
    const batch = [m(1, 0, 3000, 0, undefined, 1), m(2, 0, 3000, 0, undefined, 2), m(3, 3000, 100, 0, undefined, 1)];
    expect(cacheMisses(batch)).toEqual([]);
    expect(cacheReadShare([m(1, 0, 100), m(2, 300, 100)])).toBeCloseTo(300 / 500);
  });

  it('does not judge a conversation that never used the cache', () => {
    expect(cacheMisses([m(1, 0, 2000), m(2, 0, 2400), m(3, 0, 2800)])).toEqual([]);
  });

  it('says calls that never used the cache had nothing to miss, rather than that they read from it', () => {
    expect(steadyCacheNote([m(1, 0, 2000), m(2, 0, 2400)])).toBe('No model call here wrote to the prompt cache or read from it, so there was nothing to miss.');
    expect(steadyCacheNote([m(1, 0, 200, 3000), m(3, 3000, 100, 400)])).toBe('Every model call read the previous prompt from the cache.');
    expect(steadyCacheNote([m(1, 0, 200, 3000, undefined, 1), m(3, 3000, 100, 400, undefined, 1)])).toMatch(/^Each conversation starts its own context/);
  });
});

describe('backoff', () => {
  it('waits 5, 10, 20, then 30 seconds between retries', () => {
    expect([0, 1, 2, 3, 4, 10].map(backoffSeconds)).toEqual([5, 10, 20, 30, 30, 30]);
  });

  it('treats no answer or a gateway error as unreachable, and other errors as answers', () => {
    expect(isUnreachable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isUnreachable({ status: 503 })).toBe(true);
    expect(isUnreachable({ status: 401 })).toBe(false);
    expect(isUnreachable({ status: 404 })).toBe(false);
  });
});

describe('formatting', () => {
  it('writes money, tokens and durations as the mock does', () => {
    expect(money(0)).toBe('$0');
    expect(money(0.0231)).toBe('$0.023');
    expect(money(0.004)).toBe('$0.004');
    expect(money(1.2)).toBe('$1.2');
    expect(approx(0.0281)).toBe('≈$0.028');
    expect(approx(0)).toBe('$0');
    expect(ktok(12400)).toBe('12.4k');
    expect(ktok(950)).toBe('950');
    expect(ktok(1_250_000)).toBe('1.25M');
    expect(dur(840)).toBe('840 ms');
    expect(dur(2900)).toBe('2.9 s');
    expect(dur(64_000)).toBe('1m 4s');
    expect(durLong(24_000)).toBe('24s');
    expect(durLong(28 * 60_000)).toBe('28m');
    expect(durLong(65 * 60_000)).toBe('1h 5m');
  });

  it('says when a run started in a few characters', () => {
    const now = new Date(2026, 9, 1, 10, 30).getTime();
    expect(whenShort(now - 20_000, now)).toBe('now');
    expect(whenShort(new Date(2026, 9, 1, 9, 58).getTime(), now)).toBe('09:58');
    expect(whenShort(new Date(2026, 8, 30, 23, 0).getTime(), now)).toBe('Sep 30');
  });

  it('shortens a home folder and finds the project a store belongs to', () => {
    expect(tildePath('/home/dana/support-agent/.shadowlap/shadowlap.db')).toBe('~/support-agent/.shadowlap/shadowlap.db');
    expect(tildePath('/home/ci/x')).toBe('~/x');
    expect(tildePath('C:\\Users\\dana\\agent')).toBe('~\\agent');
    expect(tildePath('/srv/x')).toBe('/srv/x');
    expect(projectOfStore('/home/dana/support-agent/.shadowlap/shadowlap.db')).toEqual({ name: 'support-agent', path: '/home/dana/support-agent' });
    expect(projectOfStore(':memory:')).toBeNull();
    expect(compactPath('/home/dana/support-agent')).toBe('~/support-agent');
    expect(compactPath('/srv/builds/a-very-long-folder-name/agents/work1', 24)).toBe('…/agents/work1');
  });
});

describe('runs', () => {
  const base: RunLike = {
    runId: '01K5CQ4N7G00000000000000AA',
    parentRunId: null,
    mode: 'record',
    status: 'completed',
    divergence: null,
    command: 'python refund_agent.py',
    codeVersion: 'c91d0f4',
    startedAt: 1000,
    calls: 30,
    spent: 0.051,
    saved: 0,
    captured: 0,
    imported: false,
    covers: null,
    source: null,
    labels: ['refund-flow'],
  };
  const fork: RunLike = { ...base, runId: '01K5CQ4R1T00000000000000BB', parentRunId: base.runId, mode: 'replay', divergence: { callNo: 17, type: 'request_changed' }, startedAt: 3000, spent: 0.028, origins: 'r'.repeat(16) + 'l'.repeat(13) + 'b', labels: [] };
  const clean: RunLike = { ...base, runId: '01K5CQ4N9A00000000000000CC', parentRunId: base.runId, mode: 'replay', startedAt: 2000, spent: 0, saved: 0.05, origins: 'r'.repeat(30), labels: [] };
  const capture: RunLike = { ...base, runId: '01K5CQ2E8M00000000000000DD', command: '', source: 'traffic.har', covers: ['api'], imported: true, spent: 0, captured: 0.4, startedAt: 500, labels: [] };
  const test: RunLike = { ...clean, runId: '01K5CQ4V5K00000000000000EE', test: { golden: 'goldens/refund-in-limit' }, divergence: { callNo: 1, type: 'request_changed' }, status: 'failed', startedAt: 4000 };
  const live: RunLike = { ...base, runId: '01K5CQ6L0P00000000000000FF', status: 'running', calls: 9, spent: 0.011, startedAt: 5000, labels: [] };

  it('names what each run is and what came of it', () => {
    expect([base, fork, clean, capture, test, live].map(runType)).toEqual(['recording', 'fork', 'clean', 'capture', 'test', 'recording']);
    expect(runOutcome(live)).toEqual({ tone: 'live', text: 'in progress' });
    expect(runOutcome(test)).toEqual({ tone: 'err', text: 'diverged at #1' });
    expect(runOutcome(clean)).toEqual({ tone: 'ok', text: 'clean' });
    expect(runOutcome({ ...fork, checks: { passed: 2, total: 2 } })).toEqual({ tone: 'ok', text: '2 checks passed' });
    expect(runOutcome({ ...base, status: 'failed', blame: { callNo: 9 } })).toEqual({ tone: 'err', text: 'lost at #9' });
    expect(runOutcome(base)).toEqual({ tone: 'n', text: '—' });
    expect(runSubline(fork)).toBe('fork @17 of 01K5CQ4N7G · python refund_agent.py');
    expect(runSubline(capture)).toBe('capture · traffic.har');
    expect(sideLine(fork)).toEqual({ text: 'fork @17 · 13 live · 1 blocked' });
    expect(sideLine(clean)).toEqual({ text: 'clean replay · 30/30' });
    expect(sideLine(live)).toEqual({ text: 'recording · 9 calls so far' });
    expect(sideLine(test)).toEqual({ err: 'test failed', text: ' · diverged at #1' });
  });

  it('filters by type chip and text, and sorts by calls, spent or when', () => {
    const all = [base, fork, clean, capture, test, live];
    expect(all.filter((r) => matchesChip(r, 'failed')).map((r) => r.runId)).toEqual([test.runId]);
    expect(all.filter((r) => matchesChip(r, 'capture')).length).toBe(1);
    expect(all.filter((r) => matchesText(r, 'refund FLOW')).map((r) => r.runId)).toEqual([base.runId]);
    expect(all.filter((r) => matchesText(r, 'har')).map((r) => r.runId)).toEqual([capture.runId]);
    expect(sortRuns(all, 'spent')[0]!.runId).toBe(base.runId);
    expect(sortRuns(all, 'when')[0]!.runId).toBe(live.runId);
    expect(isFailed({ ...base, checks: { passed: 1, total: 2 } })).toBe(true);
  });

  it('lists recordings newest family first with their replays and forks under them', () => {
    const tree = runTree([capture, base, clean, fork, live]);
    expect(tree.map((x) => [x.run.runId.slice(0, 10), x.depth])).toEqual([
      ['01K5CQ6L0P', 0],
      ['01K5CQ4N7G', 0],
      ['01K5CQ4N9A', 1],
      ['01K5CQ4R1T', 1],
      ['01K5CQ2E8M', 0],
    ]);
  });

  it('picks what Compare opens with', () => {
    expect(defaultComparePair([base, clean, fork, live])).toEqual([base.runId, fork.runId]);
    expect(defaultComparePair([base, live])).toEqual([base.runId, live.runId]);
    expect(defaultComparePair([base])).toBeNull();
    expect(compareTarget(fork, [])).toEqual([base.runId, fork.runId]);
    expect(compareTarget(base, [fork, clean])).toEqual([base.runId, clean.runId]);
    expect(compareTarget(capture, [])).toBeNull();
  });

  it('narrows to a scope and the scopes nested in it', () => {
    const calls = [{ callNo: 1, scope: 'customer' }, { callNo: 2, scope: 'agent' }, { callNo: 3, scope: 'agent/policy-checker' }, { callNo: 4 }];
    expect(scopesOf(calls)).toEqual(['customer', 'agent', 'agent/policy-checker']);
    expect(calls.filter((c) => inScope(c, 'agent')).map((c) => c.callNo)).toEqual([2, 3]);
    expect(scopeCount(calls, 'all')).toBe(4);
  });
});

describe('fork menu', () => {
  const a = (key: string, label: string, extra: Partial<ActionLike> = {}): ActionLike => ({ key, label, opensRun: true, prompt: null, disabled: null, ...extra });
  const today = [
    a('r', 'Replay this run (clean if nothing changed)'),
    a('s', 'Replay with writes stubbed (--writes stub)'),
    a('e', 'Replay several times and compare the attempts (--repeat)', { opensRun: false }),
    a('i', 'Fork: inject an instruction at #17 (--inject)'),
    a('g', 'Fork: my changed prompt from #17 on (--prompt-from)'),
    a('f', 'Fork: answer #17 with an HTTP failure (--fail-at)'),
    a('m', 'Fork: switch the model from #17 on (--model)'),
    a('a', 'Fork: diverge at #17 (--diverge-at)'),
    a('p', 'Pack this run to a directory (redaction rules applied)', { opensRun: false }),
  ];

  it('puts the call’s actions first in the mock’s order, then the whole run, leaving out what has its own place', () => {
    const menu = forkMenu(today);
    expect(menu.call.map((x) => [x.label, x.flag])).toEqual([
      ['Inject an instruction', '--inject'],
      ['Switch the model from here', '--model'],
      ['Fork with your changed prompt', '--prompt-from'],
      ['Answer with an HTTP failure', '--fail-at'],
      ['Diverge here', '--diverge-at'],
    ]);
    expect(menu.run.map((x) => x.label)).toEqual(['Repeat the replay and compare', 'Stub the writes']);
  });

  it('uses the server’s flag and group when it sends them', () => {
    const next = [a('t', 'Answer with a tool error', { flag: '--fail-at 16=timeout', group: 'call' }), a('b', 'Find the commit that broke it', { flag: 'bisect', group: 'run' }), a('l', 'Fork: force get_policy live (--live-tool)')];
    const menu = forkMenu(next, 'get_policy');
    expect(menu.call.map((x) => [x.label, x.flag])).toEqual([
      ['Answer with a tool error', '--fail-at 16=timeout'],
      ['Force get_policy live', '--live-tool'],
    ]);
    expect(menu.run.map((x) => [x.label, x.flag])).toEqual([['Find the commit that broke it', 'bisect']]);
    expect(menuLabel(a('z', 'Fork: plant a prompt injection (--inject-result)'))).toBe('Plant a prompt injection');
    expect(menuFlag(a('z', 'Fork: plant a prompt injection (--inject-result)'))).toBe('--inject-result');
  });

  it('names the call and its kind in the header', () => {
    expect(forkMenuTitle({ callNo: 17, kind: 'api', name: 'POST /v1/messages', effect: null }, 'messages')).toBe('At #17 · model call');
    expect(forkMenuTitle({ callNo: 16, kind: 'tool', name: 'lookup_policy', effect: 'read' }, 'lookup_policy')).toBe('At #16 · lookup_policy · read tool');
    expect(forkMenuTitle({ callNo: 1, kind: 'clock', name: 'now', effect: null }, 'now')).toBe('At #1 · now · clock read');
  });
});

describe('job drawer', () => {
  it('names the job from its command and colours its lines', () => {
    expect(jobTitle({ args: ['replay', 'X', '--inject', '17=hi'], done: false, code: null })).toBe('Forking');
    expect(jobTitle({ args: ['replay', 'X'], done: false, code: null })).toBe('Replaying');
    expect(jobTitle({ args: ['replay', 'X', '--repeat', '5'], done: false, code: null })).toBe('Repeating');
    expect(jobTitle({ args: ['pack', 'X', 'dir'], done: false, code: null, title: 'Packing a run' })).toBe('Packing a run');
    expect(lineTone('✓ Replay clean: 30/30 calls')).toBe('ok');
    expect(lineTone('⑂ Forked at call 17: 16 calls replayed')).toBe('y');
    expect(lineTone('  ✗ Diverged at call 1')).toBe('no');
    expect(lineTone('$ shadowlap replay x')).toBe('p');
    expect(lineTone('plain')).toBe('');
  });

  it('ends on the outcome, then the exit code', () => {
    const done = (code: number | null) => ({ args: ['replay', 'X'], done: true, code });
    expect(jobStatus({ ...done(0), done: false }, [])).toEqual({ text: 'running', tone: '' });
    expect(jobStatus(done(0), ['✓ Replay clean: 30/30 calls replayed'])).toEqual({ text: 'reproduced · exit 0', tone: 'ok' });
    expect(jobStatus(done(1), ['✗ Diverged at call 1 (api POST /v1/messages)'])).toEqual({ text: 'diverged · exit 1', tone: 'err' });
    expect(jobStatus(done(1), ['✗ check failed: issue_refund called 1×'])).toEqual({ text: 'check failed · exit 1', tone: 'err' });
    expect(jobStatus(done(1), ['⑂ Forked at call 19', '  the agent process exited with an error'])).toEqual({ text: 'agent exited 1', tone: 'warn' });
    expect(jobStatus(done(null), [])).toEqual({ text: 'stopped', tone: 'err' });
    expect(lastLine(['a', '✓ Forked at call 17 · ran to the end', '  '])).toBe('Forked at call 17 · ran to the end');
  });
});

describe('overview grid', () => {
  it('draws a family on one scale: the run’s calls, then empty cells, the fork outlined', () => {
    const cells = gridCells(parseOrigins('rrrl')!, 30, 4);
    expect(cells).toHaveLength(30);
    expect(cells.slice(0, 4).map((c) => c.origin)).toEqual(['rep', 'rep', 'rep', 'live']);
    expect(cells[3]!.fork).toBe(true);
    expect(cells[4]).toEqual({ origin: null, fork: false });
    const long = gridCells(parseOrigins('r'.repeat(119) + 'b')!, 120);
    expect(long).toHaveLength(60);
    expect(long.at(-1)!.origin).toBe('block');
  });
});

describe('strip origins of failed and fenced calls', () => {
  it('marks a live call that errored as failed, and a fenced write by its fence, not as a failure', () => {
    const calls = [
      { origin: 'replayed', outcome: 'ok' as const },
      { origin: 'live', outcome: 'ok' as const },
      { origin: 'blocked', outcome: 'error' as const },
      { origin: 'live', outcome: 'error' as const },
    ].map((c, i) => ({ n: i + 1, origin: displayOrigin(c) }));
    expect(stripCells(calls, { selected: 2, forkAt: 2, lostAt: null }).map((c) => [c.first, c.origin, c.selected, c.mark])).toEqual([
      [1, 'rep', false, null],
      [2, 'live', true, 'fork'],
      [3, 'block', false, null],
      [4, 'fail', false, null],
    ]);
  });

  it('keeps a lone failure visible in a 5,000-call run, with the fork and the selection', () => {
    const calls = Array.from({ length: 5000 }, (_, i) => ({ n: i + 1, origin: displayOrigin({ origin: i + 1 === 2500 ? 'blocked' : i + 1 > 2000 ? 'live' : 'replayed', outcome: i + 1 === 4000 ? 'error' : 'ok' }) }));
    const cells = stripCells(calls, { selected: 4321, forkAt: 2001, lostAt: null });
    expect(cells.length).toBeLessThanOrEqual(360);
    expect(cells[0]!.first).toBe(1);
    expect(cells.at(-1)!.last).toBe(5000);
    expect(cells.find((c) => c.first <= 2500 && c.last >= 2500)).toMatchObject({ origin: 'block', target: 2500 });
    expect(cells.find((c) => c.mark === 'fork')).toMatchObject({ target: 2001 });
    expect(cells.find((c) => c.selected)).toMatchObject({ target: 4321 });
    expect(cells.filter((c) => c.origin === 'fail')).toHaveLength(1);
  });
});

describe('a run’s calls in the views', () => {
  const call = (callNo: number, kind: string, extra: Partial<CallLike> = {}): CallLike => ({
    callNo,
    kind,
    name: kind === 'api' ? 'POST /v1/messages' : 'lookup_order',
    origin: 'live',
    effect: kind === 'tool' ? 'read' : null,
    outcome: 'ok',
    status: kind === 'api' ? 200 : null,
    latencyMs: 100,
    model: kind === 'api' ? 'sonnet-5' : null,
    stopReason: kind === 'api' ? 'tool_use' : null,
    usage: kind === 'api' ? { input: 200, output: 80, cacheRead: 2400, cacheWrite: 400 } : null,
    detail: kind === 'tool' ? '{"order_id":"A-1042"}' : '',
    attempts: 0,
    replayedFrom: null,
    error: null,
    startedAt: 1000 + callNo * 100,
    endedAt: 1000 + callNo * 100 + 90,
    ttftMs: null,
    scope: null,
    ...extra,
  });

  it('counts a blamed call among the model calls of its scope', () => {
    const calls = [call(1, 'api', { scope: 'customer' }), call(2, 'api', { scope: 'agent' }), call(3, 'tool', { scope: 'agent' }), call(4, 'api', { scope: 'agent' }), call(5, 'api', { scope: 'agent/policy-checker' })];
    expect(modelCallOf(calls, 4, 'agent')).toEqual({ k: 2, m: 3 });
    expect(modelCallOf(calls, 4, null)).toEqual({ k: 3, m: 4 });
    expect(modelCallOf(calls, 3, 'agent')).toBeNull();
  });

  it('groups tool calls under the model call that asked for them, within a scope when there are scopes', () => {
    const calls = [call(1, 'api', { scope: 'agent' }), call(2, 'api', { scope: 'customer' }), call(3, 'tool', { scope: 'agent' }), call(4, 'clock'), call(5, 'tool', { scope: 'customer' })];
    expect(turnsOf(calls, true).map((t) => [t.model.callNo, t.tools.map((c) => c.callNo)])).toEqual([
      [1, [3]],
      [2, [5]],
    ]);
    expect(turnsOf(calls, false).map((t) => [t.model.callNo, t.tools.map((c) => c.callNo)])).toEqual([
      [1, []],
      [2, [3, 5]],
    ]);
  });

  it('places calls on one clock and finds the ones that ran at once, under a long call too', () => {
    const calls = [call(1, 'api', { startedAt: 1000, endedAt: 3000 }), call(2, 'tool', { startedAt: 1100, endedAt: 1200 }), call(3, 'tool', { startedAt: 1500, endedAt: 1600 }), call(4, 'api', { startedAt: 3100, endedAt: 3500, ttftMs: 40 })];
    const t = timelineOf(calls);
    expect(t.end).toBe(2500);
    expect(t.rows.map((r) => [r.call.callNo, r.start, r.end, r.firstToken])).toEqual([
      [1, 0, 2000, null],
      [2, 100, 200, null],
      [3, 500, 600, null],
      [4, 2100, 2500, 40],
    ]);
    expect(t.parallel).toEqual([
      [1, 2],
      [1, 3],
    ]);
    expect(ticksFor(2500).map((x) => x.label)).toEqual(['0s', '0.5s', '1s', '1.5s', '2s', '2.5s']);
  });

  it('says what a call did on its line, and a replayed call’s time as recorded', () => {
    expect(callDetail(call(1, 'api'))).toEqual({ text: 'sonnet-5 · tool_use', err: false });
    expect(callDetail(call(1, 'api', { outcome: 'error', status: 529, attempts: 2 }))).toEqual({ text: 'HTTP 529 · 3 attempts', err: true });
    expect(resultLine(call(3, 'tool', { origin: 'blocked', outcome: 'error' }))).toEqual({ text: 'blocked', err: true });
    expect(resultLine(call(3, 'tool', { origin: 'stubbed', resultShort: '{"sent":true}' }))).toEqual({ text: 'stubbed {"sent":true}', err: false });
    expect(resultLine(call(3, 'tool', { outcome: 'error', error: 'TimeoutError: 30 s' }))).toEqual({ text: 'TimeoutError: 30 s', err: true });
    expect(resultLine(call(1, 'api'))).toBeNull();
    const parent = indexCalls([{ callNo: 3, origin: 'live', latencyMs: 410 }]);
    expect(timeOf(call(3, 'tool', { origin: 'replayed', latencyMs: 1, replayedFrom: 3 }), [parent], false)).toEqual({ text: '410 ms', was: true });
    expect(timeOf(call(3, 'tool', { origin: 'replayed', latencyMs: 1 }), [], false)).toEqual({ text: '—', was: true });
    expect(timeOf(call(5, 'api', { latencyMs: null, outcome: null }), [], true)).toEqual({ text: '…', was: false });
    expect(tokensText(call(1, 'api'))).toBe('3.0k → 80');
  });
});
