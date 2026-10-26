import type { Store, UnrecordedTool } from '@shadowlap/engine';
import { palette as p, safe } from './ui.js';
import { declaredUnrecorded, howToRecord, refusedEffect, unrecordedOf } from './unrecorded.js';

/**
 * What an attempt ran without Shadowlap recording it. The recording's own unrecorded writes are
 * refused before any attempt starts (refuseUnrecorded), but a fork's model answers live, and can ask
 * for a tool the agent runs unwrapped: that call runs for real, and nothing stubs it, however the
 * command fences the writes it records. So each attempt (blame's, verify's, repair's, `replay
 * --repeat`'s) names the tools its own run left unrecorded, on its line, in its JSON, and once after
 * all of them.
 */

/** The tools the model called in the attempt's run that the run recorded no call of, by the project's declarations. */
export function ranUnrecorded(store: Store, runId: string): UnrecordedTool[] {
  return unrecordedOf(store, runId, declaredUnrecorded(process.cwd()));
}

/** An attempt line's note of the writes, or may-writes, it ran unrecorded: ` · send_email ran for real, unrecorded`; '' for none. */
export function unrecordedNote(tools: readonly UnrecordedTool[] | undefined): string {
  const writes = (tools ?? []).filter(refusedEffect);
  if (!writes.length) return '';
  return p.yellow(` · ${writes.map((t) => safe(t.name)).join(', ')} ran for real, unrecorded`);
}

/**
 * What the attempts ran unrecorded, said once after them: each tool with how often and in how many
 * attempts, whether nothing stubbed it, and how to have it recorded. '' when none did.
 */
export function formatAttemptsUnrecorded(lists: ReadonlyArray<readonly UnrecordedTool[] | undefined>): string {
  const seen = new Map<string, { tool: UnrecordedTool; calls: number; attempts: number }>();
  for (const list of lists) {
    for (const t of list ?? []) {
      const s = seen.get(t.name);
      if (s) {
        s.calls += t.count;
        s.attempts++;
      } else seen.set(t.name, { tool: t, calls: t.count, attempts: 1 });
    }
  }
  if (!seen.size) return '';
  const rows = [...seen.values()];
  const n = rows.length;
  const writes = rows.filter((r) => refusedEffect(r.tool));
  const them = n === 1 ? 'it' : 'them';
  const head = `${p.yellow('!')} The model called ${n === 1 ? 'a tool' : `${n} tools`} Shadowlap did not record: the attempts ran ${them} for real${writes.length ? `, and nothing stubbed ${writes.length === n ? them : 'the writes among them'}` : ''}`;
  const width = Math.max(...rows.map((r) => safe(r.tool.name).length));
  const lines = rows.map((r) => p.dim(`    ${safe(r.tool.name).padEnd(width)}  ${r.calls} call${r.calls === 1 ? '' : 's'} in ${r.attempts} of ${lists.length} attempt${lists.length === 1 ? '' : 's'} · ${safe(r.tool.why)}`));
  const shown = writes[0]?.tool ?? rows.find((r) => r.tool.fix !== 'none')?.tool;
  const how = shown ? howToRecord(shown) : null;
  const remedy = how ? [p.dim(`  To have ${n === 1 ? 'it' : 'each'} recorded, and a write stubbed after a fork as the others are, ${how}`)] : [];
  return [head, ...lines, ...remedy].join('\n') + '\n';
}
