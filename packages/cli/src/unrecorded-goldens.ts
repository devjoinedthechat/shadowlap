import type { RunRecord, Store } from '@shadowlap/engine';
import { packRecording } from './check-recordings.js';
import { palette as p, safe } from './ui.js';
import { literal, unrecordedLines, unrecordedOf } from './unrecorded.js';

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
