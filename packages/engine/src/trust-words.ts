/**
 * Where a read's untrusted mark came from, in the words `shadowlap show` names it with and the
 * dashboard's untrusted tag titles its card with: the config's `tools`, the SDK's `trust` option, an
 * MCP server's `openWorldHint`. No imports but a type: the dashboard's pages bundle it as it is.
 */
import type { TrustSource } from './injection.js';

export const TRUST_FROM: Readonly<Record<TrustSource, string>> = { config: 'config', sdk: 'SDK', mcp: 'MCP openWorldHint' };
