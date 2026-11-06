import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { JobDrawer } from '../ui/components/Drawer.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { JobView } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Import capture's job, as its drawer shows it once the import ends: the verdict the import judged
 * the capture by, in whichever tone it came (passed, failed, or no rule to judge it by), and Open run
 * leading to the run it made, whose Status says the same verdict.
 */

const RUN = '01M5JEQWA2QMJ3NYD1C687WP08';

function importJob(verdict: string): JobView {
  return { id: 'b1b2c3d4e5f60718', kind: 'import', title: 'Importing a capture', args: ['import', 'gateway.jsonl'], runId: null, opensRun: true, startedAt: 1_000, done: true, stopped: false, code: 0, newRunId: RUN, lines: ['$ shadowlap import gateway.jsonl', `✓ imported 1 run as ${RUN.slice(0, 10)}: 3 model calls`, verdict], total: 3 } as JobView;
}

const app = (j: JobView) => ({ conn: 'ok', exported: false, meta: { version: null, dbPath: null, actions: true, project: null }, runs: [], live: [], loadedAt: 0, runsTick: 0, feeds: {}, jobs: [{ job: j, lines: j.lines, open: true }], actionsOff: null, hasKind: () => false, guard: (fn: () => void) => fn(), toast: () => undefined, closeJob: () => undefined, openJob: () => undefined, sideOpen: false, setSideOpen: () => undefined, setHelp: () => undefined }) as unknown as AppState;

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Import capture’s job, at its end', () => {
  it('keeps the verdict line in its tone, and leads with Open run', async () => {
    const lines = [
      ['✓ judged by the rules on calls in shadowlap.config.json · 1 check passed', 'ok'],
      ['✗ judged by the rules on calls in shadowlap.config.json · check failed at #6: issue_refund never called', 'no'],
      ['  no rule on calls in shadowlap.config.json to judge it by', null],
    ] as const;
    for (const [line, tone] of lines) {
      r = await render(createElement(AppContext.Provider, { value: app(importJob(line)) }, createElement(JobDrawer)));
      const shown = r.all('.drawer pre span').find((s) => s.textContent.includes('judge'));
      expect(shown?.textContent, line).toBe(`${line}\n`);
      expect(shown?.getAttribute('class') ?? null, line).toBe(tone);
      const lime = r.all('.drawer footer .btn.lime');
      expect(lime.map((a) => a.textContent)).toEqual([`Open run ${RUN.slice(0, 10)}`]);
      expect(lime[0]!.getAttribute('href')).toBe(`#/run/${RUN}`);
      await r.unmount();
      r = null;
    }
  });
});
