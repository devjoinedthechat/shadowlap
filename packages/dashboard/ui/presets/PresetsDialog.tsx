import { useEffect, useId, useRef, useState } from 'react';
import { CHAOS_EXPECT_EXAMPLE, CHAOS_PRESETS, PRESET_LABELS } from '../../../engine/src/chaos.js';
import { PRESETS_PART } from '../../../engine/src/cost-words.js';
import { consentAsked } from '../actions.js';
import { JOB_KINDS } from '../api.js';
import { ConsentDialog, Dialog } from '../components/Dialog.js';
import type { DialogFact } from '../components/DialogFacts.js';
import { namedIn } from '../components/Id.js';
import { Skeleton } from '../components/States.js';
import { toggled, ToggleChips } from '../components/ToggleChips.js';
import { useTestsWait } from '../fixes/tree.js';
import { goldenName, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { personName } from '../person.js';
import { sentEstimate } from '../spending.js';
import { guardedWayOn, useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { PresetsPicks, PresetsPlan } from '../types.js';
import './job-footer.js';

/*
 * Run error-path presets…'s dialog, a part only the served dashboard hands in (served-parts.ts): a
 * copy runs nothing, so its script holds none of it. The fork menu's whole run, a golden's row on
 * Tests and the palette open it on a run; the presets run on its recording, as its golden's (`test
 * <golden> --chaos`) where the recording is a golden's, else as `replay <id> --chaos`. What they hit,
 * judge and bill is the server's plan (`/api/chaos/runs/:id/plan`), asked again a moment after each
 * pick, and the job it starts is `chaos`, with exactly the fields its command row shows.
 */

export interface PresetsDialogProps {
  /** The run it opened on: the presets run on its recording, the plan's target. */
  runId: string;
  onClose: () => void;
}

const OK = confirmWords(ACTIONS.runPresets.label);
const PICK = 'Pick at least one preset';
const CHIPS = CHAOS_PRESETS.map((p) => ({ id: p, label: PRESET_LABELS[p] }));
const ORDER: readonly string[] = CHAOS_PRESETS;

/** What the person picked: the presets, in their order, the tool the tool presets hit, and the text of `--expect`. */
interface Picks {
  presets: string[];
  tool: string | null;
  expect: string;
}

/** The job's fields beyond the target, as the command row shows them: each only where it differs from what the command runs naming none. */
export function sentPicks(first: Pick<PresetsPlan, 'presets' | 'tool' | 'golden'>, p: Picks): { presets?: string[]; tool?: string; expect?: string } {
  const same = p.presets.length === first.presets.length && p.presets.every((x, i) => x === first.presets[i]);
  const expect = first.golden ? '' : p.expect.trim();
  return { ...(same ? {} : { presets: p.presets }), ...(p.tool && p.tool !== first.tool ? { tool: p.tool } : {}), ...(expect ? { expect } : {}) };
}

/** The command the presets run as picked: a golden's test, or a replay of the recording, with `--yes` where someone else recorded it. */
export function presetsCommand(first: Pick<PresetsPlan, 'golden' | 'target' | 'runsHere'>, sent: ReturnType<typeof sentPicks>): string {
  return [
    first.golden ? `shadowlap test ${first.golden} --chaos` : `shadowlap replay ${shortId(first.target)} --chaos`,
    ...(sent.presets ? [`--presets ${sent.presets.join(',')}`] : []),
    ...(sent.tool ? [`--chaos-tool ${sent.tool}`] : []),
    ...(sent.expect ? [`--expect '${sent.expect}'`] : []),
    ...(first.runsHere ? ['--yes'] : []),
  ].join(' ');
}

/** Where the picks hit past the tool: the model call that reads its answer, or why the provider presets can't. */
export function whereWords(at: PresetsPlan['at']): string {
  if (!('callNo' in at.model)) return 'no model call: the provider presets are not applicable';
  return `and model call #${at.model.callNo}${'callNo' in at.tool ? ', which reads its answer' : ''}`;
}

/** Judged by for a golden's presets: its checks, quiet where they come from; the exit alone where its expect bounds no write. */
export function goldenJudged(plan: Pick<PresetsPlan, 'judge'>, golden: string): Pick<DialogFact, 'value' | 'quiet'> {
  const name = goldenName(golden);
  if (plan.judge.source === 'exit' || !plan.judge.checks.length) return { value: 'the agent exiting 0 alone', quiet: `${name}’s expect sets no limit on a write` };
  return { value: plan.judge.checks.join('; '), quiet: plan.judge.source === 'chaos.expect' ? `${name}’s chaos.expect` : `the write\u00a0limits of ${name}’s expect` };
}

/** What an empty `--expect` leaves a run's attempts to: the exit alone, or the golden's checks Q6's lookup ties the run to. */
export function expectCaption(empty: PresetsPlan['judge']): string {
  return `what every attempt must do besides exiting 0; empty, ${empty.from ? `each attempt is judged by ${empty.from}` : 'the exit alone'}`;
}

/** Decided by: a sequential gate's rule, a fixed count its golden repeats, or one attempt each. */
export function decidedWords(plan: Pick<PresetsPlan, 'gate' | 'rule'>): string {
  if ('good' in plan.gate) return `its chaos.gate: ${plan.rule}`;
  return plan.gate.repeat > 1 ? `${plan.rule}, as its golden repeats` : 'one attempt each';
}

export function PresetsDialog({ runId, onClose }: PresetsDialogProps) {
  const { client } = useApp();
  const first = useLoad(() => client.presetsPlan(runId, {}), `${runId}:presets-plan`);
  if (!first.data) {
    const short = shortId(runId);
    return (
      <Dialog title={namedIn(`${OK} on ${short}`, short)} lead={LEAD} doc="errorPaths" className="cxdlg" warn={first.error ? { text: errorText(first.error), tone: 'red' } : null} ok={OK} okWhy={first.error ? errorText(first.error) : 'Reading what the presets hit'} onClose={onClose}>
        {first.error ? null : <Skeleton what="what the presets hit" lines={4} />}
      </Dialog>
    );
  }
  return <PresetsForm first={first.data} onClose={onClose} />;
}

const LEAD = 'Injects one failure per preset at the call it hits, and judges what the agent does next.';

/**
 * The plan for the picks: the first answer as the dialog opened, then asked again 250 ms after a
 * pick, the last answer kept until the next comes. With nothing picked there is nothing to ask.
 */
function usePlan(runId: string, first: PresetsPlan, ask: PresetsPicks, picked: boolean): PresetsPlan {
  const { client } = useApp();
  const [plan, setPlan] = useState(first);
  const key = JSON.stringify(ask);
  const priced = useRef(JSON.stringify({}));
  useEffect(() => {
    if (!picked || priced.current === key) return;
    let alive = true;
    const t = setTimeout(() => {
      void client.presetsPlan(runId, JSON.parse(key) as PresetsPicks).then(
        (p) => {
          if (!alive) return;
          priced.current = key;
          setPlan(p);
        },
        () => undefined,
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [client, runId, key, picked]);
  return plan;
}

/** The dialog once the plan is in: the picks, what they hit, judge and bill, and the yes a command someone else recorded asks. */
function PresetsForm({ first, onClose }: { first: PresetsPlan; onClose: () => void }) {
  const app = useApp();
  const head = useId();
  const [picks, setPicks] = useState<Picks>(() => ({ presets: [...first.presets], tool: first.tool, expect: first.expect ?? '' }));
  const [consent, setConsent] = useState<{ why: string; confirm: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const sent = sentPicks(first, picks);
  const picked = picks.presets.length > 0;
  const plan = usePlan(first.target, first, { ...(sent.presets ? { presets: sent.presets } : {}), ...(sent.tool ? { tool: sent.tool } : {}), ...(sent.expect ? { expect: true } : {}) }, picked);
  // A golden's presets share the test lane, and wait as Tests' buttons do; a run's wait only as every action does.
  const lane = useTestsWait('run its presets');
  const busy = first.golden ? lane : null;
  const fields = () => ({ ...(first.golden ? { golden: first.golden } : { runId: first.target }), ...sent, ...sentEstimate(plan.estimate) });
  // The yes to a command someone else recorded sends the same fields again; a refusal after it opens the dialog again with the server's words.
  const start = (confirmed?: string): Promise<boolean> =>
    app.client.startJob(JOB_KINDS.chaos, confirmed === undefined ? fields() : { ...fields(), confirmed }).then(
      (job) => {
        app.watchJob(Promise.resolve(job));
        return true;
      },
      (err: unknown) => {
        const ask = confirmed === undefined ? consentAsked(err) : null;
        setConsent(ask ? { why: ask.why, confirm: ask.confirm } : null);
        if (!ask) setRefused(errorText(err));
        return false;
      },
    );
  if (consent) return <ConsentDialog why={consent.why} ok={OK} onClose={onClose} onOk={() => guardedWayOn(app.guard, () => start(consent.confirm))} />;
  const short = shortId(first.target);
  const here = first.runsHere;
  const facts: Array<DialogFact | null> = [
    here ? { label: 'Runs here', value: `\`${here.command}\``, quiet: here.by ? `recorded by ${personName(here.by)}, from ${here.from}` : `from ${here.from}`, tone: 'amber' } : null,
    { label: <span id={head}>Presets</span>, value: <ToggleChips chips={CHIPS} picked={picks.presets} labelledBy={head} onToggle={(id) => setPicks((p) => ({ ...p, presets: toggled(ORDER, p.presets, id) }))} /> },
    first.choices.length ? { label: 'At', value: <ToolPick first={first} at={plan.at} tool={picks.tool} onTool={(tool) => setPicks((p) => ({ ...p, tool }))} /> } : null,
    first.golden
      ? { label: 'Judged by', ...goldenJudged(plan, first.golden) }
      : {
          label: 'Judged by',
          value: (
            <label className="cxj">
              <input type="text" spellCheck={false} value={picks.expect} placeholder={CHAOS_EXPECT_EXAMPLE} aria-label="The checks every attempt must pass (--expect)" onChange={(e) => setPicks((p) => ({ ...p, expect: e.target.value }))} />
              <small>{expectCaption(first.judge)}</small>
            </label>
          ),
        },
    { label: 'Decided by', value: decidedWords(plan) },
  ];
  return (
    <Dialog
      title={namedIn(`${OK} on ${short}`, short)}
      lead={LEAD}
      doc="errorPaths"
      className="cxdlg"
      warn={refused ? { text: refused } : null}
      facts={facts}
      command={presetsCommand(first, sent)}
      cost={picked ? { price: 'Billed by your provider', parts: [PRESETS_PART], estimate: plan.estimate } : { price: PICK, estimate: null }}
      ok={OK}
      okWhy={picked ? busy : PICK}
      onOk={() => guardedWayOn(app.guard, () => start())}
      onClose={onClose}
    />
  );
}

/**
 * The tool the tool presets hit, each the recording calls at its first answered call, and where the
 * provider presets hit after it. The one the command hits naming none is said to be the first read
 * only where it is (else a tool of unknown effect, a write, or the one chaos.tool names).
 */
function ToolPick({ first, at, tool, onTool }: { first: PresetsPlan; at: PresetsPlan['at']; tool: string | null; onTool: (tool: string) => void }) {
  const firstRead = first.choices.find((c) => c.effect === 'read')?.name;
  return (
    <div className="cxat">
      <select className="sel" aria-label="The tool the tool presets hit" value={tool ?? ''} onChange={(e) => onTool(e.target.value)}>
        {first.choices.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} · #{c.callNo}
            {c.name === first.tool ? (c.name === firstRead ? ', the first read' : ', what the command hits') : ''}
          </option>
        ))}
      </select>
      <span>{whereWords(at)}</span>
    </div>
  );
}
