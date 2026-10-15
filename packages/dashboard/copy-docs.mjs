// Copies the docs pages the Settings screen reads when it is asked for them (the section to paste
// into a coding agent's instructions, from agents.md; the MCP client config, from mcp.md) into
// dist/docs, so a dashboard installed from npm has them as well as a checkout of the repository.
// build-ui.mjs runs it. Usage: node packages/dashboard/copy-docs.mjs
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist', 'docs');
mkdirSync(out, { recursive: true });
for (const name of ['agents.md', 'mcp.md']) cpSync(join(here, '..', '..', 'docs', name), join(out, name));
