import { useEffect, useRef, useState, type ReactElement } from 'react';
import { fieldValue } from '../../../engine/src/field-value.js';
import { decisionsArgv, FIELD_NAME, MODEL_NAME, typedValue, type DecisionsArgs } from '../../src/decisions-argv.js';
import { fieldModels, startModel } from '../../src/model-order.js';
import type { CommandRowProps } from '../components/CommandRow.js';
import { Dialog } from '../components/Dialog.js';
import type { DialogFactRows } from '../components/DialogFacts.js';
import { tipCard } from '../components/HoverCard.js';
import { ModelField, useModelChoices } from '../components/ModelField.js';
import { failedRead } from '../components/States.js';
import { NO_GOLDENS, noTargets, type PreviewTarget, type PreviewWay } from '../components/NewPreviewMenu.js';
import { previewBody, type PreviewEstimates, type PreviewQuery } from '../estimates-api.js';
import { useConsentStart } from '../fixes/FixJobButton.js';
import { narrowed, NarrowFields, narrowWhy, WHOLE, type Narrow } from './narrow.js';
import { pickSession } from '../run/decisions-pick.js';
import { useTreeBusy } from '../fixes/tree.js';
import { useLoad, useSettled } from '../hooks.js';
import { draftCommand } from '../job-title.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { untilDone } from '../runspage/push.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { JobView } from '../types.js';

/**
 * New preview's three dialogs: Preview model switch…, Preview changed prompt and Preview field
 * change…. Each says what it asks and what that costs as its form changes (POST
 * /api/decisions/estimates), shows the command its job runs, built by the job's own helper
 * (decisions-argv.ts), and starts `decisions` with the estimate it showed. Its confirm waits, saying
 * why, until what it asks is read. The served dashboard hands them in (pages/served.tsx), loaded on
 * demand, so an exported copy holds none of them.
 */

export interface NewPreviewProps {
  way: PreviewWay;
  target: PreviewTarget;
  onClose: () => void;
}

const TOOLS_FACT = { label: 'Tools', value: 'none run', quiet: 'nothing reaches the world' };
/** Why a confirm waits while what it asks is read, and where that read failed. */
const READING = 'Reading what it asks…';
const readFailed = (why: string) => `What it asks didn’t load: ${why}`;
/** A command naming more targets than this shows the first few and how many more, its Copy taking it whole. */
const CUT = 6;
const SHOWN = 3;

/** The targets as the job and its estimate take them: every golden, those picked of them (`picked`), or the runs. */
const targetFields = (t: PreviewTarget, picked: readonly string[] | null = null): Record<string, unknown> => ('goldens' in t ? { goldens: picked ? [...picked] : 'all' } : { runs: [...t.runs] });
const targetQuery = (t: PreviewTarget, picked: readonly string[] | null = null): PreviewQuery => ('goldens' in t ? { goldens: picked ?? 'all' } : { runs: t.runs });
/** The targets a command names: the goldens picked, else as the read answers with the goldens' paths, else the runs, else `…`. */
const shownTargets = (t: PreviewTarget, read: readonly string[] | undefined): readonly string[] => read ?? ('runs' in t ? t.runs : ['']);
const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

/** The command a dialog shows: the job's own, its targets cut to the first few where it names many. */
export function previewCommand(o: DecisionsArgs): CommandRowProps {
  const argv = decisionsArgv(o);
  const full = draftCommand(argv);
  if (o.targets.length <= CUT) return { command: full };
  const flags = draftCommand(argv.slice(1 + o.targets.length)).slice('shadowlap '.length);
  return { command: `${draftCommand(['decisions', ...o.targets.slice(0, SHOWN)])} … and ${o.targets.length - SHOWN} more ${flags}`.trimEnd(), full };
}

/**
 * What the change would ask and bill, read again as the form settles: `est` undefined while it is
 * read, `failed` why it couldn't be, in the line every page says (`failedRead`). `off` reads nothing;
 * `picked`, the goldens picked of every golden.
 */
function usePreviewRead(target: PreviewTarget, change: Omit<PreviewQuery, 'goldens' | 'runs'>, off = false, picked: readonly string[] | null = null): { est: PreviewEstimates | undefined; failed: string | null } {
  const { client } = useApp();
  const q = { ...targetQuery(target, picked), ...change };
  const key = useSettled(off ? '' : JSON.stringify(previewBody(q)));
  const read = useLoad(() => (off ? null : (client.estimates?.previewEstimates(q) ?? null)), `preview-estimate:${key}`);
  return { est: read.data ?? undefined, failed: !off && read.error ? failedRead(read.error) : null };
}

/**
 * Starts the preview, with the estimate its cost line showed, asking a sent golden's consent first,
 * unless its read of the working tree was given the yes (`yes`), which the same commands carry. A
 * preview of one run is picked in that run's Decisions view once it ends with its session.
 */
function usePreviewStart(target: PreviewTarget, change: Record<string, unknown>, shown: PreviewEstimates | null | undefined, onClose: () => void, yes: string | null = null, picked: readonly string[] | null = null) {
  const app = useApp();
  const one = 'runs' in target && target.runs.length === 1 ? target.runs[0]! : null;
  const { start, consent } = useConsentStart('decisions', { ...targetFields(target, picked), ...change, ...(yes ? { yes } : {}) }, {
    started: (job) => {
      if (one) void untilDone(job, (id, since) => app.client.job(id, since), { ms: 2000 }).then((done) => pickEnded(one, done));
      onClose();
    },
  });
  return { ok: () => app.guard(() => void start(sentEstimate(shown?.preview ?? null))), consent };
}

/** A one-run preview that ended with its session (the job's result, the CLI's report): shown in its run's Decisions view. */
function pickEnded(runId: string, done: JobView | null): void {
  const id = (done?.result as { decisionsId?: unknown } | null | undefined)?.decisionsId;
  if (typeof id === 'string') pickSession(runId, id);
}

/**
 * Every golden it opened on, as the first read with none picked named them, kept as goldens are
 * picked, for the narrowing's chips; null where it opened on runs.
 */
function useAllGoldens(target: PreviewTarget, est: PreviewEstimates | undefined, n: Narrow): readonly string[] | null {
  const [all, setAll] = useState<readonly string[] | null>(null);
  const read = 'goldens' in target && n.goldens === null ? est?.targets : undefined;
  useEffect(() => {
    if (read) setAll(read);
  }, [read]);
  return 'goldens' in target ? all : null;
}

export function NewPreview(props: NewPreviewProps) {
  if (props.way === 'model') return <ModelSwitchDialog {...props} />;
  if (props.way === 'code') return <ChangedPromptDialog {...props} />;
  return <FieldChangeDialog {...props} />;
}

/** The model a switch's field starts on: the one its card was priced at, else the first offered that the runs don't use most. */
function firstModel(ways: PreviewEstimates | null | undefined, listing: ReturnType<typeof useModelChoices>): string {
  if (ways?.ways?.model) return ways.ways.model;
  const recorded = ways?.recorded ?? [];
  return startModel(fieldModels(recorded, listing ? [...listing.choices, ...listing.priced] : []), recorded[0]?.id ?? null) ?? '';
}

/** Models as code, joined by `or`. */
function codes(models: readonly string[]): ReactElement {
  return (
    <>
      {models.map((m, i) => (
        <span key={m}>
          {i ? ' or ' : ''}
          <code>{m}</code>
        </span>
      ))}
    </>
  );
}

/** A switch's Asks row: the calls made with the model the runs use most, how often each, and the control; nothing for another family. */
function switchAsks(asks: PreviewEstimates['asks'] | undefined, samples: number): DialogFactRows[number] {
  if (!asks) return { label: 'Asks', value: 'nothing yet' };
  if (asks.otherFamily) return { label: 'Asks', value: 'nothing', quiet: 'another family’s request format' };
  const each = samples > 1 ? `, ${samples} samples each${asks.control ? ` and ${samples} as recorded` : ''}` : '';
  return {
    label: 'Asks',
    value: (
      <>
        the {plural(asks.calls, 'call')} made with {codes(asks.from)}
        {each}
      </>
    ),
    quiet: `the model ${asks.runs === 1 ? 'the run uses' : 'the runs use'} most${asks.control ? '; as recorded is the control' : ''}`,
  };
}

/** Why a switch's confirm waits, the first that holds: what the dialog warns of, a model to name, the narrowing, a read that failed or is still out. */
function switchWhy(o: { warn: string | null; named: boolean; n: Narrow; failed: string | null; read: boolean }): string | null {
  if (o.warn) return o.warn;
  if (!o.named) return 'Give a model’s name';
  return narrowWhy(o.n) ?? (o.failed ? readFailed(o.failed) : o.read ? null : READING);
}

/** Every golden a read of the whole target named, for the narrowing's chips; null where it opened on runs. */
const wholeGoldens = (target: PreviewTarget, est: PreviewEstimates | undefined): readonly string[] | null => ('goldens' in target ? (est?.targets ?? null) : null);

function ModelSwitchDialog({ target, onClose }: NewPreviewProps) {
  const listing = useModelChoices();
  const none = noTargets(target);
  const ways = usePreviewRead(target, {}, none);
  const [picked, setModel] = useState<string | null>(null);
  const [samples, setSamples] = useState(3);
  const [n, setNarrow] = useState<Narrow>(WHOLE);
  const recorded = ways.est?.recorded ?? [];
  const model = picked ?? firstModel(ways.est, listing);
  const named = MODEL_NAME.test(model);
  const sampled = samples !== 3 ? { samples } : {};
  const change = { model, ...sampled, ...narrowed(n) };
  const read = usePreviewRead(target, change, none || !named, n.goldens);
  const est = named ? read.est : undefined;
  // Another family's model asks nothing: the engine's words are the warning and why the confirm waits.
  const warn = none ? NO_GOLDENS : (est?.asks.otherFamily ?? null);
  const failed = read.failed ?? (named ? null : ways.failed);
  const why = switchWhy({ warn, named, n, failed, read: !!est });
  const facts: DialogFactRows = [switchAsks(est?.asks, samples), TOOLS_FACT];
  const start = usePreviewStart(target, change, est, onClose, null, n.goldens);
  const label = confirmWords(ACTIONS.previewModelSwitch.label);
  return (
    <>
      <Dialog
        title={label}
        lead="Asks the model calls again under the model you pick, nothing else changed."
        doc="decisions"
        warn={warn ? { text: warn, tone: 'amber' } : null}
        facts={facts}
        command={none ? null : previewCommand({ targets: shownTargets(target, n.goldens ?? est?.targets ?? ways.est?.targets), model: model || '<model>', ...sampled, ...narrowed(n) })}
        cost={warn ? null : { price: 'Billed by your provider', estimate: est?.preview }}
        ok={label}
        okWhy={why}
        onOk={start.ok}
        onClose={onClose}
      >
        <div className="form">
          <ModelField value={model} onChange={setModel} recorded={recorded} listing={listing} />
          <label>
            Samples a call
            <select value={samples} onChange={(e) => setSamples(Number(e.currentTarget.value))}>
              {[1, 3, 5].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        </div>
        {none ? null : <NarrowFields n={n} onChange={setNarrow} est={ways.est} goldens={wholeGoldens(target, ways.est)} way="model" />}
        {failed && !warn ? <p className="muted dlgest">{readFailed(failed)}</p> : null}
      </Dialog>
      {start.consent}
    </>
  );
}

/** What `decisions --from-code --dry-run` answers (the CLI's decisions-read.ts): the working tree's prompt and tools, each run's changed calls, and the scope whose prompt it is. */
interface TreeRead {
  fromCode: { calls: number; instructions: { before: string; after: string } | null; tools: { added: string[]; removed: string[]; changed: string[] } };
  runs: Array<{ runId: string; golden: string | null; changed: number[]; refused: string | null }>;
  notes: string[];
  nothing: string | null;
  scope?: string | null;
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

/** A read of the working tree: what it answered, why it couldn't (`failed`), or null while it reads. */
type TreeState = TreeRead | { failed: string } | null;

/** Why the working tree's read gave nothing: its command's question closed unanswered, or the read refused or ended badly. */
const DECLINED = 'Its command wasn’t confirmed, so nothing was read';
const treeFailed = (why: string) => `What your working tree sends didn’t load: ${why}`;

/**
 * Reads what the working tree sends the runs, as a job of its own (decisions-read) that it follows
 * here rather than in the drawer and stops on close, its consent asked as any job's start asks it
 * (useConsentStart), whose yes the preview's start then carries. `off` reads nothing.
 */
function useTreeRead(target: PreviewTarget, off: boolean): { read: TreeState; consent: ReactElement | null; yes: string | null } {
  const app = useApp();
  const [read, setRead] = useState<TreeState>(null);
  const job = useRef<string | null>(null);
  const follow = (v: JobView) => {
    job.current = v.id;
    void untilDone(v, (id, since) => app.client.job(id, since)).then((done) => {
      job.current = null;
      const result = done?.code === 0 ? (done.result as TreeRead | undefined) : undefined;
      setRead(result?.fromCode ? result : { failed: treeFailed(done ? `the read ended with exit code ${done.code ?? 'none'}` : 'the dashboard lost the read') });
    });
  };
  const { start, consent, yes } = useConsentStart('decisions-read', targetFields(target), { follow: true, started: follow, failed: (err) => setRead({ failed: err === null ? DECLINED : treeFailed(err instanceof Error ? failedRead(err) : errorText(err)) }) });
  useEffect(() => {
    if (!off) void start({});
    return () => {
      if (job.current) void app.client.stopJob(job.current).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read as the dialog opens, for the targets it opened on, stopped as it closes
  }, []);
  return { read, consent, yes };
}

/** The label over the prompt: the agent's whose call it changes first, by its scope. */
const promptLabel = (scope: string | null | undefined): string => (scope ? `The ${scope}’s system prompt` : 'The system prompt');

/** The line under a changed prompt's facts while its read is out, or why it or its price couldn't be read. */
function TreeLines({ reading, failed }: { reading: boolean; failed: string | null }) {
  if (reading) return <p className="muted dlgest">Reading what your working tree sends…</p>;
  return failed ? <p className="muted dlgest">{failed}</p> : null;
}

/** The Asks row of a read: the calls the working tree changes, and in how many of the runs where not all. */
function treeAsks(read: TreeRead, unit: string): DialogFactRows[number] {
  const mine = read.runs.filter((r) => r.changed.length);
  const calls = mine.reduce((n, r) => n + r.changed.length, 0);
  return { label: 'Asks', value: `${plural(calls, 'model call')}${mine.length < read.runs.length ? `, in ${mine.length} of ${plural(read.runs.length, unit)}` : ''}` };
}

/** What the working tree sends: its system prompt, the change marked, and its tool definitions. */
function PromptChange({ read }: { read: TreeRead }) {
  const ins = read.fromCode.instructions;
  const marked = ins ? markedChange(ins.before, ins.after) : null;
  return (
    <div className="dprompt">
      <span className="k">{promptLabel(read.scope)}</span>
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
  );
}

/** A changed prompt's dialog state: the working tree's read, its price once read (with its Stop at $ and Then verify, `n`), and why the confirm waits. */
function useChangedPrompt(target: PreviewTarget, n: Narrow) {
  const none = noTargets(target);
  const tree = useTreeRead(target, none);
  const read = tree.read && 'fromCode' in tree.read ? tree.read : null;
  const failed = tree.read && 'failed' in tree.read ? tree.read.failed : null;
  // Priced once the read has named the calls the working tree changes: asked once, never while it reads.
  const changed = read ? Object.fromEntries(read.runs.map((r) => [r.runId, r.changed])) : undefined;
  const priced = usePreviewRead(target, { fromCode: true, samples: 1, ...narrowed(n), ...(changed ? { changed } : {}) }, none || !read || !!read.nothing);
  const busy = useTreeBusy('reads', 'preview the change');
  const nothing = (none ? NO_GOLDENS : null) ?? read?.nothing ?? null;
  const facts: DialogFactRows = [{ label: 'Reads', value: 'each run, replayed offline', quiet: 'nothing sent, no tool runs' }, read && !nothing ? treeAsks(read, 'goldens' in target ? 'golden' : 'run') : null];
  const why = nothing ?? failed ?? busy ?? (read ? narrowWhy(n) : 'Reading what your working tree sends');
  const line = failed ?? (priced.failed && read && !nothing ? readFailed(priced.failed) : null);
  return { none, tree, read, priced, nothing, facts, why, line };
}

function ChangedPromptDialog({ target, onClose }: NewPreviewProps) {
  const [n, setNarrow] = useState<Narrow>(WHOLE);
  const { none, tree, read, priced, nothing, facts, why, line } = useChangedPrompt(target, n);
  const start = usePreviewStart(target, { fromCode: true, samples: 1, ...narrowed(n) }, priced.est, onClose, tree.yes);
  const label = ACTIONS.previewChangedPrompt.label;
  return (
    <>
      <Dialog
        title={label}
        lead="Asks again each model call whose prompt changed, under your working tree’s prompt and tools."
        doc="decisions"
        warn={nothing ? { text: nothing, tone: 'amber' } : null}
        facts={facts}
        command={none ? null : previewCommand({ targets: shownTargets(target, priced.est?.targets), fromCode: true, samples: 1, ...narrowed(n) })}
        cost={nothing ? null : { price: 'Billed by your provider', estimate: priced.est?.preview ?? null }}
        ok={label}
        okWhy={why}
        onOk={start.ok}
        onClose={onClose}
      >
        <TreeLines reading={tree.read === null && !none} failed={line} />
        {read && !nothing ? <PromptChange read={read} /> : null}
        {read && !nothing ? <NarrowFields n={n} onChange={setNarrow} est={priced.est} goldens={null} way="code" /> : null}
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
  // What was typed, kept whole so a value can hold a space; trimmed where it is read.
  const [typed, setValue] = useState('512');
  const value = typed.trim();
  const bad = !FIELD_NAME.test(field) || field === 'model' || value === '';
  const none = noTargets(target);
  const [n, setNarrow] = useState<Narrow>(WHOLE);
  const read = usePreviewRead(target, bad ? {} : { set: [[field, value]], samples: 1, ...narrowed(n) }, none || bad, n.goldens);
  const shown = bad ? undefined : read.est;
  const goldens = useAllGoldens(target, read.est, n);
  const text = fieldValue(typedValue(value));
  const start = usePreviewStart(target, { set: { [field]: typedValue(value) }, samples: 1, ...narrowed(n) }, shown, onClose, null, n.goldens);
  const label = confirmWords(ACTIONS.previewFieldChange.label);
  const line = read.failed ? readFailed(read.failed) : fieldLine(field, value, shown);
  const why = none ? NO_GOLDENS : bad ? line : (narrowWhy(n) ?? (read.failed ? line : !shown ? READING : null));
  return (
    <>
      <Dialog
        title={label}
        lead="Asks each recorded model call again with this request field set, nothing else changed."
        doc="decisions"
        warn={none ? { text: NO_GOLDENS, tone: 'amber' } : null}
        facts={[TOOLS_FACT]}
        command={none ? null : previewCommand({ targets: shownTargets(target, n.goldens ?? read.est?.targets), set: [[field || '<key>', value ? text : '<value>']], samples: 1, ...narrowed(n) })}
        cost={bad || none ? null : { price: 'Billed by your provider', estimate: shown?.preview }}
        ok={label}
        okWhy={why}
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
            <input type="text" value={typed} spellCheck={false} autoComplete="off" onChange={(e) => setValue(e.currentTarget.value)} />
          </label>
        </div>
        {none ? null : <p className="muted dlgest">{line ?? ' '}</p>}
        {none ? null : <NarrowFields n={n} onChange={setNarrow} est={read.est} goldens={goldens} way="field" />}
      </Dialog>
      {start.consent}
    </>
  );
}
