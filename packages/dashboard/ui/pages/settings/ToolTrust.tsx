import { useRef, useState, type ReactNode } from 'react';
import { ActionButton } from '../../components/ActionButton.js';
import { SrSpace } from '../../components/bits.js';
import { CodeBox, CopyButton } from '../../components/CodeBox.js';
import { Copy } from '../../components/Copy.js';
import { tipCard, type TipRow } from '../../components/HoverCard.js';
import { Icon } from '../../components/Icon.js';
import { Term } from '../../components/Term.js';
import { num, shortId, whenShort } from '../../format.js';
import { ACTIONS } from '../../labels.js';
import { useListKeys } from '../../list-keys.js';
import type { ToolsSettings } from '../../settings-api.js';
import { useApp } from '../../state.js';
import { CONFIG_FILE, type useEditor } from './common.js';

/**
 * Settings → Tools' Trust table: every tool in one table, by what a fork does to it (a read runs
 * live, a pure tool is served when its call is the same, a write is blocked or stubbed). A read
 * takes a mark: a pure tool computes from its arguments, what the user types is the user's own, and
 * a write's result is only its receipt. A pure tool or what the user types marked untrusted all the
 * same is planted in, as `shadowlap injection` plants in any untrusted call but a write and one of no
 * effect, so its row says so and offers Mark trusted. Reads come first, untrusted first among them,
 * in the order the page first drew them, so a mark made here keeps its row in place until the page
 * loads again. Mark untrusted and Mark trusted write `tools.<name>.trust` against the version the
 * tab read, with an Undo; under the table, the `tools` entry they write, folded, the line written
 * here marked. Under it, the tools Shadowlap doesn't record, each declared a read or a write under
 * `tools.unrecorded` the same way (UnrecordedTools).
 */

export type ToolRow = ToolsSettings['live'][number];
type Kind = 'read' | 'pure' | 'undeclared' | 'input' | 'write';

const kindOf = (t: ToolRow): Kind => (t.input ? 'input' : (t.effect ?? 'undeclared'));
const RANK: Readonly<Record<Kind, number>> = { read: 0, pure: 1, undeclared: 2, input: 3, write: 4 };

/** Why a row takes no mark, on its `—`'s card. */
const NO_MARK: Readonly<Record<Exclude<Kind, 'read'>, { t: string; s: string }>> = {
  input: { t: 'What the user types', s: 'The person the agent works for: a payload there is the user’s own words, never planted' },
  write: { t: 'A write', s: 'Never planted in: an instruction arrives in what the agent reads, and a write’s result is only its receipt' },
  pure: { t: 'A pure tool', s: 'It computes from its arguments and brings nothing in, so nothing is planted in it' },
  undeclared: { t: 'No effect declared', s: 'It may be a write, so nothing is planted in it' },
};

/** Whether a tool takes a mark: a read, and a pure tool or what the user types once marked untrusted, where `shadowlap injection` plants as it plants in a read. */
const planted = (t: ToolRow): boolean => {
  const k = kindOf(t);
  return k === 'read' || (t.trust === 'untrusted' && (k === 'pure' || k === 'input'));
};

/** The order the page first drew, by the tools it drew: kept until the page loads again. */
let drawn: { key: string; names: string[] } | null = null;
/** The `tools` entry's box: null until toggled (then open once a mark is made here), and the tool marked last here. */
let entryShown: boolean | null = null;
let marked: string | null = null;

/** The rows in the order the page first drew them: reads, pure, undeclared, input, writes; untrusted first among them; then by name. */
export function trustOrder(rows: readonly ToolRow[]): ToolRow[] {
  const key = rows.map((r) => r.name).sort().join('\u0000');
  if (drawn?.key !== key) {
    const sorted = [...rows].sort((a, b) => RANK[kindOf(a)] - RANK[kindOf(b)] || Number(b.trust === 'untrusted') - Number(a.trust === 'untrusted') || a.name.localeCompare(b.name));
    drawn = { key, names: sorted.map((r) => r.name) };
  }
  const by = new Map(rows.map((r) => [r.name, r]));
  return drawn.names.map((n) => by.get(n)!);
}

/** Mark trusted's card: what the line it writes wins over. */
function winsOver(t: ToolRow): string {
  if (t.from === 'mcp') return 'Writes this line, which wins over its server’s openWorldHint';
  return t.from === 'sdk' ? 'Writes this line, which wins over the mark in the agent’s code' : 'Writes this line, which wins over every recorded mark';
}

const MARK_UNTRUSTED = 'Writes this line. shadowlap injection then plants payloads in its reads, recorded runs included: a mark never enters a fingerprint';

type Editor = ReturnType<typeof useEditor>;

interface TrustProps {
  data: ToolsSettings;
  editor: Editor;
  /** Why an edit waits (read-only, the folder gone, a file that can't be read, an edit landing). */
  off: string | null;
  /** The file's version the tab read (`absent` with no file). */
  version: string;
  /** Run injection test… on an untrusted read's row, where a run reads it. */
  test?: ((row: ToolRow) => ReactNode) | undefined;
}

export function TrustTable({ data, editor, off, version, test }: TrustProps) {
  const { client } = useApp();
  const rows = trustOrder([...data.live, ...data.fenced]);
  const box = useRef<HTMLDivElement>(null);
  const [, redraw] = useState(0);
  const mark = (t: ToolRow) => {
    const to = t.trust === 'untrusted' ? 'trusted' : 'untrusted';
    const before = marked;
    void editor.run(
      () => client.settings.setToolTrust(t.name, to, version),
      (r) => {
        marked = t.name;
        redraw((n) => n + 1);
        return `Wrote ${r.line ?? t.flip} to ${CONFIG_FILE}`;
      },
      (r) => {
        if (!r.changed) return null;
        let back: string | null = null;
        return {
          edit: async () => {
            const u = await client.settings.setToolTrust(t.name, r.was, r.version);
            back = u.line;
            return u;
          },
          ok: () => (r.was ? `Put ${back ?? ''} back in ${CONFIG_FILE}` : `Took ${r.line ?? t.flip} out of ${CONFIG_FILE}`),
          then: () => {
            marked = before;
            redraw((n) => n + 1);
          },
        };
      },
    );
  };
  const markable = (t: ToolRow) => planted(t) && t.name !== 'unrecorded';
  const inFocus = useListKeys({
    rows,
    keyOf: (t) => `tool:${t.name}`,
    root: box,
    actions: (t) => {
      const items: Array<{ label: string; hint: string; run: () => void }> = markable(t) ? [{ label: t.trust === 'untrusted' ? ACTIONS.markTrusted.label : ACTIONS.markUntrusted.label, hint: t.flip, run: () => mark(t) }] : [];
      // Run injection test… as the row's own button runs it, so its dialog opens where the row draws it.
      const tested = test && t.trust === 'untrusted' && t.test ? t.test : null;
      if (tested && items.length) items.push({ label: ACTIONS.runInjectionTest.label, hint: `shadowlap injection ${tested.runId ? shortId(tested.runId) : (tested.golden ?? '')}`, run: () => Array.from(box.current?.querySelectorAll<HTMLElement>('tr[data-rowkey]') ?? []).find((tr) => tr.dataset.rowkey === `tool:${t.name}`)?.querySelector<HTMLButtonElement>('.tooltest')?.click() });
      return items.length ? { name: t.name, items: () => items } : null;
    },
  });
  return (
    <>
      <div className="tscroll" ref={box}>
        <table className="t trusttab">
          <thead>
            <tr>
              <th>Tool</th>
              <th>After a fork</th>
              <th>Trust</th>
              <th className="num">
                <span className="sr">Change</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <TrustRow key={t.name} t={t} focused={inFocus === `tool:${t.name}`} markable={markable(t)} off={off} onMark={() => mark(t)} test={t.trust === 'untrusted' && markable(t) ? test?.(t) : null} />
            ))}
          </tbody>
        </table>
      </div>
      <ToolsEntry entry={data.entry} />
    </>
  );
}

/** A tool's card, on its name: the effect it records, its calls, its last, and where its effect comes from or changed. */
function toolCard(t: ToolRow): string {
  const rows: TipRow[] = [
    { label: 'effect', value: t.effect ?? 'none declared: it runs live' },
    { label: 'calls', value: `${num(t.calls)} in ${num(t.runs)} ${t.runs === 1 ? 'run' : 'runs'}` },
    { label: 'last', value: whenShort(t.lastAt) },
  ];
  if (t.mcp) rows.push({ label: 'from', value: 'mcp.effects in the config' });
  if (t.changed) rows.push({ label: 'note', value: 'older runs recorded another effect' });
  return tipCard(t.name, rows);
}

function TrustRow({ t, focused, markable, off, onMark, test }: { t: ToolRow; focused: boolean; markable: boolean; off: string | null; onMark: () => void; test: ReactNode }) {
  const k = kindOf(t);
  const other = t.trust === 'untrusted' ? 'trusted' : 'untrusted';
  const na = k === 'read' || planted(t) ? null : NO_MARK[k];
  return (
    <tr className={`still${focused ? ' krow' : ''}`} data-rowkey={`tool:${t.name}`}>
      <td>
        <code className={k === 'write' ? 'wr' : undefined} data-tip={toolCard(t)}>
          {t.name}
        </code>
        <SrSpace />
        <span className={`eff ${k}`}>{k}</span>
      </td>
      <td>{k === 'input' ? <span className="tafter na">—</span> : k === 'write' ? <span className="tafter w">{<><Term k="blocked">blocked</Term> or <Term k="stubbed">stubbed</Term></>}</span> : <span className="tafter">{k === 'pure' ? 'served when the same' : 'runs live'}</span>}</td>
      <td>
        {na ? (
          <span className="trust na" data-tip={tipCard(na.t, [], na.s)}>
            —
          </span>
        ) : t.trust === 'untrusted' ? (
          <>
            <span className="trust u">untrusted</span>
            {t.where ? <small>{t.where}</small> : null}
          </>
        ) : (
          <span className="trust">trusted</span>
        )}
      </td>
      <td className="num">
        {markable ? (
          <ActionButton className="linkbtn trustbtn" why={off} tip={`Mark ${t.name} ${other}`} sub={other === 'untrusted' ? MARK_UNTRUSTED : winsOver(t)} command={t.flip} onClick={onMark}>
            {other === 'untrusted' ? ACTIONS.markUntrusted.label : ACTIONS.markTrusted.label}
          </ActionButton>
        ) : null}
        {test}
      </td>
    </tr>
  );
}

/** Show the tools entry: closed at first, open once a mark is made here, then as it was left; Copy entry beside it copies while folded. */
function ToolsEntry({ entry }: { entry: ToolsSettings['entry'] }) {
  const [shown, setShown] = useState<boolean | null>(() => entryShown);
  const open = shown ?? marked !== null;
  const text = entry.length ? `"tools": {\n${entry.map((l) => l.text).join('\n')}\n}` : '"tools": { }';
  const lines = entry.length ? [{ op: ' ' as const, text: '"tools": {' }, ...entry.map((l) => ({ op: l.tool === marked ? ('+' as const) : (' ' as const), text: l.text })), { op: ' ' as const, text: '}' }] : [{ op: ' ' as const, text }];
  return (
    <>
      <p className="wftog">
        <button
          className="linkbtn"
          type="button"
          aria-expanded={open}
          aria-controls="toolsCfg"
          onClick={() => {
            entryShown = !open;
            setShown(!open);
          }}
        >
          {open ? 'Hide' : 'Show'} the tools entry
          <Icon name="caret" />
        </button>
        <CopyButton text={text} label="the tools entry">
          Copy entry
        </CopyButton>
      </p>
      <div id="toolsCfg" className="trustcfg" hidden={!open}>
        <CodeBox file={CONFIG_FILE} lines={lines} />
      </div>
    </>
  );
}

/** A tool Shadowlap doesn't record, as `tools.unrecorded` declares it. */
type Declared = NonNullable<ToolsSettings['unrecorded']>[number];

/** The words that write a declaration, and its toasts' line. */
const unrecordedLine = (name: string, effect: 'read' | 'write') => `"tools": { "unrecorded": { ${JSON.stringify(name)}: "${effect}" } }`;

/** What a replay does with one declared so, on its button's card. */
const DECLARE_SUB: Readonly<Record<'read' | 'write', string>> = {
  read: 'Writes this line. A replay then runs it again for real, as it ran when it was recorded',
  write: 'Writes this line. Every command that replays a run then refuses to run it again, unless allowed',
};

/**
 * The tools the agent runs without Shadowlap recording them, as `tools.unrecorded` declares them:
 * each with what it does and the other declaration, and a field to declare another one a read by
 * the name the model called it, as a run's page names it. A replay serves the model's answers
 * again, so it runs such a tool again for real: it runs one declared a read, and refuses one that
 * writes or whose effect nothing says. Each writes its line against the version the tab read, with
 * an Undo, as a mark does.
 */
export function UnrecordedTools({ data, editor, off, version }: Pick<TrustProps, 'data' | 'editor' | 'off' | 'version'>) {
  const { client } = useApp();
  const [name, setName] = useState('');
  const declare = (tool: string, effect: 'read' | 'write') =>
    editor.run(
      () => client.settings.setUnrecorded(tool, effect, version),
      (r) => `Wrote ${r.line ?? unrecordedLine(tool, effect)} to ${CONFIG_FILE}`,
      (r) => {
        if (!r.changed) return null;
        let back: string | null = null;
        return {
          edit: async () => {
            const u = await client.settings.setUnrecorded(tool, r.was, r.version);
            back = u.line;
            return u;
          },
          ok: () => (r.was ? `Put ${back ?? ''} back in ${CONFIG_FILE}` : `Took ${r.line ?? unrecordedLine(tool, effect)} out of ${CONFIG_FILE}`),
        };
      },
    );
  const typed = name.trim();
  const submit = () => {
    if (typed) void declare(typed, 'read').then((r) => r && setName(''));
  };
  return (
    <div className="egrp unrec">
      <span className="k">tools Shadowlap doesn’t record</span>
      <Copy className="muted">
        A tool the agent runs without Shadowlap recording it runs again for real on every replay. A replay refuses one that writes, or whose effect nothing says, unless <code>tools.unrecorded</code> in {CONFIG_FILE} declares it a read.
      </Copy>
      {data.unrecorded?.length ? (
        <ul>
          {data.unrecorded.map((t: Declared) => {
            const other = t.effect === 'read' ? 'write' : 'read';
            return (
              <li key={t.name}>
                <code>{t.name}</code>
                <span className="muted">declared a {t.effect}</span>
                <ActionButton className="linkbtn" why={off} tip={`Declare ${t.name} a ${other}`} sub={DECLARE_SUB[other]} command={unrecordedLine(t.name, other)} onClick={() => void declare(t.name, other)}>
                  Declare {other}
                </ActionButton>
              </li>
            );
          })}
        </ul>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          <span className="sr">The tool’s name, as the model called it</span>
          <input spellCheck={false} autoComplete="off" placeholder="Bash" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <ActionButton className="btn sm" why={off ?? (typed ? null : 'Type the tool’s name, as a run’s page names it')} tip={typed ? `Declare ${typed} a read` : 'Declare read'} sub={DECLARE_SUB.read} command={typed ? unrecordedLine(typed, 'read') : undefined} onClick={submit}>
          Declare read
        </ActionButton>
      </form>
    </div>
  );
}
