import { describe, expect, it } from 'vitest';
import { copyRules, endpointSamples, redactRuleCount, tallyProviders } from '../ui/run/provenance.js';

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
