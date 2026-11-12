import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { CallDetail, CallRow, RunDetail } from '../ui/api.js';
import type { OnShow } from '../ui/components/OnShow.js';
import { argsOf } from '../ui/run/call-args.js';
import { addsCheck, useCheckEntry } from '../ui/run/check-entry.js';
import { checkMenuItems } from '../ui/run/CheckMenu.js';
import type { BuilderProps } from '../ui/run/check-part.js';
import { ServedPartsContext, type CheckMenuProps } from '../ui/served-parts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render } from './ui-render.js';

const run = (o: { status?: string; source?: string | null } = {}) => ({ run: { runId: '01K5CQ4V3H8M2XWQH6V3T9RB1D', status: o.status ?? 'completed' }, source: o.source ?? null }) as unknown as RunDetail;
const can = { exported: false, actionsOff: null };
const tool = { kind: 'tool' as const, scope: null };

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

  it('gives no entry where nothing hands the page the menu and the builder, as in an exported copy, whose script holds neither', async () => {
    const offered: boolean[] = [];
    const Page = () => {
      offered.push(!!useCheckEntry({ run: run(), row: { callNo: 3, ...tool } as unknown as CallRow, detail: null }).check);
      return null;
    };
    const app = { exported: false, actionsOff: null } as unknown as AppState;
    const part = Object.assign(() => null, { preload: () => undefined, script: 'idle' }) as unknown as OnShow<BuilderProps>;
    const menu = Object.assign(() => null, { preload: () => undefined, script: 'idle' }) as unknown as OnShow<CheckMenuProps>;
    const copy = await render(createElement(AppContext.Provider, { value: app }, createElement(Page)));
    expect(offered.at(-1)).toBe(false);
    await copy.unmount();
    const served = await render(createElement(AppContext.Provider, { value: app }, createElement(ServedPartsContext.Provider, { value: { CheckBuilder: part, CheckMenu: menu } }, createElement(Page))));
    expect(offered.at(-1)).toBe(true);
    await served.unmount();
  });
});
