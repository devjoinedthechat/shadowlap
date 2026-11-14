import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { makeRun } from '../../engine/test/fix-fixtures.js';
import { actionArgs } from '../src/api.js';

/**
 * The fork menu's Set request field from here…, as the dashboard's server builds it: `replay --set
 * <call>:<key>=<value>` from the answer, a field the CLI would refuse refused here, in its words.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

describe('Set request field from here…', () => {
  it('forks with the field set from the model call on, and refuses an answer that isn’t key=value before anything runs', () => {
    const run = makeRun(store, { calls: ['api', 'tool', 'api'], status: 'completed' });
    expect(actionArgs(store, run, 3, 'd', ' temperature=1 ')).toEqual({ args: ['replay', run, '--set', '3:temperature=1'], opensRun: true });
    expect(actionArgs(store, run, 3, 'd', 'temperature')).toEqual({ error: '--set expects <call>:<key>=<value>, got "3:temperature"', status: 400 });
    // At a tool call there is no such item to run.
    expect(actionArgs(store, run, 2, 'd', 'temperature=1')).toHaveProperty('error');
  });
});
