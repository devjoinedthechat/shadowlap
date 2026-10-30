import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER, credentialFreeBody, credentialFreeHeaders, credentialFreeQuery, credentialFreeRequest, credentialFreeResult, credentialHeader, credentialParam, maskChallenge, maskJsonCredentials, maskJsonTextCredentials, maskLocation, maskMultipartBytes, maskTextCredentials, rawJsonMember, resultBlob, withoutCredentials, withoutStoredCredentials, withSecretNames } from '../src/http.js';
import { parseMultipart } from '../src/multipart.js';

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

describe('a name with a password or secret word in it', () => {
  const C = CREDENTIAL_PLACEHOLDER;
  // Each holds a secret by its name. Every value is invented.
  const SECRETS: Record<string, string> = {
    // AWS Secrets Manager's secret itself.
    SecretString: '{"username":"app","password":"EXAMPLE-pw-0123"}',
    SecretBinary: 'RVhBTVBMRS1iaW5hcnktMDEyMw==',
    secret_value: 'EXAMPLE-value-0123',
    secretValue: 'EXAMPLE-value-4567',
    secret_data: 'EXAMPLE-data-0123',
    secret_text: 'EXAMPLE-text-0123',
    secret_key: 'EXAMPLE-key-0123',
    // Vault AppRole's secret_id signs in, though AWS's SecretId names a secret: an id is taken for one.
    secret_id: 'EXAMPLE-0000-1111-2222',
    SecretId: 'prod/db',
    secrets: 'EXAMPLE-one',
    client_secret: 'EXAMPLE-client-0123',
    new_password: 'EXAMPLE-pw-8901',
    password_confirmation: 'EXAMPLE-pw-8901',
    password_hash: '$2b$12$EXAMPLEhashEXAMPLEhashEXAMPLE',
    passphrase_value: 'EXAMPLE pass phrase',
    // A hint is often the password itself; a reset link carries its token; a secret URL is the secret.
    password_hint: 'EXAMPLE-pw-4567',
    user_password_hint: 'EXAMPLE-pw-4567',
    password_reset_url: 'https://app.example.com/reset/EXAMPLE0123456789abcdef',
    secret_url: 'https://calendar.example.com/ical/private-EXAMPLE0123/basic.ics',
    password_reset_token: 'EXAMPLE-reset-0123',
    // Only the last words count: these end in what holds the secret.
    secret_rotation_value: 'EXAMPLE-rotated-0123',
    secret_name_value: 'EXAMPLE-0123',
    SecretList: 'EXAMPLE-list',
  };
  // Each names or describes a secret, and is a lookup's identity.
  const NAMES: Record<string, string> = {
    secret_name: 'prod/db',
    SecretName: 'prod/cache',
    secretName: 'db-credentials',
    secret_names: 'prod/db',
    secret_arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf',
    SecretARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf',
    secret_version: 'v3',
    SecretVersionId: 'EXAMPLE1-90ab-cdef-fedc-ba987EXAMPLE',
    secret_version_stage: 'AWSCURRENT',
    SecretVersionStages: 'AWSPENDING',
    password_policy: 'min 12, one symbol',
    PasswordPolicy: 'strict',
    password_reset_email: 'ops@example.com',
    passwordless_email: 'ops@example.com',
    minimum_password_length: '12',
    secret_count: '3',
    secret_type: 'SecureString',
    secret_description: 'the reporting database',
    secret_tags: 'team:data',
    secret_rotation: 'rate(30 days)',
    secret_rotation_enabled: 'true',
    secret_rotation_rules: 'cron(0 4 1 * ? *)',
    password_rotation_days: '90',
    password_expires_at: '2027-01-01T00:00:00Z',
    password_created_at: '2026-01-01T00:00:00Z',
    secret_updated_at: '2026-10-01T00:00:00Z',
    secret_last_rotated_date: '2026-10-01',
    password_last_changed_date: '2026-09-01',
  };
  const masked = (names: Record<string, string>) => Object.fromEntries(Object.keys(names).map((k) => [k, C]));

  it('is a credential whatever its value, unless its last words name or describe the secret', () => {
    for (const [name, value] of Object.entries(SECRETS)) expect(credentialParam(name, value), name).toBe(true);
    for (const [name, value] of Object.entries(NAMES)) expect(credentialParam(name, value), name).toBe(false);
  });

  it('keeps what names or describes a secret in each shape a body is read by, and masks the secret', () => {
    expect(maskJsonCredentials({ ...SECRETS, ...NAMES })).toEqual({ ...masked(SECRETS), ...NAMES });
    // An object or a list under a name that describes one is read by its own names.
    const described = { secret_tags: [{ Key: 'team', Value: 'data' }], PasswordPolicy: { MinimumPasswordLength: 12, RequireSymbols: true }, secret_rotation_rules: { ScheduleExpression: 'rate(30 days)' } };
    expect(maskJsonCredentials(described)).toBe(described);
    expect(maskJsonCredentials({ secret: { name: 'prod/db' }, SecretList: [{ Name: 'prod/db' }] })).toEqual({ secret: { name: C }, SecretList: [{ Name: C }] });
    expect(withoutCredentials('?secret_name=prod%2Fdb&secret_arn=arn%3Aaws&SecretString=EXAMPLE-0123')).toBe(`?secret_name=prod%2Fdb&secret_arn=arn%3Aaws&SecretString=${C}`);
    expect(maskTextCredentials('<Describe><SecretName>prod/db</SecretName><SecretString>EXAMPLE-0123</SecretString></Describe>')).toBe('<Describe><SecretName>prod/db</SecretName><SecretString>&lt;CREDENTIAL&gt;</SecretString></Describe>');
    expect(maskTextCredentials('secret_name: prod/db\nsecret_value: EXAMPLE-0123\n')).toBe(`secret_name: prod/db\nsecret_value: ${C}\n`);
    expect(maskTextCredentials('Server=db;Password Policy=strict;Password=EXAMPLE-0123;')).toBe(`Server=db;Password Policy=strict;Password=${C};`);
  });

  it('is a credential when read by its name alone, so a model call’s query leaves it out as before', () => {
    expect(credentialParam('secret_name')).toBe(true);
    expect(credentialFreeQuery('secret_name=prod%2Fdb&alt=sse')).toBe('alt=sse');
  });

  it('is masked as a recording made before such names were kept masked it, for a replay of one to match it', () => {
    expect(withSecretNames(false, () => maskJsonCredentials({ ...SECRETS, ...NAMES }))).toEqual({ ...masked(SECRETS), ...masked(NAMES) });
    expect(withSecretNames(false, () => withoutCredentials('?secret_arn=arn%3Aaws&q=1'))).toBe(`?secret_arn=${C}&q=1`);
    expect(withSecretNames(false, () => withSecretNames(true, () => credentialParam('secret_name', 'prod/db')))).toBe(false);
    // The rule is as it was once the masking ends, however it ends.
    expect(() =>
      withSecretNames(false, () => {
        throw new Error('stopped');
      }),
    ).toThrow('stopped');
    expect(credentialParam('secret_name', 'prod/db')).toBe(false);
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

  it('mask the tokens the review’s list names, by their name or the value in them, and keep what a client needs', () => {
    // The reviewer's planted response headers (harness/servers.mjs): each token gone, the rest kept.
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer SLSEC_RH_AUTHZ',
      'proxy-authorization': 'Basic SLSEC_RH_PROXYAUTHZ',
      'x-subject-token': 'SLSEC_RH_SUBJECT',
      'x-auth-token': 'SLSEC_RH_XAUTH',
      'x-access-token': 'SLSEC_RH_XACCESS',
      'x-refresh-token': 'SLSEC_RH_XREFRESH',
      'x-csrf-token': 'SLSEC_RH_CSRF',
      'x-vault-token': 'SLSEC_RH_VAULT',
      'private-token': 'SLSEC_RH_GITLAB',
      'x-amz-security-token': 'SLSEC_RH_AMZTOKEN',
      'x-goog-api-key': 'SLSEC_RH_GOOGKEY',
      'api-key': 'SLSEC_RH_APIKEY',
      'x-api-key': 'SLSEC_RH_XAPIKEY',
      location: 'https://app.example.com/callback?code=SLSEC_RH_LOCCODE_0123456789&state=xyz#access_token=SLSEC_RH_LOCFRAG_0123456789',
      'www-authenticate': 'Bearer realm="api", error="invalid_token", token="SLSEC_RH_WWWAUTH_0123456789"',
      'set-cookie': 'session=SLSEC_RH_COOKIE',
      'anthropic-organization-id': 'SLSEC_RH_ORGID',
      'openai-organization': 'SLSEC_RH_OAIORG',
      'openai-project': 'SLSEC_RH_OAIPROJ',
      'x-request-id': 'req_1',
    };
    const out = credentialFreeHeaders(headers);
    // No planted token survives, in any header.
    expect(JSON.stringify(out)).not.toMatch(/SLSEC_RH_/);
    // The account-naming and cookie-setting headers are gone; a request id stays.
    for (const gone of ['set-cookie', 'anthropic-organization-id', 'openai-organization', 'openai-project']) expect(out).not.toHaveProperty(gone);
    expect(out['x-request-id']).toBe('req_1');
    // A redirect keeps what a client needs (state), the challenge its scheme, realm and error.
    expect(out.location).toBe(`https://app.example.com/callback?code=${CREDENTIAL_PLACEHOLDER}&state=xyz#access_token=${CREDENTIAL_PLACEHOLDER}`);
    expect(out['www-authenticate']).toBe(`Bearer realm="api", error="invalid_token", token="${CREDENTIAL_PLACEHOLDER}"`);
  });

  it('read a service’s own *-token, *-key and *-secret headers as credentials, and leave a page cursor and a content header alone', () => {
    expect(credentialHeader('x-gitlab-token')).toBe(true);
    expect(credentialHeader('x-session-token')).toBe(true);
    expect(credentialHeader('x-client-secret')).toBe(true);
    expect(credentialHeader('x-amz-security-token')).toBe(true);
    expect(credentialHeader('location')).toBe(false);
    expect(credentialHeader('www-authenticate')).toBe(false);
    expect(credentialHeader('x-next-page-token')).toBe(false);
    expect(credentialHeader('content-type')).toBe(false);
    expect(credentialHeader('x-request-id')).toBe(false);
  });

  it('keep a count or a limit of tokens and Azure’s model session as sent, whatever their value reads as', () => {
    // What langchain-aws reads with int(headers.get("x-amzn-bedrock-input-token-count", 0)), and the rate limits' families.
    const kept = {
      'x-amzn-bedrock-input-token-count': '12',
      'x-amzn-bedrock-output-token-count': '5',
      'x-amzn-bedrock-cache-read-input-token-count': '0',
      'x-amzn-bedrock-cache-write-input-token-count': '1024',
      'anthropic-ratelimit-tokens-limit': '480000',
      'anthropic-ratelimit-input-tokens-remaining': '399000',
      'anthropic-ratelimit-output-tokens-reset': '2026-10-30T12:00:00Z',
      'x-ratelimit-limit-tokens': '150000',
      'x-ratelimit-remaining-tokens': '149984',
      'x-ratelimit-reset-tokens': '6m0s',
      'x-tokens-used': '17',
      // A count's word after the token word, whatever the value reads as: a time.
      'x-gateway-token-reset': '2026-10-30T12:00:00.125+01:00',
      // Azure's routing to the deployment's session that served the call: it signs nobody in.
      'azureml-model-session': 'd065-20240606224238',
    };
    expect(credentialFreeHeaders(kept)).toBe(kept);
    expect(credentialHeader('x-amzn-bedrock-input-token-count', '12')).toBe(false);
    expect(credentialHeader('azureml-model-session', 'd065-20240606224238')).toBe(false);
    // Read by its name alone, with no value to read, one is taken for a credential.
    expect(credentialHeader('x-amzn-bedrock-input-token-count')).toBe(true);
    expect(credentialHeader('azureml-model-session')).toBe(true);
  });

  it('mask a header that holds a token whatever counting word it has, and a count whose value reads as a key or a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJFWEFNUExFIn0.c2lnbmF0dXJlLWV4YW1wbGU';
    const headers = {
      'x-auth-token': 'EXAMPLE-auth-0123',
      'x-amz-security-token': 'EXAMPLE-sts-0123',
      'x-session-token-raw': 'EXAMPLE-raw-0123',
      'x-session': 'EXAMPLE-session',
      'x-gateway-session': 'EXAMPLE-gw-session',
      'x-gateway-auth': 'EXAMPLE-gw-auth',
      // A password reset's token: a count's word before it, but no rate limit's name.
      'x-reset-token': 'EXAMPLE-reset-0123',
      'x-password-reset-token': 'EXAMPLE-reset-4567',
      // A count's word that doesn't end the name: what it names is the key, or the secret.
      'x-token-limit-key': 'EXAMPLE-limit-key',
      'x-token-count-secret': 'EXAMPLE-count-secret',
      // A count or a session named as one whose value is a key or a JWT.
      'x-amzn-bedrock-input-token-count': 'sk-test-EXAMPLE0123456789abcdef',
      'x-amzn-bedrock-output-token-count': jwt,
      'azureml-model-session': `Bearer ${jwt}`,
      'x-gateway-token-reset': 'ghp_EXAMPLE0123456789abcdefABCDEF',
    };
    expect(credentialFreeHeaders(headers)).toEqual(Object.fromEntries(Object.keys(headers).map((k) => [k, CREDENTIAL_PLACEHOLDER])));
  });

  it('mask a Negotiate token68 blob but leave a plain redirect and a bare realm alone', () => {
    expect(maskChallenge('Negotiate oYG3MIG0oAMKAQWhAwoBAKKBqw==')).toBe(`Negotiate ${CREDENTIAL_PLACEHOLDER}`);
    expect(maskChallenge('Basic realm="corp"')).toBe('Basic realm="corp"');
    expect(maskLocation('/dashboard?next=/home')).toBe('/dashboard?next=/home');
    expect(maskLocation('https://example.com/cb#id_token=aaaa.bbbb.cccc&token_type=Bearer')).toBe(`https://example.com/cb#id_token=${CREDENTIAL_PLACEHOLDER}&token_type=Bearer`);
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

/** A multipart/form-data body as a client writes one, with a fixed boundary: an `api_key` field, a note and a file. */
function form(apiKey: string, file: Buffer | string = 'hello'): Buffer {
  const b = '----shadowlap0123456789';
  return Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="api_key"\r\n\r\n${apiKey}\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="note"\r\n\r\nrefund policy\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    typeof file === 'string' ? Buffer.from(file) : file,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
}

describe('credentials in a captured body', () => {
  it('are masked in a JSON body by key, at any depth, and only strings: the review’s request body among them', () => {
    const body = { api_key: 'tvly-SLSEC_TJ_APIKEY_0123456789', query: 'refund', password: 'SLSEC_TJ_PASSWORD_0123', client_secret: 'SLSEC_TJ_CLIENTSECRET_0123', page_token: 'next-2', nested: [{ id_token: 'eyJhbGciOi.SECRET.sig', count: 3 }], code: 'US', key: 'checkout_v2' };
    const masked = maskJsonCredentials(body) as typeof body;
    expect(JSON.stringify(masked)).not.toMatch(/SLSEC_|SECRET/);
    expect(masked).toEqual({ ...body, api_key: CREDENTIAL_PLACEHOLDER, password: CREDENTIAL_PLACEHOLDER, client_secret: CREDENTIAL_PLACEHOLDER, nested: [{ id_token: CREDENTIAL_PLACEHOLDER, count: 3 }] });
    // A page token, a country code and a lookup key stay: a bare code or key is masked only when its value reads as a credential.
    expect([masked.page_token, masked.code, masked.key]).toEqual(['next-2', 'US', 'checkout_v2']);
    // Masked again, nothing changes: the same object.
    expect(maskJsonCredentials(masked)).toBe(masked);
    expect(maskJsonCredentials({ q: 'refund' })).toEqual({ q: 'refund' });
  });

  it('are masked in a JSON response body in place, every other byte as the service sent it', () => {
    const text = '{\n  "access_token": "SLSEC_RB_ACCESSTOKEN_eyJhbGciOiJIUzI1NiJ9",\n  "refresh_token":"SLSEC_RB_REFRESH_0123456789", "token_type": "Bearer", "expires_in": 3600,\n  "id": 1234567890123456789, "total": 20.0, "scope": ["read", "write"], "client": {"client_secret": "cs_SECRET_0123"}\n}';
    const masked = maskJsonTextCredentials(text)!;
    expect(masked).not.toMatch(/SLSEC_|SECRET/);
    expect(masked).toBe(text.replace('"SLSEC_RB_ACCESSTOKEN_eyJhbGciOiJIUzI1NiJ9"', `"${CREDENTIAL_PLACEHOLDER}"`).replace('"SLSEC_RB_REFRESH_0123456789"', `"${CREDENTIAL_PLACEHOLDER}"`).replace('"cs_SECRET_0123"', `"${CREDENTIAL_PLACEHOLDER}"`));
    // The 64-bit id and 20.0 kept as written.
    expect(masked).toContain('"id": 1234567890123456789, "total": 20.0');
    expect(maskJsonTextCredentials(masked)).toBeNull();
    expect(maskJsonTextCredentials('{"ok": true}')).toBeNull();
    expect(maskJsonTextCredentials('not json')).toBeNull();
  });

  it('are masked in a multipart body’s credential fields, files and other fields as they were, the form still a form', () => {
    const raw = form('SLSEC_TM_APIKEY_0123456789');
    const masked = maskMultipartBytes(raw)!;
    expect(masked.toString('utf8')).not.toContain('SLSEC_TM_APIKEY');
    expect(parseMultipart(masked)).toEqual([
      { name: 'api_key', value: CREDENTIAL_PLACEHOLDER },
      { name: 'note', value: 'refund policy' },
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', sha256: parseMultipart(raw)![2].sha256, bytes: 5 },
    ]);
    expect(maskMultipartBytes(masked)).toBeNull();
    // A file under a field whose name only holds a credential's words (`api_key_file`) is left as uploaded.
    const keyFile = Buffer.from(raw.toString('latin1').replace('name="file"; filename="a.txt"', 'name="api_key_file"; filename="key.pem"'), 'latin1');
    expect(maskMultipartBytes(keyFile)!.toString('utf8')).toContain('hello');
    expect(maskMultipartBytes(Buffer.from('not a form'))).toBeNull();
  });

  it('are masked by one rule for a body stored as JSON, text or base64', () => {
    expect(credentialFreeBody({ body: { client_secret: 'cs-SECRET-0123456789', q: 'x' }, encoding: 'json' })).toEqual({ body: { client_secret: CREDENTIAL_PLACEHOLDER, q: 'x' }, encoding: 'json' });
    expect(credentialFreeBody({ body: 'grant_type=client_credentials&client_secret=cs-SECRET', encoding: 'text' })).toEqual({ body: `grant_type=client_credentials&client_secret=${CREDENTIAL_PLACEHOLDER}`, encoding: 'text' });
    expect((credentialFreeBody({ body: form('SLSEC_TM_APIKEY_0123456789').toString('utf8'), encoding: 'text' }).body)).not.toContain('SLSEC_TM_APIKEY');
    // A form whose file is binary is stored as base64.
    const binary = form('SLSEC_TM_APIKEY_0123456789', Buffer.from([0, 159, 146, 150]));
    const b64 = credentialFreeBody({ body: binary.toString('base64'), encoding: 'base64' });
    expect(Buffer.from(b64.body, 'base64').toString('latin1')).not.toContain('SLSEC_TM_APIKEY');
    expect(Buffer.from(b64.body, 'base64').includes(Buffer.from([0, 159, 146, 150]))).toBe(true);
    const plain = { body: 'hello', encoding: 'text' };
    expect(credentialFreeBody(plain)).toBe(plain);
  });

  it('leave every copy without them: a captured request’s JSON and multipart bodies, a response’s JSON and form-encoded bodies', () => {
    const request = Buffer.from(JSON.stringify({ args: { method: 'POST', url: 'http://h/search', body: { api_key: 'tvly-SLSEC_TJ_APIKEY_0123456789', query: 'refund' }, encoding: 'json' } }));
    expect(credentialFreeRequest(request)!.toString('utf8')).not.toContain('SLSEC_TJ_APIKEY');
    expect(withoutStoredCredentials({ method: 'POST', url: 'http://h/u', body: form('SLSEC_TM_APIKEY_0123456789').toString('utf8'), encoding: 'text' })).not.toEqual(expect.objectContaining({ body: expect.stringContaining('SLSEC_TM_APIKEY') }));
    const oauth = '{"access_token": "SLSEC_RB_ACCESSTOKEN_eyJhbGciOiJIUzI1NiJ9", "refresh_token": "SLSEC_RB_REFRESH_0123456789", "token_type": "Bearer", "id": 1234567890123456789}';
    const json = credentialFreeResult(resultBlob({ status: 200, headers: { 'content-type': 'application/json' }, encoding: 'json' }, oauth))!;
    expect(json.toString('utf8')).not.toMatch(/SLSEC_RB_/);
    // The body is as sent but for the tokens: its 64-bit id is still the bytes it was.
    expect(rawJsonMember(json.toString('utf8'), ['result', 'body'])).toContain('"id": 1234567890123456789');
    const text = credentialFreeResult(Buffer.from(JSON.stringify({ result: { status: 200, headers: {}, body: 'session_token=SLSEC_RB_TEXTBODY_0123456789abcdef&expires=3600', encoding: 'text' } })))!;
    expect(JSON.parse(text.toString('utf8')).result.body).toBe(`session_token=${CREDENTIAL_PLACEHOLDER}&expires=3600`);
    // A result with nothing to mask, headers or body, is no copy to make.
    expect(credentialFreeResult(resultBlob({ status: 200, headers: { 'content-type': 'application/json' }, encoding: 'json' }, '{"ok": true}'))).toBeNull();
    expect(credentialFreeResult(json)).toBeNull();
  });
});
