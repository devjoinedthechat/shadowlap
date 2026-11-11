import { Fragment } from 'react';
import { argParts, effectTag, toolMarks } from '../decisions.js';
import { plural } from '../format.js';
import type { DecisionView } from '../types.js';

/**
 * One model call's decision beside the other side's, as a preview's opened cell draws it: what it
 * said, each tool it called with its effect and arguments, and how its turn ended. A call the other
 * side makes the same way is marked → faint, one it makes otherwise → in ink, one it doesn't make −
 * (struck through) on the recorded side and + on the changed one, an added write in red; the stop
 * line in amber where the two stops differ. `stop` is the engine's words for it (STOP_WORDS), sent
 * with the data, since a page can't load the engine's decisions module. `notCalled` is what a screen
 * reader hears after a tool the other side doesn't call: a preview's words unless given (Compare
 * names the other run). `more` is how many more tool calls it made than `d` lists, said after
 * them: Compare's rows list ROW_TOOLS at most.
 */
export function Decision({ d, other, side, stop, stopDiffers, notCalled = side === 'recorded' ? ', not called under the change' : ', not called as recorded', more = 0 }: { d: DecisionView; other: DecisionView | null; side: 'recorded' | 'now'; stop: string; stopDiffers: boolean; notCalled?: string; more?: number }) {
  const marks = toolMarks(d, other, side);
  return (
    <>
      {d.text ? <p className="dsay">“{d.text}”</p> : null}
      {d.tools.map((t, i) => {
        const mark = marks[i]!;
        const tag = effectTag(t.effect);
        return (
          <div key={i} className={['dtool', mark === 'same' ? '' : mark, tag === 'write' ? 'w' : ''].filter(Boolean).join(' ')}>
            <span className="ar" aria-hidden="true">
              {mark === 'gone' ? '−' : mark === 'new' ? '+' : '→'}
            </span>
            <b>{t.name}</b>
            <span className={`eff ${tag}`}>{tag}</span>
            {mark === 'gone' || mark === 'new' ? <span className="sr">{notCalled}</span> : null}
            <code>
              {argParts(JSON.stringify(t.args ?? null)).map((p, k) => (
                <Fragment key={k}>
                  {p.whole ? <span className="nw">{p.text}</span> : p.text}
                  {/[,{]$/.test(p.text) ? <wbr /> : null}
                </Fragment>
              ))}
            </code>
          </div>
        );
      })}
      {more ? (
        <div className="dtool dmore">
          <span className="ar" aria-hidden="true">…</span>
          {plural(more, 'more tool call')}
        </div>
      ) : null}
      <p className={`dstop${stopDiffers ? ' diff' : ''}`}>{stop}</p>
    </>
  );
}
