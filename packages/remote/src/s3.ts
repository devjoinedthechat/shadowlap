import { createHash } from 'node:crypto';
import { send, type FetchLike, type HttpResponse } from './http.js';
import { StoreError, transportError, type BucketInfo, type GetResult, type ObjectInfo, type ObjectLock, type ObjectStore, type PutOptions, type PutResult, type SignedLink } from './object-store.js';
import { presignRequest, sha256Hex, signRequest, UNSIGNED_PAYLOAD, type AwsCredentials, EMPTY_SHA256 } from './sigv4.js';
import { encodeKeyPath, encodeRfc3986, objectKey, type StoreLocation } from './url.js';
import { xmlBlocks, xmlText } from './xml.js';

/**
 * The S3 API with SigV4, for Amazon S3, Cloudflare R2, other S3-compatible stores (MinIO, Ceph,
 * Wasabi, Backblaze B2…) and Google Cloud Storage's HMAC interop. Requests go straight to the
 * service with the user's own credentials.
 */

export interface S3Options {
  location: StoreLocation;
  /** Service name for messages: Amazon S3, Cloudflare R2, Google Cloud. */
  service: string;
  /** Base URL; null for AWS, which is addressed by region. */
  endpoint: string | null;
  /** Signing region; for AWS null means "find it from the bucket". */
  region: string | null;
  pathStyle: boolean;
  credentials: () => Promise<AwsCredentials>;
  /** Whether the service has bucket versioning (R2 doesn't). */
  versioning: boolean;
  /** Whether to ask for the bucket's Object Lock setting (?object-lock): Amazon S3 and other S3-compatible stores, not R2 or Cloud Storage. */
  objectLock?: boolean;
  /** What a service that always encrypts says about it, when it has no setting to read. */
  alwaysEncrypted?: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Wait between retries (tests make it short). */
  retryDelayMs?: number;
}

const MAX_OBJECT = 512 * 1024 * 1024;

/**
 * The body's MD5, base64, for Content-MD5: S3 refuses a write without it (or another checksum) to a
 * bucket whose Object Lock has a default retention. Null where MD5 isn't available (a FIPS build).
 */
function contentMd5(body: Buffer): string | null {
  try {
    return createHash('md5').update(body).digest('base64');
  } catch {
    return null;
  }
}

/** `governance mode, 30 days` from an Object Lock configuration's default retention, or null without one. */
function retentionOf(xml: string): string | null {
  const mode = xmlText(xml, 'Mode');
  if (!mode) return null;
  const days = xmlText(xml, 'Days');
  const years = xmlText(xml, 'Years');
  const span = days ? `${days} day${days === '1' ? '' : 's'}` : years ? `${years} year${years === '1' ? '' : 's'}` : null;
  return `${mode.toLowerCase()} mode${span ? `, ${span}` : ''}`;
}

type Op = 'list' | 'read' | 'write' | 'delete' | 'check';
const OP_WORDS: Record<Op, string> = { list: 'list objects in', read: 'read from', write: 'write to', delete: 'delete from', check: 'read the settings of' };

export class S3Store implements ObjectStore {
  readonly location: StoreLocation;
  private region: string | null;
  private conditional = true;

  constructor(private readonly o: S3Options) {
    this.location = o.location;
    this.region = o.region;
  }

  async credentials(): Promise<string> {
    return (await this.o.credentials()).source;
  }

  private sendOptions(maxBytes = MAX_OBJECT) {
    return { ...(this.o.fetch ? { fetch: this.o.fetch } : {}), maxBytes, ...(this.o.retryDelayMs !== undefined ? { retryDelayMs: this.o.retryDelayMs } : {}) };
  }

  /** The bucket's region, found once from the bucket itself when nothing configured one. */
  private async resolvedRegion(): Promise<string> {
    if (this.region) return this.region;
    try {
      const res = await send({ method: 'HEAD', url: `https://${this.location.bucket}.s3.amazonaws.com/` }, { ...this.sendOptions(1024), attempts: 2 });
      this.region = res.headers.get('x-amz-bucket-region') ?? 'us-east-1';
    } catch {
      this.region = 'us-east-1';
    }
    return this.region;
  }

  /** Virtual-hosted on AWS when the bucket name allows it; path-style everywhere else. */
  private async base(): Promise<{ origin: string; bucketPath: string }> {
    if (this.o.endpoint) {
      const u = new URL(this.o.endpoint);
      const root = u.pathname.replace(/\/+$/, '');
      if (!this.o.pathStyle) return { origin: `${u.protocol}//${this.location.bucket}.${u.host}`, bucketPath: root };
      return { origin: `${u.protocol}//${u.host}`, bucketPath: `${root}/${encodeRfc3986(this.location.bucket)}` };
    }
    const region = await this.resolvedRegion();
    const host = `s3.${region}.amazonaws.com`;
    if (this.o.pathStyle || this.location.bucket.includes('.')) return { origin: `https://${host}`, bucketPath: `/${encodeRfc3986(this.location.bucket)}` };
    return { origin: `https://${this.location.bucket}.${host}`, bucketPath: '' };
  }

  private async request(op: Op, method: string, key: string | null, query: string, opts: { body?: Buffer; headers?: Record<string, string>; maxBytes?: number; what?: string } = {}): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++) {
      const { origin, bucketPath } = await this.base();
      const path = `${bucketPath}/${key === null ? '' : encodeKeyPath(key)}`;
      const url = new URL(`${origin}${path}${query ? `?${query}` : ''}`);
      const credentials = await this.o.credentials();
      const region = this.o.endpoint ? (this.o.region ?? 'us-east-1') : await this.resolvedRegion();
      const payloadHash = opts.body ? sha256Hex(opts.body) : EMPTY_SHA256;
      const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, ...(opts.headers ?? {}) };
      const signed = signRequest({ method, path: url.pathname, query: url.search.slice(1), headers, payloadHash }, { region, service: 's3', date: new Date(this.o.now?.() ?? Date.now()), credentials });
      const { host: _host, ...sendHeaders } = headers;
      let res: HttpResponse;
      try {
        res = await send({ method, url: url.toString(), headers: { ...sendHeaders, ...signed.add }, ...(opts.body ? { body: opts.body } : {}) }, this.sendOptions(opts.maxBytes));
      } catch (err) {
        throw transportError(this.o.service, err);
      }
      // The bucket is in another region than the one asked: S3 says which, once.
      if (!this.o.endpoint && attempt === 0 && (res.status === 301 || res.status === 400)) {
        const actual = res.headers.get('x-amz-bucket-region') ?? xmlText(res.body.toString('utf8'), 'Region');
        if (actual && actual !== region) {
          this.region = actual;
          continue;
        }
      }
      return res;
    }
  }

  private fail(op: Op, res: HttpResponse, key: string | null): never {
    const text = res.body.toString('utf8');
    const code = xmlText(text, 'Code') ?? (res.status === 404 ? 'NoSuchKey' : res.status === 403 ? 'AccessDenied' : `HTTP ${res.status}`);
    const message = xmlText(text, 'Message');
    const where = `${this.location.bucket}${key !== null ? `/${objectKey(this.location, key)}` : ''}`;
    switch (code) {
      case 'AccessDenied':
      case 'AllAccessDisabled':
        throw new StoreError('denied', `${this.o.service} refused to let these credentials ${OP_WORDS[op]} ${where}: access denied. Ask your cloud admin for the access that shadowlap store policy prints.`, res.status);
      case 'NoSuchBucket':
        throw new StoreError('no-bucket', `The bucket ${this.location.bucket} doesn't exist${this.o.endpoint ? '' : ` (looked in ${this.region ?? 'us-east-1'})`}. Check the name in shadowlap store set.`, res.status);
      case 'InvalidAccessKeyId':
        throw new StoreError('credentials', `${this.o.service} doesn't know this access key. Check your credentials.`, res.status);
      case 'SignatureDoesNotMatch':
        throw new StoreError('credentials', `${this.o.service} says the secret key doesn't match the access key. Check your credentials.`, res.status);
      case 'ExpiredToken':
      case 'TokenRefreshRequired':
      case 'InvalidToken':
        throw new StoreError('credentials', `The session credentials expired or aren't valid: sign in again (aws sso login, or new temporary keys).`, res.status);
      case 'PreconditionFailed':
      case 'ConditionalRequestConflict':
        throw new StoreError('precondition', `${where} changed while it was being written`, res.status);
      default:
        throw new StoreError('service', `${this.o.service} couldn't ${OP_WORDS[op]} ${where}: ${code}${message ? ` (${message})` : ''}`, res.status);
    }
  }

  async get(key: string, options: { maxBytes?: number } = {}): Promise<GetResult | null> {
    const res = await this.request('read', 'GET', objectKey(this.location, key), '', options.maxBytes ? { maxBytes: options.maxBytes } : {});
    if (res.status === 404 && xmlText(res.body.toString('utf8'), 'Code') !== 'NoSuchBucket') return null;
    if (res.status !== 200) this.fail('read', res, key);
    return { body: res.body, version: res.headers.get('etag') };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const res = await this.request('read', 'HEAD', objectKey(this.location, key), '');
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail('read', res, key);
    const modified = Date.parse(res.headers.get('last-modified') ?? '');
    return { key, size: Number(res.headers.get('content-length') ?? 0), version: res.headers.get('etag'), modified: Number.isFinite(modified) ? modified : null };
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<PutResult> {
    const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/octet-stream' };
    const md5 = contentMd5(body);
    if (md5) headers['content-md5'] = md5;
    if (this.conditional && options.ifMatch) headers['if-match'] = options.ifMatch;
    if (this.conditional && options.ifNoneMatch) headers['if-none-match'] = '*';
    let res = await this.request('write', 'PUT', objectKey(this.location, key), '', { body, headers, maxBytes: 64 * 1024 });
    // A store without conditional writes: write anyway, as every write did before S3 had them.
    if (res.status === 501 && (headers['if-match'] || headers['if-none-match'])) {
      this.conditional = false;
      delete headers['if-match'];
      delete headers['if-none-match'];
      res = await this.request('write', 'PUT', objectKey(this.location, key), '', { body, headers, maxBytes: 64 * 1024 });
    }
    if (res.status === 412 || res.status === 409) this.fail('write', { ...res, body: Buffer.from('<Error><Code>PreconditionFailed</Code></Error>') }, key);
    if (res.status !== 200) this.fail('write', res, key);
    const versionId = res.headers.get('x-amz-version-id');
    return {
      version: res.headers.get('etag'),
      versionId: versionId && versionId !== 'null' ? versionId : null,
      encryption: res.headers.get('x-amz-server-side-encryption') ?? this.o.alwaysEncrypted ?? null,
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('delete', 'DELETE', objectKey(this.location, key), '', { maxBytes: 64 * 1024 });
    if (res.status === 404 && xmlText(res.body.toString('utf8'), 'Code') !== 'NoSuchBucket') return;
    if (res.status !== 204 && res.status !== 200) this.fail('delete', res, key);
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const full = objectKey(this.location, prefix);
    const strip = this.location.prefix ? this.location.prefix.length + 1 : 0;
    let token: string | null = null;
    for (;;) {
      const params = [`list-type=2`, `max-keys=1000`, `prefix=${encodeRfc3986(full)}`, ...(token ? [`continuation-token=${encodeRfc3986(token)}`] : [])];
      const res = await this.request('list', 'GET', null, params.join('&'), { maxBytes: 32 * 1024 * 1024 });
      if (res.status !== 200) this.fail('list', res, null);
      const xml = res.body.toString('utf8');
      for (const c of xmlBlocks(xml, 'Contents')) {
        const k = xmlText(c, 'Key');
        if (k === null || !k.startsWith(full)) continue;
        const modified = Date.parse(xmlText(c, 'LastModified') ?? '');
        yield { key: k.slice(strip), size: Number(xmlText(c, 'Size') ?? 0), version: xmlText(c, 'ETag'), modified: Number.isFinite(modified) ? modified : null };
      }
      token = xmlText(xml, 'IsTruncated') === 'true' ? xmlText(xml, 'NextContinuationToken') : null;
      if (!token) return;
    }
  }

  async presign(key: string, expiresSeconds: number): Promise<SignedLink> {
    const seconds = Math.min(Math.max(1, Math.floor(expiresSeconds)), 604_800);
    const credentials = await this.o.credentials();
    const { origin, bucketPath } = await this.base();
    const url = new URL(`${origin}${bucketPath}/${encodeKeyPath(objectKey(this.location, key))}`);
    const now = this.o.now?.() ?? Date.now();
    const region = this.o.endpoint ? (this.o.region ?? 'us-east-1') : await this.resolvedRegion();
    const signed = presignRequest({ method: 'GET', path: url.pathname, query: '', headers: { host: url.host }, payloadHash: UNSIGNED_PAYLOAD }, { region, service: 's3', date: new Date(now), credentials }, seconds);
    let expiresAt = now + seconds * 1000;
    let note: string | null = null;
    if (credentials.sessionToken) {
      if (credentials.expiresAt !== undefined && credentials.expiresAt < expiresAt) {
        expiresAt = credentials.expiresAt;
        note = `It was signed with temporary credentials (${credentials.source}), so it stops working when they expire, at ${new Date(expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. For a 7-day link, share from long-lived credentials.`;
      } else if (credentials.expiresAt === undefined) {
        note = `It was signed with temporary credentials (${credentials.source}), so it stops working when they expire, which may be before the 7 days are up.`;
      }
    }
    return { url: `${url.origin}${url.pathname}?${signed.query}`, expiresAt, note };
  }

  async bucketInfo(): Promise<BucketInfo> {
    const notes: string[] = [];
    let versioning: BucketInfo['versioning'] = 'unknown';
    let encryption: string | null = this.o.alwaysEncrypted ?? null;
    let objectLock: ObjectLock = { state: 'unavailable', detail: null };
    if (!this.o.versioning) versioning = 'unavailable';
    else {
      const res = await this.request('check', 'GET', null, 'versioning=', { maxBytes: 64 * 1024 });
      if (res.status === 200) {
        const status = xmlText(res.body.toString('utf8'), 'Status');
        versioning = status === 'Enabled' ? 'on' : status === 'Suspended' ? 'suspended' : 'off';
      } else if (res.status === 403) notes.push(`versioning: these credentials can't read the bucket's versioning setting (s3:GetBucketVersioning)`);
      else if (res.status === 501) versioning = 'unavailable';
    }
    if (this.o.versioning && this.o.objectLock) {
      const res = await this.request('check', 'GET', null, 'object-lock=', { maxBytes: 64 * 1024 });
      if (res.status === 200) {
        const xml = res.body.toString('utf8');
        const retention = retentionOf(xml);
        if (xmlText(xml, 'ObjectLockEnabled') !== 'Enabled') objectLock = { state: 'off', detail: null };
        else objectLock = retention ? { state: 'on', detail: retention } : { state: 'off', detail: "on for the bucket, but with no default retention, so new objects aren't locked" };
      } else if (res.status === 404) objectLock = { state: 'off', detail: null };
      else if (res.status === 403) {
        objectLock = { state: 'unknown', detail: null };
        notes.push(`object lock: these credentials can't read the bucket's Object Lock setting (s3:GetBucketObjectLockConfiguration)`);
      }
    }
    if (!this.o.alwaysEncrypted) {
      const res = await this.request('check', 'GET', null, 'encryption=', { maxBytes: 64 * 1024 });
      if (res.status === 200) {
        const xml = res.body.toString('utf8');
        const alg = xmlText(xml, 'SSEAlgorithm');
        const kms = xmlText(xml, 'KMSMasterKeyID');
        encryption = alg ? `${alg}${kms ? ` (${kms})` : ''}` : null;
      } else if (res.status === 403) notes.push(`encryption: these credentials can't read the bucket's default encryption (s3:GetEncryptionConfiguration)`);
      else if (res.status === 404) encryption = null;
    }
    return { versioning, encryption, objectLock, notes };
  }
}
