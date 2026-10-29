import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Effect } from '@shadowlap/engine';
import { isObject } from '@shadowlap/engine';
import { signalExit } from './exit-codes.js';
import { idKey, isRequest, isToolCall, lines, refuseBatch, ToolCalls, type JsonRpcMessage, type LiveCall, type ProxySidecar } from './mcp-calls.js';
import { startCommand } from './start-command.js';

/** `shadowlap mcp -- <command>`: the proxy in front of a local MCP server, which it starts and speaks stdio to. */

/** Package runners whose first argument names the server, when only flags without values come before it. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);
const RUNNER_FLAGS = new Set(['-y', '--yes', '-q', '--quiet']);
const PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~-]+)?$/i;

/** A local server's name for the recording: its command, and the package a runner like npx starts. */
export function stdioServerName(command: string, args: readonly string[]): string {
  const name = (command.split(/[\\/]/).pop() ?? command).replace(/\.(?:cmd|exe|bat)$/i, '');
  if (!RUNNERS.has(name)) return name;
  for (const a of args) {
    if (RUNNER_FLAGS.has(a)) continue;
    return PACKAGE.test(a) ? `${name} ${a}` : name;
  }
  return name;
}

export interface McpProxyOptions {
  /** From and to the MCP client (the agent). */
  clientIn: Readable;
  clientOut: Writable;
  server: { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  sidecar: ProxySidecar;
  /** Effects by tool name; wins over the server's annotations. */
  effects?: Record<string, Effect>;
  log?: (line: string) => void;
}

export function startMcpProxy(o: McpProxyOptions): { child: ChildProcess; done: Promise<number> } {
  // `npx -y some-server` runs through cmd.exe on Windows, where npx is a batch file.
  const start = startCommand(o.server.command, o.server.args, { env: o.server.env ?? process.env });
  const child = spawn(start.command, start.args, { ...start.options, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<string, { method: string; live?: LiveCall }>();
  const calls = new ToolCalls(o.sidecar, o.effects, o.log, { transport: 'stdio', server: stdioServerName(o.server.command, o.server.args) });
  const toServer = (raw: string) => {
    child.stdin.write(raw + '\n');
  };
  const toClient = (raw: string) => {
    o.clientOut.write(raw + '\n');
  };

  // Client → server. tools/call is resolved through the sidecar; everything else passes through.
  lines(
    o.clientIn,
    async (msg, raw) => {
      if (Array.isArray(msg) && !calls.transparent && msg.some(isToolCall)) {
        // The rest of the batch still reaches the server, one message at a time.
        for (const item of msg) if (!isRequest(item)) toServer(JSON.stringify(item));
        const errors = refuseBatch(msg);
        if (errors.length) toClient(JSON.stringify(errors));
        return;
      }
      if (!isRequest(msg)) return toServer(raw);
      if (msg.method !== 'tools/call') {
        pending.set(idKey(msg.id), { method: msg.method });
        return toServer(raw);
      }
      const route = await calls.route(msg);
      if ('answer' in route) return toClient(JSON.stringify(route.answer));
      pending.set(idKey(msg.id), { method: msg.method, ...(route.live ? { live: route.live } : {}) });
      return toServer(raw);
    },
    () => child.stdin.end(),
  );

  // Server → client. Responses to tools/call complete the recorded call first; tools/list responses teach the effects.
  lines(
    child.stdout,
    async (msg, raw) => {
      const m = isObject(msg) ? (msg as JsonRpcMessage) : null;
      if (!m || m.id === undefined || m.id === null || m.method !== undefined) return toClient(raw);
      const p = pending.get(idKey(m.id));
      if (!p) return toClient(raw);
      pending.delete(idKey(m.id));
      if (p.method === 'tools/list') calls.learn(m.result);
      if (p.live) await calls.complete(p.live, m);
      toClient(raw);
    },
    () => {},
  );

  const done = new Promise<number>((resolve) => {
    child.on('error', (err) => {
      o.log?.(`failed to start ${o.server.command}: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      // A call the server never answered still ends in the recording, as the agent saw it end.
      const unanswered = [...pending.values()].filter((p) => p.live);
      pending.clear();
      // A server a signal ended ends the proxy as a shell reports it: 128 + the signal's number.
      void Promise.all(unanswered.map((p) => calls.complete(p.live!, { error: { code: -32000, message: 'the MCP server exited before answering' } }))).then(() => resolve(code ?? (signal ? signalExit(signal) : 1)));
    });
  });
  return { child, done };
}
