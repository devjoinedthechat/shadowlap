import { HttpError } from './http.js';
import type { StoreLocation } from './url.js';

/**
 * What every driver offers: a few operations on objects in the store's folder. Keys are relative to
 * the folder (`runs/01K…/run.json`); a driver adds the folder. Nothing here knows about runs.
 */

export interface ObjectInfo {
  /** Relative to the store's folder. */
  key: string;
  size: number;
  /** ETag (S3, Azure) or generation (GCS): what a conditional write compares. */
  version: string | null;
  /** ms, when the service says. */
  modified: number | null;
}

export interface PutOptions {
  contentType?: string;
  /** Write only if the object is still at this version. */
  ifMatch?: string;
  /** Write only if the object doesn't exist yet. */
  ifNoneMatch?: boolean;
}

export interface PutResult {
  version: string | null;
  /** The object version the service keeps when bucket versioning is on; null when it is off. */
  versionId: string | null;
  /** How the service says the object is encrypted at rest (AES256, aws:kms, …), when it says. */
  encryption: string | null;
}

export interface GetResult {
  body: Buffer;
  version: string | null;
}

export interface SignedLink {
  url: string;
  /** When the link stops working, ms. */
  expiresAt: number;
  /** Why it may stop earlier: temporary credentials sign links that end with them. */
  note: string | null;
}

export type Versioning = 'on' | 'off' | 'suspended' | 'unavailable' | 'unknown';

/**
 * Whether the bucket keeps what is written to it from being removed for a while, even by someone
 * allowed to delete: S3 Object Lock with a default retention, Cloud Storage's soft delete or a
 * retention policy, Azure's immutability policies. `detail` says which, and for how long.
 */
export interface ObjectLock {
  state: 'on' | 'off' | 'unavailable' | 'unknown';
  detail: string | null;
}

export interface BucketInfo {
  versioning: Versioning;
  /** Default encryption at rest as the service reports it; null when it can't be read. */
  encryption: string | null;
  objectLock: ObjectLock;
  /** Why something is unknown (a permission the check doesn't have). */
  notes: string[];
}

export interface ObjectStore {
  readonly location: StoreLocation;
  /** Where the credentials come from, in words: `AWS profile northwind`, `GOOGLE_APPLICATION_CREDENTIALS`. */
  credentials(): Promise<string>;
  get(key: string, options?: { maxBytes?: number }): Promise<GetResult | null>;
  head(key: string): Promise<ObjectInfo | null>;
  put(key: string, body: Buffer, options?: PutOptions): Promise<PutResult>;
  delete(key: string): Promise<void>;
  /** Every object under a sub-folder, in key order, page by page. */
  list(prefix: string): AsyncIterable<ObjectInfo>;
  /** A link anyone can open until it expires, without credentials. */
  presign(key: string, expiresSeconds: number): Promise<SignedLink>;
  bucketInfo(): Promise<BucketInfo>;
}

export type StoreErrorCode = 'denied' | 'no-bucket' | 'credentials' | 'precondition' | 'network' | 'too-large' | 'unsupported' | 'service';

/** A failure talking to the store, in words a person can act on. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly status: number | null;
  constructor(code: StoreErrorCode, message: string, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'StoreError';
  }
}

/**
 * A request that failed on its way: an answer larger than asked for is the object's problem
 * (`too-large`), anything else the network's.
 */
export function transportError(service: string, err: unknown): StoreError {
  return new StoreError(err instanceof HttpError && !err.network ? 'too-large' : 'network', `${service}: ${(err as Error).message}`);
}

/** A conditional write that lost the race: someone else wrote the object first. */
export function isPrecondition(err: unknown): boolean {
  return err instanceof StoreError && err.code === 'precondition';
}
