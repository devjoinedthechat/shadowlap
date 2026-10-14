import { describe, expect, it } from 'vitest';
import type { CallRecord } from '@shadowlap/engine';
import { parseFailures } from '../src/run-agent.js';

const call = (callNo: number, kind: CallRecord['kind'], name: string): CallRecord => ({
  runId: 'r', callNo, kind, name, fingerprint: 'f', occurrence: 1, origin: 'live',
  effect: null, requestRef: null, meta: {}, at: 0, end: null, attempts: [],
});
const parent = [call(1, 'api', 'POST /v1/messages'), call(2, 'tool', 'search_web'), call(3, 'api', 'POST /v1/messages')];

describe('--fail-at', () => {
  it('reads <call>=<status> pairs', () => {
    expect(parseFailures(['1=429'], parent)).toEqual(new Map([[1, 429]]));
    expect(parseFailures([' 3=500 '], parent)).toEqual(new Map([[3, 500]]));
    expect(parseFailures(['1=429', '3=529'], parent)).toEqual(new Map([[1, 429], [3, 529]]));
  });

  it('accepts no pairs at all', () => {
    expect(parseFailures([], parent).size).toBe(0);
  });

  it('rejects a status no provider could return', () => {
    // The point is to run the agent's own error path; a made-up status exercises nothing.
    for (const bad of ['1=200', '1=302', '1=600']) expect(() => parseFailures([bad], parent)).toThrow(/not a failure status/);
  });

  it('rejects a shape it cannot read, showing what was given', () => {
    for (const bad of ['1', '1=', 'x=429', '1=42', '=429']) expect(() => parseFailures([bad], parent)).toThrow(/--fail-at expects <call>=<status>/);
  });

  it('refuses a call the recording does not have', () => {
    expect(() => parseFailures(['9=429'], parent)).toThrow('--fail-at: the recording has no call #9');
  });

  it('refuses a tool call, since this answers a model request', () => {
    expect(() => parseFailures(['2=429'], parent)).toThrow(/call #2 is a tool call/);
  });
});
