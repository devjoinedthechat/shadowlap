import { messageOf, ulid } from '@shadowlap/engine';
import { keys } from './layout.js';
import { StoreError, type ObjectLock, type ObjectStore, type PutResult, type StoreErrorCode, type Versioning } from './object-store.js';
import type { StoreLocation } from './url.js';

/**
 * `shadowlap store check`: proves the credentials on this machine can do what push and pull need
 * (list, write, read and delete a small test object in the store's folder) and reports how the
 * bucket keeps what is written to it: encryption at rest, whether versioning is on, and whether an
 * object lock keeps those versions, with a warning when either is off. Anyone allowed to write to the
 * bucket can change a run's record there; versions and a lock are what keep its earlier state.
 */

export type CheckStepName = 'list' | 'write' | 'read' | 'delete';

export interface CheckStep {
  name: CheckStepName;
  ok: boolean;
  /** Why it failed, in words; null when it worked. */
  detail: string | null;
  /** What kind of failure it was (credentials, access, the network…), when the store said; null otherwise. */
  code: StoreErrorCode | null;
}

export interface StoreCheck {
  url: string;
  /** Where the credentials came from, or null when none were found. */
  credentials: string | null;
  steps: CheckStep[];
  /** List, write, read and delete all work. */
  ok: boolean;
  encryption: string | null;
  versioning: Versioning;
  objectLock: ObjectLock;
  warnings: string[];
  /** What couldn't be checked, and why. */
  notes: string[];
  /** The kind of the first failure, to say what to do about it; null when the check passed. */
  failure: StoreErrorCode | 'other' | null;
}

/** How to turn versioning on, per provider. */
export function versioningHint(loc: StoreLocation): string {
  switch (loc.provider) {
    case 's3':
      return loc.endpoint ? "Turn it on in the store's own settings." : `Turn it on: aws s3api put-bucket-versioning --bucket ${loc.bucket} --versioning-configuration Status=Enabled`;
    case 'gcs':
      return `Turn it on: gcloud storage buckets update gs://${loc.bucket} --versioning`;
    case 'azure':
      return `Turn it on: az storage account blob-service-properties update --account-name ${loc.account!} --enable-versioning true`;
    case 'r2':
      return 'R2 keeps no versions; keep a copy elsewhere if the runs matter beyond the bucket.';
  }
}

/** How to turn an object lock on, per provider. */
export function objectLockHint(loc: StoreLocation): string {
  switch (loc.provider) {
    case 's3':
      return loc.endpoint
        ? "Turn it on in the store's own settings, if it has an object lock."
        : `Turn it on, with versioning on first: aws s3api put-object-lock-configuration --bucket ${loc.bucket} --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":30}}}'`;
    case 'gcs':
      return `Turn on soft delete, which keeps deleted and replaced objects: gcloud storage buckets update gs://${loc.bucket} --soft-delete-duration=30d`;
    case 'azure':
      return "Turn on version-level immutability for the container, with a time-based retention policy, in the storage account's data protection settings.";
    case 'r2':
      return 'R2 has no object lock.';
  }
}

function message(err: unknown): string {
  return messageOf(err);
}

function codeOf(err: unknown): StoreErrorCode | null {
  return err instanceof StoreError ? err.code : null;
}

export async function checkStore(remote: ObjectStore, options: { now?: () => number } = {}): Promise<StoreCheck> {
  const loc = remote.location;
  const result: StoreCheck = { url: loc.url, credentials: null, steps: [], ok: false, encryption: null, versioning: 'unknown', objectLock: { state: 'unknown', detail: null }, warnings: [], notes: [], failure: null };
  try {
    result.credentials = await remote.credentials();
  } catch (err) {
    for (const name of ['list', 'write', 'read', 'delete'] as const) result.steps.push({ name, ok: false, detail: name === 'list' ? message(err) : 'not tried', code: name === 'list' ? (codeOf(err) ?? 'credentials') : null });
    result.failure = codeOf(err) ?? 'credentials';
    return result;
  }
  const step = async (name: CheckStepName, fn: () => Promise<string | null>): Promise<boolean> => {
    try {
      const problem = await fn();
      result.steps.push({ name, ok: problem === null, detail: problem, code: null });
      if (problem !== null) result.failure ??= 'other';
      return problem === null;
    } catch (err) {
      result.steps.push({ name, ok: false, detail: message(err), code: codeOf(err) });
      result.failure ??= codeOf(err) ?? 'other';
      return false;
    }
  };
  const id = ulid(options.now?.() ?? Date.now());
  const key = keys.check(id);
  const body = Buffer.from(`shadowlap store check ${id}\n`, 'utf8');
  let written: PutResult | null = null;
  const listed = await step('list', async () => {
    for await (const _ of remote.list('')) break;
    return null;
  });
  const wrote = await step('write', async () => {
    written = await remote.put(key, body, { contentType: 'text/plain; charset=utf-8' });
    return null;
  });
  const read = wrote
    ? await step('read', async () => {
        const got = await remote.get(key, { maxBytes: 64 * 1024 });
        if (!got) return 'the object just written is not there';
        return got.body.equals(body) ? null : 'the object read back differs from what was written';
      })
    : (result.steps.push({ name: 'read', ok: false, detail: 'not tried: the write failed', code: null }), false);
  const deleted = wrote
    ? await step('delete', async () => {
        await remote.delete(key);
        return (await remote.head(key)) ? 'the object is still there after deleting it' : null;
      })
    : (result.steps.push({ name: 'delete', ok: false, detail: 'not tried: the write failed', code: null }), false);
  result.ok = listed && wrote && read && deleted;

  try {
    const info = await remote.bucketInfo();
    result.versioning = info.versioning;
    result.encryption = info.encryption;
    result.objectLock = info.objectLock;
    result.notes.push(...info.notes);
  } catch (err) {
    result.notes.push(`bucket settings: ${message(err)}`);
  }
  const w = written as PutResult | null;
  // The bucket's default says more (the KMS key, the provider's note); the write's header is the fallback.
  if (!result.encryption && w?.encryption) result.encryption = w.encryption;
  if (result.versioning === 'unknown' && w) {
    // A versioned bucket names the version it kept; S3 and Azure say nothing when versioning is off.
    if (w.versionId) result.versioning = 'on';
    else if (loc.provider === 'azure' || loc.provider === 's3') result.versioning = 'off';
  }
  if (result.versioning === 'off') result.warnings.push(`Versioning is off: a run deleted or overwritten in the bucket can't be recovered. ${versioningHint(loc)}`);
  else if (result.versioning === 'suspended') result.warnings.push(`Versioning is suspended: new writes keep no older versions. ${versioningHint(loc)}`);
  else if (result.versioning === 'unavailable') result.warnings.push(`This store has no object versioning: a run deleted in the bucket can't be recovered. ${versioningHint(loc)}`);
  const lock = result.objectLock;
  if (lock.state === 'off') result.warnings.push(`Object lock is off${lock.detail ? ` (${lock.detail})` : ''}: anyone allowed to delete in the bucket can remove a run's earlier versions for good. ${objectLockHint(loc)}`);
  else if (lock.state === 'unavailable' && result.versioning !== 'unavailable') result.notes.push(`This store has no object lock that shadowlap can read: check the bucket's own retention settings.`);
  if (result.ok && !result.encryption) result.warnings.push("The store didn't say it encrypts objects at rest. Check the bucket's encryption settings.");
  return result;
}
