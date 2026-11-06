import { createElement, useEffect, useRef, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useListKeys } from '../ui/list-keys.js';
import { runRowScope } from '../ui/run-row.js';
import { openAndPress, PRESS_WAIT_MS, rowStep } from '../ui/run/row-step.js';
import { useRoute } from '../ui/router.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { Palette } from '../ui/shell/Palette.js';
import { setSingleKeys } from '../ui/shortcuts.js';
import { AppContext } from '../ui/state.js';
import type { NextStepRow } from '../ui/types.js';
import { addressBar, app } from './ui-route-helpers.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A run row's next step in ⌘K on the row: after Open run, what the run's lime button says, its key by
 * what it presses, a link going where it goes and any other step opening the run to press that
 * button there, as This run's entry presses it.
 */

const RUN = '01M5JEQWA2QMJ3NYD1C687WP08';
const PARENT = '01M5JEQXRGBX1QXGW0X8A3ZB4C';
const BLAME: NextStepRow = { key: 'blame', label: 'Run blame', command: `shadowlap blame ${RUN.slice(0, 10)}` };

let r: Rendered | null = null;
beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});
beforeEach(() => {
  addressBar('#/runs');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  setSingleKeys(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A row's actions as the palette lists them, by label and key, with the palette's builder. */
function rowItems(next: NextStepRow | null, o: { parent?: string; actionsOff?: string | null } = {}) {
  const run = { runId: RUN, parentRunId: o.parent ?? null, startedAt: 1, mode: o.parent ? 'replay' : 'record', status: 'completed', next };
  const runs = o.parent ? [run, { runId: o.parent, parentRunId: null, startedAt: 0, mode: 'record', status: 'completed' }] : [run];
  return runRowScope(run as never, { runs: runs as never, toast: () => undefined }).items(rowStep(o.actionsOff ?? null, () => undefined));
}

describe('a run row’s next step in ⌘K', () => {
  it('comes after Open run, its key by what it presses, and one that compares takes Compare’s place', () => {
    expect(rowItems(BLAME).map((x) => [x.label, x.key])).toEqual([
      ['Open run', undefined],
      ['Run blame', 'b'],
      ['Copy ID', undefined],
    ]);
    expect(rowItems(BLAME)[1]).toMatchObject({ hint: `shadowlap blame ${RUN.slice(0, 10)}`, job: true });
    expect(rowItems({ key: 'replay', label: 'Replay' })[1]).toMatchObject({ label: 'Replay', key: 'r' });
    const compare: NextStepRow = { key: 'compare', label: 'Compare with parent', href: `#/compare/${PARENT}/${RUN}`, title: `Against ${PARENT.slice(0, 10)}` };
    const items = rowItems(compare, { parent: PARENT });
    expect(items.map((x) => [x.label, x.key])).toEqual([
      ['Open run', undefined],
      ['Compare with parent', 'c'],
      ['Copy ID', undefined],
    ]);
    // A step no key presses has none.
    expect(rowItems({ key: 'pack', label: 'Pack as golden…' })[1]).not.toHaveProperty('key');
  });

  it('is the palette’s to build, and a row that says no step has none', () => {
    const run = { runId: RUN, parentRunId: null, startedAt: 1, mode: 'record', status: 'completed', next: BLAME };
    expect(runRowScope(run as never, { runs: [run] as never, toast: () => undefined }).items().map((x) => x.label)).toEqual(['Open run', 'Copy ID']);
    expect(rowItems(null).map((x) => x.label)).toEqual(['Open run', 'Copy ID']);
    // Compare stays where the step isn't Compare.
    expect(rowItems(BLAME, { parent: PARENT }).map((x) => x.label)).toEqual(['Open run', 'Run blame', 'Compare with parent', 'Copy ID']);
  });

  it('leaves out a step that can’t start, and a job while actions are paused, but not a link', async () => {
    expect(rowItems({ ...BLAME, off: 'Blame needs a run that made a model call' }).map((x) => x.label)).not.toContain('Run blame');
    expect(rowItems(BLAME, { actionsOff: 'This dashboard is read-only' }).map((x) => x.label)).not.toContain('Run blame');
    const fix: NextStepRow = { key: 'fix', label: 'Open fix', href: '#/fixes/F1', title: '“The agent exited with code 1”' };
    const items = rowItems(fix, { actionsOff: 'This dashboard is read-only' });
    expect(items[1]).toMatchObject({ label: 'Open fix', hint: '“The agent exited with code 1”' });
    expect(items[1]).not.toHaveProperty('job');
    r = await render(createElement('main'));
    items[1].run();
    expect(location.hash).toBe('#/fixes/F1');
  });

  it('is listed under the row’s name on a row in focus, its key while single keys are on', async () => {
    const runs = [{ runId: RUN, parentRunId: null, startedAt: 1, mode: 'record', status: 'completed', next: BLAME }];
    function Runs() {
      const [open, setOpen] = useState(false);
      return createElement(AppContext.Provider, { value: app({ palette: open, setPalette: setOpen }) }, createElement('main', { id: 'view' }, createElement(Rows, { runs })), createElement(Keyboard), createElement(Palette, { route: { page: 'runs' } }));
    }
    // The test's clock: the press it starts looks for a run's page this test never draws.
    vi.useFakeTimers();
    r = await render(createElement(Runs));
    await r.press('j');
    await r.press('k', { metaKey: true });
    await r.until('the palette', () => r!.all('.palette').length === 1);
    expect(r.all('.palit .pl').map((x) => x.textContent)).toEqual(['Open run', 'Run blame', 'Copy ID']);
    const blame = r.all('.palit').find((x) => x.querySelector('.pl')!.textContent === 'Run blame')!;
    expect(blame.querySelector('.palk')!.textContent).toBe('b');
    await r.click(blame);
    expect(location.hash).toBe(`#/run/${RUN}`);
  });
});

/** Runs' rows, as a list the keys walk, each offering its row's actions. */
function Rows({ runs }: { runs: Array<{ runId: string; next: NextStepRow }> }) {
  const root = useRef<HTMLUListElement>(null);
  const keyOf = (x: { runId: string }) => `#/run/${x.runId}`;
  const at = useListKeys({ rows: runs, keyOf, root, open: null, pick: null, actions: (x) => runRowScope(x as never, { runs: runs as never, toast: () => undefined }), show: null });
  return createElement('ul', { ref: root }, runs.map((x) => createElement('li', { key: x.runId, 'data-rowkey': keyOf(x), className: at === keyOf(x) ? 'krow' : undefined }, x.runId)));
}

/** The pages as the router draws them: a run's header `late` ms after its address, leading with `lead`. */
function Pages({ late, lead }: { late: number; lead: { key: string; disabled?: boolean; title?: string; onClick: () => void } }) {
  const route = useRoute();
  const id = route.page === 'run' ? route.id : null;
  const [drawn, setDrawn] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const t = setTimeout(() => setDrawn(id), late);
    return () => clearTimeout(t);
  }, [id, late]);
  if (!id || drawn !== id) return createElement('main', { id: 'view' }, createElement('h1', null, route.page));
  return createElement(
    'main',
    { id: 'view' },
    createElement('section', { className: 'rhead' }, createElement('h1', { className: 'rnm', 'data-run': id }, id.slice(0, 10)), createElement('button', { type: 'button', 'data-next': lead.key, disabled: lead.disabled, title: lead.title, onClick: lead.onClick }, 'Lead')),
  );
}

describe('a step picked on a row', () => {
  it('opens the run and presses its lime button once the page draws it', async () => {
    const onClick = vi.fn();
    r = await render(createElement(Pages, { late: 400, lead: { key: 'blame', onClick } }));
    openAndPress(RUN, 'blame', () => undefined);
    expect(location.hash).toBe(`#/run/${RUN}`);
    await r.wait(200);
    expect(onClick).not.toHaveBeenCalled();
    await r.until('the press', () => onClick.mock.calls.length > 0);
    await r.wait(300);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('says why its button is off, and presses nothing', async () => {
    const onClick = vi.fn();
    const toast = vi.fn();
    r = await render(createElement(Pages, { late: 0, lead: { key: 'blame', disabled: true, title: 'A repair is running: blame once it is done.', onClick } }));
    openAndPress(RUN, 'blame', toast);
    await r.until('the reason', () => toast.mock.calls.length > 0);
    expect(toast).toHaveBeenCalledWith('A repair is running: blame once it is done.');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('presses nothing where the page leads with another step by then', async () => {
    const onClick = vi.fn();
    const toast = vi.fn();
    r = await render(createElement(Pages, { late: 0, lead: { key: 'fix', onClick } }));
    openAndPress(RUN, 'blame', toast);
    await r.until('the page', () => r!.all('.rhead').length === 1);
    await r.wait(300);
    expect(onClick).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('gives up on another page, and after its wait', async () => {
    const onClick = vi.fn();
    r = await render(createElement(Pages, { late: 200, lead: { key: 'blame', onClick } }));
    openAndPress(RUN, 'blame', () => undefined);
    location.hash = '#/fixes';
    await r.wait(50);
    location.hash = `#/run/${RUN}`;
    await r.until('the page', () => r!.all('.rhead').length === 1);
    await r.wait(300);
    expect(onClick).not.toHaveBeenCalled();
    await r.unmount();
    vi.useFakeTimers();
    addressBar('#/runs');
    r = await render(createElement(Pages, { late: PRESS_WAIT_MS + 1000, lead: { key: 'blame', onClick } }));
    openAndPress(RUN, 'blame', () => undefined);
    // The page hears the address change, then draws its header after the wait is over.
    await r.wait(0);
    await r.wait(PRESS_WAIT_MS + 2000);
    expect(r.all('.rhead')).toHaveLength(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
