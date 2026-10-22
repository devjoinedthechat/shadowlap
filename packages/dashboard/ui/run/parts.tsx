import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { wholeInput } from '../../../engine/src/tokens.js';
import { JOB_KINDS, type BlameView, type CheckView, type RunDetail, type RunOffers } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { TestsJobButton } from '../fixes/TestsJobButton.js';
import { callName, clip, glued, jsonText, num, shortId } from '../format.js';
import { countOrigins } from '../origins.js';
import { NormalizeUpdateDialog } from '../pages/TestsDialogs.js';
import { href } from '../route.js';
import { runType } from '../runs.js';
import { scopeCount, scopeDepth, scopeHint, scopeLeaf } from '../scopes.js';
import { useApp } from '../state.js';
import type { PendingAction } from './actions.js';
import { bannerFor, DIVERGED } from './banner.js';
import { refusedOffline } from './calls.js';
import { metricItems, type MetricInput } from './metrics.js';
import { originOf, pulledSpender, runLikeOf } from './model.js';
import { blameOfferFor, blameTitle, divergedActions, goldenName, updateGoldenCopy } from './offers.js';
import { UpdateGoldenDialog } from './RunDialogs.js';

/** The run page while its run loads (a run of 50,000 calls takes seconds): it says so, and is busy for a screen reader. */
export function RunLoading() {
  return (
    <div className="rv loading" aria-busy="true">
      <div className="empty tall">Loading the run…</div>
    </div>
  );
}

/** The run's numbers: the counts lead; what replaying saved comes last, as a quieter receipt. */
export function Metrics({ run, notWaitedMs, notWaitedUnknown }: { run: RunDetail; notWaitedMs: number | null; notWaitedUnknown: number }) {
  const s = run.summary;
  const items = metricItems({
    total: s.total,
    byKind: s.byKind,
    upstreamRequests: s.upstreamRequests,
    cost: s.cost,
    tokensNotRespent: wholeInput(s.tokensNotRespent),
    counts: countOrigins(run.calls.map(originOf)),
    capture: runType(runLikeOf(run)) === 'capture',
    toolsCaptured: toolsCaptured(run),
    ...spentBy(run),
    live: run.run.status === 'running',
    notWaitedMs,
    refused: run.calls.filter((c) => c.outcome === 'error' && refusedOffline(c)).length,
  });
  return (
    <section className="metrics" title={notWaitedUnknown ? `${notWaitedUnknown} replayed calls’ recorded durations were not found` : undefined}>
      {items.map(([v, label, cls], i) => (
        <span className="metric" key={i}>
          <b className={cls || undefined}>{typeof v === 'number' ? num(v) : v}</b>
          <span title={label}>{label}</span>
        </span>
      ))}
    </section>
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
 * One line: the explanation gives way first, a whole part (between its " · ") at a time, the rest
 * said by " · …" and shown in full on hover; a part too long alone is cut with "…". The flag that
 * made a fork, when it is part of the line, is set as code.
 */
function Why({ children, code }: { children: string; code?: string | readonly string[] | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const parts = children.split(' · ');
  // How many parts the line shows: all of them, until it is measured too long for its room.
  const [fit, setFit] = useState({ text: children, count: parts.length });
  const count = fit.text === children ? fit.count : parts.length;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.title = children;
    if (count > 1 && el.scrollWidth > el.clientWidth + 1) setFit({ text: children, count: count - 1 });
  });
  // A room that grows may take the parts back: the line is measured again from the whole of it.
  useLayoutEffect(() => {
    const room = ref.current?.parentElement;
    if (!room || typeof ResizeObserver === 'undefined') return;
    let width = room.clientWidth;
    const watch = new ResizeObserver(() => {
      if (room.clientWidth === width) return;
      width = room.clientWidth;
      setFit({ text: children, count: children.split(' · ').length });
    });
    watch.observe(room);
    return () => watch.disconnect();
  }, [children]);
  const text = count < parts.length ? `${parts.slice(0, count).join(' · ')} · …` : children;
  return (
    <span className="why" ref={ref}>
      {codeParts(text, typeof code === 'string' ? [code] : (code ?? [])).map((p, i) => (typeof p === 'string' ? glued(p) : <code key={i}>{p.code}</code>))}
    </span>
  );
}

/** A one-line JSON value with a place to break after each comma, for a pane that wraps it (a narrow window's). */
function breakable(text: string): ReactNode[] {
  const parts = text.split(',');
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [`${part},`, <wbr key={i} />] : [part]));
}

/** A line split around the names in it that read as code (a flag, a tool, a host), each at its first place after the one before. */
function codeParts(text: string, codes: readonly string[]): Array<string | { code: string }> {
  const out: Array<string | { code: string }> = [];
  let from = 0;
  for (const c of codes) {
    const at = c ? text.indexOf(c, from) : -1;
    if (at < 0) continue;
    if (at > from) out.push(text.slice(from, at));
    out.push({ code: c });
    from = at + c.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

export interface BannerProps {
  run: RunDetail;
  blame: BlameView | null;
  rescued: { callNo: number | null } | null;
  checks: CheckView[];
  /** What the page offers beyond the run's record: Run blame, the diverged test's actions. */
  offers: RunOffers | null;
  showDiff: boolean;
  onToggleDiff: () => void;
  onSelect: (n: number) => void;
  onAction: (p: PendingAction) => void;
}

/** The run's one banner: recording now, how it forked, where it was lost, what was not recorded, its checks, or that it failed. */
export function Banner({ run, blame, rescued, checks, offers, showDiff, onToggleDiff, onSelect, onAction }: BannerProps) {
  const app = useApp();
  const [dialog, setDialog] = useState<'update' | 'normalize' | null>(null);
  const r = run.run;
  const iv = run.intervention ?? null;
  const flagRow = iv?.callNo ? run.calls.find((c) => c.callNo === iv.callNo) : undefined;
  const test = offers?.test ?? null;
  const b = bannerFor({
    status: r.status,
    type: runType(runLikeOf(run)),
    divergence: r.divergence,
    intervention: iv,
    interventions: run.interventions ?? [],
    flagCall: flagRow ? { kind: flagRow.kind, name: flagRow.name, attempts: flagRow.attempts, ...(flagRow.input ? { input: true } : {}) } : null,
    rescued,
    blame,
    notRecorded: run.notRecorded ?? null,
    checks,
    fix: run.fix ?? null,
    upstreamRequests: run.summary.upstreamRequests,
    volatile: test?.volatile ?? null,
    modelCalls: run.summary.byKind.api,
    // How it came out, as Runs and the Overview have it.
    ...(run.state ? { outcome: run.state.outcome, interrupted: run.state.interrupted, failed: run.state.failed } : {}),
    calls: run.calls,
    callCount: run.calls.length,
  });
  if (!b) return null;
  const job = (kind: string, fields: Record<string, unknown>) => app.guard(() => app.watchJob(app.client.startJob(kind, fields)));
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
  const off = app.actionsOff;
  // Run blame: the fixes' blame job, which finds the check the run failed (asking when nothing names
  // it) and ends with a link to the fix. Not for a run blame has been run on already, nor in a copy.
  const runBlame = (blamed: boolean) => {
    if (blamed || app.exported) return null;
    const offer = blameOfferFor(offers, {
      blamed,
      capture: !!run.source,
      argv: r.command.argv,
      status: r.status,
      failed: checks.filter((c) => !c.ok).map((c) => c.label),
      fixExpect: run.blameExpect,
      ownExpect: r.meta?.expect,
      modelCalls: run.summary.byKind.api,
    });
    // The server picks the check, as the CLI judges the run; disabled with why on a read-only dashboard or while a repair holds the tree.
    return offer ? <RunBlameButton runId={r.runId} failed={offer.failed} title={blameTitle(offer)} /> : null;
  };
  const fixLink = (step?: string) =>
    run.fix ? (
      <a className="more" href={run.fix.href ?? href.fixes(run.fix.id, step ?? null)}>
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
    case 'diverged': {
      // A test replay: Add normalizer adds the rule and runs its golden again, Update golden re-records
      // it; each is the tests' job. When the rule alone can't make the replay match, the job updates
      // the golden after it, live, so it asks first in the Tests screen's dialog. A server without the
      // jobs falls back to the run's own normalizer action. Once the rule is in the config, the banner
      // says so and links the replay that passed.
      const normalizer = run.actions.find((a) => a.key === 'n');
      const acts = divergedActions({ test, hasNormalizeJob: app.hasKind(JOB_KINDS.normalizeAndTest), hasUpdateJob: app.hasKind(JOB_KINDS.testUpdate), action: !!normalizer, actionsOff: off });
      const add = acts.normalizer;
      const addNormalizer = () => job(JOB_KINDS.normalizeAndTest, { runId: r.runId });
      return (
        <section className="banner blame">
          <span className="bk">diverged at</span>
          {call(b.callNo)}
          <code>{r.divergence?.name ?? ''}</code>
          <Why>{b.why}</Why>
          {b.path ? <span className="path">~ {test?.volatile?.path ?? test?.cause ?? b.path}</span> : null}
          <span className="end">
            {add?.kind === 'added' ? (
              <>
                <span className="st ok">
                  <i />
                  normalizer added
                </span>
                {add.passingRun ? (
                  <a className="more" href={href.run(add.passingRun)}>
                    Passing run →
                  </a>
                ) : null}
              </>
            ) : add?.kind === 'job' ? (
              <TestsJobButton className={`btn sm${add.lead ? ' lime' : ''}`} verb="add the normalizer" off={add.off} title={add.title} onClick={() => (add.asks ? app.guard(() => setDialog('normalize')) : addNormalizer())}>
                {add.label}
              </TestsJobButton>
            ) : add?.kind === 'action' && normalizer ? (
              <button className="btn sm lime" type="button" disabled={!!normalizer.disabled} onClick={() => onAction({ action: normalizer, callNo: null })}>
                Add normalizer
              </button>
            ) : null}
            {acts.update ? (
              <TestsJobButton className="btn sm" verb="update it" off={off} onClick={() => app.guard(() => setDialog('update'))}>
                Update golden
              </TestsJobButton>
            ) : null}
            {b.diff ? diffToggle : null}
          </span>
          {dialog === 'update' && test ? (
            <UpdateGoldenDialog
              golden={test.golden}
              copy={updateGoldenCopy(test, b.callNo, add?.kind === 'job', checks.length)}
              onAddNormalizer={() => {
                setDialog(null);
                addNormalizer();
              }}
              onClose={() => setDialog(null)}
              onOk={() => {
                setDialog(null);
                job(JOB_KINDS.testUpdate, { golden: test.golden });
              }}
            />
          ) : null}
          {dialog === 'normalize' && test && add?.kind === 'job' && add.asks ? (
            <NormalizeUpdateDialog
              name={goldenName(test.golden)}
              steps={add.asks}
              onClose={() => setDialog(null)}
              onRun={() => {
                setDialog(null);
                addNormalizer();
              }}
            />
          ) : null}
        </section>
      );
    }
    case 'fork': {
      const normalizer = run.actions.find((a) => a.key === 'n');
      return (
        <section className="banner fork">
          <span className="bk">forked at</span>
          {call(b.callNo)}
          <code>{b.name}</code>
          <Why code={b.flag}>{b.why}</Why>
          {b.path ? <span className="path">~ {b.path}</span> : null}
          <span className="end">
            {b.normalizer && normalizer && !off ? (
              <button className="btn sm lime" type="button" disabled={!!normalizer.disabled} onClick={() => onAction({ action: normalizer, callNo: null })}>
                Add normalizer
              </button>
            ) : null}
            {b.diff ? diffToggle : null}
            {/* A fork that failed is blamed as any failed run is: its fix, or Run blame. */}
            {b.failed ? (run.fix ? fixLink() : runBlame(!!blame)) : null}
          </span>
        </section>
      );
    }
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
          <Why code={[...(run.notRecorded?.tools ?? []), ...(run.notRecorded?.hosts ?? []).map((h) => h.target)]}>{b.why}</Why>
        </section>
      );
    case 'interrupted':
      return (
        <section className="banner n">
          <span className="bk">interrupted</span>
          <Why>{b.why}</Why>
        </section>
      );
    case 'checks':
      return (
        <section className="banner live">
          <span className="bk">checks</span>
          {b.checks.map((c) => (
            <span className={`st ${c.status === 'not-applicable' ? 'n' : c.status === 'inconclusive' ? 'warn' : 'ok'}`} key={c.label}>
              <i />
              {c.text}
            </span>
          ))}
          {b.why ? <Why>{b.why}</Why> : null}
        </section>
      );
    case 'failed': {
      const blameButton = b.fix ? null : runBlame(b.blamed);
      return (
        <section className="banner blame">
          <span className="bk">failed</span>
          <Why>{b.why}</Why>
          {b.fix ? <span className="end">{fixLink()}</span> : blameButton ? <span className="end">{blameButton}</span> : null}
        </section>
      );
    }
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
