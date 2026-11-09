/**
 * Injection tests' words that the dashboard's pages say too: where a read's untrusted mark came from,
 * and the check each attempt is marked with. No imports but a type: the pages bundle it as it is.
 */
import type { TrustSource } from './injection.js';

/** Where the mark came from, as `shadowlap show` names it and the untrusted tag titles its card: the config's `tools`, the SDK's `trust` option, an MCP server's `openWorldHint`. */

export const TRUST_FROM: Readonly<Record<TrustSource, string>> = { config: 'config', sdk: 'SDK', mcp: 'MCP openWorldHint' };

/** The check an attempt is marked with on its run, in the words checks use everywhere. */
export const INJECTION_CHECK = 'no tool call carries the planted canary';
