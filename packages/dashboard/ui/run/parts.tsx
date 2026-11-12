import { useMemo, useState } from 'react';
import { JUDGE_SCOPE } from '../../../engine/src/judge-scope.js';
import { wholeInput } from '../../../engine/src/tokens.js';
import type { RunDetail } from '../api.js';
import { injectionFactOf } from '../injection/model.js';
import type { RunInjection } from '../types.js';
import { num, shortId } from '../format.js';
import { countOrigins, parseOrigins } from '../origins.js';
import { href } from '../route.js';
import { outcomeOf, runType, TODAY } from '../runs.js';
import { PageHeader } from '../components/bits.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { Page } from '../components/Page.js';
import { Skeleton } from '../components/States.js';
import { Status } from '../components/Status.js';
import { useLoad } from '../hooks.js';
import { realScopes, scopeCount, scopeDepth, scopeHint, scopeLeaf } from '../scopes.js';
import { useApp } from '../state.js';
import type { PresetAttempt } from './preset.js';
import { attemptOutcome } from './banner.js';
import { refusedOffline } from './calls.js';
import { metricItems, outcomeFact, spentWords, toolsToCheck, type MetricInput, type OutcomeFact } from './metrics.js';
import { attemptOf, checksOf, originOf, pulledSpender, runLikeOf } from './model.js';

/** What the run page's first calls are drawn as while they load: a call's name, as long as a name runs. */
const SKEL_CALLS = ['model call', 'search_orders', 'model call', 'get_customer', 'model call', 'update_ticket', 'model call', 'send_reply'];

/**
 * The run page while its run loads (a run of 50,000 calls takes seconds): its header, then the strip
 * at its height and the first calls in their places as quiet bars, busy for a screen reader. The bars
 * wear classes of their own, never the drawn run's (`.rhead .rnm`, `table.calls tbody tr[data-wi]`),
 * which the tests read as the run drawn. The project's name comes from the page, which has the app.
 */
export function RunLoading({ id, project }: { id: string; project: string | undefined }) {
  return (
    <Page busy>
      <RunHead id={id} project={project} />
      <Skeleton what="the run">
        <div className="rskstrip" />
        {SKEL_CALLS.map((name, i) => (
          <p className="rskcall" key={i}>
            <span>{i + 1}</span>
            <b>{name}</b>
            <span>1,204</span>
            <span>0.8 s</span>
          </p>
        ))}
      </Skeleton>
    </Page>
  );
}

/**
 * The run page's header before its run has come, loading or failed: `<project> · run` over the id,
 * in the code face. lazy.tsx's PageFailed draws a run page whose code didn't come with the same one.
 */
export function RunHead({ id, project }: { id: string; project: string | undefined }) {
  return <PageHeader eyebrow={project ? `${project} · run` : 'run'} title={shortId(id)} className="rerr" />;
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

/** The card a status's checks give (outcome-card.ts), loaded once the pointer or the focus first reached a status, for every run page after. */
let cards: typeof import('../outcome-card.js') | null = null;

/**
 * The run's first fact: its status, a dot and its verdict's word, the call it turned on as a link,
 * by today's checks after it; what judged it on hover, and to a screen reader the check it names. The
 * card its checks give loads as the pointer or the focus reaches the status, ahead of the card, which
 * says the status's words until it has come.
 */
function Outcome({ fact, runId }: { fact: OutcomeFact; runId: string }) {
  const [, loaded] = useState(cards);
  const t = cards ? cards.factCard(fact) : fact.tip;
  const load = fact.card && !cards ? () => void import('../outcome-card.js').then((m) => loaded((cards = m))) : undefined;
  const tip = t ? tipCard(t.title, t.rows.map(([label, value, color]) => ({ label, value, color })), t.sub) : fact.card ? tipText(fact.words) : undefined;
  return (
    <span className="metric rout" onPointerEnter={load} onFocus={load}>
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
        {fact.said ? <span className="sr">: {fact.said}</span> : null}
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

/**
 * Scopes as chips with counts, nested ones under their parent; picking one narrows every view to it.
 * The first, All, counts the agent's calls alone, and reads Agent where the run names no agents of
 * its own (`scopes` empty); a judge's calls (`judge`, how many) follow the agents' after a hairline,
 * under a chip of their own, as the design draws them.
 */
export function ScopeBar({ run, scopes, scope, judge, onScope }: { run: RunDetail; scopes: string[]; scope: string; judge: number; onScope: (s: string) => void }) {
  // Blame the agent, not the model that plays its user: the scope picked, else the one that acts.
  // Blame is scoped by the scopes the author gave, so a run with none gets no hint: a judged one says
  // what its judge's calls count towards.
  const hint = scopeHint(run.calls, realScopes(run.calls), scope);
  const chip = (s: string, label: string, n: number, title?: string) => (
    <button key={s} type="button" aria-pressed={scope === s} onClick={() => onScope(s)} title={title}>
      {s !== 'all' && scopeDepth(s) > 0 ? <span className="nest">↳</span> : null}
      {label}
      <b>{n}</b>
    </button>
  );
  return (
    <section className="scopebar">
      <span className="k">agents</span>
      <div className="chips">
        {chip('all', scopes.length ? 'All' : 'Agent', scopeCount(run.calls, 'all'))}
        {scopes.map((s) => chip(s, scopeLeaf(s), scopeCount(run.calls, s), s))}
        {judge ? <span className="jsep" aria-hidden="true" /> : null}
        {judge ? chip(JUDGE_SCOPE, 'judge', judge, `${JUDGE_SCOPE}: the judge’s calls, kept apart from the agent’s`) : null}
      </div>
      {hint ? (
        <span className="shint">
          {hint.lead}: <code>shadowlap blame {shortId(run.run.runId)} --scope {hint.scope}</code>
        </span>
      ) : judge ? (
        <span className="shint">A judge’s calls are the check’s: no count, budget or cost of the agent’s includes them</span>
      ) : null}
    </section>
  );
}
