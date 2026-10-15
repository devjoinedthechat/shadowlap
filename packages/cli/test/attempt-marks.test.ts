import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyRun, Store } from '@shadowlap/engine';
import { AttemptRunner } from '../src/attempts.js';

/**
 * Blame's probes and verify's attempts are marked as attempts when they start, not once they end, so
 * the run list, the Overview and the status bar's count bundle them under the run they replay while
 * blame or verify is still running them.
 */

// An agent that makes no calls and waits for the test to let it finish.
const WAIT = `const { existsSync } = require('node:fs'); const t = setInterval(() => { if (existsSync(process.argv[1])) { clearInterval(t); process.exit(0); } }, 20);`;

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'shadowlap-attempt-marks-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('attempts', () => {
  it('are marked before their agent starts, and keep the mark once they are judged', async () => {
    const db = join(work, 'store.db');
    const go = join(work, 'go');
    const setup = Store.open(db);
    const parent = setup.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: work } });
    setup.endRun(parent.runId, 'failed');
    const recorded = setup.getRun(parent.runId)!;
    setup.close();

    const runner = await AttemptRunner.start({ db }, { writes: 'block', reads: 'replay', liveTools: [], spec: null, budget: null, timeoutMs: 30_000, guard: 'off' });
    const look = Store.open(db);
    try {
      const marks = { repeat: { group: 'g-3', attempt: 1, of: 4 }, probe: { of: parent.runId, callNo: 3, passed: false } };
      const pending = runner.attempt({ parent: recorded, argv: [process.execPath, '-e', WAIT, go], commandFromImport: false }, { meta: marks });
      // The agent is running: the run already says it is one of blame's attempts at the run it replays.
      const running = look.allRuns().find((r) => r.parentRunId === parent.runId)!;
      expect(running.status).toBe('running');
      expect(running.meta).toMatchObject(marks);
      expect(classifyRun(running)).toMatchObject({ attemptOf: parent.runId, attemptKind: 'probe' });

      writeFileSync(go, '');
      const a = await pending;
      expect(a.code).toBe(0);
      expect(look.getRun(a.run.runId)!.status).toBe('completed');
      expect(look.getRun(a.run.runId)!.meta).toMatchObject(marks);
    } finally {
      look.close();
      await runner.close();
    }
  });
});
