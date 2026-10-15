import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { JOB_KINDS, type BlameView, type CheckView, type RunDetail } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { callName, clip, jsonText, num, shortId } from '../format.js';
import { countOrigins } from '../origins.js';
import { href } from '../route.js';
import { runType } from '../runs.js';
import { scopeDepth, scopeLeaf, scopeCount } from '../scopes.js';
import { useApp } from '../state.js';
import type { PendingAction } from './actions.js';
import { bannerFor, DIVERGED } from './banner.js';
import { metricItems } from './metrics.js';
import { originOf, runLikeOf } from './model.js';

/** The run's numbers: the counts lead; what replaying saved comes last, as a quieter receipt. */
export function Metrics({ run, notWaitedMs, notWaitedUnknown }: { run: RunDetail; notWaitedMs: number | null; notWaitedUnknown: number }) {
  const s = run.summary;
  const items = metricItems({
    total: s.total,
    byKind: s.byKind,
    upstreamRequests: s.upstreamRequests,
    cost: s.cost,
    tokensNotRespent: s.tokensNotRespent.inputTokens + (s.tokensNotRespent.cacheReadInputTokens ?? 0),
    counts: countOrigins(run.calls.map(originOf)),
    capture: runType(runLikeOf(run)) === 'capture',
    live: run.run.status === 'running',
    notWaitedMs,
  });
  return (
    <section className="metrics" title={notWaitedUnknown ? `${notWaitedUnknown} replayed calls’ recorded durations were not found` : undefined}>
      {items.map(([v, label, cls], i) => (
        <span className="metric" key={i}>
          <b className={cls || undefined}>{typeof v === 'number' ? num(v) : v}</b>
          <span>{label}</span>
        </span>
      ))}
    </section>
  );
}

/** One line: the explanation gives way first, cut with "…" and shown in full on hover. */
function Why({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.title = el.textContent ?? '';
  });
  return (
    <span className="why" ref={ref}>
      {children}
    </span>
  );
}

export interface BannerProps {
  run: RunDetail;
  blame: BlameView | null;
  rescued: { callNo: number | null } | null;
  checks: CheckView[];
  showDiff: boolean;
  onToggleDiff: () => void;
  onSelect: (n: number) => void;
  onAction: (p: PendingAction) => void;
}

/** The run's one banner: recording now, how it forked, where it was lost, what was not recorded, its checks, or that it failed. */
export function Banner({ run, blame, rescued, checks, showDiff, onToggleDiff, onSelect, onAction }: BannerProps) {
  const app = useApp();
  const r = run.run;
  const b = bannerFor({
    status: r.status,
    type: runType(runLikeOf(run)),
    divergence: r.divergence,
    intervention: run.intervention ?? null,
    rescued,
    blame,
    notRecorded: run.notRecorded ?? null,
    checks,
    fix: run.fix ?? null,
    upstreamRequests: run.summary.upstreamRequests,
  });
  if (!b) return null;
  const call = (n: number) => (
    <button className="bn" type="button" onClick={() => onSelect(n)}>
      #{n}
    </button>
  );
  const diffToggle = (
    <button className="linkbtn" type="button" onClick={onToggleDiff}>
      {showDiff ? 'Hide diff' : 'Show diff'}
    </button>
  );
  const normalizer = run.actions.find((a) => a.key === 'n');
  const addNormalizer =
    normalizer && !app.actionsOff ? (
      <button className="btn sm lime" type="button" disabled={!!normalizer.disabled} onClick={() => onAction({ action: normalizer, callNo: null })}>
        Add normalizer
      </button>
    ) : null;
  const fixLink = (step?: string) =>
    run.fix ? (
      <a className="more" href={href.fixes(run.fix.id, step ?? null)}>
        Fix →
      </a>
    ) : null;
  switch (b.kind) {
    case 'recording':
      return (
        <section className="banner live">
          <span className="dotlive" />
          <span className="bk">recording</span>
          <Why>calls arrive as they happen · replay and fork once it finishes</Why>
        </section>
      );
    case 'rescued':
      return (
        <section className="banner fork">
          <span className="bk">forked at</span>
          {b.callNo !== null ? call(b.callNo) : null}
          <Why>{b.why}</Why>
          <span className="end">{fixLink('blame')}</span>
        </section>
      );
    case 'diverged':
    case 'fork':
      return (
        <section className={`banner ${b.kind === 'diverged' ? 'blame' : 'fork'}`}>
          <span className="bk">{b.kind === 'diverged' ? 'diverged at' : 'forked at'}</span>
          {call(b.callNo)}
          <code>{b.name}</code>
          <Why>{b.why}</Why>
          {b.path ? <span className="path">~ {b.path}</span> : null}
          <span className="end">
            {b.normalizer ? addNormalizer : null}
            {b.diff ? diffToggle : null}
          </span>
        </section>
      );
    case 'lost':
      return (
        <section className="banner blame">
          <span className="bk">lost at</span>
          {call(b.callNo)}
          <Why>{b.why}</Why>
          <span className="end">
            {b.rescuedRunId ? (
              <a className="more" href={href.run(b.rescuedRunId)}>
                Rescued fork
              </a>
            ) : null}
            {fixLink('blame')}
          </span>
        </section>
      );
    case 'not-recorded':
      return (
        <section className="banner blame">
          <span className="bk">not recorded</span>
          <Why>{b.why}</Why>
        </section>
      );
    case 'checks':
      return (
        <section className="banner live">
          <span className="bk">checks</span>
          {b.checks.map((c) => (
            <span className="st ok" key={c.label}>
              <i />
              {c.text}
            </span>
          ))}
          {b.why ? <Why>{b.why}</Why> : null}
        </section>
      );
    case 'failed':
      return (
        <section className="banner blame">
          <span className="bk">failed</span>
          <Why>{b.why}</Why>
          {b.fix ? (
            <span className="end">{fixLink()}</span>
          ) : !b.blamed && app.hasKind(JOB_KINDS.blame) && !app.actionsOff ? (
            <span className="end">
              <button className="linkbtn" type="button" onClick={() => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.blame, { runId: r.runId, ...(run.blameExpect !== undefined ? { expect: run.blameExpect } : {}) })))}>
                Run blame
              </button>
            </span>
          ) : null}
        </section>
      );
  }
}

/** The request that changed at the fork: what the recording sent, and what this run sent. */
export function DiffPanel({ run }: { run: RunDetail }) {
  const d = run.run.divergence;
  if (!d) return null;
  const diff = d.diff ?? [];
  const parent = run.parent ? shortId(run.parent.runId) : 'the recording';
  const hint = d.hints?.find((h) => h.normalizer);
  const n = hint?.normalizer;
  const command = n ? `shadowlap normalize add${n.kind ? ` --kind ${n.kind}` : ''}${n.name ? ` --name ${n.name}` : ''} --path '${n.path ?? '$'}'${n.pattern ? ` --pattern ${n.pattern}` : ''} --replace '${n.replace}'` : null;
  return (
    <section className="diffpanel">
      <div>
        <h4>
          Recorded request #{d.counterpart?.callNo ?? d.callNo} · {parent}
        </h4>
        <pre>
          {diff.length
            ? diff.slice(0, 12).map((e, i) => (
                <span key={i}>
                  {e.path}
                  {'\n'}
                  {e.op === 'added' ? '  (absent)' : `  ${clip(jsonText(e.before, false), 800)}`}
                  {'\n'}
                </span>
              ))
            : (d.reason ?? DIVERGED[d.type] ?? d.type)}
        </pre>
      </div>
      <div>
        <h4>This run’s request #{d.callNo}</h4>
        <pre>
          {diff.length
            ? diff.slice(0, 12).map((e, i) => (
                <span key={i}>
                  {e.path}
                  {'\n'}
                  <span className="add">{e.op === 'removed' ? '  (absent)' : `  ${clip(jsonText(e.after, false), 800)}`}</span>
                </span>
              ))
            : `${callName(d.kind, d.name)}`}
        </pre>
      </div>
      <div className="hint">
        {diff.length ? `${diff.length === 1 ? 'One field' : `${diff.length} fields`} changed${diff.length > 12 ? '; the first 12 are shown' : ''}.` : null}
        {d.hints?.map((h, i) => (
          <span key={i}> {h.message}</span>
        ))}
        {!hint && diff.length ? ' Not a date or an id, so no normalizer is suggested.' : null}
        {command ? <CmdLine>{command}</CmdLine> : null}
      </div>
    </section>
  );
}

/** Scopes as chips with counts, nested ones under their parent; picking one narrows every view to it. */
export function ScopeBar({ run, scopes, scope, onScope }: { run: RunDetail; scopes: string[]; scope: string; onScope: (s: string) => void }) {
  const first = scopes.find((s) => scopeDepth(s) === 0) ?? scopes[0]!;
  return (
    <section className="scopebar">
      <span className="k">scopes</span>
      <div className="chips">
        {['all', ...scopes].map((s) => (
          <button key={s} type="button" aria-pressed={scope === s} onClick={() => onScope(s)} title={s === 'all' ? undefined : s}>
            {s !== 'all' && scopeDepth(s) > 0 ? <span className="nest">↳</span> : null}
            {s === 'all' ? 'All' : scopeLeaf(s)}
            <b>{scopeCount(run.calls, s)}</b>
          </button>
        ))}
      </div>
      <span className="shint">
        Blame within one scope: <code>shadowlap blame {shortId(run.run.runId)} --scope {scope === 'all' ? first : scope}</code>
      </span>
    </section>
  );
}
