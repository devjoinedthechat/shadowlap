import { checkStatus } from '../check-status.js';
import { aboutUsd, formatUsd } from '../prices.js';
import type { CheckStatus, JudgeOutcome, StoredCheck } from '../types.js';
import { pathAt, type CallCondition, type CallRule, type CountRange, type JudgeCheck, type Matcher, type Operand } from './grammar.js';

/**
 * What checks are called and how a result reads, as every report writes them: a count, a budget, a
 * rule's clauses, a judge's question, and a result's line with its mark. Nothing here needs Node, so
 * the dashboard's pages can say a check in the same words.
 */

export function formatCount(r: CountRange, noun = 'time'): string {
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (r.min === r.max) return plural(r.min);
  if (r.max === Infinity) return `at least ${plural(r.min)}`;
  if (r.min === 0) return `at most ${plural(r.max)}`;
  return `${r.min} to ${plural(r.max)}`;
}

/**
 * A budget in a label, not a measurement. `formatUsd` carries sub-cent precision because a measured
 * cost needs it, which turns the `<= 0.50` someone wrote into `$0.500`. A threshold is a round
 * number a person chose, so it is echoed as they would have written it; the measured side that a
 * failure reports still goes through `formatUsd`.
 */
const threshold = (n: number) => (n === 0 ? '$0' : n < 0.01 ? formatUsd(n) : `$${n.toFixed(2)}`);

export function formatAmount(r: CountRange): string {
  if (r.min === r.max) return `exactly ${threshold(r.min)}`;
  if (r.max === Infinity) return `at least ${threshold(r.min)}`;
  if (r.min === 0) return `at most ${threshold(r.max)}`;
  return `${threshold(r.min)} to ${threshold(r.max)}`;
}

/**
 * A value in a label or a detail: JSON in one line, cut at 80 characters. Cut inside a quoted
 * string, it is closed after the mark (`"Replay works; forks…"`), so a detail's quotes stay paired
 * and what reads one (a fix's title, which takes its first problem) never takes a value's own '; '
 * for the one between problems.
 */
export function showValue(v: unknown): string {
  if (v === undefined) return 'nothing';
  const s = JSON.stringify(v) ?? String(v);
  if (s.length <= 80) return s;
  let cut = s.slice(0, 79);
  let quoted = false;
  let i = 0;
  while (i < cut.length) {
    if (cut[i] === '\\') i += 2;
    else {
      if (cut[i] === '"') quoted = !quoted;
      i++;
    }
  }
  // An escape cut in two loses its backslash, which would escape the closing quote.
  if (i > cut.length) cut = cut.slice(0, -1);
  return quoted ? `${cut}…"` : `${cut}…`;
}

const operandText = (o: Operand) => ('ref' in o ? o.ref.text : showValue(o.value));
export const PHRASE = { '=': '=', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=', includes: 'includes', startsWith: 'starts with', endsWith: 'ends with', in: 'in' } as const;
export const NEGATED = { '=': '!=', '!=': '=', '<': '>=', '<=': '>', '>': '<=', '>=': '<', includes: "doesn't include", startsWith: "doesn't start with", endsWith: "doesn't end with", in: 'not in' } as const;

/** What a matcher asks of the value at `path`, as clauses: `amount <= lookup_order.result.total`. */
function clauses(m: Matcher, path: string): string[] {
  const subject = path || 'the value';
  switch (m.op) {
    case 'object':
      return m.keys.length ? m.keys.flatMap((k) => clauses(k.matcher, pathAt(path, k.key))) : [`${subject} is an object`];
    case 'array':
      return m.items.every((i) => i.op === '=' && 'value' in i.operand)
        ? [`${subject} = ${showValue(m.items.map((i) => ((i as { operand: { value: unknown } }).operand.value)))}`]
        : [`${subject} has ${m.items.length} item${m.items.length === 1 ? '' : 's'}`, ...m.items.flatMap((i, n) => clauses(i, pathAt(path, n)))];
    case 'all':
      return m.matchers.flatMap((x) => clauses(x, path));
    case 'not': {
      const inner = m.matcher;
      if (inner.op === 'in' || inner.op === 'includes' || inner.op === 'startsWith' || inner.op === 'endsWith' || inner.op === '=' || inner.op === '!=') return [clause(inner, subject, true)];
      return [`not (${clauses(inner, path).join(' and ')})`];
    }
    default:
      return [clause(m, subject, false)];
  }
}

function clause(m: Extract<Matcher, { op: keyof typeof PHRASE }>, subject: string, negated: boolean): string {
  const word = (negated ? NEGATED : PHRASE)[m.op];
  if (m.op === 'in') return `${subject} ${word} ${'list' in m ? m.list.text : `[${m.items.map(operandText).join(', ')}]`}`;
  return `${subject} ${word} ${operandText(m.operand)}`;
}

const andList = (items: readonly string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`);
export const orList = (items: readonly string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)!}`);

/** `every issue_refund call: after lookup_order, amount <= lookup_order.result.total`. */
export function callRuleLabel(rule: CallRule): string {
  const parts = [...(rule.after.length ? [`after ${andList(rule.after)}`] : []), ...(rule.args ? clauses(rule.args, '') : [])];
  return `every ${rule.tool} call: ${parts.join(', ')}`;
}

/** `when lookup_order has result.total > 200`, `when escalate is called`. */
export function conditionLabel(c: CallCondition): string {
  const parts = [...(c.args ? clauses(c.args, 'args') : []), ...(c.result ? clauses(c.result, 'result') : [])];
  return parts.length ? `when ${c.tool} has ${parts.join(' and ')}` : `when ${c.tool} is called`;
}

/** `judge "explains-escalation" answers yes`. */
export const judgeLabel = (j: JudgeCheck): string => `judge "${j.name}" answers ${j.pass}`;

// ---- Reports ------------------------------------------------------------------------------------

/** Each status's mark at the start of a report's line. */
export const CHECK_MARKS: Readonly<Record<CheckStatus, string>> = { passed: '✓', failed: '✗', inconclusive: '?', 'not-applicable': '–' };

/**
 * A check as one line of a report: `✓ label`, `✗ label: detail`, `? label: inconclusive · detail`,
 * `– label: not applicable · detail`, and a judge's reason after it. `join` is what comes between a
 * failed check's label and its detail (a replay's report writes `, but `). A result kept before
 * results had a status reads as `ok` says.
 */
export function checkLine(c: StoredCheck, join = ': '): string {
  return `${CHECK_MARKS[checkStatus(c)]} ${checkWords(c, join)}`;
}

/** The line `checkLine` writes, without its mark, for a report that draws the mark itself. A judge's verdict says where it came from. */
export function checkWords(c: StoredCheck, join = ': '): string {
  const source = c.judge ? judgeSource(c.judge) : null;
  const reason = `${c.reason ? ` · ${c.reason}` : ''}${source ? ` (${source})` : ''}`;
  switch (checkStatus(c)) {
    case 'passed':
      return `${c.label}${reason}`;
    case 'failed':
      return `${c.label}${join}${c.detail ?? ''}${reason}`;
    case 'inconclusive':
      return `${c.label}: inconclusive · ${c.detail ?? ''}`;
    case 'not-applicable':
      return `${c.label}: not applicable · ${c.detail ?? ''}`;
  }
}

/**
 * Where a judge check's verdict came from and what it cost, with what was done to what it read:
 * `judged from the recording, free`, `judged live, ≈$0.0004 · read with 1 redaction rule applied`.
 * Null for a check that was not judged.
 */
export function judgeSource(j: JudgeOutcome): string | null {
  if (!j.source) return null;
  const read = [
    j.redactions ? `read with ${j.redactions} redaction rule${j.redactions === 1 ? '' : 's'} applied` : null,
    j.normalized ? 'values that change every run masked' : null,
    j.cut ? `${j.cut.toLocaleString('en-US')} characters left out` : null,
  ].filter(Boolean);
  const how = j.source === 'recording' ? 'judged from the recording, free' : `judged live, ${j.cost === null ? `no price for ${j.model}` : aboutUsd(j.cost)}`;
  return [how, ...read].join(' · ');
}
