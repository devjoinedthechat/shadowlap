import { Fragment, useState } from 'react';
import { CodeBox } from '../../components/CodeBox.js';
import { ConfirmDialog } from '../../components/Dialog.js';
import { Icon } from '../../components/Icon.js';
import type { CodingAgentsSettings } from '../../settings-api.js';
import { useApp } from '../../state.js';
import { CommandLine, FILES_GONE, LoadProblem, Loading, useFolderGone, useSettingsData } from './common.js';
import { agentFileWords, orList, sharedSkillsWords, SKILL_INSTALL_KIND, skillWords, type AgentAction } from './logic.js';
import { ActionButton } from '../../components/ActionButton.js';
import { Section } from '../../components/Section.js';

/**
 * Coding agents, as the design has it (codingAgentsPanel): coding agents need no MCP server, the CLI
 * is their interface; which instruction files the project has (CLAUDE.md, AGENTS.md, and Cursor's
 * rules and Copilot's file where the project has them) and whether each mentions Shadowlap yet; the
 * `.agents/skills` row with the skills `shadowlap skill install agents` adds for Codex, Cursor,
 * Copilot and the other agents that read that folder; and the section from docs/agents.md to paste.
 * Once the owner has published the Claude Code plugin (SKILL_PUBLISHED), The skills row above the
 * files installs it (skillPanelRows). The states the design doesn't show come from the read model
 * (`skillOffer()`): another version's copy offers Update, one edited here Replace…, which asks
 * first, and a way that is blocked says why, with no button. A file whose agents read the installed
 * skills needs no section, and says so. With the project's folder gone, its files can't be read,
 * and the list says so.
 */
export function AgentsTab() {
  const { client } = useApp();
  const { data, error, reload } = useSettingsData(() => client.settings.agents(), 'settings:agents');
  const gone = useFolderGone();
  const [asking, setAsking] = useState<{ install: Install; title: string; lead: string; path: string; others: boolean } | null>(null);
  const start = useInstall();
  if (error && !data) return <LoadProblem error={error} retry={reload} />;
  if (!data) return <Loading title="Coding agents" />;
  const skill = data.skill;
  const found = data.files.filter((f) => f.found);
  const intro = <p className="muted">Coding agents need no MCP server: the CLI is their interface, and every command reads and writes JSON.</p>;
  // Once the plugin is in the project, Claude Code has the section through its skills: CLAUDE.md
  // needs none. Once the skills are in .agents/skills, neither do the files of the agents that read them.
  const pluginHere = !!skill?.published && skill.claudeCode.state === 'current' && !skill.claudeCode.blocked;
  const sharedHere = !!skill && skill.agents.state === 'current' && !skill.agents.blocked;
  const shared = skill?.skills.map((s) => s.shared) ?? [];
  const covered: Record<string, string | null> = {
    'CLAUDE.md': pluginHere ? 'the skills give Claude Code the section' : null,
    'AGENTS.md': sharedHere ? 'the skills give Codex and others the section' : null,
    '.cursor/rules': sharedHere ? 'Cursor reads the skills in .agents/skills' : null,
    '.github/copilot-instructions.md': sharedHere ? 'Copilot reads the skills in .agents/skills' : null,
  };
  const act = (agent: 'claude-code' | 'agents', a: AgentAction) => {
    const offer = agent === 'agents' ? skill?.agents : skill?.claudeCode;
    if (!offer?.install) return;
    if (!a.ask) return start(offer.install);
    const v = skill?.version ?? 'this version';
    setAsking({ install: offer.install, title: `Replace skills with ${v}’s copy?`, lead: `Puts ${v}’s copy in place of the skills edited here, and removes the files it doesn’t have.`, path: offer.path, others: agent === 'agents' });
  };
  const files = (
    <>
      {gone ? (
        <p className="muted agentsgone">{FILES_GONE}</p>
      ) : (
        <div className="agentfiles">
          {data.files
            // Cursor's rules and Copilot's file are listed only when the project has them; the others always.
            .filter((f) => f.found || (f.path !== '.cursor/rules' && f.path !== '.github/copilot-instructions.md'))
            .map((f) => {
              const skills = f.path === '.agents/skills' && skill ? sharedSkillsWords(f, skill.agents, skill.version, shared) : null;
              const w = skills ?? agentFileWords(f, covered[f.path] ?? null);
              return (
                <div key={f.path}>
                  <code>{f.path}</code>
                  <span className={w.tone}>{w.text}</span>
                  {skills?.action && skill ? <InstallButton small action={skills.action} command={skill.agents.install?.command ?? null} sub={`writes ${orList(shared, 'and')} to ${skill.agents.path}, from the copy that comes with the CLI`} onClick={() => act('agents', skills.action!)} /> : null}
                  {skills?.why ? <span className="warn agwhy">{skills.why}</span> : null}
                </div>
              );
            })}
        </div>
      )}
      {data.section ? (
        <>
          {/* Its Copy in the box's corner, Copy section. */}
          <CodeBox code={data.section} what="the section" className="md" />
          <p className="hintx">Paste it into {!gone && found.length && !found.some((f) => f.mentions) ? orList(found.map((f) => f.path)) : 'CLAUDE.md, AGENTS.md or your rules file'}.</p>
        </>
      ) : (
        <p className="muted">
          The section to paste is in <code>{data.source}</code>, under “Instructions to give it”.
        </p>
      )}
    </>
  );
  return (
    <Section className="set" title="Coding agents" sub="Claude Code, Codex, Cursor and others">
      {/* The skills' row only once the owner has published the plugin: before that, no install it can't complete, and nothing said about one. */}
      {skill?.published ? (
        <>
          <div className="pbody">{intro}</div>
          <SkillRow skill={skill} gone={gone} onAct={(a) => act('claude-code', a)} />
          <div className="pbody">{files}</div>
        </>
      ) : (
        <div className="pbody">
          {intro}
          {files}
        </div>
      )}
      {asking ? <ReplaceSkillsDialog {...asking} command={asking.install.command} onClose={() => setAsking(null)} onOk={() => start(asking.install)} /> : null}
    </Section>
  );
}

type Install = NonNullable<NonNullable<CodingAgentsSettings['skill']>['agents']['install']>;

/** Starts `skill-install` for an install the read model offers, and opens its drawer. */
function useInstall(): (install: Install) => void {
  const app = useApp();
  return (install) => app.guard(() => app.watchJob(app.client.startJob(install.job.kind, { agent: install.job.agent, replace: install.job.replace })));
}

/** Why an install button can't start now: the dashboard's own reason, the folder gone, or a dashboard without the job. */
function useInstallOff(command: string | null): string | null {
  const app = useApp();
  const gone = useFolderGone();
  return app.actionsOff ?? gone ?? (app.hasKind(SKILL_INSTALL_KIND) ? null : `This dashboard doesn’t install it: ${command ?? 'shadowlap skill install'} in a terminal`);
}

/**
 * An install, as the design's job button: small on a file's row, lime where it is the step to take;
 * its command on hover with what it writes, or why it can't start.
 */
function InstallButton({ action, command, sub, small = false, lime = false, onClick }: { action: AgentAction; command: string | null; sub: string; small?: boolean; lime?: boolean; onClick: () => void }) {
  const off = useInstallOff(command);
  return (
    <ActionButton className={`btn${small ? ' sm' : ''}${lime ? ' lime' : ''}`} why={off} title={`${command ?? 'shadowlap skill install'} · ${sub}`} onClick={onClick}>
      {action.label}
    </ActionButton>
  );
}

/**
 * The skills, once the owner has published the Claude Code plugin (the design's skillPanelRows):
 * they package the section below for Claude Code; its command and Install the skills in lime,
 * or where it is installed, with Commit it; and Show commands for every project, the commands that
 * install it in every project on this machine, in a box with its Copy. Another version's copy offers Update to this one; one edited here,
 * Replace…, which asks first; a way that is blocked says why. With the folder gone, what the project
 * has can't be read.
 */
function SkillRow({ skill, gone, onAct }: { skill: NonNullable<CodingAgentsSettings['skill']>; gone: string | null; onAct: (a: AgentAction) => void }) {
  const [open, setOpen] = useState(false);
  const offer = skill.claudeCode;
  const w = skillWords(offer, skill.version);
  const every = offer.everywhere;
  return (
    <div className="setrow skrow">
      <div>
        <b>The skills</b>
        <span>
          {skill.skills.map((s, i) => (
            <Fragment key={s.name}>
              {i ? ', and ' : ''}
              {s.name} {s.does}
            </Fragment>
          ))}
          : they package the section below for Claude Code, which uses each when a task calls for it, or on{' '}
          {skill.skills.map((s, i) => (
            <Fragment key={s.command}>
              {i ? ' and ' : ''}
              <code>{s.command}</code>
            </Fragment>
          ))}
          .
        </span>
        {gone ? (
          <span>{FILES_GONE}</span>
        ) : w.installed ? (
          <span>
            Installed in <code>{offer.path}</code>
            {skill.version ? `, ${skill.version}` : ''}. Commit it, and everyone working on the project has it too.
          </span>
        ) : (
          <>
            {w.line ? <span className={w.tone || undefined}>{w.line}</span> : null}
            {w.command ? (
              <div className="skcmd">
                <CommandLine command={w.command} />
              </div>
            ) : null}
          </>
        )}
        {every ? (
          <>
            <button className="linkbtn skall" type="button" aria-expanded={open} aria-controls="skall" onClick={() => setOpen((o) => !o)}>
              <Icon name="caret" />
              {open ? 'Hide' : 'Show'} commands for every project
            </button>
            {/* Its Copy, Copy commands. */}
            {open ? <CodeBox id="skall" command={every} className="skcmd" /> : null}
          </>
        ) : null}
      </div>
      {gone ? null : w.installed ? (
        <span className="st ok">
          <i />
          installed{skill.version ? ` · ${skill.version}` : ''}
        </span>
      ) : w.action && offer.install ? (
        <InstallButton action={w.action} command={offer.install.command} sub={`writes the plugin to ${offer.path}, where Claude Code loads it for everyone working on the project`} lime={!w.action.ask} onClick={() => onAct(w.action!)} />
      ) : null}
    </div>
  );
}

/** Replace skills: another version's copy over the ones edited here, red, as what goes doesn't come back. */
export function ReplaceSkillsDialog({ title, lead, path, others, command, onOk, onClose }: { title: string; lead: string; path: string; others: boolean; command: string; onOk: () => unknown; onClose: () => void }) {
  return (
    <ConfirmDialog
      title={title}
      lead={lead}
      doc="agents"
      facts={[{ label: 'Changes', value: <code>{path}</code>, wide: true }, others ? { label: 'Left alone', value: 'the other skills there' } : null]}
      ok="Replace skills"
      danger
      command={command}
      onClose={onClose}
      onOk={onOk}
    />
  );
}
