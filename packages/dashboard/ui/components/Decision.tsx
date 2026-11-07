import { Fragment } from 'react';
import { argParts, effectTag, toolMarks } from '../decisions.js';
import type { DecisionView } from '../types.js';

/**
 * One model call's decision beside the other side's, as a preview's opened cell draws it: what it
 * said, each tool it called with its effect and arguments, and how its turn ended. A call the other
 * side makes the same way is marked → faint, one it makes otherwise → in ink, one it doesn't make −
 * (struck through) on the recorded side and + on the changed one, an added write in red; the stop
 * line in amber where the two stops differ. `stop` is the engine's words for it (STOP_WORDS), sent
 * with the data, since a page can't load the engine's decisions module.
 */
export function Decision({ d, other, side, stop, stopDiffers }: { d: DecisionView; other: DecisionView | null; side: 'recorded' | 'now'; stop: string; stopDiffers: boolean }) {
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
            {mark === 'gone' || mark === 'new' ? <span className="sr">{mark === 'gone' ? ', not called under the change' : ', not called as recorded'}</span> : null}
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
      <p className={`dstop${stopDiffers ? ' diff' : ''}`}>{stop}</p>
    </>
  );
}
