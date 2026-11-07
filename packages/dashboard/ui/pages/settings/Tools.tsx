import { useEffect, useState } from 'react';
import { Seg } from '../../components/bits.js';
import { CodeBox } from '../../components/CodeBox.js';
import { Dialog } from '../../components/Dialog.js';
import { Section } from '../../components/Section.js';
import { DialogFacts } from '../../components/DialogFacts.js';
import { Icon } from '../../components/Icon.js';
import { Term } from '../../components/Term.js';
import { tipCard, tipText, type TipRow } from '../../components/HoverCard.js';
import { copyText } from '../../dom.js';
import { num, whenShort } from '../../format.js';
import { useLoad } from '../../hooks.js';
import type { ToolsSettings } from '../../settings-api.js';
import { useApp } from '../../state.js';
import { CommandLine, LoadProblem, Loading, MCP_GONE, TOOLS_GONE, useFolderGone, useSettingsData } from './common.js';
import { MCP_FORMS, addServerNotes, copiedLineText, entryEnvFor, mcpEntryText, mcpRows, pasteFile, pasteWhere, serverNameFor, type McpRow } from './logic.js';

/**
 * Tools: every tool the recordings called, by what happens to it after a fork (reads run live,
 * writes are blocked or stubbed), the hosts the config records as tools, and the MCP servers:
 * those the project's client configs list and those calls came through, each with its transport,
 * its command or URL and its tools, with the `shadowlap mcp` line that records one, and under Show
 * the client’s config, folded at first, the config to copy with it in front. With the
 * project's folder gone, neither the store's calls nor the client configs can be read, and the tab
 * says so where they would be, rather than that there are none.
 */
export function ToolsTab() {
  const { client } = useApp();
  const { data, error } = useSettingsData(() => client.settings.tools(), 'settings:tools');
  const [adding, setAdding] = useState(false);
  const gone = useFolderGone();
  if (error && !data) return <LoadProblem error={error} />;
  if (!data) return <Loading title="Tools" />;
  const none = !data.live.length && !data.fenced.length;
  return (
    <Section className="set" title="Tools" sub="what a fork runs again">
      <div className="pbody">
        <p className="muted">Declared in the agent’s code. After a fork, reads run live and writes are blocked or stubbed unless you allow them, so by default a replay never acts on the world twice.</p>
      </div>
      {gone ? (
        <div className="egrp">
          <p className="muted">{TOOLS_GONE}</p>
        </div>
      ) : none ? (
        <div className="egrp">
          <p className="muted">
            No tool calls recorded yet. Wrap a tool with <code>tool()</code> from the SDK and say what it does (<code>pure</code>, <code>read</code> or <code>write</code>), and its calls are recorded with it.
          </p>
        </div>
      ) : (
        <>
          <ToolGroup title="runs live after a fork" tools={data.live} write={false} />
          <ToolGroup title="blocked or stubbed after a fork" tools={data.fenced} write />
        </>
      )}
      {data.http.length && !gone ? (
        <div className="egrp">
          <span className="k">hosts recorded as tools</span>
          <div className="tchips">
            {data.http.map((h) => (
              <span
                key={h.host}
                className={`tchip${h.effect === 'write' ? ' w' : ''}`}
                data-tip={tipCard(h.host, [
                  { label: 'effect', value: h.error ?? h.effect ?? 'none declared' },
                  { label: 'calls', value: num(h.calls) },
                  { label: 'config', value: h.declared ? 'under http' : 'not in the config any more' },
                ])}
              >
                <code>{h.host}</code>
                <em>{h.effect ?? '?'}</em>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <McpBlock data={data} gone={!!gone} onAdd={() => setAdding(true)} />
      {adding ? <AddServerDialog files={data.mcp.files} onClose={() => setAdding(false)} /> : null}
    </Section>
  );
}

function ToolGroup({ title, tools, write }: { title: string; tools: ToolsSettings['live']; write: boolean }) {
  return (
    <div className="egrp">
      <span className="k">{title}</span>
      {tools.length ? (
        <div className="tchips">
          {tools.map((t) => {
            const rows: TipRow[] = [
              { label: 'effect', value: t.effect ?? 'none declared: it runs live' },
              { label: 'calls', value: `${num(t.calls)} in ${num(t.runs)} ${t.runs === 1 ? 'run' : 'runs'}` },
              { label: 'last', value: whenShort(t.lastAt) },
            ];
            if (t.mcp) rows.push({ label: 'from', value: 'mcp.effects in the config' });
            if (t.changed) rows.push({ label: 'note', value: 'older runs recorded another effect' });
            return (
              <span key={t.name} className={`tchip${write ? ' w' : ''}`} data-tip={tipCard(t.name, rows)}>
                <code>{t.name}</code>
                <em>{t.effect ?? 'undeclared'}</em>
              </span>
            );
          })}
        </div>
      ) : (
        <p className="muted none">{write ? 'No write tools recorded.' : 'Every tool recorded is a write.'}</p>
      )}
    </div>
  );
}

/** Show the client’s config: closed at first, then as it was left while the page is open in this tab. */
let configShown = false;

function McpBlock({ data, gone, onAdd }: { data: ToolsSettings; gone: boolean; onAdd: () => void }) {
  const rows = mcpRows(data.mcp);
  const broken = data.mcp.files.filter((f) => f.error);
  const [shown, setShownState] = useState(() => configShown);
  const setShown = (v: boolean) => {
    configShown = v;
    setShownState(v);
  };
  const folded = data.mcp.clientConfigs.length > 0 || data.mcp.otherForms.length > 0;
  return (
    <div className="egrp mcp">
      <span className="k">tools from MCP servers</span>
      <p className="muted">
        Put <code>shadowlap mcp</code> in front of a server in the client’s config. Its tool calls are then recorded, replayed and <Term k="fenced">fenced</Term> like any other tool. A tool marked <code>readOnlyHint</code> is read; any other is write, unless <code>mcp.effects</code> in the config says otherwise.
      </p>
      {gone ? (
        <p className="muted none">{MCP_GONE}</p>
      ) : rows.length ? (
        <div className="tscroll mcptable">
          <table className="t">
            <thead>
              <tr>
                <th>Server</th>
                <th>Transport</th>
                <th>Command or URL</th>
                <th className="num">Tools</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <McpServer key={r.key} row={r} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted none">No MCP server in .mcp.json, .cursor/mcp.json or .vscode/mcp.json, and none recorded yet.</p>
      )}
      {broken.map((f) => (
        <p key={f.path} className="fieldnote warn">
          {f.path}: {f.error}
        </p>
      ))}
      {data.mcp.effects.length ? (
        <div className="tchips mcpeffects">
          {data.mcp.effects.map((e) => (
            <span key={e.tool} className={`tchip${e.effect === 'write' ? ' w' : ''}`} data-tip={tipText(e.error ?? `mcp.effects in the config sets ${e.tool} to ${e.effect!}${e.seen ? '' : ' (not recorded yet)'}`)}>
              <code>{e.tool}</code>
              <em>{e.effect ?? '?'}</em>
            </span>
          ))}
        </div>
      ) : null}
      <button className="btn sm" type="button" onClick={onAdd}>
        Add MCP server…
      </button>
      {folded ? (
        <>
          <p className="wftog">
            <button className="linkbtn" type="button" aria-expanded={shown} aria-controls="mcpCfg" onClick={() => setShown(!shown)}>
              {shown ? 'Hide' : 'Show'} the client’s config
              <Icon name="caret" />
            </button>
          </p>
          <div id="mcpCfg" hidden={!shown}>
            {data.mcp.clientConfigs.map((b) => (
              <ClientConfig key={b.file ?? 'docs'} block={b} />
            ))}
            {data.mcp.otherForms.map((f) => (
              <div key={f} className="mcpform2">
                <span className="muted">{MCP_FORMS[f].label}:</span>
                <CommandLine command={MCP_FORMS[f].line} />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * A client config to copy, its Copy named Copy MCP config: a project file's servers with
 * `shadowlap mcp` in front, under its name, and right under it what the copy leaves out to put back;
 * or the docs' example, as the mock shows it.
 */
function ClientConfig({ block }: { block: ToolsSettings['mcp']['clientConfigs'][number] }) {
  if (!block.file) return <CodeBox code={block.text} what="the MCP config" className="mcpjson" />;
  return (
    <>
      <CodeBox file={block.file} code={block.text} what="the MCP config" />
      {block.putBack.length ? (
        <div className="fieldnote warn putback">
          Values aren’t copied. Put these back before the client starts the server:
          <ul>
            {block.putBack.map((p) => (
              <li key={p.server}>
                <code>{p.server}</code> {p.values.join(', ')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {(block.notes ?? []).map((n) => (
        <p key={`${n.server}\u0000${n.text}`} className="fieldnote mcpnote">
          <code>{n.server}</code>: {n.text}.
        </p>
      ))}
    </>
  );
}

function McpServer({ row }: { row: McpRow }) {
  const { toast } = useApp();
  return (
    <tr className="still">
      <td>
        <code>{row.name}</code>
        {row.note ? (
          <small className={`mnote${row.line ? ' warn' : ''}`}>
            {row.note}
            {row.line ? (
              <>
                {' · '}
                <button className="linkbtn" type="button" title={row.line} onClick={() => void copyText(row.line!).then((ok) => toast(ok ? copiedLineText(row) : 'Copying was refused by the browser'))}>
                  copy the line
                </button>
              </>
            ) : null}
          </small>
        ) : null}
      </td>
      <td>
        <span className="chip">{row.transport === 'http' ? 'HTTP' : 'stdio'}</span>
      </td>
      <td>
        <code className="mcpt" title={row.target}>
          {row.target}
        </code>
      </td>
      <td className="num">
        {row.tools === null ? (
          <span className="muted" data-tip={tipText('Nothing recorded through it yet')}>
            —
          </span>
        ) : (
          <>
            {row.tools} <small>{row.writes} write</small>
          </>
        )}
      </td>
    </tr>
  );
}

/** Add MCP server…: the `shadowlap mcp` line and the client entry for a command or a URL. Nothing is written; the entry is copied. */
export function AddServerDialog({ files, onClose }: { files: ToolsSettings['mcp']['files']; onClose: () => void }) {
  const { client, toast } = useApp();
  const [transport, setTransport] = useState<'stdio' | 'http'>('http');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [asked, setAsked] = useState('');
  // Asked a moment after typing stops: the server splits the command and hides credentials, as the table does.
  useEffect(() => {
    const t = setTimeout(() => setAsked(target.trim()), 250);
    return () => clearTimeout(t);
  }, [target]);
  const line = useLoad(() => (asked ? client.settings.mcpLine(transport === 'http' ? { url: asked } : { command: asked }) : null), `mcp:${transport}:${asked}`);
  const shown = asked === target.trim() ? line.data : null;
  // Named from what was typed until a name is given: linear for https://mcp.linear.app/mcp.
  const serverName = name.trim() || serverNameFor(transport, target);
  // The file the entry goes in decides how its environment is written: Claude Code fills in ${…} in .mcp.json itself.
  const file = pasteFile(files);
  const env = shown ? entryEnvFor(shown.env ?? [], shown.basic, file) : [];
  const entry = shown ? mcpEntryText(serverName, shown.entry, env) : '';
  // Copied as typed, but for a URL's user and password, which never go on the clipboard. What shows hides any credential, as the table does.
  const copied = shown ? mcpEntryText(serverName, shown.copy ?? shown.entry, env) : '';
  const notes = shown ? addServerNotes(shown, file) : null;
  const placeholder = transport === 'http' ? 'shadowlap mcp --url <server URL>' : 'shadowlap mcp -- <command>';
  return (
    <Dialog
      title="Add MCP server"
      lead="Records an MCP server’s tool calls, replayed and fenced like any other tool."
      doc="mcp"
      warn={notes ? { text: <AddServerNote notes={notes} /> } : null}
      command={shown?.line ?? placeholder}
      ok="Copy entry"
      okDisabled={!shown}
      keepOnSwitch
      local
      onClose={onClose}
      onOk={() =>
        copyText(copied).then((ok) => {
          toast(ok ? `Copied the entry for ${serverName} · paste it ${pasteWhere(files)}; its tool calls are recorded from the next run` : 'Copying was refused by the browser');
          return ok;
        })
      }
    >
      <Seg
        label="Transport"
        items={[
          { key: 'stdio', label: 'Command' },
          { key: 'http', label: 'URL' },
        ]}
        value={transport}
        onChange={(t) => {
          setTransport(t);
          setTarget('');
          setAsked('');
        }}
      />
      <div className="form one mcpform">
        <label>
          Name
          <input value={name} placeholder={target.trim() ? serverNameFor(transport, target) : transport === 'http' ? 'linear' : 'github'} spellCheck={false} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {transport === 'http' ? 'Server URL' : 'Command'}
          <input value={target} placeholder={transport === 'http' ? 'https://mcp.linear.app/mcp' : 'npx -y @modelcontextprotocol/server-github'} spellCheck={false} autoComplete="off" onChange={(e) => setTarget(e.target.value)} />
        </label>
      </div>
      <DialogFacts rows={[{ label: 'Effects', value: 'from each tool’s `readOnlyHint`', quiet: 'any other tool is a write' }]} />
      <p className="muted mcphow">{transport === 'http' ? 'The client starts the proxy, and the proxy talks to the remote server over Streamable HTTP.' : 'The client starts the proxy, and the proxy starts the server.'}</p>
      {entry ? <pre className="codebox">{entry}</pre> : null}
      {line.error && asked === target.trim() ? <p className="fieldnote err">{line.error.message}</p> : null}
    </Dialog>
  );
}

/** What Add MCP server… says about what it hid (`addServerNotes`): where the Basic header's variable is set, and what the copy has as typed. */
function AddServerNote({ notes }: { notes: NonNullable<ReturnType<typeof addServerNotes>> }) {
  const KEEP_OUT = 'keep it out of a file you commit, or pass it in an environment variable.';
  const b = notes.basic;
  const ref = b ? <code>{`\${${b.name}}`}</code> : null;
  return (
    <>
      {b ? (
        <>
          The URL’s user and password aren’t copied: <code>shadowlap mcp</code> sends them as an Authorization header. Set <code>{b.name}</code> to their base64, from <code>printf &apos;user:password&apos; | base64</code>,{' '}
          {b.where === 'claude-code' ? (
            <>in the environment Claude Code starts from: it fills in {ref} in .mcp.json itself.</>
          ) : b.where === 'env' ? (
            <>in the entry’s env.</>
          ) : (
            <>in the entry’s env, or for .mcp.json in the environment Claude Code starts from, since it fills in {ref} itself.</>
          )}{' '}
        </>
      ) : null}
      {notes.inCopy ? 'A URL’s user and password show as •••, in the copy too: put them back in your own entry. ' : null}
      {notes.asTyped ? (b || notes.inCopy ? `Anything else that looks like a credential shows as ••• and is copied as you typed it: ${KEEP_OUT}` : `Something that looks like a credential shows as •••. The copied entry has it as you typed it: ${KEEP_OUT}`) : null}
    </>
  );
}
