import type { Effect } from '@shadowlap/engine';
import { STOP_SIGNALS } from './agent-signals.js';
import type { ProxySidecar } from './mcp-calls.js';
import { mcpServerUrl, parseHeaderFlags, startMcpHttpProxy } from './mcp-http.js';
import { listen, listenAddress } from './mcp-listen.js';
import { findSidecar } from './mcp-sidecar.js';
import { startMcpProxy } from './mcp-stdio.js';

export { isLoopbackUrl, type SidecarTarget } from './agent-registry.js';
export { effectFromAnnotations, openWorld, type McpOrigin, type ProxySidecar } from './mcp-calls.js';
export { mcpServerUrl, parseHeaderFlags, startMcpHttpProxy, type McpHttpProxyOptions } from './mcp-http.js';
export { listenAddress, sessionRun, sessionSidecar, startMcpListener, type ClientEnd, type McpListener, type McpListenOptions } from './mcp-listen.js';
export { discoverSidecar, findSidecar, type DiscoverySkip } from './mcp-sidecar.js';
export { startMcpProxy, stdioServerName, type McpProxyOptions } from './mcp-stdio.js';

/**
 * `shadowlap mcp`: a proxy in front of an MCP server, which the agent's MCP client starts instead of
 * the server and talks to over stdio exactly as it would to the server. Two kinds of server:
 *
 * - `shadowlap mcp -- <command>` starts a local server and speaks stdio to it;
 * - `shadowlap mcp --url <server>` speaks Streamable HTTP to a remote one: each message is a POST,
 *   answered with JSON or an event stream, in the session the server names in `Mcp-Session-Id`.
 *
 * Either way, `tools/call` requests go through the sidecar like SDK tool calls (recorded, replayed,
 * blocked or stubbed); every other message passes through untouched. Effects come from the server's
 * tool annotations (`readOnlyHint` → read, otherwise write), overridden by `--effect name=read` or
 * the `mcp.effects` config; a read tool with `openWorldHint: true` is recorded untrusted, where
 * `shadowlap injection` plants. A call the recording answers never reaches the server, and a write
 * after a fork is refused or stubbed here, so a remote write never runs again on replay. When the
 * proxy was started under Shadowlap but can't record (its sidecar can't be found or asked), it
 * refuses writes rather than send them unrecorded: this could be a replay.
 *
 * Each transport has a module: mcp-stdio.ts for a local server, mcp-http.ts for a remote one,
 * mcp-listen.ts for a remote one served over HTTP (--listen); mcp-calls.ts holds what they share, and
 * mcp-sidecar.ts finds the run a proxy records into.
 */

/** `name=effect` flags into a map. */
export function parseEffectFlags(flags: string[]): Record<string, Effect> {
  const out: Record<string, Effect> = {};
  for (const f of flags) {
    const i = f.indexOf('=');
    const name = i > 0 ? f.slice(0, i) : '';
    const effect = f.slice(i + 1);
    if (!name || (effect !== 'pure' && effect !== 'read' && effect !== 'write')) throw new Error(`--effect expects <tool>=<pure|read|write>, got "${f}"`);
    out[name] = effect;
  }
  return out;
}

/**
 * `shadowlap mcp`: the proxy in front of a local server (`argv`) or a remote one (`--url`), with the
 * sidecar of the run it was started under, if any. Resolves with the exit code.
 */
export async function runMcp(argv: string[], flags: { url?: string; header: string[]; effect: string[]; allowHttp?: boolean; listen?: string }, effectsFromConfig: Record<string, Effect> | undefined): Promise<number> {
  if (flags.url && argv.length) throw new Error('give the server as a command after -- or as --url, not both');
  if (!flags.url && !argv.length) throw new Error('give the MCP server: shadowlap mcp -- <server command>, or shadowlap mcp --url <server>');
  if (!flags.url && flags.header.length) throw new Error('--header is for a server reached with --url');
  if (!flags.url && flags.allowHttp) throw new Error('--allow-http is for a server reached with --url');
  if (flags.listen !== undefined && !flags.url) throw new Error('--listen serves a remote server over HTTP: give it with --url');
  const effects = { ...effectsFromConfig, ...parseEffectFlags(flags.effect) };
  const log = (line: string) => process.stderr.write(`[shadowlap mcp] ${line}\n`);
  const headers = parseHeaderFlags(flags.header);
  const url = flags.url ? mcpServerUrl(flags.url, Object.keys(headers).length > 0, flags.allowHttp === true) : null;
  const at = flags.listen !== undefined ? listenAddress(flags.listen) : null;
  const found = await findSidecar(process.env, process.cwd(), log);
  if (url && at) return listen(url, at, headers, effects, found, log);
  let sidecar: ProxySidecar = null;
  if (found.kind === 'sidecar') {
    sidecar = found.target;
    // Said once, up front: a sidecar that doesn't answer means every write will be refused.
    const answers = await fetch(`${found.target.url}/v1/health`, { signal: AbortSignal.timeout(2000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (!answers) log(`the Shadowlap sidecar named by ${found.from === 'SHADOWLAP_URL' ? 'SHADOWLAP_URL' : found.from} does not answer, so write tools will be refused. Outside a Shadowlap run, unset SHADOWLAP_URL`);
  } else if (found.kind === 'unusable') {
    sidecar = { unusable: found.reason };
    log(`can't record: ${found.reason}. Write tools will be refused; read tools pass through unrecorded`);
  } else log('no active run (no SHADOWLAP_URL, and no Shadowlap command started this process): passing everything through');
  if (url) return startMcpHttpProxy({ clientIn: process.stdin, clientOut: process.stdout, url: url.href, headers, sidecar, effects, log }).done;
  const { child, done } = startMcpProxy({ clientIn: process.stdin, clientOut: process.stdout, server: { command: argv[0]!, args: argv.slice(1) }, sidecar, effects, log });
  // A stop signal reaches the server too, a closed terminal's as well. The proxy ends with its
  // server: once it has exited, nothing more is read from a client that holds its end open.
  const onSignal = (sig: NodeJS.Signals) => child.kill(sig);
  for (const s of STOP_SIGNALS) process.on(s, onSignal);
  return done.finally(() => {
    for (const s of STOP_SIGNALS) process.off(s, onSignal);
    process.stdin.destroy();
  });
}
