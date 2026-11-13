import type { ReactNode } from 'react';
import { glossed } from '../components/Term.js';
import { glued, wholeTallies } from '../format.js';
import { href } from '../route.js';
import { ANSWER_LEAD } from './answer-words.js';
import type { CauseView } from './model.js';

type Answer = CauseView['answers'][number];

/** The lead answer's weight, as the bar draws it: a cause red, one the gate couldn't decide amber, a read that caused nothing muted, never lime. */
const TONE: Readonly<Record<Answer['verdict'], string>> = { caused: 'blame', inconclusive: 'inc', 'not caused': 'mu' };
const LABEL: Readonly<Record<Answer['verdict'], string>> = { caused: 'caused by', 'not caused': 'not caused by', inconclusive: 'inconclusive' };

/** What an answer says after its read: `get_ticket · #28 send_email is gone in 3 of 3 clean attempts · rate >= 0.29 (95%)`. */
const afterRead = (a: Answer): string => {
  const at = `#${a.read.callNo} `;
  return glued(wholeTallies(a.line.startsWith(at) ? a.line.slice(at.length) : a.line));
};

/** An answer's read as a pick, then the rest of its line, glossed. */
function Said({ a, onSelect, className }: { a: Answer; onSelect: (n: number) => void; className: string }) {
  return (
    <>
      <button className={className} type="button" onClick={() => onSelect(a.read.callNo)} aria-label={`Open #${a.read.callNo}, the read made neutral`}>
        #{a.read.callNo}
      </button>{' '}
      {glossed(afterRead(a))}
    </>
  );
}

/**
 * The run's `--clean` answers as a finding (Find cause…, FindCause.tsx): the lead answer, a cause
 * first, by its label in its weight, its read a pick and Clean attempts → to the write's forks; then,
 * under the bar's toggle, each other answer in full on a line of its own and the gate's rule once.
 * A cause asked about stays whatever was asked after it: the server lists causes first. A part only
 * the served dashboard hands in (served-parts.ts), as a copy keeps no answers.
 */
export function CauseFinding({ runId, cause, fx, more, onSelect }: { runId: string; cause: CauseView; fx: boolean; more: ReactNode; onSelect: (n: number) => void }) {
  const [lead, ...rest] = cause.answers;
  if (!lead) return null;
  return (
    <section className={`banner wrap ${TONE[lead.verdict]}${fx ? ' fx' : ''}`} data-finding="cause">
      <span className="bk">{LABEL[lead.verdict]}</span>
      <span className="why">
        <Said a={lead} onSelect={onSelect} className="bn" />
      </span>
      <span className="end">
        <a className="more" href={href.run(runId, lead.write.callNo, 'forks')}>
          Clean attempts →
        </a>
      </span>
      {more}
      <div className="fbody injmore">
        {rest.map((a) => (
          <p key={`${a.read.callNo}:${a.write.callNo}`} className="injline2">
            {ANSWER_LEAD[a.verdict]} <Said a={a} onSelect={onSelect} className="pbn" />
          </p>
        ))}
        {cause.rule ? <p className="injrule">{cause.rule}</p> : null}
      </div>
    </section>
  );
}
