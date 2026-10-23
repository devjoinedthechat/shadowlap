import { describe, expect, it } from 'vitest';
import type { CallEndRow, CallMeta, CallRecord } from '../src/types.js';
import { UNAVAILABLE_RETRY, providerUnavailable, retryAfter, retryDelay, unavailableReason, unavailableStatus } from '../src/unavailable.js';

/**
 * An attempt the agent failed while its provider couldn't answer says nothing about the agent: what
 * counts as the provider's failure, read from the call records, and how long to wait before asking again.
 */

let n = 0;
function call(end: Partial<CallMeta> & { outcome?: 'ok' | 'error' } = {}, o: { origin?: CallRecord['origin']; kind?: CallRecord['kind']; scope?: string; noEnd?: boolean } = {}): CallRecord {
  const callNo = ++n;
  const { outcome = 'error', ...meta } = end;
  const row: CallEndRow = { runId: 'R', callNo, attempt: 0, responseRef: null, outcome, meta: { provider: 'anthropic', ...meta }, at: Date.UTC(2026, 9, 23, 12) };
  return {
    runId: 'R',
    callNo,
    kind: o.kind ?? 'api',
    name: 'POST /v1/messages',
    fingerprint: 'f',
    occurrence: 1,
    origin: o.origin ?? 'live',
    effect: null,
    requestRef: null,
    meta: { provider: 'anthropic', ...(o.scope ? { scope: o.scope } : {}) },
    at: row.at,
    end: o.noEnd ? null : row,
    attempts: [],
  };
}
const ok = () => call({ outcome: 'ok', status: 200 });

describe('providerUnavailable', () => {
  it('names the call that ended on a status the provider sends when it cannot answer', () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504, 524, 529]) {
      expect(unavailableStatus(status)).toBe(true);
      const u = providerUnavailable([ok(), call({ status })]);
      expect(u, `HTTP ${status}`).toMatchObject({ status, provider: 'anthropic', error: null });
      expect(u!.reason).toMatch(new RegExp(`^HTTP ${status} from anthropic at call #\\d+$`));
    }
    for (const status of [400, 401, 403, 404, 413, 422]) expect(providerUnavailable([call({ status })]), `HTTP ${status}`).toBeNull();
  });

  it('counts a connection that failed or a stream cut short', () => {
    expect(providerUnavailable([call({ status: 502, error: { name: 'UpstreamConnectionError', message: 'connect ECONNREFUSED' } })])).toMatchObject({ error: 'UpstreamConnectionError', reason: expect.stringMatching(/^a connection that failed from anthropic at call #/) });
    expect(providerUnavailable([call({ status: 200, error: { name: 'UpstreamStreamError', message: 'terminated' } })])).toMatchObject({ error: 'UpstreamStreamError', reason: expect.stringMatching(/^a stream cut short from anthropic/) });
  });

  it("leaves out the agent's own timeout, what Shadowlap played in or refused, a judge's calls, and calls that ended well", () => {
    // The agent hung up: its client's timeout, or an abort.
    expect(providerUnavailable([call({ status: 529, error: { name: 'ClientDisconnected', message: 'the client closed the connection' } })])).toBeNull();
    // `--fail-at` and test --chaos play failures in on purpose; offline and placeholder refusals are Shadowlap's.
    expect(providerUnavailable([call({ status: 429, injected: true })])).toBeNull();
    expect(providerUnavailable([call({ status: 503, offline: true })])).toBeNull();
    expect(providerUnavailable([call({ status: 401, refused: true })])).toBeNull();
    expect(providerUnavailable([call({ status: 529 }, { scope: 'shadowlap:judge' })])).toBeNull();
    // A recorded error replayed is the recording's, not the provider's now.
    expect(providerUnavailable([call({ status: 529 }, { origin: 'replayed' })])).toBeNull();
    // An SDK that retried until it succeeded ended well; a call still waiting has no answer to read.
    expect(providerUnavailable([ok(), call({ status: 529 }, { noEnd: true })])).toBeNull();
    expect(providerUnavailable([call({ status: 529 }, { kind: 'tool' })])).toBeNull();
  });

  it('takes the last call that shows it, with what it asked for', () => {
    const u = providerUnavailable([call({ status: 429, headers: { 'retry-after': '2' } }), ok(), call({ status: 529, headers: { 'retry-after-ms': '250' } })]);
    expect(u).toMatchObject({ status: 529, retryAfterMs: 250 });
  });
});

describe('retryAfter', () => {
  it('reads retry-after-ms first, then retry-after as seconds or an HTTP date', () => {
    expect(retryAfter({ 'retry-after-ms': '1500', 'retry-after': '9' })).toBe(1500);
    expect(retryAfter({ 'retry-after': '3' })).toBe(3000);
    expect(retryAfter({ 'retry-after': '0.5' })).toBe(500);
    const now = Date.UTC(2026, 9, 23, 12, 0, 0);
    expect(retryAfter({ 'retry-after': 'Fri, 23 Oct 2026 12:00:20 GMT' }, now)).toBe(20_000);
    expect(retryAfter({ 'retry-after': 'Fri, 23 Oct 2026 11:00:00 GMT' }, now)).toBe(0);
    expect(retryAfter({ 'retry-after': 'soon' })).toBeNull();
    expect(retryAfter({})).toBeNull();
    expect(retryAfter(undefined)).toBeNull();
  });
});

describe('retryDelay', () => {
  it('waits what the provider asked, at most a minute', () => {
    expect(retryDelay(1, 2_000)).toBe(2_000);
    expect(retryDelay(2, 0)).toBe(0);
    expect(retryDelay(1, 600_000)).toBe(UNAVAILABLE_RETRY.maxDelayMs);
  });

  it('else backs off from 5 s, three times longer each time, a fifth either way at random, at most a minute', () => {
    expect(retryDelay(1, null, () => 0.5)).toBe(5_000);
    expect(retryDelay(2, null, () => 0.5)).toBe(15_000);
    expect(retryDelay(3, null, () => 0.5)).toBe(45_000);
    expect(retryDelay(4, null, () => 0.5)).toBe(60_000);
    expect(retryDelay(1, null, () => 0)).toBe(4_000);
    expect(retryDelay(1, null, () => 0.999999)).toBe(6_000);
  });

  it('gives up after three in a row, and says why with the provider named', () => {
    expect(UNAVAILABLE_RETRY.inARow).toBe(3);
    const u = providerUnavailable([call({ status: 529 })])!;
    expect(unavailableReason(3, u)).toBe(`provider unavailable: 3 attempts in a row ended on HTTP 529 from anthropic at call #${u.callNo}, so none of them says anything about the agent; run it again once the provider answers`);
  });
});
