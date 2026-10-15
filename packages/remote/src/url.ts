/**
 * Where a team store lives: a bucket the customer owns, and a folder in it, written as a URL.
 *
 *   s3://bucket/folder            Amazon S3 (?region=eu-central-1, ?profile=…)
 *   s3://bucket/folder?endpoint=https://minio.internal:9000
 *                                 another S3-compatible store (path-style by default)
 *   r2://account-id/bucket/folder Cloudflare R2
 *   gs://bucket/folder            Google Cloud Storage (?auth=hmac for its S3-compatible API)
 *   az://account/container/folder Azure Blob Storage
 *
 * The query carries only what the bucket name can't say. The URL without its query is the store's
 * identity: what this machine remembers it pushed and pulled is kept under it.
 */

export type Provider = 's3' | 'r2' | 'gcs' | 'azure';
export const PROVIDERS: readonly Provider[] = ['s3', 'gcs', 'azure', 'r2'];

export const SCHEMES: Record<Provider, string> = { s3: 's3://', gcs: 'gs://', azure: 'az://', r2: 'r2://' };
export const PROVIDER_NAMES: Record<Provider, string> = { s3: 'Amazon S3', gcs: 'Google Cloud', azure: 'Azure Blob', r2: 'Cloudflare R2' };

export interface StoreLocation {
  provider: Provider;
  /** scheme://…/folder without the query: the store's identity. */
  url: string;
  /** The bucket (S3, R2, GCS) or container (Azure). */
  bucket: string;
  /** The folder inside it, without leading or trailing slashes; '' for the bucket's root. */
  prefix: string;
  /** The R2 account id, or the Azure storage account. */
  account?: string;
  /** S3: the bucket's region, when known up front. */
  region?: string;
  /** Another endpoint: an S3-compatible service, Azurite, a GCS emulator. */
  endpoint?: string;
  /** S3: address the bucket in the path instead of the host name. */
  pathStyle?: boolean;
  /** GCS: use the S3-compatible XML API with HMAC keys instead of OAuth. */
  auth?: 'hmac';
  /** S3 and R2: the AWS profile to read credentials from. */
  profile?: string;
}

export class StoreUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreUrlError';
  }
}

const SHAPES: Record<Provider, string> = {
  s3: 'then the bucket and, if you like, a folder: s3://my-bucket/agent-runs',
  gcs: 'then the bucket and, if you like, a folder: gs://my-bucket/agent-runs',
  azure: 'then the storage account, the container and, if you like, a folder: az://myaccount/agent-runs',
  r2: 'then your account id, the bucket and, if you like, a folder: r2://<account-id>/agent-runs',
};

/** The message the mock shows for a URL that doesn't fit the provider picked. */
export function schemeHint(provider: Provider): string {
  const name = PROVIDER_NAMES[provider];
  return `${/^[AEIOU]/.test(name) ? 'An' : 'A'} ${name} store starts with ${SCHEMES[provider]}, ${SHAPES[provider]}.`;
}

const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const LOOSE_BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const GCS_BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const AZ_CONTAINER = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const AZ_ACCOUNT = /^[a-z0-9]{3,24}$/;
const R2_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const REGION = /^[a-z0-9-]{2,40}$/;
const PROFILE = /^[A-Za-z0-9_.+@-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function providerOf(scheme: string): Provider | null {
  const found = (Object.keys(SCHEMES) as Provider[]).find((p) => SCHEMES[p] === `${scheme}//`);
  return found ?? null;
}

function cleanPrefix(parts: string[], raw: string): string {
  const segments = parts.filter((s) => s !== '');
  for (const s of segments) {
    if (s === '.' || s === '..') throw new StoreUrlError(`${raw}: a folder can't be "." or ".."`);
    if (CONTROL.test(s) || s.includes('\\')) throw new StoreUrlError(`${raw}: a folder name can't contain control characters or backslashes`);
  }
  const prefix = segments.join('/');
  if (prefix.length > 512) throw new StoreUrlError(`${raw}: the folder is longer than 512 characters`);
  return prefix;
}

function checkEndpoint(raw: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new StoreUrlError(`${raw}: endpoint must be a URL such as https://minio.internal:9000`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new StoreUrlError(`${raw}: endpoint must be an http(s) URL`);
  if (u.username || u.password) throw new StoreUrlError(`${raw}: put credentials in the environment, never in the store URL`);
  if (u.search || u.hash) throw new StoreUrlError(`${raw}: endpoint is a base URL, without a query`);
  return u.toString().replace(/\/+$/, '');
}

/**
 * Parses and checks a store URL. `expect` checks it against one provider's scheme, as the setup
 * step does when a provider was picked first.
 */
export function parseStoreUrl(raw: string, expect?: Provider): StoreLocation {
  const text = raw.trim();
  const m = /^([a-z0-9]+:)\/\/([^?#]*)(\?[^#]*)?$/i.exec(text);
  const provider = m ? providerOf(m[1]!.toLowerCase()) : null;
  if (expect && provider !== expect) throw new StoreUrlError(schemeHint(expect));
  if (!m || !provider) throw new StoreUrlError(`${text || '""'} isn't a store URL. Use s3://bucket/folder, gs://bucket/folder, az://account/container/folder or r2://account/bucket/folder.`);
  const parts = m[2]!.split('/');
  const query = new URLSearchParams(m[3]?.slice(1) ?? '');
  const loc: StoreLocation = { provider, url: '', bucket: '', prefix: '' };

  for (const key of query.keys()) {
    if (!['region', 'endpoint', 'path-style', 'auth', 'profile'].includes(key)) throw new StoreUrlError(`${text}: unknown setting "${key}" (the URL takes region, endpoint, path-style, auth and profile)`);
  }
  const endpoint = query.get('endpoint');
  if (endpoint) loc.endpoint = checkEndpoint(text, endpoint);

  if (provider === 'r2' || provider === 'azure') {
    const account = parts[0] ?? '';
    const bucket = parts[1] ?? '';
    if (provider === 'r2' && !R2_ACCOUNT.test(account)) throw new StoreUrlError(schemeHint('r2'));
    if (provider === 'azure' && !AZ_ACCOUNT.test(account)) throw new StoreUrlError(`${text}: an Azure storage account name is 3 to 24 lowercase letters and digits. ${schemeHint('azure')}`);
    if (!bucket) throw new StoreUrlError(schemeHint(provider));
    if (provider === 'r2' && !R2_BUCKET.test(bucket)) throw new StoreUrlError(`${text}: an R2 bucket name is 3 to 63 lowercase letters, digits and hyphens`);
    if (provider === 'azure' && !AZ_CONTAINER.test(bucket)) throw new StoreUrlError(`${text}: an Azure container name is 3 to 63 lowercase letters, digits and single hyphens`);
    loc.account = account;
    loc.bucket = bucket;
    loc.prefix = cleanPrefix(parts.slice(2), text);
  } else {
    const bucket = parts[0] ?? '';
    if (!bucket) throw new StoreUrlError(schemeHint(provider));
    const ok = provider === 'gcs' ? GCS_BUCKET.test(bucket) : loc.endpoint ? LOOSE_BUCKET.test(bucket) : S3_BUCKET.test(bucket) && !/\.\.|^\d+\.\d+\.\d+\.\d+$/.test(bucket);
    if (!ok) throw new StoreUrlError(`${text}: "${bucket}" isn't a valid ${PROVIDER_NAMES[provider]} bucket name (3 to 63 lowercase letters, digits, dots and hyphens)`);
    loc.bucket = bucket;
    loc.prefix = cleanPrefix(parts.slice(1), text);
  }

  const region = query.get('region');
  if (region) {
    if (!REGION.test(region)) throw new StoreUrlError(`${text}: "${region}" isn't a region name`);
    if (provider !== 's3' && provider !== 'r2') throw new StoreUrlError(`${text}: region applies to s3:// and r2:// stores`);
    loc.region = region;
  }
  const pathStyle = query.get('path-style');
  if (pathStyle !== null) {
    if (provider !== 's3') throw new StoreUrlError(`${text}: path-style applies to s3:// stores`);
    if (pathStyle !== 'true' && pathStyle !== 'false') throw new StoreUrlError(`${text}: path-style is true or false`);
    loc.pathStyle = pathStyle === 'true';
  }
  const auth = query.get('auth');
  if (auth !== null) {
    if (provider !== 'gcs' || auth !== 'hmac') throw new StoreUrlError(`${text}: auth=hmac is the one setting auth takes, for gs:// stores`);
    loc.auth = 'hmac';
  }
  const profile = query.get('profile');
  if (profile !== null) {
    if (provider !== 's3' && provider !== 'r2') throw new StoreUrlError(`${text}: profile applies to s3:// and r2:// stores`);
    if (!PROFILE.test(profile)) throw new StoreUrlError(`${text}: "${profile}" isn't an AWS profile name`);
    loc.profile = profile;
  }

  const path = [loc.account, loc.bucket, loc.prefix].filter(Boolean).join('/');
  loc.url = `${SCHEMES[provider]}${path}`;
  return loc;
}

/** The URL with its settings, as `store set` writes it to the config. */
export function formatStoreUrl(loc: StoreLocation): string {
  const q: string[] = [];
  if (loc.region) q.push(`region=${loc.region}`);
  if (loc.endpoint) q.push(`endpoint=${loc.endpoint}`);
  if (loc.pathStyle !== undefined) q.push(`path-style=${loc.pathStyle}`);
  if (loc.auth) q.push(`auth=${loc.auth}`);
  if (loc.profile) q.push(`profile=${loc.profile}`);
  return q.length ? `${loc.url}?${q.join('&')}` : loc.url;
}

/** What kind of store a URL names, for a status line: an `?endpoint=` on s3:// is another S3-compatible store, not Amazon's. */
export function storeKindName(loc: StoreLocation): string {
  if (loc.provider === 's3' && loc.endpoint) return 'S3-compatible';
  if (loc.provider === 'gcs' && loc.auth === 'hmac') return 'Google Cloud, S3-compatible API';
  return PROVIDER_NAMES[loc.provider];
}

/** `northwind-agent-runs/support-agent`: the bucket and folder, for a status line. */
export function shortStoreName(loc: StoreLocation): string {
  return [loc.provider === 'azure' || loc.provider === 'r2' ? loc.account : null, loc.bucket, loc.prefix].filter(Boolean).join('/');
}

/** The object key for a path inside the store's folder. */
export function objectKey(loc: StoreLocation, key: string): string {
  return loc.prefix ? `${loc.prefix}/${key}` : key;
}

/** RFC 3986 percent-encoding: everything but letters, digits and - _ . ~. */
export function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** An object key as a URL path: each segment encoded, the slashes kept. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}
