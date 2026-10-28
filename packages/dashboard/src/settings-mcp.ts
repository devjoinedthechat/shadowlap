import { readFileSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { isObject, messageOf } from '@shadowlap/engine';
import { type ToolReads } from './tool-reads.js';
import { HIDDEN, hideSecrets, hideUrlCredentials, hideUrlSecrets, PROXY_REFERENCE, REFERENCE, SCHEME, withoutCredentials } from './settings-secrets.js';
import { READ_LIMIT, str } from './settings-shared.js';

/**
 * The MCP servers the Tools tab lists: read from the MCP clients' config files, each as `shadowlap mcp`
 * would record it, its secrets kept off the page, and a command line split as a shell would.
 */

export interface McpServerRow {
  name: string;
  /** The project file that lists it. */
  file: string;
  transport: 'stdio' | 'http';
  /** The command line or URL, with anything that looks like a credential hidden. */
  target: string;
  /** Its entry already starts `shadowlap mcp`. */
  viaShadowlap: boolean;
  /**
   * The `shadowlap mcp` line in front of it: as the entry has it, or as it would be. A remote
   * server's headers become `--header "Name: ${VAR}"`, which `shadowlap mcp` fills in from its
   * environment, with VAR in `env`.
   */
  line: string;
  /** What the client's entry takes instead of its command and args. */
  entry: { command: string; args: string[] };
  /** Something that looked like a credential is shown as ••• in `target`, `line` and `entry`. */
  hidden: boolean;
  /**
   * The entry's environment as the client config to copy writes it: a value that is only a
   * reference (`${GITHUB_TOKEN}`) as it is, any other as `…`, never its text; and for a remote
   * server, a variable for each header's value.
   */
  env: Array<{ name: string; value: string }>;
  /** What a copy of its entry leaves out, to put back before the client starts it: `GITHUB_TOKEN`, `the ••• in its command`. */
  putBack: string[];
  /** What a copy of its entry leaves out for good, and why: its URL's user and password, when its own Authorization header signs in. */
  notes: string[];
  /** How `shadowlap mcp` names the server in what it records: its transport, and its host or its command (with the package a runner such as npx starts). */
  recordedAs: { transport: 'stdio' | 'http'; server: string };
  /** What the recordings hold from it (McpRecordedServer), or null when nothing was recorded through it. */
  recorded: McpRecordedServer | null;
}

/** An MCP server recorded tool calls came through, by the name `shadowlap mcp` gave it (call meta `mcp`). */
export interface McpRecordedServer {
  transport: 'stdio' | 'http';
  server: string;
  /**
   * The tools it offers and how many of those are writes, from the latest call that listed them
   * (`listed`); without such a call, the tools called through it.
   */
  tools: number;
  writes: number;
  listed: boolean;
  calls: number;
  lastAt: number;
  /** A server in one of the project's client configs has this name. */
  inConfig: boolean;
}

/** One client config to copy. */
export interface ClientConfigBlock {
  /** The project file it stands for, or null for the docs' example. */
  file: string | null;
  text: string;
  /** Per server, each value the copy leaves out, to put back before the client starts it. */
  putBack: Array<{ server: string; values: string[] }>;
  /** Per server, what the copy leaves out for good, and why (`McpServerRow.notes`). */
  notes: Array<{ server: string; text: string }>;
}

/** The MCP servers recorded calls came through, with their tools and writes (Store.mcpServerUsage). */
export function recordedMcpServers(usage: ToolReads['mcp']): McpRecordedServer[] {
  return usage.flatMap((u): McpRecordedServer[] => {
    if (u.transport !== 'stdio' && u.transport !== 'http') return [];
    const called = new Map<string, boolean>();
    for (const c of u.called) called.set(c.name, (called.get(c.name) ?? false) || c.effect === 'write');
    const tools = u.tools ? u.tools.length : called.size;
    const writes = u.tools ? u.tools.filter((t) => t.effect === 'write').length : [...called.values()].filter(Boolean).length;
    return [{ transport: u.transport, server: u.server, tools, writes, listed: u.tools !== null, calls: u.calls, lastAt: u.lastAt, inConfig: false }];
  });
}

/** Package runners whose first argument names the server, when only flags without values come before it. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);

const RUNNER_FLAGS = new Set(['-y', '--yes', '-q', '--quiet']);

const PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~-]+)?$/i;

/**
 * A local server's name as `shadowlap mcp` records it (call meta `mcp.server`): its command, and the
 * package a runner like npx starts; never its other arguments, which can hold secrets. Kept in step
 * with stdioServerName in the CLI's mcp-stdio.ts.
 */
export function stdioServerName(command: string, args: readonly string[]): string {
  const name = (command.split(/[\\/]/).pop() ?? command).replace(/\.(?:cmd|exe|bat)$/i, '');
  let out = name;
  if (RUNNERS.has(name)) {
    const first = args.find((a) => !RUNNER_FLAGS.has(a));
    if (first !== undefined && PACKAGE.test(first)) out = `${name} ${first}`;
  }
  return out.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
}

/** A remote server's name as `shadowlap mcp --url` records it: the URL's host (with a port it names). */
function httpServerName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Where MCP clients keep a project's servers, the key each uses for them, and how its client fills
 * in a variable from its own environment: `${NAME}` in Claude Code's `.mcp.json`, `${env:NAME}` in
 * Cursor's and VS Code's.
 */
const MCP_FILES: Array<{ path: string; key: string; ref: (name: string) => string }> = [
  { path: '.mcp.json', key: 'mcpServers', ref: (name) => `\${${name}}` },
  { path: '.cursor/mcp.json', key: 'mcpServers', ref: (name) => `\${env:${name}}` },
  { path: '.vscode/mcp.json', key: 'servers', ref: (name) => `\${env:${name}}` },
];

/** Where the JSON string starting at `i` (a `"`) ends: the index just past its closing quote. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** JSON with comments and trailing commas, as VS Code writes its config files. Strings are left exactly as they are. */
export function parseJsonc(text: string): unknown {
  // Comments out, strings kept whole: a "//" inside a URL is not a comment.
  let plain = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '"') {
      const end = stringEnd(text, i);
      plain += text.slice(i, end);
      i = end;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      plain += ' ';
    } else {
      plain += c;
      i++;
    }
  }
  // A comma before a closing bracket goes, but only between tokens: "a, }" in a string stays.
  let out = '';
  for (let i = 0; i < plain.length; ) {
    const c = plain[i]!;
    if (c === '"') {
      const end = stringEnd(plain, i);
      out += plain.slice(i, end);
      i = end;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < plain.length && /\s/.test(plain[j]!)) j++;
      if (plain[j] === '}' || plain[j] === ']') {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

/** Words in a host that say nothing about which server it is: what's left names its variable (`LINEAR_AUTH` for mcp.linear.app). */
const HOST_NOISE = new Set(['mcp', 'api', 'www', 'server', 'servers', 'app', 'com', 'net', 'org', 'io', 'dev', 'ai', 'co', 'cloud']);

/** The word a remote server's variables are named by: `linear` for https://mcp.linear.app/mcp, else `SERVER`. */
function hostWord(url: string): string {
  try {
    const labels = new URL(url).hostname.split('.').slice(0, -1);
    return labels.find((l) => /^[a-z][a-z0-9-]*$/i.test(l) && !HOST_NOISE.has(l.toLowerCase())) ?? 'server';
  } catch {
    return 'server';
  }
}

const quote = (a: string) => (/^[\w@%+=:,./•-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

const commandLine = (argv: readonly string[]) => argv.map(quote).join(' ');

/**
 * A command line as a shell splits it into arguments: spaces separate them, '…' keeps everything,
 * "…" keeps all but \", \\, \$ and \`, and a backslash outside quotes keeps the next character.
 */
export function splitCommandLine(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new Error('a quote is not closed');
      current += text.slice(i + 1, end);
      started = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && j + 1 < text.length && '"\\$`'.includes(text[j + 1]!)) j++;
        current += text[j];
      }
      if (j >= text.length) throw new Error('a quote is not closed');
      started = true;
      i = j;
    } else if (c === '\\' && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

/** The arguments after `mcp` when an entry starts `shadowlap mcp`, directly or through a package runner. */
function shadowlapMcpArgs(command: string, args: string[]): string[] | null {
  if (/(^|[\\/])shadowlap(\.cmd|\.exe)?$/i.test(command)) return args[0] === 'mcp' ? args.slice(1) : null;
  let runner: string[];
  if (/(^|[\\/])(npx|pnpx|bunx)(\.cmd|\.exe)?$/i.test(command)) runner = args;
  else if (/(^|[\\/])(pnpm|yarn|bun|npm)(\.cmd|\.exe)?$/i.test(command) && ['dlx', 'x', 'exec'].includes(args[0] ?? '')) runner = args.slice(1);
  else return null;
  // `npx -y shadowlap mcp …`, `pnpm dlx shadowlap@1.2.0 mcp …`, `npm exec -- shadowlap mcp …`
  const at = runner.findIndex((a) => /^shadowlap(@.*)?$/.test(a));
  if (at < 0 || runner[at + 1] !== 'mcp' || runner.slice(0, at).some((a) => !a.startsWith('-'))) return null;
  return runner.slice(at + 2);
}

/** `shadowlap mcp …` in a client entry: the server it stands in front of. */
function proxied(command: string, args: string[]): { transport: 'stdio' | 'http'; target: string[] } | null {
  const rest = shadowlapMcpArgs(command, args);
  if (!rest) return null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--url') return { transport: 'http', target: [rest[i + 1] ?? ''] };
    if (a.startsWith('--url=')) return { transport: 'http', target: [a.slice(6)] };
    if (a === '--') return { transport: 'stdio', target: rest.slice(i + 1) };
    if (a === '--effect') i++;
    else if (!a.startsWith('-')) return { transport: 'stdio', target: rest.slice(i) };
  }
  return { transport: 'stdio', target: [] };
}

/** How a server entry is recorded, from its command and arguments: the row without its name, file, environment, what to put back and what was recorded. */
type ServerRecording = Omit<McpServerRow, 'name' | 'file' | 'env' | 'putBack' | 'notes' | 'recorded'>;

function commandServer(command: string, args: string[]): ServerRecording {
  const shownArgs = hideSecrets(args);
  const via = proxied(command, args);
  if (via) {
    const target = via.transport === 'http' ? hideUrlSecrets(via.target[0] ?? '') : commandLine(hideSecrets(via.target));
    const hidden = shownArgs.some((a, i) => a !== args[i]) || (via.transport === 'http' && target !== via.target[0]);
    const recordedAs = via.transport === 'http' ? { transport: 'http' as const, server: httpServerName(via.target[0] ?? '') } : { transport: 'stdio' as const, server: via.target.length ? stdioServerName(via.target[0]!, via.target.slice(1)) : '' };
    return { transport: via.transport, target, viaShadowlap: true, line: commandLine([command, ...shownArgs]), entry: { command, args: shownArgs }, hidden, recordedAs };
  }
  const shown = hideSecrets([command, ...args]);
  return { transport: 'stdio', target: commandLine(shown), viaShadowlap: false, line: commandLine(['shadowlap', 'mcp', '--', ...shown]), entry: { command: 'shadowlap', args: ['mcp', '--', ...shown] }, hidden: shown.some((a, i) => a !== [command, ...args][i]), recordedAs: { transport: 'stdio', server: stdioServerName(command, args) } };
}

/** A remote server by its URL, with the `--header` flags `shadowlap mcp --url` sends (`Authorization: Bearer $STRIPE_TOKEN`). */
function urlServer(url: string, headers: readonly string[] = []): ServerRecording {
  const shown = hideUrlSecrets(url);
  const args = ['mcp', '--url', shown, ...headers.flatMap((h) => ['--header', h])];
  return { transport: 'http', target: shown, viaShadowlap: false, line: commandLine(['shadowlap', ...args]), entry: { command: 'shadowlap', args }, hidden: shown !== url, recordedAs: { transport: 'http', server: httpServerName(url) } };
}

/**
 * A remote server whose URL holds a user and password: `shadowlap mcp --url` refuses that, so the
 * URL goes without them and they become `Authorization: Basic $<SERVER>_AUTH`, a variable for the
 * person to set to their base64, which the proxy reads from its environment (as `$NAME`, like every
 * header headerFlags writes, so a client that fills in `${…}` itself leaves it alone). Their text is
 * never shown or copied. Null for a URL without them, or one that already sends an Authorization
 * header.
 */
function basicAuth(url: string, headers: readonly string[], word: string, taken: Set<string>): { url: string; header: string; env: string } | null {
  const bare = withoutCredentials(url);
  if (!bare.had || headers.some((h) => /^authorization\s*:/i.test(h))) return null;
  const base = `${envWord(word)}_AUTH`;
  let env = base;
  for (let i = 2; taken.has(env); i++) env = `${base}_${i}`;
  taken.add(env);
  return { url: bare.url, header: `Authorization: Basic $${env}`, env };
}

/** What stands in for a value the page never shows: an environment value to put back. */
const LEFT_OUT = '…';

const ENV_NAME = /^[A-Za-z_][\w.-]{0,99}$/;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

const envWord = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SERVER';

/** An entry's environment as a copy shows it: references as they are, any other value as `…`, to put back. */
function envOf(value: unknown): Array<{ name: string; value: string }> {
  if (!isObject(value)) return [];
  return Object.entries(value)
    .filter(([name]) => ENV_NAME.test(name))
    .map(([name, v]) => ({ name, value: typeof v === 'string' && REFERENCE.test(v.trim()) ? v.trim() : LEFT_OUT }));
}

/**
 * A remote server's headers as `shadowlap mcp --header` flags, each value a variable the proxy reads
 * from its environment as `$NAME`, never `${NAME}`: Claude Code fills in `${…}` in .mcp.json itself,
 * which would put the token on the proxy's command line, and refuses the config when the variable
 * isn't set. A value already in that form stays as it is. A reference the client fills in
 * (`${STRIPE_TOKEN}`, `${env:STRIPE_TOKEN}`, `${input:token}`) moves to the entry's environment,
 * which the client fills in the same way (`ref` writes a plain variable as this file's client does),
 * so nothing is left to put back. Any other value becomes `$SERVER_HEADER` (an Authorization header
 * keeps its scheme: `Bearer $STRIPE_TOKEN`), a variable added to the entry's environment as `…` for
 * the person to set. Only the scheme word is read from a value; its text never leaves here.
 */
function headerFlags(value: unknown, server: string, taken: Set<string>, ref: (name: string) => string): Array<{ flag: string; env: string | null; value: string }> {
  if (!isObject(value)) return [];
  return Object.entries(value)
    .filter(([name]) => HEADER_NAME.test(name))
    .map(([name, v]) => {
      const text = typeof v === 'string' ? v.trim() : '';
      const scheme = SCHEME.exec(text);
      const token = scheme ? scheme[2]!.trim() : text;
      const lead = scheme ? `${scheme[1]!} ` : '';
      if (PROXY_REFERENCE.test(token)) return { flag: `${name}: ${text}`, env: null, value: '' };
      // A plain variable (`${STRIPE_TOKEN}`, `${env:STRIPE_TOKEN}`) keeps its name; another reference is named as a value would be.
      const plain = REFERENCE.test(token) ? /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(token)?.[1] : undefined;
      const base = plain ?? `${envWord(server)}_${scheme && /^authorization$/i.test(name) ? 'TOKEN' : envWord(name)}`;
      let env = base;
      for (let i = 2; taken.has(env); i++) env = `${base}_${i}`;
      taken.add(env);
      return { flag: `${name}: ${lead}$${env}`, env, value: plain ? ref(plain) : REFERENCE.test(token) ? token : LEFT_OUT };
    });
}

/**
 * The client configs to copy: one per project file that lists servers, in the order clients read
 * them, each written as docs/mcp.md writes one and under the key its file uses (`servers` for VS
 * Code), with what each copy leaves out to put back. Without a server, the docs' example. And the
 * forms no server in them uses, for the page to show beside them.
 */
export function clientConfigs(servers: ReadonlyArray<Pick<McpServerRow, 'name' | 'file' | 'transport' | 'entry' | 'env' | 'putBack'> & { notes?: readonly string[] }>, docExample: string | null = null): { clientConfigs: ClientConfigBlock[]; otherForms: Array<'stdio' | 'http'> } {
  const q = (v: string) => JSON.stringify(v);
  const blocks = MCP_FILES.flatMap(({ path, key }): ClientConfigBlock[] => {
    const here = servers.filter((s) => s.file === path);
    if (!here.length) return [];
    const entries = here.map((s) => {
      const lines = [`    ${q(s.name)}: {`, `      "command": ${q(s.entry.command)},`, `      "args": [${s.entry.args.map(q).join(', ')}]${s.env.length ? ',' : ''}`];
      if (s.env.length) lines.push(`      "env": { ${s.env.map((e) => `${q(e.name)}: ${q(e.value)}`).join(', ')} }`);
      return [...lines, '    }'].join('\n');
    });
    const text = ['{', `  ${q(key)}: {`, entries.join(',\n'), '  }', '}'].join('\n');
    return [{ file: path, text, putBack: here.filter((s) => s.putBack.length).map((s) => ({ server: s.name, values: s.putBack })), notes: here.flatMap((s) => (s.notes ?? []).map((text) => ({ server: s.name, text }))) }];
  });
  if (!blocks.length) return { clientConfigs: docExample === null ? [] : [{ file: null, text: docExample, putBack: [], notes: [] }], otherForms: [] };
  const used = new Set(servers.filter((s) => blocks.some((b) => b.file === s.file)).map((s) => s.transport));
  return { clientConfigs: blocks, otherForms: (['stdio', 'http'] as const).filter((t) => !used.has(t)) };
}

/** What "Add a server…" shows for a URL with a user and password: the Basic header's variable, set in the entry's env. */
export interface ServerFor extends ServerRecording {
  /** The entry's environment: the variable a URL's user and password became, to set (value `…`). */
  env: Array<{ name: string; value: string }>;
  /** That variable's name, for the dialog to say how to set it; null without one. */
  basic: string | null;
}

/**
 * "Add a server…": the `shadowlap mcp` line and client entry for a command or a URL typed into the
 * dialog, with credentials hidden as the table hides them (`hidden` then asks the person to put
 * the real value back in their own entry). A URL's user and password become an `Authorization:
 * Basic` header whose value is a variable in the entry's env (`basic` names it), since `shadowlap
 * mcp --url` refuses them in the URL. Nothing is written. Throws with what to type instead.
 */
export function mcpServerFor(input: { command?: string | null; url?: string | null }): ServerFor {
  const url = input.url?.trim();
  if (url) {
    checkServerUrl(url);
    const basic = basicAuth(url, [], hostWord(url), new Set());
    if (!basic) return { ...urlServer(url), env: [], basic: null };
    return { ...urlServer(basic.url, [basic.header]), hidden: true, env: [{ name: basic.env, value: LEFT_OUT }], basic: basic.env };
  }
  const argv = splitCommandLine(input.command ?? '');
  if (!argv.length) throw new Error('type the command that starts the server, such as npx -y @modelcontextprotocol/server-filesystem .');
  return { ...commandServer(argv[0]!, argv.slice(1)), env: [], basic: null };
}

/** A remote server's URL as `shadowlap mcp --url` takes one: http(s), with a host, that a URL parser can read. Throws with what to type instead. */
function checkServerUrl(url: string): void {
  const example = 'such as https://mcp.example.com/mcp';
  if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error(`an MCP server URL starts with http:// or https://, ${example}`);
  try {
    new URL(url);
  } catch {
    throw new Error(`that isn’t a URL shadowlap mcp can reach, ${example}; a password with / ? or # in it goes in an Authorization header instead`);
  }
}

/**
 * The client entry for what "Add a server…" has, as the person typed it: what Copy the entry
 * copies. The line and entry the dialog shows hide credentials (mcpServerFor); the copy keeps what
 * was typed, since the person typed it and the dialog says so (a URL's query and path, a token in a
 * command), except a URL's user and password, which never go on the clipboard: a remote server's
 * become its Basic header's variable, and one in a command shows as `•••@`, to put back in your own
 * entry.
 */
export function mcpEntryAsTyped(input: { command?: string | null; url?: string | null }): { command: string; args: string[] } {
  const url = input.url?.trim();
  if (url) {
    checkServerUrl(url);
    const basic = basicAuth(url, [], hostWord(url), new Set());
    return { command: 'shadowlap', args: ['mcp', '--url', basic?.url ?? url, ...(basic ? ['--header', basic.header] : [])] };
  }
  const argv = splitCommandLine(input.command ?? '').map(hideUrlCredentials);
  if (!argv.length) throw new Error('type the command that starts the server, such as npx -y @modelcontextprotocol/server-filesystem .');
  if (shadowlapMcpArgs(argv[0]!, argv.slice(1))) return { command: argv[0]!, args: argv.slice(1) };
  return { command: 'shadowlap', args: ['mcp', '--', ...argv] };
}

/**
 * A header's variable to put back, as its file needs it. Claude Code fills in `${NAME}` in
 * .mcp.json itself, from the environment it starts from, and won't start the server while NAME is
 * unset there; other clients pass the entry's env on to `shadowlap mcp`, which fills it in.
 */
function headerPutBack(file: string | null, name: string, what: string): string {
  return file === '.mcp.json' ? `${name} (${what}), in the environment Claude Code starts from: it fills in \${${name}} itself` : `${name} (${what})`;
}

/** The MCP servers a project's client configs list, with how each would be recorded. */
export function mcpServers(cwd: string): { servers: Array<Omit<McpServerRow, 'recorded'>>; files: Array<{ path: string; found: boolean; error: string | null }> } {
  const servers: Array<Omit<McpServerRow, 'recorded'>> = [];
  const files = MCP_FILES.map(({ path, key, ref }) => {
    const full = join(cwd, path);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      return { path, found: false, error: null };
    }
    if (!st.isFile()) return { path, found: false, error: null };
    if (st.size > READ_LIMIT) return { path, found: true, error: `larger than ${READ_LIMIT / (1024 * 1024)} MB, so it was not read` };
    let parsed: unknown;
    try {
      parsed = parseJsonc(readFileSync(full, 'utf8'));
    } catch (err) {
      return { path, found: true, error: `not valid JSON (${messageOf(err)})` };
    }
    const list = isObject(parsed) && isObject(parsed[key]) ? parsed[key] : {};
    for (const [name, entry] of Object.entries(list)) {
      if (!isObject(entry)) continue;
      const url = str(entry.url) ?? str(entry.serverUrl) ?? str(entry.httpUrl);
      const command = str(entry.command);
      const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
      const env = envOf(entry.env);
      const putBack = env.filter((e) => e.value === LEFT_OUT).map((e) => e.name);
      const notes: string[] = [];
      if (command) {
        const server = commandServer(command, args);
        if (server.hidden) putBack.push(`the ${HIDDEN} in its command`);
        servers.push({ name, file: path, ...server, env, putBack, notes });
      } else if (url) {
        const taken = new Set(env.map((e) => e.name));
        const headers = headerFlags(entry.headers, name, taken, ref);
        // A user and password in the URL become a Basic header: `shadowlap mcp --url` refuses them
        // there. Beside its own Authorization header they go, since that header signs in.
        const bare = withoutCredentials(url);
        const basic = basicAuth(url, headers.map((h) => h.flag), name, taken);
        if (basic) headers.push({ flag: basic.header, env: basic.env, value: LEFT_OUT });
        else if (bare.had) notes.push(`its URL’s user and password are left out: shadowlap mcp refuses them there, and its Authorization header signs in`);
        const server = urlServer(bare.url, headers.map((h) => h.flag));
        for (const h of headers) {
          if (!h.env) continue;
          // A reference goes in as it is, for the client to fill in: nothing to put back.
          if (h.value !== LEFT_OUT) {
            env.push({ name: h.env, value: h.value });
            continue;
          }
          // A value is put back by the person. Claude Code fills in a reference in .mcp.json from its
          // own environment, so there the variable is set in that environment; elsewhere, in the env.
          env.push({ name: h.env, value: path === '.mcp.json' ? ref(h.env) : LEFT_OUT });
          putBack.push(headerPutBack(path, h.env, h.env === basic?.env ? 'the base64 of its URL’s user:password, for its Authorization header' : `its ${h.flag.slice(0, h.flag.indexOf(':'))} header`));
        }
        if (bare.had) server.hidden = true;
        if (server.target.includes(HIDDEN)) putBack.push(`the ${HIDDEN} in its URL`);
        servers.push({ name, file: path, ...server, env, putBack, notes });
      }
    }
    return { path, found: true, error: null };
  });
  return { servers, files };
}
