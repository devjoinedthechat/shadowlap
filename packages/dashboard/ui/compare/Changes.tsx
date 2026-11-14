import { shortId } from '../format.js';
import { ChangeList } from '../run/ForkDifferences.js';
import type { Pair } from './paths.js';

/**
 * What B decided differently from A from where they part, ranked as `shadowlap decisions` ranks a
 * changed decision and drawn as a fork's are on its page (run/ForkDifferences.tsx): the first few,
 * then Show all, each with the call it is about on each side. Under the verdict, which names the
 * most consequential; none where they decided alike, which the verdict says.
 */
export function PairChanges({ pair, a, b }: { pair: Pair; a: string; b: string }) {
  if (!pair.changes.length) return null;
  const [ra, rb] = [shortId(a), shortId(b)];
  const from = pair.from.a === pair.from.b ? `#${pair.from.a}` : `#${pair.from.a} and #${pair.from.b}`;
  // B against A as a fork's are told against its parent: A's call, then B's.
  const changes = pair.changes.map(({ a: inA, b: inB, ...c }) => ({ ...c, parent: inA, fork: inB }));
  return (
    <section className="fdiff cmpdiff" aria-labelledby="cmpdiffT">
      <header>
        <h2 id="cmpdiffT">
          What <code>{rb}</code> did differently
        </h2>
        <span className="sub">
          than <code>{ra}</code>, from {from}
          {pair.cut ? ' · the first 2,000 tool calls of each' : ''}
        </span>
      </header>
      <ChangeList changes={changes} ended={{ parent: pair.ended.a, fork: pair.ended.b }} ranks={pair.ranks} sides={{ parent: `in ${ra}`, fork: `in ${rb}` }} />
    </section>
  );
}
