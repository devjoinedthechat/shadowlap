// Copies the docs pages the Settings screen reads when it is asked for them (the section to paste
// into a coding agent's instructions, from agents.md; the MCP client config, from mcp.md) into
// dist/docs, so a dashboard installed from npm has them as well as a checkout of the repository.
//
// It also copies the coding agents' instructions, packaged (coding-agents/: the Claude Code plugin
// and the Cursor rule), into dist/coding-agents, laid out as the repository lays them out.
// `shadowlap skill install` installs from that copy (src/agent-skill.ts), so what it puts in a project
// is the version of the CLI it came with, and it needs no network.
//
// build-ui.mjs runs it. Usage: node packages/dashboard/copy-docs.mjs
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const out = join(here, 'dist', 'docs');
mkdirSync(out, { recursive: true });
for (const name of ['agents.md', 'mcp.md']) cpSync(join(repo, 'docs', name), join(out, name));

const agents = join(here, 'dist', 'coding-agents');
rmSync(agents, { recursive: true, force: true });
cpSync(join(repo, 'coding-agents'), agents, { recursive: true });
