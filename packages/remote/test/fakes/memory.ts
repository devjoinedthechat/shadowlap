import { StoreError, type BucketInfo, type GetResult, type ObjectInfo, type ObjectStore, type PutOptions, type PutResult, type SignedLink, type StoreLocation } from '../../src/index.js';

/**
 * An object store in memory with the semantics the drivers give: conditional writes, a new version
 * per write, listing in key order under a prefix. For tests of push, pull and the CLI that are about
 * what is stored, not about one cloud's wire format.
 */
export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; version: string; contentType: string }>();
  readonly log: Array<{ op: 'get' | 'head' | 'put' | 'delete' | 'list'; key: string }> = [];
  private seq = 0;
  /** Called before a write; a test throws from it to simulate a failure or a race. */
  beforePut: ((key: string) => void) | null = null;

  constructor(readonly location: StoreLocation) {}

  async credentials(): Promise<string> {
    return 'memory';
  }

  async get(key: string): Promise<GetResult | null> {
    this.log.push({ op: 'get', key });
    const o = this.objects.get(key);
    return o ? { body: Buffer.from(o.body), version: o.version } : null;
  }

  async head(key: string): Promise<ObjectInfo | null> {
    this.log.push({ op: 'head', key });
    const o = this.objects.get(key);
    return o ? { key, size: o.body.length, version: o.version, modified: null } : null;
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<PutResult> {
    this.log.push({ op: 'put', key });
    this.beforePut?.(key);
    const existing = this.objects.get(key);
    if (options.ifNoneMatch && existing) throw new StoreError('precondition', `${key} exists`, 412);
    if (options.ifMatch && existing?.version !== options.ifMatch) throw new StoreError('precondition', `${key} changed`, 412);
    const version = `v${++this.seq}`;
    this.objects.set(key, { body: Buffer.from(body), version, contentType: options.contentType ?? 'application/octet-stream' });
    return { version, versionId: null, encryption: 'memory' };
  }

  async delete(key: string): Promise<void> {
    this.log.push({ op: 'delete', key });
    this.objects.delete(key);
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    this.log.push({ op: 'list', key: prefix });
    for (const key of [...this.objects.keys()].sort()) if (key.startsWith(prefix)) yield { key, size: this.objects.get(key)!.body.length, version: this.objects.get(key)!.version, modified: null };
  }

  async presign(key: string, expiresSeconds: number): Promise<SignedLink> {
    return { url: `memory://${this.location.bucket}/${key}?expires=${expiresSeconds}`, expiresAt: Date.now() + expiresSeconds * 1000, note: null };
  }

  async bucketInfo(): Promise<BucketInfo> {
    return { versioning: 'on', encryption: 'memory', objectLock: { state: 'on', detail: 'memory' }, notes: [] };
  }

  /** Keys under a folder, for assertions. */
  keysUnder(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
