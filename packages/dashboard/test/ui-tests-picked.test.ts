import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { GoldenRow } from '../ui/api.js';
import { AppContext, type AppState } from '../ui/state.js';
import { pickedCommand, RunPickedDialog } from '../ui/tests/RunPicked.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Run tests on…: the goldens to run as toggle chips, none picked at first, those whose pack can't be
 * read left out; the command and its price following the picks, the price asked again a moment
 * after each pick; and its confirm running the goldens picked, as the page's own start runs a Tests
 * job, with the price it showed.
 */

const row = (name: string, over: Partial<GoldenRow> = {}): GoldenRow => ({ path: `goldens/${name}`, name, mode: 'replay', error: null, injection: false, ...over }) as GoldenRow;
const ROWS = [row('refund-flow'), row('refund-in-limit', { mode: 'fork' }), row('broken', { error: 'no run.json: not a pack' }), row('planted', { injection: true })];
const price = (usd: number): Estimate => ({ kind: 'tests', usd, ceiling: false, parts: ['what the last session spent live'] });

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

async function dialog(o: { wait?: string | null } = {}) {
  const asked: string[][] = [];
  const ran: Array<{ goldens: string[]; estimate: Estimate | null | undefined }> = [];
  const app = {
    client: { estimates: { testsEstimates: (_update: unknown, run: readonly string[] = []) => (asked.push([...run]), Promise.resolve({ run: null, goldens: {}, picked: price(run.length * 0.01) })) } },
    actionsOff: null,
    conn: 'ok',
    toast: () => undefined,
    guard: (fn: () => void) => (fn(), true),
  } as unknown as AppState;
  r = await render(createElement(AppContext.Provider, { value: app }, createElement(RunPickedDialog, { rows: ROWS, wait: o.wait ?? null, onRun: (goldens: string[], estimate: Estimate | null | undefined) => (ran.push({ goldens, estimate }), true), onClose: () => undefined })));
  return { asked, ran };
}

const chips = () => r!.all('.dialog .togchips button').map((b) => [b.textContent, b.getAttribute('aria-pressed')]);
const ok = () => r!.one('.dialog .dlg-ok');

describe('Run tests on…', () => {
  it('offers each golden that can be read, none picked, and waits on Pick at least one golden', async () => {
    await dialog();
    expect(r!.one('.dialog h3').textContent.replace(/\u00a0/g, ' ')).toBe('Run tests on goldens');
    expect(chips()).toEqual([
      ['refund-flow', 'false'],
      ['refund-in-limit', 'false'],
      ['planted', 'false'],
    ]);
    expect(ok().getAttribute('data-why')).toBe('Pick at least one golden');
    expect(r!.one('.dialog .dcost').textContent.replace(/\u00a0/g, ' ')).toContain('Pick at least one golden');
  });

  it('follows the picks: its title, the command, the goldens that run live, and the price asked again a moment after a pick', async () => {
    const { asked, ran } = await dialog();
    await r!.click(r!.byText('.dialog .togchips button', 'refund-in-limit'));
    await r!.click(r!.byText('.dialog .togchips button', 'refund-flow'));
    expect(r!.one('.dialog h3').textContent.replace(/\u00a0/g, ' ')).toBe('Run tests on 2 goldens');
    // In the goldens' order, whatever order they were picked in.
    expect(r!.one('.dialog .cmdline').textContent).toBe('$shadowlap test goldens/refund-flow goldens/refund-in-limit');
    const facts = r!.all('.dialog .dfacts > div').map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent.replace(/\u00a0/g, ' ')]);
    expect(facts.slice(1)).toEqual([['Runs live', '1 golden marked forkfrom where it forks, writes blocked']]);
    await r!.until('the picks are priced', () => ok().getAttribute('data-why') === null);
    expect(asked.at(-1)).toEqual(['goldens/refund-flow', 'goldens/refund-in-limit']);
    expect(r!.one('.dialog .dcost').textContent).toContain('$0.02');
    await r!.click(ok());
    expect(ran).toEqual([{ goldens: ['goldens/refund-flow', 'goldens/refund-in-limit'], estimate: price(0.02) }]);
  });

  it('names the command for the goldens picked, as the job runs it', () => {
    expect(pickedCommand(['goldens/a', 'evals/b c'])).toBe("shadowlap test goldens/a 'evals/b c'");
  });

  it('waits as Run tests does while a session or a job holds the goldens', async () => {
    await dialog({ wait: 'A test session is running: run the tests once it is done' });
    await r!.click(r!.byText('.dialog .togchips button', 'refund-flow'));
    expect(ok().getAttribute('data-why')).toBe('A test session is running: run the tests once it is done');
  });
});
