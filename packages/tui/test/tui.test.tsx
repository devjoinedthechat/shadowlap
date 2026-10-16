import { render } from 'ink-testing-library';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeConversation, normalizeResponse, Store, unpackRun } from '@shadowlap/engine';
import { App } from '../src/app.js';
import { diffLines } from '../src/components/DiffView.js';
import { conversationLines } from '../src/render.js';
import { parseSse, streamView } from '../src/sse.js';

const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent/', import.meta.url));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// Frames carry ANSI style codes between adjacent <Text> nodes; assertions look at the plain text.
const plain = (frame: string | undefined) => (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
/**
 * Waits for a frame to show something, rather than guessing how long the render takes. A key that
 * starts async work reaches the frame one resolved promise and one re-render later, which is
 * microseconds on an idle machine and longer than a fixed delay on a loaded CI runner. Failing
 * asserts on the last frame seen, so the message is the frame, not a timeout.
 */
async function frameWith(lastFrame: () => string | undefined, text: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = plain(lastFrame());
  while (!frame.includes(text) && Date.now() < deadline) {
    await tick(10);
    frame = plain(lastFrame());
  }
  expect(frame).toContain(text);
  return frame;
}

function goldenStore(): { store: Store; runId: string } {
  const store = Store.open(':memory:');
  const { imported } = unpackRun(store, GOLDEN);
  return { store, runId: imported[0]! };
}

describe('TUI', () => {
  it('lists runs and opens a timeline with Enter', async () => {
    const { store, runId } = goldenStore();
    const fork = store.createRun({ mode: 'replay', parentRunId: runId, command: { argv: ['node', 'agent.js'], cwd: '.' } });
    store.setDivergence(fork.runId, { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, diff: [{ path: '$.system', op: 'changed', before: 'a', after: 'b' }] });
    store.endRun(fork.runId, 'completed');

    const { lastFrame, stdin } = render(<App store={store} columns={100} rows={30} />);
    await tick();
    const frame = plain(lastFrame());
    expect(frame).toContain('2 runs');
    expect(frame).toContain(runId.slice(0, 10));
    expect(frame).toContain('recording');
    expect(frame).toContain('fork @3');
    expect(frame).toContain('30 calls');

    stdin.write('k'); // up to the recording
    await tick();
    stdin.write('\r');
    await tick(60);
    let timeline = plain(lastFrame());
    expect(timeline).toContain('#1');
    expect(timeline).toContain('now');
    expect(timeline).toMatch(/api\s+messages/); // the endpoint without its method and version
    expect(timeline).toContain('conversation');
    expect(timeline).toContain('no model request before this call'); // #1 is the clock read

    stdin.write('j');
    stdin.write('j'); // #3, the first model call
    await tick(60);
    timeline = plain(lastFrame());
    expect(timeline).toContain('conversation as sent in call #3');
    expect(timeline).toContain('You are a research agent');

    stdin.write('\t'); // request tab
    await tick(60);
    expect(plain(lastFrame())).toContain('request');
    stdin.write('4'); // meta tab
    await tick(60);
    expect(plain(lastFrame())).toContain('origin');
    store.close();
  });

  it('opens a fork at its divergence and shows the diff', async () => {
    const { store, runId } = goldenStore();
    const fork = store.createRun({ mode: 'replay', parentRunId: runId, command: { argv: ['node', 'agent.js'], cwd: '.' } });
    const parentCalls = store.getCalls(runId);
    for (const c of parentCalls.slice(0, 3)) {
      const { end, attempts, ...start } = c;
      store.appendCallStart({ ...start, runId: fork.runId, origin: c.callNo < 3 ? 'replayed' : 'live' });
      if (end) store.appendCallEnd(c, { ...end, runId: fork.runId });
    }
    store.setDivergence(fork.runId, {
      type: 'request_changed',
      callNo: 3,
      kind: 'api',
      name: 'POST /v1/messages',
      replayedBefore: 2,
      counterpart: { runId, callNo: 3 },
      diff: [{ path: '$.system', op: 'changed', before: 'Today is 2026-09-15.', after: 'Today is 2026-09-16.' }],
      hints: [{ message: 'this looks like a date', normalizer: { kind: 'api', path: '$.system', pattern: 'iso-date', replace: '<DATE>' } }],
    });
    store.endRun(fork.runId, 'completed');

    const { lastFrame, stdin } = render(<App store={store} runId={fork.runId} columns={100} rows={30} />);
    await tick(60);
    expect(plain(lastFrame())).toContain('>!#3'); // divergence row marked and selected
    stdin.write('d');
    await tick(60);
    const diff = plain(lastFrame());
    expect(diff).toContain('Diverged at call 3');
    expect(diff).toContain('~ $.system');
    expect(diff).toContain('- "Today is 2026-09-15."');
    expect(diff).toContain('shadowlap normalize add --kind api');
    store.close();
  });

  it('plays a streamed response instantly', async () => {
    const { store, runId } = goldenStore();
    const { lastFrame, stdin } = render(<App store={store} runId={runId} columns={100} rows={30} />);
    await tick(60);
    stdin.write('j');
    stdin.write('j'); // #3, the first model call
    await tick(60);
    stdin.write('+');
    stdin.write('+');
    stdin.write('+'); // ×1 → ×2 → ×4 → instant
    stdin.write(' ');
    // CI runners can be slow to re-render; poll instead of assuming a fixed delay.
    let frame = '';
    for (let i = 0; i < 40 && !frame.includes('⚙ search_web'); i++) {
      await tick(50);
      frame = plain(lastFrame());
    }
    expect(frame).toContain('response');
    expect(frame).toContain('Starting research.');
    expect(frame).toContain('⚙ search_web');
    expect(frame).toContain('19 events');
    store.close();
  });
});

describe('ease of use', () => {
  it('summarizes the run in the header, focuses panes, filters, and jumps between notable calls', async () => {
    const { store, runId } = goldenStore();
    const fork = store.createRun({ mode: 'replay', parentRunId: runId, command: { argv: ['node', 'agent.js'], cwd: '.' } });
    const parentCalls = store.getCalls(runId);
    for (const c of parentCalls) {
      const { end, attempts, ...start } = c;
      void attempts;
      const origin = c.callNo < 17 ? 'replayed' : c.name === 'send_email' ? 'blocked' : 'live';
      store.appendCallStart({ ...start, runId: fork.runId, origin });
      if (end) store.appendCallEnd(c, { ...end, runId: fork.runId, ...(origin === 'blocked' ? { outcome: 'error' } : {}) });
    }
    store.setDivergence(fork.runId, { type: 'request_changed', callNo: 17, kind: 'api', name: 'POST /v1/messages', replayedBefore: 16 });
    store.endRun(fork.runId, 'completed');

    const { lastFrame, stdin } = render(<App store={store} runId={fork.runId} columns={100} rows={30} />);
    await tick(60);
    let frame = plain(lastFrame());
    expect(frame).toContain(`fork @17 of ${runId.slice(0, 10)}`);
    expect(frame).toContain('16 replayed');
    expect(frame).toContain('13 live'); // 14 calls after the fork, one of them blocked
    expect(frame).toContain('1 blocked');
    expect(frame).toContain('>!#17'); // opened at the divergence

    stdin.write(']'); // next notable call after #17: #18 ran live
    await tick(60);
    expect(plain(lastFrame())).toContain('> #18');
    stdin.write('['); // and back
    await tick(60);
    expect(plain(lastFrame())).toContain('>!#17');

    stdin.write('/');
    await tick(60);
    expect(plain(lastFrame())).toContain('Filter calls');
    stdin.write('send_email');
    stdin.write('\r');
    await tick(60);
    frame = plain(lastFrame());
    expect(frame).toContain('filter: /send_email (1/30)');
    expect(frame).toContain('tool send_email'); // the list row
    expect(frame).not.toContain('tool search_web'); // filtered out of the list (the inspector may still mention it)
    stdin.write('\x1b'); // Esc clears the filter
    await tick(60);
    expect(plain(lastFrame())).not.toContain('filter:');

    stdin.write('l'); // focus the inspector
    await tick(60);
    frame = plain(lastFrame());
    expect(frame).toContain('inspector: j/k scroll');
    stdin.write('h');
    await tick(60);
    expect(plain(lastFrame())).toContain(': actions');
    store.close();
  });

  it('searches and deletes runs from the runs view', async () => {
    const { store, runId } = goldenStore();
    const other = store.createRun({ mode: 'record', command: { argv: ['python', 'triage.py'], cwd: '.' } });
    store.endRun(other.runId, 'completed');
    const { lastFrame, stdin } = render(<App store={store} columns={100} rows={30} />);
    await tick(60);
    expect(plain(lastFrame())).toContain('2 runs');
    stdin.write('/');
    await tick(60);
    expect(plain(lastFrame())).toContain('run id, command, revision or label contains');
    stdin.write('triage');
    stdin.write('\r'); // same tick as the text: the editor must not submit a stale value
    await tick(60);
    let frame = plain(lastFrame());
    expect(frame).toContain('1/2 runs');
    expect(frame).toContain('triage.py');
    expect(frame).not.toContain(runId.slice(0, 10));
    stdin.write('x');
    await tick(60);
    expect(plain(lastFrame())).toContain('delete run');
    stdin.write('y');
    await tick(60);
    expect(store.getRun(other.runId)).toBeNull();
    stdin.write('\x1b'); // clear the search
    await tick(60);
    frame = plain(lastFrame());
    expect(frame).toContain('1 run');
    expect(frame).toContain(runId.slice(0, 10));
    store.close();
  });

  it('leaves a run that is still recording, and says why', async () => {
    const { store } = goldenStore();
    // Recorded by this process, which is still running.
    const live = store.createRun({ mode: 'record', command: { argv: ['python', 'chat.py'], cwd: '.' } });
    const { lastFrame, stdin } = render(<App store={store} columns={100} rows={30} />);
    await tick(60);
    stdin.write('/');
    await tick(60);
    stdin.write('chat');
    stdin.write('\r');
    await tick(60);
    stdin.write('x');
    await tick(60);
    stdin.write('y');
    await frameWith(lastFrame, `${live.runId.slice(0, 10)} was not deleted: still recording; delete it once that has ended`);
    expect(store.getRun(live.runId)).not.toBeNull();
    store.close();
  });
});

describe('scopes, labels and the dashboard', () => {
  it('shows each call\'s scope, opens at a given call, and hands the call to the dashboard', async () => {
    const { store, runId } = goldenStore();
    const scoped = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' } });
    for (const c of store.getCalls(runId).slice(0, 6)) {
      const { end, attempts, ...start } = c;
      void attempts;
      store.appendCallStart({ ...start, runId: scoped.runId, meta: { ...start.meta, scope: c.callNo % 2 ? 'planner' : 'researcher' } });
      if (end) store.appendCallEnd(c, { ...end, runId: scoped.runId });
    }
    store.endRun(scoped.runId, 'completed');
    const asked: Array<[string, number | undefined]> = [];
    const openDashboard = async (id: string, callNo?: number) => {
      asked.push([id, callNo]);
      return { url: 'http://127.0.0.1:4777/#token=t', opened: true };
    };

    const { lastFrame, stdin } = render(<App store={store} runId={scoped.runId} callNo={4} openDashboard={openDashboard} columns={100} rows={30} />);
    await tick(60);
    const frame = plain(lastFrame());
    expect(frame).toMatch(/> #4\s+tool\s+researcher\s+search_web/); // opened at #4, with its scope before the name
    expect(frame).toMatch(/#3\s+api\s+planner/);
    stdin.write('/');
    await tick(60);
    stdin.write('planner');
    stdin.write('\r');
    await tick(60);
    expect(plain(lastFrame())).toContain('(3/6)'); // the filter matches scopes too
    stdin.write('j'); // #3, the second planner call
    await tick(60);
    stdin.write('4'); // meta tab
    await tick(60);
    expect(plain(lastFrame())).toMatch(/scope\s+planner/);
    stdin.write('o');
    await frameWith(lastFrame, 'opened #3 in the dashboard');
    expect(asked).toEqual([[scoped.runId, 3]]);
    store.close();
  });

  it('lists labels and check results with each run, finds runs by label, and opens a run in the dashboard', async () => {
    const { store, runId } = goldenStore();
    store.updateRunMeta(runId, { labels: ['refund', 'eu'], checks: [{ ok: true, label: 'a', detail: null }, { ok: false, label: 'b', detail: 'no' }] });
    const other = store.createRun({ mode: 'record', command: { argv: ['python', 'triage.py'], cwd: '.' } });
    store.endRun(other.runId, 'completed');
    let url = '';
    const openDashboard = async (id: string) => ({ url: (url = `http://127.0.0.1:4777/#token=t&open=/run/${id}`), opened: false });

    const { lastFrame, stdin } = render(<App store={store} openDashboard={openDashboard} columns={100} rows={30} />);
    await tick(60);
    let frame = plain(lastFrame());
    expect(frame).toContain('✗ 1/2 refund eu');
    stdin.write('/');
    await tick(60);
    stdin.write('refund');
    stdin.write('\r');
    await tick(60);
    frame = plain(lastFrame());
    expect(frame).toContain('1/2 runs');
    expect(frame).not.toContain('triage.py');
    expect(frame).toContain('checks 1/2 passed');
    stdin.write('o');
    // No browser: the link is shown to copy.
    await frameWith(lastFrame, 'http://127.0.0.1:4777/#token=t');
    expect(url).toContain(runId);
    store.close();
  });
});

describe('actions palette', () => {
  it('lists context-aware actions, prompts for input, runs the CLI and opens the created run', async () => {
    const { spawn } = await import('node:child_process');
    const { store, runId } = goldenStore();
    const fork = store.createRun({ mode: 'replay', parentRunId: runId, command: { argv: ['node', 'agent.js'], cwd: '.' } });
    store.endRun(fork.runId, 'completed');
    const spawned: string[][] = [];
    // A stand-in for the CLI: echoes its arguments and announces a run id like `shadowlap replay` does.
    const spawnCli = (args: string[]) => {
      spawned.push(args);
      return spawn(process.execPath, ['-e', `console.log('args: ' + JSON.stringify(process.argv.slice(1))); console.error('[shadowlap] replaying run ${fork.runId}'); console.log('done')`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    };

    const { lastFrame, stdin } = render(<App store={store} runId={runId} spawnCli={spawnCli} columns={100} rows={30} />);
    await tick(60);
    stdin.write('j');
    stdin.write('j'); // #3, the first model call
    await tick(60);
    stdin.write(':');
    await tick(60);
    let frame = plain(lastFrame());
    expect(frame).toContain('Actions');
    expect(frame).toContain('At #3 · model call');
    expect(frame).toContain('Inject an instruction');
    expect(frame).toContain('--inject 3=… --inject-as user'); // each line carries its flag
    expect(frame).toContain('Switch the model from here');
    expect(frame).toContain('The whole run');
    expect(frame).not.toContain('--live-tool'); // not a tool call

    stdin.write('i'); // inject → prompt
    await tick(60);
    frame = plain(lastFrame());
    expect(frame).toContain('Instruction to add at #3:');
    stdin.write('Be brief.');
    await tick(30);
    stdin.write('\r');
    let opened = '';
    for (let i = 0; i < 60 && !opened; i++) {
      await tick(50);
      frame = plain(lastFrame());
      if (frame.includes('Enter opens run')) opened = frame;
    }
    // The golden is imported with unpack; submitting the prompt is the consent, passed on as --yes.
    expect(spawned).toEqual([['replay', runId, '--inject', '3=Be brief.', '--inject-as', 'user', '--yes']]);
    expect(opened).toContain('args: ["replay"');
    expect(opened).toContain('done');

    stdin.write('\r'); // open the created run
    await tick(80);
    frame = plain(lastFrame());
    expect(frame).toContain(fork.runId.slice(0, 10));
    store.close();
  });

  it('puts a prompt\'s label on its own lines, above what is typed, however long it is', async () => {
    const { store, runId } = goldenStore();
    // The golden is a pack's run: each fork's prompt starts with what replaying it runs.
    const spawnCli = () => {
      throw new Error('nothing is run here');
    };
    const { lastFrame, stdin } = render(<App store={store} runId={runId} spawnCli={spawnCli as never} columns={100} rows={30} />);
    await tick(60);
    stdin.write('j');
    stdin.write('j'); // #3, the first model call
    await tick(60);
    stdin.write(':');
    await frameWith(lastFrame, 'Inject an instruction');
    stdin.write('i');
    await frameWith(lastFrame, 'Instruction to add at #3:');
    stdin.write('Be brief.');
    const frame = await frameWith(lastFrame, '› Be brief.');
    const lines = frame.split('\n').map((l) => l.replace(/^[\s│]+|[\s│]+$/g, ''));
    // What is typed has its line to itself, and the label wraps above it, every word whole.
    const at = lines.findIndex((l) => l.startsWith('› Be brief.'));
    expect(lines[at]).toBe('› Be brief.');
    const label = 'This run came from an imported pack; replaying it runs: node testing/reference-agent/dist/main.js. Instruction to add at #3:';
    expect(lines.slice(0, at).join(' ')).toContain(label);
    expect(lines[at + 1]).toBe('Enter to confirm · Esc to cancel');
    stdin.write('\u001b');
    store.close();
  });

  it('offers tool actions on a tool call and the normalizer action on a fork with a hint', async () => {
    const { store, runId } = goldenStore();
    const calls = store.getCalls(runId);
    const toolCall = calls.find((c) => c.kind === 'tool')!;
    // As a run recorded here: imported runs are covered in actions.test.ts.
    const run = { ...store.getRun(runId)!, meta: {} };
    const labels = (await import('../src/components/ActionsView.js')).buildActions({ ...run, divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'x', replayedBefore: 2, hints: [{ message: 'date', normalizer: { kind: 'api', path: '$.system', pattern: 'iso-date', replace: '<DATE>' } }] } }, toolCall).map((a) => [a.key, a.label, a.args] as const);
    expect(toolCall.effect).toBe('read');
    expect(labels.map((l) => l[0])).toEqual(['r', 'o', 't', 'x', 'l', 'a', 'e', 's', 'n', 'p']);
    expect(labels.find((l) => l[0] === 'l')![2]).toEqual(['replay', runId, '--live-tool', toolCall.name]);
    expect(labels.find((l) => l[0] === 'n')![2]).toEqual(['normalize', 'add', '--kind', 'api', '--path', '$.system', '--pattern', 'iso-date', '--replace', '<DATE>']);
    store.close();
  });
});

describe('render helpers', () => {
  it('renders a conversation with roles and blocks, whatever the provider', () => {
    const text = (body: unknown) => conversationLines(normalizeConversation(body)!.turns, 60).map((l) => l.text);
    expect(text({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 't', input: { a: 1 } }] }] })).toEqual(['system', 'be brief', '', 'user  #1', 'hi', '', 'assistant  #2', 'hello', '⚙ t {"a":1}', '']);
    // OpenAI Chat Completions, as the OpenAI Agents SDK sends it to Ollama.
    expect(
      text({
        model: 'qwen2.5:7b',
        messages: [
          { role: 'system', content: 'triage' },
          { role: 'user', content: 'go' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_alert_log', arguments: '{"file":"a.log"}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'ERROR pool exhausted' },
        ],
      }),
    ).toEqual(['system', 'triage', '', 'user  #1', 'go', '', 'assistant  #2', '⚙ read_alert_log {"file":"a.log"}', '', 'tool  #3', '↳ result: ERROR pool exhausted', '']);
    // Gemini contents.
    expect(text({ systemInstruction: { parts: [{ text: 'triage' }] }, contents: [{ role: 'user', parts: [{ text: 'go' }] }, { role: 'model', parts: [{ functionCall: { name: 'read_alert_log', args: { file: 'a.log' } } }] }, { role: 'user', parts: [{ functionResponse: { name: 'read_alert_log', response: { lines: 3 } } }] }] })).toEqual([
      'system',
      'triage',
      '',
      'user  #1',
      'go',
      '',
      'assistant  #2',
      '⚙ read_alert_log {"file":"a.log"}',
      '',
      'tool  #3',
      '↳ result from read_alert_log: {',
      '  "lines": 3',
      '}',
      '',
    ]);
  });

  it('plays a stream back delta by delta: Anthropic events and OpenAI tool-call chunks', () => {
    const anthropic = Buffer.from(
      [
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      ].join(''),
    );
    expect(parseSse(anthropic)).toHaveLength(5);
    const a = normalizeResponse(anthropic, 'text/event-stream', [[0, 0], [0, 5], [0, 10], [0, 15], [0, 20]]);
    expect(streamView(a.deltas, 2).lines).toEqual(['Hel']);
    expect(streamView(a.deltas, a.deltas.length)).toEqual({ lines: ['Hello'], stopReason: 'end_turn' });

    // Ollama's OpenAI-compatible stream: the tool call arrives in one chunk, usage in the last.
    const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ object: 'chat.completion.chunk', model: 'qwen2.5:7b', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const openai = Buffer.from(
      [chunk({ role: 'assistant', content: '' }), chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_alert_log', arguments: '{"file":"cert-monitor.log"}' } }] }), chunk({}, 'tool_calls'), 'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":344,"completion_tokens":17}}\n\n', 'data: [DONE]\n\n'].join(''),
    );
    const o = normalizeResponse(openai, 'text/event-stream', [], 'openai');
    expect(streamView(o.deltas, o.deltas.length)).toEqual({ lines: ['⚙ read_alert_log {"file":"cert-monitor.log"}'], stopReason: 'tool_calls' });
  });

  it('formats a divergence for the diff view', () => {
    expect(diffLines(null, 80)[0]!.text).toContain('did not diverge');
    const lines = diffLines({ type: 'forced', callNo: 4, kind: 'tool', name: 'search_web', replayedBefore: 3 }, 80).map((l) => l.text);
    expect(lines[0]).toContain('Diverged at call 4 (tool search_web)');
    expect(lines[1]).toContain('forced live');
  });
});
