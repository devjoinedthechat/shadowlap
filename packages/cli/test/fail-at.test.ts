import { describe, expect, it } from 'vitest';
import type { CallRecord } from '@shadowlap/engine';
import { parseFailures } from '../src/run-agent.js';

const call = (callNo: number, kind: CallRecord['kind'], name: string): CallRecord => ({
  runId: 'r', callNo, kind, name, fingerprint: 'f', occurrence: 1, origin: 'live',
  effect: null, requestRef: null, meta: {}, at: 0, end: null, attempts: [],
});
const parent = [call(1, 'api', 'POST /v1/messages'), call(2, 'tool', 'search_web'), call(3, 'api', 'POST /v1/messages'), call(4, 'clock', 'now')];
const models = (specs: string[]) => parseFailures(specs, parent).models;
const tools = (specs: string[]) => parseFailures(specs, parent).tools;

describe('--fail-at', () => {
  it('reads <call>=<status> pairs for model calls', () => {
    expect(models(['1=429'])).toEqual(new Map([[1, 429]]));
    expect(models([' 3=500 '])).toEqual(new Map([[3, 500]]));
    expect(models(['1=429', '3=529'])).toEqual(new Map([[1, 429], [3, 529]]));
  });

  it('accepts no pairs at all', () => {
    expect(models([]).size).toBe(0);
    expect(tools([]).size).toBe(0);
  });

  it('rejects a status no provider could return', () => {
    // The point is to run the agent's own error path; a made-up status exercises nothing.
    for (const bad of ['1=200', '1=302', '1=600', '2=200']) expect(() => parseFailures([bad], parent)).toThrow(/not a failure status/);
  });

  it('rejects a shape it cannot read, showing what was given', () => {
    for (const bad of ['1', '1=', 'x=429', '1=42', '=429']) expect(() => parseFailures([bad], parent)).toThrow(/--fail-at expects <call>=<status>/);
  });

  it('refuses a call the recording does not have', () => {
    expect(() => parseFailures(['9=429'], parent)).toThrow('--fail-at: the recording has no call #9');
  });

  it('fails a tool call with a timeout, an error with a message, or an HTTP status', () => {
    expect(tools(['2=timeout'])).toEqual(new Map([[2, { kind: 'timeout' }]]));
    expect(tools(['2=error'])).toEqual(new Map([[2, { kind: 'error' }]]));
    expect(tools(['2=error:connection reset by peer'])).toEqual(new Map([[2, { kind: 'error', message: 'connection reset by peer' }]]));
    expect(tools(['2=429'])).toEqual(new Map([[2, { kind: 'status', status: 429 }]]));
    expect(() => parseFailures(['2=slow'], parent)).toThrow(/--fail-at 2=slow: expected timeout, error/);
  });

  it('keeps timeouts and errors to tool calls, and the clock out of it, saying why', () => {
    expect(() => parseFailures(['1=timeout'], parent)).toThrow(/#1 is a model call, which fails with an HTTP status/);
    expect(() => parseFailures(['3=error:boom'], parent)).toThrow(/timeout and error are for tool calls/);
    expect(() => parseFailures(['4=500'], parent)).toThrow(/call #4 is a clock read/);
  });
});
