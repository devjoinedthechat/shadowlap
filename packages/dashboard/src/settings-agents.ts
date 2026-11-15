import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent, type Stats } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { skillOffer, type SkillOffer } from './agent-skill.js';
import { READ_LIMIT, type SettingsContext } from './settings-shared.js';
import { agentsSection, readShippedDoc } from './settings-docs.js';

/** Settings' Coding agents tab: the instructions files coding agents read here, and whether each mentions shadowlap. */

export interface AgentFile {
  /** As the project has it, relative to its folder. */
  path: string;
  /** Who reads it. */
  agents: string;
  found: boolean;
  /** `.agents/skills` is a folder of skills, `.cursor/rules` a folder of rule files or one file. Null when not found. */
  type: 'file' | 'folder' | null;
  /** It, or a file in the folder, already mentions shadowlap. */
  mentions: boolean;
}

export interface CodingAgentsSettings {
  files: AgentFile[];
  /** The section to paste, from docs/agents.md; null when the docs aren't installed with the dashboard. */
  section: string | null;
  source: string;
  /** The same instructions as skills, in the Claude Code plugin and in `.agents/skills`: what the project has of each, and their install (agent-skill.ts). */
  skill: SkillOffer;
}

/** The files coding agents read their project instructions from, and who reads each. */
const AGENT_FILES: Array<{ path: string; agents: string }> = [
  { path: 'CLAUDE.md', agents: 'Claude Code' },
  { path: 'AGENTS.md', agents: 'Codex, Cursor and others' },
  { path: '.agents/skills', agents: 'Codex, Cursor, GitHub Copilot, Gemini CLI and others' },
  { path: '.cursor/rules', agents: 'Cursor' },
  { path: '.github/copilot-instructions.md', agents: 'GitHub Copilot' },
];

const MENTION = /shadowlap/i;

/** How much of a rules folder is looked through: real ones hold a handful of files. */
const FOLDER_FILES = 200;

const FOLDER_DIRS = 50;

const FOLDER_DEPTH = 4;

const FOLDER_MS = 250;

function mentionsIn(file: string): boolean {
  try {
    if (statSync(file).size > READ_LIMIT) return false;
    return MENTION.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** Whether any file in a rules folder mentions shadowlap. Links inside it aren't followed, and the walk stops early on a folder far bigger than a rules folder. */
function folderMentions(dir: string): boolean {
  const stack: Array<[string, number]> = [[dir, 0]];
  const deadline = Date.now() + FOLDER_MS;
  let files = 0;
  let dirs = 0;
  while (stack.length && files < FOLDER_FILES && dirs < FOLDER_DIRS && Date.now() < deadline) {
    const [at, depth] = stack.pop()!;
    dirs++;
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(at, e.name);
      if (e.isDirectory()) {
        if (depth < FOLDER_DEPTH) stack.push([full, depth + 1]);
      } else if (e.isFile() && ++files <= FOLDER_FILES && mentionsIn(full)) return true;
    }
  }
  return false;
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * The Coding agents tab: which instruction files the project has and whether each mentions
 * shadowlap yet, the section to paste, and the plugin and the skills that package it: what the
 * project has of each, and their install. Only a yes or no leaves each file, never its text. A
 * folder (`.agents/skills`, `.cursor/rules`) that is a link to somewhere outside the project is not
 * looked through.
 */
export function codingAgentsSettings(ctx: Pick<SettingsContext, 'cwd'>, options: { agentsDoc?: string | null; skill?: SkillOffer } = {}): CodingAgentsSettings {
  const files = AGENT_FILES.map(({ path, agents }): AgentFile => {
    const full = join(ctx.cwd, path);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      return { path, agents, found: false, type: null, mentions: false };
    }
    if (st.isDirectory()) {
      let walk: boolean;
      try {
        walk = !lstatSync(full).isSymbolicLink() || inside(realpathSync(full), realpathSync(ctx.cwd));
      } catch {
        walk = false;
      }
      return { path, agents, found: true, type: 'folder', mentions: walk && folderMentions(full) };
    }
    return { path, agents, found: st.isFile(), type: st.isFile() ? 'file' : null, mentions: st.isFile() && mentionsIn(full) };
  });
  const doc = options.agentsDoc !== undefined ? options.agentsDoc : readShippedDoc('agents.md');
  return { files, section: doc === null ? null : agentsSection(doc), source: 'docs/agents.md', skill: options.skill ?? skillOffer({ cwd: ctx.cwd }) };
}
