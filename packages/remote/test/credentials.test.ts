import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { awsCredentialProvider, azureAuth, configuredRegion, credentialsHere, parseStoreUrl, resolveAwsCredentials, resolveGoogleToken, type AzureAuth } from '@shadowlap/remote';

/**
 * The user's own credentials, found where each cloud's tools keep them: the AWS chain (environment,
 * profiles, assumed roles, web identity, credential_process, IAM Identity Center, container
 * credentials), Google's Application Default Credentials (a user sign-in, workload identity
 * federation), and Azure's (keys, SAS, a service principal, a federated token). Every token
 * endpoint is a local server here; the home folder is a temporary one.
 */

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

type Route = (seen: Seen) => { status: number; body: string; headers?: Record<string, string> };

let server: Server;
let base: string;
const routes = new Map<string, Route>();
const seen: Seen[] = [];
const home = mkdtempSync(join(tmpdir(), 'sl-creds-'));

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0]!;
      const s: Seen = { method: req.method ?? '', path: req.url ?? '/', headers: req.headers, body };
      seen.push(s);
      const route = routes.get(`${req.method} ${path}`);
      const out = route ? route(s) : { status: 404, body: 'no route' };
      res.writeHead(out.status, out.headers ?? {});
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

function file(rel: string, text: string): string {
  const path = join(home, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const stsAnswer = (id: string, action: string) =>
  `<${action}Response><${action}Result><Credentials><AccessKeyId>${id}</AccessKeyId><SecretAccessKey>secret-${id}</SecretAccessKey><SessionToken>token-${id}</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials></${action}Result></${action}Response>`;

describe('AWS credentials', () => {
  it('takes keys from the environment first', async () => {
    const c = await resolveAwsCredentials({ env: { AWS_ACCESS_KEY_ID: 'AKIDENV', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't', AWS_CREDENTIAL_EXPIRATION: '2030-01-01T00:00:00Z' }, home });
    expect(c).toEqual({ accessKeyId: 'AKIDENV', secretAccessKey: 's', sessionToken: 't', expiresAt: Date.parse('2030-01-01T00:00:00Z'), source: 'AWS_ACCESS_KEY_ID' });
  });

  it('reads a profile from the shared files, and its region', async () => {
    const h = join(home, 'aws-files');
    mkdirSync(join(h, '.aws'), { recursive: true });
    writeFileSync(join(h, '.aws', 'credentials'), '[default]\naws_access_key_id = AKIDDEFAULT\naws_secret_access_key = d\n\n[northwind]\naws_access_key_id=AKIDNORTH ; a comment\naws_secret_access_key=n\n');
    writeFileSync(join(h, '.aws', 'config'), '[default]\nregion = us-west-2\n\n[profile northwind]\nregion = eu-central-1\ns3 =\n  addressing_style = path\n');
    expect((await resolveAwsCredentials({ env: {}, home: h })).accessKeyId).toBe('AKIDDEFAULT');
    const named = await resolveAwsCredentials({ env: { AWS_PROFILE: 'northwind' }, home: h });
    expect(named).toMatchObject({ accessKeyId: 'AKIDNORTH', secretAccessKey: 'n', source: 'AWS profile northwind' });
    // A profile named in the store URL wins over AWS_PROFILE.
    expect((await resolveAwsCredentials({ env: { AWS_PROFILE: 'northwind' }, home: h }, { profile: 'default' })).accessKeyId).toBe('AKIDDEFAULT');
    expect(configuredRegion({ env: { AWS_PROFILE: 'northwind' }, home: h })).toBe('eu-central-1');
    expect(configuredRegion({ env: { AWS_REGION: 'ap-south-1' }, home: h })).toBe('ap-south-1');
    await expect(resolveAwsCredentials({ env: { AWS_PROFILE: 'nobody' }, home: h })).rejects.toThrow('There is no AWS profile named nobody');
  });

  it('assumes a role with a source profile, signing the request to STS', async () => {
    routes.set('POST /', (s) => {
      const form = new URLSearchParams(s.body);
      if (form.get('Action') === 'AssumeRole') {
        expect(s.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDBASE\/\d{8}\/eu-central-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
        expect(form.get('RoleArn')).toBe('arn:aws:iam::123456789012:role/shadowlap');
        expect(form.get('ExternalId')).toBe('ext-1');
        return { status: 200, body: stsAnswer('ASIAROLE', 'AssumeRole') };
      }
      if (form.get('Action') === 'AssumeRoleWithWebIdentity') {
        expect(s.headers.authorization).toBeUndefined();
        expect(form.get('WebIdentityToken')).toBe('oidc-token-from-ci');
        return { status: 200, body: stsAnswer('ASIAWEB', 'AssumeRoleWithWebIdentity') };
      }
      return { status: 400, body: '<ErrorResponse><Error><Code>InvalidAction</Code><Message>no</Message></Error></ErrorResponse>' };
    });
    const h = join(home, 'aws-role');
    mkdirSync(join(h, '.aws'), { recursive: true });
    writeFileSync(join(h, '.aws', 'config'), '[profile base]\naws_access_key_id = AKIDBASE\naws_secret_access_key = b\n\n[profile ci]\nrole_arn = arn:aws:iam::123456789012:role/shadowlap\nsource_profile = base\nexternal_id = ext-1\nregion = eu-central-1\n\n[profile mfa]\nrole_arn = arn:aws:iam::1:role/x\nsource_profile = base\nmfa_serial = arn:aws:iam::1:mfa/me\n');
    const env = { AWS_PROFILE: 'ci', AWS_ENDPOINT_URL_STS: base };
    const role = await resolveAwsCredentials({ env, home: h });
    expect(role).toMatchObject({ accessKeyId: 'ASIAROLE', sessionToken: 'token-ASIAROLE', source: 'AWS profile ci' });
    await expect(resolveAwsCredentials({ env: { ...env, AWS_PROFILE: 'mfa' }, home: h })).rejects.toThrow(/needs an MFA code/);
    // An S3-compatible store has no STS: a role is refused rather than sent somewhere else.
    await expect(resolveAwsCredentials({ env, home: h }, { allowSts: false })).rejects.toThrow(/only AWS can do/);

    const token = file('ci/web-identity-token', 'oidc-token-from-ci\n');
    const web = await resolveAwsCredentials({ env: { AWS_ROLE_ARN: 'arn:aws:iam::1:role/ci', AWS_WEB_IDENTITY_TOKEN_FILE: token, AWS_ENDPOINT_URL_STS: base }, home: join(home, 'none') });
    expect(web).toMatchObject({ accessKeyId: 'ASIAWEB', source: 'web identity (AWS_ROLE_ARN)' });
  });

  it('runs a credential_process and reads its JSON', async () => {
    const script = file('bin/creds.mjs', "console.log(JSON.stringify({ Version: 1, AccessKeyId: 'AKIDPROC', SecretAccessKey: 'p', SessionToken: 'pt', Expiration: '2030-01-01T00:00:00Z' }))\n");
    const h = join(home, 'aws-proc');
    mkdirSync(join(h, '.aws'), { recursive: true });
    writeFileSync(join(h, '.aws', 'config'), `[default]\ncredential_process = "${process.execPath}" "${script}"\n`);
    expect(await resolveAwsCredentials({ env: {}, home: h })).toMatchObject({ accessKeyId: 'AKIDPROC', sessionToken: 'pt', source: 'AWS profile default' });
  });

  it('uses an IAM Identity Center sign-in from the SSO cache', async () => {
    routes.set('GET /federation/credentials', (s) => {
      expect(s.headers['x-amz-sso_bearer_token']).toBe('sso-access-token');
      expect(s.path).toBe('/federation/credentials?account_id=123456789012&role_name=Engineer');
      return { status: 200, body: JSON.stringify({ roleCredentials: { accessKeyId: 'ASIASSO', secretAccessKey: 'x', sessionToken: 'y', expiration: Date.parse('2030-01-01T00:00:00Z') } }) };
    });
    const h = join(home, 'aws-sso');
    mkdirSync(join(h, '.aws', 'sso', 'cache'), { recursive: true });
    writeFileSync(join(h, '.aws', 'config'), '[profile eng]\nsso_session = northwind\nsso_account_id = 123456789012\nsso_role_name = Engineer\n\n[sso-session northwind]\nsso_start_url = https://northwind.awsapps.com/start\nsso_region = eu-central-1\n');
    const env = { AWS_PROFILE: 'eng', AWS_ENDPOINT_URL_SSO: base };
    await expect(resolveAwsCredentials({ env, home: h })).rejects.toThrow('Run: aws sso login --profile eng');
    const cache = join(h, '.aws', 'sso', 'cache', `${createHash('sha1').update('northwind').digest('hex')}.json`);
    writeFileSync(cache, JSON.stringify({ accessToken: 'sso-access-token', expiresAt: '2030-01-01T00:00:00Z' }));
    expect(await resolveAwsCredentials({ env, home: h })).toMatchObject({ accessKeyId: 'ASIASSO', source: 'AWS profile eng (IAM Identity Center)' });
    writeFileSync(cache, JSON.stringify({ accessToken: 'sso-access-token', expiresAt: '2020-01-01T00:00:00Z' }));
    await expect(resolveAwsCredentials({ env, home: h })).rejects.toThrow(/sign-in expired/);
  });

  it('reads container credentials, with their authorization token', async () => {
    routes.set('GET /creds', (s) => {
      expect(s.headers.authorization).toBe('container-token');
      return { status: 200, body: JSON.stringify({ AccessKeyId: 'ASIACONT', SecretAccessKey: 'c', Token: 'ct', Expiration: '2030-01-01T00:00:00Z' }) };
    });
    const c = await resolveAwsCredentials({ env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: `${base}/creds`, AWS_CONTAINER_AUTHORIZATION_TOKEN: 'container-token', AWS_EC2_METADATA_DISABLED: 'true' }, home: join(home, 'none') });
    expect(c).toMatchObject({ accessKeyId: 'ASIACONT', sessionToken: 'ct', source: 'container credentials (ECS or EKS Pod Identity)' });
    // Not over plain http to anywhere but the container agent.
    await expect(resolveAwsCredentials({ env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.1.1/creds', AWS_EC2_METADATA_DISABLED: 'true' }, home: join(home, 'none') })).rejects.toThrow(/must be https/);
  });

  it('says where to get credentials when there are none', async () => {
    await expect(resolveAwsCredentials({ env: { AWS_EC2_METADATA_DISABLED: 'true' }, home: join(home, 'none') })).rejects.toThrow(/No AWS credentials found/);
  });

  it('keeps temporary credentials until five minutes before they expire', async () => {
    let calls = 0;
    let expires = 0;
    routes.set('GET /creds-short', () => {
      calls++;
      return { status: 200, body: JSON.stringify({ AccessKeyId: `ASIA${calls}`, SecretAccessKey: 'c', Token: 't', Expiration: new Date(expires).toISOString() }) };
    });
    let now = Date.parse('2027-01-01T00:00:00Z');
    expires = now + 60 * 60_000;
    const provider = awsCredentialProvider({ env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: `${base}/creds-short`, AWS_EC2_METADATA_DISABLED: 'true' }, home: join(home, 'none'), now: () => now });
    expect((await provider()).accessKeyId).toBe('ASIA1');
    now += 50 * 60_000;
    expect((await provider()).accessKeyId).toBe('ASIA1');
    now += 6 * 60_000;
    expires = now + 60 * 60_000;
    expect((await provider()).accessKeyId).toBe('ASIA2');
  });
});

describe('Google credentials', () => {
  it('refreshes a gcloud user sign-in', async () => {
    routes.set('POST /oauth/token', (s) => {
      const form = new URLSearchParams(s.body);
      expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken' });
      return { status: 200, body: JSON.stringify({ access_token: 'ya29.user', expires_in: 3599 }) };
    });
    const adc = file('gcloud/application_default_credentials.json', JSON.stringify({ type: 'authorized_user', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken', token_uri: `${base}/oauth/token` }));
    const t = await resolveGoogleToken({ env: { CLOUDSDK_CONFIG: join(adc, '..') } });
    expect(t).toMatchObject({ accessToken: 'ya29.user', source: 'gcloud application default credentials' });
    expect(t.signer).toBeUndefined();
  });

  it('exchanges a CI token through workload identity federation, then impersonates a service account', async () => {
    routes.set('POST /sts/v1/token', (s) => {
      const form = new URLSearchParams(s.body);
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
      expect(form.get('subject_token')).toBe('github-oidc-jwt');
      expect(form.get('audience')).toBe('//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/ci/providers/github');
      return { status: 200, body: JSON.stringify({ access_token: 'federated', expires_in: 3600 }) };
    });
    routes.set('POST /v1/projects/-/serviceAccounts/shadowlap-ci@p.iam.gserviceaccount.com:generateAccessToken', (s) => {
      expect(s.headers.authorization).toBe('Bearer federated');
      return { status: 200, body: JSON.stringify({ accessToken: 'ya29.impersonated', expireTime: '2030-01-01T00:00:00Z' }) };
    });
    const subject = file('wif/token', 'github-oidc-jwt');
    const config = file(
      'wif/config.json',
      JSON.stringify({
        type: 'external_account',
        audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/ci/providers/github',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_url: `${base}/sts/v1/token`,
        credential_source: { file: subject },
        service_account_impersonation_url: `${base}/v1/projects/-/serviceAccounts/shadowlap-ci@p.iam.gserviceaccount.com:generateAccessToken`,
      }),
    );
    const t = await resolveGoogleToken({ env: { GOOGLE_APPLICATION_CREDENTIALS: config } });
    expect(t).toMatchObject({ accessToken: 'ya29.impersonated', expiresAt: Date.parse('2030-01-01T00:00:00Z'), source: 'GOOGLE_APPLICATION_CREDENTIALS (workload identity) (as shadowlap-ci@p.iam.gserviceaccount.com)' });
  });

  it('says what went wrong with a sign-in Google refuses', async () => {
    routes.set('POST /oauth/bad', () => ({ status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) }));
    const adc = file('bad/adc.json', JSON.stringify({ type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r', token_uri: `${base}/oauth/bad` }));
    await expect(resolveGoogleToken({ env: { GOOGLE_APPLICATION_CREDENTIALS: adc } })).rejects.toThrow('Google refused the sign-in (invalid_grant: Token has been expired or revoked.)');
  });
});

describe('Azure credentials', () => {
  const bearer = async (auth: AzureAuth) => {
    if (auth.kind !== 'bearer') throw new Error(`expected a bearer sign-in, got ${auth.kind}`);
    return (await auth.token()).token;
  };

  it('signs in as a service principal, or with a federated token from CI', async () => {
    routes.set('POST /tenant-1/oauth2/v2.0/token', (s) => {
      const form = new URLSearchParams(s.body);
      expect(form.get('scope')).toBe('https://storage.azure.com/.default');
      if (form.get('client_secret')) return { status: 200, body: JSON.stringify({ access_token: `secret:${form.get('client_id')}`, expires_in: 3599 }) };
      expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      return { status: 200, body: JSON.stringify({ access_token: `federated:${form.get('client_assertion')}`, expires_in: 3599 }) };
    });
    const sp = azureAuth({ env: { AZURE_CLIENT_ID: 'app-1', AZURE_TENANT_ID: 'tenant-1', AZURE_CLIENT_SECRET: 'shh', AZURE_AUTHORITY_HOST: base } }, 'northwindruns');
    expect(sp.source).toBe('service principal app-1');
    expect(await bearer(sp)).toBe('secret:app-1');
    const assertion = file('azure/federated-token', 'gitlab-id-token\n');
    const wi = azureAuth({ env: { AZURE_CLIENT_ID: 'app-1', AZURE_TENANT_ID: 'tenant-1', AZURE_FEDERATED_TOKEN_FILE: assertion, AZURE_AUTHORITY_HOST: base } }, 'northwindruns');
    expect(wi.source).toBe('workload identity app-1');
    expect(await bearer(wi)).toBe('federated:gitlab-id-token');
  });

  it('prefers an account key or SAS for the account named, as the Azure tools do', () => {
    const key = Buffer.from('k').toString('base64');
    expect(azureAuth({ env: { AZURE_STORAGE_CONNECTION_STRING: `AccountName=northwindruns;AccountKey=${key}` } }, 'northwindruns')).toMatchObject({ kind: 'key', source: 'AZURE_STORAGE_CONNECTION_STRING' });
    // A connection string for another account is not used for this one.
    expect(azureAuth({ env: { AZURE_STORAGE_CONNECTION_STRING: `AccountName=other;AccountKey=${key}`, AZURE_STORAGE_SAS_TOKEN: '?sv=x&sig=y' } }, 'northwindruns')).toMatchObject({ kind: 'sas', token: 'sv=x&sig=y' });
    expect(azureAuth({ env: { AZURE_STORAGE_KEY: key, AZURE_STORAGE_ACCOUNT: 'other' } }, 'northwindruns').kind).toBe('bearer');
  });
});

describe('the credentials this machine would use, found offline', () => {
  const at = (name: string) => {
    const dir = mkdtempSync(join(home, `${name}-`));
    return dir;
  };
  const s3 = parseStoreUrl('s3://northwind-agent-runs/support-agent');

  it('follows the AWS chain without asking STS or the metadata service', () => {
    const empty = at('aws-empty');
    expect(credentialsHere('s3', s3, { env: {}, home: empty })).toBeNull();
    expect(credentialsHere('s3', s3, { env: { AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 's' }, home: empty })).toEqual({ uses: 'access keys in the environment', from: 'from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY' });
    expect(credentialsHere('s3', s3, { env: { AWS_ROLE_ARN: 'arn:aws:iam::1:role/ci', AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/t' }, home: empty })?.uses).toBe('the role arn:aws:iam::1:role/ci');
    // An S3-compatible store has no STS: web identity doesn't count there.
    expect(credentialsHere('s3', parseStoreUrl('s3://b-1?endpoint=https://minio.internal:9000'), { env: { AWS_ROLE_ARN: 'arn:aws:iam::1:role/ci', AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/t' }, home: empty })).toBeNull();
    expect(credentialsHere('s3', s3, { env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/creds' }, home: empty })?.uses).toBe('container credentials');

    const withProfiles = at('aws-profiles');
    mkdirSync(join(withProfiles, '.aws'));
    writeFileSync(join(withProfiles, '.aws', 'config'), '[profile northwind-shadowlap]\nsso_session = northwind\n');
    writeFileSync(join(withProfiles, '.aws', 'credentials'), '[default]\naws_access_key_id = AKID\naws_secret_access_key = s\n');
    expect(credentialsHere('s3', s3, { env: {}, home: withProfiles })).toEqual({ uses: 'the default AWS profile', from: 'from ~/.aws/config; AWS_PROFILE picks another' });
    expect(credentialsHere('s3', s3, { env: { AWS_PROFILE: 'northwind-shadowlap' }, home: withProfiles })).toEqual({ uses: 'AWS profile northwind-shadowlap', from: 'from ~/.aws/config; AWS_PROFILE picks it' });
    expect(credentialsHere('s3', parseStoreUrl('s3://b-1?profile=northwind-shadowlap'), { env: {}, home: withProfiles })?.from).toBe('from ~/.aws/config; the store URL names it');
    expect(credentialsHere('s3', s3, { env: { AWS_PROFILE: 'missing' }, home: withProfiles })).toBeNull();
    // R2: its token's keys first, else an AWS profile that holds them.
    expect(credentialsHere('r2', null, { env: { R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b' }, home: empty })?.uses).toBe('an R2 API token');
    expect(credentialsHere('r2', null, { env: {}, home: withProfiles })?.uses).toBe('the default AWS profile');
  });

  it("finds Google's application default credentials, HMAC keys and an emulator", () => {
    const empty = at('gcp-empty');
    const gs = parseStoreUrl('gs://northwind-agent-runs/support-agent');
    expect(credentialsHere('gcs', gs, { env: {}, home: empty })).toBeNull();
    expect(credentialsHere('gcs', gs, { env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29' }, home: empty })?.from).toBe('from GOOGLE_OAUTH_ACCESS_TOKEN');
    expect(credentialsHere('gcs', gs, { env: { GOOGLE_APPLICATION_CREDENTIALS: '/keys/sa.json' }, home: empty })?.uses).toBe('the credentials file GOOGLE_APPLICATION_CREDENTIALS names');
    const adc = at('gcp-adc');
    mkdirSync(join(adc, '.config', 'gcloud'), { recursive: true });
    writeFileSync(join(adc, '.config', 'gcloud', 'application_default_credentials.json'), '{}');
    expect(credentialsHere('gcs', gs, { env: {}, home: adc })).toEqual({ uses: 'gcloud application default credentials', from: 'from gcloud auth application-default login' });
    expect(credentialsHere('gcs', parseStoreUrl('gs://b-1?auth=hmac'), { env: { GCS_HMAC_ACCESS_KEY_ID: 'a', GCS_HMAC_SECRET_ACCESS_KEY: 'b' }, home: empty })?.uses).toBe('HMAC keys');
    expect(credentialsHere('gcs', gs, { env: { STORAGE_EMULATOR_HOST: '127.0.0.1:4443', GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29' }, home: empty })?.uses).toBe('no credentials');
    // An endpoint that isn't Google's gets none.
    expect(credentialsHere('gcs', parseStoreUrl('gs://b-1?endpoint=https://storage.evil.example'), { env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29' }, home: adc })).toBeNull();
  });

  it("finds Azure keys, a service principal and the Azure CLI's sign-in", () => {
    const empty = at('az-empty');
    const az = parseStoreUrl('az://northwindruns/agent-runs/support-agent');
    expect(credentialsHere('azure', az, { env: {}, home: empty })).toBeNull();
    expect(credentialsHere('azure', az, { env: { AZURE_STORAGE_KEY: 'a2V5' }, home: empty })).toEqual({ uses: 'the storage account key', from: 'from AZURE_STORAGE_KEY' });
    expect(credentialsHere('azure', az, { env: { AZURE_CLIENT_ID: 'app', AZURE_TENANT_ID: 't', AZURE_CLIENT_SECRET: 's' }, home: empty })?.uses).toBe('service principal app');
    const signedIn = at('az-cli');
    mkdirSync(join(signedIn, '.azure'));
    writeFileSync(join(signedIn, '.azure', 'azureProfile.json'), '{}');
    expect(credentialsHere('azure', az, { env: {}, home: signedIn })).toEqual({ uses: 'your Azure CLI sign-in', from: 'from az login' });
    // Without a store yet, the account named in the environment picks the key.
    expect(credentialsHere('azure', null, { env: { AZURE_STORAGE_ACCOUNT: 'northwindruns', AZURE_STORAGE_KEY: 'a2V5' }, home: empty })?.uses).toBe('the storage account key');
  });
});
