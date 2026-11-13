import { Fragment } from 'react';
import { useOfflineLink } from '../components/ActionButton.js';
import { Glyph } from '../components/RunIcon.js';
import { shortId, stamp } from '../format.js';
import { href } from '../route.js';
import { openResults } from '../run/panel-state.js';
import { useServedParts } from '../served-parts.js';
import { presetsNode } from './fork-node.js';

const GLYPH = { failed: 'fail', inconclusive: 'warn', passed: 'test' } as const;

/**
 * A session's error-path presets in the Forks view, under the recording they ran on, as the design
 * files them: `error-path presets`, which opens the recording with its results (plain in an exported
 * copy, which keeps none), its line, its attempts as one picture, a mark each with its card, and lines
 * that open the attempts that failed or couldn't say. The node is no link of its own, and its strip
 * takes no Tab stop, as an injection test's does.
 */
export function PresetsNode({ attempts, current }: { attempts: Parameters<typeof presetsNode>[0]; current: string }) {
  const v = presetsNode(attempts);
  const attemptLink = useOfflineLink();
  const { PresetsResults } = useServedParts();
  return (
    <div className={`fnode fb${v.runs.has(current) ? ' here' : ''}`} data-node="presets">
      <Glyph kind={GLYPH[v.verdict]} label="Error-path presets" />
      <div className="fmain">
        <span className="f1">
          <a className="more fbt" href={href.run(v.runId)} onClick={PresetsResults ? () => openResults(v.runId, 'presets') : undefined}>
            <code>error-path presets</code>
          </a>
        </span>
        <span className="f2 block">
          {v.parts.map((p, i) => (
            <Fragment key={i}>
              {i ? ' ' : null}
              <span className="nw">{i < v.parts.length - 1 ? `${p} ·` : p}</span>
            </Fragment>
          ))}
        </span>
        {/* a picture of the attempts in the order they ran, each one's card on hover, its words said once for a screen reader */}
        <div className="astrip" role="img" aria-label={v.label}>
          {v.cells.map((c) => (
            <i key={c.runId} className={`ac${c.tone ? ` ${c.tone}` : ''}`} data-tip={JSON.stringify(c.card)} />
          ))}
        </div>
        <div className="alist">
          {v.lines.map((l) => (
            <span key={l.runId} className="al">
              <i className={l.tone} aria-hidden="true" />
              <a className="more rlink" href={href.run(l.runId, l.callNo)} onClick={attemptLink}>
                <code className="rnm">{shortId(l.runId)}</code>
              </a>
              <span className="an"> · {l.words}</span>
            </span>
          ))}
          <span className="more2">{v.more}</span>
        </div>
      </div>
      <span className="fr">{stamp(v.at)}</span>
    </div>
  );
}
