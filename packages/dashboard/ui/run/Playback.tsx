import { useEffect, useMemo, useState } from 'react';
import { applyDeltas } from '../../../engine/src/deltas.js';
import type { Block, Delta } from '../api.js';
import { Seg } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { dur } from '../format.js';

/**
 * The Response tab's streamed answer, played back at its recorded pacing (Play, Pause, a speed), its
 * thinking first and how it stopped last: a part of the inspector of its own (Inspector.tsx), loaded
 * the first time it shows, which keeps the run page within its budget.
 */

function blocksText(blocks: Block[]): { think: string; text: string } {
  const think = blocks.filter((b) => b.type === 'thinking').map((b) => (b as { text: string }).text).join('\n\n');
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'tool_call') parts.push(`→ ${b.name} ${JSON.stringify(b.input)}`);
  }
  return { think, text: parts.join('\n\n') };
}

const SPEEDS = [1, 2, 4, 0] as const;

export function Playback({ blocks, deltas, stopReason, replayed, latency }: { blocks: Block[]; deltas: Delta[]; stopReason: string | null; replayed: boolean; latency: number | null }) {
  const [upto, setUpto] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const total = deltas.length;
  const partial = useMemo(() => (upto === null ? null : applyDeltas(deltas.slice(0, upto))), [deltas, upto]);
  useEffect(() => {
    if (!playing) return;
    const i = upto ?? 0;
    if (i >= total) {
      setPlaying(false);
      return;
    }
    if (speed === 0) {
      setUpto(total);
      return;
    }
    const prev = i > 0 ? deltas[i - 1]!.t : 0;
    const t = setTimeout(() => setUpto(i + 1), Math.min(1500, Math.max(0, (deltas[i]!.t - prev) / speed)));
    return () => clearTimeout(t);
  }, [playing, upto, speed, deltas, total]);
  const shownBlocks = partial ? partial.blocks : blocks;
  const { think, text } = blocksText(shownBlocks);
  const streaming = upto !== null && upto < total;
  const span = total ? deltas[total - 1]!.t : 0;
  const elapsed = upto !== null && upto > 0 ? deltas[Math.min(upto, total) - 1]!.t : 0;
  return (
    <>
      {think ? (
        <div className="think">
          <span className="tlab">thinking</span>
          {think}
        </div>
      ) : null}
      {total ? (
        <>
          <div className="play">
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                if (playing) setPlaying(false);
                else {
                  if (upto === null || upto >= total) setUpto(0);
                  setPlaying(true);
                }
              }}
            >
              <Icon name={playing ? 'pause' : 'play'} />
              {playing ? 'Pause' : streaming ? 'Resume' : 'Play'}
            </button>
            <Seg label="Speed" items={SPEEDS.map((s) => ({ key: String(s), label: s === 0 ? 'instant' : `${s}×` }))} value={String(speed)} onChange={(k) => setSpeed(Number(k) as (typeof SPEEDS)[number])} />
            <span className="ev">{upto === null ? `${replayed ? 'as recorded' : 'streamed'} · ${dur(span || latency || 0)}` : `${dur(elapsed)} / ${dur(span)}`}</span>
          </div>
          <div className="prog">
            <i style={{ width: `${span ? (100 * elapsed) / span : upto === null ? 0 : 100}%` }} />
          </div>
        </>
      ) : null}
      <div className="resp">
        {text}
        {streaming || playing ? <span className="caret-blink" /> : null}
      </div>
      {stopReason && !streaming ? <div className="ibar stopline">stop · {stopReason}</div> : null}
    </>
  );
}
