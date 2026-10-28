import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER as C, credentialFreeBody, credentialFreeHeaders, credentialParam, maskJsonCredentials, maskJsonTextCredentials, maskLocation, maskMultipartBytes, maskTextCredentials } from '../src/http.js';

/**
 * The shapes and headers the review found a credential still left by: a token in a URL inside a
 * string, JSON inside a string or a form value, arrays and objects under a credential member, a
 * GraphQL query's inline arguments, a connection string, a JWT under any name; the URLs that
 * `content-location`, `link`, `refresh` and `x-original-url` name, a header named `*-authorization`,
 * `x-amzn-oidc-data`, and the password in a redirect's URL. Its planted values, the rest as sent.
 */

const b64u = (s: string) => Buffer.from(s).toString('base64url');
const jwt = (name: string) => `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify({ sub: `SLSEC_${name}_q1w2e3`, iat: 1 }))}.c2lnU0xTRUM`;

describe('a credential inside a string of a body', () => {
  it('is masked in a URL, in JSON inside a string, and twice inside, the rest of the string as sent', () => {
    const body = {
      paging: { next: 'https://api.example.com/items?page=2&access_token=SLSEC_SS_PAGINGNEXT_q1w2e3', prev: '/items?page=1#access_token=SLSEC_SS_FRAGMENT_q1w2e3' },
      payload: JSON.stringify({ api_key: 'SLSEC_SS_PAYLOADKEY_q1w2e3', q: 'refund' }),
      double: JSON.stringify(JSON.stringify({ password: 'SLSEC_SS_DOUBLEPWD_q1w2e3' })),
      signed_url: 'https://s3.example.invalid/o?X-Amz-Date=20261026&X-Amz-Signature=SLSEC_SS_SIGNEDURL_q1w2',
    };
    const masked = maskJsonCredentials(body) as typeof body;
    expect(JSON.stringify(masked)).not.toMatch(/SLSEC_SS_/);
    expect(masked.paging.next).toBe(`https://api.example.com/items?page=2&access_token=${C}`);
    expect(masked.paging.prev).toBe(`/items?page=1#access_token=${C}`);
    expect(JSON.parse(masked.payload)).toEqual({ api_key: C, q: 'refund' });
    expect(JSON.parse(JSON.parse(masked.double) as string)).toEqual({ password: C });
    expect(masked.signed_url).toBe(`https://s3.example.invalid/o?X-Amz-Date=20261026&X-Amz-Signature=${C}`);
    // The text a recording keeps reads the same way, every other byte as sent.
    expect(maskJsonTextCredentials(JSON.stringify(body))).toBe(JSON.stringify(masked));
    expect(maskJsonTextCredentials(JSON.stringify(masked))).toBeNull();
  });

  it('is masked through every string under a credential member, a JWT whatever its member, and a password in a connection string', () => {
    const body = {
      api_keys: ['SLSEC_SS_APIKEYSARR_q1w2'],
      recovery_codes: ['SLSEC_SS_RECOVERY_q1w2'],
      objSecret: { client_secret: { value: 'SLSEC_SS_OBJSECRET_q1w2', note: { deeper: 'SLSEC_SS_OBJDEEP_q1w2' } } },
      cookies: [{ name: 'sid', value: 'SLSEC_SS_COOKIESARR_q1w2' }],
      cookie: 'sid=SLSEC_SS_COOKIEFIELD_q1w2',
      headers: { Cookie: 'sid=SLSEC_SS_HDRCOOKIE_q1w2', 'X-Upstream-Authorization': 'Bearer SLSEC_SS_HDRUPSTREAM_q1w2' },
      mfa_code: 'SLSEC_SS_MFACODE_q1w2',
      otp: 'SLSEC_SS_OTP_q1w2',
      SAMLResponse: Buffer.from('<saml:Assertion>SLSEC_SS_SAMLRESPONSE_q1w2</saml:Assertion>').toString('base64'),
      data: jwt('SS_DATA'),
      value: jwt('SS_VALUE'),
      result: [jwt('SS_RESULT')],
      connection_string: 'postgres://app:SLSEC_SS_CONNSTRPASS_q1w2@db.internal:5432/app',
      url: 'https://user:SLSEC_SS_URLUSERINFO_q1w2@files.example.invalid/x',
      connectionString: 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=SLSEC_SS_AZACCOUNTKEY_q1w2==;EndpointSuffix=core.windows.net',
    };
    const masked = maskJsonCredentials(body) as Record<string, unknown>;
    // Every planted value is gone, the scanner's way of finding one (in base64 too) included.
    const seen = JSON.stringify(masked);
    expect(seen).not.toMatch(/SLSEC_SS_/);
    expect(Buffer.from(String(masked.SAMLResponse), 'base64').toString('utf8')).not.toMatch(/SLSEC/);
    expect(masked).toMatchObject({
      api_keys: [C],
      cookies: [{ name: C, value: C }],
      connection_string: `postgres://app:${C}@db.internal:5432/app`,
      url: `https://user:${C}@files.example.invalid/x`,
      connectionString: `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${C};EndpointSuffix=core.windows.net`,
    });
  });

  it('is masked in a GraphQL query’s inline arguments, in JSON and sent as GraphQL itself', () => {
    const json = { query: 'mutation { login(password: "SLSEC_SS_INLINEPWD_q1w2e3", apiKey: "SLSEC_SS_INLINEKEY_q1w2e3", user: "ops") { token } }', variables: { input: { password: 'SLSEC_SS_VARPWD_q1w2e3' } } };
    const masked = maskJsonCredentials(json) as typeof json;
    expect(masked.query).toBe(`mutation { login(password: "${C}", apiKey: "${C}", user: "ops") { token } }`);
    expect(masked.variables.input.password).toBe(C);
    expect(maskTextCredentials('mutation { login(password: "SLSEC_SS_RAWPWD_q1w2e3") { token } }')).toBe(`mutation { login(password: "${C}") { token } }`);
  });

  it('is masked in a form value that holds JSON, encoded or not, the form as sent', () => {
    const encoded = `grant_type=x&data=${encodeURIComponent(JSON.stringify({ api_key: 'SLSEC_SS_FORMJSON_q1w2e3', password: 'SLSEC_SS_FORMJSONPWD_q1w2e3', q: 'refund' }))}`;
    const stored = credentialFreeBody({ body: encoded, encoding: 'text' }).body;
    expect(stored).toBe(`grant_type=x&data=${encodeURIComponent(JSON.stringify({ api_key: C, password: C, q: 'refund' }))}`);
    expect(maskTextCredentials('data={"api_key":"SLSEC_SS_FORMRAWJSON_q1w2e3"}&x=1')).not.toMatch(/SLSEC/);
  });

  it('leaves alone what reads as no credential: counts, cursors, a lookup, a plain URL or query, booleans', () => {
    const body = { usage: { input_tokens: 3, output_tokens: 1 }, max_tokens: 1024, page_token: 'CAEQAA', sort_key: 'created_at', error_code: 'E42', cookie_consent: true, cookie_banner: 'shown', next: 'https://api.example.com/items?page=2', query: 'refund policy', tokens: ['a', 'b'] };
    expect(maskJsonCredentials(body)).toBe(body);
    for (const name of ['input_tokens', 'max_tokens', 'tokens', 'page_token', 'cookie_banner', 'error_codes', 'sort_keys']) expect(credentialParam(name, 'SLSEC_SS_NOT_q1w2e3x'), name).toBe(false);
    for (const name of ['api_keys', 'recovery_codes', 'refresh_tokens', 'client_secrets', 'cookies', 'otp', 'mfa_code', 'SAMLResponse', 'x-upstream-authorization']) expect(credentialParam(name, 'SLSEC_SS_YES_q1w2e3x'), name).toBe(true);
  });
});

describe('a response header', () => {
  it('names a URL masked in place, carries a token whole, or is one the review named', () => {
    const headers = {
      'x-amzn-oidc-data': jwt('SH_AMZNOIDCDATA'),
      'x-upstream-authorization': 'Bearer SLSEC_SH_UPSTREAMAUTHZ_q1w2',
      'x-original-url': '/cb?access_token=SLSEC_SH_ORIGURL_q1w2&x=1',
      'content-location': 'https://cdn.example.invalid/file?X-Amz-Signature=SLSEC_SH_CONTENTLOC_q1w2&X-Amz-Expires=60',
      link: '<https://api.example.invalid/next?access_token=SLSEC_SH_LINKHDR_q1w2&page=2>; rel="next", <https://api.example.invalid/first?page=1>; rel="first"',
      refresh: '0; url=https://app.example.invalid/cb?code=SLSEC_SH_REFRESHHDR_q1w2e3&state=s1',
      'x-identity': jwt('SH_JWTVALUE'),
      'x-request-id': 'req_0123456789abcdef',
    };
    const kept = credentialFreeHeaders(headers);
    expect(JSON.stringify(kept)).not.toMatch(/SLSEC_SH_/);
    expect(Buffer.from(JSON.stringify(kept)).toString('base64url')).not.toContain(b64u('SLSEC'));
    expect(kept).toEqual({
      'x-amzn-oidc-data': C,
      'x-upstream-authorization': C,
      'x-original-url': `/cb?access_token=${C}&x=1`,
      'content-location': `https://cdn.example.invalid/file?X-Amz-Signature=${C}&X-Amz-Expires=60`,
      link: `<https://api.example.invalid/next?access_token=${C}&page=2>; rel="next", <https://api.example.invalid/first?page=1>; rel="first"`,
      refresh: `0; url=https://app.example.invalid/cb?code=${C}&state=s1`,
      'x-identity': C,
      'x-request-id': 'req_0123456789abcdef',
    });
    expect(credentialFreeHeaders(kept)).toBe(kept);
    // A session handed back in a header of its own, and each challenge of a value that holds several.
    expect(credentialFreeHeaders({ 'x-session': 'SLSEC_SH_XSESSION_q1w2e3r4', 'x-session-id': 'run-42', 'www-authenticate': 'Negotiate SLSEC_SH_NEGOTIATE_q1w2e3==, Basic realm="x"', 'proxy-authenticate': 'NTLM TlRMTVNTUAACSLSEC_SH_NTLM_q1w2, Negotiate' })).toEqual({
      'x-session': C,
      'x-session-id': 'run-42',
      'www-authenticate': `Negotiate ${C}, Basic realm="x"`,
      'proxy-authenticate': `NTLM ${C}, Negotiate`,
    });
  });

  it('keeps no password in a redirect’s URL, nor a session in its path, nor a token in a URL it carries', () => {
    expect(maskLocation('https://svc:SLSEC_SH_USERINFOPASS_q1w2@files.example.invalid/x')).toBe(`https://svc:${C}@files.example.invalid/x`);
    expect(maskLocation('https://app.example.invalid/cb;jsessionid=SLSEC_SH_JSESSION_q1w2e3?x=1')).toBe(`https://app.example.invalid/cb;jsessionid=${C}?x=1`);
    const nested = maskLocation('https://app.example.invalid/cb?state=1&code=SLSEC_SH_CODE_q1w2e3r4&next=%2Fdone%3Faccess_token%3DSLSEC_SH_NESTEDNEXT_q1w2');
    expect(nested).toBe(`https://app.example.invalid/cb?state=1&code=${C}&next=${encodeURIComponent(`/done?access_token=${C}`)}`);
    expect(maskLocation(nested)).toBe(nested);
    expect(maskLocation('https://app.example.invalid/done?page=2')).toBe('https://app.example.invalid/done?page=2');
  });
});

describe('a multipart body’s parts', () => {
  const form = (parts: string[]) => Buffer.from(`${parts.map((p) => `--b1\r\n${p}\r\n`).join('')}--b1--\r\n`, 'utf8');
  it('are masked by a name given as name*, a credential file, a part header, and a JSON part', () => {
    const body = form([
      "Content-Disposition: form-data; name*=UTF-8''api_key\r\n\r\nSLSEC_SM_NAMESTAR_q1w2e3",
      'Content-Disposition: form-data; name="api_key"; filename="key.txt"\r\nContent-Type: text/plain\r\n\r\nSLSEC_SM_FILEKEY_q1w2e3',
      'Content-Disposition: form-data; name="note"\r\nX-Api-Key: SLSEC_SM_PARTHDR_q1w2e3\r\n\r\nhello',
      'Content-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{"api_key":"SLSEC_SM_JSONPART_q1w2e3","name":"f"}',
      'Content-Disposition: form-data; name="upload"; filename="sa.json"\r\nContent-Type: application/json\r\n\r\n{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nSLSEC_SM_SAKEY_q1w2e3\\n-----END PRIVATE KEY-----"}',
      'Content-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nplain file',
    ]);
    const masked = maskMultipartBytes(body)!.toString('utf8');
    expect(masked).not.toMatch(/SLSEC_SM_/);
    expect(masked).toContain(`X-Api-Key: ${C}\r\n\r\nhello`);
    expect(masked).toContain(`{"api_key":"${C}","name":"f"}`);
    expect(masked).toContain('filename="a.txt"\r\n\r\nplain file');
    expect(maskMultipartBytes(Buffer.from(masked))).toBeNull();
  });
});
