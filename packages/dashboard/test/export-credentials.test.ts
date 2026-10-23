import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resultBlob, storeApiRequest, Store } from '@shadowlap/engine';
import { exportHtml } from '../src/index.js';

/**
 * An HTML copy (`export html`, the dashboard's download, every share link) of a run whose recording
 * kept credentials an earlier version didn't know to mask: none of them is in the file, with the
 * project's redaction rules or with none.
 */

let uiDir: string;
beforeAll(() => {
  // A stand-in for the built UI, so the test does not depend on a bundle.
  uiDir = mkdtempSync(join(tmpdir(), 'sl-export-cred-ui-'));
  mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app { color: red }\n');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(() => rmSync(uiDir, { recursive: true, force: true }));

describe('an HTML copy of a recording that kept credentials', () => {
  it('holds none of them, with no redaction rules too', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } });
    const api = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: 1, ...api, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }), meta: { provider: 'anthropic', query: 'subscription-key=SECRET-APIM-123' }, at: 1 });
    store.appendCallEnd(api, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from('{"content":[]}')), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json', authorization: 'Bearer TOKEN-ECHOED' } }, at: 2 });
    const tool = { kind: 'tool' as const, name: 'POST keystone.example.com/v3/auth/tokens', fingerprint: 'b'.repeat(64), occurrence: 1 };
    const request = store.putJson({ args: { method: 'POST', url: 'https://keystone.example.com/v3/auth/tokens?password=HUNTER2', encoding: 'text', body: 'client_secret=SECRET-FORM' } });
    const result = store.putBlob(resultBlob({ status: 201, headers: { 'x-subject-token': 'KEYSTONE-TOKEN', 'content-type': 'application/json' }, encoding: 'json' }, '{"ok":true}'));
    store.appendCallStart({ runId: run.runId, callNo: 2, ...tool, origin: 'live', effect: 'read', requestRef: request, meta: { http: 'keystone.example.com' }, at: 3 });
    store.appendCallEnd(tool, { runId: run.runId, callNo: 2, attempt: 0, responseRef: result, outcome: 'ok', meta: {}, at: 4 });
    store.endRun(run.runId, 'completed');
    for (const redact of [undefined, [{ pattern: 'email', replace: '<EMAIL>' }]]) {
      const { html, redacted } = exportHtml({ store, runIds: [run.runId], uiDir, version: 'test', ...(redact ? { redact } : {}) });
      expect(redacted).toBe(redact !== undefined);
      for (const secret of ['SECRET-APIM-123', 'TOKEN-ECHOED', 'HUNTER2', 'SECRET-FORM', 'KEYSTONE-TOKEN']) expect(html, secret).not.toContain(secret);
      // The call is still there to read, its headers named.
      expect(html).toContain('x-subject-token');
    }
    store.close();
  });
});
