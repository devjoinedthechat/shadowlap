import { useEffect, useRef, useState, type ReactNode } from 'react';
import { messageOf } from '../../../engine/src/message-of.js';
import { ApiError } from '../api.js';
import type { CheckContext, CheckPreview, ChecksConfig, ChecksOf, GoldenEntry } from '../checks-api.js';
import { Dialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { ErrorState } from '../components/States.js';
import { goldenName, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { argsOf } from '../run/check-entry.js';
import type { BuilderProps } from '../run/check-part.js';
import { useApp } from '../state.js';
import { Change } from './Change.js';
import { judgeCost } from './Judge.js';
import {
  addBlank,
  baseOf,
  blankUnit,
  editAt,
  fileUnit,
  firstCall,
  goldenLead,
  judgeAdded,
  judgesIn,
  jsonFrom,
  keepAt,
  pickGolden,
  previewNotes,
  rebased,
  removeAt,
  ruleFrom,
  ruleTool,
  saveWhy,
  settle,
  snapOf,
  titleOf,
  unitsOf,
  withGolden,
  withoutJudges,
  withRule,
  type Fragment,
  type Rule,
  type RuleContext,
  type RuleKind,
  type PreviewNote,
  type Settled,
  type Unit,
  type Units,
} from './model.js';
import { Preview } from './Preview.js';
import { RulePicker } from './RulePicker.js';
import { Sentence } from './Sentence.js';

/**
 * The check builder: a check made from a run's tool call, or added to or changed on a golden, judged
 * on the agent's recordings as it is built and saved to the golden's `tests` entry in
 * shadowlap.config.json. A part of its own, which a run's page loads the first time its check menu
 * opens (run/check-entry.tsx). A press on the dimmed page never closes it; Esc asks first once
 * something in it changed. It opens on its loading state, then again on its rules once their reads
 * have come, so its focus starts on what it checks.
 */
export function Builder(props: BuilderProps) {
  const { client } = useApp();
  const of: ChecksOf = 'call' in props ? { run: props.run.run.runId } : { golden: props.golden };
  const cfg = useLoad(() => client.checks.goldens(of), JSON.stringify(of));
  const at = contextAt(props, cfg.data);
  const ctx = useLoad(() => (at ? client.checks.context(at.runId, at.callNo) : null), at ? `${at.runId}:${at.callNo}` : 'none');
  const head = headOf(props, 'call' in props ? null : props.golden);
  if (!cfg.data || (at && !ctx.data && !ctx.error)) {
    return (
      <Dialog title={head.title} lead={head.lead} doc="checks" className="ckb" scrim="ignore" ok="Save check" okWhy={cfg.error ? 'Its golden’s checks didn’t load' : 'Loading its golden’s checks…'} onClose={props.onClose}>
        {cfg.error ? <ErrorState retry={cfg.reload}>{messageOf(cfg.error)}</ErrorState> : <p className="cb-note">Loading the golden’s checks…</p>}
      </Dialog>
    );
  }
  return <Body {...props} cfg={cfg.data} cfgError={cfg.error ? messageOf(cfg.error) : null} reread={cfg.reload} context={ctx.data} contextError={ctx.error ? messageOf(ctx.error) : null} retryContext={ctx.reload} of={of} />;
}

/** The call whose run the editor reads: the one the check is made from, else the golden's own recording, read whole. */
function contextAt(props: BuilderProps, cfg: ChecksConfig | null): { runId: string; callNo: number } | null {
  if ('call' in props) return { runId: props.run.run.runId, callNo: props.call.call.callNo };
  const g = cfg?.goldens.find((x) => x.path === props.golden);
  return g?.runId && g.inStore ? { runId: g.runId, callNo: Number.MAX_SAFE_INTEGER } : null;
}

/** The title and lead: from a call they name it, on a golden the golden. */
function headOf(props: BuilderProps, golden: string | null): { title: ReactNode; lead: ReactNode } {
  const edit = !('call' in props) && props.edit !== null;
  const title = titleOf(golden, { edit, fromCall: 'call' in props });
  if (!('call' in props)) return { title: golden ? namedIn(title, goldenName(golden)) : title, lead: goldenLead(golden, edit) };
  const c = props.call.call;
  return {
    title,
    lead: (
      <>
        Makes a check from #{c.callNo} <code>{c.name}</code> in <code>{shortId(props.run.run.runId)}</code>, judged on your recordings as you build it.
      </>
    ),
  };
}

interface BodyProps {
  cfg: ChecksConfig;
  cfgError: string | null;
  reread: () => void;
  context: CheckContext | null;
  contextError: string | null;
  retryContext: () => void;
  of: ChecksOf;
}

/** The builder's state: its units and the one being edited, the golden it goes to, and whether that was picked. */
type State = Units & { golden: string | null; picked: boolean };

const goldenAt = (cfg: ChecksConfig, path: string | null): GoldenEntry | null => cfg.goldens.find((g) => g.path === path) ?? null;

function startOf(props: BuilderProps, cfg: ChecksConfig, rctx: RuleContext): State {
  if ('call' in props) {
    const rule = ruleFrom(props.kind, rctx);
    const golden = pickGolden(cfg.goldens, null, rule);
    const file = unitsOf(baseOf(goldenAt(cfg, golden))).map(fileUnit);
    return { units: [...file, withRule(blankUnit(), rule)], active: file.length, golden, picked: false };
  }
  const file = unitsOf(baseOf(goldenAt(cfg, props.golden))).map(fileUnit);
  const opened = props.edit !== null && file[props.edit] ? editAt({ units: file, active: 0 }, props.edit) : { units: [...file, blankUnit()], active: file.length };
  return { ...opened, golden: props.golden, picked: true };
}

/** What the editor reads of the run: the call, the run's calls, the tools the run and the agent call, and the model a judge starts on. */
function ruleContext(props: BuilderProps, cfg: ChecksConfig, context: CheckContext | null, agentTools: readonly string[]): RuleContext {
  const own = 'call' in props ? { callNo: props.call.call.callNo, tool: props.call.call.name, args: argsOf(props.call), effect: null } : null;
  const tools = [...new Set([...(context?.tools.map((t) => t.tool) ?? []), ...agentTools])];
  return { call: context?.at ?? own, context, tools, model: cfg.models[0] ?? 'claude-haiku-4-5' };
}

/** What the builder draws from its state: the golden, the unit in the editor and its rule, the check as settled, and the draft as judged. */
interface Drawn {
  golden: GoldenEntry | null;
  unit: Unit | null;
  rule: Rule | null;
  settled: Settled;
  /** The draft as judged: without its judges, whose verdicts no recording holds; null while nothing else writes. */
  judged: Fragment | null;
  judgesOnly: boolean;
  judges: number;
  fork: boolean;
}

function drawnOf(cfg: ChecksConfig, s: State): Drawn {
  const golden = goldenAt(cfg, s.golden);
  const unit = s.units[s.active] ?? null;
  const settled = settle(s.units, baseOf(golden), s.active);
  const judged = settled.draft ? withoutJudges(settled.draft) : null;
  const some = !!judged && Object.keys(judged).length > 0;
  return { golden, unit, rule: unit?.rule ?? null, settled, judged: some ? judged : null, judgesOnly: !!judged && !some, judges: some ? judgesIn(settled.draft) : 0, fork: !!golden && golden.mode.label.startsWith('fork') };
}

/** Against your recordings' notes: the run it is made from has its own only when it is a recording whose check failed. */
function notesOf(props: BuilderProps, d: Drawn, golden: string | null, answer: CheckPreview | null): PreviewNote[] {
  if (!answer) return [];
  const failedItsCheck = 'call' in props && props.run.run.mode === 'record' && props.run.judged?.verdict === 'failed';
  return previewNotes(answer, { golden, failedItsCheck, judges: d.judges, fork: d.fork });
}

/**
 * Save's words, which follow the state: off with why until it can save, plain while a note needs a
 * look, lime once none does. A save the server refused stays off on its words until something changes.
 */
function waysOf(d: Drawn, s: State, o: { amber: boolean; conflict: boolean; edit: boolean; cfgError: string | null; warn: string | null; redactions: number }) {
  return {
    ok: o.conflict ? 'Save again' : o.edit ? 'Save change' : 'Save check',
    tone: o.amber ? ('plain' as const) : ('lime' as const),
    okWhy: o.cfgError ? 'shadowlap.config.json couldn’t be read again: Retry it under The change' : (o.warn ?? saveWhy(d.settled, s.units, s.active, s.golden)),
    okSub: o.amber ? 'Saves it as it is, though something above needs a look' : 'Only if shadowlap.config.json is as this page read it: a change made since is never overwritten',
    startFocus: d.rule ? '.cb-kinds [aria-pressed="true"]' : '.cb-kinds button',
    cost: d.rule?.kind === 'judge' ? judgeCost(d.rule, d.fork, o.redactions) : null,
  };
}

/**
 * Save: the golden's entry written against the version read. A file changed since is read again, its
 * words kept for The change and every rule kept; any other refusal goes in the dialog's amber line.
 * Once saved it toasts, and the run list is read again, with the run's outcome under its checks.
 */
function useSave(cfg: ChecksConfig, golden: GoldenEntry | null, merged: Fragment, o: { reread: () => void; onConflict: (why: string) => void; onWarn: (why: string) => void }) {
  const { client, toast, refresh } = useApp();
  return async () => {
    if (!golden) return false;
    try {
      await client.checks.save({ golden: golden.path, version: cfg.version, read: cfg.read, entry: { expect: Object.keys(merged).length ? merged : null } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && /since this page read it/.test(err.message)) {
        o.onConflict(err.message);
        o.reread();
      } else o.onWarn(messageOf(err));
      return false;
    }
    toast(`Saved to shadowlap.config.json · ${golden.path}`);
    refresh();
    return true;
  };
}

/** The preview as the builder last drew it: the answer to the draft as it stands, the last answer of any draft, and whether the newest is being judged. */
interface Judging {
  answer: CheckPreview | null;
  last: CheckPreview | null;
  pending: boolean;
}

/**
 * The tools the agent's recordings call, gathered from each answer, and the golden a check from a call
 * follows until one is picked. While the newest draft is being judged the golden stays: an answer to
 * an older draft never moves it.
 */
function useFollow(props: BuilderProps, cfg: ChecksConfig, s: State, seen: Judging, setS: (next: (x: State) => State) => void): readonly string[] {
  const [tools, setTools] = useState<readonly string[]>([]);
  const last = seen.last;
  if (last && last.tools.some((t) => !tools.includes(t))) setTools([...new Set([...tools, ...last.tools])]);
  const rule = s.units[s.active]?.rule ?? null;
  const auto = 'call' in props && !s.picked && !seen.pending ? pickGolden(cfg.goldens, seen.answer?.goldens ?? null, rule) : s.golden;
  if (auto !== s.golden) setS((x) => ({ ...withGolden(x, baseOf(goldenAt(cfg, auto))), golden: auto, picked: false }));
  return tools;
}

function Body(props: BuilderProps & BodyProps) {
  const { cfg, of } = props;
  const fromCall = 'call' in props;
  const [seen, setSeen] = useState<Judging>({ answer: null, last: null, pending: false });
  const [s, setS] = useState<State>(() => startOf(props, cfg, ruleContext(props, cfg, props.context, [])));
  // The file read again after a 409: the golden's checks as they are now, each edit kept on a check still there.
  const [readFrom, setReadFrom] = useState(cfg);
  if (readFrom !== cfg) {
    setReadFrom(cfg);
    setS((x) => ({ ...x, ...rebased(x, baseOf(goldenAt(cfg, x.golden))) }));
  }
  const agentTools = useFollow(props, cfg, s, seen, setS);
  const rctx = ruleContext(props, cfg, props.context, agentTools);
  const [opened] = useState(() => snapOf(s.picked ? s.golden : null, s));
  const [conflict, setConflict] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const d = drawnOf(cfg, s);
  const judging = usePreview(of, d.judged);
  if (judging.answer !== seen.answer || judging.last !== seen.last || judging.pending !== seen.pending) setSeen({ answer: judging.answer, last: judging.last, pending: judging.pending });
  const notes = notesOf(props, d, s.golden, judging.answer);
  const ways = waysOf(d, s, { amber: notes.some((n) => n.tone === 'amber'), conflict: !!conflict, edit: !fromCall && props.edit !== null, cfgError: props.cfgError, warn, redactions: cfg.redactions });
  const save = useSave(cfg, d.golden, d.settled.merged, { reread: props.reread, onConflict: setConflict, onWarn: setWarn });
  const change = (next: (x: State) => Units) => {
    setWarn(null);
    setS((x) => ({ ...x, ...next(x) }));
  };
  const setRule = (r: Rule) => change((x) => ({ units: x.units.map((u, j) => (j === x.active ? withRule(u, r) : u)), active: x.active }));
  const setKind = (k: RuleKind) => setRule(k === 'json' ? jsonFrom(d.rule, rctx) : ruleFrom(k, { ...rctx, call: firstCall(rctx, ruleTool(d.rule) ?? '') ?? rctx.call }));
  const head = headOf(props, s.golden);
  const runId = fromCall ? props.run.run.runId : null;
  return (
    <Dialog title={head.title} lead={head.lead} doc="checks" className="ckb" scrim="ignore" dirty={snapOf(s.picked ? s.golden : null, s) !== opened} warn={warn ? { text: warn, written: true } : null} {...ways} onOk={save} onClose={props.onClose}>
      <RulePicker
        settled={d.settled}
        units={s.units}
        active={s.active}
        goldens={cfg.goldens}
        golden={d.golden}
        picker={fromCall && cfg.goldens.length > 1}
        onGolden={(path) => change((x) => ({ ...withGolden(x, baseOf(goldenAt(cfg, path))), golden: path, picked: true }))}
        onEdit={(i) => change((x) => editAt(x, i))}
        onRemove={(i) => change((x) => removeAt(x, i))}
        onKeep={(i) => change((x) => keepAt(x, i))}
        onAdd={() => change(addBlank)}
      />
      <section className="cb-sec" id="cbEdit">
        {props.contextError ? <ErrorState retry={props.retryContext}>{props.contextError}</ErrorState> : null}
        {d.unit && !d.unit.gone ? <Sentence rule={d.rule} ctx={rctx} run={runId ? shortId(runId) : null} models={cfg.models} onRule={setRule} onKind={setKind} /> : null}
      </section>
      <Preview answer={judging.answer} error={judging.error} retry={judging.retry} notes={notes} judged={d.judged} judgesOnly={d.judgesOnly} agent={cfg.agent} />
      <Change cfg={cfg} error={props.cfgError} retry={props.reread} golden={d.golden} merged={d.settled.merged} changed={d.settled.changed} conflict={conflict} judgeAdded={judgeAdded(s.units)} runId={runId} />
    </Dialog>
  );
}

/** How long the builder waits after the last change to a draft before it is judged. */
const SETTLE_MS = 300;

interface Got {
  /** The draft the answer is to. */
  key: string | null;
  answer: CheckPreview | null;
  error: string | null;
}

/**
 * The draft judged on the agent's recordings: asked about 300 ms after its last change, at most one
 * read in flight, since the pool can't stop one, and the newest draft sent when the last answers. An
 * answer to an older draft is dropped, so what is drawn is always the draft's own: until it comes,
 * the draft is being judged. A failed read says so and keeps the last answer.
 */
function usePreview(of: ChecksOf, judged: Fragment | null): Judging & { error: string | null; retry: () => void } {
  const { client } = useApp();
  const [got, setGot] = useState<Got>({ key: null, answer: null, error: null });
  const [tries, setTries] = useState(0);
  const flying = useRef(false);
  const waiting = useRef(false);
  const want = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const key = judged ? JSON.stringify(judged) : null;
  const whose = JSON.stringify(of);
  useEffect(() => {
    want.current = key;
    const send = () => {
      const k = want.current;
      if (k === null || flying.current) return;
      flying.current = true;
      const done = (next: (g: Got) => Got) => {
        flying.current = false;
        if (!alive.current) return;
        if (want.current === k) setGot(next);
        else if (!waiting.current) send();
      };
      client.checks.preview(JSON.parse(k) as Fragment, JSON.parse(whose) as ChecksOf).then(
        (answer) => done(() => ({ key: k, answer, error: null })),
        (err: unknown) => done((g) => ({ ...g, error: messageOf(err) })),
      );
    };
    waiting.current = true;
    const t = setTimeout(() => {
      waiting.current = false;
      send();
    }, SETTLE_MS);
    return () => {
      clearTimeout(t);
      waiting.current = false;
    };
  }, [client, key, whose, tries]);
  const own = got.key === key;
  return { answer: own ? got.answer : null, last: got.answer, pending: key !== null && !own, error: got.error, retry: () => setTries((t) => t + 1) };
}
