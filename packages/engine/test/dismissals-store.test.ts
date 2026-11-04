import { describe, expect, it } from 'vitest';
import { stillDismissed, Store } from '../src/index.js';

/**
 * Dismissals in the store: each advice item Needs a look shows that its owner put away, by its key,
 * with the facts it stated then, when and who; put away again in its place (Undo writes back what was
 * kept before), brought back by deleting it (Restore), and counted for the change feed.
 */

describe('dismissals', () => {
  it('keeps an advice item put away by its key, with its facts each once, when and who, the most recent first', () => {
    const store = Store.open(':memory:');
    const coverage = store.putDismissal({ key: 'coverage', facts: ['3f9a2c1d5e8b7a60', '1db3eff9c2a04b17', '3f9a2c1d5e8b7a60'], at: 2_000, actor: 'dana@northwind.example' });
    expect(coverage).toEqual({ key: 'coverage', facts: ['3f9a2c1d5e8b7a60', '1db3eff9c2a04b17'], at: 2_000, actor: 'dana@northwind.example' });
    // Who and when, when not given: nobody named, and now.
    const before = Date.now();
    const retire = store.putDismissal({ key: 'retire claude-sonnet-4-5', facts: ['2026-11-30', 'goldens/refund-in-limit'] });
    expect(retire.actor).toBeNull();
    expect(retire.at).toBeGreaterThanOrEqual(before);
    store.putDismissal({ key: 'local', facts: [], at: 1_000 });

    expect(store.getDismissal('coverage')).toEqual(coverage);
    // Another model's retirement was never put away.
    expect(store.getDismissal('retire gpt-4o')).toBeNull();
    expect(store.listDismissals().map((d) => [d.key, d.facts])).toEqual([
      ['retire claude-sonnet-4-5', ['2026-11-30', 'goldens/refund-in-limit']],
      ['coverage', ['3f9a2c1d5e8b7a60', '1db3eff9c2a04b17']],
      ['local', []],
    ]);

    // Put away again, as Undo writes back an earlier dismissal's facts: in place of what was kept.
    store.putDismissal({ key: 'coverage', facts: ['3f9a2c1d5e8b7a60'], at: 1_500, actor: 'dana@northwind.example' });
    expect(store.getDismissal('coverage')).toEqual({ key: 'coverage', facts: ['3f9a2c1d5e8b7a60'], at: 1_500, actor: 'dana@northwind.example' });
    expect(store.listDismissals()).toHaveLength(3);

    // Restore: it is back, and bringing back one that was never put away says so.
    expect(store.deleteDismissal('coverage')).toBe(true);
    expect(store.getDismissal('coverage')).toBeNull();
    expect(store.deleteDismissal('coverage')).toBe(false);
    expect(() => store.putDismissal({ key: '', facts: ['x'] })).toThrow('a dismissal needs the key of the advice it puts away');
    store.close();
  });

  it('keeps advice put away while every fact it states was kept: only a new fact brings it back', () => {
    const kept = { facts: ['3f9a2c1d5e8b7a60', '1db3eff9c2a04b17', '8c0d4e2f6a1b3957', '5e7a9c1b3d0f2846'] };
    // Nothing kept: it shows.
    expect(stillDismissed(null, ['3f9a2c1d5e8b7a60'])).toBe(false);
    // The same facts, or fewer (a behaviour packed since: 4 became 3), and none at all: it stays put away.
    expect(stillDismissed(kept, [...kept.facts])).toBe(true);
    expect(stillDismissed(kept, ['3f9a2c1d5e8b7a60', '1db3eff9c2a04b17', '8c0d4e2f6a1b3957'])).toBe(true);
    expect(stillDismissed(kept, [])).toBe(true);
    // A behaviour that had a golden then and has none now is a new fact: it is back.
    expect(stillDismissed(kept, ['3f9a2c1d5e8b7a60', '9b2e4d6f8a0c1357'])).toBe(false);
    // A model that retires: a new date, or a migration's finding, is a fact it didn't state.
    const retire = { facts: ['2026-11-30', 'goldens/refund-in-limit', 'goldens/escalate-over-limit'] };
    expect(stillDismissed(retire, ['2026-11-30', 'goldens/refund-in-limit'])).toBe(true);
    expect(stillDismissed(retire, ['2027-01-15', 'goldens/refund-in-limit'])).toBe(false);
    expect(stillDismissed(retire, ['2026-11-30', 'goldens/refund-in-limit', 'checked · the config change is ready'])).toBe(false);
  });

  it('moves the dismissals counter on every write, and on nothing else', () => {
    const store = Store.open(':memory:');
    const count = () => store.changeCounts().dismissals;
    expect(count()).toBe(0);
    store.putDismissal({ key: 'local', facts: ['01M3S1C7QD0000000000000000'] });
    const put = count();
    expect(put).toBeGreaterThan(0);
    store.putDismissal({ key: 'local', facts: ['01M3S1C7QD0000000000000000', '01M3S1C8AB0000000000000000'] });
    const again = count();
    expect(again).toBeGreaterThan(put);
    expect(store.deleteDismissal('local')).toBe(true);
    const restored = count();
    expect(restored).toBeGreaterThan(again);
    // Nothing to bring back, and a run recorded: the counter stays.
    expect(store.deleteDismissal('local')).toBe(false);
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '.' } });
    store.endRun(run.runId, 'completed');
    expect(count()).toBe(restored);
    store.close();
  });

  it('reads facts kept as anything but words as the words among them, and none', () => {
    const store = Store.open(':memory:');
    const raw = (store as unknown as { db: { exec(sql: string): void } }).db;
    store.putDismissal({ key: 'coverage', facts: ['3f9a2c1d5e8b7a60'], at: 1 });
    raw.exec(`UPDATE dismissals SET facts = '[1, "3f9a2c1d5e8b7a60", null]' WHERE key = 'coverage'`);
    expect(store.getDismissal('coverage')?.facts).toEqual(['3f9a2c1d5e8b7a60']);
    raw.exec(`UPDATE dismissals SET facts = 'not json' WHERE key = 'coverage'`);
    expect(store.getDismissal('coverage')?.facts).toEqual([]);
    store.close();
  });
});
