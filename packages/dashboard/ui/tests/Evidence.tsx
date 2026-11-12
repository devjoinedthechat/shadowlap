import { useEffect, useState } from 'react';
import type { GoldenRow, InconclusiveView } from '../api.js';
import { AttemptList } from '../components/AttemptsCell.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { JobButton } from '../components/JobButton.js';
import { ErrorState, Skeleton } from '../components/States.js';
import { glossed } from '../components/Term.js';
import { IntervalBar } from '../components/Verdict.js';
import { pageUp } from '../focus-manager.js';
import { useLatest, useLoad } from '../hooks.js';
import { moreCard, testsJob } from '../pages/tests-cards.js';
import { useApp } from '../state.js';
import { goldenPrice } from '../tests-estimates.js';
import type { EvidenceWords, NextStep } from '../types.js';
import type { LeadPress } from './Verdict.js';

/** A golden's last gate, where it decided the result. */
export type GateShown = NonNullable<GoldenRow['last']['gate']>;

/** A gate decided it from its attempts (not a clean replay's one, which is the same every time): its line is a tally and a bound. */
export const gated = (g: GoldenRow['last']['gate']): g is GateShown => !!g && !g.clean;

/** Two places, as a rate reads beside a bar: `.70`. */
const rate2 = (x: number) => x.toFixed(2).replace(/^0(?=\.)/, '');

/** The id of a golden's evidence, which its toggle controls and a job's end can hand the focus to. */
const evidenceId = (name: string) => `ev-${name.replace(/[^\w-]/g, '-')}`;

/** The verdict's colour on the bar and the line's last point. */
const toneOf = (d: GateShown['decision']) => (d === 'pass' ? 'ok' : d === 'inconclusive' ? 'y' : 'no');

/**
 * Under a gated golden's line, its interval bar against the gate's two rates, or against the
 * baseline and the drop that fails it, in the verdict's colour: the toggle of the row under it that
 * says why the gate stopped where it did. Its hover says what the line shows, in the gate's figures.
 */
export function EvidenceToggle({ g, name, open, onToggle }: { g: GateShown; name: string; open: boolean; onToggle: () => void }) {
  const baseline = g.kind === 'baseline' && g.evidence.kind === 'baseline' ? { at: g.evidence.baseline, drop: g.drop } : null;
  const marks = g.kind === 'sprt' ? [g.bad, g.good] : baseline ? [baseline.at - baseline.drop, baseline.at] : [];
  const w = g.words;
  const id = evidenceId(name);
  // The bar is a picture: these words are what the button shows, and its name holds them.
  const against = g.kind === 'sprt' ? `against ${rate2(g.bad)} and ${rate2(g.good)}` : 'against its baseline';
  return (
    <button
      type="button"
      className="gev"
      data-ev={id}
      aria-expanded={open}
      {...(open ? { 'aria-controls': id } : {})}
      aria-label={`${open ? 'Hide' : 'Show'} why it stopped at attempt ${g.attempts}, ${against}`}
      data-tip={w ? tipCard(`${name} · ${w.head}`, w.row ? [{ label: w.row[0], value: w.row[1], color: 'var(--faint)' }] : [], w.tip) : undefined}
      onClick={onToggle}
    >
      <IntervalBar lo={g.interval.lo} hi={g.interval.hi} marks={marks} tone={toneOf(g.decision)} />
      <small>{against}</small>
      <Icon name="caret" className="cr" />
    </button>
  );
}

/**
 * Which goldens' evidence is open: kept while the view reloads (a job's drawer closing leaves it
 * open), dropped for a golden no longer gated. Esc closes all of it before anything else on the
 * page, and a focus inside an open row goes back to that row's toggle.
 */
export function useEvidenceOpen(rows: readonly GoldenRow[]): { open: ReadonlySet<string>; toggle: (path: string) => void } {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const open = picked.size ? new Set([...picked].filter((p) => rows.some((r) => r.path === p && gated(r.last.gate) && r.last.gate.attempts))) : picked;
  const now = useLatest(open);
  useEffect(() => {
    pageUp.current = () => {
      if (!now.current.size) return false;
      const inside = document.activeElement?.closest('section.gevx');
      if (inside) [...document.querySelectorAll<HTMLElement>('button.gev')].find((b) => b.getAttribute('data-ev') === inside.id)?.focus();
      setPicked(new Set());
      return true;
    };
    return () => {
      pageUp.current = null;
    };
  }, [now]);
  const toggle = (path: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return { open, toggle };
}

/** The line's points, in attempts and the gate's own units: the score after each attempt from 0, or the chance of a drop from the gate's first decision. */
interface LinePlot {
  x0: number;
  n: number;
  pts: Array<[number, number]>;
  /** Attempts that failed, a red dot each; those the provider cut short, amber (never the agent's failure). */
  fails: number[];
  cuts: number[];
  hi: number;
  lo: number;
  zero: boolean;
  /** A history gate's few points, each a dot and its value, on a taller plot. */
  dots: boolean;
  carried: number;
}

/** The plot of a gate's evidence from what its result kept (`evidence`, `outcomes`); null before a history gate decides anything. */
export function linePlot(g: GateShown): LinePlot | null {
  const n = g.attempts;
  const cut = new Set((g.unavailableAt ?? []).map((i) => i + 1));
  const fails = g.outcomes.flatMap((ok, i) => (ok || cut.has(i + 1) ? [] : [i + 1]));
  if (g.evidence.kind === 'sprt') {
    const e = g.evidence;
    return { x0: 0, n, pts: [[0, 0], ...e.scores.map((v, i): [number, number] => [i + 1, v])], fails, cuts: [...cut], hi: e.upper, lo: e.lower, zero: true, dots: false, carried: g.carried ?? 0 };
  }
  const e = g.evidence;
  const first = e.probabilities.findIndex((p) => p !== null);
  if (first < 0) return null;
  const from = first + 1;
  const pts = e.probabilities.slice(first).map((v, k): [number, number] => [from + k, v ?? 0]);
  return { x0: from < n ? from : n - 1, n, pts, fails: fails.filter((i) => i >= from), cuts: [...cut].filter((i) => i >= from), hi: e.threshold, lo: e.passAt, zero: false, dots: pts.length <= 12, carried: 0 };
}

/**
 * The line, drawn to the width it gets: the SVG stretches (its strokes don't), and the dots and
 * labels are placed by percentage, so they stay round and readable at any width. Each bound is
 * labelled with what crossing it does, outside the plot; the last point takes the verdict's colour.
 */
function EvidenceLine({ p, w, tone }: { p: LinePlot; w: EvidenceWords; tone: 'ok' | 'y' | 'no' }) {
  const ys = p.pts.map(([, v]) => v);
  const [hi, lo] = [Math.max(p.hi, ...ys), Math.min(p.lo, ...ys)];
  const [top, bot] = [hi + (hi - lo) * 0.1, lo - (hi - lo) * 0.1];
  const X = (i: number) => (100 * (i - p.x0)) / (p.n - p.x0 || 1);
  const Y = (v: number) => (100 * (top - v)) / (top - bot || 1);
  const at = (i: number, v: number) => ({ left: `${X(i).toFixed(2)}%`, top: `${Y(v).toFixed(2)}%` });
  const byN = new Map(p.pts);
  const mark = (i: number) => (p.fails.includes(i) ? 'no' : p.cuts.includes(i) ? 'y' : 'pt');
  const dots = p.dots ? p.pts.slice(0, -1).map(([i]) => i) : [...p.fails, ...p.cuts].filter((i) => byN.has(i));
  const last = p.pts[p.pts.length - 1]!;
  const hline = (v: number, cls: string) => <line className={cls} x1="0" x2="1000" y1={Y(v).toFixed(2)} y2={Y(v).toFixed(2)} vectorEffect="non-scaling-stroke" />;
  // each value under its dot, clear of the line; over it at or past the bound it fails above, or close over the one it passes at
  const value = ([i, v]: [number, number], k: number) => {
    const up = v >= p.hi || v <= p.lo + 0.15 * (top - bot);
    return (
      <span key={`v${i}`} className={`ev${up ? ' up' : ''}${k === p.pts.length - 1 ? ' r' : k === 0 ? ' l' : ''}`} style={at(i, v)}>
        {v.toFixed(2)}
      </span>
    );
  };
  return (
    <div className={`evw${p.dots ? ' tall' : ''}${p.carried ? ' carried' : ''}`}>
      <div className="evl" role="img" aria-label={w.why}>
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
          {hline(p.hi, 'bd')}
          {hline(p.lo, 'bd')}
          {p.zero ? hline(0, 'z') : null}
          <polyline className="pl" points={p.pts.map(([i, v]) => `${(X(i) * 10).toFixed(1)},${Y(v).toFixed(2)}`).join(' ')} vectorEffect="non-scaling-stroke" />
        </svg>
        {p.carried ? (
          <span className="evc" style={{ left: `${X(p.carried).toFixed(2)}%` }}>
            <span className="l">{p.carried} carried over</span>
            <span className="r">this session</span>
          </span>
        ) : null}
        {dots.map((i) => (
          <i key={i} className={`ed ${mark(i)}`} style={at(i, byN.get(i)!)} />
        ))}
        <i className={`ed end ${tone}`} style={at(last[0], last[1])} />
        {p.dots ? p.pts.map(value) : null}
        <span className="eb" style={{ top: `${Y(p.hi).toFixed(2)}%` }}>
          {w.hiLabel}
        </span>
        <span className="eb" style={{ top: `${Y(p.lo).toFixed(2)}%` }}>
          {w.loLabel}
        </span>
      </div>
      <div className="evx">
        {w.start ? <span>{w.start}</span> : null}
        <span className="r">{w.end}</span>
      </div>
    </div>
  );
}

/** The attempts, each judged from its run, read when the row opens (and again when the golden's result changes); a stand-in client without the read draws none. */
function Attempts({ golden, at }: { golden: string; at: number | null }) {
  const { client } = useApp();
  const loaded = useLoad(() => (client.testEvidence ? client.testEvidence(golden) : null), `tests-evidence:${golden}`, at);
  if (!client.testEvidence) return null;
  if (loaded.error) return <ErrorState retry={loaded.reload}>Its attempts couldn’t be read: {loaded.error.message}</ErrorState>;
  if (!loaded.data) return <Skeleton what="the attempts" lines={2} />;
  const { attempts, gone } = loaded.data;
  if (!attempts.length) return <p className="muted">The attempts aren’t in the store any more.</p>;
  return (
    <>
      <AttemptList attempts={attempts} />
      {gone ? <p className="muted">{gone === 1 ? 'One of its attempts isn’t' : `${gone} of its attempts aren’t`} in the store any more.</p> : null}
    </>
  );
}

/**
 * The row under a gated golden: why its gate stopped where it did, the line between its bounds, its
 * attempts, what each attempt weighs, and for an inconclusive gate, its step, plain: Run more
 * attempts, or Run tests where its checks changed since (`step`, the server's), as more attempts
 * would judge checks the config no longer holds. A part of the page of its own (a `section` with an
 * id), so a job's end can hand the focus to it.
 */
export function EvidenceRow({ row, g, span, press, inc, step }: { row: GoldenRow; g: GateShown; span: number; press: LeadPress | undefined; inc: InconclusiveView | undefined; step: NextStep | null }) {
  const w = g.words;
  const plot = linePlot(g);
  const stale = inc && step?.key === 'run-tests' ? step : null;
  const more = stale ? null : inc?.gate?.more;
  return (
    <tr className="sub gevrow still">
      <td colSpan={span}>
        <section className="gevx" id={evidenceId(row.name)} aria-label={`Why ${row.name} stopped where it did`}>
          {w ? (
            <p className="lead">
              {w.why}
              {w.carriedNote}
            </p>
          ) : null}
          {w && plot ? <EvidenceLine p={plot} w={w} tone={toneOf(g.decision)} /> : null}
          <Attempts golden={row.path} at={row.last.at} />
          {w ? <p className="receipt">{glossed([w.step, w.passK ? `pass^5 ${w.passK}` : '', w.forked, w.provider].filter(Boolean).join(' · '))}</p> : null}
          {stale && press?.runTests ? (
            <div className="actions gevact">
              <JobButton className="btn" why={press.wait('run the tests')} {...press.runTests} sub={stale.sub}>
                {stale.label}
              </JobButton>
            </div>
          ) : null}
          {more && inc && press ? (
            <div className="actions gevact">
              <JobButton className="btn" why={press.wait('run the tests')} {...testsJob(moreCard(more), goldenPrice(press.prices, inc.golden, 'more'), (e) => press.onMore(inc, e))}>
                Run more attempts
              </JobButton>
            </div>
          ) : null}
        </section>
      </td>
    </tr>
  );
}
