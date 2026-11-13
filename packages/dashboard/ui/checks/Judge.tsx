import { useState } from 'react';
import { JUDGE_ASKED, NO_OUTPUT_KEPT } from '../../../engine/src/checks/labels.js';
import { noEstimate } from '../../../engine/src/estimates/estimate.js';
import { costLine } from '../../../engine/src/estimates/spending.js';
import { JUDGE_UNASKED } from '../../../engine/src/cost-words.js';
import { plural } from '../../../engine/src/words.js';
import type { CostLineProps } from '../components/CostLine.js';
import { SegmentedControl } from '../components/Segmented.js';
import { JUDGE_READS, type Rule } from './model.js';
import { Row } from './Row.js';

/**
 * Ask a judge…: its question, what it reads, its model, the answer that passes and its name. Nothing
 * here asks or bills: Save writes the config, and the judge is asked later, by Update golden or a
 * test, with every one of the project's redaction rules applied to what it reads.
 */

type JudgeRule = Extract<Rule, { kind: 'judge' }>;

/** Other…'s value in the model picker: a model typed as is. */
const OTHER = '\u0000other';

export function JudgeRows({ rule, models, onRule }: { rule: JudgeRule; models: readonly string[]; onRule: (rule: Rule) => void }) {
  const [typing, setTyping] = useState(() => !!rule.model && !models.includes(rule.model));
  return (
    <>
      <Row label="question">
        <textarea className="cb-ta" rows={2} spellCheck maxLength={2000} aria-label="The question it answers yes or no" value={rule.question} onChange={(e) => onRule({ ...rule, question: e.target.value })} />
      </Row>
      <Row label="reads">
        <SegmentedControl label="What the judge reads" items={JUDGE_READS.map(([key, label]) => ({ key, label }))} value={rule.of} onChange={(of) => onRule({ ...rule, of })} />
      </Row>
      <Row label="model">
        <select
          className="cb-sel"
          aria-label="Its model"
          value={typing ? OTHER : rule.model}
          onChange={(e) => {
            const other = e.target.value === OTHER;
            setTyping(other);
            if (!other) onRule({ ...rule, model: e.target.value });
          }}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
        {typing ? <input className="cb-in" type="text" spellCheck={false} aria-label="Its model, as typed" placeholder="such as openai:gpt-5.5" value={rule.model} onChange={(e) => onRule({ ...rule, model: e.target.value.trim() })} /> : null}
        <span className="cb-t">passes when it answers</span>
        <SegmentedControl<'yes' | 'no'>
          label="The answer that passes"
          items={[
            { key: 'yes', label: 'yes' },
            { key: 'no', label: 'no' },
          ]}
          value={rule.pass}
          onChange={(pass) => onRule({ ...rule, pass })}
        />
      </Row>
      <Row label="name">
        <input className="cb-in" type="text" spellCheck={false} maxLength={64} aria-label="Its name" placeholder="such as explains-escalation" value={rule.name} onChange={(e) => onRule({ ...rule, name: e.target.value })} />
        <span className="cb-hint">its verdicts are kept under it</span>
      </Row>
    </>
  );
}

/**
 * A judge's cost line, the body's last line: no price, since the engine has none for a judge never
 * asked, then when it is asked and what it reads beyond the answer.
 */
export function judgeCost(rule: JudgeRule, fork: boolean, redactions: number): CostLineProps {
  const reads = rule.of === 'run' ? [`your ${plural(redactions, 'redaction rule')} apply`] : rule.of === 'output' ? [`Update golden judges a replay: ${NO_OUTPUT_KEPT}`] : [];
  const [price = '', ...parts] = costLine(noEstimate('update', JUDGE_UNASKED, [fork ? 'asked in each attempt that passes its other checks, live where what it reads changed' : 'replays read its verdict free', ...reads]));
  return { price, parts };
}

/**
 * In fix mode: verify asks the fix's judge live in each attempt that exits 0, where a golden's replay
 * reads its verdict free, so the line says that and what it reads beyond the answer, never a price.
 */
export function fixJudgeCost(rule: JudgeRule, redactions: number): CostLineProps {
  const reads = rule.of === 'run' ? [`your ${plural(redactions, 'redaction rule')} apply`] : [];
  const [price = '', ...parts] = costLine(noEstimate('verify', JUDGE_UNASKED, [JUDGE_ASKED, ...reads]));
  return { price, parts };
}
