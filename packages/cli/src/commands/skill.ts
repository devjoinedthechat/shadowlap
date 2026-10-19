import { Argument, Command } from 'commander';
import { CODING_AGENTS, SKILL_COMMAND, installCodingAgent, type CodingAgent, type InstallResult } from '@shadowlap/dashboard';
import { recordActivity } from '../activity.js';
import { emitJobEvent } from '../job-events.js';
import type { GlobalOpts } from '../shared.js';
import { palette as p, safe } from '../ui.js';

/**
 * `shadowlap skill install`: the coding agents' instructions, packaged (docs/agents.md), put into the
 * project from the copy that comes with the CLI. The Claude Code plugin goes into
 * `.claude/skills/shadowlap`, where Claude Code loads it for everyone working on the project; the
 * Cursor rule into `.cursor/rules/shadowlap.mdc`. Settings → Coding agents runs it as the
 * `skill-install` job.
 */
export function register(program: Command): void {
  const skill = program.command('skill').description("The coding agents' instructions, packaged: the Claude Code plugin with its skill, debug-agent, and the Cursor rule");

  skill
    .command('install')
    .description("Put this version's Claude Code plugin into .claude/skills/shadowlap, where Claude Code loads it for everyone working on the project, or with cursor the Cursor rule into .cursor/rules/shadowlap.mdc. The copy comes with the CLI: nothing is downloaded")
    .addArgument(new Argument('[agent]', 'claude-code or cursor').choices(CODING_AGENTS).default('claude-code'))
    .option('--force', "replace what is there when it isn't this version's copy (another version's, or one edited here); for claude-code, also remove the files in the plugin's folder this version doesn't have")
    .option('--json', 'machine-readable output: what was there, what was done to each file, and why when nothing was')
    .action((agent: CodingAgent, flags: { force?: boolean; json?: boolean }) => {
      const result = installCodingAgent(process.cwd(), agent, { replace: flags.force === true });
      if (result.outcome === 'installed' || result.outcome === 'updated') {
        recordActivity(program.opts<GlobalOpts>(), {
          kind: 'skill.installed',
          ref: agent,
          data: { path: result.path, version: result.version, outcome: result.outcome, previous: result.installedVersion },
        });
      }
      process.stdout.write((flags.json ? JSON.stringify(result, null, 2) : formatInstall(result)) + '\n');
      emitJobEvent({ type: 'result', data: result });
      if (result.outcome === 'refused') process.exitCode = 1;
    });
}

/** What `skill install` says it did, for people. */
export function formatInstall(r: InstallResult): string {
  const what = r.agent === 'claude-code' ? 'the Claude Code plugin' : 'the Cursor rule';
  const count = (action: string, word: string) => {
    const n = r.files.filter((f) => f.action === action).length;
    return n ? `${n} ${word}` : null;
  };
  const lines: string[] = [];
  if (r.outcome === 'refused') {
    lines.push(`${p.red('✗')} Nothing was changed: ${safe(r.reason ?? '')}`);
    for (const f of r.files) lines.push(`    ${safe(f.path)}  ${f.action === 'extra' ? p.dim(`not in ${r.version}’s copy`) : p.dim('differs')}`);
    return lines.join('\n');
  }
  if (r.outcome === 'unchanged') return `${p.green('✓')} ${safe(r.path)} already holds ${what}, ${r.version}`;
  if (r.outcome === 'installed') lines.push(`${p.green('✓')} Installed ${what}, ${r.version}, in ${safe(r.path)}`);
  else lines.push(`${p.green('✓')} Updated ${what} in ${safe(r.path)}${r.installedVersion && r.installedVersion !== r.version ? ` from ${safe(r.installedVersion)}` : ''} to ${r.version} (${[count('replaced', 'replaced'), count('written', 'added'), count('removed', 'removed')].filter(Boolean).join(', ')})`);
  if (r.agent === 'claude-code') {
    lines.push(`  Claude Code loads it in this project once you trust the folder, and Claude uses the skill when a task calls for it, or on ${SKILL_COMMAND}.`);
    lines.push(`  Commit ${safe(r.path)}, and everyone working on the project has it too.`);
  } else {
    lines.push('  Cursor’s Agent applies it when it finds it relevant. Commit it, and everyone working on the project has it too.');
  }
  return lines.join('\n');
}
