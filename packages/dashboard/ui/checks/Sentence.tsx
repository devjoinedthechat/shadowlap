import type { ReactNode } from 'react';
import { asNumber } from '../../../engine/src/checks/grammar.js';
import type { ContextCall, ResultField } from '../checks-api.js';
import { SegmentedControl } from '../components/Segmented.js';
import { JudgeRows } from './Judge.js';
import { Row } from './Row.js';
import { CALL_OPS, COND_OPS, KINDS, THEN_COUNTS, argList, firstCall, numberArgs, threshold, type ArgPick, type CallOp, type CondOp, type Rule, type RuleContext, type RuleKind } from './model.js';

/**
 * The rule being built, as a sentence of picked values: what it checks (the kinds), then its rows,
 * each a label and its controls. A rule on calls compares an argument with an earlier call's value
 * (a chip, written as its reference) or a number; a condition holds on a number a call returned.
 */

type Of<K extends RuleKind> = Extract<Rule, { kind: K }>;
type Change<K extends RuleKind> = { rule: Of<K>; ctx: RuleContext; run: string | null; onRule: (rule: Rule) => void };

export interface SentenceProps {
  rule: Rule | null;
  ctx: RuleContext;
  /** The run the check is made from, as its hints name it; null for a golden's own check. */
  run: string | null;
  /** What Ask a judge's model picker offers before Other…. */
  models: readonly string[];
  onRule: (rule: Rule) => void;
  onKind: (kind: RuleKind) => void;
}

export function Sentence({ rule, ctx, run, models, onRule, onKind }: SentenceProps) {
  const kinds = (
    <SegmentedControl<RuleKind | ''>
      className="cb-kinds"
      label="What it checks"
      items={KINDS.map(([key, label]) => ({ key, label }))}
      value={rule?.kind ?? ''}
      onChange={(k) => {
        if (k && k !== rule?.kind) onKind(k);
      }}
    />
  );
  if (!rule) {
    return (
      <>
        {kinds}
        <p className="cb-note">Pick what it checks.</p>
      </>
    );
  }
  return (
    <>
      {kinds}
      <div className="cb-f">{rows(rule, { ctx, run, models, onRule })}</div>
    </>
  );
}

function rows(rule: Rule, o: { ctx: RuleContext; run: string | null; models: readonly string[]; onRule: (rule: Rule) => void }): ReactNode {
  if (rule.kind === 'never' || rule.kind === 'must') return <CountRows rule={rule} {...o} />;
  if (rule.kind === 'every') return <EveryRows rule={rule} {...o} />;
  if (rule.kind === 'when') return <WhenRows rule={rule} {...o} />;
  if (rule.kind === 'judge') return <JudgeRows rule={rule} models={o.models} onRule={o.onRule} />;
  return (
    <Row label="expect">
      <textarea className="cb-ta mono" rows={5} spellCheck={false} aria-label="The expect object" value={rule.json} onChange={(e) => o.onRule({ kind: 'json', json: e.target.value })} />
    </Row>
  );
}

/** A value as its field shows it: text as it is, anything else as JSON. */
const valueText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** A value typed over a recorded one keeps its type: a number stays a number, `true` or `false` a boolean. */
function typedAs(was: unknown, text: string): unknown {
  const n = asNumber(text);
  if (typeof was === 'number' && n !== null) return n;
  if (typeof was === 'boolean' && /^(true|false)$/.test(text)) return text === 'true';
  return text;
}

/** A pick of the tools the run and the agent call, the rule's own among them. */
function ToolSelect({ value, tools, label, onChange }: { value: string; tools: readonly string[]; label: string; onChange: (tool: string) => void }) {
  const all = value && !tools.includes(value) ? [value, ...tools] : tools;
  return (
    <select className="cb-sel" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {value ? null : <option value="">a tool…</option>}
      {all.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

function Chip({ on, title, onClick, children }: { on: boolean; title: string; onClick: () => void; children: string }) {
  return (
    <button type="button" className="cb-chip" aria-pressed={on} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

/** Never and Must call: the tool, how many times, and the arguments only calls with which count. */
function CountRows({ rule, ctx, onRule }: Change<'never' | 'must'>) {
  const c = firstCall(ctx, rule.tool);
  // A count with no arguments of its own offers the call's, unticked.
  const args = rule.args.length ? rule.args : argList(c?.args, 'none');
  const setArg = (i: number, a: Partial<ArgPick>) => onRule({ ...rule, args: args.map((x, j) => (j === i ? { ...x, ...a } : x)) });
  return (
    <>
      <Row label="tool">
        <ToolSelect value={rule.tool} tools={ctx.tools} label="The tool it counts" onChange={(tool) => onRule({ ...rule, tool, args: argList(firstCall(ctx, tool)?.args, rule.kind === 'must' ? 'first' : 'none') })} />
        <span className="cb-t">called</span>
        {rule.kind === 'never' ? (
          <span className="cb-t ink">0 times</span>
        ) : (
          <select className="cb-sel" aria-label="How many times" value={String(rule.count)} onChange={(e) => onRule({ ...rule, count: e.target.value === '1' ? 1 : '>= 1' })}>
            <option value=">= 1">at least 1 time</option>
            <option value="1">1 time</option>
          </select>
        )}
      </Row>
      <Row label="with">
        {args.length ? (
          <>
            {args.map((a, i) => (
              <span key={a.k} className="cb-arg">
                <input type="checkbox" checked={a.on} aria-label={`Only calls with this ${a.k}`} onChange={(e) => setArg(i, { on: e.target.checked })} />
                <code>{a.k}</code>
                <span className="cb-t">=</span>
                <input className="cb-in" type="text" spellCheck={false} aria-label={`Its ${a.k}`} value={valueText(a.v)} onChange={(e) => setArg(i, { v: typedAs(a.v, e.target.value) })} />
              </span>
            ))}
            <span className="cb-hint">{args.some((a) => a.on) ? 'only calls with the ticked values count' : 'tick a value and only calls with it count'}</span>
          </>
        ) : (
          <span className="cb-hint">{c ? `#${c.callNo} took no arguments` : 'its calls in this run took no arguments'}</span>
        )}
      </Row>
    </>
  );
}

/** The tools called before a call: the run's, as its context read them for the call the check is made from. */
function toolsBefore(ctx: RuleContext, c: ContextCall): string[] {
  if (ctx.context?.at && ctx.context.at.callNo === c.callNo) return ctx.context.before;
  return (ctx.context?.tools ?? []).filter((t) => t.callNo < c.callNo).map((t) => t.tool);
}

/** The number fields results recorded before a call, the latest per tool and field. */
function fieldsBefore(ctx: RuleContext, c: ContextCall | null): ResultField[] {
  if (!c || !ctx.context) return [];
  if (ctx.context.at && ctx.context.at.callNo === c.callNo) return ctx.context.fields;
  return ctx.context.conds.filter((f) => f.callNo < c.callNo);
}

const REF = /^@([^.\s]+)\.result\.(.+)$/;
const refOf = (f: Pick<ResultField, 'tool' | 'field'>) => `@${f.tool}.result.${f.field}`;
const chipText = (f: { tool: string; field: string; value: unknown; callNo: number | null }) => `${f.tool} → ${f.field}${f.callNo ? `: ${valueText(f.value)}` : ''}`;

/** Every call: the tool, the tools it must come after, and a number argument against an earlier call's value or a number. */
function EveryRows({ rule, ctx, run, onRule }: Change<'every'>) {
  const c = firstCall(ctx, rule.tool);
  const before = c ? toolsBefore(ctx, c).filter((t) => t !== rule.tool) : [];
  const chips = [...before, ...rule.after.filter((t) => !before.includes(t))];
  const others = ctx.tools.filter((t) => t !== rule.tool && !before.includes(t) && !rule.after.includes(t));
  const where = run ?? 'this run';
  const afterHint = c ? (before.length ? `tools called before #${c.callNo} in ${where}` : `no tool is called before #${c.callNo} in ${where}`) : `${rule.tool} isn’t called in ${where}: pick from the agent’s tools`;
  const toggle = (t: string) => onRule({ ...rule, after: rule.after.includes(t) ? rule.after.filter((x) => x !== t) : [...rule.after, t] });
  return (
    <>
      <Row label="every">
        <ToolSelect value={rule.tool} tools={ctx.tools} label="The tool whose calls it checks" onChange={(tool) => onRule({ ...rule, tool, after: [], arg: numberArgs(firstCall(ctx, tool)?.args)[0] ?? '', val: null })} />
        <span className="cb-t">call</span>
      </Row>
      <Row label="after" want={rule.focus === 'after' && !rule.after.length}>
        {chips.length ? (
          <span className="cb-chips">
            {chips.map((t) => (
              <Chip key={t} on={rule.after.includes(t)} title={t} onClick={() => toggle(t)}>
                {t}
              </Chip>
            ))}
          </span>
        ) : null}
        {others.length ? (
          <select className="cb-sel" aria-label="Another tool it must come after" value="" onChange={(e) => e.target.value && onRule({ ...rule, after: [...rule.after, e.target.value] })}>
            <option value="">{chips.length ? 'another tool…' : 'a tool…'}</option>
            {others.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : null}
        <span className="cb-hint">{afterHint}</span>
      </Row>
      <ValueRow rule={rule} ctx={ctx} c={c} onRule={onRule} />
    </>
  );
}

/** Every call's value: the argument it compares, how, and with what. */
function ValueRow({ rule, ctx, c, onRule }: { rule: Of<'every'>; ctx: RuleContext; c: ContextCall | null; onRule: (rule: Rule) => void }) {
  const nums = numberArgs(c?.args);
  if (rule.arg && !nums.includes(rule.arg)) nums.unshift(rule.arg);
  const ref = rule.val && 'ref' in rule.val ? rule.val.ref : null;
  const fields: Array<{ tool: string; field: string; value: unknown; callNo: number | null }> = fieldsBefore(ctx, c);
  const held = ref ? REF.exec(ref) : null;
  if (held && !fields.some((f) => refOf(f) === ref)) fields.unshift({ tool: held[1]!, field: held[2]!, value: null, callNo: null });
  if (!nums.length && !rule.arg) return null;
  const hint = rule.arg ? (fields.length ? 'a value an earlier call returned, or a number' : c ? `a number: no call before #${c.callNo} returned one` : 'a number') : `an argument of ${rule.tool} to compare`;
  return (
    <Row label="value" want={rule.focus === 'value' && !rule.val}>
      <select className="cb-sel" aria-label="The argument it compares" value={rule.arg} onChange={(e) => onRule({ ...rule, arg: e.target.value, val: null })}>
        <option value="">—</option>
        {nums.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      {rule.arg ? (
        <>
          <select className="cb-sel" aria-label="How it compares" value={rule.op} onChange={(e) => onRule({ ...rule, op: e.target.value as CallOp })}>
            {CALL_OPS.map((op) => (
              <option key={op}>{op}</option>
            ))}
          </select>
          {fields.length ? (
            <span className="cb-chips">
              {fields.map((f) => {
                const r = refOf(f);
                return (
                  <Chip key={r} on={ref === r} title={f.callNo ? `from #${f.callNo}: ${r}` : r} onClick={() => onRule({ ...rule, val: ref === r ? null : { ref: r } })}>
                    {chipText(f)}
                  </Chip>
                );
              })}
            </span>
          ) : null}
          <input
            className="cb-in num"
            type="text"
            inputMode="decimal"
            placeholder="a number"
            aria-label="A number it compares with"
            value={rule.val && 'num' in rule.val ? String(rule.val.num) : ''}
            onChange={(e) => onRule({ ...rule, val: e.target.value.trim() === '' ? null : { num: asNumber(e.target.value) ?? e.target.value } })}
          />
        </>
      ) : null}
      <span className="cb-hint">{hint}</span>
    </Row>
  );
}

/** When… then: a condition on a number a call returned, its threshold, then how often a tool is called. */
function WhenRows({ rule, ctx, onRule }: Change<'when'>) {
  const conds = ctx.context?.conds ?? [];
  const cond = rule.cond;
  const isCond = (f: { tool: string; field: string }) => !!cond && cond.tool === f.tool && cond.field === f.field;
  const cands: Array<{ tool: string; field: string; value: unknown; callNo: number | null }> = cond && !conds.some(isCond) ? [{ tool: cond.tool, field: cond.field, value: null, callNo: null }, ...conds] : [...conds];
  return (
    <>
      <Row label="when">
        {cands.length ? (
          <span className="cb-chips">
            {cands.map((f) => (
              <Chip
                key={`${f.tool}.${f.field}`}
                on={isCond(f)}
                title={f.callNo ? `from #${f.callNo}` : 'the condition it holds now'}
                onClick={() => {
                  if (isCond(f)) return;
                  const at = conds.find((x) => x.tool === f.tool && x.field === f.field);
                  onRule({ ...rule, cond: { tool: f.tool, field: f.field, callNo: f.callNo }, num: at ? threshold(conds, at) : rule.num });
                }}
              >
                {chipText(f)}
              </Chip>
            ))}
          </span>
        ) : (
          <span className="cb-hint">no call in this run returned a number to hold a condition on</span>
        )}
      </Row>
      {cond ? (
        <Row label="">
          <code className="cb-code">
            {cond.tool} has result.{cond.field}
          </code>
          <select className="cb-sel" aria-label="How the condition compares" value={rule.op} onChange={(e) => onRule({ ...rule, op: e.target.value as CondOp })}>
            {COND_OPS.map((op) => (
              <option key={op}>{op}</option>
            ))}
          </select>
          <input className="cb-in num" type="text" inputMode="decimal" aria-label="The number it holds on" value={String(rule.num)} onChange={(e) => onRule({ ...rule, num: e.target.value.trim() })} />
        </Row>
      ) : null}
      <Row label="then">
        <ToolSelect value={rule.then.tool} tools={ctx.tools} label="The tool it then counts" onChange={(tool) => onRule({ ...rule, then: { ...rule.then, tool } })} />
        <span className="cb-t">called</span>
        <select className="cb-sel" aria-label="How many times then" value={String(rule.then.count)} onChange={(e) => onRule({ ...rule, then: { ...rule.then, count: THEN_COUNTS.find(([k]) => String(k) === e.target.value)?.[0] ?? 0 } })}>
          {THEN_COUNTS.map(([k, words]) => (
            <option key={String(k)} value={String(k)}>
              {words}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
}
