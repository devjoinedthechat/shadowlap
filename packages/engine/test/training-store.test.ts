import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, Store } from '../src/index.js';

/** The training tables: what left the machine as pairs, and each model's scores per task. */

describe('training tables', () => {
  it('keep each pairs export, newest first', () => {
    const store = Store.open(':memory:');
    expect(store.listPairsExports()).toEqual([]);
    store.addPairsExport({ pairs: 4, file: 'pairs.jsonl', format: 'openai-preference', minConfidence: 'high', leftOut: 2, actor: 'dana@example.com', at: 1000 });
    const last = store.addPairsExport({ pairs: 6, file: '.shadowlap/exports/pairs.jsonl', format: 'trl', minConfidence: 'medium', at: 2000, data: { sources: 3 } });
    expect(last.exportId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(store.listPairsExports()).toEqual([
      { exportId: last.exportId, at: 2000, pairs: 6, file: '.shadowlap/exports/pairs.jsonl', format: 'trl', minConfidence: 'medium', leftOut: 0, actor: null, data: { sources: 3 } },
      expect.objectContaining({ at: 1000, pairs: 4, leftOut: 2, actor: 'dana@example.com', data: null }),
    ]);
    expect(store.listPairsExports(1)).toHaveLength(1);
    store.close();
  });

  it('replace a model\'s scores on a task when it is scored again, and keep the rest', () => {
    const store = Store.open(':memory:');
    const row = (attempt: number, score: number) => ({ attempt, runId: `RUN${attempt}`, score, checks: [{ label: 'the agent exits 0', ok: true, detail: null }], spent: 0.01, via: 'Anthropic API', session: 's1', at: 1 });
    store.replaceTaskScores('claude-haiku-4-5', null, 'goldens/a', [row(1, 1), row(2, 0.5)]);
    store.replaceTaskScores('claude-haiku-4-5', null, 'goldens/b', [row(1, 1)]);
    store.replaceTaskScores('qwen2.5:7b', 'http://127.0.0.1:11434/v1', 'goldens/a', [row(1, 0)]);
    store.replaceTaskScores('claude-haiku-4-5', null, 'goldens/a', [row(1, 0.5), row(2, 0.5), row(3, 1)]);
    const rows = store.listTaskScores();
    expect(rows.map((r) => [r.model, r.baseUrl, r.golden, r.attempt, r.score])).toEqual([
      ['claude-haiku-4-5', null, 'goldens/a', 1, 0.5],
      ['claude-haiku-4-5', null, 'goldens/a', 2, 0.5],
      ['claude-haiku-4-5', null, 'goldens/a', 3, 1],
      ['claude-haiku-4-5', null, 'goldens/b', 1, 1],
      ['qwen2.5:7b', 'http://127.0.0.1:11434/v1', 'goldens/a', 1, 0],
    ]);
    expect(rows[0]!.checks).toEqual([{ label: 'the agent exits 0', ok: true, detail: null }]);
    store.close();
  });

  it('are part of schema v4, so a store opened again keeps them', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    const path = join(mkdtempSync(join(tmpdir(), 'sl-train-')), 'shadowlap.db');
    const a = Store.open(path);
    a.addPairsExport({ pairs: 1, file: 'p.jsonl', format: 'trl', minConfidence: 'high' });
    a.close();
    const b = Store.open(path);
    expect(b.listPairsExports()).toHaveLength(1);
    expect(b.schemaVersion()).toBe(SCHEMA_VERSION);
    b.close();
  });
});
