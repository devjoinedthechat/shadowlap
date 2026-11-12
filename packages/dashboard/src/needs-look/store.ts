import { links } from '../links.js';
import { stepWords } from '../store-steps.js';
import { adviceOf } from './advice.js';
import { type LookSource, plural } from './row.js';

/** A team store's setup left half done leads back to its page: first, since the team gets nothing from a store set up halfway. */
export const setup: LookSource = {
  id: 'setup',
  group: 'setup',
  order: 10,
  rows: (w) =>
    w.teamStore?.setup
      ? [{ key: 'attn:setup:store', group: 'setup', kind: 'store-setup', icon: 'setting', title: 'The team store’s setup isn’t finished', detail: `step ${w.teamStore.setup.step} of 4: ${stepWords(w.teamStore.setup.title)}`, step: { of: 'link', label: 'Continue setup', href: links.storeSetup() }, href: links.storeSetup(), runId: null, fixId: null, at: 0 }]
      : [],
};

/**
 * The runs only on this machine, with Push local runs; the row opens Runs on them, each tagged local.
 * Advice: it states every one of them, so a run that is only here once it finishes brings it back.
 */
export const local: LookSource = {
  id: 'local',
  group: 'housekeeping',
  order: 10,
  rows: (w) => {
    const note = w.teamStore;
    const n = note?.onlyLocal ?? 0;
    if (!note || n <= 0) return [];
    const them = n === 1 ? 'it' : 'them';
    return [{ key: 'attn:local', group: 'housekeeping', kind: 'local', icon: 'rec', title: `${plural(n, 'run is', 'runs are')} only on this machine`, detail: `push ${them} so the team can open ${them}`, step: { of: 'push', label: 'Push local runs', command: 'shadowlap push --all' }, href: links.runs({ types: 'local' }), runId: null, fixId: null, at: 0, advice: adviceOf('local', note.localRuns) }];
  },
};
