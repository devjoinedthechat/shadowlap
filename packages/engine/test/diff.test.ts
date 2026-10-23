import { describe, expect, it } from 'vitest';
import { hintsFor, structuralDiff } from '../src/diff.js';
import { formatDivergence, formatSummary, plain, summarizeRun } from '../src/report.js';
import type { CallRecord, RunRecord } from '../src/types.js';

describe('structuralDiff', () => {
  it('reports changed, added and removed paths with array indexes', () => {
    const d = structuralDiff({ a: 1, b: [1, 2], c: 'x' }, { a: 2, b: [1, 2, 3], d: true });
    expect(d).toEqual([
      { path: '$.a', op: 'changed', before: 1, after: 2 },
      { path: '$.b[2]', op: 'added', after: 3 },
      { path: '$.c', op: 'removed', before: 'x' },
      { path: '$.d', op: 'added', after: true },
    ]);
  });
  it('reads a member named like an inherited one (toString, __proto__) as a member', () => {
    expect(structuralDiff({}, { toString: 'x' })).toEqual([{ path: '$.toString', op: 'added', after: 'x' }]);
    expect(structuralDiff({ constructor: 1 }, {})).toEqual([{ path: '$.constructor', op: 'removed', before: 1 }]);
    expect(structuralDiff(JSON.parse('{"__proto__":{"a":1}}'), {})).toEqual([{ path: '$.__proto__', op: 'removed', before: { a: 1 } }]);
  });

  it('is empty for deep-equal values regardless of key order', () => {
    expect(structuralDiff({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } })).toEqual([]);
  });
});

describe('hintsFor', () => {
  it('suggests a date normalizer when only a date differs', () => {
    const h = hintsFor({ path: '$.system[0].text', op: 'changed', before: 'Today is 2026-09-15.', after: 'Today is 2026-09-16.' }, 'api');
    expect(h[0]?.normalizer).toEqual({ kind: 'api', path: '$.system[0].text', pattern: 'iso-date', replace: '<DATE>' });
  });
  it('prefers datetime over date and scopes tool hints by name', () => {
    const h = hintsFor({ path: '$.at', op: 'changed', before: 't=2026-09-15T01:02:03Z', after: 't=2026-09-16T01:02:03Z' }, 'tool', 'log');
    expect(h[0]?.normalizer).toMatchObject({ kind: 'tool', name: 'log', pattern: 'iso-datetime' });
  });
  it('gives no hint when the change is not a known volatile pattern', () => {
    expect(hintsFor({ path: '$.x', op: 'changed', before: 'a', after: 'b' }, 'api')).toEqual([]);
  });
});

describe('report formatting', () => {
  const run: RunRecord = { runId: '01J8ZTESTRUN', parentRunId: 'P', mode: 'replay', status: 'completed', divergence: null, command: { argv: [], cwd: '' }, codeVersion: null, startedAt: 0, endedAt: 1 };
  const call = (over: Partial<CallRecord>): CallRecord => ({
    runId: run.runId,
    callNo: 1,
    kind: 'api',
    name: 'POST /v1/messages',
    fingerprint: 'f',
    occurrence: 1,
    origin: 'replayed',
    effect: null,
    requestRef: null,
    meta: {},
    at: 0,
    end: { runId: run.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { usage: { inputTokens: 1000, outputTokens: 50 } }, at: 0 },
    attempts: [],
    ...over,
  });

  it('summarizes a clean replay with tokens not re-spent', () => {
    const s = summarizeRun(run, [call({}), call({ callNo: 2, kind: 'tool', name: 't', origin: 'replayed' })]);
    expect(s.upstreamRequests).toBe(0);
    expect(s.tokensNotRespent.inputTokens).toBe(1000);
    expect(formatSummary(s, plain)).toContain('Replay clean: 2/2 calls replayed (1 api, 1 tool), 0 upstream requests, 1.0k input tokens not re-spent');
  });

  it('formats a divergence with a diff and a hint', () => {
    const text = formatDivergence(
      {
        type: 'request_changed',
        callNo: 7,
        kind: 'api',
        name: 'POST /v1/messages',
        replayedBefore: 6,
        counterpart: { runId: '01J8ZPARENTRUN', callNo: 7 },
        diff: [{ path: '$.system[0].text', op: 'changed', before: 'Today is 2026-09-15.', after: 'Today is 2026-09-16.' }],
        hints: [{ message: 'this looks like a date', normalizer: { kind: 'api', path: '$.system[0].text', pattern: 'iso-date', replace: '<DATE>' } }],
      },
      plain,
    );
    expect(text).toContain('Diverged at call 7 (api POST /v1/messages): 6 calls replayed before divergence');
    expect(text).toContain('~ $.system[0].text');
    expect(text).toContain('- "Today is 2026-09-15."');
    expect(text).toContain("shadowlap normalize add --kind api --path '$.system[0].text' --pattern iso-date");
  });
});
