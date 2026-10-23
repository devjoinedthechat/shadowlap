import { unrecordedTools, type RunRecord, type Store, type UnrecordedTool } from '@shadowlap/engine';
import { packRecording } from './check-recordings.js';
import { loadConfig } from './config.js';
import { palette as p, quoteArgv, safe, shortId } from './ui.js';

/**
 * Tools the model called that a run never recorded (the engine's unrecordedTools), as the CLI
 * names and fences them. They ran in the agent unseen, and a replay, which serves the model's
 * answers again, runs them again for real: `run`, `replay` and `show` name them, and `replay` and
 * `test` refuse to run one that writes unless the config declares it a read or `--allow-unrecorded`
 * lets it run.
 */

/** `--allow-unrecorded Bash,Write` (repeatable): the unrecorded tools a replay may run again for real. */
export function allowedUnrecorded(values: readonly string[]): Set<string> {
  return new Set(values.flatMap((v) => v.split(',')).map((name) => name.trim()).filter(Boolean));
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
export function unrecordedOf(store: Store, runId: string, declared: Readonly<Record<string, 'read' | 'write'>>): UnrecordedTool[] {
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

/** A tool's name as a JavaScript string literal, in the single quotes the SDK's examples use. */
const literal = (name: string) => `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** How to have a tool recorded and replayed: wrapped where the agent runs it, with the effect it has. */
function wrapIt(tool: UnrecordedTool): string {
  return `tool(${literal(tool.name)}, { effect: '${tool.effect === 'read' ? 'read' : 'write'}' }, fn) with @shadowlap/sdk`;
}

/** What a recording or a replay says at its end about the tools it left unrecorded, or '' for none. */
export function formatUnrecorded(tools: readonly UnrecordedTool[], what: 'recording' | 'replay'): string {
  if (!tools.length) return '';
  const writes = tools.filter((t) => t.effect === 'write');
  const head = `${p.yellow('!')} The model called ${tools.length === 1 ? 'a tool' : `${tools.length} tools`} Shadowlap did not record: ${what === 'replay' ? 'this replay ran' : 'they ran in your agent unseen, and a replay runs'} ${tools.length === 1 ? 'it' : 'them'} for real`;
  const refuse = writes.length ? `  ${writes.length === 1 ? `${safe(writes[0]!.name)} writes, so shadowlap replay and test refuse` : 'Some write, so shadowlap replay and test refuse'} to run ${writes.length === 1 ? 'it' : 'them'} again until it is recorded, declared a read, or allowed with --allow-unrecorded.` : '';
  // The tool to show how to wrap and declare: the first that writes, else the first named.
  const shown = writes[0] ?? tools[0]!;
  const effect = shown.effect === 'read' ? 'read' : 'write';
  const remedy = `Wrap each where your agent runs it, so it is recorded and replayed (${wrapIt(shown)}), or declare what it does in shadowlap.config.json: "tools": { "unrecorded": { ${JSON.stringify(shown.name)}: "${effect}" } }`;
  return [head, ...unrecordedLines(tools).map((l) => p.dim(l)), ...(refuse ? [refuse] : []), p.dim(`  ${remedy}`)].join('\n') + '\n';
}

/**
 * Why a replay of `run` must not start, or null: its model called tools Shadowlap never recorded
 * that write, so a replay would run them again for real. A tool `allowed` names may run; a partial
 * recording (an import, which holds only the model calls of a trace or capture) runs every other
 * tool live by design, so it is never refused. `command` is the replay to suggest.
 */
export function unrecordedRefusal(run: RunRecord, tools: readonly UnrecordedTool[], allowed: ReadonlySet<string>, command: readonly string[]): string | null {
  if (run.meta?.covers?.length) return null;
  const writes = tools.filter((t) => t.effect === 'write' && !allowed.has(t.name));
  if (!writes.length) return null;
  const names = writes.map((t) => t.name);
  const it = writes.length === 1 ? 'it' : 'them';
  return [
    `${shortId(run.runId)} holds model calls of ${writes.length === 1 ? 'a tool' : 'tools'} Shadowlap never recorded, which ${writes.length === 1 ? 'writes' : 'write'}: a replay serves the model's answers again, so it would run ${it} again for real.`,
    ...unrecordedLines(writes),
    `  Wrap ${writes.length === 1 ? 'it' : 'each'} where your agent runs it, so Shadowlap records it and a replay serves it: ${wrapIt(writes[0]!)}.`,
    `  If running ${it} again is safe, declare ${it} a read in shadowlap.config.json, "tools": { "unrecorded": { ${JSON.stringify(writes[0]!.name)}: "read" } }, or let this replay run ${it}: ${safe(quoteArgv([...command, '--allow-unrecorded', names.join(',')]))}`,
  ].join('\n');
}

/** The tools a replay or test runs again for real without refusing: reads, unknown, and writes allowed. */
export function unrecordedRunAnyway(tools: readonly UnrecordedTool[], allowed: ReadonlySet<string>): UnrecordedTool[] {
  return tools.filter((t) => t.effect !== 'write' || allowed.has(t.name));
}

/**
 * `shadowlap test`'s look at its goldens before any replay runs: each golden whose model called a
 * tool its recording never recorded that writes is refused, all of them named at once; the rest of
 * the tools left unrecorded are warnings, a line per golden. A pack that can't be read is left to
 * the test itself, which says why.
 */
export function unrecordedInGoldens(goldens: ReadonlyArray<{ dir: string; name: string }>, declared: Readonly<Record<string, 'read' | 'write'>>, allowed: ReadonlySet<string>): { refused: string | null; warnings: string[] } {
  const refused: string[] = [];
  const warnings: string[] = [];
  const names = new Set<string>();
  let goldensRefused = 0;
  for (const g of goldens) {
    let read: { run: RunRecord; store: Store };
    try {
      read = packRecording(g.dir);
    } catch {
      continue;
    }
    try {
      const tools = unrecordedOf(read.store, read.run.runId, declared);
      const partial = !!read.run.meta?.covers?.length;
      const writes = partial ? [] : tools.filter((t) => t.effect === 'write' && !allowed.has(t.name));
      const anyway = tools.filter((t) => !writes.includes(t));
      if (writes.length) {
        goldensRefused++;
        refused.push(`  ${safe(g.name)}`, ...unrecordedLines(writes, '    '));
        for (const t of writes) names.add(t.name);
      }
      if (anyway.length) warnings.push(`${p.yellow('!')} ${safe(g.name)}: the model called ${anyway.map((t) => `${safe(t.name)} (${t.count} call${t.count === 1 ? '' : 's'})`).join(', ')}, which Shadowlap never recorded: its replay runs ${anyway.length === 1 ? 'it' : 'them'} for real`);
    } finally {
      read.store.close();
    }
  }
  if (!refused.length) return { refused: null, warnings };
  const list = [...names];
  const first = list[0]!;
  return {
    refused: [
      `${goldensRefused === 1 ? 'a golden holds' : `${goldensRefused} goldens hold`} model calls of ${list.length === 1 ? 'a tool' : 'tools'} Shadowlap never recorded, which ${list.length === 1 ? 'writes' : 'write'}: a replay would run ${list.length === 1 ? 'it' : 'them'} again for real, so no golden was run.`,
      ...refused,
      `  Wrap each where your agent runs it, so Shadowlap records it and a replay serves it (tool(${literal(first)}, { effect: 'write' }, fn) with @shadowlap/sdk), and record the golden again; or, if running it again is safe, declare it a read in shadowlap.config.json: "tools": { "unrecorded": { ${JSON.stringify(first)}: "read" } }`,
      `  Or let the test run ${list.length === 1 ? 'it' : 'them'}: --allow-unrecorded ${list.join(',')}`,
    ].join('\n'),
    warnings,
  };
}
