import { useMemo } from 'react';
import { wholeInput } from '../../../engine/src/tokens.js';
import type { RunDetail } from '../api.js';
import { injectionFactOf } from '../injection/model.js';
import type { RunInjection } from '../types.js';
import { num, shortId } from '../format.js';
import { countOrigins, parseOrigins } from '../origins.js';
import { href } from '../route.js';
import { outcomeOf, runType, TODAY } from '../runs.js';
import { tipCard } from '../components/HoverCard.js';
import { Status } from '../components/Status.js';
import { useLoad } from '../hooks.js';
import { realScopes, scopeCount, scopeDepth, scopeHint, scopeLeaf } from '../scopes.js';
import { useApp } from '../state.js';
import type { PresetAttempt } from './preset.js';
import { attemptOutcome } from './banner.js';
import { refusedOffline } from './calls.js';
import { metricItems, outcomeFact, spentWords, toolsToCheck, type MetricInput, type OutcomeFact } from './metrics.js';
import { attemptOf, checksOf, originOf, pulledSpender, runLikeOf } from './model.js';

/** The run page while its run loads (a run of 50,000 calls takes seconds): it says so, and is busy for a screen reader. */
export function RunLoading() {
  return (
    <div className="rv loading" aria-busy="true">
      <div className="empty tall">Loading the run…</div>
    </div>
  );
}

/** The run's numbers, led by its outcome by checks: the payload's, or the one asked for alone (useJudgedAt), pending until it comes. */
export function RunMetrics(props: { run: RunDetail; judged: RunDetail['judged']; notWaitedMs: number | null; notWaitedUnknown: number; preset?: PresetAttempt | null; rescued?: boolean; offered?: boolean; injection?: RunInjection['attempt'] }) {
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

/**
 * How a run came out, its header's first fact (outcomeFact): by the checks that judged it, a fork
 * blame rescued a run with, an error-path preset's verdict, an injection test's replay's by its own
 * record (with what the read of the attempt adds, on its page) or an attempt's. Compare's line a run
 * says it the same way.
 */
export function runFact(run: RunDetail, judged: NonNullable<RunDetail['judged']> | null, o: { pending?: boolean; preset?: PresetAttempt | null; rescued?: boolean; offered?: boolean; injection?: RunInjection['attempt'] }): OutcomeFact {
  const { injection = null, ...rest } = o;
  const checks = checksOf(run);
  return outcomeFact({ ...runLikeOf(run), judged }, { tools: toolsToCheck(run.calls, run.callsTotal, run.summary.byKind.tool), ...rest, attempt: attemptVerdictOf(run, checks), injection: injectionFactOf(run, checks, injection) });
}

/** What a run spent, in its header's words (spentWords): Compare's line a run says it again. */
export const runSpentWords = (run: RunDetail): ReturnType<typeof spentWords> => spentWords({ cost: run.summary.cost, capture: runType(runLikeOf(run)) === 'capture', ...spentBy(run) });

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
export function Metrics({ run, notWaitedMs, notWaitedUnknown, judged = run.judged ?? null, pending = false, preset = null, rescued = false, offered = false, injection = null }: { run: RunDetail; notWaitedMs: number | null; notWaitedUnknown: number; judged?: RunDetail['judged']; pending?: boolean; preset?: PresetAttempt | null; rescued?: boolean; offered?: boolean; injection?: RunInjection['attempt'] }) {
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
  const fact = runFact(run, judged ?? null, { pending, preset, rescued, offered, injection });
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

/** Scopes as chips with counts, nested ones under their parent; picking one narrows every view to it. */
export function ScopeBar({ run, scopes, scope, onScope }: { run: RunDetail; scopes: string[]; scope: string; onScope: (s: string) => void }) {
  // Blame the agent, not the model that plays its user: the scope picked, else the one that acts.
  // Blame is scoped by the scopes the author gave, so a run with none gets no hint.
  const hint = scopeHint(run.calls, realScopes(run.calls), scope);
  return (
    <section className="scopebar">
      <span className="k">agents</span>
      <div className="chips">
        {['all', ...scopes].map((s) => (
          <button key={s} type="button" aria-pressed={scope === s} onClick={() => onScope(s)} title={s === 'all' ? undefined : s}>
            {s !== 'all' && scopeDepth(s) > 0 ? <span className="nest">↳</span> : null}
            {s === 'all' ? 'All' : scopeLeaf(s)}
            <b>{scopeCount(run.calls, s)}</b>
          </button>
        ))}
      </div>
      {hint ? (
        <span className="shint">
          {hint.lead}: <code>shadowlap blame {shortId(run.run.runId)} --scope {hint.scope}</code>
        </span>
      ) : null}
    </section>
  );
}
