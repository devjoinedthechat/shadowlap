import { useEffect, useRef, useState, type ReactElement } from 'react';
import { fieldValue } from '../../../engine/src/field-value.js';
import { decisionsArgv, FIELD_NAME, MODEL_NAME, type DecisionsArgs } from '../../src/decisions-argv.js';
import { fieldModels, startModel } from '../../src/model-order.js';
import type { CommandRowProps } from '../components/CommandRow.js';
import { consentAsked } from '../actions.js';
import { ConsentDialog, Dialog } from '../components/Dialog.js';
import type { DialogFactRows } from '../components/DialogFacts.js';
import { tipCard } from '../components/HoverCard.js';
import { ModelField, useModelChoices } from '../components/ModelField.js';
import type { PreviewTarget, PreviewWay } from '../components/NewPreviewMenu.js';
import { previewQuery, type PreviewEstimates, type PreviewQuery } from '../estimates-api.js';
import { useConsentStart } from '../fixes/FixJobButton.js';
import { dropPick } from '../run/decisions-pick.js';
import { useTreeBusy } from '../fixes/tree.js';
import { useLoad } from '../hooks.js';
import { draftCommand } from '../job-title.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { untilDone } from '../runspage/push.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import type { JobView } from '../types.js';

/**
 * New preview's three dialogs: Preview model switch…, Preview changed prompt and Preview field
 * change…. Each says what it asks and what that costs as its form changes (GET
 * /api/decisions/estimates), shows the command its job runs, built by the job's own helper
 * (decisions-argv.ts), and starts `decisions` with the estimate it showed. The served dashboard
 * hands them in (pages/served.tsx), loaded on demand, so an exported copy holds none of them.
 */

export interface NewPreviewProps {
  way: PreviewWay;
  target: PreviewTarget;
  onClose: () => void;
}

/** Said where there is nothing to preview on: no golden yet. */
export const NO_GOLDENS = 'No goldens yet: pack a run as a golden, or preview a change on one run from its Decisions view.';
/** Where none of a switch's calls can be asked: why its confirm waits. */
const SWITCH_IN_CODE = 'Switch to it in your code, then verify the change';
const TOOLS_FACT = { label: 'Tools', value: 'none run', quiet: 'nothing reaches the world' };
/** A command naming more targets than this shows the first few and how many more, its Copy taking it whole. */
const CUT = 6;
const SHOWN = 3;

const targetFields = (t: PreviewTarget): Record<string, unknown> => ('goldens' in t ? { goldens: 'all' } : { runs: [...t.runs] });
const targetQuery = (t: PreviewTarget): PreviewQuery => ('goldens' in t ? { goldens: 'all' } : { runs: t.runs });
const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

/** The value `--set` reads from what was typed: JSON where it parses, else the text. */
export function typedValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The command a dialog shows: the job's own, its targets cut to the first few where it names many. */
export function previewCommand(o: DecisionsArgs): CommandRowProps {
  const argv = decisionsArgv(o);
  const full = draftCommand(argv);
  if (o.targets.length <= CUT) return { command: full };
  const flags = draftCommand(argv.slice(1 + o.targets.length)).slice('shadowlap '.length);
  return { command: `${draftCommand(['decisions', ...o.targets.slice(0, SHOWN)])} … and ${o.targets.length - SHOWN} more ${flags}`.trimEnd(), full };
}

/** `value`, once it has held still for `ms`: a form's read waits for the typing to stop. */
function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** What the change would ask and bill, read again as the form settles; undefined while it is read, null where it can't be. */
function usePreviewRead(target: PreviewTarget, change: Omit<PreviewQuery, 'goldens' | 'runs'>): PreviewEstimates | null | undefined {
  const { client } = useApp();
  const q = { ...targetQuery(target), ...change };
  const key = useSettled(previewQuery(q));
  const read = useLoad(() => client.estimates?.previewEstimates(q) ?? null, `preview-estimate:${key}`);
  return read.data ?? (read.error ? null : undefined);
}

/** Starts the preview, with the estimate its cost line showed, asking a sent golden's consent first. */
function usePreviewStart(target: PreviewTarget, change: Record<string, unknown>, shown: PreviewEstimates | null | undefined, onClose: () => void) {
  const app = useApp();
  // The dialog stays open over a consent question, and closes once the job runs.
  const one = 'runs' in target && target.runs.length === 1 ? target.runs[0]! : null;
  const { start, consent } = useConsentStart('decisions', { ...targetFields(target), ...change }, () => {
    // A preview of one run shows in its Decisions view once it ends, the newest there.
    if (one) dropPick(one);
    onClose();
  });
  return { ok: () => app.guard(() => void start(sentEstimate(shown?.preview ?? null))), consent };
}

export function NewPreview(props: NewPreviewProps) {
  if (props.way === 'model') return <ModelSwitchDialog {...props} />;
  if (props.way === 'code') return <ChangedPromptDialog {...props} />;
  return <FieldChangeDialog {...props} />;
}

const noTargets = (t: PreviewTarget) => 'runs' in t && !t.runs.length;

/** The model a switch's field starts on: the one its card was priced at, else the first offered that the runs don't use most. */
function firstModel(ways: PreviewEstimates | null | undefined, listing: ReturnType<typeof useModelChoices>): string {
  if (ways?.ways?.model) return ways.ways.model;
  const recorded = ways?.recorded ?? [];
  return startModel(fieldModels(recorded, listing ? [...listing.choices, ...listing.priced] : []), recorded[0]?.id ?? null) ?? '';
}

/** A switch's Asks row: the calls made with the model the runs use most, how often each, and the control; nothing for another family. */
function switchAsks(asks: PreviewEstimates['asks'] | undefined, samples: number): DialogFactRows[number] {
  if (!asks) return { label: 'Asks', value: 'nothing yet' };
  if (asks.otherFamily) return { label: 'Asks', value: 'nothing', quiet: 'another family’s request format' };
  const each = samples > 1 ? `, ${samples} samples each${asks.control ? ` and ${samples} as recorded` : ''}` : '';
  return { label: 'Asks', value: `the ${plural(asks.calls, 'call')} made with ${asks.from.join(' or ')}${each}`, quiet: `the model ${asks.runs === 1 ? 'the run uses' : 'the runs use'} most${asks.control ? '; as recorded is the control' : ''}` };
}

function ModelSwitchDialog({ target, onClose }: NewPreviewProps) {
  const listing = useModelChoices();
  const ways = usePreviewRead(target, {});
  const [picked, setModel] = useState<string | null>(null);
  const [samples, setSamples] = useState(3);
  const recorded = ways?.recorded ?? [];
  const model = picked ?? firstModel(ways, listing);
  const named = MODEL_NAME.test(model);
  const read = usePreviewRead(target, named ? { model, ...(samples !== 3 ? { samples } : {}) } : {});
  const est = named ? read : undefined;
  const other = est?.asks.otherFamily ?? null;
  const warn = noTargets(target) ? NO_GOLDENS : other;
  const facts: DialogFactRows = [switchAsks(est?.asks, samples), TOOLS_FACT];
  const start = usePreviewStart(target, { model, ...(samples !== 3 ? { samples } : {}) }, est, onClose);
  const label = confirmWords(ACTIONS.previewModelSwitch.label);
  return (
    <>
      <Dialog
        title={label}
        lead="Asks the model calls again under the model you pick, nothing else changed."
        doc="decisions"
        warn={warn ? { text: warn, tone: 'amber' } : null}
        facts={facts}
        command={previewCommand({ targets: est?.targets ?? ways?.targets ?? [''], model: model || '<model>', ...(samples !== 3 ? { samples } : {}) })}
        cost={warn ? null : { price: 'Billed by your provider', estimate: est?.preview }}
        ok={label}
        okDisabled={!named || !!warn || !est}
        okWhy={other ? SWITCH_IN_CODE : !named ? 'Give a model’s name' : null}
        onOk={start.ok}
        onClose={onClose}
      >
        <div className="form">
          <ModelField value={model} onChange={setModel} recorded={recorded} listing={listing} />
          <label>
            Samples a call
            <select value={samples} onChange={(e) => setSamples(Number(e.currentTarget.value))}>
              {[1, 3, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Dialog>
      {start.consent}
    </>
  );
}

/** What `decisions --from-code --dry-run` answers (the CLI's decisions-read.ts): the working tree's prompt and tools, and each run's changed calls. */
interface TreeRead {
  fromCode: { calls: number; instructions: { before: string; after: string } | null; tools: { added: string[]; removed: string[]; changed: string[] } };
  runs: Array<{ runId: string; golden: string | null; changed: number[]; refused: string | null }>;
  notes: string[];
  nothing: string | null;
}

/** The instructions' change, marked: the common start and end kept, the middle removed and added. */
export function markedChange(before: string, after: string): { head: string; del: string; ins: string; tail: string } {
  let a = 0;
  while (a < before.length && a < after.length && before[a] === after[a]) a++;
  let z = 0;
  while (z < before.length - a && z < after.length - a && before[before.length - 1 - z] === after[after.length - 1 - z]) z++;
  return { head: after.slice(0, a), del: before.slice(a, before.length - z), ins: after.slice(a, after.length - z), tail: after.slice(after.length - z) };
}

const toolWords = (t: TreeRead['fromCode']['tools']) =>
  [t.added.length && `added ${t.added.join(', ')}`, t.removed.length && `removed ${t.removed.join(', ')}`, t.changed.length && `changed ${t.changed.join(', ')}`].filter(Boolean).join('; ') || 'unchanged';

/** Reads what the working tree sends the runs, as a job of its own that it stops on close: null while it reads, `failed` where it couldn't. */
function useTreeRead(target: PreviewTarget): { read: TreeRead | 'failed' | null; consent: ReactElement | null } {
  const app = useApp();
  const [read, setRead] = useState<TreeRead | 'failed' | null>(null);
  const job = useRef<string | null>(null);
  const follow = (v: JobView) => {
    job.current = v.id;
    void untilDone(v, (id, since) => app.client.job(id, since)).then((done) => {
      job.current = null;
      const result = done?.code === 0 ? (done.result as TreeRead | undefined) : undefined;
      setRead(result?.fromCode ? result : 'failed');
    });
  };
  const fields = targetFields(target);
  const { start, consent } = useConsentStartFollowing(fields, follow, () => setRead('failed'));
  useEffect(() => {
    void start({});
    return () => {
      if (job.current) void app.client.stopJob(job.current).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read as the dialog opens, for the targets it opened on, stopped as it closes
  }, []);
  return { read, consent };
}

/** decisions-read started and followed here rather than in the drawer, its consent asked as any job's. */
function useConsentStartFollowing(fields: Record<string, unknown>, follow: (v: JobView) => void, failed: () => void) {
  const app = useApp();
  const [asked, setAsked] = useState<{ why: string; confirm: string } | null>(null);
  const start = (more: Record<string, unknown>) =>
    app.client.startJob('decisions-read', { ...fields, ...more }).then(follow, (err: unknown) => {
      const ask = more.yes === undefined ? consentAsked(err) : null;
      if (ask) setAsked(ask);
      else failed();
    });
  const close = () => {
    setAsked(null);
    failed();
  };
  const consent = asked ? <ConsentDialog why={asked.why} ok="Run command" onClose={close} onOk={() => (setAsked(null), void start({ yes: asked.confirm }))} /> : null;
  return { start, consent };
}

function ChangedPromptDialog({ target, onClose }: NewPreviewProps) {
  const tree = useTreeRead(target);
  const read = tree.read === 'failed' ? null : tree.read;
  const est = usePreviewRead(target, { fromCode: true, samples: 1 });
  const busy = useTreeBusy('reads', 'preview the change');
  const runs = read?.runs ?? [];
  const mine = runs.filter((r) => r.changed.length);
  const calls = mine.reduce((n, r) => n + r.changed.length, 0);
  const unit = 'goldens' in target ? 'golden' : 'run';
  const nothing = (noTargets(target) ? NO_GOLDENS : null) ?? read?.nothing ?? null;
  const ins = read?.fromCode.instructions;
  const marked = ins ? markedChange(ins.before, ins.after) : null;
  const facts: DialogFactRows = [
    { label: 'Reads', value: 'each run, replayed offline', quiet: 'nothing sent, no tool runs' },
    read && !nothing ? { label: 'Asks', value: `${plural(calls, 'model call')}${mine.length < runs.length ? `, in ${mine.length} of ${plural(runs.length, unit)}` : ''}` } : null,
  ];
  const start = usePreviewStart(target, { fromCode: true, samples: 1 }, est, onClose);
  const label = ACTIONS.previewChangedPrompt.label;
  return (
    <>
      <Dialog
        title={label}
        lead="Asks again each model call whose prompt changed, under your working tree’s prompt and tools."
        doc="decisions"
        warn={nothing ? { text: nothing, tone: 'amber' } : null}
        facts={facts}
        command={previewCommand({ targets: est?.targets ?? [''], fromCode: true, samples: 1 })}
        cost={nothing ? null : { price: 'Billed by your provider', estimate: est?.preview ?? null }}
        ok={label}
        okDisabled={!read || !!nothing}
        okWhy={nothing ?? busy ?? (tree.read === null ? 'Reading what your working tree sends' : null)}
        onOk={start.ok}
        onClose={onClose}
      >
        {tree.read === null ? <p className="muted dlgest">Reading what your working tree sends…</p> : null}
        {read && !nothing ? (
          <div className="dprompt">
            <span className="k">The system prompt</span>
            {marked ? (
              <p>
                {marked.head}
                {marked.del ? <del>{marked.del}</del> : null}
                {marked.ins ? <ins>{marked.ins}</ins> : null}
                {marked.tail}
              </p>
            ) : (
              <p>unchanged</p>
            )}
            <span className="k">tool definitions</span>
            <p>{toolWords(read.fromCode.tools)}</p>
          </div>
        ) : null}
      </Dialog>
      {tree.consent}
      {start.consent}
    </>
  );
}

/** The line under a field change's fields: what the recorded answers show, or why it can't run. */
export function fieldLine(field: string, value: string, est: PreviewEstimates | null | undefined): string | null {
  if (field === 'model') return 'model is not a request field to set: give the model with Preview model switch…';
  if (!FIELD_NAME.test(field)) return 'A field’s name: letters, digits, _ and dots; a dotted name is a path.';
  if (value === '') return 'Give it a value: a number, a word, or JSON.';
  if (!est) return null;
  if (est.refused) return `${est.refused.says}: its steps would get no answer.`;
  if (field === 'max_tokens') return est.answers.most === null ? null : `The recorded answers used up to ${est.answers.most.toLocaleString('en-US')} output tokens${est.answers.cut ? `: ${plural(est.answers.cut, 'answer')} would be cut off.` : '.'}`;
  return 'Every call is asked with it, the agent’s and any other’s.';
}

function FieldChangeDialog({ target, onClose }: NewPreviewProps) {
  const [field, setField] = useState('max_tokens');
  const [value, setValue] = useState('512');
  const bad = !FIELD_NAME.test(field) || field === 'model' || value === '';
  const est = usePreviewRead(target, bad ? {} : { set: [[field, value]], samples: 1 });
  const shown = bad ? undefined : est;
  const none = noTargets(target) ? NO_GOLDENS : null;
  const text = fieldValue(typedValue(value));
  const start = usePreviewStart(target, { set: { [field]: typedValue(value) }, samples: 1 }, shown, onClose);
  const label = confirmWords(ACTIONS.previewFieldChange.label);
  return (
    <>
      <Dialog
        title={label}
        lead="Asks each recorded model call again with this request field set, nothing else changed."
        doc="decisions"
        warn={none ? { text: none, tone: 'amber' } : null}
        facts={[TOOLS_FACT]}
        command={previewCommand({ targets: est?.targets ?? [''], set: [[field || '<key>', value ? text : '<value>']], samples: 1 })}
        cost={bad || none ? null : { price: 'Billed by your provider', estimate: shown?.preview }}
        ok={label}
        okDisabled={bad || !!none || !shown}
        onOk={start.ok}
        onClose={onClose}
      >
        <div className="form">
          <label>
            <span className="dtip" tabIndex={0} data-tip={tipCard('Set where its provider keeps it', [], 'temperature is generationConfig.temperature on Gemini')}>
              Field
            </span>
            <input type="text" value={field} spellCheck={false} autoComplete="off" onChange={(e) => setField(e.currentTarget.value.trim())} />
          </label>
          <label>
            Value
            <input type="text" value={value} spellCheck={false} autoComplete="off" onChange={(e) => setValue(e.currentTarget.value.trim())} />
          </label>
        </div>
        {none ? null : <p className="muted dlgest">{fieldLine(field, value, shown) ?? ' '}</p>}
      </Dialog>
      {start.consent}
    </>
  );
}
