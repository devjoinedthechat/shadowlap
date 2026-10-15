import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packRun, Store } from '@shadowlap/engine';
import { parseTests } from '../src/checks.js';
import { givenCommand } from '../src/commands/testing.js';
import { importGolden } from '../src/golden-test.js';
import { expandRecordings, goldenName, listGoldens, projectGoldens, rawExpectFor, readPackHead, testsKeyFor } from '../src/goldens.js';

/** Finding a project's goldens, and naming them the way the test history does. */
let project: string;

function pack(dir: string, runId: string, createdAt = 1000): void {
  mkdirSync(join(project, dir), { recursive: true });
  writeFileSync(join(project, dir, 'run.json'), JSON.stringify({ format: 'shadowlap-pack', version: 1, createdAt, runs: [{ runId: 'PARENT', command: { argv: ['node'] } }, { runId, parentRunId: 'PARENT', startedAt: createdAt - 10, command: { argv: ['node', 'agent.mjs'] } }] }));
}

const config = {
  tests: {
    'goldens/refund-*': { expect: { tools: { send_email: 0 } } },
    'goldens/refund-over-limit': { fork: true, repeat: 5, expect: { tools: { issue_refund: 0, escalate: 1 } } },
    'elsewhere/budget': { expect: { inputTokens: '<= 60000', cost: '<= 0.05' } },
  },
};

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'sl-goldens-'));
  pack('goldens/refund-over-limit', 'R_OVER', 2000);
  pack('goldens/refund-in-limit', 'R_IN');
  pack('goldens/triage', 'R_TRIAGE');
  pack('elsewhere/budget', 'R_BUDGET');
  mkdirSync(join(project, 'goldens', 'notes'));
  pack('goldens/.scratch', 'R_HIDDEN');
  writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify(config));
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

describe('goldens', () => {
  it('lists the goldens folder and the packs the config names, with how each is tested', () => {
    const goldens = listGoldens(project, parseTests(config.tests));
    expect(goldens.map((g) => g.path)).toEqual(['goldens/refund-in-limit', 'goldens/refund-over-limit', 'goldens/triage', 'elsewhere/budget']);
    expect(goldens[1]).toEqual({ path: 'goldens/refund-over-limit', runId: 'R_OVER', packedAt: 2000, mode: 'fork', repeat: 5, passes: 5, checks: ['issue_refund called 0 times', 'escalate called 1 time'], error: null });
    expect(goldens[0]).toMatchObject({ mode: 'replay', repeat: 1, checks: ['send_email called 0 times'] });
    expect(goldens[2]).toMatchObject({ mode: 'replay', checks: [] });
    expect(goldens[3]!.checks).toEqual(['at most 60000 input tokens', 'cost at most $0.05']);
    expect(listGoldens(project, [], 'nowhere')).toEqual([]);
    // As the dashboard asks for them: from the config on disk, or the folder alone when it can't be read.
    expect(projectGoldens(project)).toEqual(goldens);
    const broken = mkdtempSync(join(tmpdir(), 'sl-goldens-broken-'));
    try {
      mkdirSync(join(broken, 'goldens', 'a'), { recursive: true });
      writeFileSync(join(broken, 'goldens', 'a', 'run.json'), JSON.stringify({ format: 'shadowlap-pack', version: 1, createdAt: 5, runs: [{ runId: 'R_A', command: { argv: ['node'] } }] }));
      writeFileSync(join(broken, 'shadowlap.config.json'), '{ "tests": ');
      expect(projectGoldens(broken).map((g) => [g.path, g.runId])).toEqual([['goldens/a', 'R_A']]);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('expands a pattern itself, names goldens by their folder, and finds their checks as written', () => {
    expect(expandRecordings(['goldens/refund-*', 'goldens/triage/', 'missing/*'], project)).toEqual({ dirs: ['goldens/refund-in-limit', 'goldens/refund-over-limit', 'goldens/triage/'], unmatched: ['missing/*'] });
    expect(() => expandRecordings(['*/triage'], project)).toThrow('only the last part');
    expect(goldenName('./goldens/triage/', project)).toBe('goldens/triage');
    expect(goldenName(join(project, 'elsewhere', 'budget'), project)).toBe('elsewhere/budget');
    const entries = parseTests(config.tests);
    expect(testsKeyFor(entries, join(project, 'goldens/refund-over-limit'), project)).toBe('goldens/refund-over-limit');
    expect(testsKeyFor(entries, join(project, 'goldens/refund-in-limit'), project)).toBe('goldens/refund-*');
    expect(rawExpectFor(entries, join(project, 'goldens/refund-in-limit'), project)).toEqual({ tools: { send_email: 0 } });
    expect(rawExpectFor(entries, join(project, 'goldens/triage'), project)).toBeNull();
    expect(readPackHead(join(project, 'goldens/triage'))).toEqual({ runId: 'R_TRIAGE', packedAt: 1000, recordedAt: 990, argv: ['node', 'agent.mjs'], parentRunId: 'PARENT', redactions: [] });
    expect(readPackHead(join(project, 'goldens/notes'))).toEqual({ error: 'no run.json: not a pack' });
  });

  it('keeps the command as typed, without the global options before it', () => {
    expect(givenCommand(['node', 'shadowlap', '--db', 'x.db', '-v', 'test', 'goldens/*', '--update'], 'test')).toEqual(['shadowlap', 'test', 'goldens/*', '--update']);
    expect(givenCommand(['node', 'shadowlap', 'test', 'goldens/a'], 'test')).toEqual(['shadowlap', 'test', 'goldens/a']);
  });
});

describe('importing a golden', () => {
  it('replays the pack\'s own run, even when only one of its ancestors had to be imported', () => {
    const source = Store.open(':memory:');
    const parent = source.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/p' } });
    const fork = source.createRun({ mode: 'replay', parentRunId: parent.runId, command: { argv: ['node', 'agent.mjs'], cwd: '/p' } });
    packRun(source, fork.runId, join(project, 'elsewhere', 'lineage'), { lineage: true });
    source.close();
    const store = Store.open(':memory:');
    expect(importGolden(store, join(project, 'elsewhere', 'lineage')).runId).toBe(fork.runId);
    store.deleteRun(parent.runId);
    expect(importGolden(store, join(project, 'elsewhere', 'lineage')).runId).toBe(fork.runId);
    store.close();
  });
});
