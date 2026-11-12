import { useEffect, useRef, useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { amountWords } from '../../../engine/src/estimates/spending.js';
import type { Spending } from '../../../engine/src/estimates/spending.js';
import type { PayloadTemplate } from '../../../engine/src/injection.js';
import { defaultTemplates } from '../../src/injection-defaults.js';
import type { PayloadsRead } from '../../src/injection.js';
import { consentAsked } from '../actions.js';
import { JOB_KINDS } from '../api.js';
import { ConsentDialog, Dialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { Skeleton } from '../components/States.js';
import { Term } from '../components/Term.js';
import { useTreeBusy } from '../fixes/tree.js';
import { plural, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { sentEstimate, useSpending } from '../spending.js';
import { guardedWayOn, useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { UntrustedView } from '../types.js';
import { readsWords } from './reads-words.js';
import { TemplatePicks, usePlanEstimate } from './TemplatePicks.js';
import './job-footer.js';

/*
 * Run injection test…'s dialog, a part only the served dashboard hands in (served-parts.ts): a copy
 * runs nothing, so its script holds none of it. Every opener (the fork menu's whole run, the lime
 * step, a read's row on Settings → Tools, Tests' Security, the palette) opens this one dialog on the
 * run it tests. What it bills is the server's, asked again a moment after each pick (the estimators
 * read node modules, so the browser never works out a price), and the job it starts is `injection`.
 */

export interface TestDialogProps {
  /** The run it plants in, one of the store's; null for a golden whose recording only its pack holds. */
  runId: string | null;
  /** The golden it tests where the store doesn't hold its recording. */
  golden?: string | null | undefined;
  /** The recording's id, for the title where `runId` is null. */
  recording?: string | undefined;
  /** The run's untrusted reads where the page has them; read here otherwise. */
  reads?: readonly UntrustedView[] | undefined;
  /** What it bills at the plan nobody picked, where the opener has it; asked here otherwise. */
  estimate?: Estimate | null | undefined;
  /** Why the step leads (`It stopped at its budget: …`): the amber line, over the bill's. */
  why?: string | null | undefined;
  onClose: () => void;
}

const LEAD_DOC = 'injectionTests';
const PICK = 'Pick a template or add a payload file.';
const MAX_REPEAT = 100;

/** A payload file as the dialog holds it: being read, read, or refused with why. */
type PayloadFile = { name: string; reading: true } | { name: string; uploadId: string; read: PayloadsRead } | { name: string; error: string };

/** What the person picked: the templates, in the set's order, a payload file, attempts each, Stop at $. */
interface Picks {
  templates: string[];
  file: PayloadFile | null;
  repeat: string;
  budget: string;
}

const attempts = (p: Picks): number => Math.max(1, Math.min(MAX_REPEAT, Math.trunc(Number(p.repeat)) || 1));
const stopAt = (p: Picks): number | null => {
  const b = Number(p.budget);
  return p.budget.trim() && Number.isFinite(b) && b > 0 ? Math.round(b * 100) / 100 : null;
};
const fileRead = (f: PayloadFile | null) => (f && 'read' in f ? f : null);

/** The templates as the job takes them: every one is the CLI's default, so no flag, unless a payload file comes with them. */
function templatesField(p: Picks, all: readonly string[]): 'all' | 'none' | string[] | undefined {
  if (!p.templates.length) return 'none';
  if (p.templates.length < all.length) return p.templates;
  return fileRead(p.file) ? 'all' : undefined;
}

/** The command the test runs as picked: each flag kept with its value, the template list breaking only after its commas (Command). */
export function testCommand(id: string, p: Picks, all: readonly string[]): string {
  const t = templatesField(p, all);
  const file = fileRead(p.file);
  const repeat = attempts(p);
  const budget = stopAt(p);
  return [
    'shadowlap injection',
    id,
    ...(t === undefined || (t === 'none' && file) ? [] : [`--templates ${Array.isArray(t) ? t.join(',') : t}`]),
    ...(file ? [`--payloads ${file.name}`] : []),
    ...(repeat > 1 ? [`--repeat ${repeat}`] : []),
    ...(budget ? [`--budget ${budget.toFixed(2)}`] : []),
  ].join(' ');
}

/** A bill many times what Spending asks above, with no Stop at $ under it: over twenty times the threshold (at least $10), or $100 with Never ask. */
export function bigBill(e: Estimate | null | undefined, askAbove: Spending | undefined): string | null {
  if (!e || e.usd === null || askAbove === undefined || (e.stops !== undefined && e.stops < e.usd)) return null;
  const over = askAbove === null ? 100 : Math.max(askAbove, 0.5) * 20;
  return e.usd > over ? `${amountWords(e.usd)} at these picks: set Stop at $ to stop it there` : null;
}

export function TestDialog(props: TestDialogProps) {
  const { client } = useApp();
  const set = useLoad(() => client.injectionTemplates(), 'injection-templates');
  const asked = useLoad(() => (props.reads || !props.runId ? null : client.injectionRun(props.runId)), `${props.runId ?? props.golden ?? ''}:test-reads`);
  const reads = props.reads ?? asked.data?.untrusted ?? (props.runId ? null : []);
  const failed = set.error ?? asked.error;
  // The title names the recording; the command runs on the golden where the store doesn't hold it.
  const named = props.runId || props.recording ? shortId(props.runId ?? props.recording ?? '') : (props.golden ?? '');
  const id = props.runId ? shortId(props.runId) : (props.golden ?? '');
  const title = namedIn(`${confirmWords(ACTIONS.runInjectionTest.label)} on ${named}`, named);
  if (!set.data || !reads) {
    return (
      <Dialog title={title} lead={<Lead />} doc={LEAD_DOC} warn={failed ? { text: errorText(failed), tone: 'red' } : null} ok={confirmWords(ACTIONS.runInjectionTest.label)} okWhy={failed ? errorText(failed) : 'Reading what the test plants in'} onClose={props.onClose}>
        {failed ? null : <Skeleton what="the run’s untrusted reads" lines={3} />}
      </Dialog>
    );
  }
  // It plants in the reads a model call reads; one no model reads is never planted in.
  return <TestForm {...props} id={id} title={title} all={set.data.templates} reads={reads.filter((r) => r.readAt !== null)} />;
}

function Lead() {
  return (
    <>
      Plants each payload, with its own <Term k="canary" />, in the run’s untrusted reads and runs the agent from the call that reads it.
    </>
  );
}

/** The dialog once the templates and the reads are in: the picks, what they bill, and the consent a command from elsewhere asks. */
function TestForm(props: TestDialogProps & { id: string; title: ReturnType<typeof namedIn>; all: readonly PayloadTemplate[]; reads: readonly UntrustedView[] }) {
  const app = useApp();
  const { all, reads, runId } = props;
  const ids = all.map((t) => t.id);
  const [picks, setPicks] = useState<Picks>(() => ({ templates: [...(defaultTemplates(reads.length) ?? ids)], file: null, repeat: '1', budget: '' }));
  const [consent, setConsent] = useState<{ why: string; confirm: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const payloads = picks.templates.length + (fileRead(picks.file)?.read.count ?? 0);
  const estimate = usePlanEstimate({ runId, golden: props.golden }, { payloads, repeat: attempts(picks), budget: stopAt(picks) }, props.estimate);
  const askAbove = useSpending();
  const busy = useTreeBusy('reads', 'test it');
  const fields = () => {
    const t = templatesField(picks, ids);
    const file = fileRead(picks.file);
    const repeat = attempts(picks);
    const budget = stopAt(picks);
    return { ...(runId ? { runId } : { golden: props.golden }), ...(t !== undefined ? { templates: t } : {}), ...(file ? { payloadsUpload: file.uploadId } : {}), ...(repeat > 1 ? { repeat } : {}), ...(budget ? { budget } : {}), ...sentEstimate(estimate) };
  };
  // The yes to a command someone else recorded sends the same fields again; a refusal after it opens the dialog again with the server's words.
  const start = (yes?: string): Promise<boolean> =>
    app.client.startJob(JOB_KINDS.injection, yes === undefined ? fields() : { ...fields(), yes }).then(
      (job) => {
        app.watchJob(Promise.resolve(job));
        return true;
      },
      (err: unknown) => {
        const ask = yes === undefined ? consentAsked(err) : null;
        setConsent(ask ? { why: ask.why, confirm: ask.confirm } : null);
        if (!ask) setRefused(errorText(err));
        return false;
      },
    );
  if (consent) return <ConsentDialog why={consent.why} ok={confirmWords(ACTIONS.runInjectionTest.label)} onClose={props.onClose} onOk={() => guardedWayOn(app.guard, () => start(consent.confirm))} />;
  const big = bigBill(estimate, askAbove);
  const warn = refused ?? props.why ?? big;
  return (
    <Dialog
      title={props.title}
      lead={<Lead />}
      doc={LEAD_DOC}
      className="injdlg"
      warn={warn ? { text: warn } : null}
      facts={[{ label: 'Plants in', value: readsWords(reads, true) }]}
      command={testCommand(props.id, picks, ids)}
      cost={payloads ? { price: 'Billed by your provider', parts: ['live from each read, writes stubbed'], estimate } : { price: PICK, estimate: null }}
      ok={confirmWords(ACTIONS.runInjectionTest.label)}
      okWhy={payloads ? busy : PICK}
      dirty={!!picks.file}
      onOk={() => guardedWayOn(app.guard, () => start())}
      onClose={props.onClose}
    >
      <TemplatePicks all={all} why={defaultTemplates(reads.length) ? `fewer to start: ${reads.length} reads multiply the cost` : null} picked={picks.templates} onPick={(templates) => setPicks((p) => ({ ...p, templates }))} />
      <PayloadFilePick file={picks.file} onFile={(file) => setPicks((p) => ({ ...p, file }))} />
      <div className="injsec injnums">
        <label className="injrep">
          Attempts each
          <input type="number" min={1} max={MAX_REPEAT} value={picks.repeat} onChange={(e) => setPicks((p) => ({ ...p, repeat: e.target.value }))} />
        </label>
        <label className="injrep">
          Stop at $
          <input type="number" min={0.5} step={0.5} placeholder="none" value={picks.budget} onChange={(e) => setPicks((p) => ({ ...p, budget: e.target.value }))} />
        </label>
      </div>
    </Dialog>
  );
}

/** Your own payloads: Add payload file…, then the file's chip with its × and what it holds; the focus goes from one to the other as each takes the other's place. */
function PayloadFilePick({ file, onFile }: { file: PayloadFile | null; onFile: (f: PayloadFile | null) => void }) {
  const { client } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const drop = useRef<HTMLButtonElement>(null);
  const focusTo = useRef<'add' | 'drop' | null>(null);
  useEffect(() => {
    const to = focusTo.current === 'drop' ? drop.current : focusTo.current === 'add' ? add.current : null;
    if (!to) return;
    focusTo.current = null;
    to.focus();
  });
  const pick = (f: File | undefined) => {
    if (!f) return;
    onFile({ name: f.name, reading: true });
    void client
      .upload(f, f.name)
      .then((up) => client.injectionPayloads(up.uploadId).then((read) => ({ name: read.name, uploadId: up.uploadId, read })))
      .then(
        (read) => {
          focusTo.current = 'drop';
          onFile(read);
        },
        (err: unknown) => {
          focusTo.current = 'add';
          onFile({ name: f.name, error: errorText(err) });
        },
      );
  };
  const read = fileRead(file);
  return (
    <>
      <div className="injsec">
        <span className="k">Your own payloads</span>
      </div>
      <div className="injfile">
        <input ref={input} type="file" accept=".txt,.json,.jsonl,text/plain,application/json" hidden onChange={(e) => pick(e.target.files?.[0] ?? undefined)} />
        {read ? (
          <>
            <span className="chip">
              {read.name} · {plural(read.read.count, 'payload')}
              <button
                ref={drop}
                type="button"
                aria-label={`Leave ${read.name} out`}
                onClick={() => {
                  focusTo.current = 'add';
                  if (input.current) input.current.value = '';
                  onFile(null);
                }}
              >
                ×
              </button>
            </span>
            <small>{read.read.noCanary.length ? `${read.read.noCanary.join(', ')} has no {{canary}}: it can show influence, never prove it obeyed` : '{{canary}} in each is filled in'}</small>
          </>
        ) : file && 'reading' in file ? (
          <small>Reading {file.name}…</small>
        ) : (
          <>
            <button ref={add} className="btn sm" type="button" onClick={() => input.current?.click()}>
              Add payload file…
            </button>
            <small className={file && 'error' in file ? 'err' : undefined}>{file && 'error' in file ? file.error : 'a red-teaming tool’s or your own: text, JSON or JSON Lines, {{canary}} filled in'}</small>
          </>
        )}
      </div>
    </>
  );
}
