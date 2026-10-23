import { useState } from 'react';
import type { ForkChange, ForkDifferences as Differences, ForkEnd } from '../../src/fork-differences.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { useApp } from '../state.js';

/**
 * What the fork did differently from its parent, under its banner: from the call it left its parent
 * at on, the tool calls it made and didn't, the tools it called with other arguments, how each run
 * ended and its last words, most consequential first as `shadowlap decisions` ranks them (a write
 * changed, how the run ends, a read added or removed, a read asked differently, other words); then
 * its writes and what became of each. The first few show; the rest open with a click.
 */

/** The changes shown before Show all. */
export const SHOWN = 4;

/** A rank in a few words, for the column the changes line up on. */
const RANK_WORDS: Record<number, string> = { 1: 'a write', 2: 'how it ends', 3: 'a read', 4: 'a read asked', 5: 'its words' };

const FATE_WORDS: Record<string, string> = { blocked: 'blocked', stubbed: 'stubbed', live: 'ran live', overridden: 'overridden', replayed: 'replayed', failed: 'failed' };

export function ForkDifferences({ runId }: { runId: string }) {
  const { client } = useApp();
  const loaded = useLoad(() => client.forkDifferences(runId), `differences:${runId}`);
  const d = loaded.data;
  if (!d) return null;
  return <DifferencesPanel d={d} />;
}

export function DifferencesPanel({ d }: { d: Differences }) {
  const [all, setAll] = useState(false);
  const shown = all ? d.changes : d.changes.slice(0, SHOWN);
  const parent = shortId(d.parentRunId);
  const same = d.changes.length === 0;
  return (
    <section className="fdiff" aria-labelledby="fdiffT">
      <header>
        <h2 id="fdiffT">What the fork did differently</h2>
        <span className="sub">
          than{' '}
          <a href={href.run(d.parentRunId, d.from)}>
            <code>{parent}</code>
          </a>
          , from #{d.from}
          {d.cut ? ' · the first 2,000 tool calls of each' : ''}
        </span>
        <span className="sp" />
        <a className="more" href={href.compare(d.parentRunId, d.runId)}>
          Compare →
        </a>
      </header>
      {same ? (
        <p className="fdsame">The same tool calls as its parent from #{d.from}, and it ended as its parent did: {d.ended.fork.words}.</p>
      ) : (
        <ol className="fdl">
          {shown.map((c, i) => (
            <Change key={`${c.kind}:${c.tool ?? ''}:${i}`} c={c} ended={d.ended} ranks={d.ranks} />
          ))}
        </ol>
      )}
      {d.changes.length > SHOWN ? (
        <button className="linkbtn fdall" type="button" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show the first few' : `Show all ${d.changes.length}`}
        </button>
      ) : null}
      <p className="fdw">
        {d.writes.length ? (
          <>
            <span className="k">its writes</span>
            {d.writes.map((w, i) => (
              <span key={w.callNo} className="fw">
                {i ? ' · ' : null}
                <a href={w.href}>#{w.callNo}</a> <b className="w">{w.tool}</b> <code>{w.args}</code> <em className={`fate ${w.fate}`}>{FATE_WORDS[w.fate] ?? w.fate}</em>
              </span>
            ))}
          </>
        ) : (
          <span className="k">no writes from #{d.from} on</span>
        )}
      </p>
    </section>
  );
}

function Change({ c, ended, ranks }: { c: ForkChange; ended: Differences['ended']; ranks: Differences['ranks'] }) {
  const write = c.effect === 'write' || c.effect === 'unknown';
  return (
    <li className={`r${c.rank}`}>
      <span className="rk" title={ranks[c.rank]}>
        {RANK_WORDS[c.rank]}
      </span>
      <span className="what">
        {c.kind === 'ended' ? (
          <>
            {c.detail}: <End e={ended.parent} /> → <End e={ended.fork} />
          </>
        ) : (
          <>
            {c.tool && c.detail.startsWith(c.tool) ? (
              <>
                <b className={write ? 'w' : undefined}>{c.tool}</b>
                {c.detail.slice(c.tool.length)}
              </>
            ) : (
              c.detail
            )}
            {c.before !== null || c.after !== null ? (
              <>
                {' '}
                {c.before !== null ? <code className="was">{c.before}</code> : null}
                {c.before !== null && c.after !== null ? ' → ' : null}
                {c.after !== null ? <code>{c.after}</code> : null}
              </>
            ) : null}
            {c.parent || c.fork ? (
              <span className="at">
                {c.parent ? <a href={c.parent.href}>#{c.parent.callNo} in the parent</a> : null}
                {c.parent && c.fork ? ' · ' : null}
                {c.fork ? <a href={c.fork.href}>#{c.fork.callNo} here</a> : null}
              </span>
            ) : null}
          </>
        )}
      </span>
    </li>
  );
}

function End({ e }: { e: ForkEnd }) {
  return <em className={e.tone}>{e.words}</em>;
}
