import { describe, expect, it } from 'vitest';
import { copyRules, endpointSamples, lineageWords, redactRuleCount, tallyProviders } from '../ui/run/provenance.js';
import type { RunLike } from '../ui/runs.js';

// Provenance names the provider a run's model calls went to, and what a copy made now would apply,
// when the server does not work them out.

describe('the provider of a run’s model calls', () => {
  const calls = [
    { callNo: 1, kind: 'clock', name: 'now' },
    { callNo: 3, kind: 'api', name: 'POST /v1/messages' },
    { callNo: 4, kind: 'tool', name: 'search_web' },
    { callNo: 6, kind: 'api', name: 'POST /v1/messages' },
    { callNo: 9, kind: 'api', name: 'POST /v1/chat/completions' },
    { callNo: 11, kind: 'api', name: 'POST /v1/messages' },
  ];

  it('asks one call of each endpoint, with how many calls went there', () => {
    expect(endpointSamples(calls)).toEqual([
      { first: 3, calls: 3 },
      { first: 9, calls: 1 },
    ]);
    expect(endpointSamples(calls, 1)).toEqual([{ first: 3, calls: 3 }]);
    expect(endpointSamples([{ callNo: 1, kind: 'tool', name: 'read_file' }])).toEqual([]);
  });

  it('counts the calls per provider the calls named, most used first, leaving out a call that named none', () => {
    expect(tallyProviders([{ provider: 'openai', calls: 1 }, { provider: 'anthropic', calls: 3 }, { provider: null, calls: 2 }, { provider: 'openai', calls: 4 }])).toEqual([
      { provider: 'openai', calls: 5 },
      { provider: 'anthropic', calls: 3 },
    ]);
    expect(tallyProviders([])).toEqual([]);
  });
});

describe('what a copy made now applies', () => {
  it('names the rules and, when counted, what they would mask', () => {
    expect(copyRules(3, 12)).toBe('3 redaction rules and would mask 12 values in this run');
    expect(copyRules(1, 1)).toBe('1 redaction rule and would mask 1 value in this run');
    // What the rules match that a copy leaves as it is (numbers), apart.
    expect(copyRules(3, 7, false, false, 1)).toBe('3 redaction rules and would mask 7 values in this run; 1 more they match stays as it is');
    expect(copyRules(1, 0, false, false, 40)).toBe('1 redaction rule and would mask 0 values in this run; 40 more it matches stay as they are');
    expect(copyRules(2, null, true, false, 4)).toBe('2 redaction rules; what they would mask in this run wasn’t counted');
    expect(copyRules(2, null)).toBe('2 redaction rules');
    // Not counted, and why on hover; or still to be, while the previews are busy.
    expect(copyRules(2, null, true)).toBe('2 redaction rules; what they would mask in this run wasn’t counted');
    expect(copyRules(1, null, true, true)).toBe('1 redaction rule; what it would mask in this run is being counted');
    expect(copyRules(0, 0)).toBe('no redaction rules: it would hold what was recorded');
    expect(copyRules(undefined, null)).toBe('the redaction rules in shadowlap.config.json');
  });

  it('counts the Share menu’s rules from the server, else from the run’s provenance record', () => {
    expect(redactRuleCount({ redactRules: 4 }, { mask: { rules: 3 } })).toBe(4);
    expect(redactRuleCount({}, { mask: { rules: 3 } })).toBe(3);
    expect(redactRuleCount({ redactRules: null }, { mask: { rules: 0 } })).toBe(0);
    expect(redactRuleCount(null, null)).toBeNull();
    expect(redactRuleCount({}, { mask: null })).toBeNull();
  });
});

describe('a run of the lineage', () => {
  const rec: RunLike = { runId: '01K5CQ4N7G0000000000000000', parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node refund_agent.mjs', codeVersion: null, startedAt: 0, calls: 8, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], kind: 'recording', outcome: { kind: 'none' }, failed: false };
  const fork: RunLike = { ...rec, runId: '01K5CQ4P2R0000000000000000', mode: 'replay', parentRunId: rec.runId, divergence: { callNo: 3, type: 'forced' }, kind: 'fork' };

  it('says what it is, and how it stands as Runs and the Forks view say it', () => {
    expect(lineageWords(rec, 'recording')).toEqual({ err: null, text: 'recording' });
    expect(lineageWords(fork, 'fork @3')).toEqual({ err: null, text: 'fork @3' });
    // Stopped before it ended (Ctrl-C, its recorder killed): what it is, then that, in grey.
    expect(lineageWords({ ...rec, status: 'crashed' }, 'recording')).toEqual({ err: null, text: 'recording · interrupted' });
    expect(lineageWords({ ...fork, status: 'crashed' }, 'fork @3')).toEqual({ err: null, text: 'fork @3 · interrupted' });
    // Recording now.
    expect(lineageWords({ ...rec, status: 'running', outcome: { kind: 'running' } }, 'recording')).toEqual({ err: null, text: 'recording now' });
    expect(lineageWords({ ...fork, status: 'running', outcome: { kind: 'running' } }, 'fork @3')).toEqual({ err: null, text: 'fork @3 · running now' });
  });

  it('names what a failed recording or test failed in its place, as the design does', () => {
    expect(lineageWords({ ...rec, status: 'failed', outcome: { kind: 'check-failed', check: null }, failed: true }, 'recording')).toEqual({ err: 'failed', text: '' });
    expect(lineageWords({ ...rec, outcome: { kind: 'lost', callNo: 9 }, failed: true }, 'recording')).toEqual({ err: 'check failed', text: '' });
    expect(lineageWords({ ...fork, kind: 'test', test: { golden: 'goldens/refund' }, outcome: { kind: 'diverged', callNo: 3 }, failed: true }, 'test')).toEqual({ err: 'test failed', text: '' });
    // A fork keeps what it is: its line in Forks says what it did.
    expect(lineageWords({ ...fork, status: 'failed', failed: true }, 'fork @3')).toEqual({ err: null, text: 'fork @3' });
  });
});
