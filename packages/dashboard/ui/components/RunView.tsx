import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, CallDetail, CallRow, Client, RunDetail } from '../api.js';
import { callName, formatDuration, formatTokens, formatUsd, json, shortId, when, isFailure } from '../format.js';
import { useKey, usePolling } from '../hooks.js';
import { stripCells } from '../strip.js';
import { href, navigate } from '../router.js';
import { ActionsMenu } from './Actions.js';
import { CopyButton, Eyebrow, Origin, Stat } from './common.js';
import { LabelsBar } from './Notes.js';
import { Inspector, type Tab } from './Inspector.js';
import { ContextView, ForksView, RUN_PANES, TimelineView, TurnsView, type RunPane } from './RunViews.js';

const PANE_KEY = 'shadowlap-dashboard-pane';
function savedPane(): RunPane {
  try {
    const v = localStorage.getItem(PANE_KEY);
    return RUN_PANES.some(([p]) => p === v) ? (v as RunPane) : 'calls';
  } catch {
    return 'calls';
  }
}

type OriginFilter = 'all' | 'live' | 'replayed' | 'fenced' | 'errors';
const ORIGIN_FILTERS: Array<[OriginFilter, string]> = [
  ['all', 'All'],
  ['live', 'Live'],
  ['replayed', 'Replayed'],
  ['fenced', 'Fenced'],
  ['errors', 'Errors'],
];

export function RunView({ client, runId, callNo, actionsEnabled, onAction, onDelete, refreshMs = 2000 }: { client: Client; runId: string; callNo: number | null; actionsEnabled: boolean; onAction: (a: Action, callNo: number | null) => void; onDelete: (runId: string) => void; refreshMs?: number | null }) {
  const { data: run, error } = usePolling(() => client.run(runId), runId, refreshMs);
  const [tab, setTab] = useState<Tab>('conversation');
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const [pane, setPaneState] = useState<RunPane>(savedPane);
  const setPane = (p: RunPane) => {
    setPaneState(p);
    try {
      localStorage.setItem(PANE_KEY, p);
    } catch {
      // the choice lasts for this page only
    }
  };
  const [query, setQuery] = useState('');

  // A fork opens at its divergence; anything else at its first call.
  useEffect(() => {
    if (!run) return;
    // A link with a short id, as the CLI prints them, settles on the full one.
    if (run.run.runId !== runId) return navigate(href.run(run.run.runId, callNo ?? undefined), true);
    if (callNo !== null) return;
    const first = run.run.divergence?.callNo ?? run.calls[0]?.callNo;
    if (first !== undefined) navigate(href.run(runId, first), true);
  }, [run, callNo, runId]);

  const selectedKey = callNo === null ? 'none' : `${runId}:${callNo}:${run?.calls.find((c) => c.callNo === callNo)?.outcome ?? ''}`;
  const detail = usePolling<CallDetail | null>(() => (callNo === null ? Promise.resolve(null) : client.call(runId, callNo)), selectedKey, null);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!run) return [];
    return run.calls.filter((c) => {
      if (originFilter === 'live' && c.origin !== 'live') return false;
      if (originFilter === 'replayed' && c.origin !== 'replayed' && c.origin !== 'overridden') return false;
      if (originFilter === 'fenced' && c.origin !== 'blocked' && c.origin !== 'stubbed') return false;
      if (originFilter === 'errors' && !isFailure(c)) return false;
      return !q || `${c.name} ${c.detail} ${c.model ?? ''} ${c.stopReason ?? ''} #${c.callNo}`.toLowerCase().includes(q);
    });
  }, [run, originFilter, q]);
  const originCounts = useMemo(() => {
    const n = { live: 0, replayed: 0, fenced: 0, errors: 0 };
    for (const c of run?.calls ?? []) {
      if (c.origin === 'live') n.live++;
      else if (c.origin === 'replayed' || c.origin === 'overridden') n.replayed++;
      else if (c.origin === 'blocked' || c.origin === 'stubbed') n.fenced++;
      // An injected failure reached no provider and fenced nothing: it counts only as the error it is.
      if (isFailure(c)) n.errors++;
    }
    return n;
  }, [run]);

  const searchRef = useRef<HTMLInputElement>(null);
  useKey((e) => {
    if (!run) return;
    const i = visible.findIndex((c) => c.callNo === callNo);
    if (e.key === 'j' || e.key === 'ArrowDown') {
      const next = visible[Math.min(visible.length - 1, i + 1)];
      if (next) {
        e.preventDefault();
        navigate(href.run(runId, next.callNo), true);
      }
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      const prev = visible[Math.max(0, i - 1)];
      if (prev) {
        e.preventDefault();
        navigate(href.run(runId, prev.callNo), true);
      }
    } else if (e.key === '/') {
      e.preventDefault();
      setPane('calls');
      setTimeout(() => searchRef.current?.focus());
    } else if (e.key === 'v') {
      const i = RUN_PANES.findIndex(([p]) => p === pane);
      setPane(RUN_PANES[(i + 1) % RUN_PANES.length]![0]);
    } else if (e.key === 'n' && run.run.divergence) navigate(href.run(runId, run.run.divergence.callNo), true);
    else if (e.key === 'p' && run.parent) navigate(href.run(run.parent.runId));
    else if (['1', '2', '3', '4'].includes(e.key)) setTab((['conversation', 'response', 'request', 'details'] as Tab[])[Number(e.key) - 1]!);
    else if (e.key === 'Escape' && document.activeElement === searchRef.current) searchRef.current?.blur();
  });

  if (error)
    return (
      <div className="page">
        <Eyebrow>run {shortId(runId)}</Eyebrow>
        <h1 className="display">{error.message.includes('no run') ? 'This run is not in the store.' : 'Could not load this run.'}</h1>
        <p className="lede">{error.message}</p>
      </div>
    );
  if (!run) return <div className="note pad">Loading run…</div>;

  const current = callNo !== null ? (detail.data ?? null) : null;
  return (
    <div className="runview">
      <RunHeader client={client} run={run} actions={current?.actions ?? run.actions} callNo={callNo} actionsEnabled={actionsEnabled} onAction={onAction} onDelete={onDelete} />
      {run.run.divergence ? <ForkSection run={run} /> : null}
      <OriginStrip run={run} selected={callNo} />
      <div className="split">
        <section className="calls" aria-label="Calls">
          <div className="calls-bar">
            <div className="mode panes" role="group" aria-label="View">
              {RUN_PANES.map(([p, label]) => (
                <button key={p} type="button" aria-pressed={pane === p} onClick={() => setPane(p)}>
                  {label}
                </button>
              ))}
            </div>
            {pane === 'calls' ? (
              <div className="calls-filters">
                <div className="texttabs" role="group" aria-label="Filter by origin">
                  {ORIGIN_FILTERS.map(([f, label]) =>
                    f !== 'all' && originCounts[f] === 0 ? null : (
                      <button key={f} type="button" aria-pressed={originFilter === f} onClick={() => setOriginFilter(f)}>
                        {label}
                        <sup>{f === 'all' ? run.calls.length : originCounts[f]}</sup>
                      </button>
                    ),
                  )}
                </div>
                <input ref={searchRef} className="field-input compact" type="search" placeholder="Filter calls" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter calls (press /)" id="call-search" />
              </div>
            ) : null}
          </div>
          {pane === 'calls' ? <CallsTable calls={visible} runId={runId} selected={callNo} divergence={run.run.divergence?.callNo ?? null} /> : null}
          {pane === 'turns' ? <TurnsView run={run} selected={callNo} /> : null}
          {pane === 'context' ? <ContextView run={run} selected={callNo} /> : null}
          {pane === 'timeline' ? <TimelineView run={run} selected={callNo} /> : null}
          {pane === 'forks' ? <ForksView client={client} runId={run.run.runId} /> : null}
        </section>
        <Inspector detail={current} loading={callNo !== null && !detail.data} error={detail.error?.message ?? null} tab={tab} onTab={setTab} runId={runId} client={client} actionsEnabled={actionsEnabled} />
      </div>
    </div>
  );
}

function RunHeader({ client, run, actions, callNo, actionsEnabled, onAction, onDelete }: { client: Client; run: RunDetail; actions: Action[]; callNo: number | null; actionsEnabled: boolean; onAction: (a: Action, callNo: number | null) => void; onDelete: (runId: string) => void }) {
  const s = run.summary;
  const r = run.run;
  const tokensSaved = s.tokensNotRespent.inputTokens + (s.tokensNotRespent.cacheReadInputTokens ?? 0);
  const fenced = s.byOrigin.blocked + s.byOrigin.stubbed;
  const unpriced = s.cost.spent === 0 && s.cost.saved === 0 && s.cost.unknownModels.length > 0;
  return (
    <header className="runhead">
      <div className="rh-main">
        <div className="rh-text">
          <Eyebrow>
            {run.label}
            {run.parent ? (
              <>
                {' '}
                of <a href={href.run(run.parent.runId)}>{shortId(run.parent.runId)}</a>
              </>
            ) : null}
            {r.status === 'running' ? <span className="live-word">recording now</span> : r.status !== 'completed' ? <span className="bad-word">{r.status}</span> : null}
          </Eyebrow>
          <div className="rh-title">
            <h1>{shortId(r.runId)}</h1>
            <CopyButton text={r.runId} label="Copy id" />
          </div>
          <div className="rh-line">
          <code className="rh-cmd">{run.source ? `from ${run.source}` : r.command.argv.join(' ')}</code>
          <span className="rh-meta">
            {when(r.startedAt)}
            {s.durationMs !== null ? ` · ${formatDuration(s.durationMs)}` : ''}
            {r.codeVersion ? ` · @${r.codeVersion}` : ''}
            {/* A partial recording explains itself: otherwise "11 of 30 replayed" looks like a fault. */}
            {r.meta?.covers?.length ? ` · partial recording: ${r.meta.covers.join('/')} only, other kinds run live` : ''}
            {run.children.length ? (
              <>
                {' · '}
                {run.children.length} {run.children.length === 1 ? 'replay' : 'replays'}:{' '}
                {run.children.slice(0, 3).map((c, i) => (
                  <span key={c.runId}>
                    {i ? ', ' : ''}
                    <a href={href.run(c.runId)} title={c.label}>
                      {shortId(c.runId)}
                    </a>
                  </span>
                ))}
                {run.children.length > 3 ? ` +${run.children.length - 3}` : ''}
              </>
            ) : null}
          </span>
          </div>
          <LabelsBar client={client} runId={r.runId} labels={r.meta?.labels ?? []} enabled={actionsEnabled} />
        </div>
        <div className="rh-actions">
          {run.parent ? (
            <a className="btn" href={href.compare(run.parent.runId, r.runId)}>
              Compare
            </a>
          ) : null}
          {client.exported ? null : <DownloadButton client={client} runId={r.runId} />}
          {/* An exported copy has nothing to run or delete against, so it shows neither. */}
          {client.exported ? null : (
            <>
              <ActionsMenu actions={actions} callNo={callNo} enabled={actionsEnabled} onPick={(a) => onAction(a, a.key === 'r' || a.key === 's' || a.key === 'e' || a.key === 'p' || a.key === 'n' ? null : callNo)} />
              <button type="button" className="btn quiet" onClick={() => onDelete(r.runId)} disabled={r.status === 'running'} title={r.status === 'running' ? 'This run is still recording' : 'Delete this run'}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>
      <div className="stats">
        <Stat value={s.total} label="calls" note={`${s.byKind.api} model · ${s.byKind.tool} tool`} />
        {r.mode === 'replay' ? (
          <Stat value={s.byOrigin.replayed + s.byOrigin.overridden} label="replayed" note={`${s.byOrigin.live - s.injected} live${s.injected ? ` · ${s.injected} injected` : ''}${fenced ? ` · ${fenced} fenced` : ''}`} />
        ) : s.imported ? (
          // An imported run holds calls someone else's process made; it recorded nothing live here.
          <Stat value={s.byOrigin.live} label="captured" note={r.meta?.covers?.length ? `${r.meta.covers.join('/')} calls only` : 'from a pack'} />
        ) : (
          <Stat value={s.byOrigin.live} label="recorded live" />
        )}
        <Stat value={s.upstreamRequests} label="upstream requests" note={s.injected ? `${s.injected} answered by Shadowlap` : s.imported ? 'none from here' : undefined} />
        {s.imported && s.cost.captured ? (
          <Stat value={`≈${formatUsd(s.cost.captured)}`} label="traffic captured" note="spent where it ran, not here" />
        ) : unpriced ? (
          // A model with no price (a local one, or one missing from the price table): no dollar figure is better than $0.
          <Stat value="—" label="spent" note={`no price for ${s.cost.unknownModels[0]}`} />
        ) : (
          <Stat value={s.cost.spent ? `≈${formatUsd(s.cost.spent)}` : '$0'} label="spent" note={s.cost.unknownModels.length ? `no price for ${s.cost.unknownModels[0]}` : 'at list price'} />
        )}
        {r.mode === 'replay' ? unpriced ? <Stat value={formatTokens(tokensSaved)} label="tokens not re-spent" note="input tokens" /> : <Stat value={formatUsd(s.cost.saved)} label="not re-spent" note={tokensSaved ? `${formatTokens(tokensSaved)} input tokens` : undefined} /> : null}
      </div>
    </header>
  );
}

/**
 * Saves the run as one HTML file to send: its ancestors come along so a fork still shows what it
 * parted from, and the project's redaction rules apply, as `shadowlap export html --lineage` does. The
 * label says so when there were no rules to apply, because the file is made to leave the machine.
 */
function DownloadButton({ client, runId }: { client: Client; runId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'unredacted' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle' || state === 'busy') return;
    const t = setTimeout(() => setState('idle'), state === 'unredacted' ? 4000 : 1600);
    return () => clearTimeout(t);
  }, [state]);
  const label = { idle: 'Download', busy: 'Preparing…', saved: 'Saved', unredacted: 'Saved · not redacted', failed: 'Download failed' }[state];
  const title =
    state === 'unredacted'
      ? 'shadowlap.config.json has no redaction rules, so the file holds the prompts and tool data as recorded'
      : 'This run as one HTML file, with the runs it came from, to open anywhere or attach to a pull request';
  return (
    <button
      type="button"
      className="btn"
      disabled={state === 'busy'}
      title={title}
      onClick={() => {
        setState('busy');
        client.download(runId).then(
          (r) => setState(r.redacted ? 'saved' : 'unredacted'),
          () => setState('failed'),
        );
      }}
    >
      {label}
    </button>
  );
}

const DIVERGENCE_TITLE: Record<string, string> = {
  request_changed: 'a request changed',
  new_call: 'a call the recording never made',
  forced: 'forced live',
  beyond_recording: 'past the end of the recording',
};

function ForkSection({ run }: { run: RunDetail }) {
  const d = run.run.divergence!;
  const [open, setOpen] = useState(() => window.innerHeight >= 860);
  const diff = d.diff ?? [];
  const first = diff[0];
  return (
    <section className="forkinfo" aria-label="Where the run forked">
      <div className="fork-head">
        <span className="label">Forked at</span>
        <a className="fork-call" href={href.run(run.run.runId, d.callNo)}>
          #{d.callNo} <span>{d.name}</span>
        </a>
        <span className="fork-why">
          {DIVERGENCE_TITLE[d.type] ?? d.type} · {d.replayedBefore} {d.replayedBefore === 1 ? 'call' : 'calls'} replayed before it
        </span>
        {!open && first ? (
          <span className="fork-summary">
            <span className={`op op-${first.op}`}>{first.op === 'added' ? '+' : first.op === 'removed' ? '−' : '~'}</span>
            {first.path}
            {diff.length > 1 ? ` and ${diff.length - 1} more` : ''}
          </span>
        ) : null}
        {/* A fork nothing changed a request to cause — --fail-at, --live-tool, --diverge-at — has no
            diff to show, and its reason is the whole explanation, so it stands where the diff would. */}
        {!open && !first && d.reason ? (
          <span className="fork-summary" title={d.reason}>
            {d.reason}
          </span>
        ) : null}
        <span className="spacer" />
        {diff.length || d.hints?.length || d.counterpart ? (
          <button type="button" className="textbtn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {diff.length ? (open ? 'Hide diff' : 'Show diff') : open ? 'Hide' : 'More'}
          </button>
        ) : null}
      </div>
      {open && (diff.length || d.reason || d.hints?.length) ? (
        <div className="evidence">
          {d.reason && !diff.length ? <div className="ev-line muted">{d.reason}</div> : null}
          {diff.slice(0, 12).map((e, i) => (
            <div className="ev-diff" key={i}>
              <div className="ev-path">
                <span className={`op op-${e.op}`}>{e.op === 'added' ? '+' : e.op === 'removed' ? '−' : '~'}</span> {e.path}
              </div>
              {e.op !== 'added' ? <pre className="del">− {clip(json(e.before))}</pre> : null}
              {e.op !== 'removed' ? <pre className="add">+ {clip(json(e.after))}</pre> : null}
            </div>
          ))}
          {diff.length > 12 ? <div className="ev-line muted">… {diff.length - 12} more differences</div> : null}
          {d.hints?.map((h, i) => (
            <div className="ev-line" key={i}>
              <span className="muted">hint:</span> {h.message}
              {h.normalizer ? (
                <div className="ev-cmd">
                  shadowlap normalize add{h.normalizer.kind ? ` --kind ${h.normalizer.kind}` : ''} --path &apos;{h.normalizer.path ?? '$'}&apos;{h.normalizer.pattern ? ` --pattern ${h.normalizer.pattern}` : ''}
                </div>
              ) : null}
            </div>
          ))}
          {d.counterpart ? (
            <div className="ev-line muted">
              compared with <a href={href.run(d.counterpart.runId, d.counterpart.callNo)}>{shortId(d.counterpart.runId)} #{d.counterpart.callNo}</a>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function clip(s: string, max = 1500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** One cell per call, in the color of what happened to it: the shape of the run at a glance. */
function OriginStrip({ run, selected }: { run: RunDetail; selected: number | null }) {
  const divergence = run.run.divergence?.callNo;
  const cells = useMemo(() => stripCells(run.calls, selected, divergence), [run.calls, selected, divergence]);
  if (run.calls.length === 0) return null;
  const present = new Set(run.calls.map((c) => (c.origin === 'overridden' ? 'replayed' : c.origin)));
  const liveErrors = run.calls.some((c) => isFailure(c) && c.origin !== 'blocked' && c.origin !== 'injected');
  return (
    <div className="originstrip">
      <div className="cells" role="list" aria-label={cells.length < run.calls.length ? `Calls by origin, ${Math.ceil(run.calls.length / cells.length)} calls per cell` : 'Calls by origin'}>
        {cells.map((c) => (
          <a
            key={c.first}
            role="listitem"
            href={href.run(run.run.runId, c.target)}
            className={`cell o-${c.origin}${c.error ? ' is-error' : ''}${c.selected ? ' sel' : ''}${c.fork ? ' is-fork' : ''}`}
            title={c.title}
          />
        ))}
      </div>
      <div className="legend" aria-hidden="true">
        {(['replayed', 'live', 'blocked', 'stubbed', 'injected'] as const).filter((o) => present.has(o)).map((o) => (
          <Origin key={o} origin={o} error={o === 'injected'} />
        ))}
        {liveErrors ? <Origin origin="error" error /> : null}
      </div>
    </div>
  );
}

const CallsTable = memo(function CallsTable({ calls, runId, selected, divergence }: { calls: CallRow[]; runId: string; selected: number | null; divergence: number | null }) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    // Scroll the table only: scrollIntoView would also scroll the panes around it on a short screen.
    const row = bodyRef.current?.querySelector<HTMLElement>('tr.sel');
    const wrap = row?.closest<HTMLElement>('.table-wrap');
    if (!row || !wrap) return;
    const view = wrap.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const head = wrap.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    if (box.top < view.top + head) wrap.scrollTop -= view.top + head - box.top;
    else if (box.bottom > view.bottom) wrap.scrollTop += box.bottom - view.bottom;
  }, [selected, calls]);
  if (calls.length === 0) return <div className="note pad">No calls match.</div>;
  return (
    <div className="table-wrap">
      <table className={`calltable${calls.some((c) => c.cost !== null) ? '' : ' nocost'}`}>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Call</th>
            <th>Origin</th>
            <th>Detail</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
            <th className="num">Time</th>
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {calls.map((c) => (
            <CallRowView key={c.callNo} c={c} runId={runId} selected={c.callNo === selected} fork={c.callNo === divergence} />
          ))}
        </tbody>
      </table>
    </div>
  );
});

const CallRowView = memo(function CallRowView({ c, runId, selected, fork }: { c: CallRow; runId: string; selected: boolean; fork: boolean }) {
  const detail = c.kind === 'api' ? [c.outcome === 'error' && c.status ? `HTTP ${c.status}` : null, c.model, c.stopReason].filter(Boolean).join(' · ') : (c.error ?? c.detail);
  return (
    <tr className={`${selected ? 'sel' : ''}${fork ? ' is-fork' : ''}${isFailure(c) ? ' is-error' : ''}`} onClick={() => navigate(href.run(runId, c.callNo), true)} aria-selected={selected}>
      <td className="num">{c.callNo}</td>
      <td className="callname">
        <span className="kind">{c.kind}</span>
        <span className="name" title={c.name}>
          {callName(c.kind, c.name)}
        </span>
        {c.attempts ? (
          // "+2", as `show` prints it: two more attempts than the first. "2×" read as two in all.
          <span className="retries" title={`${c.attempts} ${c.attempts === 1 ? 'retry' : 'retries'} before the final outcome`}>
            +{c.attempts}
          </span>
        ) : null}
      </td>
      <td>
        <Origin origin={c.origin} />
      </td>
      <td className="detail" title={detail}>
        {detail}
      </td>
      <td className="num">{c.usage ? `${formatTokens(c.usage.input + c.usage.cacheRead)} → ${formatTokens(c.usage.output)}` : ''}</td>
      <td className="num">{c.cost !== null ? formatUsd(c.cost) : ''}</td>
      <td className="num">{c.latencyMs !== null ? (c.latencyMs < 1000 ? `${c.latencyMs} ms` : `${(c.latencyMs / 1000).toFixed(1)} s`) : c.outcome === null ? '…' : ''}</td>
    </tr>
  );
});
