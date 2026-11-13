import { describe, expect, it } from 'vitest';
import { parseExpect } from '../../engine/src/checks/parse.js';
import type { CheckContext, GoldenEntry, PreviewGolden, PreviewRow } from '../ui/checks-api.js';
import {
  EMPTY_JSON,
  addBlank,
  blankUnit,
  editAt,
  entryOf,
  fieldRef,
  goldenLead,
  judgeAdded,
  judgesIn,
  judgesNote,
  keepAt,
  previewNotes,
  rebased,
  removeAt,
  snapOf,
  titleOf,
  withGolden,
  changeLines,
  checkCommand,
  fileUnit,
  fragmentOf,
  goldenNote,
  headWords,
  jsonFrom,
  madeFromNote,
  mergeFragments,
  opened,
  pickGolden,
  ruleFrom,
  ruleOf,
  rowsWords,
  saveWhy,
  settle,
  threshold,
  unitsOf,
  withRule,
  withoutJudges,
  type BoxLine,
  type Rule,
  type RuleContext,
  type Unit,
  type Units,
} from '../ui/checks/model.js';

/**
 * The check builder's rules, pure (ui/checks/model.ts): units and the merged check, each kind's
 * sentence and the part of an expect object it writes, @-references, refusals in parseExpect's words
 * on the rule they name, the golden it goes to, the change's lines and the preview's words.
 */

const context: CheckContext = {
  runId: 'run-0123456789abcdef',
  at: { callNo: 4, tool: 'issue_refund', args: { order_id: 'A-1', amount: 240, reason: 'late' }, effect: 'write' },
  tools: [
    { callNo: 1, tool: 'lookup_order', args: { order_id: 'A-1' }, effect: 'read' },
    { callNo: 2, tool: 'get_policy', args: {}, effect: 'read' },
    { callNo: 4, tool: 'issue_refund', args: { order_id: 'A-1', amount: 240, reason: 'late' }, effect: 'write' },
  ],
  before: ['lookup_order', 'get_policy'],
  fields: [
    { tool: 'lookup_order', field: 'total', value: 240, callNo: 1 },
    { tool: 'get_policy', field: 'limit', value: 200, callNo: 2 },
  ],
  conds: [
    { tool: 'lookup_order', field: 'total', value: 240, callNo: 1 },
    { tool: 'get_policy', field: 'limit', value: 200, callNo: 2 },
  ],
};
const ctx: RuleContext = { call: context.at, context, tools: ['lookup_order', 'get_policy', 'issue_refund'], model: 'claude-haiku-4-5' };
const written = (rule: Rule) => fragmentOf(rule).f;

describe('a golden’s checks as units', () => {
  it('lists each tool apart in the file’s order, then the rest as the grammar orders them, each rule of a list apart', () => {
    const expect_ = { calls: [{ tool: 'a', after: 'b' }, { tool: 'c', after: 'd' }], tools: { send_email: 0, escalate: '>= 1' }, cost: '<= 0.50' };
    expect(unitsOf(expect_)).toEqual([{ tools: { send_email: 0 } }, { tools: { escalate: '>= 1' } }, { cost: '<= 0.50' }, { calls: [{ tool: 'a', after: 'b' }] }, { calls: [{ tool: 'c', after: 'd' }] }]);
    expect(mergeFragments(unitsOf(expect_))).toEqual({ tools: { send_email: 0, escalate: '>= 1' }, cost: '<= 0.50', calls: expect_.calls });
  });

  it('keeps a key the grammar doesn’t know as a unit of its own, so a save never drops it', () => {
    expect(unitsOf({ tools: { a: 0 }, budget: 3 })).toEqual([{ tools: { a: 0 } }, { budget: 3 }]);
  });

  it('keeps a tool’s count in its first place, the last to name it winning', () => {
    expect(Object.entries(mergeFragments([{ tools: { a: 0 } }, { tools: { b: 1 } }, { tools: { a: '>= 1' } }]).tools as object)).toEqual([
      ['a', '>= 1'],
      ['b', 1],
    ]);
  });
});

describe('what each kind writes', () => {
  it('Never: a count of 0, with the ticked arguments as recorded', () => {
    expect(written(ruleFrom('never', ctx))).toEqual({ tools: { issue_refund: 0 } });
    expect(written(ruleFrom('neverargs', ctx))).toEqual({ tools: { issue_refund: { count: 0, args: { order_id: 'A-1', amount: 240, reason: 'late' } } } });
  });

  it('Must call: at least once, with the first argument ticked; once, with its count', () => {
    const must = ruleFrom('must', ctx);
    expect(written(must)).toEqual({ tools: { issue_refund: { args: { order_id: 'A-1' } } } });
    expect(written({ ...must, count: 1 } as Rule)).toEqual({ tools: { issue_refund: { count: 1, args: { order_id: 'A-1' } } } });
    expect(written({ ...must, args: [] } as Rule)).toEqual({ tools: { issue_refund: '>= 1' } });
  });

  it('Every call: after one tool or several, and a number argument against an earlier call’s value or a number', () => {
    const after = ruleFrom('after', ctx);
    expect(fragmentOf(after)).toEqual({ f: null, why: 'Pick the tools it must come after' });
    expect(written({ ...after, after: ['lookup_order'] } as Rule)).toEqual({ calls: [{ tool: 'issue_refund', after: 'lookup_order' }] });
    expect(written({ ...after, after: ['lookup_order', 'get_policy'] } as Rule)).toEqual({ calls: [{ tool: 'issue_refund', after: ['lookup_order', 'get_policy'] }] });
    const every = ruleFrom('every', ctx);
    expect(every).toMatchObject({ arg: 'amount', op: '<=', focus: 'value' });
    expect(fragmentOf(every).why).toBe('Pick a value from an earlier call, or type a number');
    expect(fragmentOf({ ...every, arg: '' } as Rule).why).toBe('Pick the tools it must come after, or a value');
    expect(written({ ...every, val: { ref: '@get_policy.result.limit' } } as Rule)).toEqual({ calls: [{ tool: 'issue_refund', args: { amount: { '<=': '@get_policy.result.limit' } } }] });
    // A number typed keeps its type.
    expect(written({ ...every, val: { num: '150' } } as Rule)).toEqual({ calls: [{ tool: 'issue_refund', args: { amount: { '<=': 150 } } }] });
  });

  it('When… then: the first number field of another tool before the call, above a value the run recorded below it, then the call’s tool never', () => {
    const when = ruleFrom('when', ctx);
    expect(when).toMatchObject({ cond: { tool: 'lookup_order', field: 'total', callNo: 1 }, op: '>', num: 200, then: { tool: 'issue_refund', count: 0 } });
    expect(written(when)).toEqual({ when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { tools: { issue_refund: 0 } } }] });
    expect(fragmentOf({ ...when, cond: null } as Rule).why).toBe('Pick the condition from a call');
    expect(fragmentOf({ ...when, num: '' } as Rule).why).toBe('Give the condition a number');
  });

  it('takes a round number below a value where the run recorded none below it', () => {
    expect(threshold([], { tool: 'a', field: 'x', value: 240 })).toBe(200);
    expect(threshold([], { tool: 'a', field: 'x', value: 40 })).toBe(20);
    expect(threshold([], { tool: 'a', field: 'x', value: 1 })).toBe(0);
    expect(threshold([{ tool: 'b', field: 'y', value: '75', callNo: 2 }], { tool: 'a', field: 'x', value: 90 })).toBe(75);
  });

  it('Ask a judge: an empty question and name, the question’s why first, then the name’s; a name as typed goes to the engine', () => {
    const judge = ruleFrom('judge', ctx);
    expect(judge).toEqual({ kind: 'judge', name: '', question: '', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes' });
    expect(fragmentOf(judge).why).toBe('Ask it a question it answers yes or no');
    expect(fragmentOf({ ...judge, question: 'Does it say why?' } as Rule).why).toBe('Give it a name');
    expect(written({ ...judge, question: ' Does it say why? ', name: 'says why' } as Rule)).toEqual({ judge: [{ name: 'says why', question: 'Does it say why?', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes' }] });
  });

  it('JSON: its whys, and picked as a kind it starts from the rule so far, else as the call’s Never', () => {
    expect(fragmentOf({ kind: 'json', json: '{ "tools": ' }).why).toMatch(/^Not JSON yet: /);
    expect(fragmentOf({ kind: 'json', json: '[1]' }).why).toBe('expect must be an object');
    expect(fragmentOf({ kind: 'json', json: '{}' }).why).toBe(EMPTY_JSON);
    expect(jsonFrom(ruleFrom('must', ctx), ctx)).toEqual({ kind: 'json', json: JSON.stringify({ tools: { issue_refund: { args: { order_id: 'A-1' } } } }, null, 2) });
    expect(jsonFrom(null, ctx)).toEqual({ kind: 'json', json: JSON.stringify({ tools: { issue_refund: 0 } }, null, 2) });
  });
});

describe('a rule back in the editor’s terms', () => {
  it('reads each form it has back as it was written', () => {
    for (const f of [
      { tools: { issue_refund: 0 } },
      { tools: { issue_refund: { count: 0, args: { reason: 'late' } } } },
      { tools: { escalate: '>= 1' } },
      { calls: [{ tool: 'issue_refund', after: 'lookup_order' }] },
      { calls: [{ tool: 'issue_refund', args: { amount: { '<=': '@get_policy.result.limit' } } }] },
      { when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { tools: { issue_refund: 0 } } }] },
      { judge: [{ name: 'says-why', question: 'Does it say why?', of: 'run', model: 'gpt-5', pass: 'no' }] },
    ]) {
      expect(written(ruleOf(f))).toEqual(f);
    }
  });

  it('opens a rule it has no form for as JSON', () => {
    for (const f of [
      { tools: { issue_refund: 2 } },
      { cost: '<= 0.50' },
      { calls: [{ tool: 'issue_refund', args: { amount: { '<=': 1 }, reason: 'late' } }] },
      { calls: [{ tool: 'issue_refund', args: { reason: { includes: 'late' } } }] },
      { calls: [{ tool: 'issue_refund', args: { amount: { '<=': 'lots' } } }] },
      { when: [{ if: { tool: 'lookup_order', args: { id: 1 }, result: { total: { '>': 1 } } }, then: { tools: { a: 0 } } }] },
      { tools: { a: 0, b: 0 } },
    ]) {
      expect(ruleOf(f)).toEqual({ kind: 'json', json: JSON.stringify(f, null, 2) });
    }
  });

  it('opens a unit of the file without changing what it writes', () => {
    const u = opened(fileUnit({ tools: { issue_refund: '0' } }));
    expect(u.rule).toMatchObject({ kind: 'never', tool: 'issue_refund' });
    expect(u.f).toEqual({ tools: { issue_refund: '0' } });
  });
});

const units = (...fs: Array<Record<string, unknown>>): Unit[] => fs.map(fileUnit);

describe('the golden’s checks as they change', () => {
  it('marks a tool’s count replaced by a new count of the same tool, and the new one new', () => {
    const base = { tools: { issue_refund: 0 }, calls: [{ tool: 'issue_refund', after: 'lookup_order' }] };
    const us = [...units(...unitsOf(base)), withRule(blankUnit(), ruleFrom('must', ctx))];
    const s = settle(us, base, 2);
    expect(s.rows.map((r) => r.tag)).toEqual(['replaced', '', 'new']);
    expect(s.merged).toEqual({ tools: { issue_refund: { args: { order_id: 'A-1' } } }, calls: base.calls });
    expect(s.draft).toEqual({ tools: { issue_refund: { args: { order_id: 'A-1' } } } });
    expect(s.changed).toBe(true);
    expect(saveWhy(s, us, 2, 'goldens/refund')).toBeNull();
    expect(saveWhy(s, us, 2, null)).toBe('No golden to save it under');
  });

  it('marks a removed check, and one edited changed', () => {
    const base = { tools: { a: 0, b: 1 } };
    const us = units(...unitsOf(base));
    us[0] = { ...us[0], gone: true };
    us[1] = withRule(opened(us[1]), { kind: 'must', tool: 'b', count: '>= 1', args: [] });
    const s = settle(us, base, 1);
    expect(s.rows.map((r) => r.tag)).toEqual(['removed', 'changed']);
    expect(s.merged).toEqual({ tools: { b: '>= 1' } });
    // Changed is said of the one in the editor only, as the mock has it.
    expect(settle([...us, blankUnit()], base, 2).rows.map((r) => r.tag)).toEqual(['removed', '', 'new']);
  });

  it('says nothing changed, then why the rule can’t be saved yet, then to finish another rule first', () => {
    const base = { tools: { a: 0 } };
    expect(saveWhy(settle(units(base), base, 0), units(base), 0, 'g')).toBe('Nothing changed yet');
    // A rule that can't write yet changes nothing, as the mock has it: its row says why.
    const blank = [...units(base), withRule(blankUnit(), ruleFrom('after', ctx))];
    expect(saveWhy(settle(blank, base, 1), blank, 1, 'g')).toBe('Nothing changed yet');
    const us = [withRule(opened(units(base)[0]), { kind: 'must', tool: 'a', count: 1, args: [] }), withRule(blankUnit(), ruleFrom('after', ctx))];
    expect(saveWhy(settle(us, base, 1), us, 1, 'g')).toBe('Pick the tools it must come after');
    expect(saveWhy(settle(us, base, 0), us, 0, 'g')).toBe('Finish the rule first');
  });

  it('puts parseExpect’s words on the rule they name, by its place in the merged list', () => {
    const base = { calls: [{ tool: 'issue_refund', after: 'lookup_order' }] };
    const empty = withRule(blankUnit(), { kind: 'json', json: '{ "calls": [{ "tool": "escalate" }] }' });
    const us = [...units(base), empty];
    const s = settle(us, base, 1);
    expect(s.refusal?.at).toBe(1);
    expect(s.refusal?.why).toMatch(/^expect\.calls\[1\] checks nothing: give it "after", "args" or both/);
    expect(s.rows[1]).toMatchObject({ f: null, why: s.refusal?.why });
    expect(saveWhy(s, us, 1, 'g')).toBe(s.refusal?.why);
  });

  it('names a judge whose name is taken across the check, on the second', () => {
    const judge = (name: string) => ({ judge: [{ name, question: 'Is it polite?', model: 'claude-haiku-4-5' }] });
    const base = judge('polite');
    const us = [...units(base), withRule(blankUnit(), { kind: 'judge', name: 'polite', question: 'Is it short?', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes' })];
    const s = settle(us, base, 1);
    expect(s.refusal).toMatchObject({ at: 1 });
    expect(s.refusal?.why).toMatch(/^expect\.judge\[1\]\.name "polite" is already the name of expect\.judge\[0\]/);
  });

  it('names a tool’s count by its name, and a judge’s name in the engine’s words', () => {
    const us = [withRule(blankUnit(), { kind: 'json', json: '{ "tools": { "a": "lots" } }' })];
    expect(settle(us, null, 0).refusal).toMatchObject({ at: 0, why: expect.stringMatching(/^expect\.tools\["a"\] must be a count/) as unknown });
    const named = [withRule(blankUnit(), { kind: 'judge', name: 'says why', question: 'Does it?', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes' })];
    expect(settle(named, null, 0).refusal?.why).toMatch(/^expect\.judge\[0\]\.name must be a short name of letters/);
  });

  it('judges the draft without its judges', () => {
    expect(withoutJudges({ tools: { a: 0 }, judge: [{ name: 'j' }] })).toEqual({ tools: { a: 0 } });
    expect(withoutJudges({ when: [{ if: {}, then: { judge: [] } }, { if: {}, then: { tools: {} } }] })).toEqual({ when: [{ if: {}, then: { tools: {} } }] });
    expect(withoutJudges({ judge: [{ name: 'j' }] })).toEqual({});
  });
});

const golden = (path: string, over: Partial<GoldenEntry> = {}): GoldenEntry => ({ path, key: path, pattern: false, mode: { label: 'replay', hint: '' }, runId: `run-${path}`, inStore: true, entry: null, error: null, ...over });
const row = (outcome: PreviewRow['outcome'], over: Partial<PreviewRow> = {}): PreviewRow => ({ runId: 'run-aaaaaaaaaaaa1234', labels: [], outcome, na: false, why: [], checks: [], ...over });
const answer = (path: string, r: PreviewRow | null, tools: string[] = []): PreviewGolden => ({ path, runId: `run-${path}`, row: r, tools, error: null });

describe('the golden it goes to', () => {
  const gs = [golden('goldens/a'), golden('goldens/b'), golden('goldens/c')];
  it('follows the rule to the first golden whose recording passes it and calls its tool; Never needs no such call', () => {
    const answers = [answer('goldens/a', row('failed'), ['issue_refund']), answer('goldens/b', row('passed'), []), answer('goldens/c', row('passed'), ['issue_refund'])];
    expect(pickGolden(gs, answers, ruleFrom('must', ctx))).toBe('goldens/c');
    expect(pickGolden(gs, answers, ruleFrom('never', ctx))).toBe('goldens/b');
  });

  it('never picks one it passes only as not applicable, nor one whose pack can’t be read', () => {
    const answers = [answer('goldens/a', row('passed', { na: true }), ['issue_refund']), answer('goldens/b', row('passed'), ['issue_refund'])];
    expect(pickGolden(gs, answers, ruleFrom('must', ctx))).toBe('goldens/b');
    expect(pickGolden([golden('goldens/a', { error: 'no pack' }), gs[1]], null, null)).toBe('goldens/b');
    expect(pickGolden(gs, [answer('goldens/a', row('failed'))], ruleFrom('must', ctx))).toBe('goldens/a');
    // One whose pack the preview couldn't read is no fallback either.
    expect(pickGolden(gs, [{ ...answer('goldens/a', null), error: 'not a pack' }, answer('goldens/b', row('failed'))], ruleFrom('must', ctx))).toBe('goldens/b');
    expect(pickGolden([], null, null)).toBeNull();
  });
});

describe('the change', () => {
  /** A line by its colour (`add`, `del`, or `.` kept), then its mark and its text, as the box draws them but for `−`. */
  const drawn = (l: BoxLine) => `${l.op === '+' ? 'add' : l.op === '-' ? 'del' : '.'} ${l.op} ${l.text}`;
  it('shows the golden’s entry as the file lays it out, what goes and what comes, two kept lines around them and … for the entries around it', () => {
    const before = { expect: { tools: { a: 0, b: 1, c: 2, d: 3, e: 4 } } };
    const after = { expect: { tools: { a: 0, b: 1, c: 2, d: 3, e: 5 } } };
    const lines = changeLines({ key: 'goldens/x', before, after, indent: '  ', order: ['goldens/w', 'goldens/x', 'goldens/y'], exists: true, hasTests: true });
    expect(lines.map(drawn)).toEqual([
      '.     "tests": {',
      '.       …',
      '.       "goldens/x": {',
      '.       …',
      '.             "c": 2,',
      '.             "d": 3,',
      'del -           "e": 4',
      'add +           "e": 5',
      '.           }',
      '.         }',
      '.       },',
      '.       …',
    ]);
  });

  it('lays the lines out with the file’s own indent, four spaces as two', () => {
    const before = { expect: { tools: { a: 0, b: 1, c: 2, d: 3, e: 4 } } };
    const after = { expect: { tools: { a: 0, b: 1, c: 2, d: 3, e: 5 } } };
    const lines = changeLines({ key: 'goldens/x', before, after, indent: '    ', order: ['goldens/w', 'goldens/x', 'goldens/y'], exists: true, hasTests: true });
    const sp = (n: number) => ' '.repeat(n);
    expect(lines.map(drawn)).toEqual([
      `. ${sp(6)}"tests": {`,
      `. ${sp(10)}…`,
      `. ${sp(10)}"goldens/x": {`,
      `. ${sp(10)}…`,
      `. ${sp(22)}"c": 2,`,
      `. ${sp(22)}"d": 3,`,
      `del - ${sp(20)}"e": 4`,
      `add + ${sp(20)}"e": 5`,
      `. ${sp(18)}}`,
      `. ${sp(14)}}`,
      `. ${sp(10)}},`,
      `. ${sp(10)}…`,
    ]);
  });

  it('shows an entry with no tests as it comes in whole, the file’s braces too with no file', () => {
    const after = { expect: { tools: { a: 0 } } };
    const lines = changeLines({ key: 'goldens/x', before: undefined, after, indent: '  ', order: [], exists: false, hasTests: false });
    expect(lines.every((l) => l.op === '+')).toBe(true);
    expect(lines.map((l) => `${l.op} ${l.text}`)).toEqual(['+ {', '+   "tests": {', '+     "goldens/x": {', '+       "expect": {', '+         "tools": {', '+           "a": 0', '+         }', '+       }', '+     }', '+   }', '+ }']);
  });
});

describe('against your recordings', () => {
  const counts = (passed: number, failed: number, inconclusive = 0, notApplicable = 0) => ({ passed, failed, inconclusive, notApplicable });
  it('names a label only where it tells the failing recordings apart', () => {
    const judged = [row('failed', { labels: ['refund-bug', 'bug'] }), row('failed', { labels: ['bug'] }), row('passed', { labels: ['good'] })];
    expect(headWords({ counts: counts(1, 2), judged })).toBe('Passes 1 recording · fails 2, both labelled bug');
    expect(headWords({ counts: counts(0, 2), judged: judged.slice(0, 2) })).toBe('Fails all 2 recordings');
    expect(headWords({ counts: counts(0, 1, 2), judged: [row('failed', { labels: ['bug'] }), row('inconclusive'), row('inconclusive')] })).toBe('Fails 1 recording, labelled bug · 2 inconclusive');
  });

  it('notes the run it is made from only where it failed its check, and the golden’s own recording', () => {
    expect(madeFromNote(row('passed'), false)).toBeNull();
    expect(madeFromNote(row('passed'), true)).toEqual({ text: 'Passes run-aaaaaa, the run it is made from, which failed its check', tone: 'amber' });
    expect(madeFromNote(row('failed', { why: ['issue_refund called 1 time'] }), true)).toEqual({ text: 'Fails run-aaaaaa, the run it is made from: issue_refund called 1 time', tone: 'grey' });
    expect(goldenNote(answer('goldens/refund', row('passed')))).toEqual({ text: 'refund’s own recording, run-aaaaaa, passes it', tone: 'grey' });
    expect(goldenNote(answer('goldens/refund', row('failed', { why: ['x'] })))?.tone).toBe('amber');
  });

  it('says which recordings Show opens, and the command with every id in its copy', () => {
    expect(rowsWords(2, 1)).toBe('3 recordings it fails or is inconclusive on');
    expect(rowsWords(1, 0)).toBe('1 recording it fails');
    expect(rowsWords(0, 2)).toBe('2 inconclusive recordings');
    const ids = ['run-1111111111111111', 'run-2222222222222222', 'run-3333333333333333', 'run-4444444444444444'];
    const c = checkCommand(ids, { tools: { a: 0 } });
    expect(c.full).toBe(`shadowlap check ${ids.join(' ')} --expect '{"tools":{"a":0}}'`);
    expect(c.view).toMatch(/^shadowlap check \S+ \S+ \S+ … --expect /);
    expect(c.more).toBe('and 1 more recordings by id, all in its copy');
  });
});

describe('a reference to a result field', () => {
  it('writes a field by the engine’s path rule, a key with a dot or a space in brackets, and the engine reads it as that one key', () => {
    expect(['total', 'a.b', 'unit price'].map((field) => fieldRef({ tool: 'lookup_order', field }))).toEqual(['@lookup_order.result.total', '@lookup_order.result["a.b"]', '@lookup_order.result["unit price"]']);
    for (const field of ['total', 'a.b', 'unit price']) {
      const spec = parseExpect({ calls: [{ tool: 'issue_refund', args: { amount: { '<=': fieldRef({ tool: 'lookup_order', field }) } } }] }, 'expect');
      expect(JSON.stringify(spec.calls)).toContain(JSON.stringify({ path: [{ type: 'key', key: field }] }).slice(1, -1));
    }
  });
});

describe('the builder’s head', () => {
  it('names the golden it adds to or changes, and only a check from a call names the call (Q18)', () => {
    expect(titleOf(null, { edit: false, fromCall: true })).toBe('Add check');
    expect(titleOf('goldens/refund-flow', { edit: false, fromCall: true })).toBe('Add check');
    expect(titleOf('goldens/refund-flow', { edit: false, fromCall: false })).toBe('Add check to refund-flow');
    expect(titleOf('goldens/refund-flow', { edit: true, fromCall: false })).toBe('Edit check of refund-flow');
    expect(goldenLead('goldens/refund-flow', false)).toBe('Adds a check to refund-flow, judged on your recordings as you build it.');
    expect(goldenLead('goldens/refund-flow', true)).toBe('Changes refund-flow’s check, judged on your recordings as you build it.');
    expect(goldenLead(null, false)).toBe('Makes a check, judged on your recordings as you build it.');
  });
});

describe('the list’s actions', () => {
  const file = (n: number): Unit[] => Array.from({ length: n }, (_, i) => fileUnit({ tools: { [`t${i}`]: 0 } }));
  const fresh = withRule(blankUnit(), { kind: 'never', tool: 'issue_refund', args: [] });

  it('opens a check in the editor, crosses out one the file holds with Keep, and drops one of this session', () => {
    const s: Units = { units: [...file(2), fresh], active: 2 };
    const edited = editAt(s, 0);
    expect(edited.active).toBe(0);
    expect(edited.units[0].rule).toEqual({ kind: 'never', tool: 't0', args: [] });
    const gone = removeAt(edited, 0);
    expect(gone.units[0].gone).toBe(true);
    expect(gone.active).toBe(1);
    expect(keepAt(gone, 0).units[0].gone).toBe(false);
    const dropped = removeAt({ units: [...file(1), fresh, ...file(1)], active: 2 }, 1);
    expect(dropped.units).toHaveLength(2);
    expect(dropped.active).toBe(1);
  });

  it('adds one blank rule at a time, and keeps the rules being built when the golden changes', () => {
    const s = addBlank({ units: file(1), active: 0 });
    expect(s).toEqual({ units: [...file(1), blankUnit()], active: 1 });
    expect(addBlank(s)).toBe(s);
    const moved = withGolden({ units: [...file(2), fresh], active: 2 }, { tools: { send_email: 0 } });
    expect(moved.units.map((u) => u.f)).toEqual([{ tools: { send_email: 0 } }, fresh.f]);
    expect(moved.active).toBe(1);
  });

  it('rebases the units on the file read again: a check added meanwhile among them, each edit or removal kept on a check still there, the session’s rules after', () => {
    const [t0, t1, t2] = file(3);
    const edited: Unit = { ...t0, f: { tools: { t0: 2 } } };
    const s: Units = { units: [edited, { ...t1, gone: true }, t2, fresh], active: 3 };
    // t2 removed from the file meanwhile, and a check added.
    const now = rebased(s, { tools: { t0: 0, t1: 0, added: 1 } });
    expect(now.units.map((u) => [u.orig, u.f, u.gone])).toEqual([
      [{ tools: { t0: 0 } }, { tools: { t0: 2 } }, false],
      [{ tools: { t1: 0 } }, { tools: { t1: 0 } }, true],
      [{ tools: { added: 1 } }, { tools: { added: 1 } }, false],
      [null, fresh.f, false],
    ]);
    expect(now.active).toBe(3);
    // The editor stays on an edit still there; one on a check changed meanwhile takes the file's, the editor on the last.
    expect(rebased({ ...s, active: 0 }, { tools: { t0: 0 } }).active).toBe(0);
    const changed = rebased({ ...s, active: 0 }, { tools: { t0: 5 } });
    expect(changed.units.map((u) => [u.orig, u.f])).toEqual([[{ tools: { t0: 5 } }, { tools: { t0: 5 } }], [null, fresh.f]]);
    expect(changed.active).toBe(1);
  });

  it('tells a change by the golden picked and the units that differ from the file, never by a rule only opened', () => {
    const s: Units = { units: [...file(2), fresh], active: 2 };
    expect(snapOf(null, editAt(s, 0))).toBe(snapOf(null, s));
    expect(snapOf(null, withGolden(s, { tools: { other: 1 } }))).toBe(snapOf(null, s));
    expect(snapOf('goldens/a', s)).not.toBe(snapOf(null, s));
    expect(snapOf(null, removeAt(s, 0))).not.toBe(snapOf(null, s));
  });
});

describe('where a save writes', () => {
  const g = (o: Partial<GoldenEntry>): GoldenEntry => ({ path: 'goldens/refund-flow', key: null, pattern: false, mode: { label: 'replay', hint: '' }, runId: null, inStore: false, entry: null, error: null, ...o });

  it('keeps the exact key as spelled, and gives a golden a pattern holds an entry of its own with the pattern’s keys (Q8)', () => {
    expect(entryOf(g({ key: './goldens/refund-flow', entry: { expect: {} } }))).toEqual({ key: './goldens/refund-flow', before: { expect: {} }, from: { expect: {} } });
    expect(entryOf(g({ key: 'goldens/refund-*', pattern: true, entry: { runs: 3 } }))).toEqual({ key: 'goldens/refund-flow', before: null, from: { runs: 3 } });
    expect(entryOf(g({}))).toEqual({ key: 'goldens/refund-flow', before: null, from: null });
  });
});

describe('a judge beside other rules', () => {
  const judge = { name: 'explains', question: 'Does it explain?' };

  it('counts the judges a draft asks, which no recording holds a verdict of (Q24)', () => {
    expect(judgesIn({ tools: { a: 0 }, judge: [judge], when: [{ if: { tool: 'x' }, then: { judge: [judge] } }, { if: { tool: 'y' }, then: { tools: { b: 0 } } }] })).toBe(2);
    expect(judgesIn(null)).toBe(0);
    expect(judgesNote(0, false)).toBeNull();
    expect(judgesNote(1, false)).toEqual({ text: 'Its judge isn’t counted: a recording holds no verdict for a new judge until the golden is packed or updated', tone: 'grey' });
    expect(judgesNote(2, true)?.text).toBe('Its 2 judges aren’t counted: its verdicts are recorded in the golden’s next test, in the attempts that pass its other checks');
    expect(judgeAdded([fileUnit({ judge: [judge] })])).toBe(false);
    expect(judgeAdded([withRule(blankUnit(), { kind: 'judge', name: 'explains', question: 'Does it explain?', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes' })])).toBe(true);
  });

  it('orders the notes: the server’s in amber, then the run it is made from, the golden’s own recording and the judges', () => {
    const row = (outcome: PreviewRow['outcome'], runId: string): PreviewRow => ({ runId, labels: [], outcome, na: false, why: ['why'], checks: [] });
    const golden: PreviewGolden = { path: 'goldens/refund-flow', runId: 'gold-0123456789', row: row('failed', 'gold-0123456789'), tools: [], error: null };
    const notes = previewNotes(
      { total: 1, judged: [], counts: { passed: 0, failed: 1, inconclusive: 0, notApplicable: 0 }, notes: ['Fails 1 recording labelled good: run-a'], tools: [], goldens: [golden], madeFrom: row('passed', 'run-0123456789') },
      { golden: 'goldens/refund-flow', failedItsCheck: true, judges: 1, fork: false },
    );
    expect(notes.map((n) => n.tone)).toEqual(['amber', 'amber', 'amber', 'grey']);
    expect(notes.map((n) => n.text.split(':')[0])).toEqual(['Fails 1 recording labelled good', 'Passes run-012345, the run it is made from, which failed its check', 'Fails refund-flow’s own recording, gold-01234', 'Its judge isn’t counted']);
  });
});
