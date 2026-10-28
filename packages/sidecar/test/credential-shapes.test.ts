import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER, credentialFreeRequest, credentialFreeResult, packRun, rawJsonMember, Store, withoutStoredCredentials } from '@shadowlap/engine';
import { decodeBody, storedRequestBody, storedResponseBytes, storedResult, type HttpResult } from '../src/http.js';

/**
 * A captured call's credentials are masked by the shape of its body, whatever its content type said:
 * JSON sent as text (a `fetch` string body, Python's `requests` with `data=json.dumps(…)`) or with no
 * type, JSON behind a byte-order mark, an anti-XSSI prefix or inside a JSONP call, lines of JSON, an
 * event stream, XML, a body that isn't UTF-8. The review's oracle (creds-verify/verify.mjs) first:
 * the same request and response under each content type it tried. Then each shape, the bytes kept
 * but for the values; and the copies of a recording an earlier version made, which kept them.
 */

const BOM = String.fromCharCode(0xfeff);
const tokens = (tag: string) => JSON.stringify({ access_token: `SLSEC_SH_${tag}ACCESS_q1w2e3`, refresh_token: `SLSEC_SH_${tag}REFRESH_q1w2e3`, token_type: 'bearer', expires_in: 3600 });

/** A response stored as the sidecar stores one, from the bytes the service sent and their content type. */
function storeResponse(bytes: Buffer, contentType: string | undefined): { blob: string; result: HttpResult } {
  const result: HttpResult = { status: 200, headers: contentType ? { 'content-type': contentType } : {}, ...decodeBody(bytes, contentType) };
  const blob = storedResult(result, bytes);
  return { blob: blob.toString('utf8'), result: (JSON.parse(blob.toString('utf8')) as { result: HttpResult }).result };
}

/** What a stored body holds, decoded as the replay sends it (base64 read back to its bytes, Latin-1 so each byte shows). */
function served(result: HttpResult, blob: string): string {
  return storedResponseBytes(result, Buffer.from(blob, 'utf8')).toString('latin1');
}

describe('the review’s oracle: one request and one response under each content type', () => {
  it('masks a JSON request body sent as JSON, as text or with no content type', () => {
    const body = Buffer.from(JSON.stringify({ api_key: 'MARK_REQ_KEY', password: 'MARK_REQ_PWD', q: 'x' }));
    for (const contentType of ['application/json', 'text/plain;charset=UTF-8', undefined]) {
      const s = JSON.stringify(storedRequestBody(body, contentType));
      expect(s, String(contentType)).not.toMatch(/MARK_REQ_/);
      expect(s, String(contentType)).toContain('x');
    }
  });

  it('masks a JSON response body served as JSON, as text, as HTML or with no content type', () => {
    const body = Buffer.from(JSON.stringify({ access_token: 'MARK_RESP_ACCESS', refresh_token: 'MARK_RESP_REFRESH', token_type: 'bearer' }));
    for (const contentType of ['application/json', 'text/plain', 'text/html', undefined]) {
      const { blob } = storeResponse(body, contentType);
      expect(blob, String(contentType)).not.toMatch(/MARK_RESP_/);
      expect(blob, String(contentType)).toContain('bearer');
    }
  });
});

describe('a request body by its shape', () => {
  it('masks JSON sent as text, from fetch or from requests, and lines of JSON, the rest as sent', () => {
    const text = '{"client_secret": "SLSEC_SH_CLIENTSECRET_q1w2e3", "grant_type": "client_credentials", "n": 12345678901234567890}';
    for (const contentType of ['text/plain;charset=UTF-8', undefined, 'application/octet-stream']) {
      const s = storedRequestBody(Buffer.from(text), contentType);
      expect(s.encoding).toBe('text');
      expect(s.body).toBe(text.replace('SLSEC_SH_CLIENTSECRET_q1w2e3', CREDENTIAL_PLACEHOLDER));
    }
    const lines = `${JSON.stringify({ api_key: 'SLSEC_SH_NDJSONKEY_q1w2e3' })}\n${JSON.stringify({ password: 'SLSEC_SH_NDJSONPWD_q1w2e3', n: 1 })}\n`;
    expect(storedRequestBody(Buffer.from(lines), 'application/x-ndjson').body).toBe(`{"api_key":"${CREDENTIAL_PLACEHOLDER}"}\n{"password":"${CREDENTIAL_PLACEHOLDER}","n":1}\n`);
  });

  it('masks XML elements and attributes a credential is in, and a multipart body however its boundary and lines are written', () => {
    const soap = '<?xml version="1.0"?><Envelope><Body><Login user="ops"><Password>SLSEC_SH_SOAPPWD_q1w2e3</Password><Note>refund</Note></Login><Token kind="x" secret="SLSEC_SH_ATTRSECRET_q1w2"/></Body></Envelope>';
    const masked = String(storedRequestBody(Buffer.from(soap), 'text/xml').body);
    expect(masked).toBe(soap.replace('SLSEC_SH_SOAPPWD_q1w2e3', '&lt;CREDENTIAL&gt;').replace('SLSEC_SH_ATTRSECRET_q1w2', '&lt;CREDENTIAL&gt;'));
    const parts = (nl: string, boundary: string, preamble = '') => `${preamble}--${boundary}${nl}Content-Disposition: form-data; name="api_key"${nl}${nl}SLSEC_SH_MPKEY_q1w2e3${nl}--${boundary}${nl}Content-Disposition: form-data; name="note"${nl}${nl}hello${nl}--${boundary}--${nl}`;
    for (const [nl, boundary, preamble] of [['\n', 'b1', ''], ['\r\n', 'L'.repeat(75), ''], ['\r\n', 'b@1#x', ''], ['\r\n', 'b1', 'This is the preamble.\r\n']] as const) {
      const body = parts(nl, boundary, preamble);
      const stored = String(storedRequestBody(Buffer.from(body), `multipart/form-data; boundary="${boundary}"`).body);
      expect(stored, JSON.stringify([nl, boundary.length, preamble])).toBe(body.replace('SLSEC_SH_MPKEY_q1w2e3', CREDENTIAL_PLACEHOLDER));
    }
  });

  it('masks a body that isn’t UTF-8, kept as base64, byte for byte but for the value', () => {
    const latin1 = Buffer.from('{"name":"Jos\xe9","password":"SLSEC_SH_LATIN1PWD_q1w2e3"}', 'latin1');
    const s = storedRequestBody(latin1, 'application/json; charset=iso-8859-1');
    expect(s.encoding).toBe('base64');
    expect(Buffer.from(String(s.body), 'base64')).toEqual(Buffer.from(`{"name":"Jos\xe9","password":"${CREDENTIAL_PLACEHOLDER}"}`, 'latin1'));
  });
});

describe('a response body by its shape', () => {
  it('masks JSON behind a byte-order mark, an anti-XSSI prefix or in a JSONP call, the wrapping as sent', () => {
    for (const [wrap, contentType] of [
      [(t: string) => `${BOM}${t}`, 'application/json; charset=utf-8'],
      [(t: string) => `)]}'\n${t}`, 'application/json'],
      [(t: string) => `)]}',\n${t}`, 'application/json'],
      [(t: string) => `while(1);${t}`, 'application/json'],
      [(t: string) => `cb(${t});`, 'application/javascript'],
      [(t: string) => `/**/ jQuery123_456(${t})`, 'text/javascript'],
    ] as const) {
      const sent = wrap(tokens('WRAP'));
      const { blob, result } = storeResponse(Buffer.from(sent), contentType);
      expect(blob, sent.slice(0, 12)).not.toMatch(/SLSEC_SH_/);
      expect(served(result, blob)).toBe(Buffer.from(wrap(JSON.stringify({ access_token: CREDENTIAL_PLACEHOLDER, refresh_token: CREDENTIAL_PLACEHOLDER, token_type: 'bearer', expires_in: 3600 }))).toString('latin1'));
    }
  });

  it('masks lines of JSON and an event stream’s data, line by line, every other line as sent', () => {
    const ndjson = `${tokens('NDA')}\n${tokens('NDB')}\n`;
    expect(storeResponse(Buffer.from(ndjson), 'application/x-ndjson').blob).not.toMatch(/SLSEC_SH_/);
    const sse = 'event: token\ndata: {"access_token":"SLSEC_SH_SSEACCESS_q1w2e3","refresh_token":"SLSEC_SH_SSEREFRESH_q1w2e3"}\n\n: keep-alive\ndata: {"session":{"api_key":"SLSEC_SH_SSEAPIKEY_q1w2e3"}}\n\ndata: [DONE]\n\n';
    const { blob, result } = storeResponse(Buffer.from(sse), 'text/event-stream');
    expect(served(result, blob)).toBe(`event: token\ndata: {"access_token":"${CREDENTIAL_PLACEHOLDER}","refresh_token":"${CREDENTIAL_PLACEHOLDER}"}\n\n: keep-alive\ndata: {"session":{"api_key":"${CREDENTIAL_PLACEHOLDER}"}}\n\ndata: [DONE]\n\n`);
  });

  it('masks an STS answer’s secret key and session token, its key id and expiry as sent', () => {
    const sts = '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASIAEXAMPLEKEYID0001</AccessKeyId><SecretAccessKey>SLSEC_SH_STSSECRET_q1w2e3</SecretAccessKey><SessionToken>SLSEC_SH_STSTOKEN_q1w2e3</SessionToken><Expiration>2026-10-26T12:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>';
    const { blob, result } = storeResponse(Buffer.from(sts), 'text/xml');
    expect(served(result, blob)).toBe(sts.replace('SLSEC_SH_STSSECRET_q1w2e3', '&lt;CREDENTIAL&gt;').replace('SLSEC_SH_STSTOKEN_q1w2e3', '&lt;CREDENTIAL&gt;'));
  });

  it('masks JSON in Latin-1, JSON holding raw bytes, a number of 450 digits and nesting 8,000 deep', () => {
    const latin1 = Buffer.from('{"name":"Jos\xe9","access_token":"SLSEC_SH_LATIN1ACCESS_q1w2e3"}', 'latin1');
    const a = storeResponse(latin1, 'application/json; charset=iso-8859-1');
    expect(a.result.encoding).toBe('base64');
    expect(served(a.result, a.blob)).toBe(`{"name":"Jos\xe9","access_token":"${CREDENTIAL_PLACEHOLDER}"}`);
    const raw = Buffer.concat([Buffer.from('{"blob":"'), Buffer.from([0xff, 0xfe]), Buffer.from('","access_token":"SLSEC_SH_BINARYJSON_q1w2e3"}')]);
    const b = storeResponse(raw, 'application/json');
    expect(served(b.result, b.blob)).toBe(Buffer.concat([Buffer.from('{"blob":"'), Buffer.from([0xff, 0xfe]), Buffer.from(`","access_token":"${CREDENTIAL_PLACEHOLDER}"}`)]).toString('latin1'));
    const big = `{"n":${'7'.repeat(450)},"access_token":"SLSEC_SH_BIGNUM_q1w2e3"}`;
    expect(served(...(Object.values(storeResponse(Buffer.from(big), 'application/json')).reverse() as [HttpResult, string]))).toBe(`{"n":${'7'.repeat(450)},"access_token":"${CREDENTIAL_PLACEHOLDER}"}`);
    // Nested 8,000 deep: masked, kept as its text, which every reader of a recording (a copy, a replay, an HTML report) can hold.
    const deep = `${'['.repeat(8000)}${tokens('DEEP')}${']'.repeat(8000)}`;
    const d = storeResponse(Buffer.from(deep), 'application/json');
    expect(d.blob).not.toMatch(/SLSEC_SH_/);
    expect(d.result.encoding).toBe('text');
    expect(served(d.result, d.blob)).toBe(`${'['.repeat(8000)}${JSON.stringify({ access_token: CREDENTIAL_PLACEHOLDER, refresh_token: CREDENTIAL_PLACEHOLDER, token_type: 'bearer', expires_in: 3600 })}${']'.repeat(8000)}`);
    expect(credentialFreeResult(Buffer.from(d.blob))).toBeNull();
    expect(() => JSON.stringify(d.result)).not.toThrow();
    // A member nested as deep is read where it stands, as a copy and a replay read a stored body.
    expect(rawJsonMember(`{"result":{"status":200,"body":${deep}}}`, ['result', 'body'])).toBe(deep);
  });

  it('leaves a body it can read no credential in as the service sent it', () => {
    for (const [text, contentType] of [
      ['{"ok":true,"name":"refund"}', 'text/plain'],
      ['<html><body><p>token: hello</p></body></html>', 'text/html'],
      ['data: {"text":"hi"}\n\n', 'text/event-stream'],
      ['plain words, no shape at all', 'text/plain'],
    ] as const) {
      const { blob, result } = storeResponse(Buffer.from(text), contentType);
      expect(served(result, blob)).toBe(text);
    }
  });
});

/** Every file under `dir`, read as Latin-1 so a marker in any of them shows. */
function filesText(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? filesText(path) : readFileSync(path).toString('latin1')))
    .join('\n');
}

describe('a recording an earlier version made, which kept them', () => {
  // As it was stored: a text body as sent, and a text response as it came.
  const request = { method: 'POST', url: 'https://auth.example.com/token', body: '{"client_secret":"SLSEC_SH_OLDSECRET_q1w2e3","grant_type":"client_credentials"}', encoding: 'text' as const };
  const response = { result: { status: 200, headers: { 'content-type': 'text/plain' }, body: tokens('OLD'), encoding: 'text' } };

  it('matches a live call again, its body read by the same rule', () => {
    const live = { method: request.method, url: request.url, ...storedRequestBody(Buffer.from(request.body), 'text/plain;charset=UTF-8') };
    expect(withoutStoredCredentials(request)).toEqual(live);
  });

  it('is copied without them: a stored request and result, and a pack', () => {
    expect(credentialFreeRequest(Buffer.from(JSON.stringify({ args: request })))!.toString('utf8')).not.toMatch(/SLSEC_SH_/);
    expect(credentialFreeResult(Buffer.from(JSON.stringify(response)))!.toString('utf8')).not.toMatch(/SLSEC_SH_/);
    // A JSON answer kept as it came, with a number longer than any window: masked, the number as sent.
    const big = Buffer.from(`{"result":{"status":200,"headers":{},"encoding":"json","body":{"n":${'7'.repeat(450)},"access_token":"SLSEC_SH_OLDBIGNUM_q1w2e3"}}}`);
    const bigCopy = credentialFreeResult(big)!.toString('utf8');
    expect(bigCopy).not.toMatch(/SLSEC_SH_/);
    expect(bigCopy).toContain(`"n":${'7'.repeat(450)},`);
    const store = Store.open(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'sl-shapes-pack-'));
    try {
      const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } });
      const tool = { kind: 'tool' as const, name: 'POST auth.example.com/token', fingerprint: 'c'.repeat(64), occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo: 1, ...tool, origin: 'live', effect: 'read', requestRef: store.putJson({ args: request }), meta: { http: 'auth.example.com' }, at: 1 });
      store.appendCallEnd(tool, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from(JSON.stringify(response))), outcome: 'ok', meta: {}, at: 2 });
      store.endRun(run.runId, 'completed');
      packRun(store, run.runId, join(dir, 'pack'));
      expect(filesText(join(dir, 'pack'))).not.toMatch(/SLSEC_SH_/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
