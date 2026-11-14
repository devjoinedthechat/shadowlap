import { useEffect, useRef, useState, type ReactNode } from 'react';
import { messageOf } from '../../../../engine/src/message-of.js';
import { ApiError } from '../../api.js';
import { CodeBox } from '../../components/CodeBox.js';
import { Copy } from '../../components/Copy.js';
import { tipCard } from '../../components/HoverCard.js';
import { Icon } from '../../components/Icon.js';
import { Section } from '../../components/Section.js';
import { SegmentedControl } from '../../components/Segmented.js';
import { addressNow } from '../../dom.js';
import { href } from '../../route.js';
import { navigate } from '../../router.js';
import type { CiWorkflowsView, GatePreview } from '../../types.js';
import { useApp } from '../../state.js';
import { Select } from './CiList.js';
import { keptFor } from './ci-kept.js';
import { useCiWorkflows } from './ci-read.js';
import { ConfigProblem, LoadProblem, Loading } from './common.js';
import { InconclusiveLine } from './inconclusive.js';
import { ciShown } from './logic.js';
import { gateLink, type GateKind } from './tabs.js';

/**
 * Gates (`#/settings/gates`), a tab of its own: try a gate's figures and copy the golden's entry.
 * Each change asks `GET /api/tests/gate` again (the server works out every figure, from the
 * engine's own rules): what the gate tells apart, what each extreme takes, the odds of each
 * verdict, and how often a CI run of 100 such goldens goes red for nothing, the session planned as
 * `shadowlap test` plans it at the config's suite risk. The page works out only which figures
 * differ from the defaults the answer names. Under `in CI`, what an inconclusive golden does in
 * Your workflow, which the CI tab sets: its changes there, written or not, are read here too
 * (ci-kept.ts), so the CI figure is the one the workflow as it stands would give.
 * `#/settings/gates?gate=<kind>` (a rule under Tests' table) opens it on that kind.
 */

type Kind = GateKind;
type Figure = 'good' | 'bad' | 'risk' | 'max' | 'drop' | 'window' | 'min';

const pct = (x: number) => `${+(x * 100).toFixed(1)}%`;
const unit = (w: string) => (x: number) => `${x} ${w}`;

/** Each kind's figures, as the design words them: what each sets, and the values its select offers. */
const FIGURES: Record<Kind, ReadonlyArray<{ k: Figure; b: string; s: string | ((risk: number) => string); opts: readonly number[]; f: (x: number) => string }>> = {
  sprt: [
    { k: 'good', b: 'Good', s: 'The pass rate you need.', opts: [0.8, 0.85, 0.9, 0.95, 0.99], f: pct },
    { k: 'bad', b: 'Bad', s: 'The pass rate you must never ship.', opts: [0.5, 0.6, 0.7, 0.8, 0.9], f: pct },
    { k: 'risk', b: 'Risk', s: 'The most a verdict may be wrong, at those two rates.', opts: [0.01, 0.05, 0.1], f: pct },
    { k: 'max', b: 'Max', s: 'Attempts before it says inconclusive.', opts: [20, 40, 80, 160], f: unit('attempts') },
  ],
  baseline: [
    { k: 'drop', b: 'Drop', s: 'The fall from its baseline that fails it.', opts: [0.1, 0.15, 0.2, 0.3], f: (x) => `${Math.round(x * 100)} points` },
    { k: 'risk', b: 'Risk', s: (risk) => `It fails once that drop is ${pct(1 - risk)} likely.`, opts: [0.01, 0.05, 0.1], f: pct },
    { k: 'window', b: 'Window', s: 'The past sessions its baseline pools.', opts: [5, 10, 20], f: unit('sessions') },
    { k: 'min', b: 'Min', s: 'Attempts before it decides.', opts: [3, 5, 10], f: unit('attempts') },
    { k: 'max', b: 'Max', s: 'Attempts before it says inconclusive.', opts: [20, 40, 80], f: unit('attempts') },
  ],
};

const KINDS = [
  { key: 'sprt' as const, label: 'fork · gate' },
  { key: 'baseline' as const, label: 'fork · history' },
];

/** What was tried, kept while the dashboard is open: the kind, each kind's figures that were changed, and the golden a gate against history is figured against ('' for the example). */
const tried: { kind: Kind; figures: Record<Kind, Partial<Record<Figure, number>>>; golden: string } = { kind: 'sprt', figures: { sprt: {}, baseline: {} }, golden: '' };

/** The goldens a gate against history can be figured against. */
type Forks = NonNullable<CiWorkflowsView['gates']['forks']>;

/** The baseline a gate against history is figured against when no golden is picked, as the preview names it (tests-gate.ts PREVIEW_HISTORY). */
const EXAMPLE = '47 of 50, an example';

/** Where the baseline came from, under the takes: a golden's own last sessions, or that it has none yet and the example stands in. */
function fromWords(from: NonNullable<GatePreview['from']>, forks: Forks): string {
  const name = forks.find((g) => g.path === from.golden)?.name ?? from.golden;
  return from.sessions ? `${name}’s own history: its last ${from.sessions === 1 ? 'session' : `${from.sessions} sessions`}` : `${name} has no session that passed on its baseline branch yet: an example stands in`;
}

/** `"gate": {}`, or the figures that differ from the defaults: `{ "baseline": "history", "max": 20 }`. */
function entryOf(kind: Kind, gate: Record<string, unknown>, defaults: Record<string, unknown>): string {
  const parts = kind === 'baseline' ? ['"baseline": "history"'] : [];
  for (const f of FIGURES[kind]) if (gate[f.k] !== defaults[f.k]) parts.push(`"${f.k}": ${String(gate[f.k])}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

/** `a, b and c`. */
const andList = (xs: readonly ReactNode[]): ReactNode[] => xs.flatMap((x, i) => (i === 0 ? [x] : [i === xs.length - 1 ? ' and ' : ', ', x]));

/** The kind a link asks for (`?gate=sprt|baseline`), read once: the address goes back to the tab's own at once. */
function useGateLink(open: (kind: Kind) => void): void {
  const done = useRef(open);
  done.current = open;
  useEffect(() => {
    const read = () => {
      const kind = gateLink(addressNow());
      if (!kind) return;
      navigate(href.settings('gates'), true);
      done.current(kind);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
}

/** The tab: Gates for the project shown, read again in another. */
export function GatesTab() {
  const project = useApp().meta?.project?.id ?? null;
  return <GatesOf key={project ?? ''} project={project} />;
}

/** Gates for one project: what its workflow and its config say of gates, then the figures to try. */
function GatesOf({ project }: { project: string | null }) {
  // What the CI tab's switches were changed to and not yet written: an inconclusive golden's among them.
  const kept = keptFor(project);
  const { view, error, reload } = useCiWorkflows(kept);
  if (!view) return error ? <LoadProblem error={error} retry={reload} /> : <Loading title="Gates" />;
  return (
    <>
      {view.configError ? <ConfigProblem error={view.configError} /> : null}
      <Gates view={view} inc={ciShown(kept, view).inconclusive ?? 'fail'} />
      {error ? <p className="fieldnote err">{error.message}</p> : null}
    </>
  );
}

function Gates({ view, inc }: { view: CiWorkflowsView; inc: 'fail' | 'warn' }) {
  const { client, conn } = useApp();
  const [kind, setKind] = useState<Kind>(tried.kind);
  const [figures, setFigures] = useState<Partial<Record<Figure, number>>>(() => ({ ...tried.figures[tried.kind] }));
  const [answer, setAnswer] = useState<{ preview: GatePreview | null; refused: string | null; error: string | null }>({ preview: null, refused: null, error: null });
  const [odds, setOdds] = useState(false);
  const [golden, setGolden] = useState(tried.golden);
  const off = conn === 'offline';
  const forks = view.gates.forks ?? [];
  // A golden picked is figured against only where it is still one of the goldens marked fork.
  const against = kind === 'baseline' && forks.some((g) => g.path === golden) ? golden : '';
  const pick = (k: Kind) => {
    tried.kind = k;
    setKind(k);
    setFigures({ ...tried.figures[k] });
  };
  useGateLink(pick);
  const query = new URLSearchParams([...(kind === 'baseline' ? [['baseline', 'history']] : []), ...Object.entries(figures).map(([k, v]) => [k, String(v)]), ['suiteRisk', String(view.gates.suiteRisk)], ...(against ? [['golden', against]] : [])]).toString();
  useEffect(() => {
    const stop = new AbortController();
    client.settings.gate(query, stop.signal).then(
      (preview: GatePreview) => setAnswer({ preview, refused: null, error: null }),
      (err: unknown) => {
        if (stop.signal.aborted) return;
        if (err instanceof ApiError && err.status === 400) setAnswer((a) => ({ ...a, refused: err.message, error: null }));
        else setAnswer((a) => ({ ...a, error: messageOf(err) }));
      },
    );
    return () => stop.abort();
  }, [client, query]);
  const p = answer.preview && answer.preview.gate.kind === kind ? answer.preview : null;
  const defaults = (p?.defaults[kind] ?? answer.preview?.defaults[kind] ?? {}) as Record<string, number>;
  const shown = (k: Figure): number | undefined => figures[k] ?? (p?.gate as Record<string, number> | undefined)?.[k] ?? defaults[k];
  const setFigure = (k: Figure, v: number) => {
    const next = { ...figures, [k]: v };
    if (v === defaults[k]) delete next[k];
    tried.figures[kind] = next;
    setFigures(next);
  };
  const changed = FIGURES[kind].some((f) => shown(f.k) !== defaults[f.k]);
  const stands = kind === 'sprt' ? '"gate": {}' : '"gate": { "baseline": "history" }';
  const uses = view.gates.uses[kind];
  return (
    <Section
      className="set cip gatep"
      id="gates"
      title="Gates"
      sub="try figures, then copy the golden’s entry"
      actions={<SegmentedControl items={KINDS} value={kind} onChange={pick} label="Kind of gate" action reads />}
    >
      <div className="alertgrid">
        <div className="pbody cimain">
          <Copy className="muted">A golden marked fork runs live from where it forks, so its attempts vary. Its gate decides as they come in, at the risk it states.</Copy>
          {FIGURES[kind].map((f) => {
            const v = shown(f.k);
            return (
              <div className="setrow tight" key={f.k}>
                <div>
                  <b>{f.b}</b>
                  <Copy as="span">{typeof f.s === 'function' ? f.s(shown('risk') ?? 0.05) : f.s}</Copy>
                </div>
                <Select label={f.b} value={v === undefined ? '' : String(v)} off={off} options={(v === undefined || f.opts.includes(v) ? f.opts : [...f.opts, v].sort((a, b) => a - b)).map((x) => ({ value: String(x), label: f.f(x) }))} onChange={(x) => setFigure(f.k, Number(x))} />
              </div>
            );
          })}
          {kind === 'baseline' && forks.length ? (
            <div className="setrow tight">
              <div>
                <b>Against</b>
                <Copy as="span">The baseline its odds are figured against: an example, or a golden’s own last sessions.</Copy>
              </div>
              <Select label="Against" value={against} off={off} options={[{ value: '', label: EXAMPLE }, ...forks.map((g) => ({ value: g.path, label: g.name }))]} onChange={(x) => ((tried.golden = x), setGolden(x))} />
            </div>
          ) : null}
          {off ? (
            <Copy className="gdef">Paused until the dashboard server is back: the preview is the last it worked out.</Copy>
          ) : changed ? (
            <Copy className="gdef">
              These differ from the defaults: <code>{stands}</code> stands for {andList(FIGURES[kind].map((f) => <span key={f.k} className="nw">{f.f(defaults[f.k] ?? 0)}</span>))}.{' '}
              <button className="linkbtn" type="button" onClick={() => ((tried.figures[kind] = {}), setFigures({}))}>
                Reset
              </button>
            </Copy>
          ) : (
            <Copy className="gdef">
              The defaults: what <code>{stands}</code> stands for
              {uses.length ? <>, as {andList(uses.map((u) => <code key={u}>{u}</code>))} {uses.length === 1 ? 'uses it' : 'use it'}</> : null}.
            </Copy>
          )}
          <span className="k gci">in CI</span>
          <InconclusiveLine inc={inc} />
        </div>
        {answer.refused ? (
          <div className="pbody teamside gprev">
            <span className="k">the config refuses it</span>
            <p className="fieldnote err">{answer.refused}</p>
          </div>
        ) : p ? (
          <Preview p={p} inc={inc} odds={odds} setOdds={setOdds} forks={forks} />
        ) : (
          <div className="pbody teamside gprev">{answer.error ? <p className="fieldnote err">{answer.error}</p> : null}</div>
        )}
      </div>
      {p && !answer.refused ? (
        <div className="pbody cicode">
          <span className="k">these figures, as a golden’s entry</span>
          <CodeBox file="shadowlap.config.json" what="the golden’s entry" code={`"tests": {\n  "goldens/<name>": {\n    "fork": true,\n    "gate": ${entryOf(kind, p.gate as unknown as Record<string, unknown>, p.defaults[kind])}\n  }\n}`} />
        </div>
      ) : null}
    </Section>
  );
}

/** A verdict line with its word in its tone: `passed · 12 of 12 · rate >= 0.73 (95%)`. */
function Verdict({ line }: { line: string }) {
  const m = /^(passed|failed|inconclusive)\b(.*)$/.exec(line);
  if (!m) return <>{line}</>;
  return (
    <>
      <span className={`vw ${m[1] === 'passed' ? 'ok' : m[1] === 'failed' ? 'err' : 'warn'}`}>{m[1]}</span>
      {m[2]}
    </>
  );
}

/** The preview of the answer's gate: what it tells apart, what each extreme takes, where its baseline came from, how it comes out, and CI's figure. */
function Preview({ p, inc, odds, setOdds, forks }: { p: GatePreview; inc: 'fail' | 'warn'; odds: boolean; setOdds: (open: boolean) => void; forks: Forks }) {
  const g = p.gate;
  const sprt = g.kind === 'sprt';
  const tone = (line: string | null) => (line?.startsWith('passed') ? 'ok' : line?.startsWith('failed') ? 'err' : 'warn');
  const takes: Array<[string, ReactNode, string | undefined]> = sprt
    ? [
        ['an agent that always passes', <Verdict key="p" line={p.extremes.pass} />, tone(p.extremes.pass)],
        ['one that always fails', <Verdict key="f" line={p.extremes.fail ?? ''} />, tone(p.extremes.fail)],
        ['each failure takes', `about ${(p.passesPerFailure ?? 0).toFixed(1)} more passes`, undefined],
      ]
    : [
        ['an agent whose attempts all pass', <Verdict key="p" line={p.extremes.pass} />, tone(p.extremes.pass)],
        ['with no history yet, it compares with', 'its recording', undefined],
        ['in CI, its history is kept by', 'keep-history', undefined],
      ];
  const red = inc === 'warn' ? p.ci.redWarnText : p.ci.redText;
  // Its runs go red for nothing only where CI's agent (95% of the time) clears the rate the gate needs; past it, they go red for a reason.
  const idle = g.kind !== 'sprt' || g.good <= p.ci.rate;
  const agent = `an agent that passes ${pct(p.ci.rate)} of the time`;
  const p1 = (x: number) => `${(x * 100).toFixed(1)}%`;
  const tag = (rate: number) => (g.kind !== 'sprt' ? null : rate === g.good ? <small>good</small> : rate === g.bad ? <small>bad</small> : null);
  return (
    <div className="pbody teamside gprev">
      <span className="k">what it tells apart</span>
      <Copy className="gsays">{p.sentence}</Copy>
      <span className="k">what it takes, for a golden on its own</span>
      <ul className="cilist">
        {takes.map(([label, value, t]) => (
          <li key={label}>
            <i className={t} aria-hidden="true" />
            <span>{label}</span>
            <code>{value}</code>
          </li>
        ))}
      </ul>
      {p.from ? <Copy className="muted gfrom">{fromWords(p.from, forks)}</Copy> : null}
      <div className={`godw${odds ? ' open' : ''}`}>
        <div className="godh">
          <span className="k">{sprt ? 'how it comes out' : `how it comes out, against ${p.history?.passes ?? 0} of ${p.history?.attempts ?? 0}`}</span>
          <button className="xbtn" type="button" aria-expanded={odds} aria-label={`${odds ? 'Hide' : 'Show'} odds of each verdict`} onClick={() => setOdds(!odds)}>
            <Icon name="caret" />
          </button>
        </div>
        <div className="gotw">
          <table className="godds">
            <thead>
              <tr>
                <th>{sprt ? 'pass rate' : 'rate now'}</th>
                <th>passed</th>
                <th>failed</th>
                <th>inconclusive</th>
                <th data-tip={tipCard('attempts', [], 'the attempts it runs on average')}>attempts</th>
              </tr>
            </thead>
            <tbody>
              {p.odds.map((r) => (
                <tr key={r.rate}>
                  <td>
                    {pct(r.rate)}
                    {tag(r.rate)}
                  </td>
                  <td>{p1(r.pass)}</td>
                  <td>{p1(r.fail)}</td>
                  <td>{p1(r.inconclusive)}</td>
                  <td>{r.attempts.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Copy className="gnote">
        {g.kind === 'sprt' ? `Between ${pct(g.bad)} and ${pct(g.good)} either verdict can come, so a verdict states the test, never the agent’s rate.` : `A collapse fails nearly always; a drop just past ${Math.round(g.drop * 100)} points, only sometimes.`} With {p.ci.goldens} {sprt ? `forked goldens of ${agent}` : `such goldens of ${agent}, as its history says`}, <span className="nw">{red} of CI runs</span> go red{idle ? ' for nothing' : ''}.
      </Copy>
    </div>
  );
}
