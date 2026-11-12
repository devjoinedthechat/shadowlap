import { lowerRecorded } from '../../../engine/src/checks/fields.js';
import { EXPECT_KEYS, asNumber } from '../../../engine/src/checks/grammar.js';
import { checkLabels } from '../../../engine/src/checks/labels.js';
import { isReference, parseExpect, referenceTo } from '../../../engine/src/checks/parse.js';
import { isObject } from '../../../engine/src/is-object.js';
import { messageOf } from '../../../engine/src/message-of.js';
import { quoteArgv } from '../../../engine/src/text.js';
import { plural, shortRunId } from '../../../engine/src/words.js';
import type { CheckContext, CheckPreview, ContextCall, GoldenEntry, PreviewGolden, PreviewRow, ResultField } from '../checks-api.js';
import { goldenName } from '../format.js';
import type { CheckKind } from '../run/check-part.js';

/**
 * The check builder's rules, pure: a golden's checks as units (a tool's count, a rule on calls, a
 * condition, a judge, a budget), the rule being built in the editor's terms and the part of an
 * `expect` object it writes, the check merged as the file will hold it, refused in parseExpect's
 * words on the rule they name, the golden it goes to, the entry's lines as the file lays them out,
 * and the preview's words. Only ui/checks/ and tests import it: it carries the engine's parser.
 */

/** A part of an expect object: one check or, written as JSON, several. */
export type Fragment = Record<string, unknown>;

const LISTS: readonly string[] = ['calls', 'when', 'judge'];
const KNOWN: readonly string[] = EXPECT_KEYS;

/** A check's units in the file's order: each tool under `tools` as the file lists them, then the rest as EXPECT_KEYS orders them, each rule of a list apart, then any key the grammar doesn't know. */
export function unitsOf(expect: unknown): Fragment[] {
  if (!isObject(expect)) return [];
  const out: Fragment[] = [];
  for (const k of EXPECT_KEYS) {
    const v = expect[k];
    if (v === undefined) continue;
    if (k === 'tools' && isObject(v)) for (const [name, c] of Object.entries(v)) out.push({ tools: { [name]: c } });
    else if (LISTS.includes(k) && Array.isArray(v)) for (const x of v) out.push({ [k]: [x] });
    else out.push({ [k]: v });
  }
  for (const [k, v] of Object.entries(expect)) if (!KNOWN.includes(k)) out.push({ [k]: v });
  return out;
}

/** Units back into one check: a tool's count in its first place, the last to name it winning; a list's rules in order; a key the grammar doesn't know after the rest. */
export function mergeFragments(frags: readonly Fragment[]): Fragment {
  const e: Fragment = {};
  for (const f of frags) {
    for (const [k, v] of Object.entries(f)) {
      if (k === 'tools' && isObject(v)) e.tools = { ...(isObject(e.tools) ? e.tools : {}), ...v };
      else if (LISTS.includes(k) && Array.isArray(v)) e[k] = [...(Array.isArray(e[k]) ? (e[k] as unknown[]) : []), ...(v as unknown[])];
      else e[k] = v;
    }
  }
  const keys = [...EXPECT_KEYS.filter((k) => e[k] !== undefined), ...Object.keys(e).filter((k) => !KNOWN.includes(k))];
  return Object.fromEntries(keys.map((k) => [k, e[k]]));
}

const toolOf = (f: Fragment | null): string | null => (f && isObject(f.tools) ? (Object.keys(f.tools)[0] ?? null) : null);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

// ---- The rule in the editor's terms -------------------------------------------------------------

/** An argument of the call, its recorded value, ticked when only calls with it count. */
export interface ArgPick {
  k: string;
  v: unknown;
  on: boolean;
}

export const CALL_OPS = ['<=', '<', '>=', '>', '=', '!='] as const;
export type CallOp = (typeof CALL_OPS)[number];
export const COND_OPS = ['>', '>=', '<', '<=', '='] as const;
export type CondOp = (typeof COND_OPS)[number];
export type ThenCount = 0 | 1 | '>= 1';
export const THEN_COUNTS: ReadonlyArray<readonly [ThenCount, string]> = [
  [0, '0 times'],
  ['>= 1', 'at least 1 time'],
  [1, '1 time'],
];
export const JUDGE_READS = [
  ['answer', 'the answer'],
  ['output', 'the output'],
  ['run', 'the whole run'],
] as const;
export type JudgeReads = (typeof JUDGE_READS)[number][0];

/** A value compared to: an earlier call's, by reference (`@lookup_order.result.total`), or a number as typed. */
export type Operand = { ref: string } | { num: string | number };

/** What a condition reads: a number field of a tool's result; `callNo` is the call a chip offers it from. */
export interface Cond {
  tool: string;
  field: string;
  callNo: number | null;
}

export type Rule =
  | { kind: 'never'; tool: string; args: ArgPick[] }
  | { kind: 'must'; tool: string; count: '>= 1' | 1; args: ArgPick[] }
  | { kind: 'every'; tool: string; after: string[]; arg: string; op: CallOp; val: Operand | null; focus: 'after' | 'value' | null }
  | { kind: 'when'; cond: Cond | null; op: CondOp; num: string | number; then: { tool: string; count: ThenCount } }
  | { kind: 'judge'; name: string; question: string; of: JudgeReads; model: string; pass: 'yes' | 'no' }
  | { kind: 'json'; json: string };
export type RuleKind = Rule['kind'];

/** The kinds, in the order the builder offers them. */
export const KINDS: ReadonlyArray<readonly [RuleKind, string]> = [
  ['never', 'Never'],
  ['must', 'Must call'],
  ['every', 'Every call'],
  ['when', 'When… then'],
  ['judge', 'Ask a judge'],
  ['json', 'JSON'],
];

/** A call's arguments as the editor lists them, each with its recorded value: none ticked, the first, or all. */
export function argList(args: unknown, on: 'none' | 'first' | 'all'): ArgPick[] {
  return Object.entries(isObject(args) ? args : {}).map(([k, v], i) => ({ k, v, on: on === 'all' || (on === 'first' && i === 0) }));
}

/** The arguments of a call that hold a number. */
/** A result field's reference as a rule reads it, by the engine's path rule: `@lookup_order.result.total`, `@lookup_order.result["unit price"]`. */
export const fieldRef = (f: { tool: string; field: string }): string => referenceTo(f.tool, 'result', f.field);

export const numberArgs = (args: unknown): string[] => Object.keys(isObject(args) ? args : {}).filter((k) => asNumber((args as Fragment)[k]) !== null);

/** What the editor reads of the run: the call it is made from, the run's calls, the tools it offers, the model a judge starts on. */
export interface RuleContext {
  call: ContextCall | null;
  context: CheckContext | null;
  tools: readonly string[];
  model: string;
}

/** A tool's first call in the run, whose arguments a rule on it starts from. */
export const firstCall = (ctx: RuleContext, tool: string): ContextCall | null => (ctx.call?.tool === tool ? ctx.call : (ctx.context?.tools.find((t) => t.tool === tool) ?? null));

/**
 * A condition's threshold: another value the run recorded below this one (a policy's limit), else a
 * round number below it.
 */
export function threshold(all: readonly ResultField[], f: Pick<ResultField, 'tool' | 'field' | 'value'>): number {
  const lower = lowerRecorded(all, f);
  if (lower !== null) return lower;
  const v = asNumber(f.value) ?? 0;
  const p = v > 0 ? 10 ** Math.floor(Math.log10(v)) : NaN;
  return [5, 2, 1].map((x) => x * p).find((x) => x < v) ?? Math.floor(v / 2);
}

const condOf = (f: ResultField): Cond => ({ tool: f.tool, field: f.field, callNo: f.callNo });

/** A rule as the check menu prefills it from the call, or as a kind picked in the editor starts. */
export function ruleFrom(kind: CheckKind | 'json', ctx: RuleContext): Rule {
  const writes = ctx.context?.tools.find((t) => t.effect === 'write');
  const c = ctx.call ?? writes ?? ctx.context?.tools[0] ?? null;
  const tool = c?.tool ?? ctx.tools[0] ?? '';
  const args = c?.args;
  if (kind === 'never' || kind === 'neverargs') return { kind: 'never', tool, args: argList(args, kind === 'neverargs' ? 'all' : 'none') };
  if (kind === 'must') return { kind: 'must', tool, count: '>= 1', args: argList(args, 'first') };
  if (kind === 'after' || kind === 'every') return { kind: 'every', tool, after: [], arg: kind === 'every' ? (numberArgs(args)[0] ?? '') : '', op: '<=', val: null, focus: kind === 'after' ? 'after' : 'value' };
  if (kind === 'when') {
    const reads = ctx.context?.fields ?? [];
    const f = reads.find((x) => x.tool !== tool) ?? reads[0] ?? null;
    return { kind: 'when', cond: f ? condOf(f) : null, op: '>', num: f ? threshold(ctx.context?.conds ?? [], f) : '', then: { tool, count: 0 } };
  }
  if (kind === 'judge') return { kind: 'judge', name: '', question: '', of: 'answer', model: ctx.model, pass: 'yes' };
  return { kind: 'json', json: tool ? pretty({ tools: { [tool]: 0 } }) : '{}' };
}

/** JSON picked as a kind starts from the rule as built so far, else as the call's Never. */
export function jsonFrom(rule: Rule | null, ctx: RuleContext): Rule {
  const f = rule ? fragmentOf(rule).f : null;
  return f ? { kind: 'json', json: pretty(f) } : ruleFrom('json', ctx);
}

/** The part of an expect object a rule writes, or why it can't yet. */
export type Written = { f: Fragment; why: null } | { f: null; why: string };
const yes = (f: Fragment): Written => ({ f, why: null });
const no = (why: string): Written => ({ f: null, why });

/** An empty object, written as JSON. */
export const EMPTY_JSON = 'An expect object with one check or more, such as { "tools": { "send_email": 1 } }';

export function fragmentOf(rule: Rule | null): Written {
  if (!rule) return no('Pick what it checks');
  switch (rule.kind) {
    case 'never':
    case 'must':
      return toolFragment(rule);
    case 'every':
      return everyFragment(rule);
    case 'when':
      return whenFragment(rule);
    case 'judge':
      return judgeFragment(rule);
    default:
      return jsonFragment(rule.json);
  }
}

function toolFragment(r: Extract<Rule, { kind: 'never' | 'must' }>): Written {
  if (!r.tool) return no('Pick a tool');
  const on = r.args.filter((a) => a.on);
  // A tool's arguments are matched exactly as recorded: none is read as a reference.
  const args = Object.fromEntries(on.map((a) => [a.k, a.v]));
  const count = r.kind === 'never' ? 0 : r.count;
  const v = !on.length ? count : count === '>= 1' ? { args } : { count, args };
  return yes({ tools: { [r.tool]: v } });
}

function everyFragment(r: Extract<Rule, { kind: 'every' }>): Written {
  const rule: Fragment = { tool: r.tool };
  if (r.after.length) rule.after = r.after.length === 1 ? r.after[0] : [...r.after];
  if (r.arg && r.val) rule.args = { [r.arg]: { [r.op]: 'ref' in r.val ? r.val.ref : (asNumber(r.val.num) ?? r.val.num) } };
  if (rule.after !== undefined || rule.args !== undefined) return yes({ calls: [rule] });
  return no(r.focus === 'after' ? 'Pick the tools it must come after' : r.arg ? 'Pick a value from an earlier call, or type a number' : 'Pick the tools it must come after, or a value');
}

function whenFragment(r: Extract<Rule, { kind: 'when' }>): Written {
  if (!r.cond) return no('Pick the condition from a call');
  const n = asNumber(r.num);
  if (n === null) return no('Give the condition a number');
  return yes({ when: [{ if: { tool: r.cond.tool, result: { [r.cond.field]: { [r.op]: n } } }, then: { tools: { [r.then.tool]: r.then.count } } }] });
}

/** An empty field keeps the form's own why, the question's first; a name as typed goes to parseJudge, whose words refuse it. */
function judgeFragment(r: Extract<Rule, { kind: 'judge' }>): Written {
  if (!r.question.trim()) return no('Ask it a question it answers yes or no');
  if (!r.name) return no('Give it a name');
  return yes({ judge: [{ name: r.name, question: r.question.trim(), of: r.of, model: r.model, pass: r.pass }] });
}

function jsonFragment(text: string): Written {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    return no(`Not JSON yet: ${messageOf(err).replace(/^JSON\.parse: /, '')}`);
  }
  if (!isObject(v)) return no('expect must be an object');
  return Object.keys(v).length ? yes(v) : no(EMPTY_JSON);
}

/** A unit back in the editor's terms; one the editor has no form for opens as JSON. */
export function ruleOf(f: Fragment): Rule {
  const json: Rule = { kind: 'json', json: pretty(f) };
  if (Object.keys(f).length !== 1) return json;
  const one = (v: unknown) => (Array.isArray(v) && v.length === 1 ? (v[0] as unknown) : undefined);
  const rule = isObject(f.tools) ? toolRuleOf(f.tools) : f.calls ? callRuleOf(one(f.calls)) : f.when ? whenRuleOf(one(f.when)) : f.judge ? judgeRuleOf(one(f.judge)) : null;
  return rule ?? json;
}

const onlyOf = (o: Fragment, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

function toolRuleOf(tools: Fragment): Rule | null {
  const [name, ...more] = Object.keys(tools);
  if (name === undefined || more.length) return null;
  const v = tools[name];
  if (isObject(v) && (!onlyOf(v, ['count', 'args']) || (v.args !== undefined && !isObject(v.args)))) return null;
  const count = isObject(v) ? (v.count ?? '>= 1') : v;
  const args = argList(isObject(v) ? v.args : {}, 'all');
  if (count === 0 || count === '0') return { kind: 'never', tool: name, args };
  if (count === '>= 1' || count === 1 || count === '1') return { kind: 'must', tool: name, count: count === '>= 1' ? '>= 1' : 1, args };
  return null;
}

function afterOf(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (typeof v === 'string') return [v];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
}

/** One argument against one value an operator compares, else none: a rule of more opens as JSON. */
function comparison(args: unknown): { arg: string; op: CallOp; val: Operand } | null {
  if (!isObject(args)) return null;
  const [arg, ...more] = Object.keys(args);
  const p = arg === undefined ? null : args[arg];
  if (more.length || !isObject(p)) return null;
  const [op, ...ops] = Object.keys(p);
  if (ops.length || !(CALL_OPS as readonly unknown[]).includes(op)) return null;
  const x = p[op!];
  const val: Operand | null = isReference(x) ? { ref: x as string } : asNumber(x) !== null ? { num: x as number | string } : null;
  return val ? { arg: arg!, op: op as CallOp, val } : null;
}

function callRuleOf(raw: unknown): Rule | null {
  if (!isObject(raw) || typeof raw.tool !== 'string' || !onlyOf(raw, ['tool', 'after', 'args'])) return null;
  const after = afterOf(raw.after);
  if (!after) return null;
  const rule = { kind: 'every' as const, tool: raw.tool, after, arg: '', op: '<=' as CallOp, val: null, focus: null };
  if (raw.args === undefined) return rule;
  const c = comparison(raw.args);
  return c ? { ...rule, ...c } : null;
}

function whenRuleOf(raw: unknown): Rule | null {
  if (!isObject(raw) || !onlyOf(raw, ['if', 'then']) || !isObject(raw.if) || !isObject(raw.then)) return null;
  const c = raw.if;
  const then = raw.then;
  if (typeof c.tool !== 'string' || !onlyOf(c, ['tool', 'result']) || !isObject(c.result) || !onlyOf(then, ['tools']) || !isObject(then.tools)) return null;
  const [field, ...fields] = Object.keys(c.result);
  const p = field === undefined ? null : c.result[field];
  const [tool, ...tools] = Object.keys(then.tools);
  if (fields.length || tools.length || tool === undefined || !isObject(p)) return null;
  const [op, ...ops] = Object.keys(p);
  const count = then.tools[tool];
  if (ops.length || !(COND_OPS as readonly unknown[]).includes(op) || asNumber(p[op!]) === null || ![0, 1, '>= 1'].includes(count as never)) return null;
  return { kind: 'when', cond: { tool: c.tool, field: field!, callNo: null }, op: op as CondOp, num: p[op!] as number, then: { tool, count: count as ThenCount } };
}

function judgeRuleOf(raw: unknown): Rule | null {
  if (!isObject(raw) || !onlyOf(raw, ['name', 'question', 'of', 'model', 'pass'])) return null;
  const { name, question, model, of = 'answer', pass = 'yes' } = raw;
  const reads = JUDGE_READS.map((r) => r[0] as unknown);
  if (typeof name !== 'string' || typeof question !== 'string' || typeof model !== 'string' || !reads.includes(of) || (pass !== 'yes' && pass !== 'no')) return null;
  return { kind: 'judge', name, question, of: of as JudgeReads, model, pass };
}

/** A unit's labels as main labels a check, or its JSON where the engine can't read it alone. */
export function labelsOf(f: Fragment): string[] {
  try {
    return checkLabels(parseExpect(f, 'expect'));
  } catch {
    return [JSON.stringify(f)];
  }
}

// ---- The golden's checks as they change ---------------------------------------------------------

/** One check of the golden's, or one added: as the file holds it, the rule once opened in the editor, and what it writes now. */
export interface Unit {
  /** As the file holds it; null for one added here. */
  orig: Fragment | null;
  /** The editor's terms, once opened in it. */
  rule: Rule | null;
  /** What it writes now: the file's until it is edited; null while the rule can't write yet. */
  f: Fragment | null;
  why: string | null;
  gone: boolean;
}

export const fileUnit = (f: Fragment): Unit => ({ orig: f, rule: null, f, why: null, gone: false });
export const blankUnit = (): Unit => ({ orig: null, rule: null, f: null, why: null, gone: false });
/** A unit with its rule changed: what it writes is worked out again. */
export const withRule = (u: Unit, rule: Rule): Unit => ({ ...u, rule, ...fragmentOf(rule) });
/** A unit opened in the editor: its rule read from what it writes, which stays as it is until the rule changes. */
export const opened = (u: Unit): Unit => (u.rule || !u.f ? u : { ...u, rule: ruleOf(u.f) });

/** A row of the list: the unit with what it writes once refused, and its tag. */
export interface UnitRow {
  f: Fragment | null;
  why: string | null;
  replaced: boolean;
  tag: '' | 'new' | 'changed' | 'removed' | 'replaced';
  labels: string[];
}

export interface Settled {
  rows: UnitRow[];
  /** The check as the file will hold it. */
  merged: Fragment;
  /** parseExpect's words on the merged check, and the unit they name (-1 for none). */
  refusal: { at: number; why: string } | null;
  /** The merged check differs from the golden's. */
  changed: boolean;
  /** What is added or changed, on its own, else the rule being edited: what the preview judges. */
  draft: Fragment | null;
}

function replacedIn(fs: ReadonlyArray<Fragment | null>, gone: readonly boolean[]): boolean[] {
  const last = new Map<string, number>();
  fs.forEach((f, i) => {
    const t = toolOf(f);
    if (t !== null && !gone[i]) last.set(t, i);
  });
  return fs.map((f, i) => {
    const t = toolOf(f);
    return t !== null && !gone[i] && last.get(t) !== i;
  });
}

/** The unit parseExpect's words name: a tool's count by its name, a list's rule by its place in the merged list, a key by its name. */
export function unitNamed(why: string, fs: ReadonlyArray<Fragment | null>, live: readonly number[]): number {
  const lastWith = (has: (f: Fragment) => boolean) => [...live].reverse().find((i) => has(fs[i]!)) ?? -1;
  const tool = /^expect\.tools\["(.*?)"\]/.exec(why);
  if (tool) return lastWith((f) => isObject(f.tools) && tool[1]! in f.tools);
  const item = /^expect\.(calls|when|judge)\[(\d+)\]/.exec(why);
  if (item) {
    let n = Number(item[2]);
    for (const i of live) {
      const list = fs[i]![item[1]!];
      const len = Array.isArray(list) ? list.length : 0;
      if (n < len) return i;
      n -= len;
    }
    return -1;
  }
  const key = /^expect\.(\w+)/.exec(why) ?? /^expect has an unknown key "(.*?)"/.exec(why);
  return key ? lastWith((f) => key[1]! in f) : -1;
}

/** The golden's checks as the units now stand: the list's rows, the merged check, its refusal, and the draft the preview judges. */
export function settle(units: readonly Unit[], base: Fragment | null, active: number): Settled {
  const gone = units.map((u) => u.gone);
  const fs = units.map((u) => u.f);
  const whys = units.map((u) => u.why);
  const live = () => fs.flatMap((f, i) => (f && !gone[i] ? [i] : []));
  let refusal: Settled['refusal'] = null;
  // A refused rule is still a change: Save says why it can't save it, never that nothing changed.
  const asBuilt = mergeFragments(live().map((i) => fs[i]!));
  try {
    parseExpect(asBuilt, 'expect');
  } catch (err) {
    const why = messageOf(err);
    const named = unitNamed(why, fs, live());
    const at = named >= 0 ? named : fs[active] && !gone[active] ? active : -1;
    refusal = { at, why };
    if (at >= 0) {
      fs[at] = null;
      whys[at] = why;
    }
  }
  const replaced = replacedIn(fs, gone);
  const merged = mergeFragments(live().map((i) => fs[i]!));
  const rows = units.map((u, i): UnitRow => {
    const f = fs[i] ?? null;
    // Changed is said of the one in the editor, as the mock has it; Save's change box shows the rest.
    const tag = u.gone ? 'removed' : replaced[i] ? 'replaced' : !u.orig ? 'new' : i === active && f && !same(u.orig, f) ? 'changed' : '';
    return { f, why: whys[i] ?? null, replaced: replaced[i]!, tag, labels: f ? labelsOf(f) : [u.rule ? (whys[i] ?? '') : 'a new check'] };
  });
  const edits = fs.flatMap((f, i) => (f && !gone[i] && !replaced[i] && !same(f, units[i]!.orig) ? [f] : []));
  const own = fs[active];
  const draftOf = edits.length ? edits : own && !gone[active] ? [own] : [];
  return { rows, merged, refusal, changed: !same(mergeFragments(unitsOf(base)), asBuilt), draft: draftOf.length ? mergeFragments(draftOf) : null };
}

/** Why Save is off, in the mock's order, or null once it can save. */
export function saveWhy(s: Settled, units: readonly Unit[], active: number, golden: string | null): string | null {
  const own = units[active];
  const ownWhy = own && !own.gone ? s.rows[active]?.why : null;
  if (!s.changed) return 'Nothing changed yet';
  if (ownWhy) return ownWhy;
  if (s.refusal) return s.refusal.why;
  if (units.some((u, i) => !s.rows[i]!.f && !u.gone && u.rule)) return 'Finish the rule first';
  return golden ? null : 'No golden to save it under';
}

/** The draft as the preview judges it and the command repeats it: without its judges, whose verdicts no recording holds yet. */
export function withoutJudges(draft: Fragment): Fragment {
  const out: Fragment = {};
  for (const [k, v] of Object.entries(draft)) {
    if (k === 'judge') continue;
    const when = k === 'when' && Array.isArray(v) ? v.filter((w) => !(isObject(w) && isObject(w.then) && w.then.judge !== undefined)) : v;
    if (!Array.isArray(when) || when.length) out[k] = when;
  }
  return out;
}

// ---- The golden it goes to ----------------------------------------------------------------------

/** The tool a rule is about: its own, or the one a condition counts. */
export const ruleTool = (rule: Rule | null): string | null => (!rule ? null : 'tool' in rule ? rule.tool || null : rule.kind === 'when' ? rule.then.tool || null : null);

/**
 * The golden a check from a call goes to while none is picked: the first of the agent's goldens whose
 * own recording passes it and not only as not applicable, one that calls the rule's tool first (Never
 * needs no such call), else the first. A golden whose pack can't be read is left out.
 */
export function pickGolden(goldens: readonly GoldenEntry[], answers: readonly PreviewGolden[] | null, rule: Rule | null): string | null {
  // A golden whose pack the preview couldn't read is left out too.
  const usable = goldens.filter((g) => !g.error && !answers?.some((a) => a.path === g.path && a.error));
  const first = usable[0] ?? goldens[0];
  if (!first || !answers || !rule || !fragmentOf(rule).f) return first?.path ?? null;
  const tool = ruleTool(rule);
  const seen = usable.map((g) => {
    const a = answers.find((x) => x.path === g.path);
    return { g, ok: !!a?.row && a.row.outcome === 'passed' && !a.row.na, calls: !!tool && !!a?.tools.includes(tool) };
  });
  const pick = seen.find((x) => x.ok && (rule.kind === 'never' || x.calls)) ?? seen.find((x) => x.ok) ?? seen[0];
  return (pick?.g ?? first).path;
}

// ---- The change ---------------------------------------------------------------------------------

/** The golden's entry after the save: the one that holds its checks (a pattern's copied), with `expect` set, or taken out when empty. */
export function entryAfter(entry: unknown, expect: Fragment): Fragment {
  const next: Fragment = isObject(entry) ? structuredClone(entry) : {};
  if (Object.keys(expect).length) next.expect = expect;
  else delete next.expect;
  return next;
}

/** A line of the change's box, as CodeBox's `lines` draws it: going (`-`), coming (`+`), or kept and faint (` `). */
export interface BoxLine {
  op: ' ' | '+' | '-';
  text: string;
}

/** The entry's lines as the file lays them out under `tests`: its key two levels in, a comma after it where entries follow. */
export function entryLines(key: string, entry: unknown, indent: string, comma: boolean): string[] {
  if (entry === undefined || entry === null) return [];
  const t = JSON.stringify(entry, null, indent).split('\n');
  return t.map((l, i) => `${indent.repeat(2)}${i ? l : `${JSON.stringify(key)}: ${l}`}${comma && i === t.length - 1 ? ',' : ''}`);
}

function diffLines(a: readonly string[], b: readonly string[]): Array<[' ' | '-' | '+', string]> {
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: Array<[' ' | '-' | '+', string]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push([' ', a[i]!]);
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || L[i + 1]![j]! >= L[i]![j + 1]!)) out.push(['-', a[i++]!]);
    else out.push(['+', b[j++]!]);
  }
  return out;
}

/** What the change's box reads: the config as read, and where the entry goes. */
export interface ChangeOf {
  key: string;
  /** The exact entry the file holds now, or none (a pattern's, or none at all). */
  before: unknown;
  after: Fragment;
  indent: string;
  /** The keys under `tests` in the file's order. */
  order: readonly string[];
  /** The file exists, and holds `tests`. */
  exists: boolean;
  hasTests: boolean;
}

/**
 * The golden's entry before and after, line by line, under `"tests": {` as context: what goes, what
 * comes, two kept lines around them, and `…` for the entries around it. With no `tests`, it comes in
 * whole, the file's braces too with no file.
 */
export function changeLines(o: ChangeOf): BoxLine[] {
  const at = o.order.indexOf(o.key);
  const comma = at >= 0 && at < o.order.length - 1;
  const lines = diffLines(entryLines(o.key, o.before, o.indent, comma), entryLines(o.key, o.after, o.indent, comma));
  const mark = (x: [' ' | '-' | '+', string]): BoxLine => ({ op: x[0], text: x[1] });
  if (!o.hasTests) {
    const whole = [`${o.indent}"tests": {`, ...entryLines(o.key, o.after, o.indent, false), `${o.indent}}`];
    return (o.exists ? whole : ['{', ...whole, '}']).map((text) => mark(['+', text]));
  }
  // Under the entries' keys: two of the file's indents, after the mark's two columns the box draws.
  const gap: BoxLine = { op: ' ', text: `${o.indent.repeat(2)}…` };
  const near = (k: number) => lines.slice(Math.max(0, k - 2), k + 3).some((y) => y[0] !== ' ');
  const out: BoxLine[] = [{ op: ' ', text: `${o.indent}"tests": {` }, ...(at > 0 || (at < 0 && o.order.length) ? [gap] : [])];
  lines.forEach((x, k) => {
    if (x[0] === ' ' && !near(k) && k && k < lines.length - 1) {
      if (out.at(-1) !== gap) out.push(gap);
      return;
    }
    out.push(mark(x));
  });
  if (comma) out.push(gap);
  return out;
}

/** The file's version as the change's header shows it. */
export const versionWords = (version: string): string => (version === 'absent' ? 'a new file' : `version ${version.slice(0, 8)}`);

// ---- Against your recordings --------------------------------------------------------------------

export interface PreviewNote {
  text: string;
  /** Amber needs a look before saving; grey is for the record. */
  tone: 'amber' | 'grey';
}

/** A label the recordings it fails share, named only when it tells them apart: none it passes has it, and not every one judged. */
export function labelledWords(failing: readonly PreviewRow[], all: readonly PreviewRow[]): string {
  if (!failing.length) return '';
  const passing = all.filter((r) => r.outcome === 'passed');
  const common = failing[0]!.labels.filter((l) => l !== 'good' && failing.every((r) => r.labels.includes(l)) && !passing.some((r) => r.labels.includes(l)) && !all.every((r) => r.labels.includes(l)));
  const l = common.includes('bug') ? 'bug' : common[0];
  if (!l) return '';
  return `, ${failing.length === 1 ? 'labelled' : failing.length === 2 ? 'both labelled' : 'all labelled'} ${l}`;
}

/** The count's line: how many recordings it passes, fails and can't settle. */
export function headWords(p: Pick<CheckPreview, 'counts' | 'judged'>): string {
  const { passed, failed, inconclusive, notApplicable } = p.counts;
  const lab = labelledWords(
    p.judged.filter((r) => r.outcome === 'failed'),
    p.judged,
  );
  const inc = inconclusive ? ` · ${inconclusive} inconclusive` : '';
  if (!passed && !inconclusive && !notApplicable) return `Fails all ${plural(failed, 'recording')}${lab}`;
  if (!passed) return `Fails ${plural(failed, 'recording')}${lab}${inc}`;
  return `Passes ${plural(passed, 'recording')} · fails ${failed}${lab}${inc}`;
}

const firstWhy = (row: PreviewRow) => row.why[0] ?? '';

/** The note on the run the check is made from: only for a recording made from a call whose own check failed. */
export function madeFromNote(row: PreviewRow | null, failedItsCheck: boolean): PreviewNote | null {
  if (!row || !failedItsCheck) return null;
  const id = shortRunId(row.runId);
  if (row.outcome === 'failed') return { text: `Fails ${id}, the run it is made from: ${firstWhy(row)}`, tone: 'grey' };
  if (row.outcome === 'passed') return { text: `Passes ${id}, the run it is made from, which failed its check`, tone: 'amber' };
  return { text: `Inconclusive on ${id}, the run it is made from: ${firstWhy(row)}`, tone: 'amber' };
}

/** The note on the golden's own recording, which its next test judges. */
export function goldenNote(g: PreviewGolden | null): PreviewNote | null {
  if (!g) return null;
  const name = goldenName(g.path);
  if (!g.row) return g.error ? { text: `${name}’s own recording isn’t judged: ${g.error}`, tone: 'grey' } : null;
  const id = shortRunId(g.row.runId);
  if (g.row.na) return { text: `${name}’s own recording, ${id}: not applicable · ${g.row.checks[0]?.detail ?? ''}`, tone: 'grey' };
  if (g.row.outcome === 'failed') return { text: `Fails ${name}’s own recording, ${id}: its next test fails · ${firstWhy(g.row)}`, tone: 'amber' };
  if (g.row.outcome === 'inconclusive') return { text: `Inconclusive on ${name}’s own recording, ${id}: its next test is inconclusive · ${firstWhy(g.row).replace(/^inconclusive · /, '')}`, tone: 'amber' };
  return { text: `${name}’s own recording, ${id}, passes it`, tone: 'grey' };
}

/** What Show and Hide name: the recordings it fails, the inconclusive ones, or both. */
export function rowsWords(failed: number, inconclusive: number): string {
  if (failed && inconclusive) return `${plural(failed + inconclusive, 'recording')} it fails or is inconclusive on`;
  return failed ? `${plural(failed, 'recording')} it fails` : plural(inconclusive, 'inconclusive recording');
}

/** The command that gives the numbers shown: the recordings judged by id, the first three shown short and the whole of it copied with every id in full, as `shadowlap check` takes them. */
export function checkCommand(ids: readonly string[], expect: Fragment): { view: string; full: string; more: string | null } {
  const tail = quoteArgv(['--expect', JSON.stringify(expect)]);
  const full = `${quoteArgv(['shadowlap', 'check', ...ids])} ${tail}`;
  const cut = ids.length > 3;
  const view = `${quoteArgv(['shadowlap', 'check', ...ids.slice(0, 3).map(shortRunId)])}${cut ? ' …' : ''} ${tail}`;
  return { view, full, more: cut ? `and ${ids.length - 3} more recordings by id, all in its copy` : null };
}

// ---- The builder's head and the list's actions --------------------------------------------------

/** The builder's title: from a call, `Add check`; on a golden, adding to it or changing its check. */
export function titleOf(golden: string | null, o: { edit: boolean; fromCall: boolean }): string {
  if (golden && o.edit) return `Edit check of ${goldenName(golden)}`;
  return golden && !o.fromCall ? `Add check to ${goldenName(golden)}` : 'Add check';
}

/** The lead under it, where the check isn't made from a call (that lead names the call in code). */
export function goldenLead(golden: string | null, edit: boolean): string {
  if (!golden) return 'Makes a check, judged on your recordings as you build it.';
  return `${edit ? `Changes ${goldenName(golden)}’s check` : `Adds a check to ${goldenName(golden)}`}, judged on your recordings as you build it.`;
}

/** The golden's checks being built: its units, and the one in the editor. */
export interface Units {
  units: Unit[];
  active: number;
}

const openAt = (units: Unit[], active: number): Units => ({ units: units.map((u, j) => (j === active ? opened(u) : u)), active });

/** Edit: the unit goes to the editor, its rule read from what it writes. */
export const editAt = (s: Units, i: number): Units => openAt(s.units, i);

/** Remove: a rule of this session goes; one the file holds is crossed out, with Keep, and the editor moves to the first left. */
export function removeAt(s: Units, i: number): Units {
  const x = s.units[i];
  if (!x) return s;
  if (!x.orig) {
    const units = s.units.filter((_, j) => j !== i);
    return openAt(units, Math.max(0, Math.min(s.active > i ? s.active - 1 : s.active, units.length - 1)));
  }
  const units = s.units.map((u, j) => (j === i ? { ...u, gone: true } : u));
  if (i !== s.active) return { units, active: s.active };
  const next = units.findIndex((u) => !u.gone);
  return openAt(units, next < 0 ? i : next);
}

export const keepAt = (s: Units, i: number): Units => ({ units: s.units.map((u, j) => (j === i ? { ...u, gone: false } : u)), active: s.active });

/** Add rule: a blank rule in the editor, unless one is blank already. */
export const addBlank = (s: Units): Units => (s.units.some((u) => !u.orig && !u.f && !u.rule) ? s : { units: [...s.units, blankUnit()], active: s.units.length });

/** Another golden's checks in place of the last one's, keeping the rules being built. */
export function withGolden(s: Units, base: unknown): Units {
  const keep = s.units.filter((u) => !u.orig);
  const cur = s.units[s.active];
  const units = [...unitsOf(base).map(fileUnit), ...keep];
  const at = cur ? units.indexOf(cur) : -1;
  return { units, active: Math.max(0, at >= 0 ? at : units.length - 1) };
}

/**
 * The units on the file as read again after a save refused for a file changed since: the golden's
 * checks as they are now, a check added meanwhile among them, each edit or removal of a check still
 * there kept on it (one changed or gone meanwhile takes what the file holds), and this session's own
 * rules after them, the editor on the same unit where it is still there.
 */
export function rebased(s: Units, base: unknown): Units {
  const was = s.units.filter((u) => u.orig);
  const used = new Set<Unit>();
  const file = unitsOf(base).map((f) => {
    const kept = was.find((u) => !used.has(u) && same(u.orig, f));
    if (!kept) return fileUnit(f);
    used.add(kept);
    return kept;
  });
  const units = [...file, ...s.units.filter((u) => !u.orig)];
  const cur = s.units[s.active];
  const at = cur ? units.indexOf(cur) : -1;
  return at >= 0 ? { units, active: at } : openAt(units, Math.max(0, units.length - 1));
}

/**
 * What a change is told by, against the same when the builder opened: the golden picked, and each
 * unit that differs from the file, so neither the golden a check follows nor a rule only opened is one.
 */
export const snapOf = (picked: string | null, s: Units): string => JSON.stringify([picked, s.units.filter((u) => !u.orig || u.gone || !same(u.f, u.orig)).map((u) => [u.orig, u.f, u.gone])]);

/** The checks a golden has now: its entry's `expect`, a pattern's for a pattern key. */
export const baseOf = (g: GoldenEntry | null): Fragment | null => (g && isObject(g.entry) && isObject(g.entry.expect) ? g.entry.expect : null);

/** Where a save writes: the golden's exact key with its entry, else a key of its own, a pattern's other keys copied (Q8). */
export function entryOf(g: GoldenEntry): { key: string; before: unknown; from: unknown } {
  if (g.key && !g.pattern) return { key: g.key, before: g.entry, from: g.entry };
  return { key: g.path, before: null, from: g.pattern ? g.entry : null };
}

/** How many judges a draft asks: under `judge`, and as a condition's `then`. */
export function judgesIn(draft: Fragment | null): number {
  if (!draft) return 0;
  const own = Array.isArray(draft.judge) ? draft.judge.length : 0;
  const then = Array.isArray(draft.when) ? draft.when.filter((w) => isObject(w) && isObject(w.then) && w.then.judge !== undefined).length : 0;
  return own + then;
}

/** Beside other rules, a judge isn't counted: a recording holds no verdict for a judge it never asked. When its verdicts get recorded (Q24). */
export function judgesNote(n: number, fork: boolean): PreviewNote | null {
  if (!n) return null;
  const who = n === 1 ? 'Its judge isn’t counted' : `Its ${n} judges aren’t counted`;
  return { text: `${who}: ${fork ? 'its verdicts are recorded in the golden’s next test’s attempts' : 'a recording holds no verdict for a new judge until the golden is packed or updated'}`, tone: 'grey' };
}

/** Against your recordings' notes in their order: the server's (amber, as the CLI's `! ` notes), the run it is made from, the golden's own recording, then the judges'. */
export function previewNotes(p: CheckPreview, o: { golden: string | null; failedItsCheck: boolean; judges: number; fork: boolean }): PreviewNote[] {
  const g = o.golden ? (p.goldens.find((x) => x.path === o.golden) ?? null) : null;
  const notes: Array<PreviewNote | null> = [...p.notes.map((text) => ({ text, tone: 'amber' as const })), madeFromNote(p.madeFrom, o.failedItsCheck), goldenNote(g), judgesNote(o.judges, o.fork)];
  return notes.filter((n): n is PreviewNote => !!n);
}

/** A judge added or changed in this session: a replay golden's next offline test reads it inconclusive until Update golden asks it. */
export const judgeAdded = (units: readonly Unit[]): boolean => units.some((u) => !!u.f && 'judge' in u.f && !same(u.f, u.orig));

// ---- Suggested checks ---------------------------------------------------------------------------

/** The labels of the checks the builder holds, which suggestions leave out: each row's that writes something, a removed one's too, as the golden holds it until Save. */
export const haveOf = (s: Pick<Settled, 'rows'>): string[] => [...new Set(s.rows.flatMap((r) => (r.f ? r.labels : [])))];

/** What a suggestion's button does: Use rule puts it in place of the rule being built here, Add rule adds it beside a check of the golden's open in the editor. */
export function suggestVerb(s: Units): 'Use rule' | 'Add rule' {
  const u = s.units[s.active];
  return u && !u.orig ? 'Use rule' : 'Add rule';
}

/** A suggestion taken into the builder, as suggestVerb says: in place of the rule being built, else as a rule of its own, in the editor. Nothing is saved. */
export function withSuggestion(s: Units, f: Fragment): Units {
  const rule = ruleOf(f);
  if (suggestVerb(s) === 'Use rule') return { units: s.units.map((u, j) => (j === s.active ? withRule(u, rule) : u)), active: s.active };
  return { units: [...s.units, withRule(blankUnit(), rule)], active: s.units.length };
}
