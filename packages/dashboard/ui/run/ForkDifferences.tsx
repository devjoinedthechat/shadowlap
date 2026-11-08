import { useState, type ReactNode } from 'react';
import type { ForkChange, ForkDifferences as Differences, ForkEnd, ForkWrite } from '../../src/fork-differences.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { useApp } from '../state.js';

/**
 * What the fork did differently from its parent, one of its findings: from the call it left its parent
 * at on, the tool calls it made and didn't, the tools it called with other arguments, how each run
 * ended and its last words, most consequential first as `shadowlap decisions` ranks them (a write
 * changed, how the run ends, a read added or removed, a read asked differently, other words); then
 * its writes and what became of each: a few one by one, more grouped by tool and what became of
 * them, so a batch fork's dozens of writes take a line and leave Calls in view. The first few
 * changes show, and each write, with a click.
 */

/** The changes shown before Show all. */
export const SHOWN = 4;
/** Writes listed one by one; more are grouped by tool and what became of them, each with a click. */
export const WRITES_LISTED = 3;
/** The most writes Show each lists: Compare has the rest. */
export const WRITES_EACH = 100;

/** A fork's writes grouped by tool and what became of them, in the order each group's first came. */
export function writeGroups(writes: readonly ForkWrite[]): Array<{ tool: string; fate: ForkWrite['fate']; count: number; first: ForkWrite }> {
  const groups = new Map<string, { tool: string; fate: ForkWrite['fate']; count: number; first: ForkWrite }>();
  for (const w of writes) {
    const key = `${w.tool}\u0000${w.fate}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { tool: w.tool, fate: w.fate, count: 1, first: w });
  }
  return [...groups.values()];
}

/** A rank in a few words, for the column the changes line up on. */
const RANK_WORDS: Record<number, string> = { 1: 'a write', 2: 'how it ends', 3: 'a read', 4: 'a read asked', 5: 'its words' };

const FATE_WORDS: Record<string, string> = { blocked: 'blocked', stubbed: 'stubbed', live: 'ran live', overridden: 'overridden', replayed: 'replayed', failed: 'failed' };

/** What the fork did differently, read once `want` says the run is a fork that has ended; null until it comes, or with none to say. */
export function useForkDifferences(runId: string, want: boolean): Differences | null {
  const { client } = useApp();
  return useLoad(() => (want ? client.forkDifferences(runId) : null), `differences:${runId}:${want ? 'fork' : 'none'}`).data;
}

export function ForkDifferences({ runId }: { runId: string }) {
  const d = useForkDifferences(runId, true);
  return d ? <DifferencesPanel d={d} /> : null;
}

/**
 * The fork's differences as one of the run's findings (FindingsBar.tsx): its heading, where it left
 * its parent and Compare → on its line, `more` (the bar's toggle) at its end, and its changes and
 * writes under it (`.fbody`), which a closed bar hides. `fx`: a finding the closed bar folds away.
 */
export function DifferencesPanel({ d, fx = false, more = null }: { d: Differences; fx?: boolean; more?: ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? d.changes : d.changes.slice(0, SHOWN);
  const parent = shortId(d.parentRunId);
  const same = d.changes.length === 0;
  return (
    <section className={`fdiff${fx ? ' fx' : ''}`} aria-labelledby="fdiffT">
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
        {more}
      </header>
      <div className="fbody">
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
        <Writes d={d} />
      </div>
    </section>
  );
}

const Fate = ({ fate }: { fate: ForkWrite['fate'] }) => <em className={`fate ${fate}`}>{FATE_WORDS[fate] ?? fate}</em>;

function Write({ w, first }: { w: ForkWrite; first: boolean }) {
  return (
    <span className="fw">
      {first ? null : ' · '}
      <a href={w.href}>#{w.callNo}</a> <b className="w">{w.tool}</b> <code>{w.args}</code> <Fate fate={w.fate} />
    </span>
  );
}

/** The fork's writes: a few one by one; more grouped by tool and what became of them, with each a click away. */
function Writes({ d }: { d: Differences }) {
  const [each, setEach] = useState(false);
  if (!d.writes.length)
    return (
      <p className="fdw">
        <span className="k">no writes from #{d.from} on</span>
      </p>
    );
  const grouped = d.writes.length > WRITES_LISTED;
  const listed = !grouped || each ? d.writes.slice(0, WRITES_EACH) : null;
  return (
    <p className="fdw">
      <span className="k">its writes</span>
      {listed
        ? listed.map((w, i) => <Write key={w.callNo} w={w} first={i === 0} />)
        : writeGroups(d.writes).map((g, i) =>
            g.count === 1 ? (
              <Write key={g.first.callNo} w={g.first} first={i === 0} />
            ) : (
              <span key={`${g.tool}:${g.fate}`} className="fw">
                {i ? ' · ' : null}
                <b className="w">{g.tool}</b> ×{g.count} <Fate fate={g.fate} />, from <a href={g.first.href}>#{g.first.callNo}</a>
              </span>
            ),
          )}
      {listed && d.writes.length > listed.length ? (
        <span className="fw">
          {' · '}
          {(d.writes.length - listed.length).toLocaleString('en-US')} more in <a href={href.compare(d.parentRunId, d.runId)}>Compare</a>
        </span>
      ) : null}
      {grouped ? (
        <button className="linkbtn fdeach" type="button" aria-expanded={each} onClick={() => setEach(!each)}>
          {each ? 'Group them' : `Show each of ${d.writes.length.toLocaleString('en-US')}`}
        </button>
      ) : null}
    </p>
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
