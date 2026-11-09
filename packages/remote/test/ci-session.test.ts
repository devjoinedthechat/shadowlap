// The newest test session CI pushed, as a pull keeps it for Settings → CI's line under Your workflow:
// only a report a CI job wrote counts, the next pull reads only what came since, and nothing here
// ever fails a pull.
import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { ciSessionOf, lastCiSession, parseStoreUrl, pullCiSession, storeKey } from '@shadowlap/remote';
import { MemoryStore } from './fakes/memory.js';

const loc = parseStoreUrl('s3://agent-runs/team');
const KEY = storeKey(loc);
const ulid = (n: number) => `tests/01JABCDEFGHJKMNPQRSTVWXY${String(n).padStart(2, '0')}.json`;
const doc = (o: { ci?: string; session?: string; verdicts?: string[]; at?: number }) =>
  JSON.stringify({ format: 'shadowlap-store-tests', version: 1, at: o.at ?? 1, by: 'ci', ...(o.ci ? { ci: o.ci } : {}), report: { session: o.session ?? null, revision: 'd2e8a1f', results: (o.verdicts ?? []).map((verdict) => ({ verdict })) } });

describe('the newest session CI pushed', () => {
  it('reads a report only when a CI job wrote it, counting its goldens by verdict', () => {
    expect(ciSessionOf(doc({ ci: 'gitlab', session: 'S1', verdicts: ['passed', 'failed', 'inconclusive', 'passed'], at: 5 }))).toEqual({ ci: 'gitlab', session: 'S1', revision: 'd2e8a1f', at: 5, passed: 2, failed: 1, inconclusive: 1 });
    expect(ciSessionOf(doc({ session: 'S1' }))).toBeNull();
    expect(ciSessionOf('{"format":"shadowlap-store-tests","version":2,"at":1,"ci":"github","report":{"results":[]}}')).toBeNull();
    expect(ciSessionOf('not json')).toBeNull();
  });

  it('keeps the newest CI report, then lists only the reports after the newest it listed', async () => {
    const store = Store.open(':memory:');
    const remote = new MemoryStore(loc);
    const put = (n: number, body: string) => remote.put(ulid(n), Buffer.from(body));
    await put(1, doc({ ci: 'github', session: 'S1', verdicts: ['passed'] }));
    await put(2, doc({ ci: 'github', session: 'S2', verdicts: ['failed'] }));
    await put(3, doc({ session: 'mine' }));
    await remote.put('tests/notes.txt', Buffer.from('x'));
    expect(await pullCiSession(store, remote, KEY)).toMatchObject({ session: 'S2', failed: 1 });
    // The person's report, newest, was read first and passed over; the older CI one was never needed.
    expect(remote.log.filter((l) => l.op === 'get').map((l) => l.key)).toEqual([ulid(3), ulid(2)]);
    remote.log.length = 0;
    await put(4, doc({ session: 'mine again' }));
    expect(await pullCiSession(store, remote, KEY)).toMatchObject({ session: 'S2' });
    expect(remote.log.filter((l) => l.op === 'get').map((l) => l.key)).toEqual([ulid(4)]);
    remote.log.length = 0;
    expect(await pullCiSession(store, remote, KEY)).toMatchObject({ session: 'S2' });
    expect(remote.log.filter((l) => l.op === 'get')).toEqual([]);
    expect(lastCiSession(store, KEY)).toMatchObject({ session: 'S2', ci: 'github' });
    store.close();
  });

  it('keeps what an earlier pull saw when the store is out of reach', async () => {
    const store = Store.open(':memory:');
    const remote = new MemoryStore(loc);
    await remote.put(ulid(1), Buffer.from(doc({ ci: 'github', session: 'S1' })));
    await pullCiSession(store, remote, KEY);
    remote.list = () => {
      throw new Error('network down');
    };
    expect(await pullCiSession(store, remote, KEY)).toMatchObject({ session: 'S1' });
    expect(lastCiSession(store, 'another store')).toBeNull();
    store.close();
  });
});
