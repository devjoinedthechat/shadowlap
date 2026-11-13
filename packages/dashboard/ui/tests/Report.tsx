import { useCallback, useEffect, useRef, useState } from 'react';
import { issueKey } from '../../src/issue-keys.js';
import { CopyButton } from '../components/CodeBox.js';
import { Code, Copy, Words } from '../components/Copy.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { failedRunsWords } from '../failed-runs.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { plural, shortId } from '../format.js';
import { issueClick } from '../runspage/open-issue.js';
import { useApp } from '../state.js';
import type { GoldenReport, GoldenRow, Piece, ReportLine, TestsAnswer } from '../types.js';
import { gated, ReportEvidence } from './Evidence.js';
import { drawsFindCommit } from './lead.js';
import { ReportParts } from './ReportParts.js';
import { ReportSteps } from './ReportSteps.js';
import { openReports, reportOpen, setAttemptsShown, setReportOpen, shownAttempts, useAskedReport } from './report-open.js';
import { reportHint } from './report-words.js';
import { partId, useUntilFound } from './until-found.js';
import type { LeadPress } from './Verdict.js';

/**
 * A golden's report on Tests, drawn under its row, the table's full width: folded behind Show
 * report under its last result, hidden until found (find in page opens the one it matches), opened
 * by a link to it (`#/tests?report=<name>`), and kept open while the dashboard is, so Esc's way back
 * from a link inside it finds that link. Its verdict in one sentence, its parts, its next steps and
 * hint, and Show as printed, the lines `shadowlap test` prints, with Copy report. Esc folds none.
 */

/** Which reports are open, kept while the dashboard is (report-open.ts); dropped for a golden that no longer has one. */
export function useReportsOpen(reports: TestsAnswer['reports']) {
  const [, setTick] = useState(0);
  const redraw = useCallback(() => setTick((n) => n + 1), []);
  const [asked, setAsked] = useState<{ name: string } | null>(null);
  const names = reports ? Object.values(reports).map((r) => r.name) : null;
  const key = names ? names.join('\n') : null;
  useEffect(() => {
    if (key === null) return;
    const have = new Set(key.split('\n'));
    for (const n of openReports()) if (!have.has(n)) setReportOpen(n, false);
    for (const n of shownAttempts()) if (!have.has(n)) setAttemptsShown(n, false);
  }, [key]);
  useAskedReport(
    useCallback(
      (name: string) => {
        setAsked({ name });
        redraw();
      },
      [redraw],
    ),
  );
  const set = (name: string, on: boolean) => {
    setReportOpen(name, on);
    redraw();
  };
  const every = !!names?.length && names.every(reportOpen);
  const setEvery = (on: boolean) => {
    for (const n of names ?? []) setReportOpen(n, on);
    redraw();
  };
  return { isOpen: reportOpen, set, asked, every, setEvery, count: names?.length ?? 0 };
}

/** Over the table, with two reports or more: opens or folds them all, the focus staying on it. */
export function ShowEveryReport({ every, onToggle }: { every: boolean; onToggle: (on: boolean) => void }) {
  return (
    <div className="gtop">
      <button type="button" className="linkbtn" aria-expanded={every} onClick={() => onToggle(!every)}>
        {every ? 'Hide every report' : 'Show every report'}
      </button>
    </div>
  );
}

/** Under a golden's last result: the toggle of its report, keeping the focus as it opens. */
export function ReportToggle({ name, open, onToggle }: { name: string; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="gev grptog" aria-expanded={open} aria-controls={partId('grp', name)} onClick={onToggle}>
      {open ? 'Hide report' : 'Show report'}
      <Icon name="caret" className="cr" />
    </button>
  );
}

/**
 * The report's row, under its golden's: no row key of its own, so j and k, ⌘K on a row and Esc's
 * way back skip it. A gated golden's evidence opens with it, above it.
 */
export function ReportRow({ report, row, span, open, asked, onOpen, view, press }: { report: GoldenReport; row: GoldenRow; span: number; open: boolean; asked: { name: string } | null; onOpen: () => void; view: TestsAnswer; press: LeadPress | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  useUntilFound(box, !open, onOpen);
  const g = gated(row.last.gate) && row.last.gate.attempts ? row.last.gate : null;
  return (
    <tr className={`sub grprow still${open ? '' : ' shut'}`}>
      <td colSpan={span}>
        <div className="grpw" id={partId('grp', report.name)} ref={box}>
          {g ? <ReportEvidence g={g} /> : null}
          <ReportPanel report={report} row={row} open={open} asked={asked?.name === report.name ? asked : null} onOpen={onOpen} view={view} press={press} />
        </div>
      </td>
    </tr>
  );
}

function ReportPanel({ report, row, open, asked, onOpen, view, press }: { report: GoldenReport; row: GoldenRow; open: boolean; asked: { name: string } | null; onOpen: () => void; view: TestsAnswer; press: LeadPress | undefined }) {
  const section = useRef<HTMLElement>(null);
  // A link that asked for it: in view once it is open.
  useEffect(() => {
    if (asked) section.current?.scrollIntoView({ block: 'start' });
  }, [asked]);
  const { hasKind } = useApp();
  const hint = reportHint(report, { findsCommit: !!press && drawsFindCommit(view, report.golden, hasKind) });
  return (
    <section className="panel sec gpanel" id={`report-${report.name}`} ref={section}>
      <header>
        <h2>
          <code>{report.name}</code>
        </h2>
        <span className="sp" />
        <ReportLinks report={report} />
      </header>
      <VerdictLine report word={report.verdict} tone={report.verdict === 'failed' ? 'err' : 'warn'} facts={report.sub.length ? report.sub.join(' · ') : undefined}>
        <Head pieces={report.head} />
      </VerdictLine>
      <ReportParts report={report} row={row} open={open} />
      {press ? <ReportSteps report={report} view={view} press={press} onPress={onOpen} /> : null}
      {hint ? <Copy className="hintx">{hint}</Copy> : null}
      <Printed name={report.name} lines={report.printed} />
    </section>
  );
}

/** The verdict's sentence, glued as a verdict's words are (a count with its noun), its paths, checks and files as code. */
function Head({ pieces }: { pieces: readonly Piece[] }) {
  return <>{pieces.map((p, i) => (typeof p === 'string' ? <Words key={i}>{p}</Words> : <Code key={i}>{p.code}</Code>))}</>;
}

/**
 * The header's links, kept together: Failed runs → on Runs, then the run the result is (Open run, Open
 * failing attempt, Open proof). Failed runs →, pressed or Entered, opens the golden's issue there.
 */
function ReportLinks({ report }: { report: GoldenReport }) {
  const f = report.failedRuns;
  if (!f && !report.open) return null;
  return (
    <span className="glinks">
      {f ? (
        <a className="more" href={f.href} data-tip={tipCard(plural(f.count, 'failed replay'), [], failedRunsWords(f.ids.map(shortId), f.count))} onClick={issueClick(issueKey.golden(report.golden))}>
          Failed runs →
        </a>
      ) : null}
      {report.open ? (
        <a className="more" href={report.open.href}>
          {report.open.label}
        </a>
      ) : null}
    </span>
  );
}

/** Show as printed: the lines `shadowlap test` prints, folded until found, one Tab stop, with the box's one Copy in its corner. */
function Printed({ name, lines }: { name: string; lines: readonly ReportLine[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useUntilFound(box, !open, () => setOpen(true));
  const id = partId('rpp', name);
  return (
    <div className="rpp">
      <button type="button" className="linkbtn rptog" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? 'Hide as printed' : 'Show as printed'}
        <Icon name="caret" />
      </button>
      <div className="boxwrap rbox" id={id} ref={box}>
        <pre className="report" tabIndex={0} role="log" aria-live="off" aria-label={`${name} as printed`}>
          {lines.map((l, i) => (
            <span key={i} className={l.tone || undefined}>
              {l.text}
              {i < lines.length - 1 ? '\n' : ''}
            </span>
          ))}
        </pre>
        <CopyButton text={lines.map((l) => l.text).join('\n')} className="boxcopy" name="Copy report" label="the report">
          {null}
        </CopyButton>
      </div>
    </div>
  );
}
