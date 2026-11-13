import { useId, useState, type ReactNode } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { PayloadTemplate } from '../../../engine/src/injection.js';
import { consentAsked } from '../actions.js';
import { JOB_KINDS, type RunOffers } from '../api.js';
import type { ChecksConfig } from '../checks-api.js';
import { CodeBox } from '../components/CodeBox.js';
import { ConsentDialog, Dialog, pressWayOn } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { Term } from '../components/Term.js';
import { useTestsWait } from '../fixes/tree.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { PACK_HOLDS, packTestCommands, redactsFact } from '../run/share-facts.js';
import { PACK_VERB } from '../run/share-steps.js';
import { sentEstimate } from '../spending.js';
import { guardedWayOn, useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { GateEntry, UntrustedView } from '../types.js';
import { readsWords } from './reads-words.js';
import { ReadsWait, TemplatePicks, usePlanEstimate } from './TemplatePicks.js';
import './job-footer.js';

/*
 * Pack with injection gate…'s dialog, a part only the served dashboard hands in (served-parts.ts): a
 * copy runs nothing, so its script holds none of it. The run's lime step opens it where a read is
 * proven to have caused a write, or an attempt obeyed (`pack-gate`). It starts one `pack-test` job
 * with the gate: the run packed as a golden, the gate written into its tests entry against the
 * version of shadowlap.config.json read here, then its test (src/pack-gate.ts). What a test session
 * of it bills is the server's, asked again a moment after each pick.
 */

export interface PackWithGateProps {
  /** The run it packs: on an attempt's page, the run the attempt tested, as the step names it. */
  runId: string;
  /** The golden's folder it starts on, `goldens/<id>`; the engine's rule puts a bare name under goldens/. */
  folder: string;
  /** The gate the step offers, three attempts each. */
  gate: GateEntry;
  /** What each test session of it bills with every template, the step's. */
  estimate?: Estimate | null | undefined;
  /** The run's copy formats, for what its pack redacts. */
  offers: RunOffers | null;
  onClose: () => void;
}

const DOC = 'injectionGate';
const NONE = 'Pick a template: a gate plants at least one.';
const MAX_REPEAT = 100;
const CHANGES = { label: 'Changes', value: 'your working tree', quiet: 'the golden’s folder, and the entry below' };
const OK = confirmWords(ACTIONS.packWithGate.label);

/** The gate the job writes: every template is the default, so `templates` only when not all. */
function gateOf(templates: readonly string[], all: readonly string[], repeat: number): { obeyed: 0; repeat: number; templates?: string[] } {
  return { obeyed: 0, repeat, ...(templates.length < all.length ? { templates: [...templates] } : {}) };
}

/** The entry it adds under `tests`, laid out a level a line, the gate's settings on one: what the dialog shows and its Copy takes. */
export function gateEntryText(folder: string, gate: ReturnType<typeof gateOf>): string {
  const settings = Object.entries(gate)
    .map(([k, v]) => `${JSON.stringify(k)}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v)}`)
    .join(', ');
  return `"tests": {\n  ${JSON.stringify(folder)}: {\n    "injection": { ${settings} }\n  }\n}`;
}

export function PackWithGate(props: PackWithGateProps) {
  const { client } = useApp();
  const set = useLoad(() => client.injectionTemplates(), 'injection-templates');
  const run = useLoad(() => client.injectionRun(props.runId), `${props.runId}:test-reads`);
  const config = useLoad(() => client.checks.goldens({ run: props.runId }), `${props.runId}:gate-config`);
  const failed = set.error ?? run.error ?? config.error;
  const id = shortId(props.runId);
  const title = namedIn(`Pack ${id} with injection gate?`, id);
  if (!set.data || !run.data || !config.data) {
    return (
      <Dialog title={title} lead={LEAD} doc={DOC} ok={OK} okWhy={failed ? 'What the gate plants in didn’t load' : 'Reading what the gate plants in'} onClose={props.onClose}>
        <ReadsWait loads={[set, run, config]} />
      </Dialog>
    );
  }
  // It plants in the reads a model call reads, as a test does.
  return <GateForm {...props} id={id} title={title} all={set.data.templates} reads={run.data.untrusted.filter((r) => r.readAt !== null)} config={config.data} />;
}

/** Its lead, an element of its words and the canary's term, never a component's: the dialog's `Copy` sets them, and its description reads them. */
const LEAD = (
  <>
    Packs the run as a golden that fails while a {'tool\u00a0call'} carries {'a\u00a0planted\u00a0payload’s'} <Term k="canary" />.
  </>
);

/** The dialog once the templates, the reads and the config are in: the golden, the gate's picks, the entry it adds, what each test session bills. */
function GateForm(props: PackWithGateProps & { id: string; title: ReactNode; all: readonly PayloadTemplate[]; reads: readonly UntrustedView[]; config: ChecksConfig }) {
  const app = useApp();
  const { all, reads, runId, config } = props;
  const ids = all.map((t) => t.id);
  const entryId = useId();
  const [golden, setGolden] = useState(props.folder);
  const [templates, setTemplates] = useState<string[]>(ids);
  const [repeat, setRepeat] = useState(String(props.gate.repeat));
  const [shown, setShown] = useState(false);
  const [consent, setConsent] = useState<{ why: string; confirm: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const each = Math.max(1, Math.min(MAX_REPEAT, Math.trunc(Number(repeat)) || 1));
  const estimate = usePlanEstimate({ runId }, { payloads: templates.length, repeat: each, gate: true }, props.estimate);
  const wait = useTestsWait(PACK_VERB);
  const dir = golden.trim();
  const gate = gateOf(templates, ids, each);
  // A yes to a command someone else recorded sends the same fields again; a refusal (the folder taken, a bad gate) keeps the dialog with the server's words.
  const start = (yes?: string): Promise<boolean> => {
    const fields = { runId, golden: dir, gate, version: config.version, read: config.read, ...sentEstimate(estimate) };
    return app.client.startJob(JOB_KINDS.keepGolden, yes === undefined ? fields : { ...fields, yes }).then(
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
  };
  if (consent) return <ConsentDialog why={consent.why} ok={OK} onClose={props.onClose} onOk={() => guardedWayOn(app.guard, () => start(consent.confirm))} />;
  const packRules = redactsFact(props.offers?.copies.formats.find((f) => f.id === 'pack')?.rules ?? null);
  return (
    <Dialog
      title={props.title}
      lead={LEAD}
      doc={DOC}
      className="injdlg"
      warn={refused ? { text: refused } : null}
      facts={[CHANGES, { label: 'Plants in', value: readsWords(reads, true) }, PACK_HOLDS, packRules]}
      command={packTestCommands(runId, dir || '…')}
      cost={templates.length ? { price: 'Billed by your provider', parts: ['live from each read, writes stubbed'], estimate } : { price: NONE, estimate: null }}
      ok={OK}
      okDisabled={!dir}
      okWhy={templates.length ? wait : NONE}
      onOk={() => guardedWayOn(app.guard, () => start())}
      onClose={props.onClose}
    >
      <div className="form one">
        <label>
          Golden
          <input
            type="text"
            value={golden}
            spellCheck={false}
            onChange={(e) => setGolden(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                pressWayOn(e.currentTarget);
              }
            }}
          />
        </label>
      </div>
      <TemplatePicks all={all} picked={templates} onPick={setTemplates} />
      <div className="injsec injnums">
        <label className="injrep">
          Attempts each
          <input type="number" min={1} max={MAX_REPEAT} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
      </div>
      {/* The entry folds behind Show entry, so the dialog fits a 1180 by 800 window; it follows the fields above it while folded too. */}
      <div className="injsec">
        <span className="k">Adds to shadowlap.config.json</span>
        <span className="sp" />
        <button className="linkbtn" type="button" aria-expanded={shown} aria-controls={entryId} onClick={() => setShown((s) => !s)}>
          {shown ? 'Hide entry' : 'Show entry'}
        </button>
      </div>
      <div id={entryId} hidden={!shown}>
        <CodeBox code={gateEntryText(dir || '…', gate)} what="the config entry" className="injconf" hang />
      </div>
    </Dialog>
  );
}
