import { useEffect, useRef, useState, type ReactNode } from 'react';
import { messageOf } from '../../../../engine/src/message-of.js';
import { ApiError } from '../../api.js';
import { CodeBox } from '../../components/CodeBox.js';
import { Icon } from '../../components/Icon.js';
import { Section } from '../../components/Section.js';
import { SegmentedControl } from '../../components/Segmented.js';
import { href } from '../../route.js';
import { navigate } from '../../router.js';
import type { CiWorkflowOptions, CiWorkflowsView, GatePreview } from '../../types.js';
import { useApp } from '../../state.js';
import { Select } from './CiList.js';

/**
 * Gates, the CI tab's last panel: try a gate's figures and copy the golden's entry. Each change
 * asks `GET /api/tests/gate` again (the server works out every figure, from the engine's own
 * rules): what the gate tells apart, what each extreme takes, the odds of each verdict, and how
 * often a CI run of 100 such goldens goes red for nothing, the session planned as `shadowlap test`
 * plans it at the config's suite risk. The page works out only which figures differ from the
 * defaults the answer names. Under `in CI`, what an inconclusive golden does in Your workflow.
 * `#/settings/ci?gate=<kind>` (a rule under Tests' table) opens it on that kind.
 */

type Kind = 'sprt' | 'baseline';
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

/** What an inconclusive golden does in CI, as the action's `inconclusive` input takes it; Fails writes no input, so the step does as `shadowlap test` does. */
const INCONCLUSIVE_WORDS: Record<'fail' | 'warn', ReactNode> = {
  fail: <>Fails the step, as a failed one does, but a gate against a history of fewer than 30 sessions only warns while the plan reads no decline or drop in them. Run more attempts can settle it.</>,
  warn: (
    <>
      Lets the step pass with a warning: <code>inconclusive: warn</code>. Every report still says inconclusive.
    </>
  ),
};
const INCONCLUSIVE_TOAST: Record<'fail' | 'warn', string> = {
  fail: 'An inconclusive golden fails the step, the default · a gate against fewer than 30 sessions only warns',
  warn: 'An inconclusive golden warns · Your workflow says inconclusive: warn',
};

/** What was tried, kept while the dashboard is open: the kind, and each kind's figures that were changed. */
const tried: { kind: Kind; figures: Record<Kind, Partial<Record<Figure, number>>> } = { kind: 'sprt', figures: { sprt: {}, baseline: {} } };

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
      const m = /^#\/settings\/ci\?(?:.*&)?gate=(sprt|baseline)(?:&|$)/.exec(location.hash);
      if (!m) return;
      navigate(href.settings('ci'), true);
      done.current(m[1] as Kind);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
}

export function Gates({ view, o, set }: { view: CiWorkflowsView; o: CiWorkflowOptions; set: (patch: Partial<CiWorkflowOptions>) => void }) {
  const { client, conn, toast } = useApp();
  const [kind, setKind] = useState<Kind>(tried.kind);
  const [figures, setFigures] = useState<Partial<Record<Figure, number>>>(() => ({ ...tried.figures[tried.kind] }));
  const [answer, setAnswer] = useState<{ preview: GatePreview | null; refused: string | null; error: string | null }>({ preview: null, refused: null, error: null });
  const [odds, setOdds] = useState(false);
  const [scroll, setScroll] = useState(false);
  const off = conn === 'offline';
  const pick = (k: Kind) => {
    tried.kind = k;
    setKind(k);
    setFigures({ ...tried.figures[k] });
  };
  useGateLink((k) => {
    pick(k);
    setScroll(true);
  });
  const query = new URLSearchParams([...(kind === 'baseline' ? [['baseline', 'history']] : []), ...Object.entries(figures).map(([k, v]) => [k, String(v)]), ['suiteRisk', String(view.gates.suiteRisk)]]).toString();
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
  // A link's kind scrolls Gates into view once its preview is drawn.
  useEffect(() => {
    if (scroll && answer.preview) {
      document.getElementById('gates')?.scrollIntoView({ block: 'start' });
      setScroll(false);
    }
  }, [scroll, answer.preview]);
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
  const inc = o.inconclusive ?? 'fail';
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
          <p className="muted">
            <span className="ln">A golden marked fork runs live from where it forks, so its attempts vary.</span> <span className="ln">Its gate decides as they come in, at the risk it states.</span>
          </p>
          {FIGURES[kind].map((f) => {
            const v = shown(f.k);
            return (
              <div className="setrow tight" key={f.k}>
                <div>
                  <b>{f.b}</b>
                  <span>{typeof f.s === 'function' ? f.s(shown('risk') ?? 0.05) : f.s}</span>
                </div>
                <Select label={f.b} value={v === undefined ? '' : String(v)} off={off} options={(v === undefined || f.opts.includes(v) ? f.opts : [...f.opts, v].sort((a, b) => a - b)).map((x) => ({ value: String(x), label: f.f(x) }))} onChange={(x) => setFigure(f.k, Number(x))} />
              </div>
            );
          })}
          {off ? (
            <p className="gdef">Paused until the dashboard server is back: the preview is the last it worked out.</p>
          ) : changed ? (
            <p className="gdef">
              These differ from the defaults: <code>{stands}</code> stands for {andList(FIGURES[kind].map((f) => <span key={f.k} className="nw">{f.f(defaults[f.k] ?? 0)}</span>))}.{' '}
              <button className="linkbtn" type="button" onClick={() => ((tried.figures[kind] = {}), setFigures({}))}>
                Reset
              </button>
            </p>
          ) : (
            <p className="gdef">
              The defaults: what <code>{stands}</code> stands for
              {uses.length ? <>, as {andList(uses.map((u) => <code key={u}>{u}</code>))} {uses.length === 1 ? 'uses it' : 'use it'}</> : null}.
            </p>
          )}
          <span className="k cineeds">in CI</span>
          <div className="setrow tight">
            <div>
              <b id="inconclusive-name">An inconclusive golden</b>
              <span id="inconclusive-help">{INCONCLUSIVE_WORDS[inc]}</span>
            </div>
            <SegmentedControl
              items={[
                { key: 'fail' as const, label: 'Fails' },
                { key: 'warn' as const, label: 'Warns' },
              ]}
              value={inc}
              labelledBy="inconclusive-name"
              describedBy="inconclusive-help"
              onChange={(k) => {
                if (k === inc) return;
                set({ inconclusive: k });
                toast(INCONCLUSIVE_TOAST[k]);
              }}
            />
          </div>
        </div>
        {answer.refused ? (
          <div className="pbody teamside gprev">
            <span className="k">the config refuses it</span>
            <p className="fieldnote err">{answer.refused}</p>
          </div>
        ) : p ? (
          <Preview p={p} inc={inc} odds={odds} setOdds={setOdds} />
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

/** The preview of the answer's gate: what it tells apart, what each extreme takes, how it comes out, and CI's figure. */
function Preview({ p, inc, odds, setOdds }: { p: GatePreview; inc: 'fail' | 'warn'; odds: boolean; setOdds: (open: boolean) => void }) {
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
  // Its runs go red for nothing only where 95% clears the rate the gate needs; past it, they go red for a reason.
  const idle = g.kind !== 'sprt' || g.good <= 0.95;
  const p1 = (x: number) => `${(x * 100).toFixed(1)}%`;
  const tag = (rate: number) => (g.kind !== 'sprt' ? null : rate === g.good ? <small>good</small> : rate === g.bad ? <small>bad</small> : null);
  return (
    <div className="pbody teamside gprev">
      <span className="k">what it tells apart</span>
      <p className="gsays">{p.sentence}</p>
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
                <th title="the attempts it runs on average">attempts</th>
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
      <p className="gnote">
        {g.kind === 'sprt' ? `Between ${pct(g.bad)} and ${pct(g.good)} either verdict can come, so a verdict states the test, never the agent’s rate.` : `A collapse fails nearly always; a drop just past ${Math.round(g.drop * 100)} points, only sometimes.`} With 100 {sprt ? 'forked goldens of an agent that passes 95% of the time' : 'such goldens of an agent that passes 95% of the time, as its history says'}, <span className="nw">{red} of CI runs</span> go red{idle ? ' for nothing' : ''}.
      </p>
    </div>
  );
}
