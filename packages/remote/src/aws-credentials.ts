import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { send, type FetchLike } from './http.js';
import { parseIni } from './ini.js';
import { StoreError } from './object-store.js';
import { sha256Hex, signRequest, type AwsCredentials } from './sigv4.js';
import { encodeRfc3986 } from './url.js';
import { xmlText } from './xml.js';

/**
 * The user's own AWS credentials, found where the AWS CLI and SDKs look: the environment, a web
 * identity token (CI with OIDC, EKS), the shared config and credentials files (static keys, a
 * credential_process, an assumed role, IAM Identity Center sign-in), the container credentials of
 * ECS and EKS Pod Identity, then the EC2 instance role. Nothing is stored; temporary credentials
 * are kept in memory until shortly before they expire.
 */

export interface AwsEnv {
  env: NodeJS.ProcessEnv;
  /** The home folder that holds .aws/; injectable for tests. */
  home?: string;
  fetch?: FetchLike;
  now?: () => number;
}

export interface CredentialOptions {
  /** A profile named in the store URL; otherwise AWS_PROFILE, then `default`. */
  profile?: string;
  /** Instance and container credentials only make sense for AWS itself. */
  allowInstance?: boolean;
  /** Web identity and assumed roles need STS, which only AWS has. */
  allowSts?: boolean;
}

type Section = Map<string, string>;

function files(e: AwsEnv): { config: Map<string, Section>; credentials: Map<string, Section> } {
  const home = e.home ?? homedir();
  const read = (path: string) => (existsSync(path) ? parseIni(readFileSync(path, 'utf8')) : new Map<string, Section>());
  return {
    config: read(e.env.AWS_CONFIG_FILE || join(home, '.aws', 'config')),
    credentials: read(e.env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials')),
  };
}

/** A profile's settings: the credentials file's section over the config file's. */
function profileSettings(f: ReturnType<typeof files>, name: string): Section | null {
  const fromConfig = f.config.get(name === 'default' ? 'default' : `profile ${name}`) ?? (name === 'default' ? f.config.get('profile default') : undefined);
  const fromCreds = f.credentials.get(name);
  if (!fromConfig && !fromCreds) return null;
  return new Map([...(fromConfig ?? []), ...(fromCreds ?? [])]);
}

/** The region the user configured for a profile, or in the environment. */
export function configuredRegion(e: AwsEnv, profile?: string): string | null {
  const fromEnv = e.env.AWS_REGION || e.env.AWS_DEFAULT_REGION;
  if (fromEnv) return fromEnv;
  const name = profile ?? e.env.AWS_PROFILE ?? 'default';
  return profileSettings(files(e), name)?.get('region') ?? null;
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function credentialsFrom(source: string, id: unknown, secret: unknown, token: unknown, expiration: unknown): AwsCredentials {
  if (typeof id !== 'string' || !id || typeof secret !== 'string' || !secret) throw new StoreError('credentials', `${source} gave no access key`);
  const c: AwsCredentials = { accessKeyId: id, secretAccessKey: secret, source };
  if (typeof token === 'string' && token) c.sessionToken = token;
  const exp = parseExpiry(expiration);
  if (exp !== undefined) c.expiresAt = exp;
  return c;
}

function stsEndpoint(e: AwsEnv, region: string | null): string {
  const custom = e.env.AWS_ENDPOINT_URL_STS || e.env.AWS_ENDPOINT_URL;
  if (custom) return custom.replace(/\/+$/, '');
  return !region || region === 'us-east-1' || region === 'aws-global' ? 'https://sts.amazonaws.com' : `https://sts.${region}.amazonaws.com`;
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');
}

async function callSts(e: AwsEnv, params: Record<string, string>, region: string | null, signWith: AwsCredentials | null, source: string): Promise<AwsCredentials> {
  const endpoint = stsEndpoint(e, region);
  const url = new URL(`${endpoint}/`);
  const body = Buffer.from(form({ ...params, Version: '2011-06-15' }), 'utf8');
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
  if (signWith) {
    const signed = signRequest(
      { method: 'POST', path: url.pathname, query: '', headers: { host: url.host, 'content-type': headers['content-type']! }, payloadHash: sha256Hex(body) },
      { region: region ?? 'us-east-1', service: 'sts', date: new Date(e.now?.() ?? Date.now()), credentials: signWith, normalizePath: true },
    );
    Object.assign(headers, signed.add);
  }
  const res = await send({ method: 'POST', url: url.toString(), headers, body }, { ...(e.fetch ? { fetch: e.fetch } : {}), maxBytes: 1024 * 1024, attempts: 3 });
  const text = res.body.toString('utf8');
  if (res.status !== 200) {
    const message = xmlText(text, 'Message') ?? `answered ${res.status}`;
    throw new StoreError('credentials', `${source}: AWS STS ${xmlText(text, 'Code') ?? 'refused'}: ${message}`, res.status);
  }
  return credentialsFrom(source, xmlText(text, 'AccessKeyId'), xmlText(text, 'SecretAccessKey'), xmlText(text, 'SessionToken'), xmlText(text, 'Expiration'));
}

function sessionName(e: AwsEnv): string {
  return (e.env.AWS_ROLE_SESSION_NAME || `shadowlap-${e.now?.() ?? Date.now()}`).slice(0, 64);
}

async function webIdentity(e: AwsEnv, roleArn: string, tokenFile: string, region: string | null, source: string): Promise<AwsCredentials> {
  let token: string;
  try {
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch {
    throw new StoreError('credentials', `${source}: can't read the web identity token at ${tokenFile}`);
  }
  return callSts(e, { Action: 'AssumeRoleWithWebIdentity', RoleArn: roleArn, RoleSessionName: sessionName(e), WebIdentityToken: token }, region, null, source);
}

function credentialProcess(command: string, source: string): AwsCredentials {
  // A process a signal ended has no exit status, only the signal.
  const r = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) throw new StoreError('credentials', `${source}: credential_process failed: ${(r.stderr || r.error?.message || `exit ${r.status ?? r.signal!}`).trim().slice(0, 300)}`);
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    throw new StoreError('credentials', `${source}: credential_process didn't print JSON`);
  }
  if (out.Version !== 1) throw new StoreError('credentials', `${source}: credential_process must print "Version": 1`);
  return credentialsFrom(source, out.AccessKeyId, out.SecretAccessKey, out.SessionToken, out.Expiration);
}

async function ssoCredentials(e: AwsEnv, f: ReturnType<typeof files>, profile: string, s: Section, source: string): Promise<AwsCredentials> {
  const sessionName = s.get('sso_session');
  const session = sessionName ? f.config.get(`sso-session ${sessionName}`) : null;
  const startUrl = session?.get('sso_start_url') ?? s.get('sso_start_url');
  const ssoRegion = session?.get('sso_region') ?? s.get('sso_region');
  const account = s.get('sso_account_id');
  const role = s.get('sso_role_name');
  if (!startUrl || !ssoRegion || !account || !role) throw new StoreError('credentials', `${source}: the profile's IAM Identity Center settings are incomplete (sso_account_id, sso_role_name and the session's start URL and region)`);
  const cacheKey = createHash('sha1').update(sessionName ?? startUrl).digest('hex');
  const cacheFile = join(e.home ?? homedir(), '.aws', 'sso', 'cache', `${cacheKey}.json`);
  let token: { accessToken?: string; expiresAt?: string };
  try {
    token = JSON.parse(readFileSync(cacheFile, 'utf8')) as typeof token;
  } catch {
    throw new StoreError('credentials', `${source}: no IAM Identity Center sign-in. Run: aws sso login --profile ${profile}`);
  }
  const expires = parseExpiry(token.expiresAt);
  if (!token.accessToken || (expires !== undefined && expires <= (e.now?.() ?? Date.now()))) throw new StoreError('credentials', `${source}: the IAM Identity Center sign-in expired. Run: aws sso login --profile ${profile}`);
  const base = (e.env.AWS_ENDPOINT_URL_SSO || `https://portal.sso.${ssoRegion}.amazonaws.com`).replace(/\/+$/, '');
  const url = `${base}/federation/credentials?account_id=${encodeRfc3986(account)}&role_name=${encodeRfc3986(role)}`;
  const res = await send({ method: 'GET', url, headers: { 'x-amz-sso_bearer_token': token.accessToken } }, { ...(e.fetch ? { fetch: e.fetch } : {}), maxBytes: 1024 * 1024, attempts: 3 });
  if (res.status !== 200) throw new StoreError('credentials', `${source}: IAM Identity Center answered ${res.status}. Run: aws sso login --profile ${profile}`, res.status);
  const rc = (JSON.parse(res.body.toString('utf8')) as { roleCredentials?: Record<string, unknown> }).roleCredentials ?? {};
  return credentialsFrom(source, rc.accessKeyId, rc.secretAccessKey, rc.sessionToken, rc.expiration);
}

async function fromProfile(e: AwsEnv, f: ReturnType<typeof files>, name: string, opts: CredentialOptions, depth: number): Promise<AwsCredentials | null> {
  const s = profileSettings(f, name);
  if (!s) return null;
  const source = `AWS profile ${name}`;
  if (depth > 4) throw new StoreError('credentials', `${source}: source_profile goes round in a loop`);
  const roleArn = s.get('role_arn');
  if (roleArn) {
    if (opts.allowSts === false) throw new StoreError('credentials', `${source} assumes a role, which only AWS can do; this store needs plain access keys`);
    const region = s.get('region') ?? configuredRegion(e) ?? null;
    if (s.get('mfa_serial')) throw new StoreError('credentials', `${source} needs an MFA code, which shadowlap can't ask for. Use a credential_process or aws sso login, or export temporary keys.`);
    const tokenFile = s.get('web_identity_token_file');
    if (tokenFile) return webIdentity(e, roleArn, tokenFile, region, source);
    let base: AwsCredentials | null = null;
    const sourceProfile = s.get('source_profile');
    const credentialSource = s.get('credential_source');
    if (sourceProfile) base = sourceProfile === name ? staticKeys(s, source) : await fromProfile(e, f, sourceProfile, opts, depth + 1);
    else if (credentialSource === 'Environment') base = fromEnvKeys(e);
    else if (credentialSource === 'EcsContainer') base = await containerCredentials(e);
    else if (credentialSource === 'Ec2InstanceMetadata') base = await instanceCredentials(e);
    if (!base) throw new StoreError('credentials', `${source} assumes ${roleArn} but has no source_profile or credential_source to assume it with`);
    const params: Record<string, string> = { Action: 'AssumeRole', RoleArn: roleArn, RoleSessionName: s.get('role_session_name') ?? sessionName(e) };
    const ext = s.get('external_id');
    if (ext) params.ExternalId = ext;
    const duration = s.get('duration_seconds');
    if (duration) params.DurationSeconds = duration;
    return callSts(e, params, region, base, source);
  }
  if (s.get('sso_session') || s.get('sso_start_url')) return ssoCredentials(e, f, name, s, `${source} (IAM Identity Center)`);
  const proc = s.get('credential_process');
  if (proc) return credentialProcess(proc, source);
  return staticKeys(s, source);
}

function staticKeys(s: Section, source: string): AwsCredentials | null {
  const id = s.get('aws_access_key_id');
  const secret = s.get('aws_secret_access_key');
  if (!id || !secret) return null;
  return credentialsFrom(source, id, secret, s.get('aws_session_token'), undefined);
}

function fromEnvKeys(e: AwsEnv): AwsCredentials | null {
  const id = e.env.AWS_ACCESS_KEY_ID;
  const secret = e.env.AWS_SECRET_ACCESS_KEY;
  if (!id || !secret) return null;
  return credentialsFrom('AWS_ACCESS_KEY_ID', id, secret, e.env.AWS_SESSION_TOKEN, e.env.AWS_CREDENTIAL_EXPIRATION);
}

const CONTAINER_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '169.254.170.2', '169.254.170.23', '[fd00:ec2::23]']);

async function containerCredentials(e: AwsEnv): Promise<AwsCredentials | null> {
  const relative = e.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const full = e.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (!relative && !full) return null;
  const url = relative ? `http://169.254.170.2${relative}` : full!;
  const u = new URL(url);
  if (u.protocol !== 'https:' && !CONTAINER_HOSTS.has(u.hostname)) throw new StoreError('credentials', `AWS_CONTAINER_CREDENTIALS_FULL_URI must be https, or http to the container agent`);
  const headers: Record<string, string> = {};
  const tokenFile = e.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
  const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : e.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  if (token) headers.authorization = token;
  const res = await send({ method: 'GET', url, headers }, { ...(e.fetch ? { fetch: e.fetch } : {}), maxBytes: 64 * 1024, attempts: 3, timeoutMs: 5000 });
  if (res.status !== 200) throw new StoreError('credentials', `the container credentials endpoint answered ${res.status}`, res.status);
  const c = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
  return credentialsFrom('container credentials (ECS or EKS Pod Identity)', c.AccessKeyId, c.SecretAccessKey, c.Token, c.Expiration);
}

async function instanceCredentials(e: AwsEnv): Promise<AwsCredentials | null> {
  if (e.env.AWS_EC2_METADATA_DISABLED === 'true') return null;
  const base = (e.env.AWS_EC2_METADATA_SERVICE_ENDPOINT || 'http://169.254.169.254').replace(/\/+$/, '');
  const opts = { ...(e.fetch ? { fetch: e.fetch } : {}), maxBytes: 64 * 1024, attempts: 1, timeoutMs: 1000 };
  try {
    const t = await send({ method: 'PUT', url: `${base}/latest/api/token`, headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' } }, opts);
    if (t.status !== 200) return null;
    const token = t.body.toString('utf8');
    const roles = await send({ method: 'GET', url: `${base}/latest/meta-data/iam/security-credentials/`, headers: { 'x-aws-ec2-metadata-token': token } }, opts);
    const role = roles.body.toString('utf8').split('\n')[0]?.trim();
    if (roles.status !== 200 || !role) return null;
    const c = await send({ method: 'GET', url: `${base}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, headers: { 'x-aws-ec2-metadata-token': token } }, opts);
    if (c.status !== 200) return null;
    const j = JSON.parse(c.body.toString('utf8')) as Record<string, unknown>;
    return credentialsFrom(`EC2 instance role ${role}`, j.AccessKeyId, j.SecretAccessKey, j.Token, j.Expiration);
  } catch {
    return null; // not on EC2
  }
}

/**
 * Where AWS credentials would come from, found offline in the same order (no STS, no metadata
 * service): what they are and where they are read from, or null when nothing here names any.
 */
export function awsCredentialsHere(e: AwsEnv, opts: CredentialOptions = {}): { uses: string; from: string } | null {
  const named = opts.profile ?? e.env.AWS_PROFILE;
  if (!named && e.env.AWS_ACCESS_KEY_ID && e.env.AWS_SECRET_ACCESS_KEY) return { uses: 'access keys in the environment', from: 'from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY' };
  if (opts.allowSts !== false && e.env.AWS_WEB_IDENTITY_TOKEN_FILE && e.env.AWS_ROLE_ARN) return { uses: `the role ${e.env.AWS_ROLE_ARN}`, from: 'by web identity (AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE)' };
  const name = named ?? 'default';
  if (profileSettings(files(e), name)) {
    const picked = opts.profile ? 'the store URL names it' : e.env.AWS_PROFILE ? 'AWS_PROFILE picks it' : 'AWS_PROFILE picks another';
    return { uses: name === 'default' ? 'the default AWS profile' : `AWS profile ${name}`, from: `from ~/.aws/config; ${picked}` };
  }
  if (opts.allowInstance !== false && (e.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || e.env.AWS_CONTAINER_CREDENTIALS_FULL_URI)) return { uses: 'container credentials', from: 'from ECS or EKS Pod Identity' };
  return null;
}

/** Where AWS credentials would come from, in the order the AWS CLI looks. Throws when there are none. */
export async function resolveAwsCredentials(e: AwsEnv, opts: CredentialOptions = {}): Promise<AwsCredentials> {
  const named = opts.profile ?? e.env.AWS_PROFILE;
  if (!named) {
    const env = fromEnvKeys(e);
    if (env) return env;
  }
  if (opts.allowSts !== false && e.env.AWS_WEB_IDENTITY_TOKEN_FILE && e.env.AWS_ROLE_ARN) {
    return webIdentity(e, e.env.AWS_ROLE_ARN, e.env.AWS_WEB_IDENTITY_TOKEN_FILE, configuredRegion(e, named), 'web identity (AWS_ROLE_ARN)');
  }
  const f = files(e);
  const fromFiles = await fromProfile(e, f, named ?? 'default', opts, 0);
  if (fromFiles) return fromFiles;
  if (named && !profileSettings(f, named)) throw new StoreError('credentials', `There is no AWS profile named ${named} in ~/.aws/config or ~/.aws/credentials.`);
  if (opts.allowInstance !== false) {
    const container = await containerCredentials(e);
    if (container) return container;
    const instance = await instanceCredentials(e);
    if (instance) return instance;
  }
  throw new StoreError(
    'credentials',
    'No AWS credentials found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, pick a profile with AWS_PROFILE (aws configure or aws sso login), or run where an IAM role applies.',
  );
}

/** A cached provider: resolves once, and again five minutes before temporary credentials expire. */
export function awsCredentialProvider(e: AwsEnv, opts: CredentialOptions = {}): () => Promise<AwsCredentials> {
  let cached: AwsCredentials | null = null;
  let pending: Promise<AwsCredentials> | null = null;
  return async () => {
    const now = e.now?.() ?? Date.now();
    if (cached && (cached.expiresAt === undefined || cached.expiresAt - now > 5 * 60_000)) return cached;
    pending ??= resolveAwsCredentials(e, opts).finally(() => {
      pending = null;
    });
    cached = await pending;
    return cached;
  };
}
