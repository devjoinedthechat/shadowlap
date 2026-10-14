import { describe, expect, it } from 'vitest';
import { ciProvider, recordEvent, resolveAuthor, SCHEMA_VERSION, Store } from '../src/index.js';

describe('activity events', () => {
  it('stores events and lists them newest first, filtered and paged', () => {
    const store = Store.open(':memory:');
    expect(SCHEMA_VERSION).toBe(4);
    recordEvent(store, { kind: 'normalizer.added', actor: 'dana@example.com', data: { path: '$.metadata.user_id' }, at: 1000 });
    recordEvent(store, { kind: 'golden.packed', ref: 'goldens/refund-over-limit', runId: '01K5CQ4N7G0000000000000000', at: 2000 });
    recordEvent(store, { kind: 'normalizer.added', at: 3000 });

    const all = store.listEvents();
    expect(all.map((e) => e.at)).toEqual([3000, 2000, 1000]);
    expect(all[2]).toMatchObject({ kind: 'normalizer.added', actor: 'dana@example.com', runId: null, data: { path: '$.metadata.user_id' } });
    expect(all[1]).toMatchObject({ kind: 'golden.packed', ref: 'goldens/refund-over-limit', runId: '01K5CQ4N7G0000000000000000', actor: null, data: null });
    expect(store.listEvents({ kinds: ['golden.packed'] })).toHaveLength(1);
    expect(store.listEvents({ before: 3000, limit: 1 }).map((e) => e.at)).toEqual([2000]);
    store.close();
  });

  it('never fails the command that records one', () => {
    const store = Store.open(':memory:');
    store.close();
    expect(recordEvent(store, { kind: 'normalizer.added' })).toBeNull();
  });
});

describe('resolveAuthor', () => {
  const git = (values: Record<string, string>) => (key: string) => values[key] ?? null;

  it('prefers SHADOWLAP_AUTHOR, then CI, then git, then the OS user', () => {
    expect(resolveAuthor({ env: { SHADOWLAP_AUTHOR: ' maya ' }, gitConfig: git({ 'user.email': 'dana@example.com' }) })).toBe('maya');
    expect(resolveAuthor({ env: { GITHUB_ACTIONS: 'true' }, gitConfig: git({ 'user.email': 'dana@example.com' }) })).toBe('ci');
    expect(resolveAuthor({ env: {}, gitConfig: git({ 'user.email': 'dana@example.com' }), osUser: () => 'dana' })).toBe('dana@example.com');
    expect(resolveAuthor({ env: {}, gitConfig: git({}), osUser: () => 'dana' })).toBe('dana');
    expect(resolveAuthor({ env: {}, gitConfig: git({}), osUser: () => null })).toBeNull();
  });

  it('recognises CI providers', () => {
    expect(ciProvider({ GITLAB_CI: 'true' })).toBe('gitlab');
    expect(ciProvider({ CI: 'true' })).toBe('ci');
    expect(ciProvider({ CI: 'false' })).toBeNull();
    expect(ciProvider({})).toBeNull();
  });
});
