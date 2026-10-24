import { fingerprintApi, fingerprintTool, storeApiRequest, type RunRecord, type Store } from '@shadowlap/engine';

/**
 * A long run for the paging tests: an agent loop of model calls, each with its request kept as an
 * agent sends it (the last twenty messages) and its answer streamed, asking for a tool, and the
 * tool's call after it. `calls` calls in all; with `liveFrom`, the calls before it are replayed (a
 * fork of a run recorded this way), and the request changes from there.
 */
export function recordLoop(store: Store, run: RunRecord, calls: number, o: { liveFrom?: number; end?: boolean } = {}): void {
  const liveFrom = o.liveFrom ?? 1;
  const sse = (events: Array<[string, Record<string, unknown>]>) => Buffer.from(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(''));
  const messages: unknown[] = [{ role: 'user', content: 'Read the notes and write a report.' }];
  let at = run.startedAt;
  store.transaction(() => {
    for (let callNo = 1, t = 0; callNo <= calls; t++) {
      const body = { model: 'claude-opus-5', max_tokens: 1024, stream: true, system: liveFrom > 1 && callNo >= liveFrom ? 'Be brief.' : 'Be thorough.', messages: messages.slice(-20) };
      const requestRef = storeApiRequest(store, body);
      const { fingerprint } = fingerprintApi({ method: 'POST', path: '/v1/messages', headers: {}, body }, [], []);
      const events: Array<[string, Record<string, unknown>]> = [
        ['message_start', { message: { id: `m${t}`, model: 'claude-opus-5', usage: { input_tokens: 900, output_tokens: 1 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: `Reading note ${t}.` } }],
        ['content_block_stop', { index: 0 }],
        ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: `tu_${t}`, name: 'read_file', input: {} } }],
        ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: `notes/${t}.md` }) } }],
        ['content_block_stop', { index: 1 }],
        ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } }],
        ['message_stop', {}],
      ];
      const api = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint, occurrence: 1 };
      const replayed = callNo < liveFrom;
      store.appendCallStart({ runId: run.runId, callNo, ...api, origin: replayed ? 'replayed' : 'live', effect: null, requestRef, meta: { provider: 'anthropic', model: 'claude-opus-5' }, at: (at += 5) });
      store.appendCallEnd(api, { runId: run.runId, callNo, attempt: 0, responseRef: store.putBlob(sse(events)), outcome: 'ok', meta: { status: 200, latencyMs: replayed ? 0 : 900, model: 'claude-opus-5', usage: { inputTokens: 900, outputTokens: 40 }, headers: { 'content-type': 'text/event-stream' }, chunks: events.map((_, i) => [0, i * 30]), ...(replayed ? { replayedFrom: callNo, recordedMs: 900 } : {}) }, at: (at += 900) });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `Reading note ${t}.` }, { type: 'tool_use', id: `tu_${t}`, name: 'read_file', input: { path: `notes/${t}.md` } }] });
      if (++callNo > calls) break;
      const args = { path: `notes/${t}.md` };
      const tool = { kind: 'tool' as const, name: 'read_file', fingerprint: fingerprintTool('read_file', args, []).fingerprint, occurrence: 1 };
      const toolReplayed = callNo < liveFrom;
      store.appendCallStart({ runId: run.runId, callNo, ...tool, origin: toolReplayed ? 'replayed' : 'live', effect: 'read', requestRef: store.putJson({ args }), meta: {}, at: (at += 1) });
      store.appendCallEnd(tool, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ content: `Note ${t}: findings.` }), outcome: 'ok', meta: { latencyMs: toolReplayed ? 0 : 2, ...(toolReplayed ? { replayedFrom: callNo, recordedMs: 2 } : {}) }, at: (at += 2) });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${t}`, content: `Note ${t}: findings.` }] });
      callNo++;
    }
  });
  if (o.end !== false) store.endRun(run.runId, 'completed', at);
}
