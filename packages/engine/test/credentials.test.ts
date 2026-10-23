import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER, credentialFreeHeaders, credentialFreeQuery, credentialFreeResult, credentialParam, rawJsonMember, resultBlob, withoutCredentials } from '../src/http.js';

describe('credentialParam: the one list of credential parameters', () => {
  it('names every credential a service takes in a query or a form, in any case', () => {
    const names = [
      // Azure API Management, as a query parameter and as its header's name.
      'subscription-key',
      'Subscription-Key',
      'Ocp-Apim-Subscription-Key',
      'client_secret',
      'clientSecret',
      'password',
      'PASSWORD',
      'auth',
      'access_token',
      'refresh_token',
      'id_token',
      'sig',
      'signature',
      // AWS presigned URLs.
      'X-Amz-Signature',
      'X-Amz-Credential',
      'X-Amz-Security-Token',
      'x-amz-security-token',
      // Google's signed URLs.
      'X-Goog-Signature',
      'X-Goog-Credential',
      'key',
      'KEY',
      'api-key',
      'api_key',
      'apiKey',
      'APIKey',
      'apikey',
      'x-api-key',
      'token',
      'Token',
      'APIToken',
      'accesstoken',
      'client_assertion',
      'code_verifier',
      'password_confirmation',
      'new_password',
      'private_token',
      'user_key',
      'auth_code',
      'device_code',
      'code',
      'jwt',
    ];
    for (const name of names) expect(credentialParam(name), name).toBe(true);
  });

  it('never matches a piece of a word, so a lookup still tells calls apart', () => {
    const names = ['q', 'keyword', 'keywords', 'monkey', 'turkey', 'sort_key', 'idempotency_key', 'partition_key', 'public_key', 'author', 'authors', 'auth_type', 'tokens', 'max_tokens', 'page_token', 'pageToken', 'nextPageToken', 'nextpagetoken', 'client_id', 'key_id', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-Algorithm', 'signed', 'secretary', 'error_code', 'country_code', 'zip_code', 'api-version', 'alt', ''];
    for (const name of names) expect(credentialParam(name), name).toBe(false);
  });

  it('reads a bare key, token or code by its value too: a lookup stays, a credential goes', () => {
    expect(credentialParam('key', 'checkout_v2')).toBe(false);
    expect(credentialParam('key', 'AIzaSyD-live-key-0123456789abcdef')).toBe(true);
    expect(credentialParam('code', 'EUR')).toBe(false);
    expect(credentialParam('code', '4/0AX4XfWh-oauth-code-0123456789')).toBe(true);
    // A name that says what it holds is a credential whatever its value.
    expect(credentialParam('subscription-key', 'x')).toBe(true);
    expect(withoutCredentials('?subscription-key=3f7c0e2a9b&client_secret=s3cr%3Dt&password=hunter2&auth=Zm9v&q=refund')).toBe(`?subscription-key=${CREDENTIAL_PLACEHOLDER}&client_secret=${CREDENTIAL_PLACEHOLDER}&password=${CREDENTIAL_PLACEHOLDER}&auth=${CREDENTIAL_PLACEHOLDER}&q=refund`);
  });
});

describe('a model call\'s query as a recording keeps it', () => {
  it('leaves every credential out, whatever its value, and the rest byte for byte', () => {
    expect(credentialFreeQuery('subscription-key=3f7c0e2a9b&api-version=2024-10-21')).toBe('api-version=2024-10-21');
    expect(credentialFreeQuery('key=short&alt=sse')).toBe('alt=sse');
    expect(credentialFreeQuery('X-Amz-Security-Token=FwoG%2Fabc&X-Amz-Signature=beef&X-Amz-Date=20261023T000000Z')).toBe('X-Amz-Date=20261023T000000Z');
    expect(credentialFreeQuery('q=a%20b+c&flag')).toBe('q=a%20b+c&flag');
    expect(credentialFreeQuery('api%5Fkey=secret')).toBeUndefined();
    expect(credentialFreeQuery('')).toBeUndefined();
  });
});

describe('response headers as a recording keeps them', () => {
  it('keep a credential header with the placeholder for its value, and drop a cookie', () => {
    const headers = { 'content-type': 'application/json', 'X-Subject-Token': 'gAAAAABl-real-token', authorization: 'Bearer echo', 'x-auth-token': 'AUTH_tk0123', 'set-cookie': 'session=secret', 'x-request-id': 'req_1' };
    expect(credentialFreeHeaders(headers)).toEqual({ 'content-type': 'application/json', 'X-Subject-Token': CREDENTIAL_PLACEHOLDER, authorization: CREDENTIAL_PLACEHOLDER, 'x-auth-token': CREDENTIAL_PLACEHOLDER, 'x-request-id': 'req_1' });
    const clean = { 'content-type': 'application/json', 'x-subject-token': CREDENTIAL_PLACEHOLDER };
    expect(credentialFreeHeaders(clean)).toBe(clean);
  });

  it('rewrite a stored result\'s headers and keep its body\'s bytes', () => {
    const body = '{\n  "token": {"expires_at": "2026-10-24T00:00:00Z"},\n  "id": 1234567890123456789, "total": 20.0\n}';
    const blob = resultBlob({ status: 201, headers: { 'content-type': 'application/json', 'x-subject-token': 'gAAAAABl-real-token', 'set-cookie': 'a=b' }, encoding: 'json' }, body);
    const clean = credentialFreeResult(blob)!;
    expect(clean.toString('utf8')).not.toContain('gAAAAABl-real-token');
    expect(clean.toString('utf8')).not.toContain('a=b');
    expect(rawJsonMember(clean.toString('utf8'), ['result', 'body'])).toBe(body);
    expect(JSON.parse(clean.toString('utf8')).result.headers).toEqual({ 'content-type': 'application/json', 'x-subject-token': CREDENTIAL_PLACEHOLDER });
    expect(credentialFreeResult(clean)).toBeNull();
    // A text body, and a result that is no captured call's, as they are.
    const text = Buffer.from(JSON.stringify({ result: { status: 200, headers: { authorization: 'Basic eDp5' }, body: 'ok', encoding: 'text' } }));
    expect(JSON.parse(credentialFreeResult(text)!.toString('utf8'))).toEqual({ result: { status: 200, headers: { authorization: CREDENTIAL_PLACEHOLDER }, body: 'ok', encoding: 'text' } });
    expect(credentialFreeResult(Buffer.from('{"result":{"rows":[1]}}'))).toBeNull();
    expect(credentialFreeResult(Buffer.from('not json'))).toBeNull();
  });
});
