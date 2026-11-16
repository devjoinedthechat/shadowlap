import { agentCallsOf } from './judge-scope.js';
import type { CallRecord } from './types.js';
import type { VerifiedRun } from './verify.js';
import { plural } from './words.js';

/**
 * A change that made no difference to any request. A replay that forks nowhere matched every call to
 * the recording (session.ts, `replaying`), so whatever the change did reached no request, and each
 * tool call it served from the recording ran none of the tool's code. The warning that a tool changed
 * reads the tool's own function (the SDK's `implHash`): a change in what a tool reads, a constant or a
 * helper in another file, leaves every run replaying clean, the change accepted, and only this to say
 * that the changed code never ran.
 */
export interface NoDifference {
  /** The runs verify made an attempt of: every one replayed clean. */
  runs: number;
  /** The tool calls their attempts got from the recording. */
  toolCalls: number;
  /** Those calls by tool, the most called first. */
  tools: Array<{ name: string; calls: number }>;
}

/**
 * The agent's tool calls an attempt that replayed clean got from the recording, by tool; null for one
 * that forked (`afterForkOf` says what answered it after the fork). A person's recorded answers are no
 * tool's code, and a judge check's calls none of the agent's.
 */
export function servedToolsOf(calls: readonly CallRecord[], forkedAt: number | null): Record<string, number> | null {
  if (forkedAt !== null) return null;
  const served = new Map<string, number>();
  for (const c of agentCallsOf(calls)) if (c.kind === 'tool' && c.origin === 'replayed' && c.meta.input !== true) served.set(c.name, (served.get(c.name) ?? 0) + 1);
  // From a map: a tool named `__proto__` is a name like any other.
  return Object.fromEntries(served);
}

/**
 * Whether the change made no difference: every run verify made an attempt of replayed clean (its
 * `deterministic`, so no request differed from the recording) and some tool call came from the
 * recording. Null when a run forked, when every tool call ran live or none was made, and for a report
 * whose attempts never counted them.
 */
export function noDifferenceOf(runs: readonly Pick<VerifiedRun, 'attempts' | 'deterministic'>[]): NoDifference | null {
  const ran = runs.filter((r) => r.attempts.length);
  if (!ran.length || !ran.every((r) => r.deterministic)) return null;
  const calls = new Map<string, number>();
  for (const a of ran.flatMap((r) => r.attempts)) for (const [name, n] of Object.entries(a.servedTools ?? {})) calls.set(name, (calls.get(name) ?? 0) + n);
  const tools = [...calls].map(([name, n]) => ({ name, calls: n })).sort((x, y) => y.calls - x.calls);
  const toolCalls = tools.reduce((s, t) => s + t.calls, 0);
  return toolCalls ? { runs: ran.length, toolCalls, tools } : null;
}

/** The most tools the warning names; the rest it counts. */
const NAMED = 5;

/**
 * The warning, in verify's words: `the change made no difference to any request in 2 runs: 2 calls of
 * read_policy were served from the recording, so its code never ran under the change; if the change is
 * in read_policy or in what it reads, verify again with --live-tool read_policy`.
 */
export function noDifferenceWarning(n: NoDifference): string {
  const head = `the change made no difference to any request in ${plural(n.runs, 'run')}`;
  if (n.tools.length === 1) {
    const name = n.tools[0]!.name;
    return `${head}: ${plural(n.toolCalls, 'call')} of ${name} ${n.toolCalls === 1 ? 'was' : 'were'} served from the recording, so its code never ran under the change; if the change is in ${name} or in what it reads, verify again with --live-tool ${name}`;
  }
  const named = n.tools.slice(0, NAMED).map((t) => t.name).join(', ') + (n.tools.length > NAMED ? ` and ${n.tools.length - NAMED} more` : '');
  return `${head}: ${plural(n.toolCalls, 'tool call')} (${named}) were served from the recording, so the code they run never ran under the change; if the change is in a tool or in what one reads, verify again with --live-tool <name>`;
}
