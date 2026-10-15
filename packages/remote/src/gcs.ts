import { createSign } from 'node:crypto';
import type { GoogleToken } from './gcp-auth.js';
import { send, type FetchLike, type HttpResponse } from './http.js';
import { StoreError, transportError, type BucketInfo, type GetResult, type ObjectInfo, type ObjectLock, type ObjectStore, type PutOptions, type PutResult, type SignedLink } from './object-store.js';
import { amzDate, canonicalRequest, sha256Hex, UNSIGNED_PAYLOAD } from './sigv4.js';
import { encodeKeyPath, encodeRfc3986, objectKey, type StoreLocation } from './url.js';

/**
 * Google Cloud Storage through its JSON API, with an OAuth token from Application Default
 * Credentials. Share links are V4 signed URLs, which need a key to sign them: a service-account key
 * here, or HMAC keys through the S3-compatible API (gs://…?auth=hmac).
 */

export interface GcsOptions {
  location: StoreLocation;
  token: () => Promise<GoogleToken>;
  /** https://storage.googleapis.com, or an emulator's address. */
  endpoint: string;
  fetch?: FetchLike;
  now?: () => number;
  retryDelayMs?: number;
}

type Op = 'list' | 'read' | 'write' | 'delete' | 'check';
const OP_WORDS: Record<Op, string> = { list: 'list objects in', read: 'read from', write: 'write to', delete: 'delete from', check: 'read the settings of' };
const MAX_OBJECT = 512 * 1024 * 1024;

function days(seconds: string | undefined): number {
  const n = Number(seconds ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n / 86_400)) : 0;
}

/**
 * Cloud Storage's object lock, as far as a team store goes: a retention policy (Bucket Lock) keeps
 * every object for its period, and soft delete keeps what was deleted or replaced for its own. Either
 * keeps a run's earlier state from being removed outright.
 */
function gcsObjectLock(retention: { retentionPeriod?: string; isLocked?: boolean } | undefined, softDelete: { retentionDurationSeconds?: string } | undefined): ObjectLock {
  const kept: string[] = [];
  const policy = days(retention?.retentionPeriod);
  if (policy) kept.push(`retention policy, ${policy} day${policy === 1 ? '' : 's'}${retention?.isLocked ? ', locked' : ''}`);
  const soft = days(softDelete?.retentionDurationSeconds);
  if (soft) kept.push(`soft delete, ${soft} day${soft === 1 ? '' : 's'}`);
  return kept.length ? { state: 'on', detail: kept.join('; ') } : { state: 'off', detail: null };
}
/** What Cloud Storage says when the bucket itself is missing; a missing object says "No such object". */
const NO_BUCKET = /bucket does not exist/i;

export class GcsStore implements ObjectStore {
  readonly location: StoreLocation;

  constructor(private readonly o: GcsOptions) {
    this.location = o.location;
  }

  async credentials(): Promise<string> {
    return (await this.o.token()).source;
  }

  private async call(op: Op, method: string, url: string, opts: { body?: Buffer; headers?: Record<string, string>; maxBytes?: number } = {}): Promise<HttpResponse> {
    const token = await this.o.token();
    try {
      return await send(
        () => ({ method, url, headers: { ...(token.accessToken ? { authorization: `Bearer ${token.accessToken}` } : {}), ...(opts.headers ?? {}) }, ...(opts.body ? { body: opts.body } : {}) }),
        { ...(this.o.fetch ? { fetch: this.o.fetch } : {}), maxBytes: opts.maxBytes ?? MAX_OBJECT, ...(this.o.retryDelayMs !== undefined ? { retryDelayMs: this.o.retryDelayMs } : {}) },
      );
    } catch (err) {
      throw transportError('Google Cloud Storage', err);
    }
  }

  private objectUrl(key: string, query = ''): string {
    return `${this.o.endpoint}/storage/v1/b/${encodeRfc3986(this.location.bucket)}/o/${encodeRfc3986(objectKey(this.location, key))}${query ? `?${query}` : ''}`;
  }

  private fail(op: Op, res: HttpResponse, key: string | null): never {
    let message = '';
    try {
      message = String(((JSON.parse(res.body.toString('utf8')) as { error?: { message?: string } }).error?.message) ?? '');
    } catch {
      // not JSON
    }
    const where = `${this.location.bucket}${key !== null ? `/${objectKey(this.location, key)}` : ''}`;
    if (res.status === 401) throw new StoreError('credentials', `Google Cloud Storage didn't accept the sign-in: ${message || 'unauthorized'}. Sign in again: gcloud auth application-default login`, 401);
    if (res.status === 403) throw new StoreError('denied', `Google Cloud Storage refused to let these credentials ${OP_WORDS[op]} ${where}: ${message || 'access denied'}. Ask your cloud admin for the access that shadowlap store policy prints.`, 403);
    if (res.status === 404 && NO_BUCKET.test(message || res.body.toString('utf8'))) throw new StoreError('no-bucket', `The bucket ${this.location.bucket} doesn't exist. Check the name in shadowlap store set.`, 404);
    if (res.status === 412) throw new StoreError('precondition', `${where} changed while it was being written`, 412);
    throw new StoreError('service', `Google Cloud Storage couldn't ${OP_WORDS[op]} ${where}: ${res.status}${message ? ` (${message})` : ''}`, res.status);
  }

  async get(key: string, options: { maxBytes?: number } = {}): Promise<GetResult | null> {
    const res = await this.call('read', 'GET', this.objectUrl(key, 'alt=media'), options.maxBytes ? { maxBytes: options.maxBytes } : {});
    if (res.status === 404 && !NO_BUCKET.test(res.body.toString('utf8'))) return null;
    if (res.status !== 200) this.fail('read', res, key);
    return { body: res.body, version: res.headers.get('x-goog-generation') };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const res = await this.call('read', 'GET', this.objectUrl(key, 'fields=size%2Cgeneration%2Cupdated'), { maxBytes: 64 * 1024 });
    if (res.status === 404 && !NO_BUCKET.test(res.body.toString('utf8'))) return null;
    if (res.status !== 200) this.fail('read', res, key);
    const j = JSON.parse(res.body.toString('utf8')) as { size?: string; generation?: string; updated?: string };
    const modified = Date.parse(j.updated ?? '');
    return { key, size: Number(j.size ?? 0), version: j.generation ?? null, modified: Number.isFinite(modified) ? modified : null };
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<PutResult> {
    const q = [`uploadType=media`, `name=${encodeRfc3986(objectKey(this.location, key))}`];
    if (options.ifNoneMatch) q.push('ifGenerationMatch=0');
    else if (options.ifMatch) q.push(`ifGenerationMatch=${encodeRfc3986(options.ifMatch)}`);
    const url = `${this.o.endpoint}/upload/storage/v1/b/${encodeRfc3986(this.location.bucket)}/o?${q.join('&')}`;
    const res = await this.call('write', 'POST', url, { body, headers: { 'content-type': options.contentType ?? 'application/octet-stream' }, maxBytes: 1024 * 1024 });
    if (res.status !== 200) this.fail('write', res, key);
    const j = JSON.parse(res.body.toString('utf8')) as { generation?: string; kmsKeyName?: string };
    return { version: j.generation ?? null, versionId: null, encryption: j.kmsKeyName ? `Cloud KMS (${j.kmsKeyName})` : 'Google-managed' };
  }

  async delete(key: string): Promise<void> {
    const res = await this.call('delete', 'DELETE', this.objectUrl(key), { maxBytes: 64 * 1024 });
    if (res.status === 404 && !NO_BUCKET.test(res.body.toString('utf8'))) return;
    if (res.status !== 204 && res.status !== 200) this.fail('delete', res, key);
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const full = objectKey(this.location, prefix);
    const strip = this.location.prefix ? this.location.prefix.length + 1 : 0;
    let page: string | null = null;
    for (;;) {
      const q = [`prefix=${encodeRfc3986(full)}`, 'maxResults=1000', `fields=${encodeRfc3986('items(name,size,generation,updated),nextPageToken')}`, ...(page ? [`pageToken=${encodeRfc3986(page)}`] : [])];
      const res = await this.call('list', 'GET', `${this.o.endpoint}/storage/v1/b/${encodeRfc3986(this.location.bucket)}/o?${q.join('&')}`, { maxBytes: 32 * 1024 * 1024 });
      if (res.status !== 200) this.fail('list', res, null);
      const j = JSON.parse(res.body.toString('utf8')) as { items?: Array<{ name: string; size?: string; generation?: string; updated?: string }>; nextPageToken?: string };
      for (const item of j.items ?? []) {
        if (!item.name.startsWith(full)) continue;
        const modified = Date.parse(item.updated ?? '');
        yield { key: item.name.slice(strip), size: Number(item.size ?? 0), version: item.generation ?? null, modified: Number.isFinite(modified) ? modified : null };
      }
      page = j.nextPageToken ?? null;
      if (!page) return;
    }
  }

  /** A V4 signed URL (GOOG4-RSA-SHA256), signed with a service account's key. */
  async presign(key: string, expiresSeconds: number): Promise<SignedLink> {
    const token = await this.o.token();
    if (!token.signer) {
      throw new StoreError(
        'unsupported',
        `A share link on Google Cloud is signed with a key, and ${token.source} has none to sign with. Use a service-account key (GOOGLE_APPLICATION_CREDENTIALS) or HMAC keys (gs://${this.location.bucket}${this.location.prefix ? `/${this.location.prefix}` : ''}?auth=hmac).`,
      );
    }
    const seconds = Math.min(Math.max(1, Math.floor(expiresSeconds)), 604_800);
    const now = this.o.now?.() ?? Date.now();
    const date = new Date(now);
    const stamp = amzDate(date);
    const scope = `${stamp.slice(0, 8)}/auto/storage/goog4_request`;
    const base = new URL(this.o.endpoint);
    const path = `/${encodeRfc3986(this.location.bucket)}/${encodeKeyPath(objectKey(this.location, key))}`;
    const params: Array<[string, string]> = [
      ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
      ['X-Goog-Credential', `${token.signer.email}/${scope}`],
      ['X-Goog-Date', stamp],
      ['X-Goog-Expires', String(seconds)],
      ['X-Goog-SignedHeaders', 'host'],
    ];
    const query = params.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&');
    const canon = canonicalRequest({ method: 'GET', path, query, headers: { host: base.host }, payloadHash: UNSIGNED_PAYLOAD }, false);
    const toSign = ['GOOG4-RSA-SHA256', stamp, scope, sha256Hex(canon.text)].join('\n');
    const signature = createSign('RSA-SHA256').update(toSign).sign(token.signer.privateKey, 'hex');
    return { url: `${base.protocol}//${base.host}${path}?${query}&X-Goog-Signature=${signature}`, expiresAt: now + seconds * 1000, note: null };
  }

  async bucketInfo(): Promise<BucketInfo> {
    const fields = encodeRfc3986('versioning,encryption,retentionPolicy,softDeletePolicy');
    const res = await this.call('check', 'GET', `${this.o.endpoint}/storage/v1/b/${encodeRfc3986(this.location.bucket)}?fields=${fields}`, { maxBytes: 64 * 1024 });
    if (res.status === 403) {
      return {
        versioning: 'unknown',
        encryption: 'Google-managed (Cloud Storage encrypts every object)',
        objectLock: { state: 'unknown', detail: null },
        notes: [`versioning and object lock: these credentials can't read the bucket's settings (storage.buckets.get)`],
      };
    }
    if (res.status !== 200) this.fail('check', res, null);
    const j = JSON.parse(res.body.toString('utf8')) as {
      versioning?: { enabled?: boolean };
      encryption?: { defaultKmsKeyName?: string };
      retentionPolicy?: { retentionPeriod?: string; isLocked?: boolean };
      softDeletePolicy?: { retentionDurationSeconds?: string };
    };
    return {
      versioning: j.versioning?.enabled ? 'on' : 'off',
      encryption: j.encryption?.defaultKmsKeyName ? `Cloud KMS (${j.encryption.defaultKmsKeyName})` : 'Google-managed (Cloud Storage encrypts every object)',
      objectLock: gcsObjectLock(j.retentionPolicy, j.softDeletePolicy),
      notes: [],
    };
  }
}
