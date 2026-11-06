import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { runDetail } from '../src/api.js';
import { listRunsPage } from '../src/runs-list.js';
import { normalizeRunDetail } from '../ui/normalize.js';
import type { RunDetail } from '../ui/types.js';
import { addRun, HOUR } from './read-model-store.js';

// A run imported from a trace store links back to the trace's page there, on its own page only: the
// server sends the page (`trace`) where the import kept one, an http or https address, and never on
// the list's rows.

const NOW = Date.UTC(2026, 9, 1, 10, 15);
const ID = '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07';
const PAGE = `https://cloud.langfuse.com/project/cm1shopproject/traces/${ID}`;

let store: Store;
const id: Record<string, string> = {};

beforeAll(() => {
  store = Store.open(':memory:');
  const imported = (url?: string) => ({ imported: { at: NOW - HOUR, from: 'langfuse:7f3a9c2e', key: ID, ...(url ? { url } : {}) }, labels: ['imported', 'langfuse'] });
  id.linked = addRun(store, { startedAt: NOW - 3 * HOUR, argv: ['<no-recorded-command>'], calls: 'll', meta: imported(PAGE) });
  id.unlinked = addRun(store, { startedAt: NOW - 2 * HOUR, argv: ['<no-recorded-command>'], calls: 'll', meta: imported() });
  id.slipped = addRun(store, { startedAt: NOW - HOUR, argv: ['<no-recorded-command>'], calls: 'll', meta: imported('javascript:alert(document.cookie)') });
});
afterAll(() => store.close());

const detail = (runId: string): RunDetail => normalizeRunDetail(JSON.parse(JSON.stringify(runDetail(store, runId))) as RunDetail);

describe('the trace an imported run came from', () => {
  it('is on the run’s page with its page in the store, the store’s name and the trace’s id', () => {
    expect(detail(id.linked).trace).toEqual({ url: PAGE, store: 'Langfuse', id: ID });
  });

  it('is left out where the import kept no page, or kept one that isn’t http or https', () => {
    expect(detail(id.unlinked)).not.toHaveProperty('trace');
    expect(detail(id.slipped)).not.toHaveProperty('trace');
  });

  it('is never on the list’s rows', () => {
    const rows = listRunsPage(store).runs;
    expect(rows.map((r) => r.runId)).toContain(id.linked);
    expect(JSON.stringify(rows)).not.toContain('cm1shopproject');
  });
});
