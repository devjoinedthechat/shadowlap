import { describe, expect, it } from 'vitest';
import { checkLabels } from '../../engine/src/checks/labels.js';
import { parseExpect } from '../../engine/src/checks/parse.js';
import { blankUnit, fileUnit, fragmentOf, haveOf, ruleOf, settle, suggestVerb, withRule, withSuggestion, type Fragment, type Units } from '../ui/checks/model.js';

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
