import { jsString as literal, unrecordedTools, type RunRecord, type StoreOf, type UnrecordedTool } from '@shadowlap/engine';
import { loadConfig } from './config.js';
import { usageError } from './exit-codes.js';
import { palette as p, quoteArgv, safe, shortId } from './ui.js';

/**
 * Tools the model called that a run never recorded (the engine's unrecordedTools), as the CLI
 * names and fences them. They ran in the agent unseen, and a replay, which serves the model's
 * answers again, runs them again for real: `run`, `replay` and `show` name them, and every command
 * that replays a recording (`replay`, `test`, `blame`, `verify`, `repair`, `calibrate` and the rest)
 * refuses to run one that writes unless the config declares it a read or `--allow-unrecorded` lets
 * it run. The runners those commands share refuse too, so no path runs one unasked.
 */

/** `--allow-unrecorded Bash,Write` (repeatable): the unrecorded tools a replay may run again for real. */
export function allowedUnrecorded(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).flatMap((v) => v.split(',')).map((name) => name.trim()).filter(Boolean));
}

/**
 * `--allow-unrecorded`, as every command that replays a recording takes it: the flag and its help.
 * Its values add up with collect (shared.ts), and allowedUnrecorded reads one never given as none.
 */
export const ALLOW_UNRECORDED = '--allow-unrecorded <names>';
export const ALLOW_UNRECORDED_HELP = 'run these tools again for real though the recording never recorded them and they write, or nothing says what they do: names separated by commas (repeatable)';

/**
 * A command line with a flag added: before its `--`, when it has one, so the flag is shadowlap's
 * and not the agent's (`shadowlap blame 01K… -- node agent.mjs`).
 */
export function withFlag(command: readonly string[], flag: readonly string[]): string[] {
  const at = command.indexOf('--');
  return at === -1 ? [...command, ...flag] : [...command.slice(0, at), ...flag, ...command.slice(at)];
}

/** The project's `tools.unrecorded`, or nothing when the config can't be read: naming what a run left unrecorded never fails it. */
export function declaredUnrecorded(cwd: string): Record<string, 'read' | 'write'> {
  try {
    return loadConfig(cwd).unrecorded ?? {};
  } catch {
    return {};
  }
}

/** A run's unrecorded tools, or none when the run can't be read. */
export function unrecordedOf(store: StoreOf<'recording'>, runId: string, declared: Readonly<Record<string, 'read' | 'write'>>): UnrecordedTool[] {
  try {
    return unrecordedTools(store, runId, { declared });
  } catch {
    return [];
  }
}

/** One line per tool: how often the model asked for it, from which model call, and what it does. */
export function unrecordedLines(tools: readonly UnrecordedTool[], indent = '    '): string[] {
  const width = Math.max(...tools.map((t) => safe(t.name).length));
  return tools.map((t) => `${indent}${safe(t.name).padEnd(width)}  ${t.count} call${t.count === 1 ? '' : 's'} from model call #${t.firstCallNo} · ${safe(t.why)}`);
}

/**
 * How to have a tool recorded and replayed, as a clause: a Claude Code built-in (in a run from Claude
 * Code only, which the tool's `fix` says) through the Claude Agent SDK's fence, an MCP server's tool
 * through `shadowlap mcp`, anything else wrapped where the agent runs it, in Node or Python, with the
 * effect it has. Null for a built-in that keeps to Claude Code's session.
 */
export function howToRecord(tool: Pick<UnrecordedTool, 'name' | 'effect' | 'fix'>): string | null {
  switch (tool.fix) {
    case 'fence':
      return `run the query through withFence from @shadowlap/adapters/claude-agent-sdk (with_fence in shadowlap.adapters.claude_agent_sdk), which records ${tool.name} and fences it on replay`;
    case 'fence-effects':
      return `name it in withFence's effects, withFence(options, { effects: { ${literal(tool.name)}: 'write' } }) (with_fence in Python), which records it and refuses to run it again on replay`;
    case 'mcp':
      return 'connect your agent to its MCP server through shadowlap mcp, which records and fences its calls';
    case 'none':
      return null;
    default: {
      const effect = tool.effect === 'read' ? 'read' : 'write';
      return `wrap it where your agent runs it: tool(${literal(tool.name)}, { effect: '${effect}' }, fn) with @shadowlap/sdk (@tool(${JSON.stringify(tool.name)}, effect="${effect}") from shadowlap in Python)`;
    }
  }
}


/**
 * Whether a replay refuses to run an unrecorded tool again: one that writes, and one whose effect
 * nothing tells, as the MCP proxy takes a tool its server doesn't annotate for a write.
 */
export const refusedEffect = (t: Pick<UnrecordedTool, 'effect'>): boolean => t.effect !== 'read';

/** What refused tools do, in words: `writes` or `may write` for one, `write`, `may write` or `write, or may` for several. */
function acts(tools: readonly UnrecordedTool[]): string {
  const unknown = tools.some((t) => t.effect === 'unknown');
  const writes = tools.some((t) => t.effect === 'write');
  if (tools.length === 1) return unknown ? 'may write' : 'writes';
  return unknown && writes ? 'write, or may' : unknown ? 'may write' : 'write';
}

/** What a recording or a replay says at its end about the tools it left unrecorded, or '' for none. */
export function formatUnrecorded(tools: readonly UnrecordedTool[], what: 'recording' | 'replay'): string {
  if (!tools.length) return '';
  const writes = tools.filter(refusedEffect);
  const head = `${p.yellow('!')} The model called ${tools.length === 1 ? 'a tool' : `${tools.length} tools`} shadowlap did not record: ${what === 'replay' ? 'this replay ran' : 'they ran in your agent unseen, and a replay runs'} ${tools.length === 1 ? 'it' : 'them'} for real`;
  const refuse = writes.length ? `  ${writes.length === 1 ? `${safe(writes[0]!.name)} ${acts(writes)}, so every command that replays the run refuses` : `Some ${acts(writes)}, so every command that replays the run refuses`} to run ${writes.length === 1 ? 'it' : 'them'} again until it is recorded, declared a read, or allowed with --allow-unrecorded.` : '';
  // The tool to show how to record and declare: the first that writes, else the first that leaves Claude Code's session.
  const shown = writes[0] ?? tools.find((t) => t.fix !== 'none');
  const how = shown ? howToRecord(shown) : null;
  const remedy = shown && how ? `To have ${tools.length === 1 ? 'it' : 'each'} recorded and replayed, ${how}; or declare what it does in shadowlap.config.json: "tools": { "unrecorded": { ${JSON.stringify(shown.name)}: "${shown.effect === 'read' ? 'read' : 'write'}" } }` : '';
  return [head, ...unrecordedLines(tools).map((l) => p.dim(l)), ...(refuse ? [refuse] : []), ...(remedy ? [p.dim(`  ${remedy}`)] : [])].join('\n') + '\n';
}

/**
 * Why a replay of `run` must not start, or null: its model called tools shadowlap never recorded
 * that write, so a replay would run them again for real. A tool `allowed` names may run; a partial
 * recording (an import, which holds only the model calls of a trace or capture) runs every other
 * tool live by design, so it is never refused. `command` is the command to suggest
 * `--allow-unrecorded` on, or null for one that doesn't take it.
 */
export function unrecordedRefusal(run: RunRecord, tools: readonly UnrecordedTool[], allowed: ReadonlySet<string>, command: readonly string[] | null): string | null {
  if (run.meta?.covers?.length) return null;
  const writes = tools.filter((t) => refusedEffect(t) && !allowed.has(t.name));
  if (!writes.length) return null;
  const names = writes.map((t) => t.name);
  const it = writes.length === 1 ? 'it' : 'them';
  return [
    `${shortId(run.runId)} holds model calls of ${writes.length === 1 ? 'a tool' : 'tools'} shadowlap never recorded, which ${acts(writes)}: a replay serves the model's answers again, so it would run ${it} again for real.`,
    ...unrecordedLines(writes),
    `  So shadowlap records ${it} and a replay serves ${writes.length === 1 ? 'it' : 'each'}: ${howToRecord(writes[0]!) ?? 'record it'}.`,
    `  If running ${it} again is safe, declare ${it} a read in shadowlap.config.json, "tools": { "unrecorded": { ${JSON.stringify(writes[0]!.name)}: "read" } }${command ? `, or let this replay run ${it}: ${safe(quoteArgv(withFlag(command, ['--allow-unrecorded', names.join(',')])))}` : ''}`,
  ].join('\n');
}

/**
 * Throws the refusal of a replay of `run` whose model called a tool shadowlap never recorded that
 * writes (unrecordedRefusal), or returns quietly. Every command that replays a recording calls it
 * before its agent starts, and so do the runners they share (`testAttempt`, `repeatUnderSidecar`,
 * the AttemptRunner of blame, verify and repair), so no path runs such a tool again unasked.
 * `allowed`: the names `--allow-unrecorded` lets run, for a command that takes the flag; undefined
 * for one that doesn't, whose refusal then suggests no flag. The declarations are the project's
 * (`tools.unrecorded` in the shadowlap.config.json of the folder the command started in, which a
 * candidate's or a baseline's worktree shares).
 */
export function refuseUnrecorded(store: StoreOf<'recording'>, run: RunRecord, allowed: ReadonlySet<string> | undefined): void {
  const refusal = unrecordedRefusal(run, unrecordedOf(store, run.runId, declaredUnrecorded(process.cwd())), allowed ?? new Set(), allowed ? ['shadowlap', ...process.argv.slice(2)] : null);
  if (refusal) throw usageError(refusal);
}

/** The tools a replay or test runs again for real without refusing: reads, and the rest allowed. */
export function unrecordedRunAnyway(tools: readonly UnrecordedTool[], allowed: ReadonlySet<string>): UnrecordedTool[] {
  return tools.filter((t) => !refusedEffect(t) || allowed.has(t.name));
}

/** What refused tools do, in words, for a refusal that names them: see acts. */
export const refusedActs = (tools: readonly UnrecordedTool[]): string => acts(tools);
