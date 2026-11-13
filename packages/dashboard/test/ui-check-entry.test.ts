import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { CallDetail, CallRow, RunDetail } from '../ui/api.js';
import type { OnShow } from '../ui/components/OnShow.js';
import { AddCheckLink, addsCheck, argsOf, useCheckEntry } from '../ui/run/check-entry.js';
import { checkMenuItems } from '../ui/run/CheckMenu.js';
import { BuilderLost, type BuilderProps, type CheckMenuProps } from '../ui/run/check-part.js';
import { ServedPartsContext } from '../ui/served-parts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render } from './ui-render.js';

const run = (o: { status?: string; source?: string | null } = {}) => ({ run: { runId: '01K5CQ4V3H8M2XWQH6V3T9RB1D', status: o.status ?? 'completed' }, source: o.source ?? null }) as unknown as RunDetail;
const can = { exported: false, actionsOff: null };
const tool = { kind: 'tool' as const, scope: null };
const app = { exported: false, actionsOff: null, conn: 'live', toast: () => undefined } as unknown as AppState;
/** A part as the served dashboard hands one, drawn by `draw`, its script never asked for. */
const part = <P>(draw: (p: P) => ReactNode): OnShow<P> => Object.assign(draw, { preload: () => undefined, script: 'idle' }) as unknown as OnShow<P>;
/** A page as the served dashboard holds it, handed the parts given, and an exported copy, handed none. */
const served = (o: { builder?: OnShow<BuilderProps>; menu?: OnShow<CheckMenuProps> }, page: ReactNode) =>
  createElement(AppContext.Provider, { value: app }, createElement(ServedPartsContext.Provider, { value: { ...(o.builder ? { CheckBuilder: o.builder } : {}), ...(o.menu ? { CheckMenu: o.menu } : {}) } }, page));

describe('Add check… on a run’s page', () => {
  it('is offered at a tool call of a finished recording alone, and never in an exported copy or on a read-only dashboard', () => {
    expect(addsCheck(run(), tool, can)).toBe(true);
    expect(addsCheck(run(), { kind: 'api', scope: null }, can)).toBe(false);
    expect(addsCheck(run(), { ...tool, input: true }, can)).toBe(false);
    expect(addsCheck(run(), { ...tool, scope: 'shadowlap:judge' }, can)).toBe(false);
    expect(addsCheck(run({ status: 'running' }), tool, can)).toBe(false);
    expect(addsCheck(run({ source: 'otel' }), tool, can)).toBe(false);
    expect(addsCheck(run(), tool, { exported: true, actionsOff: null })).toBe(false);
    expect(addsCheck(run(), tool, { exported: false, actionsOff: 'This dashboard is read-only' })).toBe(false);
    expect(addsCheck(run(), null, can)).toBe(false);
  });

  it('lists the rules a call offers, each with the key it writes, from its arguments', () => {
    expect(checkMenuItems('issue_refund', { order_id: 'A-1042', amount: 240 }).map((i) => [i.label, i.keys])).toEqual([
      ['Never call issue_refund', 'tools'],
      ['Never with these arguments', 'tools · args'],
      ['Must call with order_id = …', 'tools · args'],
      ['Only after…', 'calls · after'],
      ['Amount at most…', 'calls · args'],
      ['When… then…', 'when'],
    ]);
    expect(checkMenuItems('escalate', {}).map((i) => [i.label, i.keys])).toEqual([
      ['Never call escalate', 'tools'],
      ['Must call escalate', 'tools'],
      ['Only after…', 'calls · after'],
      ['When… then…', 'when'],
    ]);
    expect(checkMenuItems('issue_refund', { order_id: 'A-1042', refund_total: '12.5' }).map((i) => i.label)).toContain('Refund total at most…');
  });

  it('reads a number argument as the engine’s checks read one, and the arguments from the call’s request', () => {
    const atMost = (args: Record<string, unknown>) => checkMenuItems('issue_refund', args).some((i) => i.kind === 'every');
    expect([atMost({ amount: 3 }), atMost({ amount: ' -1.5e2 ' }), atMost({ amount: '12a' }), atMost({ amount: Infinity }), atMost({ amount: null })]).toEqual([true, true, false, false, false]);
    expect(argsOf({ request: { args: { amount: 1 } } } as unknown as CallDetail)).toEqual({ amount: 1 });
    expect(argsOf({ request: { amount: 1 } } as unknown as CallDetail)).toEqual({ amount: 1 });
    expect(argsOf({ request: null } as unknown as CallDetail)).toEqual({});
  });

  it('gives no entry unless the page is handed both the check menu and the builder, as an exported copy, handed neither, is not', async () => {
    const offered: boolean[] = [];
    const Page = () => {
      offered.push(!!useCheckEntry({ run: run(), row: { callNo: 3, ...tool } as unknown as CallRow, detail: null }).check);
      return null;
    };
    const builder = part<BuilderProps>(() => null);
    const menu = part<CheckMenuProps>(() => null);
    for (const [handed, want] of [
      [{}, false],
      [{ builder }, false],
      [{ menu }, false],
      [{ builder, menu }, true],
    ] as const) {
      const r = await render(served(handed, createElement(Page)));
      expect(offered.at(-1), Object.keys(handed).join(' and ') || 'neither').toBe(want);
      await r.unmount();
    }
  });

  it('draws the builder’s small dialog in the check menu’s place when the menu’s script didn’t come, which closes back to Add check…', async () => {
    const Page = () => {
      const entry = useCheckEntry({ run: run(), row: { callNo: 3, ...tool } as unknown as CallRow, detail: null });
      return createElement('div', null, entry.check ? createElement(AddCheckLink, { check: entry.check }) : null, entry.node);
    };
    const lost = part<CheckMenuProps>(() => createElement(BuilderLost));
    const r = await render(served({ builder: part<BuilderProps>(() => null), menu: lost }, createElement(Page)));
    await r.click(r.one('[data-act="ckmenu"]'));
    const dialog = r.one('[role="dialog"]');
    expect(dialog.textContent.replace(/\u00a0/g, ' ')).toContain('Add check');
    expect(dialog.textContent).toContain('This check builder’s code didn’t come from the dashboard server. Retry loads the page again.');
    await r.click(r.byText('[role="dialog"] button', 'Close'));
    expect(r.all('[role="dialog"]')).toHaveLength(0);
    expect(r.all('[data-act="ckmenu"]')).toHaveLength(1);
    await r.unmount();
  });
});
