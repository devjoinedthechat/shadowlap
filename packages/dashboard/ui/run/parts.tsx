import { useLayoutEffect, useRef, useState } from 'react';
import { JOB_KINDS, type BlameOffer, type BlameView, type CheckView, type RunDetail, type RunOffers } from '../api.js';
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
import { blameCommand, blameSource } from './offers.js';
import { BlameDialog, UpdateGoldenDialog } from './RunDialogs.js';

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

/**
 * One line: the explanation gives way first, cut with "…" and shown in full on hover. The flag that
 * made a fork, when it is part of the line, is set as code.
 */
function Why({ children, code }: { children: string; code?: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.title = el.textContent ?? '';
  });
  const at = code ? children.indexOf(code) : -1;
  return (
    <span className="why" ref={ref}>
      {at < 0 || !code ? (
        children
      ) : (
        <>
          {children.slice(0, at)}
          <code>{code}</code>
          {children.slice(at + code.length)}
        </>
      )}
    </span>
  );
}

export interface BannerProps {
  run: RunDetail;
  blame: BlameView | null;
  rescued: { callNo: number | null } | null;
  checks: CheckView[];
  /** What the page offers beyond the run's record: Run blame's check, the diverged test's actions. */
  offers: RunOffers | null;
  showDiff: boolean;
  onToggleDiff: () => void;
  onSelect: (n: number) => void;
  onAction: (p: PendingAction) => void;
}

/** The run's one banner: recording now, how it forked, where it was lost, what was not recorded, its checks, or that it failed. */
export function Banner({ run, blame, rescued, checks, offers, showDiff, onToggleDiff, onSelect, onAction }: BannerProps) {
  const app = useApp();
  const [dialog, setDialog] = useState<'blame' | 'update' | null>(null);
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
      // it; each is the tests' job. A server without them falls back to the run's own normalizer action.
      const normalizer = run.actions.find((a) => a.key === 'n');
      const canNormalize = !!test?.normalizeAndTest && app.hasKind(JOB_KINDS.normalizeAndTest);
      const canUpdate = !!test && app.hasKind(JOB_KINDS.testUpdate);
      // An id that may be a real change: neither button leads.
      const lead = test ? test.normalizerFixes && !test.maybeReal : true;
      return (
        <section className="banner blame">
          <span className="bk">diverged at</span>
          {call(b.callNo)}
          <code>{r.divergence?.name ?? ''}</code>
          <Why>{b.why}</Why>
          {b.path ? <span className="path">~ {test?.volatile?.path ?? b.path}</span> : null}
          <span className="end">
            {canNormalize ? (
              <button className={`btn sm${lead ? ' lime' : ''}`} type="button" disabled={!!off} title={off ?? test!.volatile?.command} onClick={() => job(JOB_KINDS.normalizeAndTest, { runId: r.runId })}>
                Add normalizer
              </button>
            ) : normalizer && !off ? (
              <button className="btn sm lime" type="button" disabled={!!normalizer.disabled} onClick={() => onAction({ action: normalizer, callNo: null })}>
                Add normalizer
              </button>
            ) : null}
            {canUpdate ? (
              <button className="btn sm" type="button" disabled={!!off} title={off ?? undefined} onClick={() => setDialog('update')}>
                Update golden
              </button>
            ) : null}
            {b.diff ? diffToggle : null}
          </span>
          {dialog === 'update' && test ? (
            <UpdateGoldenDialog
              golden={test.golden}
              normalizer={!!test.volatile?.certain}
              onClose={() => setDialog(null)}
              onOk={() => {
                setDialog(null);
                job(JOB_KINDS.testUpdate, { golden: test.golden });
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
    case 'failed': {
      // Run blame: with the check the run failed, or on the exit status; asking for the check when
      // nothing names it. The fixes' blame job runs it and ends with a link to the fix.
      const offer = offers?.blame ?? (offers ? null : legacyBlameOffer(run, b.blamed));
      const canBlame = app.hasKind(JOB_KINDS.blame);
      const blameIt = () => {
        if (!offer) return;
        if (offer.from === 'ask') return setDialog('blame');
        job(JOB_KINDS.blame, { runId: r.runId, expect: offer.expect ?? null });
      };
      return (
        <section className="banner blame">
          <span className="bk">failed</span>
          <Why>{b.why}</Why>
          {b.fix ? (
            <span className="end">{fixLink()}</span>
          ) : !b.blamed && offer && !app.exported ? (
            <span className="end">
              <button
                className="linkbtn"
                type="button"
                disabled={!canBlame || !!off}
                title={off ?? (canBlame ? `${blameCommand(r.runId, offer.from === 'ask' ? '…' : offer.expect)} · ${blameSource(offer)}` : `This dashboard can’t run blame: ${blameCommand(r.runId, offer.from === 'ask' ? '…' : offer.expect)}`)}
                onClick={() => app.guard(blameIt)}
              >
                Run blame
              </button>
            </span>
          ) : null}
          {dialog === 'blame' && offer ? (
            <BlameDialog
              runId={r.runId}
              offer={offer}
              onClose={() => setDialog(null)}
              onRun={(expect) => {
                setDialog(null);
                job(JOB_KINDS.blame, { runId: r.runId, expect });
              }}
            />
          ) : null}
        </section>
      );
    }
  }
}

/**
 * Run blame on a server that says nothing of it: the check the fix's labels suggest, else blame on the
 * exit status when the agent failed, else ask.
 */
function legacyBlameOffer(run: RunDetail, blamed: boolean): BlameOffer | null {
  if (blamed || !run.run.command.argv.length) return null;
  const failed = (run.checks ?? []).filter((c) => !c.ok).map((c) => c.label);
  if (run.blameExpect !== undefined && run.blameExpect !== null) return { from: 'fix', expect: run.blameExpect, failed };
  const own = run.run.meta?.expect;
  if (failed.length && own && typeof own === 'object') return { from: 'run', expect: own, failed };
  if (failed.length) return { from: 'ask', failed };
  return run.run.status === 'failed' || run.run.status === 'crashed' ? { from: 'exit', expect: null, failed } : null;
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
