import { useRef, useState } from 'react';
import { ApiError } from '../../api.js';
import { Seg } from '../../components/bits.js';
import { Dialog } from '../../components/Dialog.js';
import { Icon } from '../../components/Icon.js';
import { ACTIONS, confirmWords } from '../../labels.js';
import { messageOf } from '../../../../engine/src/message-of.js';
import type { RuleRow } from '../../settings-api.js';
import { useApp } from '../../state.js';
import { CONFIG_FILE, CommandLine, editErrorText } from './common.js';
import { emptyRuleForm, redactRuleText, ruleCommand, ruleInput, ruleProblem, ruleWarning, suggestedReplace, type PatternMode, type RuleFormState, type RuleListName } from './logic.js';
import { ActionButton, useWhenFree } from '../../components/ActionButton.js';

/**
 * The rules of one list, as Matching and Redaction show them (scope, path, pattern, what replaces
 * it, Remove), and the dialog that adds one. The table shows every rule the CLI can write: a regex,
 * a tool name, a path with no pattern, and a broken entry with why it can't be used.
 */

const NOUN: Record<RuleListName, string> = { normalize: 'normalizer', redact: 'redaction rule' };

/**
 * `unreadable`: why there is no list to show, empty or not (`rulesUnreadable`: shadowlap.config.json
 * can't be read, or the project's folder is gone), said where the rules would be.
 */
export function RuleTable({ list, rows, off, onRemove, unreadable = null }: { list: RuleListName; rows: RuleRow[]; off: string | null; onRemove: (row: RuleRow) => void; unreadable?: string | null }) {
  return (
    <div className="tscroll">
      <table className="t ruletable">
        <thead>
          <tr>
            <th>Scope</th>
            <th>Path</th>
            <th>Pattern</th>
            <th>Replace with</th>
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="none">
                <span>{unreadable ?? (list === 'normalize' ? 'No normalizers yet. Calibrate finds the ones a recording needs.' : 'No redaction rules yet: exports, packs and share links hold what was recorded.')}</span>
              </td>
            </tr>
          ) : null}
          {rows.map((r) =>
            r.error ? (
              <tr key={r.n}>
                <td>
                  <span className="chip">#{r.n}</span>
                </td>
                <td colSpan={3} className="wrapcell">
                  <span className="rerr">can’t be used: {r.error}</span>
                </td>
                <td className="num">
                  <RemoveButton list={list} row={r} off={off} onRemove={onRemove} />
                </td>
              </tr>
            ) : (
              <tr key={r.n}>
                <td>{r.scope === 'every call' ? <span className="muted">every call</span> : <span className="chip">{r.scope}</span>}</td>
                <td>
                  <code>{r.path ?? 'any string'}</code>
                </td>
                <td>
                  <code className={r.patternType === 'regex' ? 'rx' : undefined}>{r.pattern ?? 'whole value'}</code>
                </td>
                <td>
                  <code>{r.replace}</code>
                </td>
                <td className="num">
                  <RemoveButton list={list} row={r} off={off} onRemove={onRemove} />
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function RemoveButton({ list, row, off, onRemove }: { list: RuleListName; row: RuleRow; off: string | null; onRemove: (row: RuleRow) => void }) {
  return (
    <ActionButton className="linkbtn" why={off} title={`shadowlap ${list} rm ${row.n}`} aria-label={`Remove ${NOUN[list]} #${row.n}`} onClick={() => onRemove(row)}>
      Remove
    </ActionButton>
  );
}

const MODES: ReadonlyArray<{ key: PatternMode; label: string }> = [
  { key: 'named', label: 'Named pattern' },
  { key: 'regex', label: 'Regex' },
  { key: 'whole', label: 'Whole value' },
];

/** A rule dialog's title and confirm: its button's name, `Add normalizer` or `Add redaction rule`. */
const addName = (list: RuleListName): string => confirmWords((list === 'normalize' ? ACTIONS.addNormalizerRule : ACTIONS.addRedactionRule).label);

/**
 * Add normalizer…, or Add redaction rule…: a scope, a path, a named pattern and the replacement, as
 * the mock has it, and under Advanced a regex, a tool or call name, or no pattern (the whole value at
 * the path). Titled and confirmed with its button's name. The command it stands for shows as you
 * type; the server checks the rule as the CLI does and its words show here when it refuses.
 */
export function RuleDialog({
  list,
  teamStore = false,
  kinds,
  patterns,
  version,
  onClose,
  onAdded,
  onStale,
}: {
  list: RuleListName;
  /** The project has a team store: a redaction rule's dialog says push copies runs there as recorded. */
  teamStore?: boolean;
  kinds: readonly string[];
  patterns: readonly string[];
  version: string;
  onClose: () => void;
  /** The rule is in the file: its number, whether this added it, and the file's version now. */
  onAdded: (n: number, added: boolean, version: string) => void;
  /** The file changed on disk since the tab read it: read it again. */
  onStale: () => void;
}) {
  const app = useApp();
  const norm = list === 'normalize';
  // What is typed here stays when the dashboard switches project elsewhere, and then goes to the project shown: said so.
  const openedIn = useRef(app.meta?.project?.id ?? null);
  const now = app.meta?.project;
  const moved = openedIn.current && now?.id && now.id !== openedIn.current ? `The dashboard switched to ${now.name} elsewhere: ${addName(list)} adds this to ${now.name}’s ${CONFIG_FILE}.` : null;
  const [f, setF] = useState<RuleFormState>(() => emptyRuleForm(list, patterns));
  const [replaceTyped, setReplaceTyped] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<RuleFormState>) => {
    setF((prev) => {
      const next = { ...prev, ...patch };
      // The replacement follows the pattern until it is typed over.
      if (!replaceTyped && (patch.mode !== undefined || patch.named !== undefined)) next.replace = suggestedReplace(list, next.mode, next.named);
      return next;
    });
    setError(null);
  };
  const [problem, warning] = [ruleProblem(f), ruleWarning(f)];
  // Enter as the confirm: while it waits, why in a toast, the dialog and the rule kept.
  const whenFree = useWhenFree();
  const add = async () => {
    if (problem || busy) return;
    setBusy(true);
    try {
      const r = await app.client.settings.addRule(list, ruleInput(f), version);
      onAdded(r.n, r.added, r.version);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onStale();
        setError(`${editErrorText(err)} Add it again to add it to the file as it is now.`);
      } else setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  const nameLabel = f.kind === 'tool' ? 'Tool name' : 'Call name';
  return (
    <Dialog
      title={addName(list)}
      text={norm ? 'Masks a value before matching. Older recordings match too, because fingerprints are recomputed under the current rules.' : redactRuleText(teamStore)}
      ok={busy ? 'Adding…' : addName(list)}
      okDisabled={!!problem || busy}
      onOk={() => void add()}
      onClose={onClose}
      className="ruledlg"
      keepOnSwitch
    >
      <div className="form">
        <label>
          Scope
          <select value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="">every call</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          Path
          <input value={f.path} placeholder="$.metadata.user_id" spellCheck={false} autoComplete="off" onChange={(e) => set({ path: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && whenFree(() => void add())} />
        </label>
        <label>
          Pattern
          {f.mode === 'named' ? (
            <select value={f.named} onChange={(e) => set({ named: e.target.value })}>
              {patterns.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          ) : (
            <select disabled value={f.mode}>
              <option value="regex">regex, below</option>
              <option value="whole">whole value</option>
            </select>
          )}
        </label>
        <label>
          Replace with
          <input
            value={f.replace}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setReplaceTyped(true);
              set({ replace: e.target.value });
            }}
            onKeyDown={(e) => e.key === 'Enter' && whenFree(() => void add())}
          />
        </label>
      </div>
      <button className="linkbtn advtoggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
        <Icon name="caret" className={advanced ? 'open' : 'shut'} />
        Advanced: a regex, a {f.kind === 'api' ? 'call' : 'tool'} name, or the whole value
      </button>
      {advanced ? (
        <div className="advpart">
          <Seg label="What it matches" items={MODES} value={f.mode} onChange={(mode) => set({ mode })} />
          <div className="form">
            {f.mode === 'regex' ? (
              <label>
                Regex
                <input value={f.regex} placeholder="/req_[a-z0-9]+/i" spellCheck={false} autoComplete="off" autoFocus onChange={(e) => set({ regex: e.target.value })} />
              </label>
            ) : null}
            {f.kind === 'tool' || f.kind === 'api' ? (
              <label>
                {nameLabel}
                <input value={f.name} placeholder={f.kind === 'tool' ? 'create_ticket' : 'POST /v1/messages'} spellCheck={false} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
              </label>
            ) : null}
          </div>
          <p className="muted advnote">
            {f.mode === 'whole'
              ? list === 'redact'
                ? 'No pattern: the whole value at the path is replaced, a number too. What a call got back (a tool’s result is under $.result) only HTML, HAR and dataset copies mask: a pack keeps it for its replay.'
                : 'No pattern: the whole value at the path is replaced.'
              : f.mode === 'regex'
                ? `A regex as /…/flags; typed without slashes, it gets them.${list === 'redact' ? ' Use a lookbehind, such as /(?<=key=)\\w+/, to keep what comes before the secret.' : ''}`
                : f.kind === 'tool' || f.kind === 'api'
                  ? `A name scopes the rule to one ${f.kind === 'tool' ? 'tool' : 'call'}; empty, it applies to every ${f.kind} call.`
                  : 'Pick a scope of api or tool to name one call or tool.'}
          </p>
        </div>
      ) : null}
      <CommandLine command={ruleCommand(list, f)} />
      {error || problem || warning || moved ? <p className={`fieldnote ${error ? 'err' : 'warn'}`}>{error ?? problem ?? warning ?? moved}</p> : null}
    </Dialog>
  );
}

/** What the toast says once a rule is added, or found there already. */
export function addedText(list: RuleListName, n: number, added: boolean): string {
  return added ? `Added to ${CONFIG_FILE} · ${NOUN[list]} #${n}` : `That ${NOUN[list]} is in ${CONFIG_FILE} already · #${n}`;
}

export function removedText(list: RuleListName, n: number): string {
  return `Removed ${NOUN[list]} #${n} from ${CONFIG_FILE}`;
}
