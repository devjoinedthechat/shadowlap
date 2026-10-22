import { Fragment, useState } from 'react';
import { CopyButton } from '../../components/bits.js';
import { ConfirmDialog } from '../../components/Dialog.js';
import { Icon } from '../../components/Icon.js';
import type { CodingAgentsSettings } from '../../settings-api.js';
import { useApp } from '../../state.js';
import { CommandLine, FILES_GONE, LoadProblem, Loading, useFolderGone, useSettingsData } from './common.js';
import { agentFileWords, cursorRuleWords, orList, SKILL_INSTALL_KIND, skillWords, type AgentAction } from './logic.js';

/**
 * Coding agents, as the design has it (codingAgentsPanel): coding agents need no MCP server, the CLI
 * is their interface; which instruction files the project has (CLAUDE.md, AGENTS.md, .cursor/rules,
 * Copilot's) and whether each mentions Shadowlap yet, the `.cursor/rules` row with the Cursor rule
 * `shadowlap skill install cursor` adds; and the section from docs/agents.md to paste. Once the
 * owner has published the Claude Code plugin (SKILL_PUBLISHED), The skill row above the files
 * installs it (skillPanelRows). The states the design doesn't show come from the read model
 * (`skillOffer()`): another version's copy offers Update, one edited here Replace…, which asks
 * first, and a way that is blocked says why, with no button. With the project's folder gone, its
 * files can't be read, and the list says so.
 */
export function AgentsTab() {
  const { client } = useApp();
  const { data, error } = useSettingsData(() => client.settings.agents(), 'settings:agents');
  const gone = useFolderGone();
  const [asking, setAsking] = useState<{ install: Install; title: string; text: string } | null>(null);
  const start = useInstall();
  if (error && !data) return <LoadProblem error={error} />;
  if (!data) return <Loading title="Coding agents" />;
  const skill = data.skill;
  const found = data.files.filter((f) => f.found);
  const intro = <p className="muted">Coding agents need no MCP server: the CLI is their interface, and every command reads and writes JSON.</p>;
  // Once the skill is in the project, Claude Code has the section through it: CLAUDE.md needs none.
  const skillHere = !!skill?.published && skill.claudeCode.state === 'current' && !skill.claudeCode.blocked;
  const act = (agent: 'claude-code' | 'cursor', a: AgentAction) => {
    const offer = agent === 'cursor' ? skill?.cursor : skill?.claudeCode;
    if (!offer?.install) return;
    if (!a.ask) return start(offer.install);
    const v = skill?.version ?? 'this version';
    setAsking(
      agent === 'cursor'
        ? { install: offer.install, title: `Replace the Cursor rule with ${v}’s copy?`, text: `${offer.path} was edited here, or is another version’s: ${v}’s copy goes in its place, and what is there now is gone.` }
        : { install: offer.install, title: `Replace the skill with ${v}’s copy?`, text: `${offer.path} was edited here: ${v}’s copy goes in its place, and the files it doesn’t have are removed.` },
    );
  };
  const files = (
    <>
      {gone ? (
        <p className="muted agentsgone">{FILES_GONE}</p>
      ) : (
        <div className="agentfiles">
          {data.files
            // Copilot's file is listed only when the project has it; the other three always, as the design does.
            .filter((f) => f.found || f.path !== '.github/copilot-instructions.md')
            .map((f) => {
              const rule = f.path === '.cursor/rules' && skill ? cursorRuleWords(f, skill.cursor, skill.version) : null;
              const w = rule ?? agentFileWords(f, f.path === 'CLAUDE.md' && skillHere);
              return (
                <div key={f.path}>
                  <code>{f.path}</code>
                  <span className={w.tone}>{w.text}</span>
                  {rule?.action && skill ? <InstallButton small action={rule.action} command={skill.cursor.install?.command ?? null} sub={`writes the rule to ${skill.cursor.path}, from the copy that comes with the CLI`} onClick={() => act('cursor', rule.action!)} /> : null}
                  {rule?.why ? <span className="warn agwhy">{rule.why}</span> : null}
                </div>
              );
            })}
        </div>
      )}
      {data.section ? (
        <>
          <pre className="codebox md" tabIndex={0}>
            {data.section}
          </pre>
          <div className="actions">
            <CopyButton text={data.section} label="the section" className="btn">
              Copy the section
            </CopyButton>
            <span className="hintx">Paste it into {!gone && found.length && !found.some((f) => f.mentions) ? orList(found.map((f) => f.path)) : 'CLAUDE.md, AGENTS.md or your rules file'}.</span>
          </div>
        </>
      ) : (
        <p className="muted">
          The section to paste is in <code>{data.source}</code>, under “Instructions to give it”.
        </p>
      )}
    </>
  );
  return (
    <section className="panel set">
      <header>
        <h2>Coding agents</h2>
        <span className="sub">Claude Code, Cursor, Codex</span>
      </header>
      {/* The skill's row only once the owner has published the plugin: before that, no install it can't complete, and nothing said about one. */}
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
      {asking ? (
        <ConfirmDialog
          title={asking.title}
          text={asking.text}
          ok="Replace"
          danger
          command={asking.install.command}
          onClose={() => setAsking(null)}
          onOk={() => {
            setAsking(null);
            start(asking.install);
          }}
        />
      ) : null}
    </section>
  );
}

type Install = NonNullable<NonNullable<CodingAgentsSettings['skill']>['cursor']['install']>;

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
    <button className={`btn${small ? ' sm' : ''}${lime && !off ? ' lime' : ''}`} type="button" disabled={!!off} title={off ?? `${command ?? 'shadowlap skill install'} · ${sub}`} onClick={onClick}>
      {action.label}
    </button>
  );
}

/**
 * The skill, once the owner has published the Claude Code plugin (the design's skillPanelRows):
 * debug-agent packages the section below for Claude Code; its command and Install the skill in lime,
 * or where it is installed, with Commit it; and the commands that install it in every project on
 * this machine, with Copy. Another version's copy offers Update to this one; one edited here,
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
        <b>The skill</b>
        <span>
          debug-agent packages the section below for Claude Code: Claude uses it when a task calls for it, or on <code>{skill.command}</code>.
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
            <button className="linkbtn skall" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Icon name="caret" />
              In every project on this machine
            </button>
            {open ? (
              <>
                <div className="cmdline skcmd">
                  {every.map((c, i) => (
                    <Fragment key={c}>
                      {i ? <br /> : null}
                      <b>$</b>
                      <span>{c}</span>
                    </Fragment>
                  ))}
                </div>
                <CopyButton text={every.join('\n')} label="Claude Code’s install commands">
                  Copy
                </CopyButton>
              </>
            ) : null}
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
