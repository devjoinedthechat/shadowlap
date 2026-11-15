import { Argument, Command } from 'commander';
import { AGENTS_FOLDER_READERS, CODING_AGENTS, SKILLS, TARGETS, codingAgent, installCodingAgent, type InstallResult } from '@shadowlap/dashboard';
import { recordActivity } from '../activity.js';
import { EXIT } from '../exit-codes.js';
import { emitJobEvent } from '../job-events.js';
import type { GlobalOpts } from '../shared.js';
import { palette as p, safe } from '../ui.js';

/**
 * `shadowlap skill install`: the coding agents' instructions, packaged as skills (docs/agents.md),
 * put into the project from the copy that comes with the CLI. The Claude Code plugin goes into
 * `.claude/skills/shadowlap`, where Claude Code loads it for everyone working on the project; the
 * skills alone into `.agents/skills`, where Codex, Cursor, GitHub Copilot, Gemini CLI and most other
 * coding agents read them (each of their names installs there too), or into `.kiro/skills` for Kiro.
 * Settings → Coding agents runs it as the `skill-install` job.
 */
export function register(program: Command): void {
  const skill = program.command('skill').description(`The coding agents' instructions, packaged as skills (${SKILLS.map((s) => s.name).join(' and ')}): a Claude Code plugin, or the skills alone for the folder other coding agents read`);

  skill
    .command('install')
    .description(
      "Put this version's skills into the project: the Claude Code plugin into .claude/skills/shadowlap, where Claude Code loads it for everyone working on the project; with agents (or codex, cursor, copilot, gemini or another agent's name), the skills into .agents/skills, where most other coding agents read them; with kiro, into .kiro/skills. The copy comes with the CLI: nothing is downloaded",
    )
    .addArgument(new Argument('[agent]', `claude-code, agents (also ${AGENTS_FOLDER_READERS.join(', ')}) or kiro`).choices([...CODING_AGENTS, ...AGENTS_FOLDER_READERS]).default('claude-code'))
    .option('--force', "replace what is there when it isn't this version's copy (another version's, or one edited here), and remove the files of ours this version doesn't have")
    .option('--json', 'machine-readable output: what was there, what was done to each file, and why when nothing was')
    .action((name: string, flags: { force?: boolean; json?: boolean }) => {
      // Commander has checked the name against the choices: every one of them goes somewhere.
      const agent = codingAgent(name)!;
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
      if (result.outcome === 'refused') process.exitCode = EXIT.failed;
    });
}

/** What `skill install` says it did, for people. */
export function formatInstall(r: InstallResult): string {
  const target = TARGETS[r.agent];
  const what = target.kind === 'plugin' ? 'the Claude Code plugin' : 'shadowlap’s skills';
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
  if (target.kind === 'plugin') {
    lines.push(`  Claude Code loads it in this project once you trust the folder. Claude uses each skill when a task calls for it, or on ${SKILLS.map((s) => s.command).join(' and ')}.`);
    lines.push(`  Commit ${safe(r.path)}, and everyone working on the project has it too.`);
  } else {
    lines.push(`  ${target.readers} read skills from there, and use ${SKILLS.map((s) => s.shared).join(' and ')} when a task calls for them.`);
    lines.push('  Commit them, and everyone working on the project has them too.');
  }
  return lines.join('\n');
}
