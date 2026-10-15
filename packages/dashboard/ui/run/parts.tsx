import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { JOB_KINDS, type BlameView, type CheckView, type RunDetail } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { approx, callName, clip, durLong, jsonText, ktok, money, num, shortId } from '../format.js';
import { countOrigins, type OriginCounts } from '../origins.js';
import { href } from '../route.js';
import { runType } from '../runs.js';
import { scopeDepth, scopeLeaf, scopeCount } from '../scopes.js';
import { useApp } from '../state.js';
import type { PendingAction } from './actions.js';
import { originOf, runLikeOf } from './model.js';

type Item = [string | number, string, string?];

/** The run's numbers: the counts lead; what replaying saved comes last, as a quieter receipt. */
export function Metrics({ run, notWaitedMs, notWaitedUnknown }: { run: RunDetail; notWaitedMs: number | null; notWaitedUnknown: number }) {
  const s = run.summary;
  const live = run.run.status === 'running';
  const n: OriginCounts = countOrigins(run.calls.map(originOf));
  const capture = runType(runLikeOf(run)) === 'capture';
  const unpriced = s.cost.spent === 0 && s.cost.unknownModels.length > 0;
  const spent: Item = capture ? [money(s.cost.captured), 'as captured'] : unpriced ? ['—', `spent · no price for ${s.cost.unknownModels[0]}`] : [approx(s.cost.spent), 'spent'];
  const plain = !n.rep && !n.block && !n.stub && !n.inject && !n.over;
  let items: Item[];
  if (plain) {
    items = [[s.total, live ? (s.total === 1 ? 'call so far' : 'calls so far') : s.total === 1 ? 'call' : 'calls'], [s.byKind.api, s.byKind.api === 1 ? 'model call' : 'model calls'], [s.byKind.tool, s.byKind.tool === 1 ? 'tool call' : 'tool calls']];
    if (n.fail) items.push([n.fail, 'failed', 'err']);
    items.push([s.upstreamRequests, s.upstreamRequests === 1 ? 'upstream request' : 'upstream requests'], spent);
  } else {
    items = [[s.total, s.total === 1 ? 'call' : 'calls'], [n.rep, 'replayed', n.rep ? 'lime' : ''], [n.live, 'live']];
    if (n.over) items.push([n.over, 'overridden']);
    if (n.inject) items.push([n.inject, 'injected']);
    if (n.fail) items.push([n.fail, 'failed', 'err']);
    if (n.block + n.stub) items.push([n.block + n.stub, n.block && n.stub ? 'fenced' : n.stub ? 'stubbed' : 'blocked']);
    items.push([s.upstreamRequests, s.upstreamRequests === 1 ? 'upstream request' : 'upstream requests'], spent);
    const tokens = s.tokensNotRespent.inputTokens + (s.tokensNotRespent.cacheReadInputTokens ?? 0);
    if (s.cost.saved || tokens) items.push([money(s.cost.saved), `not re-spent${tokens ? ` · ${ktok(tokens)} tokens` : ''}`, 'q']);
    if (notWaitedMs) items.push([durLong(notWaitedMs), 'not waited', 'q']);
  }
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

const DIVERGED: Record<string, string> = {
  request_changed: 'a request changed',
  new_call: 'a call the recording never made',
  forced: 'forced live',
  beyond_recording: 'past the end of the recording',
};

export interface BannerProps {
  run: RunDetail;
  blame: BlameView | null;
  rescued: { callNo: number } | null;
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
  const d = r.divergence;
  const like = runLikeOf(run);
  const type = runType(like);
  const call = (n: number) => (
    <button className="bn" type="button" onClick={() => onSelect(n)}>
      #{n}
    </button>
  );
  const diffToggle = d?.diff?.length ? (
    <button className="linkbtn" type="button" onClick={onToggleDiff}>
      {showDiff ? 'Hide diff' : 'Show diff'}
    </button>
  ) : null;
  const normalizer = run.actions.find((a) => a.key === 'n');
  const addNormalizer =
    normalizer && !app.actionsOff ? (
      <button className="btn sm lime" type="button" disabled={!!normalizer.disabled} onClick={() => onAction({ action: normalizer, callNo: null })}>
        Add normalizer
      </button>
    ) : null;
  const fixLink = run.fix ? (
    <a className="more" href={href.fixes(run.fix.id, 'blame')}>
      Fix →
    </a>
  ) : null;

  if (r.status === 'running')
    return (
      <section className="banner live">
        <span className="dotlive" />
        <span className="bk">recording</span>
        <Why>calls arrive as they happen · replay and fork once it finishes</Why>
      </section>
    );
  if (rescued && d)
    return (
      <section className="banner fork">
        <span className="bk">forked at</span>
        {call(rescued.callNo)}
        <Why>a blame attempt that passed: the model was asked #{rescued.callNo} again · writes stubbed</Why>
        <span className="end">{fixLink}</span>
      </section>
    );
  if (d && type === 'test')
    return (
      <section className="banner blame">
        <span className="bk">diverged at</span>
        {call(d.callNo)}
        <code>{d.name}</code>
        <Why>
          {num(d.replayedBefore)} calls replayed before it{d.hints?.[0] ? ` · ${d.hints[0].message}` : ''}
        </Why>
        {d.diff?.[0] ? <span className="path">~ {d.diff[0].path}</span> : null}
        <span className="end">
          {addNormalizer}
          {diffToggle}
        </span>
      </section>
    );
  if (d) {
    const flag = run.intervention?.flag ?? (d.type === 'forced' && d.reason ? d.reason.replace(/^forced live by /, '').split(':')[0] : null);
    const reason = d.type === 'forced' && d.reason ? d.reason.replace(/^forced live by /, '') : null;
    return (
      <section className="banner fork">
        <span className="bk">forked at</span>
        {call(d.callNo)}
        <code>{d.name}</code>
        <Why>
          {reason ?? (flag ? `${flag} · ` : '') + (DIVERGED[d.type] ?? d.type)}
          {' · '}
          {num(d.replayedBefore)} {d.replayedBefore === 1 ? 'call' : 'calls'} replayed before it
        </Why>
        {d.diff?.[0] ? <span className="path">~ {d.diff[0].path}</span> : null}
        <span className="end">
          {d.hints?.some((h) => h.normalizer) ? addNormalizer : null}
          {diffToggle}
        </span>
      </section>
    );
  }
  if (blame && blame.callNo)
    return (
      <section className="banner blame">
        <span className="bk">lost at</span>
        {call(blame.callNo)}
        <Why>
          {blame.modelCall ? `model call ${blame.modelCall.k} of ${blame.modelCall.m}` : `call #${blame.callNo}`}
          {blame.confidence ? ` · confidence ${blame.confidence}` : ''}
          {blame.scope ? ` · scope ${blame.scope}` : ''}
        </Why>
        <span className="end">
          {blame.rescuedRunId ? (
            <a className="more" href={href.run(blame.rescuedRunId)}>
              Rescued fork
            </a>
          ) : null}
          {fixLink}
        </span>
      </section>
    );
  const nr = run.notRecorded;
  if (nr && (nr.tools.length || nr.hosts.length)) {
    const what = [...nr.tools, ...nr.hosts];
    return (
      <section className="banner blame">
        <span className="bk">not recorded</span>
        <Why>
          {nr.tools.length ? `${nr.tools.length === 1 ? '1 tool wasn’t' : `${nr.tools.length} tools weren’t`} wrapped` : `${nr.hosts.length === 1 ? '1 host wasn’t' : `${nr.hosts.length} hosts weren’t`} recorded`}, so their calls aren’t in this recording: {what.join(', ')}. A replay would run them for real.
        </Why>
      </section>
    );
  }
  const failedChecks = checks.filter((c) => !c.ok);
  if (checks.length && !failedChecks.length && r.status === 'completed')
    return (
      <section className="banner live">
        <span className="bk">checks</span>
        {checks.map((c) => (
          <span className="st ok" key={c.label}>
            <i />
            {c.label}
            {c.count !== undefined && c.of !== undefined ? ` · ${c.count} of ${c.of}` : ''}
          </span>
        ))}
        {type === 'test' || run.summary.upstreamRequests === 0 ? <Why>replayed offline · 0 upstream</Why> : null}
      </section>
    );
  const failure = failedChecks[0] ? `check failed: ${failedChecks[0].label}` : r.status === 'failed' ? 'the agent exited with an error' : r.status === 'crashed' ? 'the run was interrupted' : null;
  if (failure && run.fix)
    return (
      <section className="banner blame">
        <span className="bk">failed</span>
        <Why>
          {failure} · {run.fix.status === 'open' ? `no fix yet for “${run.fix.title}”` : `fixed: “${run.fix.title}”, ${run.fix.status}`}
        </Why>
        <span className="end">
          <a className="more" href={href.fixes(run.fix.id)}>
            Fix →
          </a>
        </span>
      </section>
    );
  if (failure)
    return (
      <section className="banner blame">
        <span className="bk">failed</span>
        <Why>{failure} · not blamed yet</Why>
        {app.hasKind(JOB_KINDS.blame) && !app.actionsOff ? (
          <span className="end">
            <button className="linkbtn" type="button" onClick={() => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.blame, { runId: r.runId })))}>
              Run blame
            </button>
          </span>
        ) : null}
      </section>
    );
  return null;
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
