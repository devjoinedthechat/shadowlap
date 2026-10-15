import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { send, type FetchLike } from './http.js';
import { StoreError } from './object-store.js';

/**
 * Google credentials as Application Default Credentials finds them: an access token in
 * GOOGLE_OAUTH_ACCESS_TOKEN, the file GOOGLE_APPLICATION_CREDENTIALS names (a service-account key,
 * a gcloud user sign-in, workload identity federation from CI, an impersonated service account),
 * gcloud's own application-default file, then the metadata server of a Google Cloud machine.
 */

export interface GoogleEnv {
  env: NodeJS.ProcessEnv;
  home?: string;
  fetch?: FetchLike;
  now?: () => number;
}

export interface GoogleToken {
  accessToken: string;
  /** ms; null when unknown. */
  expiresAt: number | null;
  /** In words: `GOOGLE_APPLICATION_CREDENTIALS (service account x@y)`. */
  source: string;
  /** A service account's key, which can sign share links. */
  signer?: { email: string; privateKey: string };
}

const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const CLOUD = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

type Json = Record<string, unknown>;

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

async function postToken(e: GoogleEnv, url: string, body: Record<string, unknown>, source: string, headers: Record<string, string> = {}, json = false): Promise<Json> {
  const payload = json ? JSON.stringify(body) : new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, String(v)])).toString();
  const res = await send(
    { method: 'POST', url, headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', ...headers }, body: Buffer.from(payload, 'utf8') },
    { ...(e.fetch ? { fetch: e.fetch } : {}), maxBytes: 1024 * 1024, attempts: 3 },
  );
  let parsed: Json = {};
  try {
    parsed = JSON.parse(res.body.toString('utf8')) as Json;
  } catch {
    // reported below
  }
  if (res.status !== 200) {
    const err = parsed.error as Json | string | undefined;
    const detail = typeof err === 'string' ? `${err}${parsed.error_description ? `: ${String(parsed.error_description)}` : ''}` : str(err?.message) ?? `answered ${res.status}`;
    throw new StoreError('credentials', `${source}: Google refused the sign-in (${detail}). Sign in again: gcloud auth application-default login`, res.status);
  }
  return parsed;
}

function expiry(e: GoogleEnv, j: Json): number | null {
  const secs = Number(j.expires_in);
  if (Number.isFinite(secs)) return (e.now?.() ?? Date.now()) + secs * 1000;
  const at = Date.parse(String(j.expireTime ?? ''));
  return Number.isFinite(at) ? at : null;
}

/** A service-account key: a JWT signed with its private key, exchanged for an access token. */
async function serviceAccount(e: GoogleEnv, key: Json, source: string): Promise<GoogleToken> {
  const email = str(key.client_email);
  const privateKey = str(key.private_key);
  if (!email || !privateKey) throw new StoreError('credentials', `${source}: the service-account key has no client_email or private_key`);
  const tokenUri = str(key.token_uri) ?? DEFAULT_TOKEN_URI;
  const iat = Math.floor((e.now?.() ?? Date.now()) / 1000);
  const header = { alg: 'RS256', typ: 'JWT', ...(str(key.private_key_id) ? { kid: key.private_key_id } : {}) };
  const claims = { iss: email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey);
  const j = await postToken(e, tokenUri, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }, source);
  const token = str(j.access_token);
  if (!token) throw new StoreError('credentials', `${source}: Google gave no access token`);
  return { accessToken: token, expiresAt: expiry(e, j), source: `${source} (service account ${email})`, signer: { email, privateKey } };
}

async function authorizedUser(e: GoogleEnv, j: Json, source: string): Promise<GoogleToken> {
  const clientId = str(j.client_id);
  const clientSecret = str(j.client_secret);
  const refresh = str(j.refresh_token);
  if (!clientId || !clientSecret || !refresh) throw new StoreError('credentials', `${source}: the sign-in file is incomplete. Run: gcloud auth application-default login`);
  const r = await postToken(e, str(j.token_uri) ?? DEFAULT_TOKEN_URI, { grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refresh }, source);
  const token = str(r.access_token);
  if (!token) throw new StoreError('credentials', `${source}: Google gave no access token`);
  return { accessToken: token, expiresAt: expiry(e, r), source };
}

async function impersonate(e: GoogleEnv, url: string, bearer: string, source: string): Promise<GoogleToken> {
  const r = await postToken(e, url, { scope: [CLOUD], lifetime: '3600s' }, source, { authorization: `Bearer ${bearer}` }, true);
  const token = str(r.accessToken);
  if (!token) throw new StoreError('credentials', `${source}: impersonating the service account gave no token`);
  const email = /serviceAccounts\/([^:]+):generateAccessToken/.exec(url)?.[1];
  return { accessToken: token, expiresAt: expiry(e, r), source: `${source}${email ? ` (as ${decodeURIComponent(email)})` : ''}` };
}

/** Workload identity federation: a token from CI or another cloud, exchanged at Google's STS. */
async function externalAccount(e: GoogleEnv, j: Json, source: string): Promise<GoogleToken> {
  const cs = (j.credential_source ?? {}) as Json;
  let subject: string;
  const format = (cs.format ?? {}) as Json;
  if (str(cs.file)) {
    try {
      subject = readFileSync(String(cs.file), 'utf8');
    } catch {
      throw new StoreError('credentials', `${source}: can't read the subject token file ${String(cs.file)}`);
    }
  } else if (str(cs.url)) {
    const res = await send({ method: 'GET', url: String(cs.url), headers: (cs.headers as Record<string, string>) ?? {} }, { ...(e.fetch ? { fetch: e.fetch } : {}), maxBytes: 1024 * 1024 });
    if (res.status !== 200) throw new StoreError('credentials', `${source}: the subject token URL answered ${res.status}`, res.status);
    subject = res.body.toString('utf8');
  } else {
    throw new StoreError('credentials', `${source}: this kind of workload identity federation (an executable or AWS source) isn't supported; use a token file or URL, or GOOGLE_OAUTH_ACCESS_TOKEN`);
  }
  if (format.type === 'json') {
    const field = str(format.subject_token_field_name) ?? 'access_token';
    subject = String((JSON.parse(subject) as Json)[field] ?? '');
  }
  subject = subject.trim();
  if (!subject) throw new StoreError('credentials', `${source}: the subject token is empty`);
  const audience = str(j.audience);
  const tokenUrl = str(j.token_url) ?? 'https://sts.googleapis.com/v1/token';
  if (!audience) throw new StoreError('credentials', `${source}: the configuration has no audience`);
  const r = await postToken(
    e,
    tokenUrl,
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience,
      scope: CLOUD,
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: subject,
      subject_token_type: str(j.subject_token_type) ?? 'urn:ietf:params:oauth:token-type:jwt',
    },
    source,
  );
  const token = str(r.access_token);
  if (!token) throw new StoreError('credentials', `${source}: Google's STS gave no access token`);
  const imp = str(j.service_account_impersonation_url);
  if (imp) return impersonate(e, imp, token, `${source} (workload identity)`);
  return { accessToken: token, expiresAt: expiry(e, r), source: `${source} (workload identity)` };
}

async function fromFile(e: GoogleEnv, path: string, source: string): Promise<GoogleToken> {
  let j: Json;
  try {
    j = JSON.parse(readFileSync(path, 'utf8')) as Json;
  } catch {
    throw new StoreError('credentials', `${source}: ${path} isn't a readable credentials file`);
  }
  switch (j.type) {
    case 'service_account':
      return serviceAccount(e, j, source);
    case 'authorized_user':
      return authorizedUser(e, j, source);
    case 'external_account':
      return externalAccount(e, j, source);
    case 'impersonated_service_account': {
      const src = (j.source_credentials ?? {}) as Json;
      const base = src.type === 'service_account' ? await serviceAccount(e, src, source) : await authorizedUser(e, src, source);
      const url = str(j.service_account_impersonation_url);
      if (!url) throw new StoreError('credentials', `${source}: no service_account_impersonation_url`);
      return impersonate(e, url, base.accessToken, source);
    }
    default:
      throw new StoreError('credentials', `${source}: credentials of type ${String(j.type)} aren't supported`);
  }
}

async function metadataServer(e: GoogleEnv): Promise<GoogleToken | null> {
  const host = e.env.GCE_METADATA_HOST || e.env.GCE_METADATA_IP || '169.254.169.254';
  try {
    const res = await send(
      { method: 'GET', url: `http://${host}/computeMetadata/v1/instance/service-accounts/default/token`, headers: { 'metadata-flavor': 'Google' } },
      { ...(e.fetch ? { fetch: e.fetch } : {}), maxBytes: 64 * 1024, attempts: 1, timeoutMs: e.env.GCE_METADATA_HOST ? 5000 : 800 },
    );
    if (res.status !== 200 || res.headers.get('metadata-flavor') !== 'Google') return null;
    const j = JSON.parse(res.body.toString('utf8')) as Json;
    const token = str(j.access_token);
    return token ? { accessToken: token, expiresAt: expiry(e, j), source: 'the Google Cloud metadata server' } : null;
  } catch {
    return null;
  }
}

/** gcloud's application-default credentials file. */
export function gcloudAdcPath(e: GoogleEnv): string {
  if (e.env.CLOUDSDK_CONFIG) return join(e.env.CLOUDSDK_CONFIG, 'application_default_credentials.json');
  if (process.platform === 'win32' && e.env.APPDATA) return join(e.env.APPDATA, 'gcloud', 'application_default_credentials.json');
  return join(e.home ?? homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

/** Where a Google token would come from, found offline in the same order (no metadata server), or null. */
export function googleCredentialsHere(e: GoogleEnv): { uses: string; from: string } | null {
  if (e.env.GOOGLE_OAUTH_ACCESS_TOKEN) return { uses: 'an access token', from: 'from GOOGLE_OAUTH_ACCESS_TOKEN' };
  if (e.env.GOOGLE_APPLICATION_CREDENTIALS) return { uses: 'the credentials file GOOGLE_APPLICATION_CREDENTIALS names', from: 'a service-account key or a workload identity file' };
  if (existsSync(gcloudAdcPath(e))) return { uses: 'gcloud application default credentials', from: 'from gcloud auth application-default login' };
  return null;
}

export async function resolveGoogleToken(e: GoogleEnv): Promise<GoogleToken> {
  const direct = e.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (direct) return { accessToken: direct.trim(), expiresAt: null, source: 'GOOGLE_OAUTH_ACCESS_TOKEN' };
  const file = e.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file) return fromFile(e, file, 'GOOGLE_APPLICATION_CREDENTIALS');
  const adc = gcloudAdcPath(e);
  if (existsSync(adc)) return fromFile(e, adc, 'gcloud application default credentials');
  const meta = await metadataServer(e);
  if (meta) return meta;
  throw new StoreError('credentials', 'No Google credentials found. Run gcloud auth application-default login, or point GOOGLE_APPLICATION_CREDENTIALS at a key or workload identity file.');
}

/** Resolves once, and again five minutes before the token expires. */
export function googleTokenProvider(e: GoogleEnv): () => Promise<GoogleToken> {
  let cached: GoogleToken | null = null;
  let pending: Promise<GoogleToken> | null = null;
  return async () => {
    const now = e.now?.() ?? Date.now();
    if (cached && (cached.expiresAt === null || cached.expiresAt - now > 5 * 60_000)) return cached;
    pending ??= resolveGoogleToken(e).finally(() => {
      pending = null;
    });
    cached = await pending;
    return cached;
  };
}
