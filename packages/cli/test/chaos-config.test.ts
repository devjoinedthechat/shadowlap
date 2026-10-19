import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { CHAOS_TIMEOUT, chaosFor, DEFAULT_CHAOS, parseChaosFields } from '../src/chaos-config.js';
import { chaosJunit, chaosMarkdown, chaosReport, checkLabels, gateWords, writeLimits, type PresetOutcome } from '../src/chaos.js';
import { parseExpect, parseTests, specFor } from '../src/checks.js';
import { attemptsToFail, attemptsToPass, decide, parseGate, type SprtGate } from '../src/gate-standin.js';

/** The presets' settings under a tests entry, the gate that decides them, and what they report. */

const parse = (raw: unknown) => parseChaosFields(raw, 'tests["g"].chaos', parseExpect);

describe('a golden\'s chaos settings', () => {
  it('default to all six presets, judged on the exit status, gated by the golden', () => {
    expect(parse(undefined)).toEqual(DEFAULT_CHAOS);
    expect(DEFAULT_CHAOS).toMatchObject({ presets: ['timeout', 'empty', 'malformed', 'oversized', '429', '500'], expect: null, tool: null, gate: null, oversize: 1_000_000, timeout: CHAOS_TIMEOUT });
    expect(parse(false)).toBe(false);
  });

  it('read the presets, the checks, the tool, the gate, the size and the time limit', () => {
    const spec = parse({ presets: ['429', 'timeout'], expect: { tools: { issue_refund: '<= 1' } }, tool: ' lookup_order ', gate: { good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, oversize: 20_000, timeout: 60 });
    expect(spec).toMatchObject({ presets: ['timeout', '429'], tool: 'lookup_order', gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, oversize: 20_000, timeout: 60, expectRaw: { tools: { issue_refund: '<= 1' } } });
    expect(spec && spec.expect?.tools).toEqual([{ name: 'issue_refund', count: { min: 0, max: 1 } }]);
  });

  it('refuse what they don\'t know, as every tests entry does', () => {
    expect(() => parse({ preset: ['timeout'] })).toThrow('tests["g"].chaos has an unknown key "preset"');
    expect(() => parse({ presets: ['flood'] })).toThrow('unknown preset "flood"');
    expect(() => parse({ presets: 'timeout' })).toThrow('presets must be a list of presets');
    expect(() => parse({ expect: { tools: { x: 'often' } } })).toThrow('tests["g"].chaos.expect.tools["x"] must be a count');
    expect(() => parse({ gate: { good: 0.7, bad: 0.9, risk: 0.05, max: 20 } })).toThrow('bad (0.9) must be below good (0.7)');
    expect(() => parse({ gate: { baseline: 'history', drop: 0.15, risk: 0.05 } })).toThrow('a baseline gate compares a golden with its own history');
    expect(() => parse({ oversize: 10 })).toThrow('oversize must be a whole number of characters from 1000');
    expect(() => parse({ timeout: 0 })).toThrow('timeout must be a whole number of seconds');
    expect(() => parse('on')).toThrow('must be false, or an object');
    // Through the tests entry itself, as shadowlap test and doctor read it.
    expect(() => parseTests({ 'goldens/a': { chaos: { tool: 3 } } })).toThrow('tests["goldens/a"].chaos.tool must be the name of a tool');
    expect(parseTests({ 'goldens/a': { chaos: { presets: ['timeout'] } } })).toHaveLength(1);
  });

  it('are read from the config as every command reads it, a byte-order mark and all, and never stand for the defaults when it is broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-chaos-config-'));
    try {
      // An editor on Windows saves JSON with a byte-order mark: the presets are still off.
      writeFileSync(join(dir, 'shadowlap.config.json'), `\uFEFF${JSON.stringify({ tests: { 'goldens/a': { chaos: false }, 'goldens/b': { chaos: { presets: ['429'], expect: { tools: { issue_refund: 0 } } } } } })}`);
      expect(chaosFor(dir, 'goldens/a', parseExpect)).toBe(false);
      expect(chaosFor(dir, 'goldens/b', parseExpect)).toMatchObject({ presets: ['429'], expectRaw: { tools: { issue_refund: 0 } } });
      expect(chaosFor(dir, 'goldens/none', parseExpect)).toEqual(DEFAULT_CHAOS);
      expect(chaosFor(dir, null, parseExpect)).toEqual(DEFAULT_CHAOS);
      writeFileSync(join(dir, 'shadowlap.config.json'), '{ "tests": { "goldens/a": { "chaos": false } ');
      expect(() => chaosFor(dir, 'goldens/a', parseExpect)).toThrow(/shadowlap\.config\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what judges an error path when chaos.expect does not say', () => {
  const effects: Record<string, 'read' | 'write' | 'pure'> = { lookup_order: 'read', get_policy: 'pure', issue_refund: 'write', send_email: 'write' };
  const effectOf = (tool: string) => effects[tool] ?? null;
  const golden = (expectRaw: Record<string, unknown>) => specFor(parseTests({ 'goldens/a': { expect: expectRaw } }), 'goldens/a', process.cwd());

  it("is the upper bounds the golden's expect sets on its write tools, and on tools of unknown effect", () => {
    const limits = writeLimits(golden({ tools: { lookup_order: 1, get_policy: '>= 1', issue_refund: 1, send_email: '1-2', escalate: 0, add_note: '>= 1', notify: { count: '<= 2', args: { channel: '#ops' } } } }), effectOf);
    expect(limits?.tools).toEqual([
      { name: 'issue_refund', count: { min: 0, max: 1 } },
      { name: 'send_email', count: { min: 0, max: 2 } },
      // Nothing says what escalate and notify do: they count as writes.
      { name: 'escalate', count: { min: 0, max: 0 } },
      { name: 'notify', count: { min: 0, max: 2 }, args: { channel: '#ops' } },
    ]);
    expect(checkLabels(limits!)).toEqual(['issue_refund called at most 1 time', 'send_email called at most 2 times', 'escalate called 0 times', 'notify with {"channel":"#ops"} called at most 2 times']);
  });

  it('is nothing when the golden sets no bound a path through a failure keeps', () => {
    expect(writeLimits(golden({ tools: { lookup_order: 1, issue_refund: '>= 1' }, modelCalls: '<= 12' }), effectOf)).toBeNull();
    expect(writeLimits(null, effectOf)).toBeNull();
  });
});

describe('the gate', () => {
  const gate = parseGate({ good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, 'gate');

  it('is Wald\'s sequential test: an agent that always passes is accepted after 12 attempts', () => {
    // ln(0.9/0.7) per pass against ln(0.95/0.05): 11 passes are not enough, 12 are.
    expect(decide(11, 11, gate)).toBe('continue');
    expect(decide(12, 12, gate)).toBe('pass');
    // Each failure costs ln(0.1/0.3); three in a row cross the lower bound.
    expect(decide(0, 2, gate)).toBe('continue');
    expect(decide(0, 3, gate)).toBe('fail');
    // Between the bounds when max runs out: inconclusive.
    expect(decide(16, 20, gate)).toBe('inconclusive');
    expect(decide(16, 19, gate)).toBe('continue');
  });

  it('is described in words, as the report and the docs say it', () => {
    expect(gateWords({ good: 0.9, bad: 0.7, risk: 0.05, max: 20 })).toBe('pass at 90% or more, fail at 70% or less, at most 5% risk, up to 20 attempts');
    expect(gateWords({ repeat: 1, passes: 1 })).toBe('1 of 1 attempt must pass');
    expect(gateWords({ repeat: 5, passes: 4 })).toBe('4 of 5 attempts must pass');
  });

  it('takes each figure as optional, with the defaults the contract gives', () => {
    expect(parseGate({}, 'g')).toEqual({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 40 });
    expect(parseGate({ max: 20 }, 'g')).toEqual({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 20 });
    expect(parseGate({ baseline: 'history' }, 'g')).toEqual({ kind: 'baseline', drop: 0.15, risk: 0.05, window: 10, min: 5 });
    expect(parseGate({ baseline: 'history', drop: 0.2, min: 3 }, 'g')).toEqual({ kind: 'baseline', drop: 0.2, risk: 0.05, window: 10, min: 3 });
    expect(parseChaosFields({ gate: { max: 20 } }, 'c', parseExpect)).toMatchObject({ gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 20 } });
  });

  it('refuses one it can\'t decide, or one that could never pass', () => {
    expect(() => parseGate({ good: 1.2, bad: 0.5, risk: 0.05, max: 5 }, 'g')).toThrow('g.good must be the pass rate it passes: a number between 0 and 1');
    expect(() => parseGate({ good: 0.9, bad: 0.5, risk: 0.6, max: 5 }, 'g')).toThrow('g.risk must be the most a verdict may be wrong: a number between 0 and 0.5');
    expect(() => parseGate({ good: 0.9, bad: 0.5, risk: 0.05, max: 0 }, 'g')).toThrow('g.max must be the most attempts it runs: a whole number from 1 to 1000');
    expect(() => parseGate({ good: 0.9, bad: 0.5, risk: 0.05, max: 5, min: 1 }, 'g')).toThrow('unknown key "min"');
    // 0.9 against 0.7 at 5% risk takes 12 passes in a row: 5 attempts would make every preset inconclusive.
    expect(attemptsToPass({ good: 0.9, bad: 0.7, risk: 0.05 })).toBe(12);
    expect(attemptsToFail({ good: 0.9, bad: 0.7, risk: 0.05 })).toBe(3);
    expect(() => parseGate({ good: 0.9, bad: 0.7, risk: 0.05, max: 5 }, 'g')).toThrow('g: max (5) is fewer than the 12 attempts an agent that always passes needs at these figures, so it could never pass');
    expect(() => parseChaosFields({ gate: { good: 0.9, bad: 0.7, risk: 0.05, max: 5 } }, 'c', parseExpect)).toThrow('could never pass');
    expect(parseGate({ good: 0.9, bad: 0.7, risk: 0.05, max: 12 }, 'g')).toMatchObject({ max: 12 });
  });

  it('counts a bound reached to the last rounding as reached', () => {
    // A pass adds ln(0.6/0.2) = ln 3, and the bound is ln(0.75/0.25) = ln 3: one pass reaches it. In
    // floating point 0.6/0.2 is 2.9999999999999996, a hair under, which must not cost a second pass.
    const close = parseGate({ good: 0.6, bad: 0.2, risk: 0.25, max: 10 }, 'g') as SprtGate;
    expect(attemptsToPass(close)).toBe(1);
    expect(decide(1, 1, close)).toBe('pass');
    const nine = parseGate({ good: 0.9, bad: 0.3, risk: 0.1, max: 10 }, 'g') as SprtGate;
    // ln 3 per pass against ln 9: two passes.
    expect(attemptsToPass(nine)).toBe(2);
    expect(decide(2, 2, nine)).toBe('pass');
    expect(decide(1, 1, nine)).toBe('continue');
  });
});

describe('what a session reports', () => {
  const outcome = (o: Partial<PresetOutcome>): PresetOutcome => ({ preset: 'timeout', label: 'tool timeout', verdict: 'passed', callNo: 3, target: { kind: 'tool', name: 'get_forecast' }, passes: 1, attempts: 1, detail: 'get_forecast (#3) timed out: the agent exited 0', summary: 'timed out: the agent exited 0', reason: null, runs: [{ runId: 'R1', passed: true, exitCode: 0, checks: [], reason: null, lastLine: null }], gate: { repeat: 1, passes: 1 }, upstreamRequests: 1, spent: 0, ...o });
  const results = [
    { golden: 'goldens/forecast', runId: 'G', error: null, skipped: null, judge: { source: 'exit' as const, checks: [] }, outcomes: [outcome({}), outcome({ preset: 'malformed', label: 'malformed JSON', verdict: 'failed', passes: 0, detail: 'get_forecast (#3) answered malformed JSON: the agent exited with code 1', reason: 'the agent exited with code 1', runs: [{ runId: 'R2', passed: false, exitCode: 1, checks: null, reason: 'the agent exited with code 1', lastLine: 'SyntaxError: x' }] }), outcome({ preset: '429', label: 'provider 429', verdict: 'inconclusive', detail: 'model call #4 failed with HTTP 429: 3 of 5 passed' }), outcome({ preset: 'empty', label: 'empty result', verdict: 'not-applicable', runs: [], attempts: 0, detail: 'the recording makes no tool call' })] },
    { golden: 'goldens/broken', runId: null, outcomes: [], judge: null, error: 'the pack contains no runs', skipped: null },
    { golden: 'goldens/quiet', runId: null, outcomes: [], judge: null, error: null, skipped: 'its tests entry turns the presets off ("chaos": false)' },
  ];

  it('counts each verdict', () => {
    expect(chaosReport(results, { session: 'S', revision: 'abc', presets: ['timeout'], interrupted: false })).toMatchObject({ version: 1, passed: 1, failed: 1, inconclusive: 1, notApplicable: 1 });
  });

  it('makes a JUnit case of each preset, failing an inconclusive one only when CI counts it', () => {
    const fail = chaosJunit(results, { inconclusive: 'fail' });
    expect(fail.map((c) => [c.classname, c.name, !!c.failure])).toEqual([
      ['goldens/forecast', 'tool timeout', false],
      ['goldens/forecast', 'malformed JSON', true],
      ['goldens/forecast', 'provider 429', true],
      ['goldens/forecast', 'empty result', false],
      ['goldens/broken', 'error-path presets', true],
    ]);
    expect(fail[1]!.failure).toEqual({ message: 'failed: get_forecast (#3) answered malformed JSON: the agent exited with code 1', details: 'attempt 1 (run R2): failed: the agent exited with code 1' });
    expect(chaosJunit(results, { inconclusive: 'warn' })[2]!.failure).toBeUndefined();
  });

  it('writes a Markdown table for a job summary', () => {
    const md = chaosMarkdown(chaosReport(results, { session: 'S', revision: null, presets: [], interrupted: false }));
    expect(md).toContain('| goldens/forecast | malformed JSON | failed | get_forecast (#3) answered malformed JSON: the agent exited with code 1 |');
    expect(md).toContain('| goldens/forecast | empty result | not applicable | the recording makes no tool call |');
    // The Verdict column keeps the four verdict words: a golden whose presets couldn't run is listed under the table.
    expect(md).not.toContain('| error |');
    expect(md).not.toContain('| skipped |');
    expect(md.trimEnd().split('\n').slice(-2)).toEqual(['- goldens/broken: not run: the pack contains no runs', '- goldens/quiet: skipped: its tests entry turns the presets off ("chaos": false)']);
  });
});

describe('the store', () => {
  it('keeps each session, and the newest result of each preset on each recording', () => {
    const store = Store.open(':memory:');
    const a = store.startChaosSession({ sessionId: 'S1', startedAt: 10, command: ['shadowlap', 'test', 'goldens/*', '--chaos'], presets: ['timeout', '429'], revision: 'abc', actor: 'dana' });
    store.addChaosResult({ sessionId: 'S1', runId: 'G', golden: 'goldens/a', preset: 'timeout', verdict: 'failed', callNo: 3, passes: 0, attempts: 1, at: 11, data: { detail: 'first' } });
    store.addChaosResult({ sessionId: 'S1', runId: 'G', golden: 'goldens/a', preset: '429', verdict: 'passed', callNo: 4, passes: 1, attempts: 1, at: 12 });
    store.finishChaosSession('S1', { passed: 1, failed: 1, inconclusive: 0, upstreamRequests: 7, endedAt: 13 });
    store.startChaosSession({ sessionId: 'S2', startedAt: 20, command: ['shadowlap', 'test', 'goldens/a', '--chaos'], presets: ['timeout'] });
    store.addChaosResult({ sessionId: 'S2', runId: 'G', golden: 'goldens/a', preset: 'timeout', verdict: 'passed', callNo: 3, passes: 1, attempts: 1, at: 21, data: { detail: 'again' } });
    expect(a.endedAt).toBeNull();
    expect(store.getChaosSession('S1')).toMatchObject({ endedAt: 13, passed: 1, failed: 1, upstreamRequests: 7, presets: ['timeout', '429'], interrupted: false });
    expect(store.listChaosSessions().map((s) => s.sessionId)).toEqual(['S2', 'S1']);
    expect(store.latestChaosResults().map((r) => [r.preset, r.sessionId, r.verdict])).toEqual([
      ['timeout', 'S2', 'passed'],
      ['429', 'S1', 'passed'],
    ]);
    expect(store.listChaosResults({ golden: 'goldens/a' })).toHaveLength(3);
    expect(store.listChaosResults({ sessionId: 'S1', runId: 'G' }).map((r) => r.data?.detail ?? null)).toEqual([null, 'first']);
    // Every write moves the dashboard's counter for them.
    expect(store.changeCounts().chaos).toBeGreaterThan(0);
    store.close();
  });

  it('keeps a result per golden when two goldens hold the same recording, and per run for replay --chaos', () => {
    const store = Store.open(':memory:');
    store.startChaosSession({ sessionId: 'S1', startedAt: 10, command: ['shadowlap', 'test', 'goldens/*', '--chaos'], presets: ['timeout'] });
    store.addChaosResult({ sessionId: 'S1', runId: 'G', golden: 'goldens/a', preset: 'timeout', verdict: 'failed', at: 11 });
    store.addChaosResult({ sessionId: 'S1', runId: 'G', golden: 'goldens/copy-of-a', preset: 'timeout', verdict: 'passed', at: 12 });
    store.startChaosSession({ sessionId: 'S2', startedAt: 20, command: ['shadowlap', 'replay', 'G', '--chaos'], presets: ['timeout'] });
    store.addChaosResult({ sessionId: 'S2', runId: 'G', preset: 'timeout', verdict: 'inconclusive', at: 21 });
    store.addChaosResult({ sessionId: 'S2', runId: 'G', preset: 'timeout', verdict: 'passed', at: 22 });
    expect(store.listChaosResults({ sessionId: 'S1' }).map((r) => [r.golden, r.verdict])).toEqual([
      ['goldens/copy-of-a', 'passed'],
      ['goldens/a', 'failed'],
    ]);
    // A second result for the same run in the same session replaces the first.
    expect(store.listChaosResults({ sessionId: 'S2' }).map((r) => [r.golden, r.verdict])).toEqual([[null, 'passed']]);
    expect(store.latestChaosResults().map((r) => [r.golden, r.verdict]).sort()).toEqual([
      ['goldens/a', 'failed'],
      ['goldens/copy-of-a', 'passed'],
      [null, 'passed'],
    ].sort());
    store.close();
  });
});
