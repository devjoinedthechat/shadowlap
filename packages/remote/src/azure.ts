import { createHmac } from 'node:crypto';
import type { AzureAuth } from './azure-auth.js';
import { send, type FetchLike, type HttpResponse } from './http.js';
import { StoreError, transportError, type BucketInfo, type GetResult, type ObjectInfo, type ObjectStore, type PutOptions, type PutResult, type SignedLink } from './object-store.js';
import { encodeKeyPath, encodeRfc3986, objectKey, type StoreLocation } from './url.js';
import { xmlBlocks, xmlEscape, xmlText } from './xml.js';

/**
 * Azure Blob Storage through its REST API: Shared Key (an account key), a SAS token, or a Microsoft
 * Entra token. Share links are SAS URLs: a service SAS signed with the account key, or a user
 * delegation SAS when the credentials are an Entra sign-in.
 */

export const AZURE_VERSION = '2021-08-06';

export interface AzureOptions {
  location: StoreLocation;
  /** https://<account>.blob.core.windows.net, or Azurite's address with the account in the path. */
  endpoint: string;
  auth: AzureAuth;
  fetch?: FetchLike;
  now?: () => number;
  retryDelayMs?: number;
}

type Op = 'list' | 'read' | 'write' | 'delete' | 'check' | 'share';
const OP_WORDS: Record<Op, string> = { list: 'list blobs in', read: 'read from', write: 'write to', delete: 'delete from', check: 'read the settings of', share: 'make a share link for' };
const MAX_OBJECT = 512 * 1024 * 1024;
/** How much earlier than 7 days a link signed with a user delegation key ends, for clock skew. */
export const DELEGATION_MARGIN_S = 15 * 60;

/** The Shared Key string to sign (Blob service, version 2015-02-21 and later). */
export function sharedKeyStringToSign(method: string, url: URL, headers: Record<string, string>, account: string): string {
  const h = (name: string) => headers[name] ?? '';
  const length = h('content-length');
  const msHeaders = Object.keys(headers)
    .filter((k) => k.startsWith('x-ms-'))
    .sort()
    .map((k) => `${k}:${headers[k]!.replace(/\s+/g, ' ').trim()}\n`)
    .join('');
  const params = new Map<string, string[]>();
  for (const [k, v] of url.searchParams) {
    const name = k.toLowerCase();
    params.set(name, [...(params.get(name) ?? []), v]);
  }
  const resource =
    `/${account}${url.pathname}` +
    [...params.keys()]
      .sort()
      .map((k) => `\n${k}:${params.get(k)!.sort().join(',')}`)
      .join('');
  return [method, h('content-encoding'), h('content-language'), length === '0' ? '' : length, h('content-md5'), h('content-type'), '', h('if-modified-since'), h('if-match'), h('if-none-match'), h('if-unmodified-since'), h('range')].join('\n') + '\n' + msHeaders + resource;
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class AzureStore implements ObjectStore {
  readonly location: StoreLocation;
  private readonly account: string;

  constructor(private readonly o: AzureOptions) {
    this.location = o.location;
    this.account = o.location.account!;
  }

  async credentials(): Promise<string> {
    return this.o.auth.source;
  }

  private async call(op: Op, method: string, path: string, query: string, opts: { body?: Buffer; headers?: Record<string, string>; maxBytes?: number } = {}): Promise<HttpResponse> {
    const auth = this.o.auth;
    const sas = auth.kind === 'sas' ? auth.token : '';
    const q = [query, sas].filter(Boolean).join('&');
    const url = new URL(`${this.o.endpoint}${path}${q ? `?${q}` : ''}`);
    const build = async () => {
      const headers: Record<string, string> = { 'x-ms-date': new Date(this.o.now?.() ?? Date.now()).toUTCString(), 'x-ms-version': AZURE_VERSION, ...(opts.headers ?? {}) };
      if (opts.body) headers['content-length'] = String(opts.body.length);
      if (auth.kind === 'key') headers.authorization = `SharedKey ${this.account}:${createHmac('sha256', auth.key).update(sharedKeyStringToSign(method, url, headers, this.account), 'utf8').digest('base64')}`;
      else if (auth.kind === 'bearer') headers.authorization = `Bearer ${(await auth.token()).token}`;
      const { 'content-length': _len, ...sendHeaders } = headers;
      return { method, url: url.toString(), headers: sendHeaders, ...(opts.body ? { body: opts.body } : {}) };
    };
    try {
      return await send(build, { ...(this.o.fetch ? { fetch: this.o.fetch } : {}), maxBytes: opts.maxBytes ?? MAX_OBJECT, ...(this.o.retryDelayMs !== undefined ? { retryDelayMs: this.o.retryDelayMs } : {}) });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      throw transportError('Azure Blob Storage', err);
    }
  }

  private blobPath(key: string): string {
    return `/${encodeRfc3986(this.location.bucket)}/${encodeKeyPath(objectKey(this.location, key))}`;
  }

  private fail(op: Op, res: HttpResponse, key: string | null): never {
    const text = res.body.toString('utf8');
    const code = res.headers.get('x-ms-error-code') ?? xmlText(text, 'Code') ?? `HTTP ${res.status}`;
    const message = (xmlText(text, 'Message') ?? '').split('\n')[0];
    const where = `${this.account}/${this.location.bucket}${key !== null ? `/${objectKey(this.location, key)}` : ''}`;
    if (code === 'ContainerNotFound') throw new StoreError('no-bucket', `The container ${this.location.bucket} doesn't exist in the storage account ${this.account}. Check the name in shadowlap store set.`, res.status);
    if (code === 'AuthenticationFailed' || res.status === 401) throw new StoreError('credentials', `Azure didn't accept the credentials (${this.o.auth.source}): ${message || code}`, res.status);
    if (res.status === 403) throw new StoreError('denied', `Azure refused to let these credentials ${OP_WORDS[op]} ${where}: ${code}. Ask your cloud admin for the access that shadowlap store policy prints.`, res.status);
    if (res.status === 412 || code === 'ConditionNotMet' || code === 'BlobAlreadyExists') throw new StoreError('precondition', `${where} changed while it was being written`, res.status);
    throw new StoreError('service', `Azure couldn't ${OP_WORDS[op]} ${where}: ${code}${message ? ` (${message})` : ''}`, res.status);
  }

  async get(key: string, options: { maxBytes?: number } = {}): Promise<GetResult | null> {
    const res = await this.call('read', 'GET', this.blobPath(key), '', options.maxBytes ? { maxBytes: options.maxBytes } : {});
    if (res.status === 404 && res.headers.get('x-ms-error-code') !== 'ContainerNotFound') return null;
    if (res.status !== 200) this.fail('read', res, key);
    return { body: res.body, version: res.headers.get('etag') };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const res = await this.call('read', 'HEAD', this.blobPath(key), '');
    if (res.status === 404 && res.headers.get('x-ms-error-code') !== 'ContainerNotFound') return null;
    if (res.status !== 200) this.fail('read', res, key);
    const modified = Date.parse(res.headers.get('last-modified') ?? '');
    return { key, size: Number(res.headers.get('content-length') ?? 0), version: res.headers.get('etag'), modified: Number.isFinite(modified) ? modified : null };
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<PutResult> {
    const headers: Record<string, string> = { 'x-ms-blob-type': 'BlockBlob', 'content-type': options.contentType ?? 'application/octet-stream' };
    if (options.ifMatch) headers['if-match'] = options.ifMatch;
    if (options.ifNoneMatch) headers['if-none-match'] = '*';
    const res = await this.call('write', 'PUT', this.blobPath(key), '', { body, headers, maxBytes: 64 * 1024 });
    if (res.status !== 201 && res.status !== 200) this.fail('write', res, key);
    const scope = res.headers.get('x-ms-encryption-scope');
    return {
      version: res.headers.get('etag'),
      versionId: res.headers.get('x-ms-version-id'),
      encryption: res.headers.get('x-ms-request-server-encrypted') === 'true' ? (scope ? `encryption scope ${scope}` : 'Microsoft-managed keys') : null,
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.call('delete', 'DELETE', this.blobPath(key), '', { maxBytes: 64 * 1024 });
    if (res.status === 404 && res.headers.get('x-ms-error-code') !== 'ContainerNotFound') return;
    if (res.status !== 202 && res.status !== 200) this.fail('delete', res, key);
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const full = objectKey(this.location, prefix);
    const strip = this.location.prefix ? this.location.prefix.length + 1 : 0;
    let marker: string | null = null;
    for (;;) {
      const q = ['restype=container', 'comp=list', `prefix=${encodeRfc3986(full)}`, 'maxresults=5000', ...(marker ? [`marker=${encodeRfc3986(marker)}`] : [])].join('&');
      const res = await this.call('list', 'GET', `/${encodeRfc3986(this.location.bucket)}`, q, { maxBytes: 32 * 1024 * 1024 });
      if (res.status !== 200) this.fail('list', res, null);
      const xml = res.body.toString('utf8');
      for (const b of xmlBlocks(xml, 'Blob')) {
        const name = xmlText(b, 'Name');
        if (name === null || !name.startsWith(full)) continue;
        const modified = Date.parse(xmlText(b, 'Last-Modified') ?? '');
        yield { key: name.slice(strip), size: Number(xmlText(b, 'Content-Length') ?? 0), version: xmlText(b, 'Etag'), modified: Number.isFinite(modified) ? modified : null };
      }
      marker = xmlText(xml, 'NextMarker') || null;
      if (!marker) return;
    }
  }

  async presign(key: string, expiresSeconds: number): Promise<SignedLink> {
    const auth = this.o.auth;
    const now = this.o.now?.() ?? Date.now();
    const seconds = Math.min(Math.max(1, Math.floor(expiresSeconds)), 604_800);
    const st = isoSeconds(now - 5 * 60_000);
    const se = isoSeconds(now + seconds * 1000);
    const blob = objectKey(this.location, key);
    const resource = `/blob/${this.account}/${this.location.bucket}/${blob}`;
    const spr = this.o.endpoint.startsWith('https:') ? 'https' : 'https,http';
    const base = `${this.o.endpoint}${this.blobPath(key)}`;
    const qs = (pairs: Array<[string, string]>) => pairs.map(([k, v]) => `${k}=${encodeRfc3986(v)}`).join('&');
    if (auth.kind === 'key') {
      const toSign = ['r', st, se, resource, '', '', spr, AZURE_VERSION, 'b', '', '', '', '', '', '', ''].join('\n');
      const sig = createHmac('sha256', auth.key).update(toSign, 'utf8').digest('base64');
      return { url: `${base}?${qs([['sv', AZURE_VERSION], ['st', st], ['se', se], ['sr', 'b'], ['sp', 'r'], ['spr', spr], ['sig', sig]])}`, expiresAt: now + seconds * 1000, note: null };
    }
    if (auth.kind === 'sas') {
      throw new StoreError('unsupported', `A share link on Azure is signed with the account key or an Entra sign-in; a SAS token (${auth.source}) can't sign a new one. Use AZURE_STORAGE_KEY, or sign in with az login.`);
    }
    // An Entra sign-in: a user delegation key, then a SAS signed with it. Azure refuses a key that
    // ends more than 7 days from its own clock, so a link asked for the most ends a little earlier:
    // a clock here that runs a few minutes fast doesn't fail the share.
    const delegated = Math.min(seconds, 604_800 - DELEGATION_MARGIN_S);
    const dse = isoSeconds(now + delegated * 1000);
    const body = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${xmlEscape(st)}</Start><Expiry>${xmlEscape(dse)}</Expiry></KeyInfo>`, 'utf8');
    const res = await this.call('share', 'POST', '/', 'restype=service&comp=userdelegationkey', { body, headers: { 'content-type': 'application/xml' }, maxBytes: 64 * 1024 });
    if (res.status === 403) {
      const code = res.headers.get('x-ms-error-code') ?? xmlText(res.body.toString('utf8'), 'Code') ?? 'HTTP 403';
      throw new StoreError(
        'denied',
        `Azure didn't give these credentials (${auth.source}) a user delegation key, which a share link from an Entra sign-in is signed with: ${code}. That takes the Storage Blob Delegator role (or another with generateUserDelegationKey) on the storage account ${this.account} itself, not only on the container; shadowlap store policy prints the assignment.`,
        403,
      );
    }
    if (res.status !== 200) this.fail('share', res, key);
    const xml = res.body.toString('utf8');
    const k = (tag: string) => xmlText(xml, tag) ?? '';
    const skoid = k('SignedOid');
    const sktid = k('SignedTid');
    const skt = k('SignedStart');
    const ske = k('SignedExpiry');
    const sks = k('SignedService');
    const skv = k('SignedVersion');
    const value = k('Value');
    if (!value) throw new StoreError('service', 'Azure gave no user delegation key');
    const toSign = ['r', st, dse, resource, skoid, sktid, skt, ske, sks, skv, '', '', '', '', spr, AZURE_VERSION, 'b', '', '', '', '', '', '', ''].join('\n');
    const sig = createHmac('sha256', Buffer.from(value, 'base64')).update(toSign, 'utf8').digest('base64');
    const pairs: Array<[string, string]> = [
      ['sv', AZURE_VERSION],
      ['st', st],
      ['se', dse],
      ['sr', 'b'],
      ['sp', 'r'],
      ['spr', spr],
      ['skoid', skoid],
      ['sktid', sktid],
      ['skt', skt],
      ['ske', ske],
      ['sks', sks],
      ['skv', skv],
      ['sig', sig],
    ];
    return { url: `${base}?${qs(pairs)}`, expiresAt: now + delegated * 1000, note: null };
  }

  async bucketInfo(): Promise<BucketInfo> {
    // Versioning is an account setting the blob API doesn't read; the check learns it from a write.
    const encryption = 'Microsoft-managed keys (Azure Storage encrypts every blob)';
    // Immutability is the container's: its properties say whether a policy or a legal hold applies.
    const res = await this.call('check', 'GET', `/${encodeRfc3986(this.location.bucket)}`, 'restype=container', { maxBytes: 64 * 1024 });
    if (res.status === 403) return { versioning: 'unknown', encryption, objectLock: { state: 'unknown', detail: null }, notes: [`object lock: these credentials can't read the container's properties`] };
    if (res.status !== 200) this.fail('check', res, null);
    const yes = (name: string) => res.headers.get(name) === 'true';
    const kept = [
      yes('x-ms-immutable-storage-with-versioning-enabled') ? 'version-level immutability' : null,
      yes('x-ms-has-immutability-policy') ? 'an immutability policy' : null,
      yes('x-ms-has-legal-hold') ? 'a legal hold' : null,
    ].filter((x): x is string => x !== null);
    return { versioning: 'unknown', encryption, objectLock: kept.length ? { state: 'on', detail: kept.join(', ') } : { state: 'off', detail: null }, notes: [] };
  }
}
