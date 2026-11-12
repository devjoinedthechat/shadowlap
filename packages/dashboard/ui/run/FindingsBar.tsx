import { Fragment, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import type { BlameView, CheckView, RunDetail, RunOffers } from '../api.js';
import type { NextStepKey } from '../../src/next-step.js';
import type { ForkDifferences as Differences } from '../../src/fork-differences.js';
import type { RunInjection, TestBannerOffer } from '../types.js';
import { ActionButton } from '../components/ActionButton.js';
import { LoadFailed } from '../components/bits.js';
import { onShow } from '../components/OnShow.js';
import { Icon } from '../components/Icon.js';
import { glossed } from '../components/Term.js';
import { firstWords } from '../outcome-tip.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { TestsJobButton } from '../fixes/TestsJobButton.js';
import { glued, GLUED_SEPARATOR, wholeTallies } from '../format.js';
import { useLoad } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { href } from '../route.js';
import { fixedByWords, runType } from '../runs.js';
import { shortcut } from '../shortcuts.js';
import { useApp } from '../state.js';
import type { PendingAction } from './actions.js';
import { findingPath, notRecordedBanner, ownBanner, type Banner as BannerView, type BannerInput } from './banner.js';
import { bannerCards, bannerJobsShown, useDivergedJobs } from './diverged.js';
import { goldenPrice, useTestsEstimates } from '../tests-estimates.js';
import { bannerSeverity, runFindings, SEVERITY_COLOURS, type Finding } from './findings.js';
import { attemptLinks, attemptOf, runLikeOf } from './model.js';
import { fixStatusWords, nextStepOf } from './next-step.js';
import type { RunNote } from './notes.js';
import { blameTitle, goldenName } from './offers.js';
import type { PresetAttempt } from './preset.js';
import { NoteFinding } from './RunNotes.js';
import type { ProofTab } from '../injection/Proof.js';
import { useServedParts } from '../served-parts.js';
import { openResults } from './panel-state.js';
import type { InjectionFinding as InjectionFindingView } from '../injection/model.js';
import { warmDiff } from './InspectorPanel.js';

/**
 * What a run's page found, as one bar under its header (findings.ts): the most telling finding whole,
 * on its line, and `N findings` at its end opening the others in place under it, a line each, with a
 * card that lists them while it is closed. A note's tools and hint, and the fork's changes, show
 * under their line once it is open; a lone finding with those opens them with `Details`. Whether a
 * run's bar is open is kept for the session.
 */

/**
 * One line: the explanation gives way first, a whole part (between its " · ") at a time, the rest
 * said by " · …" and shown in full on hover; a part too long alone is cut with "…". The flag that
 * made a fork, when it is part of the line, is set as code. A lead, what the outcome stands on, comes
 * first in ink and never gives way.
 */
function Why({ children, code, lead, gloss }: { children: string; code?: string | readonly string[] | null; lead?: string | undefined; gloss?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const parts = children.split(' · ');
  // How many parts the line shows: all of them, until it is measured too long for its room.
  const [fit, setFit] = useState({ text: children, count: parts.length });
  const count = fit.text === children ? fit.count : parts.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- measured after every render, as its room can change without its text; it only ever gives up a part, so it stops
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.title = lead ? `${lead} · ${children}` : children;
    if (count > (lead ? 0 : 1) && el.scrollWidth > el.clientWidth + 1) setFit({ text: children, count: count - 1 });
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
  const text = count < parts.length ? [...parts.slice(0, count), '…'].join(' · ') : children;
  return (
    <span className="why" ref={ref}>
      {lead ? (
        <>
          <span className="lead">{said(lead, code, gloss)}</span>
          {GLUED_SEPARATOR}
        </>
      ) : null}
      {said(text, code, gloss)}
    </span>
  );
}

/**
 * A line as the banner sets it: wrapping only after a separator, never before its dot nor inside a
 * tally (`5 of 5`), with the flag
 * in it set as code, and where asked the glossary's words in it marked (`lost`, `stubbed`, `fenced`).
 */
function said(text: string, code?: string | readonly string[] | null, gloss = false): ReactNode[] {
  return codeParts(text, typeof code === 'string' ? [code] : (code ?? [])).map((p, i) =>
    typeof p !== 'string' ? <code key={i}>{p.code}</code> : gloss ? <Fragment key={i}>{glossed(glued(wholeTallies(p)))}</Fragment> : glued(wholeTallies(p)),
  );
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
  /** The run's verdict by checks (useJudgedAt): a capture its import judged failed is a failed finding. */
  judged?: RunDetail['judged'];
  blame: BlameView | null;
  rescued: { callNo: number | null } | null;
  checks: CheckView[];
  /** What the page offers beyond the run's record: Run blame, the diverged test's actions. */
  offers: RunOffers | null;
  showDiff: boolean;
  onToggleDiff: () => void;
  onSelect: (n: number) => void;
  onAction: (p: PendingAction) => void;
  /** An error-path preset's attempt: the preset and its verdict, from its recording's presets. */
  preset?: PresetAttempt | null;
  /** The call `n` jumps to where it is the fork or the lost call, and its card. */
  jump?: { n: number; card: string } | null;
  /** An injection test's replay: what was planted where, and its proof, once the read of it comes (none in a copy). */
  attempt?: RunInjection['attempt'];
  /** A call a proof names, picked on the inspector's tab that shows it. */
  onPick?: (n: number, tab: ProofTab) => void;
}

/**
 * Words that name calls, as the engine's lostWords says where a run was lost (`lost at #5`, `lost
 * gradually around #5 and #7`, `lost between #7 and #9`): what comes before the first call is the
 * banner's label, and each call a button that selects it.
 */
function CallWords({ words, call }: { words: string; call: (n: number) => ReactNode }) {
  const [label = '', ...rest] = words.split(/(#\d+)/);
  return (
    <>
      <span className="bk">{glossed(label.trim())}</span>
      <span>{rest.map((part, i) => (/^#\d+$/.test(part) ? <Fragment key={i}>{call(Number(part.slice(1)))}</Fragment> : part))}</span>
    </>
  );
}

/** What `n` jumps to says so on the banner's call that shows it: a card that says its key and goes with it. */
function jumpMark(n: number, jump: { n: number; card: string } | null | undefined) {
  const mark = jump?.n === n ? shortcut('jump') : {};
  return mark['aria-keyshortcuts'] ? { ...mark, 'data-tip': tipText(jump!.card) } : undefined;
}

/** What drawing a finding needs from the page: the run, what it offers, and what the header leads with. */
interface Draw {
  run: RunDetail;
  test: TestBannerOffer | null;
  offers: RunOffers | null;
  leads: (key: NextStepKey) => boolean;
  /** The header's bisect step has Run blame beside it. */
  blameBeside: boolean;
  checks: number;
  off: boolean;
  call: (n: number) => ReactNode;
  diffToggle: ReactNode;
  onAction: (p: PendingAction) => void;
  attempt: RunInjection['attempt'];
  pick: (n: number, tab: ProofTab) => void;
}

/** Where a finding sits in the bar: one a closed bar folds away (`fx`), and the bar's toggle at its end (`more`). */
interface Slot {
  fx: boolean;
  more: ReactNode;
}

type Of<K extends BannerView['kind']> = Extract<BannerView, { kind: K }>;

const cls = (c: string, s: Slot) => `banner ${c}${s.fx ? ' fx' : ''}`;

/**
 * The run's record as banner.ts reads it, how it came out as Runs and the Overview have it: failed as
 * Runs counts it (`runLikeOf`), and a failed test replay its golden passed since fixed by that run.
 */
function bannerInput(run: RunDetail, p: Pick<BannerProps, 'blame' | 'rescued' | 'checks' | 'preset' | 'judged' | 'offers'>, test: TestBannerOffer | null): BannerInput {
  const r = run.run;
  const like = runLikeOf(run);
  const iv = run.intervention ?? null;
  const flagRow = iv?.callNo ? run.calls.find((c) => c.callNo === iv.callNo) : undefined;
  return {
    status: r.status,
    type: runType(like),
    divergence: r.divergence,
    intervention: iv,
    interventions: run.interventions ?? [],
    flagCall: flagRow ? { kind: flagRow.kind, name: flagRow.name, attempts: flagRow.attempts, ...(flagRow.input ? { input: true } : {}) } : null,
    rescued: p.rescued,
    blame: p.blame,
    notRecorded: run.notRecorded ?? null,
    checks: p.checks,
    fix: run.fix ?? null,
    upstreamRequests: run.summary.upstreamRequests,
    spent: run.summary.cost.spent,
    crash: p.offers?.crash ?? null,
    judged: p.judged?.by === 'import' && p.judged.verdict === 'failed' ? firstWords(p.judged) : null,
    volatile: test?.volatile ?? null,
    modelCalls: run.summary.byKind.api,
    ...(run.state ? { outcome: run.state.outcome, interrupted: run.state.interrupted, failed: like.failed === true } : {}),
    fixedBy: run.fixedBy ?? null,
    calls: run.calls,
    callCount: run.calls.length,
    attempt: attemptOf(run),
    codeVersion: r.codeVersion,
    preset: p.preset ?? null,
    injection: r.meta?.injection ?? null,
  };
}

/**
 * Run blame: the fixes' blame job, which finds the check the run failed (asking when nothing names
 * it) and ends with a link to the fix. Not for a run blame has been run on already, nor in a copy,
 * nor where the header has it, as its next step or beside a crash's. The server picks the check, as
 * the CLI judges the run; it waits with why on a read-only dashboard or while a repair holds the tree.
 */
function runBlame(x: Draw): ReactNode {
  const offer = x.offers?.blame ?? null;
  if (x.leads('blame') || x.blameBeside || !offer) return null;
  return <RunBlameButton runId={x.run.run.runId} offer={offer} title={blameTitle(offer)} />;
}

/** The fix, linked; where the header opens it already, how it stands instead (open, verified). */
function fixLink(x: Draw, step?: string): ReactNode {
  const fix = x.run.fix;
  if (!fix) return null;
  if (x.leads('fix')) {
    const st = fixStatusWords(fix.status);
    return (
      <span className={`st ${st.tone}`} title={`“${fix.title}” is ${st.why}`}>
        <i />
        {st.text}
      </span>
    );
  }
  return (
    <a className="more" href={fix.href ?? href.fixes(fix.id, step ?? null)}>
      Fix →
    </a>
  );
}

function RecordingFinding({ s }: { s: Slot }) {
  return (
    <section className={cls('live', s)}>
      <span className="dotlive" />
      <span className="bk">recording</span>
      <Why>calls arrive as they happen · replay and fork once it finishes</Why>
      {s.more}
    </section>
  );
}

/**
 * An error-path preset's attempt: where it forked, then what was done; the first fact says its verdict.
 * It wraps rather than cut its words; a golden's leads back to its presets on Tests.
 */
function PresetFinding({ b, x, s }: { b: Of<'preset'>; x: Draw; s: Slot }) {
  return (
    <section className={cls('fork wrap', s)}>
      <span className="bk">forked at</span>
      {b.callNo !== null ? x.call(b.callNo) : null}
      {/* A tally never breaks inside: "attempt 1 of 6". */}
      <span className="why">{wholeTallies(b.why)}</span>
      {b.golden ? (
        <span className="end">
          <a className="more" href={href.tests()} title={`${goldenName(b.golden)} on Tests`}>
            Tests →
          </a>
        </span>
      ) : null}
      {s.more}
    </section>
  );
}

/**
 * An attempt, as the design draws every one: what was asked again with which attempt it is, and the
 * writes (the first fact says how it came out); the whole line wraps rather than cut a word.
 * Then the way back to where it counted (its probe, its verdict) and to its bundle; the fork blame
 * rescued a run with leads to its fix.
 */
function AttemptFinding({ b, x, s }: { b: Of<'attempt'>; x: Draw; s: Slot }) {
  const a = attemptOf(x.run);
  const links = b.of === 'rescued' ? [] : a ? attemptLinks(x.run, a) : [];
  return (
    <section className={cls('fork wrap', s)}>
      <span className="bk">{b.callNo !== null ? 'forked at' : 'replayed'}</span>
      {b.callNo !== null ? x.call(b.callNo) : null}
      <span className="why">{said(b.why, b.flag, true)}</span>
      <span className="end">
        {b.diff ? x.diffToggle : null}
        {b.of === 'rescued' ? fixLink(x, 'blame') : null}
        {links.map((l) => (
          <a key={l.label} className="more" href={l.href}>
            {l.label}
          </a>
        ))}
      </span>
      {s.more}
    </section>
  );
}

/**
 * An injection test's replay, as the design draws every attempt: what was planted where, with which
 * attempt, and the writes. Then the way back to the run tested, its results open (a clean attempt's
 * to the answer it counts in), and an attempt's proof, the line that joins the read to the write.
 * The way back and the proof wait for the read of what was planted, so a copy, which answers it
 * empty, draws neither.
 */
function InjectionAttemptFinding({ b, x, s }: { b: Of<'injection-attempt'>; x: Draw; s: Slot }) {
  const tested = x.attempt ? x.run.run.parentRunId : null;
  // Handed in where the dashboard runs, its script loaded as it first shows: a copy has no attempt's read, so no proof.
  const { Proof } = useServedParts();
  return (
    <section className={cls('fork wrap', s)}>
      <span className="bk">forked at</span>
      {b.callNo !== null ? x.call(b.callNo) : null}
      <span className="why">{said(b.why, null, true)}</span>
      {tested ? (
        <span className="end">
          <a className="more" href={href.run(tested)} onClick={b.role === 'clean' ? undefined : () => openResults(tested, `injection:${b.result}`)}>
            {b.role === 'clean' ? 'The answer →' : 'Results →'}
          </a>
        </span>
      ) : null}
      {x.attempt?.parts && Proof ? <Proof parts={x.attempt.parts} why={b.proofWhy} onPick={x.pick} /> : null}
      {s.more}
    </section>
  );
}

/** A fork: where, on what, the flag that made it or what changed, its path; a fork that failed is blamed as any failed run is: its fix, or Run blame. */
function ForkFinding({ b, x, s }: { b: Of<'fork'>; x: Draw; s: Slot }) {
  const normalizer = x.run.actions.find((a) => a.key === 'n');
  return (
    <section className={cls('fork', s)}>
      <span className="bk">forked at</span>
      {x.call(b.callNo)}
      <code>{b.name}</code>
      <Why code={b.flag}>{b.why}</Why>
      {b.path ? <span className="path">~ {b.path}</span> : null}
      <span className="end">
        {b.normalizer && normalizer && !x.off && !x.leads('rule') ? (
          <ActionButton className="btn sm" why={normalizer.disabled} onClick={() => x.onAction({ action: normalizer, callNo: null })}>
            {ACTIONS.addNormalizer.label}
          </ActionButton>
        ) : null}
        {b.diff ? x.diffToggle : null}
        {b.failed ? (x.run.fix ? fixLink(x) : runBlame(x)) : null}
      </span>
      {s.more}
    </section>
  );
}

function LostFinding({ b, x, s }: { b: Of<'lost'>; x: Draw; s: Slot }) {
  return (
    <section className={cls('blame', s)}>
      <CallWords words={b.words} call={x.call} />
      <Why>{b.why}</Why>
      <span className="end">
        {b.rescuedRunId ? (
          <a className="more" href={href.run(b.rescuedRunId)}>
            Rescued fork →
          </a>
        ) : null}
        {fixLink(x, 'blame')}
      </span>
      {s.more}
    </section>
  );
}

function NotRecordedFinding({ b, x, s }: { b: Of<'not-recorded'>; x: Draw; s: Slot }) {
  const nr = x.run.notRecorded;
  return (
    <section className={cls('blame', s)}>
      <span className="bk">not recorded</span>
      <Why code={[...(nr?.tools ?? []), ...(nr?.hosts ?? []).map((h) => h.target)]}>{b.why}</Why>
      {s.more}
    </section>
  );
}

function InterruptedFinding({ b, s }: { b: Of<'interrupted'>; s: Slot }) {
  return (
    <section className={cls('n', s)}>
      <span className="bk">interrupted</span>
      <Why>{b.why}</Why>
      {s.more}
    </section>
  );
}

function ChecksFinding({ b, s }: { b: Of<'checks'>; s: Slot }) {
  return (
    <section className={cls(bannerSeverity(b) === 1 ? 'inc ck' : 'live ck', s)}>
      <span className="bk">checks</span>
      {b.checks.map((c) => (
        <span className={`st ${c.status === 'not-applicable' ? 'n' : c.status === 'inconclusive' ? 'warn' : 'ok'}`} key={c.label}>
          <i />
          {glued(wholeTallies(c.text))}
        </span>
      ))}
      {b.why ? <Why gloss>{b.why}</Why> : null}
      {s.more}
    </section>
  );
}

/** Its weight's colour: amber to look at, muted for a test replay its golden passed since, else red. */
const failedTone = (b: Of<'failed'>): string => (bannerSeverity(b) === 1 ? 'inc' : b.fixedBy ? 'n' : 'blame');

function FailedFinding({ b, x, s }: { b: Of<'failed'>; x: Draw; s: Slot }) {
  const end = b.fix ? fixLink(x) : b.blamed ? null : runBlame(x);
  return (
    <section className={cls(failedTone(b), s)}>
      {b.label ? <span className="bk">{b.label}</span> : null}
      <Why lead={b.lead}>{b.why}</Why>
      {end ? <span className="end">{end}</span> : null}
      {s.more}
    </section>
  );
}

/** A banner of the run's, drawn as its kind is. */
function BannerFinding({ b, x, s }: { b: BannerView; x: Draw; s: Slot }) {
  switch (b.kind) {
    case 'recording':
      return <RecordingFinding s={s} />;
    case 'preset':
      return <PresetFinding b={b} x={x} s={s} />;
    case 'diverged':
      return <DivergedFinding b={b} x={x} s={s} />;
    case 'attempt':
      return <AttemptFinding b={b} x={x} s={s} />;
    case 'injection-attempt':
      return <InjectionAttemptFinding b={b} x={x} s={s} />;
    case 'fork':
      return <ForkFinding b={b} x={x} s={s} />;
    case 'lost':
      return <LostFinding b={b} x={x} s={s} />;
    case 'not-recorded':
      return <NotRecordedFinding b={b} x={x} s={s} />;
    case 'interrupted':
      return <InterruptedFinding b={b} s={s} />;
    case 'checks':
      return <ChecksFinding b={b} s={s} />;
    case 'failed':
      return <FailedFinding b={b} x={x} s={s} />;
  }
}

/** The page's part in drawing a finding: what the header leads with, the calls a finding names, and Show diff. */
function useDraw(p: BannerProps, test: TestBannerOffer | null): Draw {
  const app = useApp();
  // The header leads with the run's next step; a finding doesn't offer it again.
  const next = nextStepOf(p.run);
  const call = (n: number) => (
    <button className="bn" type="button" onClick={() => p.onSelect(n)} {...jumpMark(n, p.jump)}>
      #{n}
    </button>
  );
  // The pointer or the focus on Show diff asks for its scripts and its answer, so it opens at once.
  const warm = () => warmDiff(app.client, p.run.run.runId, p.run.run.status === 'running');
  const diffToggle = (
    <button className="linkbtn" type="button" data-act="diff" onClick={p.onToggleDiff} onPointerEnter={warm} onFocus={warm}>
      {p.showDiff ? 'Hide diff' : 'Show diff'}
    </button>
  );
  return { run: p.run, test, offers: p.offers, leads: (key) => next?.key === key, blameBeside: next?.key === 'bisect' && !!next.blame, checks: p.checks.length, off: !!app.actionsOff, call, diffToggle, onAction: p.onAction, attempt: p.attempt ?? null, pick: p.onPick ?? p.onSelect };
}

/**
 * What a fork did differently from its parent, a finding of a fork's page alone: a part of its own
 * (OnShow.tsx), asked for as the differences are, so the two come together.
 */
const DifferencesPanel = onShow(() => import('./ForkDifferences.js').then((m) => m.DifferencesPanel), { failed: <LoadFailed what="finding" /> });

/** What the fork did differently, read once `want` says the run is a fork that has ended; null until it comes, or with none to say. */
function useForkDifferences(runId: string, want: boolean): Differences | null {
  const { client } = useApp();
  const load = () => {
    if (!want) return null;
    DifferencesPanel.preload();
    return client.forkDifferences(runId);
  };
  return useLoad(load, `differences:${runId}:${want ? 'fork' : 'none'}`).data;
}

/** What a fork did differently alone, read from the server as the bar reads it: for tests. */
export function ForkDifferences({ runId }: { runId: string }) {
  const d = useForkDifferences(runId, true);
  return d ? <DifferencesPanel d={d} /> : null;
}

/** Which runs' bars are open, by run, for the session: a module's memory, as the inspector's last tab is. */
const opened = new Map<string, boolean>();

/** Every bar closed again, for tests. */
export function forgetOpenFindings(): void {
  opened.clear();
}

/**
 * `N findings` (or `Details` for a lone finding with more under it), opening the rest in place; while
 * closed, a card lists the others, each in its weight's colour. The focus stays on it as it opens.
 */
function MoreToggle({ findings, open, onToggle }: { findings: readonly Finding[]; open: boolean; onToggle: () => void }) {
  const rest = findings.slice(1);
  const tip = rest.length && !open ? tipCard('Also found', rest.map((f) => ({ label: f.says, value: '', color: SEVERITY_COLOURS[f.sev] }))) : undefined;
  return (
    <button className="linkbtn fmore" type="button" data-act="findings" aria-expanded={open} aria-controls="findings" data-tip={tip} onClick={onToggle}>
      {rest.length ? `${findings.length} findings` : 'Details'}
      <Icon name="caret" className="caret" />
    </button>
  );
}

/** A finding, as its kind draws it. */
function FindingView({ f, x, s, onSelect }: { f: Finding; x: Draw; s: Slot; onSelect: (n: number) => void }) {
  // A kept injection test's finding is handed in where the dashboard runs: a copy keeps no results to draw one from.
  const { InjectionFinding } = useServedParts();
  if (f.banner) return <BannerFinding b={f.banner} x={x} s={s} />;
  if (f.note) return <NoteFinding n={f.note} fx={s.fx} more={s.more} onSelect={onSelect} />;
  if (f.injection) return InjectionFinding ? <InjectionFinding runId={x.run.run.runId} f={f.injection} fx={s.fx} more={s.more} /> : null;
  return f.differences ? <DifferencesPanel d={f.differences} fx={s.fx} more={s.more} /> : null;
}

/** The bar, from the findings the page has: drawn by FindingsBar, and alone by Banner. */
function Findings(p: BannerProps & { notes: readonly RunNote[]; differences: Differences | null; injection?: InjectionFindingView | null }) {
  const runId = p.run.run.runId;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const next = nextStepOf(p.run);
  const test = p.offers?.test ?? (next?.key === 'normalizer' || next?.key === 'update-golden' ? next.test : null);
  const x = useDraw(p, test);
  const input = bannerInput(p.run, p, test);
  const findings = runFindings({ own: ownBanner(input), differences: p.differences, notRecorded: notRecordedBanner(input), notes: p.notes, injection: p.injection });
  if (!findings.length) return null;
  const open = opened.get(runId) ?? false;
  const toggle = () => {
    opened.set(runId, !open);
    redraw();
  };
  const more = findings.length > 1 || findings[0]!.body ? <MoreToggle findings={findings} open={open} onToggle={toggle} /> : null;
  return (
    <div className={`findings${open ? ' open' : ''}`} id="findings">
      {findings.map((f, i) => (
        <FindingView key={f.key} f={f} x={x} s={{ fx: i > 0, more: i === 0 ? more : null }} onSelect={p.onSelect} />
      ))}
    </div>
  );
}

/**
 * The run's findings under its header: its own, what its fork did differently from its parent (read
 * once it has ended), what it did not record, its notes, and the injection test kept for it.
 */
export function FindingsBar(p: BannerProps & { notes: readonly RunNote[]; injection?: InjectionFindingView | null }) {
  const r = p.run.run;
  const differences = useForkDifferences(r.runId, !!r.divergence && !!r.parentRunId && r.status !== 'running');
  return <Findings {...p} differences={differences} />;
}

/** The run's own finding and what it did not record, as the bar draws them, without the page's other findings: for tests. */
export function Banner(p: BannerProps) {
  return <Findings {...p} notes={NO_NOTES} differences={null} />;
}

const NO_NOTES: readonly RunNote[] = [];

/**
 * A diverged test's jobs on its finding, priced where one of its buttons shows: each card says it,
 * and each job keeps it. None is read for a test replay its golden passed since, which offers none.
 */
function useFindingJobs(x: Draw, fixed: boolean) {
  const app = useApp();
  const { run, test, leads } = x;
  const golden = test?.golden ?? null;
  const prices = useTestsEstimates(!fixed && bannerJobsShown(app, run, test, leads) ? golden : null);
  const jobs = useDivergedJobs(run, test, x.checks, golden ? { normalize: goldenPrice(prices, golden, 'normalize'), update: goldenPrice(prices, golden, 'update') } : {});
  return { jobs, cards: bannerCards(test, jobs.acts.normalizer) };
}

/** Its rule is in the config: that, and the replay that passed, where the header doesn't lead with it. */
function NormalizerAdded({ passingRun, leads }: { passingRun: string | null; leads: Draw['leads'] }) {
  return (
    <>
      <span className="st ok">
        <i />
        normalizer added
      </span>
      {passingRun && !leads('passing') ? (
        <a className="more" href={href.run(passingRun)}>
          Passing run →
        </a>
      ) : null}
    </>
  );
}

/**
 * A test that diverged: what the value that changed looks like or why it came, in ink (the outcome
 * says where), on what, its path, and its golden's jobs (useDivergedJobs) where the header doesn't
 * lead with them. Once the rule is in the config, the finding says so and links the replay that passed.
 */
function DivergedFinding({ b, x, s }: { b: Of<'diverged'>; x: Draw; s: Slot }) {
  const { run, test, leads, onAction } = x;
  const app = useApp();
  const { jobs, cards } = useFindingJobs(x, !!b.fixedBy);
  const normalizer = run.actions.find((a) => a.key === 'n');
  // A test replay its golden passed since says so after what it diverged on, muted, and offers nothing to mend it.
  const add = b.fixedBy && jobs.acts.normalizer?.kind !== 'added' ? null : jobs.acts.normalizer;
  return (
    <section className={cls(b.fixedBy ? 'n' : 'blame', s)}>
      <Why lead={b.lead} code={b.name}>{[...(b.fixedBy ? [fixedByWords(b.fixedBy)] : []), b.name, b.why].join(' · ')}</Why>
      {b.path ? <span className="path">~ {findingPath(b, test)}</span> : null}
      <span className="end">
        {add?.kind === 'added' ? (
          <NormalizerAdded passingRun={add.passingRun} leads={leads} />
        ) : add?.kind === 'job' && !leads('normalizer') ? (
          <TestsJobButton className="btn sm" verb="add the normalizer" off={add.off} card={cards.normalize} estimate={jobs.prices.normalize} onClick={jobs.normalize}>
            {add.label}
          </TestsJobButton>
        ) : add?.kind === 'action' && normalizer && !leads('normalizer') ? (
          <ActionButton className="btn sm" why={normalizer.disabled} onClick={() => onAction({ action: normalizer, callNo: null })}>
            {ACTIONS.addNormalizer.label}
          </ActionButton>
        ) : null}
        {jobs.acts.update && !b.fixedBy && !leads('update-golden') ? (
          <TestsJobButton className="btn sm" verb="update it" off={app.actionsOff} card={cards.update} estimate={jobs.prices.update} onClick={jobs.update}>
            {ACTIONS.updateGolden.label}
          </TestsJobButton>
        ) : null}
        {b.diff ? x.diffToggle : null}
      </span>
      {s.more}
      {jobs.dialogs}
    </section>
  );
}
