import { useState } from 'react';
import { CopyButton } from '../../components/bits.js';
import { ConfirmDialog } from '../../components/Dialog.js';
import type { CodingAgentsSettings } from '../../settings-api.js';
import { useApp } from '../../state.js';
import { LoadProblem, Loading, useFolderGone, useSettingsData } from './common.js';
import { agentInstallWords, orList, SKILL_INSTALL_KIND } from './logic.js';

/**
 * Coding agents: which instruction files the project has (CLAUDE.md, AGENTS.md, .cursor/rules,
 * Copilot's) and whether each mentions Shadowlap yet; the same instructions packaged, as the Cursor
 * rule (and, once the owner has published it, the Claude Code plugin) that `shadowlap skill install`
 * puts into the project, each with what the project has of it and Install or Update; and the section
 * from docs/agents.md to paste into any other agent's instructions. The CLI is their interface: no
 * MCP server is needed.
 */
export function AgentsTab() {
  const { client } = useApp();
  const { data, error } = useSettingsData(() => client.settings.agents(), 'settings:agents');
  if (error && !data) return <LoadProblem error={error} />;
  if (!data) return <Loading title="Coding agents" />;
  const found = data.files.filter((f) => f.found);
  const skill = data.skill;
  return (
    <section className="panel set">
      <header>
        <h2>Coding agents</h2>
        <span className="sub">Claude Code, Cursor, Codex</span>
      </header>
      <div className="pbody">
        <p className="muted">
          The CLI is their interface: every command reads and writes JSON, with no MCP server to run. Shadowlap’s instructions for them come as {skill?.published ? 'a Claude Code plugin and a Cursor rule' : 'a Cursor rule'} to install, or as a section to paste into any agent’s instructions.
        </p>
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
      </div>
      {/* The plugin waits until the owner has published it; the rule needs nothing published. */}
      {skill?.published ? <InstallRow skill={skill} agent="claude-code" /> : null}
      {skill ? <InstallRow skill={skill} agent="cursor" /> : null}
      <div className="pbody">
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

/**
 * The Cursor rule or the Claude Code plugin: where it goes, what the project has there, and Install
 * (nothing there) or Update (another version's, or one edited here, which `--force` replaces: asked
 * first), as the `skill-install` job. Nothing to do for this version's copy, or a way that is blocked.
 */
function InstallRow({ skill, agent }: { skill: NonNullable<CodingAgentsSettings['skill']>; agent: 'claude-code' | 'cursor' }) {
  const app = useApp();
  const gone = useFolderGone();
  const [asking, setAsking] = useState(false);
  const offer = agent === 'cursor' ? skill.cursor : skill.claudeCode;
  const w = agentInstallWords(agent, offer, { version: skill.version, installedVersion: agent === 'claude-code' ? skill.claudeCode.installedVersion : null });
  const install = offer.install;
  const off = app.actionsOff ?? gone ?? (app.hasKind(SKILL_INSTALL_KIND) ? null : `This dashboard doesn’t install it: ${install?.command ?? 'shadowlap skill install'} in a terminal`);
  const start = () => app.guard(() => install && app.watchJob(app.client.startJob(install.job.kind, { agent: install.job.agent, replace: install.job.replace })));
  return (
    <>
      <div className="setrow">
        <div>
          <b>{w.name}</b>
          <span>
            <code>{offer.path}</code> · <em className={`agst${w.tone ? ` ${w.tone}` : ''}`}>{w.state}</em>
          </span>
        </div>
        {install && w.button ? (
          <button className="btn" type="button" disabled={!!off} title={off ?? install.command} onClick={() => (install.job.replace ? setAsking(true) : start())}>
            {w.button}
          </button>
        ) : null}
      </div>
      {/* Outside the row, whose styles would reach into the dialog. */}
      {asking && install ? (
        <ConfirmDialog
          title={`Replace the ${w.name}?`}
          text={`${offer.path} isn’t this version’s: ${w.state}. Update writes this version’s over it.`}
          ok="Update"
          command={install.command}
          onClose={() => setAsking(false)}
          onOk={() => {
            setAsking(false);
            start();
          }}
        />
      ) : null}
    </>
  );
}
