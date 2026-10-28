import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The docs pages Settings quotes, as shipped with the dashboard: the section a coding agent's instructions file takes, and an MCP client's config. */

/** The fenced block under "Instructions to give it" in docs/agents.md: what to paste into CLAUDE.md. */
export function agentsSection(doc: string): string | null {
  const from = doc.indexOf('## Instructions to give it');
  return fencedBlock(from >= 0 ? doc.slice(from) : doc, 'md');
}

/** The fenced code blocks in `text` marked `lang`, in order, without their fences. */
function fencedBlocks(text: string, lang: string): string[] {
  const re = new RegExp('^```' + lang + '[ \\t]*\\r?\\n([\\s\\S]*?)^```[ \\t]*$', 'gm');
  return [...text.matchAll(re)].map((m) => m[1]!.replace(/\r?\n$/, ''));
}

function fencedBlock(text: string, lang: string): string | null {
  return fencedBlocks(text, lang)[0] ?? null;
}

/** The client configuration example in docs/mcp.md: its first JSON block that lists servers. */
export function mcpClientConfig(doc: string): string | null {
  return fencedBlocks(doc, 'json').find((block) => block.includes('"mcpServers"')) ?? null;
}

const MONOREPO = 'shadowlap-monorepo';

/**
 * A page of the docs, read when it is asked for so the page and the docs never disagree: from a copy
 * shipped in the dashboard's build (dist/docs/<name>), else from the repository it was built in.
 * Null when neither is there.
 */
export function readShippedDoc(name: string): string | null {
  const shipped = fileURLToPath(new URL(`./docs/${name}`, import.meta.url));
  if (existsSync(shipped)) return readFileSync(shipped, 'utf8');
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name === MONOREPO) return readFileSync(join(root, 'docs', name), 'utf8');
  } catch {
    // installed without the docs
  }
  return null;
}
