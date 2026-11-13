import { Fragment, useRef } from 'react';
import type { FollowedGolden, GoldenRow } from '../api.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { Checks } from './Checks.js';
import { rowOpen } from '../components/Table.js';
import { glossed } from '../components/Term.js';
import { dotParts, RuleText } from '../components/Verdict.js';
import { changedLine, sourceText } from '../goldens.js';
import { useListKeys } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import type { TestsAnswer } from '../types.js';
import { EvidenceBar, EvidenceRow, EvidenceToggle, gated, useEvidenceOpen } from './Evidence.js';
import { ReportRow, ReportToggle, ShowEveryReport, useReportsOpen } from './Report.js';
import { HistoryCells, HistoryKey, HistoryStrip, RevisionHeads } from './History.js';
import { rowHref } from './gate.js';
import { goldenKeys, goldenRowScope } from './row-scope.js';
import type { LeadPress } from './Verdict.js';

/**
 * Tests' table: each golden with its mode and where it came from, its checks marked by how its last
 * result came out, its history and its last result, and each gate's rule stated once under it.
 */

/**
 * The goldens' table. It fits its panel at every width, as the mock's .gtw container queries fit it:
 * below 1000px of room the oldest revisions give way, below 840px the checks go under the golden's
 * name, and on a phone the revisions become a strip there too. Last result keeps its width.
 */
export function GoldensTable({ view, press }: { view: TestsAnswer; press?: LeadPress }) {
  const history = view.revisions.length > 0;
  const { open, toggle } = useEvidenceOpen(view.rows);
  // Each golden that didn't pass folds its report under its row: Show report opens it, and a gated one's evidence with it.
  const reports = useReportsOpen(view.reports);
  // j and k walk the goldens, Enter opens one's run (rowHref), ⌘K offers what its report offers.
  const table = useRef<HTMLTableElement>(null);
  const keyOf = goldenKeys(view.rows);
  const inFocus = useListKeys({
    rows: view.rows,
    keyOf,
    root: table,
    // A golden with no run leads nowhere of its own: Enter offers its actions, as ⌘K does.
    open: (r) => {
      const to = rowHref(r);
      if (!to) return false;
      navigate(to);
    },
    actions: (r) => goldenRowScope(r, () => table.current?.closest('.page') ?? document, r.path === view.verdict?.first?.golden),
  });
  return (
    <section className="panel sec gtw">
      {reports.count > 1 ? <ShowEveryReport every={reports.every} onToggle={reports.setEvery} /> : null}
      <div className="tscroll">
        <table className="t gt" ref={table}>
          <thead>
            <tr>
              <th className="gg">Golden</th>
              <th className="gck">Checks</th>
              {history ? <RevisionHeads view={view} /> : null}
              <th className="glast">Last result</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => {
              const g = row.last.gate;
              const report = view.reports?.[row.path];
              const shows = open.has(row.path) && gated(g) && !report;
              const reportShown = !!report && reports.isOpen(report.name);
              return (
                <Fragment key={row.path}>
                  <GoldenTr row={row} rowKey={keyOf(row)} focused={inFocus === keyOf(row)} showHistory={history} open={shows} onToggle={() => toggle(row.path)} now={view.following?.goldens[row.path]} report={report && { shown: reportShown, toggle: () => reports.set(report.name, !reportShown) }} />
                  {shows ? <EvidenceRow row={row} g={g} span={history ? 4 : 3} press={press} inc={view.inconclusive.find((v) => v.golden === row.path)} step={view.steps?.[row.path] ?? null} /> : null}
                  {report ? <ReportRow report={report} row={row} span={history ? 4 : 3} open={reportShown} asked={reports.asked} onOpen={() => reports.set(report.name, true)} view={view} press={press} /> : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <TableFoot rows={view.rows} history={history} />
    </section>
  );
}

/** A golden that didn't pass: its report's state and toggle. */
type ReportShown = { shown: boolean; toggle: () => void } | undefined;

function GoldenTr({ row, rowKey, focused, showHistory, open, onToggle, now, report }: { row: GoldenRow; rowKey: string; focused: boolean; showHistory: boolean; open: boolean; onToggle: () => void; now: FollowedGolden | undefined; report: ReportShown }) {
  const source = sourceText(row);
  const last = row.last;
  const stale = changedLine(row);
  const to = rowHref(row);
  return (
    <tr className={[row.runId ? '' : 'still', focused ? 'krow' : '', open ? 'open' : ''].filter(Boolean).join(' ') || undefined} data-rowkey={rowKey} {...(to ? rowOpen(() => navigate(to)) : {})}>
      <td className="gg">
        <code className="gn">{to ? <a className="rowa" href={to}>{row.name}</a> : row.name}</code>
        <span className="gmeta">
          <span className="chip" data-tip={tipCard(row.modeLabel, [], row.modeHint)}>
            {row.modeLabel}
          </span>
          {showHistory ? <HistoryStrip row={row} /> : null}
          <span className="gsrc">
            {'runId' in source ? (
              <>
                from{' '}
                <a className="dlink" href={href.run(source.runId)}>
                  <code>{source.runId.slice(0, 10)}</code>
                </a>
              </>
            ) : (
              source.text
            )}
          </span>
        </span>
        <span className="chk gin">
          <Checks row={row} cell />
        </span>
      </td>
      <td className="chk gck">
        <Checks row={row} cell />
      </td>
      {showHistory ? <HistoryCells row={row} /> : null}
      <td className="glast">
        {now ? <SessionResult now={now} /> : null}
        {/* While a session runs it: where it has got in place of the last result, whose evidence stays. */}
        <span className="glastw" hidden={!!now}>
          <LastResult row={row} />
          {last.result !== null || row.error ? (
            <span className="rsub">
              <LastLine text={last.line} />
            </span>
          ) : null}
        </span>
        {/* After the result, as the design draws it, so it stays while a session runs the golden: its checks are still untested until that result lands. */}
        {stale ? (
          <span className="ckst" data-tip={tipCard(stale.text, [], stale.why)}>
            {stale.text}
          </span>
        ) : null}
        {/* A golden with a report shows its bar alone: Show report opens its evidence with the report. */}
        {gated(last.gate) && last.gate.attempts ? report ? <EvidenceBar g={last.gate} name={row.name} /> : <EvidenceToggle g={last.gate} name={row.name} open={open} onToggle={onToggle} /> : null}
        {row.presets ? <PresetsLine p={row.presets} only={last.result === null && !row.error} /> : null}
        {/* Last, under the whole of its last result, as the mock draws it. */}
        {report ? <ReportToggle name={row.name} open={report.shown} onToggle={report.toggle} /> : null}
      </td>
    </tr>
  );
}

/** A JSON path in a line, drawn as code that may break after each of its dots. */
const JSON_PATH = /(\$\.[\w.[\]]+)/;

/** One part of the line: its JSON paths as code, the rest through the glossary. */
const partWords = (text: string) =>
  text.split(JSON_PATH).map((x, i) =>
    i % 2 ? (
      <code key={i} className="jp">
        {x.split(/(?<=\.)(?=\w)/).map((seg, j) => (
          <Fragment key={j}>
            {j ? <wbr /> : null}
            {seg}
          </Fragment>
        ))}
      </code>
    ) : (
      <Fragment key={i}>{glossed(x)}</Fragment>
    ),
  );

/**
 * The last result's line, broken only after a dot with its tally and bound kept whole, each part
 * through the glossary, so the first bound on the page is a defined term (Term decides which is first).
 */
function LastLine({ text }: { text: string }) {
  return (
    <>
      {dotParts(text, 18, 24).map((p, i) => (
        <Fragment key={i}>
          {i ? ' ' : null}
          {p.keep ? <span className={p.keep === 'whole' ? 'nw' : 'kc'}>{partWords(p.text)}</span> : partWords(p.text)}
        </Fragment>
      ))}
    </>
  );
}

/** Each state of a golden in a session that runs it: its word and tone, and when, as the mock says them. */
const SESSION_STATES: Record<FollowedGolden, [word: string, tone: string, when: string]> = {
  passed: ['passed', 'ok', 'this session, just now'],
  failed: ['failed', 'err', 'this session, just now'],
  inconclusive: ['inconclusive', 'warn', 'this session, just now'],
  running: ['running', 'live', 'this session, now'],
  // reached, its replays waiting for their turn: a session over several packs takes them in turns
  between: ['running', 'live', 'this session, in progress'],
  queued: ['queued', 'n', 'this session, next'],
};

/** Where the session that runs now is with a golden: running, queued, or its result as it landed. */
function SessionResult({ now }: { now: FollowedGolden }) {
  const [word, tone, when] = SESSION_STATES[now];
  return (
    <>
      <span className={`st ${tone}`}>
        <i />
        {word}
      </span>
      <span className="rsub">{when}</span>
    </>
  );
}

/** How the golden's last result came out, in its word and colour. */
function LastResult({ row }: { row: GoldenRow }) {
  const last = row.last;
  return last.verdict === 'inconclusive' ? (
    <span className="st warn">
      <i />
      inconclusive
    </span>
  ) : last.result === 'pass' ? (
    <span className="st ok">
      <i />
      passed
    </span>
  ) : last.result === 'fail' ? (
    <span className="st err">
      <i />
      failed
    </span>
  ) : row.error ? (
    <span className="st err">
      <i />
      can’t be read
    </span>
  ) : row.presets ? (
    // Tested by its error-path presets, its replay not yet: never "not run yet".
    <span className={`st ${presetTone(row.presets)}`}>
      <i />
      presets {row.presets.verdict}
    </span>
  ) : (
    <span className="st n">not run yet</span>
  );
}

type Presets = NonNullable<GoldenRow['presets']>;

/** A golden's presets in the consequence colours: failed red, inconclusive amber, passed quiet. */
const presetTone = (p: Presets) => (p.verdict === 'failed' ? 'err' : p.verdict === 'inconclusive' ? 'warn' : 'ok');

/**
 * How a golden's error-path presets came out, under its last result, opening the attempt that failed
 * (or couldn't say): the whole line when they are all that ran, else in short with the line on hover.
 */
function PresetsLine({ p, only }: { p: Presets; only: boolean }) {
  const count = p.verdict === 'failed' ? p.failed : p.verdict === 'inconclusive' ? p.inconclusive : p.passed;
  const text = only ? `${p.line} · replay not tested yet` : `presets · ${count} of ${p.ran} ${p.verdict}`;
  return p.runId ? (
    <a className={`rsub gpre ${presetTone(p)}`} href={href.run(p.runId)} data-tip={only ? undefined : tipText(p.line)} onClick={(e) => e.stopPropagation()}>
      {text}
    </a>
  ) : (
    <span className={`rsub gpre ${presetTone(p)}`} data-tip={only ? undefined : tipText(p.line)}>
      {text}
    </span>
  );
}

/** A rule's card: where its link goes. */
export const RULE_TIP = tipCard('What this gate takes', [], 'its figures, the attempts they take and the odds of each verdict, on Settings → CI');

/**
 * Under the table: the key to By revision's cells, then each gate's rule, stated once for every
 * golden it decided (decision 9), beside the mode its goldens show: no row repeats it. Where two
 * rules share a mode (two goldens' gates with different limits), each names the goldens it decided,
 * so "up to 12 attempts" says whose it is. A rule opens Settings → CI's Gates on its gate's kind.
 */
function TableFoot({ rows, history }: { rows: readonly GoldenRow[]; history: boolean }) {
  const rules = new Map<string, { mode: string; kind: 'sprt' | 'baseline'; names: string[] }>();
  for (const r of rows) {
    const gate = r.last.gate;
    if (!gate?.rule) continue;
    const kept = rules.get(gate.rule);
    if (kept) kept.names.push(r.name);
    else rules.set(gate.rule, { mode: r.modeLabel, kind: gate.kind, names: [r.name] });
  }
  const key = history ? <HistoryKey rows={rows} /> : null;
  if (!rules.size && !key) return null;
  const modes = [...rules.values()].map((x) => x.mode);
  const shared = (mode: string) => modes.filter((m) => m === mode).length > 1;
  return (
    <div className="gfoot">
      {key}
      {[...rules].map(([rule, { mode, kind, names }]) => (
        <p key={rule}>
          <span className="chip">{mode}</span>
          <span>
            {shared(mode) ? <b className="gnames">{`${names.join(', ')}: `}</b> : null}
            <a className="dlink" href={href.settings('ci', { gate: kind })} data-tip={RULE_TIP}>
              <RuleText rule={rule} />
            </a>
          </span>
        </p>
      ))}
    </div>
  );
}
