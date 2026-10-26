// Copies the docs pages the Settings screen reads when it is asked for them (the section to paste
// into a coding agent's instructions, from agents.md; the MCP client config, from mcp.md) into
// dist/docs, so a dashboard installed from npm has them as well as a checkout of the repository.
//
// It also copies the coding agents' instructions, packaged (coding-agents/: the Claude Code plugin
// with its skills), into dist/coding-agents, laid out as the repository lays them out.
// `shadowlap skill install` installs from that copy (src/agent-skill.ts), so what it puts in a project
// is the version of the CLI it came with, and it needs no network. The files a system leaves in a
// folder someone opened (Finder's .DS_Store, Windows' Thumbs.db), which .gitignore keeps out of the
// repository, are left out of the copy too.
//
// build-ui.mjs runs it. Usage: node packages/dashboard/copy-docs.mjs
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const out = join(here, 'dist', 'docs');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of ['agents.md', 'mcp.md']) cpSync(join(repo, 'docs', name), join(out, name));

/** What a system leaves in a folder, never part of the repository. */
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db']);

const agents = join(here, 'dist', 'coding-agents');
rmSync(agents, { recursive: true, force: true });
cpSync(join(repo, 'coding-agents'), agents, { recursive: true, filter: (from) => !SYSTEM_FILES.has(basename(from)) });
