import { describe, expect, it } from 'vitest';
import type { CallRecord, RunRecord } from '@shadowlap/engine';
import { otlpHeaders, providerOf, runToOtlp } from '../src/otel.js';

const run: RunRecord = {
  runId: '01K5CQ4N7GXXXXXXXXXXXXXXXX',
  parentRunId: null,
  mode: 'record',
  status: 'completed',
  divergence: null,
  command: { argv: ['node', 'agent.js'], cwd: '/w' },
  codeVersion: 'abc123',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_005_000,
};

const api: CallRecord = {
  runId: run.runId,
  callNo: 1,
  kind: 'api',
  name: 'POST /v1/messages',
  fingerprint: 'fp1',
  occurrence: 1,
  origin: 'live',
  effect: null,
  requestRef: null,
  meta: {},
  at: 1_700_000_000_100,
  end: { runId: run.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { status: 200, model: 'claude-opus-5', stopReason: 'tool_use', bytes: 1200, usage: { inputTokens: 1000, outputTokens: 40, cacheReadInputTokens: 200 } }, at: 1_700_000_001_100 },
  attempts: [],
};
const tool: CallRecord = { ...api, callNo: 2, kind: 'tool', name: 'search_web', effect: 'read', origin: 'replayed', at: 1_700_000_001_200, end: { ...api.end!, callNo: 2, meta: { latencyMs: 3, replayedFrom: 2 }, outcome: 'ok' } };
const failed: CallRecord = { ...api, callNo: 3, at: 1_700_000_002_000, end: { ...api.end!, callNo: 3, outcome: 'error', meta: { status: 500 } } };

describe('runToOtlp', () => {
  it('emits one run span and one span per call with GenAI attributes', () => {
    const out = runToOtlp(run, [api, tool, failed], { version: '0.1.0' }) as { resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }; scopeSpans: Array<{ scope: { name: string; version?: string }; spans: Array<Record<string, unknown>> }> }> };
    const rs = out.resourceSpans[0]!;
    expect(rs.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue).toBe('shadowlap-agent');
    const spans = rs.scopeSpans[0]!.spans;
    expect(rs.scopeSpans[0]!.scope).toEqual({ name: 'shadowlap', version: '0.1.0' });
    expect(spans).toHaveLength(4);
    const [root, s1, s2, s3] = spans as Array<{ traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string; attributes: Array<{ key: string; value: Record<string, unknown> }>; status: { code: number; message?: string } }>;
    expect(root!.traceId).toHaveLength(32);
    expect(root!.spanId).toHaveLength(16);
    expect(root!.parentSpanId).toBeUndefined();
    expect(root!.name).toBe('shadowlap.record node agent.js');
    expect(root!.startTimeUnixNano).toBe('1700000000000000000');
    expect(root!.endTimeUnixNano).toBe('1700000005000000000');
    const attrsOf = (s: (typeof spans)[number]) => Object.fromEntries((s as { attributes: Array<{ key: string; value: Record<string, unknown> }> }).attributes.map((a) => [a.key, Object.values(a.value)[0]]));
    for (const s of [s1!, s2!, s3!]) {
      expect(s.traceId).toBe(root!.traceId);
      expect(s.parentSpanId).toBe(root!.spanId);
    }
    expect(s1!.name).toBe('chat claude-opus-5');
    expect(s1!.kind).toBe(3);
    expect(attrsOf(s1!)).toMatchObject({ 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'anthropic', 'gen_ai.request.model': 'claude-opus-5', 'gen_ai.usage.input_tokens': '1200', 'gen_ai.usage.output_tokens': '40', 'http.response.status_code': '200', 'shadowlap.origin': 'live' });
    expect(attrsOf(s1!)['gen_ai.response.finish_reasons']).toEqual({ values: [{ stringValue: 'tool_use' }] });
    expect(attrsOf(s1!)['shadowlap.cost_usd']).toBeCloseTo(0.0061, 4);
    expect(s2!.name).toBe('execute_tool search_web');
    expect(attrsOf(s2!)).toMatchObject({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_web', 'shadowlap.effect': 'read', 'shadowlap.origin': 'replayed', 'shadowlap.replayed_from': '2' });
    expect(s3!.status).toEqual({ code: 2, message: 'HTTP 500' });
    expect(attrsOf(s3!)['error.type']).toBe('http.500');
    expect(attrsOf(root!)).toMatchObject({ 'shadowlap.run.id': run.runId, 'shadowlap.run.mode': 'record', 'shadowlap.run.calls': '3' });
    // Only the live model call is priced into the run's cost.
    expect(attrsOf(root!)['shadowlap.run.cost_usd']).toBeCloseTo(0.0061, 4);
    // Deterministic ids: the same run exports the same trace.
    expect((runToOtlp(run, [api]) as typeof out).resourceSpans[0]!.scopeSpans[0]!.spans[0]).toMatchObject({ traceId: root!.traceId, spanId: root!.spanId });
  });

  it('infers the provider from the request path for older recordings', () => {
    expect(providerOf(api)).toBe('anthropic');
    expect(providerOf({ ...api, name: 'POST /v1/chat/completions' })).toBe('openai');
    expect(providerOf({ ...api, name: 'POST /v1beta/models/gemini-2.5-pro:streamGenerateContent' })).toBe('gemini');
    expect(providerOf({ ...api, end: { ...api.end!, meta: { provider: 'openai' } } })).toBe('openai');
    expect(providerOf(tool)).toBeNull();
  });

  it('parses OTLP header lists', () => {
    expect(otlpHeaders('authorization=Bearer%20x, x-scope-orgid=team')).toEqual({ authorization: 'Bearer x', 'x-scope-orgid': 'team' });
    expect(otlpHeaders(undefined)).toEqual({});
  });
});
