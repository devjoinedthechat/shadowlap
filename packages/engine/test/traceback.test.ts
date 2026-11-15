import { describe, expect, it } from 'vitest';
import { ownFile, parseTraceback } from '../src/traceback.js';
import { NODE_CJS, NODE_ESM, NODE_SDK, NODE_THROWN, PY_CAUSE, PY_CHAINED, PY_GROUP, PY_KEYERROR, PY_SDK_503, PY_STDLIB, PY_SYNTAX } from './traceback-samples.js';

/** The mock's sample crash (its data.js), as the store would keep it. */
const MOCK = ['Traceback (most recent call last):', '  File "refund_agent.py", line 141, in issue_refund', '    log.info("refund %s of %s", refund["refund_id"], order["total"])', "KeyError: 'total'"].join('\n');

/** The agent's last lines as the store keeps them: the last 20, each cut at 400 characters. */
const tail = (output: string): string => output.split('\n').slice(-20).map((l) => l.slice(0, 400)).join('\n');

describe('a Python traceback', () => {
  it('names the exception and the frame of the agent that raised it', () => {
    const t = parseTraceback(MOCK)!;
    expect(t).toMatchObject({ runtime: 'python', exception: "KeyError: 'total'", type: 'KeyError', message: "'total'", cut: false });
    expect(t.raised).toEqual({ file: 'refund_agent.py', line: 141, column: null, fn: 'issue_refund', code: 'log.info("refund %s of %s", refund["refund_id"], order["total"])', own: true });
  });

  it('skips the carets Python 3.11 and on print under a frame\'s code', () => {
    const t = parseTraceback(PY_KEYERROR)!;
    expect(t.exception).toBe("KeyError: 'total'");
    expect(t.frames.map((f) => [f.fn, f.line, f.code])).toEqual([
      ['<module>', 18, 'main()'],
      ['main', 14, 'refund = issue_refund(order, amount)'],
      ['issue_refund', 7, 'log.info("refund %s of %s", refund["refund_id"], order["total"])'],
    ]);
    expect(t.raised).toMatchObject({ file: '/work/shop/refund_agent.py', line: 7, fn: 'issue_refund' });
  });

  it('points at the agent\'s own frame, never a library\'s, when an SDK raises', () => {
    const t = parseTraceback(PY_SDK_503)!;
    expect(t.type).toBe('anthropic._base_client.InternalServerError');
    expect(t.message).toMatch(/^Error code: 503 - \{'type': 'error', 'error': \{'type': 'shadowlap_offline'/);
    expect(t.frames.map((f) => f.own)).toEqual([true, true, false, false, false, false]);
    expect(t.raised).toMatchObject({ file: '/work/shop/sdk_agent.py', line: 8, fn: 'main', code: 'reply = client.messages.create(model="claude-x", max_tokens=10, messages=[])' });
  });

  it('counts the standard library as not the agent\'s', () => {
    const t = parseTraceback(PY_STDLIB)!;
    expect(t.exception).toBe('json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)');
    expect(t.raised).toMatchObject({ file: '/work/shop/tool_agent.py', line: 2, fn: '<module>', code: 'json.loads("")' });
    expect(t.frames.filter((f) => !f.own).map((f) => f.fn)).toEqual(['loads', 'decode', 'raw_decode']);
  });

  it('reads a tail that began inside the traceback, with no frame of the agent\'s left', () => {
    const cut = PY_SDK_503.split('\n').slice(7).join('\n');
    expect(cut.startsWith('    return post(')).toBe(true);
    const t = parseTraceback(cut)!;
    expect(t).toMatchObject({ runtime: 'python', cut: true, raised: null, type: 'anthropic._base_client.InternalServerError' });
    expect(t.frames.map((f) => f.fn)).toEqual(['post', 'request', '_request']);
  });

  it('reads the last of chained exceptions, which is what ended the process', () => {
    const t = parseTraceback(PY_CHAINED)!;
    expect(t).toMatchObject({ exception: 'LookupError: no order A-1042', cut: false });
    expect(t.frames.map((f) => f.fn)).toEqual(['<module>', 'find']);
    expect(t.raised).toMatchObject({ line: 8, code: 'raise LookupError("no order A-1042")' });
    expect(parseTraceback(PY_CAUSE)!).toMatchObject({ exception: 'RuntimeError: could not load the order', raised: { fn: 'load', line: 5 } });
  });

  it('reads a SyntaxError\'s frame with no `in` and no header, which is no cut', () => {
    const t = parseTraceback(PY_SYNTAX)!;
    expect(t).toMatchObject({ exception: "SyntaxError: '(' was never closed", cut: false });
    expect(t.raised).toEqual({ file: '/work/shop/syntax.py', line: 1, column: null, fn: null, code: 'print("refund"', own: true });
  });

  it('reads a frame with no code under it, as `python -c` and the CLI\'s sample print', () => {
    const t = parseTraceback('Traceback (most recent call last):\n  File "agent.py", line 3, in <module>\njson.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)\n')!;
    expect(t.exception).toBe('json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)');
    expect(t.raised).toMatchObject({ file: 'agent.py', line: 3, fn: '<module>', code: null });
  });

  it('reads the run page\'s crash sample, a frame with no `in` over its exception', () => {
    const t = parseTraceback("Traceback (most recent call last):\n  File \"agent.py\", line 12\nKeyError: 'total'\n")!;
    expect(t).toMatchObject({ exception: "KeyError: 'total'", raised: { file: 'agent.py', line: 12, fn: null, code: null } });
  });

  it('keeps the traceback when lines follow it', () => {
    const t = parseTraceback(`${PY_STDLIB}refund skipped\n[shadowlap] interrupted (SIGTERM)\n`)!;
    expect(t.exception).toBe('json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)');
  });

  it('takes an exception group\'s own line and frames, without descending into what it groups (low priority)', () => {
    const t = parseTraceback(PY_GROUP)!;
    expect(t).toMatchObject({ exception: 'ExceptionGroup: refund checks failed (2 sub-exceptions)', type: 'ExceptionGroup', cut: false });
    expect(t.raised).toMatchObject({ fn: 'check', line: 2 });
  });

  it('reads it the same with colour codes in it', () => {
    expect(parseTraceback(`\x1b[31m${MOCK}\x1b[0m\n`)).toEqual(parseTraceback(MOCK));
    expect(parseTraceback(PY_KEYERROR.replace('KeyError', '\x1b[1;35mKeyError\x1b[0m'))!.exception).toBe("KeyError: 'total'");
  });
});

describe('a Node error', () => {
  it('gives the throwing frame the throw site\'s line of code', () => {
    const t = parseTraceback(NODE_ESM)!;
    expect(t).toMatchObject({ runtime: 'node', exception: "TypeError: Cannot read properties of undefined (reading 'amount')", type: 'TypeError', cut: false });
    expect(t.raised).toEqual({ file: '/work/shop/agent.mjs', line: 3, column: 50, fn: 'issueRefund', code: "console.log('refund', refund.id, order.payment.amount);", own: true });
    expect(t.frames.map((f) => f.fn)).toEqual(['main', 'issueRefund']);
  });

  it('reads CommonJS, with the loader\'s frames as the runtime\'s', () => {
    const t = parseTraceback(NODE_CJS)!;
    expect(t.raised).toMatchObject({ file: '/work/shop/agent.js', fn: 'issueRefund', line: 3, column: 50 });
    expect(t.frames.filter((f) => f.own).map((f) => f.fn)).toEqual(['Object.<anonymous>', 'issueRefund']);
    expect(t.frames[0]).toMatchObject({ file: 'node:internal/main/run_main_module', fn: null, own: false });
  });

  it('reads an error the agent caught and printed, past node_modules and its properties', () => {
    const t = parseTraceback(NODE_SDK)!;
    expect(t.exception).toMatch(/^InternalServerError: 503 \{"type":"error","error":\{"type":"shadowlap_offline"/);
    expect(t.raised).toMatchObject({ file: '/work/shop/sdk-agent.mjs', line: 5, column: 17, fn: 'main', code: null });
    expect(t.frames.map((f) => f.own)).toEqual([true, false]);
  });

  it('reads a thrown value that is no error from the throw site', () => {
    const t = parseTraceback(NODE_THROWN)!;
    expect(t).toMatchObject({ runtime: 'node', exception: 'no order', type: null, message: null });
    expect(t.raised).toEqual({ file: '/work/shop/thrown.js', line: 2, column: 3, fn: null, code: "throw 'no order';", own: true });
  });

  it('reads the CLI\'s samples as the CLI does', () => {
    const json = parseTraceback('file:///x.mjs:3\n  throw err\n  ^\n\nSyntaxError: Unexpected end of JSON input\n    at JSON.parse (<anonymous>)\n\nNode.js v22.18.0\n')!;
    expect(json.exception).toBe('SyntaxError: Unexpected end of JSON input');
    expect(json.raised).toMatchObject({ file: '/x.mjs', line: 3, code: 'throw err' });
    expect(json.frames).toEqual([{ file: '<anonymous>', line: null, column: null, fn: 'JSON.parse', code: null, own: false }]);
    const injected = parseTraceback("ShadowlapInjectedFailure [TimeoutError]: get_forecast timed out\n    at call (file:///sdk.js:274:27) {\n  tool: 'get_forecast'\n}\n")!;
    expect(injected).toMatchObject({ exception: 'ShadowlapInjectedFailure [TimeoutError]: get_forecast timed out', type: 'ShadowlapInjectedFailure', message: 'get_forecast timed out' });
    expect(injected.frames).toEqual([{ file: '/sdk.js', line: 274, column: 27, fn: 'call', code: null, own: true }]);
  });

  it('reads a code in brackets as part of the line, not of the type', () => {
    expect(parseTraceback('TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string\n    at open (node:fs:573:10)\n')).toMatchObject({ type: 'TypeError', message: 'The "path" argument must be of type string', raised: null });
  });
});

describe('no traceback', () => {
  it('falls back to the last line that says something, as the CLI\'s chaos report reads it', () => {
    expect(parseTraceback('done, but exiting 2\n')).toEqual({ runtime: null, exception: 'done, but exiting 2', type: null, message: null, raised: null, frames: [], cut: false });
    expect(parseTraceback('ValueError: no refund for A-1042\nretrying once\ngave up\n')).toMatchObject({ exception: 'ValueError: no refund for A-1042', type: 'ValueError' });
    expect(parseTraceback('gave up\n\nNode.js v22.11.0\n(Use `node --trace-warnings ...` to show where the warning was created)\n')!.exception).toBe('gave up');
  });

  it('is null when nothing is left but shadowlap\'s own lines', () => {
    expect(parseTraceback('[shadowlap] replaying run X\n')).toBeNull();
    expect(parseTraceback('')).toBeNull();
    expect(parseTraceback('\n\n  \n[shadowlap] stopped after 30s\n')).toBeNull();
  });
});

describe('the tail the store keeps', () => {
  it('reads the last of a long output, as the store would have kept it', () => {
    const t = parseTraceback(`${'noise line\n'.repeat(2000)}${MOCK}`)!;
    expect(t.exception).toBe("KeyError: 'total'");
    expect(parseTraceback(tail(`${'progress\n'.repeat(40)}${PY_SDK_503}`))!.raised).toMatchObject({ fn: 'main' });
  });

  it('knows a library\'s file from the agent\'s', () => {
    expect(['/work/shop/agent.py', 'agent.py', '<string>', 'C:\\work\\shop\\agent.py', '/work/shop/lib/refunds.js'].map(ownFile)).toEqual([true, true, true, true, true]);
    expect(['/srv/.venv/lib/python3.12/site-packages/httpx/_client.py', '/usr/lib/python3/dist-packages/x.py', '/usr/lib/python3.12/json/decoder.py', '<frozen runpy>', '/work/shop/node_modules/openai/core.js', 'node:internal/process/task_queues', 'internal/modules/cjs/loader.js', '<anonymous>'].map(ownFile)).toEqual([false, false, false, false, false, false, false, false]);
  });
});
