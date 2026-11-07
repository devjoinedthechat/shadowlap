import { useMemo, type ReactNode } from 'react';
import { wholeInput } from '../../../engine/src/tokens.js';
import type { RunDetail } from '../api.js';
import type { TestBannerOffer } from '../types.js';
import { CmdLine } from '../components/bits.js';
import { callName, clip, jsonText, num, shortId } from '../format.js';
import { countOrigins, parseOrigins } from '../origins.js';
import { href } from '../route.js';
import { outcomeOf, runType, TODAY } from '../runs.js';
import { tipCard } from '../components/HoverCard.js';
import { Status } from '../components/Status.js';
import { useLoad } from '../hooks.js';
import { scopeCount, scopeDepth, scopeHint, scopeLeaf } from '../scopes.js';
import { useApp } from '../state.js';
import type { PresetAttempt } from './preset.js';
import { attemptOutcome, DIVERGED } from './banner.js';
import { refusedOffline } from './calls.js';
import { metricItems, outcomeFact, type MetricInput, type OutcomeFact } from './metrics.js';
import { attemptOf, checksOf, originOf, pulledSpender, runLikeOf } from './model.js';
import { updatesAfterRules } from './offers.js';

/** The run page while its run loads (a run of 50,000 calls takes seconds): it says so, and is busy for a screen reader. */
export function RunLoading() {
  return (
    <div className="rv loading" aria-busy="true">
      <div className="empty tall">Loading the run…</div>
    </div>
  );
}

/** The run's numbers, led by its outcome by checks: the payload's, or the one asked for alone (useJudgedAt), pending until it comes. */
export function RunMetrics(props: { run: RunDetail; judged: RunDetail['judged']; notWaitedMs: number | null; notWaitedUnknown: number; preset?: PresetAttempt | null; rescued?: boolean }) {
  return <Metrics {...props} judged={props.judged ?? null} pending={props.judged === undefined} />;
}

/**
 * The run's verdict by its checks (useJudged), for its first fact and its findings, and the call that
 * fact names, where the run opens when nothing more telling comes first (openingCall).
 */
export function useJudgedAt(run: RunDetail): { judged: RunDetail['judged']; outcomeAt: number | null } {
  const judged = useJudged(run);
  const outcomeAt = useMemo(() => (judged === undefined ? null : (outcomeOf({ ...runLikeOf(run), judged }).at?.callNo ?? null)), [run, judged]);
  return { judged, outcomeAt };
}

/** How an attempt came out, as its finding says it: the first fact says it too, where the chip beside the id once did. */
function attemptVerdictOf(run: RunDetail, checks: ReturnType<typeof checksOf>) {
  const a = attemptOf(run);
  return a ? attemptOutcome({ status: run.run.status, checks, ...(run.state ? { interrupted: run.state.interrupted } : {}) }, a) : null;
}

/**
 * The run's numbers: how it came out leads, by the checks that judged it (`judged`, the payload's
 * unless given; `pending` while a long run's analysis is yet to judge it); the counts follow; what
 * replaying saved comes last, as a quieter receipt.
 */
export function Metrics({ run, notWaitedMs, notWaitedUnknown, judged = run.judged ?? null, pending = false, preset = null, rescued = false }: { run: RunDetail; notWaitedMs: number | null; notWaitedUnknown: number; judged?: RunDetail['judged']; pending?: boolean; preset?: PresetAttempt | null; rescued?: boolean }) {
  const s = run.summary;
  const items = metricItems({
    // A recording's count as the poll says it, as its list has it: its page is asked for again only
    // every few seconds, and its newest call is the count (open-at.ts).
    total: run.run.status === 'running' ? Math.max(s.total, run.callsTotal) : s.total,
    byKind: s.byKind,
    upstreamRequests: s.upstreamRequests,
    cost: s.cost,
    tokensNotRespent: wholeInput(s.tokensNotRespent),
    // Every call's, while a long run's pages come (`origins`, paging.ts).
    counts: countOrigins((run.origins ? parseOrigins(run.origins) : null) ?? run.calls.map(originOf)),
    capture: runType(runLikeOf(run)) === 'capture',
    toolsCaptured: toolsCaptured(run),
    ...spentBy(run),
    live: run.run.status === 'running',
    notWaitedMs,
    notWaitedUnknown,
    refused: run.calls.filter((c) => c.outcome === 'error' && refusedOffline(c)).length,
  });
  // How it came out leads: the verdict of the checks that judged it, as Runs' Status says it.
  const fact = outcomeFact({ ...runLikeOf(run), judged: judged ?? null }, { tools: s.byKind.tool, pending, preset, rescued, attempt: attemptVerdictOf(run, checksOf(run)) });
  return (
    <section className="metrics" aria-label="How it went">
      <Outcome fact={fact} runId={run.run.runId} />
      {/* Each fact's make-up is on its card: the calls' kinds, the upstream requests, the tokens not sent again. */}
      {items.map((m) => (
        <span className="metric" key={m.label} data-tip={tipCard(m.tip.title, m.tip.rows.map(([label, value]) => ({ label, value: typeof value === 'number' ? num(value) : value })), m.tip.sub)}>
          <b className={m.cls || undefined}>{typeof m.value === 'number' ? num(m.value) : m.value}</b>
          <span>{m.label}</span>
        </span>
      ))}
    </section>
  );
}

/**
 * The run's outcome by checks: the payload's, or for a long run whose first answer came before its
 * analysis judged it, the server's answer alone (`/api/runs/:id/outcome`) once it has it; undefined
 * until then.
 */
function useJudged(run: RunDetail): RunDetail['judged'] {
  const { client } = useApp();
  const ask = run.judged === undefined && !!run.warming && run.run.status !== 'running';
  const asked = useLoad(() => (ask ? client.outcome(run.run.runId) : null), ask ? `${run.run.runId}:${run.callsTotal}` : 'none');
  if (!ask) return run.judged ?? null;
  return asked.data ? asked.data.judged : asked.error ? null : undefined;
}

/**
 * The run's first fact: its status, a dot and its verdict's word, the call it turned on as a link,
 * by today's checks after it; what judged it on hover, and to a screen reader the check it names.
 */
function Outcome({ fact, runId }: { fact: OutcomeFact; runId: string }) {
  const tip = fact.tip ? tipCard(fact.tip.title, fact.tip.rows.map(([label, value, color]) => ({ label, value, color })), fact.tip.sub) : undefined;
  return (
    <span className="metric rout">
      <Status tone={fact.tone} tip={tip}>
        {fact.words}
        {fact.callNo !== null ? (
          <>
            {' '}
            <a className="bn" href={href.run(runId, fact.callNo)}>
              #{fact.callNo}
            </a>
          </>
        ) : null}
        {fact.tip?.said ? <span className="sr">: {fact.tip.said}</span> : null}
      </Status>
      {fact.today ? <span className="rtoday">{TODAY}</span> : null}
    </span>
  );
}

/** Whether the run saw its tools: a partial recording (a capture) covers tools only when its kinds name them (`tool`, `tool:<name>`). */
function toolsCaptured(run: RunDetail): boolean {
  const covers = run.run.meta?.covers;
  return !covers?.length || covers.some((k) => k === 'tool' || k.startsWith('tool:'));
}

/** Who spent what a run pulled from the team store spent (`pulledSpender`); nothing for a run made here. */
function spentBy(run: RunDetail): Pick<MetricInput, 'spentBy'> {
  const by = pulledSpender(run.run);
  return by === undefined ? {} : { spentBy: by };
}

/** A one-line JSON value with a place to break after each comma, for a pane that wraps it (a narrow window's). */
function breakable(text: string): ReactNode[] {
  const parts = text.split(',');
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [`${part},`, <wbr key={i} />] : [part]));
}

/**
 * What a diverged test's banner found, said again under the diff: the value made anew on every run,
 * what it looks like, and what its normalizer does; that one the recording never had needs the
 * golden updated after the rule, and that one that may be a real change should be looked at first.
 */
function VolatileHint({ v, updates }: { v: NonNullable<TestBannerOffer['volatile']>; updates: boolean }) {
  return (
    <span>
      {' '}
      {v.op === 'added' ? (
        <>
          A value the recording never had, at <code>{v.path}</code>, looks like {v.looks}
        </>
      ) : (
        <>
          Only a value changed at <code>{v.path}</code>, and it looks like {v.looks}
        </>
      )}
      {v.certain ? ': the agent makes a new one on every run.' : ', though it may be a real change: look at it before masking it.'} A normalizer masks it before matching
      {updates ? '; the request still carries the field the recording lacks, so the golden is updated after it.' : ', and older recordings match too.'}
    </span>
  );
}

/**
 * The request that changed at the fork: what the recording sent, and what this run sent. A diverged
 * test's value made anew on every run is the test offer's finding (the banner's), judged on all its
 * changes: the panel says so, with its normalizer, and says none is suggested only when neither the
 * divergence's hints nor the finding suggest one.
 */
export function DiffPanel({ run, test = null }: { run: RunDetail; test?: TestBannerOffer | null }) {
  const d = run.run.divergence;
  if (!d) return null;
  const diff = d.diff ?? [];
  const parent = run.parent ? shortId(run.parent.runId) : 'the recording';
  const hint = d.hints?.find((h) => h.normalizer);
  const n = hint?.normalizer;
  const v = test?.volatile ?? null;
  const command = v?.command ?? (n ? `shadowlap normalize add${n.kind ? ` --kind ${n.kind}` : ''}${n.name ? ` --name ${n.name}` : ''} --path '${n.path ?? '$'}'${n.pattern ? ` --pattern ${n.pattern}` : ''} --replace '${n.replace}'` : null);
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
                  <span className="val">{e.op === 'added' ? '  (absent)' : <>{'  '}{breakable(clip(jsonText(e.before, false), 800))}</>}</span>
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
                  <span className="add">{e.op === 'removed' ? '  (absent)' : <>{'  '}{breakable(clip(jsonText(e.after, false), 800))}</>}</span>
                </span>
              ))
            : callName(d.kind, d.name)}
        </pre>
      </div>
      <div className="hint">
        {diff.length ? `${diff.length === 1 ? 'One field' : `${diff.length} fields`} changed${diff.length > 12 ? '; the first 12 are shown' : ''}.` : null}
        {v ? (
          <VolatileHint v={v} updates={!!test && updatesAfterRules(test)} />
        ) : (
          d.hints?.map((h, i) => <span key={i}> {h.message}</span>)
        )}
        {!hint && !v && diff.length ? ' Not a date or an id, so no normalizer is suggested.' : null}
        {command ? <CmdLine>{command}</CmdLine> : null}
      </div>
    </section>
  );
}

/** Scopes as chips with counts, nested ones under their parent; picking one narrows every view to it. */
export function ScopeBar({ run, scopes, scope, onScope }: { run: RunDetail; scopes: string[]; scope: string; onScope: (s: string) => void }) {
  // Blame the agent, not the model that plays its user: the scope picked, else the one that acts.
  const hint = scopeHint(run.calls, scopes, scope) ?? { lead: 'Blame within one scope', scope: scopes[0]! };
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
        {hint.lead}: <code>shadowlap blame {shortId(run.run.runId)} --scope {hint.scope}</code>
      </span>
    </section>
  );
}
