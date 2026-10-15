import { useMemo } from 'react';
import { Glyph } from '../components/RunIcon.js';
import { approx, shortId, stamp } from '../format.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import type { FixBundle } from '../types.js';
import { bundledRuns, bundleGlyph, bundleLine } from './model.js';

/**
 * The Forks view's blame and verify bundles: the attempts each made, under the run they replayed,
 * leading to the fix's step (a verify to its verdict). The probe blame named carries a "blamed" chip,
 * and a verify's icon says whether it accepted the change.
 */

const NONE: FixBundle[] = [];

/**
 * The bundles in a run's family; the attempt runs they list, which the family leaves out; and the
 * forks blame rescued runs with, which show as forks of their own though they are attempts too.
 */
export function useFixBundles(runId: string): { bundles: FixBundle[]; bundled: Set<string>; rescued: Set<string> } {
  const { client, tick, exported } = useApp();
  const loaded = useLoad(() => (exported ? null : client.fixBundles(runId)), `bundles:${runId}`, tick);
  const bundles = loaded.data ?? NONE;
  return useMemo(() => ({ bundles, bundled: bundledRuns(bundles), rescued: new Set(bundles.flatMap((b) => b.attempts.filter((a) => a.rescued).map((a) => a.runId))) }), [bundles]);
}

export function FixBundleNode({ bundle: b, current }: { bundle: FixBundle; current: string }) {
  const g = bundleGlyph(b);
  const here = b.attempts.some((a) => a.runId === current);
  return (
    <a className={`fnode${here ? ' here' : ''}`} href={b.href} title={b.kind === 'verify' && b.change ? `${b.change}${b.verdict ? ` · ${b.verdict}` : ''}` : undefined}>
      <Glyph kind={g.kind} label={g.label} />
      <span>
        <span className="f1">
          <code>{b.title}</code>
          {b.blamed ? <span className="chip">blamed</span> : null}
        </span>
        <span className="f2 block">{bundleLine(b, approx)}</span>
        <span className="attempts">
          {b.attempts.map((a) => (
            <span key={a.runId}>
              <i className={a.passed ? undefined : 'no'} />
              {shortId(a.runId)} · {a.note}
            </span>
          ))}
        </span>
      </span>
      <span className="fr">{stamp(b.at)}</span>
    </a>
  );
}
