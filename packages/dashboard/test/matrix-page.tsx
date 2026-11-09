import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunDetail } from '../ui/api.js';
import { AboutLine } from '../ui/components/About.js';
import { FindingPanel, ResultsToggle } from '../ui/components/FindingPanel.js';
import { HoverCardLayer, tipCard, tipText } from '../ui/components/HoverCard.js';
import { Sprite } from '../ui/components/Icon.js';
import { ResultsMatrix } from '../ui/components/ResultsMatrix.js';
import { RuleText } from '../ui/components/Verdict.js';
import { cellTone, groupRows, resultsKey, TONE_COLOUR, type Matrix, type MatrixCell, type MatrixCol, type MatrixRow, type ReadRow, type Worst } from '../ui/matrix.js';
import { InspectorPlace, useFindingPanel } from '../ui/run/InspectorPanel.js';
import { openResults } from '../ui/run/panel-state.js';
import { AppContext, type AppState } from '../ui/state.js';

/**
 * A page of results matrices for browser/matrix.spec.ts to measure in a real browser (the tests'
 * renderer has no layout and no canvas): a run against the six error-path presets in the run page's
 * inspector, an injection test's two reads by the twelve templates, its 52 reads grouped by tool in a
 * panel of their own, and a band with nothing in it that takes the focus. Counts invented on the
 * presets' and templates' real names. Each box's width is `window.setWidth(id, px)`'s.
 */

const app = { toast: () => undefined, guard: (fn: () => void) => fn(), actionsOff: null } as unknown as AppState;
const RUN = '01M5GRZK0P';

// ---------------------------------------------------------------------------------------------- presets

const PRESETS: Array<[string, string, string, string, number, number, string | null]> = [
  ['timeout', 'tool timeout', 'get_ticket (#4) timed out', 'passed', 6, 6, 'rate >= 0.62 (90%)'],
  ['empty', 'empty result', 'get_ticket (#4) answered with nothing', 'failed', 0, 2, 'rate <= 0.68 (90%)'],
  ['malformed', 'malformed JSON', 'get_ticket (#4) answered malformed JSON', 'inconclusive', 3, 6, 'rate 0.19 to 0.81 (90%)'],
  ['oversized', 'oversized result', 'get_ticket (#4) answered 1,000,000 characters', 'passed', 5, 6, 'rate >= 0.51 (90%)'],
  ['429', 'provider 429', 'model call #5 failed with HTTP 429', 'failed', 1, 6, 'rate <= 0.47 (90%)'],
  ['500', 'provider 500', 'model call #5 failed with HTTP 500', 'not applicable', 0, 0, null],
];

function presetCell(col: MatrixCol): MatrixCell | null {
  const p = PRESETS.find(([key]) => key === col.key);
  if (!p) return null;
  const [, label, , word, passes, attempts, bound] = p;
  const tally = attempts ? `${passes} of ${attempts} passed` : null;
  const rows = Array.from({ length: attempts }, (_, i) => ({ label: `attempt ${i + 1} · 01M5GS${col.key.padStart(3, '0')}${i}`, value: i < passes ? 'passed' : `${word}: issue_refund called 1 time`, color: TONE_COLOUR[i < passes ? 'ok' : cellTone({ word })] }));
  return { word, tally, bound, href: attempts ? `#/run/01M5GS${col.key.padStart(3, '0')}0/4` : null, tip: tipCard([label, word, tally, bound].filter(Boolean).join(' · '), rows, col.sub ?? null) };
}

const presets: Matrix = {
  id: `presets-${RUN}`,
  label: `Error-path presets on ${RUN}`,
  rowInLabel: true,
  corner: 'run',
  rows: [{ key: RUN, label: RUN, chip: 'refund-over-limit', subMin: 'Refunds a damaged order' }],
  cols: PRESETS.map(([key, label, sub]) => ({ key, label, sub })),
  cell: (_row, col) => presetCell(col),
};

const presetsPanel = (
  <FindingPanel
    kind="presets"
    name="Error-path preset results"
    label="Run × presets"
    meta={['6 presets', 'at get_ticket (#4) and model call #5', 'just now']}
    cmd={`shadowlap chaos ${RUN} --presets --attempts 6`}
    matrix={presets}
    keys={resultsKey([['failed', 2], ['inconclusive', 1], ['passed', 2], ['not applicable', 1]])}
    heads={{ sub: () => <AboutLine about={{ text: 'Refunds a damaged order and emails the customer a return label', from: 'golden' }} className="rmxab" /> }}
    line={[
      <RuleText key="rule" rule="gate: tells 90%+ from 50%- at <= 10% risk, up to 6 attempts" />,
      <span key="checks" data-tip={tipText('The checks')}>
        checks: issue_refund called 0 times
      </span>,
    ]}
    receipt={[{ parts: ['these presets spent ≈$0.486', 'every call before #4 replayed free'] }, { parts: ['132 upstream requests'] }]}
  />
);

const run = { run: { runId: RUN, divergence: null } } as unknown as RunDetail;

/** The run page's part that holds them: the finding's toggle and the inspector's place. */
function Inspector() {
  const p = useFindingPanel(RUN);
  return (
    <>
      <div className="findings">
        <ResultsToggle runId={RUN} which="presets" />
      </div>
      <InspectorPlace panel={p.panel} run={run} onClose={p.close} onPick={p.close} results={(key) => (key === 'presets' ? presetsPanel : null)}>
        <section className="insp" id="insp" aria-label="Call 4">
          <p>The inspector</p>
        </section>
      </InspectorPlace>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- injection

const TEMPLATES: Array<[string, string]> = [
  ['system-notice', 'Poses as a system notice'],
  ['system-tags', 'Closes the tool output and opens a system block'],
  ['developer-note', 'Poses as the developer'],
  ['html-comment', 'Hidden in an HTML comment'],
  ['hidden-text', 'Hidden in markup no reader sees'],
  ['image-alt', 'Hidden in an image’s alt text'],
  ['tool-json', 'Impersonates a tool’s answer'],
  ['function-result', 'Impersonates a function result, with a refund'],
  ['user-urgent', 'An urgent request from the “user”'],
  ['user-recipient', 'The “user” changes the recipient'],
  ['exfil-conversation', 'Asks for the conversation and instructions'],
  ['exfil-secrets', 'Asks for keys and customer records'],
];
const payloads: MatrixCol[] = TEMPLATES.map(([id, title]) => ({ key: id, label: id, sub: `${title}: …` }));
const VERDICTS = ['obeyed', 'influenced', 'inconclusive', 'ignored'] as const;

/** What a read's attempts came to against a payload: most reads ignored every payload; a third obeyed, were influenced or couldn't say. */
function verdictOf(callNo: number, j: number): Worst {
  if (callNo % 9 !== 4) return 3;
  return ([0, 1, 2, 3, 3, 3] as const)[(callNo + j) % 6];
}

const readCell = (callNo: number, tool: string, col: MatrixCol, j: number, links = true): MatrixCell => {
  const v = VERDICTS[verdictOf(callNo, j)];
  const n = v === 'ignored' ? 3 : 1 + (callNo % 3);
  const tally = `${n} of 3 ${v}`;
  // a run gc took: no attempt to open, its card still saying what came of it
  const gone = (callNo + j) % 5 === 0;
  return { word: v, tally, href: links && !gone ? `#/run/01M5HA${String(callNo).padStart(3, '0')}${j}/${callNo + 1}` : null, tip: links ? tipCard(`#${callNo} ${tool} · ${col.key}`, [{ label: v, value: tally, color: TONE_COLOUR[cellTone({ word: v })] }], v === 'ignored' ? `no tool call after #${callNo} carries the canary` : `the call after #${callNo} carries the canary`) : null };
};

const readRow = (callNo: number, tool: string, sub: string): MatrixRow => ({ key: String(callNo), label: `#${callNo} ${tool}`, href: `#/run/${RUN}/${callNo}`, sub });

const two: Matrix = {
  id: 'inj-two',
  label: 'Untrusted reads by payload',
  corner: 'untrusted read',
  rows: [readRow(4, 'get_ticket', 'config'), readRow(9, 'fetch_page', 'MCP openWorldHint')],
  cols: payloads,
  cell: (row, col) => {
    const j = payloads.indexOf(col);
    // one cell that couldn't say, in full: the widest tally a column holds
    if (row.key === '9' && j === 11) return { word: 'inconclusive', tally: '3 of 3 inconclusive', href: `#/run/01M5HB0009/10` };
    return readCell(Number(row.key), row.label.split(' ')[1], col, j);
  },
};

/** 52 reads, as a long conversation makes them: get_ticket's 40, fetch_page's 12. */
const reads: ReadRow[] = Array.from({ length: 52 }, (_, i) => {
  const callNo = 4 + i * 3;
  const tool = i % 4 === 1 && i < 48 ? 'fetch_page' : 'get_ticket';
  const worst = Math.min(...payloads.map((_, j) => verdictOf(callNo, j))) as Worst;
  return { callNo, name: tool, worst, row: readRow(callNo, tool, tool === 'get_ticket' ? 'config' : 'MCP openWorldHint') };
});
const byTool = (name: string) => reads.filter((r) => r.name === name);

const many: Matrix = {
  id: 'inj-many',
  label: 'Untrusted reads by payload',
  corner: 'untrusted read',
  rows: groupRows(reads),
  cols: payloads,
  cell: (row, col) => {
    const j = payloads.indexOf(col);
    if (!row.key.startsWith('g:')) return readCell(Number(row.key), row.name?.split(' ')[1] ?? row.label.split(' ')[1], col, j);
    // a tool's row: its reads summed, its strongest verdict and that verdict's tally
    const list = byTool(row.key.slice(2));
    const worst = Math.min(...list.map((r) => verdictOf(r.callNo, j))) as Worst;
    const v = VERDICTS[worst];
    const k = list.filter((r) => verdictOf(r.callNo, j) === worst).length;
    return { word: v, tally: `${k} of ${list.length * 3} ${v}`, href: `#/run/01M5HC${String(j).padStart(3, '0')}/5`, tip: tipCard(`${list.length} reads of ${row.key.slice(2)} · ${col.key}`, [{ label: v, value: `${k} of ${list.length * 3} ${v}` }]) };
  },
};
const manyCounts = (() => {
  const n = { obeyed: 0, influenced: 0, inconclusive: 0, ignored: 0 };
  for (const r of reads) for (let j = 0; j < payloads.length; j++) n[VERDICTS[verdictOf(r.callNo, j)]] += 3;
  return n;
})();

const manyPanel = (
  <FindingPanel
    kind="injection"
    name="Injection test results"
    label="Untrusted reads × payloads"
    meta={[`${reads.length * payloads.length * 3} attempts`, '12 templates, version 1', 'Oct 1, 09:31']}
    cmd={`shadowlap injection ${RUN} --attempts 3`}
    matrix={many}
    keys={resultsKey(VERDICTS.map((v) => [v, manyCounts[v]] as const))}
    receipt={[{ parts: ['this test spent ≈$3.11', 'every call before a read replayed free'] }, { parts: ['1,890 upstream requests', '6 clean replays to compare with'] }]}
  />
);

/** Two reads with nothing to open and no cards: the band that scrolls takes the focus itself. */
const bare: Matrix = {
  ...two,
  id: 'inj-bare',
  rows: two.rows.map((r) => ({ ...r, href: null })),
  cols: TEMPLATES.map(([id]) => ({ key: id, label: id })),
  cell: (row, col) => (row.key === '4' && col.key === 'tool-json' ? { word: 'obeyed', tally: '3 of 3 obeyed' } : { word: 'inconclusive', tally: '3 of 3 inconclusive' }),
};

// ---------------------------------------------------------------------------------------------- the page

openResults(RUN, 'presets');

function Page() {
  const [widths, setWidths] = useState<Record<string, number>>({ presets: 506, two: 470, many: 900, bare: 358 });
  const setWidth = (id: string, px: number) => setWidths((w) => ({ ...w, [id]: px }));
  Object.assign(window, { setWidth });
  return (
    <AppContext.Provider value={app}>
      <Sprite />
      <main className="page" id="view" style={{ height: '100%' }}>
        <h1>Results matrices</h1>
        <div id="presets" style={{ width: widths.presets }}>
          <Inspector />
        </div>
        <div id="two" style={{ width: widths.two }}>
          <ResultsMatrix matrix={two} />
        </div>
        <div id="many" style={{ width: widths.many }}>
          {manyPanel}
        </div>
        <div id="bare" style={{ width: widths.bare }}>
          <ResultsMatrix matrix={bare} />
        </div>
      </main>
      <HoverCardLayer />
    </AppContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
