import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkLabels } from '../../engine/src/checks/labels.js';
import { parseExpect } from '../../engine/src/checks/parse.js';
import type { CallDetail, RunDetail } from '../ui/api.js';
import type { CheckContext, CheckPreview, CheckSuggestions, ChecksConfig, SuggestionsAsk } from '../ui/checks-api.js';
import { Builder } from '../ui/checks/Builder.js';
import { blankUnit, fileUnit, fragmentOf, haveOf, ruleOf, settle, suggestVerb, withRule, withSuggestion, type Fragment, type Units } from '../ui/checks/model.js';
import type { BuilderProps } from '../ui/run/check-part.js';
import { noMedia, shell } from './ui-overlays-page.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Suggested checks in the check builder (ui/checks/Suggested.tsx, the rules from model.ts): what a
 * suggestion's button does, the builder's units after one is taken, and the labels the builder sends
 * so a rule it holds is never suggested.
 */

const VALUE = { calls: [{ tool: 'issue_refund', args: { amount: { '<=': '@get_policy.result.limit' } } }] };
const WHEN = { when: [{ if: { tool: 'lookup_order', result: { amount: { '>': 100 } } }, then: { tools: { issue_refund: 0 } } }] };
const ORDER = { calls: [{ tool: 'send_email', after: 'issue_refund' }] };
const labels = (f: Fragment) => checkLabels(parseExpect(f, 'expect'));

describe('a suggestion taken into the builder', () => {
  it('writes the rule it was suggested as, in each shape, so its label is among those the builder holds', () => {
    for (const f of [VALUE, WHEN, ORDER, { tools: { send_email: 1 } }, { tools: { send_email: 0 } }, { tools: { send_email: 2 } }]) expect(fragmentOf(ruleOf(f)).f).toEqual(f);
    // A count of 2 or more has no form of its own: it opens as JSON.
    expect(ruleOf({ tools: { send_email: 2 } }).kind).toBe('json');
  });

  it('is used in place of the rule being built, or added beside a check of the golden’s in the editor', () => {
    const building: Units = { units: [fileUnit({ tools: { send_email: 0 } }), withRule(blankUnit(), ruleOf(ORDER))], active: 1 };
    expect(suggestVerb(building)).toBe('Use rule');
    const used = withSuggestion(building, VALUE);
    expect(used.active).toBe(1);
    expect(used.units.map((u) => u.f)).toEqual([{ tools: { send_email: 0 } }, VALUE]);
    const editing: Units = { units: [fileUnit({ tools: { send_email: 0 } })], active: 0 };
    expect(suggestVerb(editing)).toBe('Add rule');
    const added = withSuggestion(editing, WHEN);
    expect(added.active).toBe(1);
    expect(added.units.map((u) => [u.orig, u.f])).toEqual([
      [{ tools: { send_email: 0 } }, { tools: { send_email: 0 } }],
      [null, WHEN],
    ]);
    expect(haveOf(settle(added.units, { tools: { send_email: 0 } }, added.active))).toEqual([...labels({ tools: { send_email: 0 } }), ...labels(WHEN)]);
  });
});

describe('the labels the builder holds', () => {
  it('are each check’s that writes something, a removed one’s too, once each', () => {
    const base = { tools: { send_email: 0 }, calls: ORDER.calls };
    const units = [{ ...fileUnit({ tools: { send_email: 0 } }), gone: true }, fileUnit(ORDER), withRule(blankUnit(), ruleOf(ORDER)), blankUnit()];
    expect(haveOf(settle(units, base, 3))).toEqual(['send_email called 0 times', 'every send_email call: after issue_refund']);
  });
});

// ---- The section drawn in the builder -----------------------------------------------------------

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  noMedia();
});
beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

const RUN = '01K5CQ4V3H8M2XWQH6V3T9RB1D';
const GOOD = '01K5CQ1AAAAAAAAAAAAAAAAAAA';
const detail = (status: string, mode = 'record') =>
  ({ run: { runId: RUN, status, mode, command: { argv: ['node', 'agent.mjs'], cwd: '/work' } }, source: null, judged: null, calls: [], summary: { cost: { spent: 0, saved: 0, captured: 0 }, imported: null } }) as unknown as RunDetail;
const args = { order_id: 'A-1042', amount: 240 };
const call = { call: { callNo: 3, name: 'issue_refund', kind: 'tool' }, request: { args } } as unknown as CallDetail;
const config: ChecksConfig = {
  version: 'c0ffee12'.repeat(8),
  exists: true,
  indent: '  ',
  order: ['goldens/refund-flow'],
  read: { keys: {}, tests: { 'goldens/refund-flow': 't1' } },
  hasTests: true,
  relaid: false,
  agent: 'node agent.mjs',
  goldens: [{ path: 'goldens/refund-flow', key: 'goldens/refund-flow', pattern: false, mode: { label: 'replay', hint: 'replays offline' }, runId: GOOD, inStore: true, entry: { expect: { tools: { send_email: 0 } } }, error: null }],
  redactions: 0,
  judges: [],
  models: ['claude-haiku-4-5'],
};
const context: CheckContext = { runId: RUN, at: { callNo: 3, tool: 'issue_refund', args, effect: 'write' }, tools: [{ callNo: 3, tool: 'issue_refund', args, effect: 'write' }], before: [], fields: [], conds: [] };
const preview: CheckPreview = { total: 1, judged: [{ runId: GOOD, labels: ['good'], outcome: 'passed', na: false, why: [], checks: [] }], counts: { passed: 1, failed: 0, inconclusive: 0, notApplicable: 0 }, notes: [], tools: ['issue_refund'], goldens: [], madeFrom: null };
const suggestion = (expect: Fragment) => ({ shape: 'value' as const, expect, label: labels(expect)[0] });

function stub(answer: (ask: SuggestionsAsk) => Promise<CheckSuggestions>) {
  return { goldens: vi.fn(async () => config), context: vi.fn(async () => context), preview: vi.fn(async () => preview), suggestions: vi.fn(answer), save: vi.fn() };
}
/** The builder made from the call of `run`. */
const fromCall = (run: RunDetail) => ({ run, call, kind: 'never' });
/** The builder drawn: from a call once the recordings are judged, on a golden once its checks are listed (with none being built, nothing is judged). */
async function open(checks: ReturnType<typeof stub>, props: object = fromCall(detail('failed'))): Promise<Rendered> {
  r = await render(shell({ client: { checks } as never, toast: vi.fn(), refresh: vi.fn(), guard: (fn: () => void) => (fn(), true) }, createElement(Builder, { ...props, onClose: vi.fn() } as unknown as BuilderProps)));
  const drawn = 'golden' in props ? '.cb-units li' : '.cb-count';
  await r.until('the builder drawn', () => r!.all(drawn).length > 0);
  return r;
}
const said = (el: { textContent: string }) => el.textContent.replace(/\s+/g, ' ').trim();

describe('Suggested in the builder', () => {
  it('lists the rules that fail the run and its good run, sends the labels it holds, and takes one in place of the rule being built', async () => {
    const checks = stub(async () => ({ runId: RUN, goods: [GOOD], suggestions: [suggestion(VALUE), suggestion(WHEN)] }));
    await open(checks);
    await r!.until('the suggestions', () => r!.all('.cb-sug').length === 2);
    expect(checks.suggestions).toHaveBeenLastCalledWith({ run: RUN, at: 3, have: ['send_email called 0 times', 'issue_refund called 0 times'] });
    const section = r!.one('.cb-sugs').closest('section')!;
    expect(said(section.querySelector('.cb-k')!)).toBe('Suggestedeach fails 01K5CQ4V3H and not its good run, 01K5CQ1AAA');
    expect(r!.all('.cb-sug').map(said)).toEqual([`${labels(VALUE)[0]}Use rule`, `${labels(WHEN)[0]}Use rule`]);
    const [first] = r!.all('.cb-sug button');
    expect(r!.all('.cb-sug code').find((c) => c.id === first.getAttribute('aria-describedby'))?.textContent).toBe(labels(VALUE)[0]);
    // The section comes between the recordings judged and The change.
    const order = r!.all('.cb-sec').map((x) => said(x.querySelector('.k') ?? x));
    expect(order.indexOf(order.find((k) => k.startsWith('Suggested'))!)).toBe(order.findIndex((k) => k.startsWith('Against your recordings')) + 1);
    first.focus();
    await r!.click(first);
    // In place of the rule being built; its row leaves at once, and focus goes to the one now in its place.
    expect(r!.all('.cb-units li').map(said)).toEqual(['send_email called 0 timesEditRemove', `${labels(VALUE)[0]}newRemove`]);
    expect(r!.all('.cb-sug').map(said)).toEqual([`${labels(WHEN)[0]}Use rule`]);
    expect(r!.focused()).toBe(r!.one('.cb-sug button'));
    await r!.until('the labels it holds sent', () => JSON.stringify(checks.suggestions.mock.lastCall?.[0]).includes('get_policy'));
  });

  it('adds a rule beside a check of the golden’s in the editor, and focuses the editor once none is left', async () => {
    const checks = stub(async () => ({ runId: RUN, goods: [GOOD, '01K5CQ2BBBBBBBBBBBBBBBBBBB'], suggestions: [suggestion(ORDER)] }));
    await open(checks);
    await r!.until('the suggestion', () => r!.all('.cb-sug').length === 1);
    expect(said(r!.one('.cb-sugs').closest('section')!.querySelector('.cb-sub')!)).toBe('each fails 01K5CQ4V3H and none of your 2 good runs');
    await r!.click(r!.all('.cb-units li button')[0]);
    expect(said(r!.one('.cb-sug'))).toBe(`${labels(ORDER)[0]}Add rule`);
    r!.one('.cb-sug button').focus();
    await r!.click(r!.one('.cb-sug button'));
    expect(r!.all('.cb-units li').map(said).at(-1)).toBe(`${labels(ORDER)[0]}newRemove`);
    expect(r!.all('.cb-sug')).toEqual([]);
    expect(r!.focused()).toBe(r!.one('.cb-kinds [aria-pressed="true"]'));
  });

  it('moves the focus on when a later answer drops the row that has it', async () => {
    const used = labels(VALUE)[0];
    // Once the first is used, the next answer no longer holds the one the focus went on to.
    const checks = stub(async (ask) => ({ runId: RUN, goods: [GOOD], suggestions: ask.have.includes(used) ? [suggestion(ORDER)] : [suggestion(VALUE), suggestion(WHEN), suggestion(ORDER)] }));
    await open(checks);
    await r!.until('the suggestions', () => r!.all('.cb-sug').length === 3);
    const [first] = r!.all('.cb-sug button');
    first.focus();
    await r!.click(first);
    expect(said(r!.focused().closest('.cb-sug')!)).toBe(`${labels(WHEN)[0]}Use rule`);
    await r!.until('the next answer', () => r!.all('.cb-sug').length === 1);
    expect(said(r!.one('.cb-sug'))).toBe(`${labels(ORDER)[0]}Use rule`);
    expect(r!.focused()).toBe(r!.one('.cb-sug button'));
  });

  it('asks nothing on a recording that didn’t fail, a replay, a capture, or a golden', async () => {
    // The capture failed and was recorded, not replayed: only that it was imported leaves it out.
    const capture: RunDetail = { ...detail('failed'), source: 'traffic.har' };
    const golden = (edit: number | null) => ({ golden: 'goldens/refund-flow', edit });
    for (const props of [fromCall(detail('completed')), fromCall(detail('failed', 'replay')), fromCall(capture), golden(null), golden(0)]) {
      const checks = stub(async () => ({ runId: RUN, goods: [GOOD], suggestions: [suggestion(VALUE)] }));
      await open(checks, props);
      await new Promise((done) => setTimeout(done, 400));
      expect(checks.suggestions).not.toHaveBeenCalled();
      expect(r!.all('.cb-sug')).toEqual([]);
      await r!.unmount();
      r = null;
    }
  });

  it('says a failed read under its head, with Retry', async () => {
    const checks = stub(async () => Promise.reject(new Error('the pool is busy')));
    await open(checks);
    await r!.until('the failed read', () => r!.all('.cb-sec .k').some((k) => k.textContent === 'Suggested'));
    const section = r!.all('.cb-sec').find((x) => x.querySelector('.k')?.textContent === 'Suggested')!;
    expect(said(section)).toContain('the pool is busy');
    expect(section.querySelector('button')?.textContent).toBe('Retry');
  });
});
