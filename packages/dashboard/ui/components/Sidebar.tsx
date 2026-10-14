import { useEffect, useMemo, useState } from 'react';
import type { Client, RunListItem, SearchHit } from '../api.js';
import { agoShort, callName, formatUsd, shortId } from '../format.js';
import { href } from '../router.js';
import { RunLabel, StatusMark } from './common.js';

type Filter = 'all' | 'recordings' | 'replays' | 'forks' | 'failed';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'All'],
  ['recordings', 'Recordings'],
  ['forks', 'Forks'],
  ['replays', 'Clean'],
  ['failed', 'Failed'],
];

function matches(r: RunListItem, f: Filter): boolean {
  switch (f) {
    case 'recordings':
      return r.mode === 'record';
    case 'replays':
      return r.mode === 'replay' && !r.divergence;
    case 'forks':
      return !!r.divergence;
    case 'failed':
      return r.status === 'failed' || r.status === 'crashed';
    default:
      return true;
  }
}

export function Sidebar({ client, runs, selected, loading }: { client: Client; runs: RunListItem[] | null; selected: string | null; loading: boolean }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  // Three characters or more also searches what the runs recorded: prompts, responses, tool arguments and results.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || client.exported) return setHits(null);
    const timer = setTimeout(() => {
      client.search(q).then(setHits, () => setHits([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, client]);
  const [filter, setFilter] = useState<Filter>('all');
  const q = query.trim().toLowerCase();
  const ordered = useMemo(() => {
    if (!runs) return [];
    const narrowed = q !== '' || filter !== 'all';
    const kept = runs
      .filter((r) => matches(r, filter) && (!q || r.runId.toLowerCase().includes(q) || r.command.toLowerCase().includes(q) || (r.codeVersion ?? '').toLowerCase().includes(q) || r.label.includes(q) || r.labels.some((l) => l.toLowerCase().includes(q))))
      .map((r) => (narrowed ? { ...r, depth: 0 } : r));
    // Newest recording first; its replays and forks stay directly under it.
    const groups: RunListItem[][] = [];
    for (const r of kept) {
      if (r.depth === 0) groups.push([r]);
      else groups[groups.length - 1]?.push(r);
    }
    return groups.reverse().flat();
  }, [runs, q, filter]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([f]) => [f, runs ? runs.filter((r) => matches(r, f)).length : 0])), [runs]);

  return (
    <aside className="sidebar" aria-label="Runs">
      <div className="side-head">
        <input className="field-input" type="search" placeholder={client.exported ? 'Filter runs' : 'Search runs'} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search runs by id, command, revision or label" id="run-search" />
        <div className="runfilter" role="group" aria-label="Filter runs">
          {FILTERS.map(([f, label]) =>
            f !== 'all' && counts[f] === 0 ? null : (
              <button key={f} type="button" aria-pressed={filter === f} aria-label={`${label}: ${counts[f]}`} onClick={() => setFilter(f)}>
                <b>{counts[f]}</b>
                <span>{label}</span>
              </button>
            ),
          )}
        </div>
      </div>
      <ol className="runlist">
        {loading && !runs ? <li className="note">Loading…</li> : null}
        {runs && ordered.length === 0 ? <li className="note">{runs.length ? 'Nothing matches.' : 'No runs yet.'}</li> : null}
        {ordered.map((r) => (
          <li key={r.runId} className={`run${r.depth > 0 ? ' child' : ''}${r.runId === selected ? ' sel' : ''}`}>
            <a href={href.run(r.runId)} aria-current={r.runId === selected ? 'page' : undefined} title={r.command}>
              <span className="run-top">
                <span className="rid">{shortId(r.runId)}</span>
                <StatusMark status={r.status} />
                <RunLabel label={r.label} status={r.status} />
                <span className="age" title={new Date(r.startedAt).toLocaleString()}>
                  {agoShort(r.startedAt)}
                </span>
              </span>
              {r.depth === 0 ? <span className="run-cmd">{r.source ? `from ${r.source}` : r.command}</span> : null}
              {r.labels.length ? (
                <span className="run-labels">
                  {r.labels.slice(0, 4).map((l) => (
                    <span className="label-chip small" key={l}>
                      {l}
                    </span>
                  ))}
                  {r.labels.length > 4 ? <span className="muted">+{r.labels.length - 4}</span> : null}
                </span>
              ) : null}
              <span className="run-facts">
                {r.calls} calls
                {r.spent ? <> · ≈{formatUsd(r.spent)}</> : null}
                {r.captured ? <> · ≈{formatUsd(r.captured)} captured</> : null}
                {r.saved ? <span className="saved"> · {formatUsd(r.saved)} saved</span> : null}
              </span>
            </a>
          </li>
        ))}
      </ol>
      {hits !== null ? (
        <section className="hits" aria-label="Matches in recorded calls">
          <div className="section-label">In recorded calls{hits.length ? ` · ${hits.length}${hits.length >= 30 ? '+' : ''}` : ''}</div>
          {hits.length === 0 ? <p className="note">No prompt, response or tool call mentions that.</p> : null}
          <ol>
            {hits.map((h) => (
              <li key={`${h.runId}:${h.callNo}:${h.field}`}>
                <a href={href.run(h.runId, h.callNo)}>
                  <span className="hit-top">
                    <span className="rid">{shortId(h.runId)}</span> #{h.callNo} {callName(h.kind, h.name)} <span className="muted">· {h.field}</span>
                  </span>
                  <Snippet text={h.snippet} />
                </a>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </aside>
  );
}

/** A search snippet with its matches marked: the text between character 1 and character 2. */
function Snippet({ text }: { text: string }) {
  const parts = text.replace(/\s+/g, ' ').split(String.fromCharCode(1));
  return (
    <span className="hit-snippet">
      {parts.map((part, i) => {
        const end = part.indexOf(String.fromCharCode(2));
        if (i === 0 || end < 0) return <span key={i}>{part}</span>;
        return (
          <span key={i}>
            <mark>{part.slice(0, end)}</mark>
            {part.slice(end + 1)}
          </span>
        );
      })}
    </span>
  );
}
