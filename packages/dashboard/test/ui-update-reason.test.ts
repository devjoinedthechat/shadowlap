import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestsView } from '../ui/api.js';
import { StepDialog, type StepAsk } from '../ui/run/StepDialogs.js';
import { UpdateGoldensDialog } from '../ui/pages/TestsDialogs.js';
import { AppContext, type AppState } from '../ui/state.js';
import { reasonField, withReason } from '../ui/update-reason.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Update golden's reason (ui/components/UpdateReason.tsx): one optional field where a golden
 * diverged, whose words go with whichever way on updates and into the command shown, the dialog
 * still opening on its way on. The dialog's anatomy is ui-dialog-anatomy.test.ts's.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});
beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

const app = { exported: false, actionsOff: null, conn: 'ok', meta: { project: { id: 'p1', name: 'support-agent', path: '/repo' } }, hasKind: () => true, guard: (fn: () => void) => (fn(), true), toast: () => undefined, watchJob: () => undefined, jobs: [], client: {} } as unknown as AppState;
async function open(element: ReturnType<typeof createElement>): Promise<Rendered> {
  r = await render(createElement(AppContext.Provider, { value: app }, element));
  return r;
}
const closes = { onClose: () => undefined };

const row = { path: 'goldens/a', name: 'a', mode: 'replay', checks: ['x'], last: { line: 'failed' } };
const UUID = { path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', certain: true };
const div = { golden: 'goldens/a', name: 'a', callNo: 3, volatile: UUID, normalizerFixes: true, maybeReal: false, normalizeAndTest: [['normalize', 'add'], ['test', 'goldens/a']], rulesAdded: false, found: null, missed: null };
const view = { rows: [row], divergences: [div], diverged: ['goldens/a'], inconclusive: [] } as unknown as TestsView;

describe('Update golden’s reason', () => {
  it('is asked optionally: the reason goes with the update and into its command, and the dialog still opens on its way on', async () => {
    const quiet = { ...view, divergences: [{ ...div, volatile: null, normalizeAndTest: null }] } as unknown as TestsView;
    const onUpdate = vi.fn(() => false);
    const page = await open(createElement(UpdateGoldensDialog, { view: quiet, paths: ['goldens/a'], has: () => true, onUpdate, onInstead: () => undefined, ...closes }));
    const field = page.one('[role="dialog"] .updwhy input');
    expect(page.one('[role="dialog"] .updwhy label span').textContent).toBe('Why, optional');
    expect(field.getAttribute('maxlength') ?? String(field.props.maxLength)).toBe('300');
    expect(page.focused()).toBe(page.one('[role="dialog"] .dlg-ok'));
    const command = () => page.one('[role="dialog"] .cmdline').textContent.replace(/\u00a0/g, ' ');
    expect(command()).not.toContain('--reason');
    await page.type(field, '  refunds above the limit\tgo to a manager ');
    expect(command()).toContain("shadowlap test goldens/a --update --reason 'refunds above the limit go to a manager'");
    // Enter in the field presses the one way on, with the reason on one line, trimmed.
    await page.press('Enter', {}, field);
    expect(onUpdate).toHaveBeenCalledWith('refunds above the limit go to a manager');
  });
  it('goes with whichever of two ways on updates, and Enter in its field presses neither', async () => {
    const b = { ...div, golden: 'goldens/b', name: 'b' };
    const several = { ...view, rows: [row, { ...row, path: 'goldens/b', name: 'b' }], divergences: [{ ...div, newRules: [['normalize', 'add']] }, b], diverged: ['goldens/a', 'goldens/b'] } as unknown as TestsView;
    const onUpdate = vi.fn(() => false);
    const onInstead = vi.fn(() => false);
    const page = await open(createElement(UpdateGoldensDialog, { view: several, paths: several.diverged, has: () => true, onUpdate, onInstead, ...closes }));
    const field = page.one('[role="dialog"] .updwhy input');
    await page.type(field, 'ids are made anew');
    await page.press('Enter', {}, field);
    expect([onUpdate.mock.calls.length, onInstead.mock.calls.length]).toEqual([0, 0]);
    await page.click(page.one('[role="dialog"] .dlg-alt'));
    expect(onInstead).toHaveBeenCalledWith(expect.objectContaining({ run: 'normalize-update-all' }), 'ids are made anew');
    await page.click(page.one('[role="dialog"] .dlg-ok'));
    expect(onUpdate).toHaveBeenCalledWith('ids are made anew');
  });
  it('is asked by a run’s Update golden step where its test diverged, and never where it only lacks a judge’s verdict', async () => {
    const command = 'shadowlap test goldens/refund --update';
    const onOk = vi.fn(() => false);
    const step = (test: unknown) => ({ key: 'update-golden', label: 'Update golden', golden: 'goldens/refund', test, sub: 'Re-records it', command }) as unknown as Extract<StepAsk, { kind: 'update' }>['step'];
    const page = await open(createElement(StepDialog, { ask: { kind: 'update', step: step({ golden: 'goldens/refund' }), onOk }, ...closes }));
    expect(page.focused()).toBe(page.one('[role="dialog"] .dlg-ok'));
    await page.type(page.one('[role="dialog"] .updwhy input'), 'refunds go to a manager');
    expect(page.one('[role="dialog"] .cmdline').textContent.replace(/\u00a0/g, ' ')).toContain(`${command} --reason 'refunds go to a manager'`);
    await page.click(page.one('[role="dialog"] .dlg-ok'));
    expect(onOk).toHaveBeenCalledWith('refunds go to a manager');
    await page.unmount();
    // Nothing diverged, so there is no change to give a reason for.
    const judged = await open(createElement(StepDialog, { ask: { kind: 'update', step: step(null), onOk }, ...closes }));
    expect(judged.all('[role="dialog"] .updwhy')).toEqual([]);
  });
  it('is the job’s field and the command’s flag only where something was typed and the command updates', () => {
    expect([reasonField(''), reasonField('why')]).toEqual([{}, { reason: 'why' }]);
    expect(withReason('shadowlap test goldens/a --update', 'it’s meant')).toBe("shadowlap test goldens/a --update --reason 'it’s meant'");
    expect(withReason('shadowlap test goldens/a --update', 'why')).toBe('shadowlap test goldens/a --update --reason why');
    expect(withReason('shadowlap test goldens/a --update', '')).toBe('shadowlap test goldens/a --update');
    expect(withReason('shadowlap test goldens/a', 'why')).toBe('shadowlap test goldens/a');
  });
});
