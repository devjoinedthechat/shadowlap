import { ACTIONS } from '@shadowlap/engine';
import { coverageNewest } from '../coverage.js';
import type { LookSource } from './row.js';

/**
 * Behaviours seen in production that no golden covers, under Tests: how many, and the newest, as
 * `/api/coverage` serves the line, opening Tests at Not covered. Its step packs the newest one (Pack
 * as golden), or, once the last `--pack` found the agent no longer does it, asks for the checks a
 * golden that forks is judged by (Pack with checks…). Keyed by that behaviour, so a pack that covers
 * it moves the row on to the next one.
 */
export const coverage: LookSource = {
  id: 'coverage',
  group: 'tests',
  order: 30,
  rows: (w) => {
    const newest = coverageNewest(w.store);
    if (!newest) return [];
    const { kind, icon, title, detail, href, runId, fixId, at } = newest.look;
    const label = (newest.forkable ? ACTIONS.packWithChecks : ACTIONS.packBehaviour).label;
    return [{ key: `attn:coverage:${newest.key}`, group: 'tests', kind, icon, title, detail, step: { of: 'pack', key: newest.key, label, fork: newest.forkable }, href, runId, fixId, at }];
  },
};
