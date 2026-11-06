import type { GoldenRow, TestsView } from '../api.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { rowOpen } from '../components/Table.js';
import { DotLine, RuleText } from '../components/Verdict.js';
import { glued } from '../format.js';
import { checkMark, sourceText } from '../goldens.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { GateEvidence, gated } from './Evidence.js';
import { HistoryCells, HistoryKey, HistoryStrip, RevisionHeads } from './History.js';

/**
 * Tests' table: each golden with its mode and where it came from, its checks marked by how its last
 * result came out, its history and its last result, and each gate's rule stated once under it.
 */

/**
 * The goldens' table. It fits its panel at every width, as the mock's .gtw container queries fit it:
 * below 1000px of room the oldest revisions give way, below 820px the checks go under the golden's
 * name, and on a phone the revisions become a strip there too. Last result keeps its width.
 */
export function GoldensTable({ view }: { view: TestsView }) {
  const history = view.revisions.length > 0;
  return (
    <section className="panel sec gtw">
      <div className="tscroll">
        <table className="t gt">
          <thead>
            <tr>
              <th className="gg">Golden</th>
              <th className="gck">Checks</th>
              {history ? <RevisionHeads view={view} /> : null}
              <th className="glast">Last result</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <GoldenTr key={row.path} row={row} showHistory={history} />
            ))}
          </tbody>
        </table>
      </div>
      <TableFoot rows={view.rows} history={history} />
    </section>
  );
}

function GoldenTr({ row, showHistory }: { row: GoldenRow; showHistory: boolean }) {
  const source = sourceText(row);
  const last = row.last;
  return (
    <tr className={row.runId ? undefined : 'still'} {...(row.runId ? rowOpen(() => navigate(href.run(row.runId!))) : {})}>
      <td className="gg">
        <code className="gn">{row.runId ? <a className="rowa" href={href.run(row.runId)}>{row.name}</a> : row.name}</code>
        <span className="gmeta">
          <span className="chip" data-tip={tipText(row.modeHint)}>
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
          <Checks row={row} />
        </span>
      </td>
      <td className="chk gck">
        <Checks row={row} />
      </td>
      {showHistory ? <HistoryCells row={row} /> : null}
      <td className="glast">
        <LastResult row={row} />
        {last.result !== null || row.error ? <span className="rsub">{gated(last.gate) ? <DotLine text={last.line} max={18} soft={24} /> : last.line}</span> : null}
        {gated(last.gate) && last.gate.attempts ? <GateEvidence g={last.gate} verdict={last.verdict} /> : null}
        {row.presets ? <PresetsLine p={row.presets} only={last.result === null && !row.error} /> : null}
      </td>
    </tr>
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

/**
 * A golden's checks, each marked by how its last result came out on it (✓ passed, ✗ failed, ? in
 * amber when it couldn't be decided, – when it didn't apply; no mark before a result), with what
 * failed, in how many attempts, or why, under it and on hover.
 */
function Checks({ row }: { row: GoldenRow }) {
  if (!row.checks.length) {
    return (
      <em className="nil" data-tip={tipText('No checks in shadowlap.config.json: it passes when it replays and the agent exits 0')}>
        exit status only
      </em>
    );
  }
  const ran = row.last.result !== null;
  return (
    <>
      {row.checkResults.map((c, i) => {
        const m = checkMark(c, ran);
        return (
          <span key={`${c.label}:${i}`} className={`ck${m.status ? ` ${m.status}` : ''}`} data-tip={tipCard(m.tip.title, [{ label: m.tip.label, value: m.tip.value, color: m.tip.color }])}>
            {m.mark ? (
              <b className="cm" role="img" aria-label={m.word}>
                {m.mark}
              </b>
            ) : null}
            <span className="cw">
              {m.text}
              {m.sub ? <small>{glued(m.sub)}</small> : null}
            </span>
          </span>
        );
      })}
    </>
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

/**
 * Under the table: the key to By revision's cells, then each gate's rule, stated once for every
 * golden it decided (decision 9), beside the mode its goldens show: no row repeats it. Where two
 * rules share a mode (two goldens' gates with different limits), each names the goldens it decided,
 * so "up to 12 attempts" says whose it is.
 */
function TableFoot({ rows, history }: { rows: readonly GoldenRow[]; history: boolean }) {
  const rules = new Map<string, { mode: string; names: string[] }>();
  for (const r of rows) {
    const rule = r.last.gate?.rule;
    if (!rule) continue;
    const kept = rules.get(rule);
    if (kept) kept.names.push(r.name);
    else rules.set(rule, { mode: r.modeLabel, names: [r.name] });
  }
  const key = history ? <HistoryKey rows={rows} /> : null;
  if (!rules.size && !key) return null;
  const modes = [...rules.values()].map((x) => x.mode);
  const shared = (mode: string) => modes.filter((m) => m === mode).length > 1;
  return (
    <div className="gfoot">
      {key}
      {[...rules].map(([rule, { mode, names }]) => (
        <p key={rule}>
          <span className="chip">{mode}</span>
          <span>
            {shared(mode) ? <b className="gnames">{`${names.join(', ')}: `}</b> : null}
            <RuleText rule={rule} />
          </span>
        </p>
      ))}
    </div>
  );
}
