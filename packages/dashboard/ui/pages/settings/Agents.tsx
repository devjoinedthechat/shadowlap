import { CopyButton } from '../../components/bits.js';
import { useApp } from '../../state.js';
import { LoadProblem, Loading, useSettingsData } from './common.js';
import { orList } from './logic.js';

/**
 * Coding agents: which instruction files the project has (CLAUDE.md, AGENTS.md, .cursor/rules,
 * Copilot's) and whether each mentions Shadowlap yet, and the section from docs/agents.md to paste.
 * Coding agents need no plugin: the CLI is their interface.
 */
export function AgentsTab() {
  const { client } = useApp();
  const { data, error } = useSettingsData(() => client.settings.agents(), 'settings:agents');
  if (error && !data) return <LoadProblem error={error} />;
  if (!data) return <Loading title="Coding agents" />;
  const found = data.files.filter((f) => f.found);
  return (
    <section className="panel set">
      <header>
        <h2>Coding agents</h2>
        <span className="sub">Claude Code, Cursor, Codex</span>
      </header>
      <div className="pbody">
        <p className="muted">Coding agents need no plugin or MCP server: the CLI is their interface, and every command reads and writes JSON.</p>
        <div className="agentfiles">
          {data.files
            // Copilot's file is listed only when the project has it; the other three always, as the mock does.
            .filter((f) => f.found || f.path !== '.github/copilot-instructions.md')
            .map((f) => (
              <div key={f.path}>
                <code>{f.path}</code>
                <span className={f.found ? (f.mentions ? 'ok' : 'warn') : 'muted'}>{f.found ? `found · ${f.mentions ? 'mentions Shadowlap' : 'no Shadowlap section yet'}` : 'not in this project'}</span>
              </div>
            ))}
        </div>
        {data.section ? (
          <>
            <pre className="codebox md" tabIndex={0}>
              {data.section}
            </pre>
            <div className="actions">
              <CopyButton text={data.section} label="the section" className="btn">
                Copy the section
              </CopyButton>
              <span className="hintx">
                Paste it into {found.length && !found.some((f) => f.mentions) ? orList(found.map((f) => f.path)) : 'CLAUDE.md, AGENTS.md or your rules file'}.
              </span>
            </div>
          </>
        ) : (
          <p className="muted">
            The section to paste is in <code>{data.source}</code>, under “Instructions to give it”.
          </p>
        )}
      </div>
    </section>
  );
}
