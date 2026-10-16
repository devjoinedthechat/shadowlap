import { resolve } from 'node:path';
import { maskedChange, Store, type DiffEntry, type DivergenceReport } from '@shadowlap/engine';
import { specFor } from './checks.js';
import { loadConfig, loadTests } from './config.js';
import { testGolden } from './golden-test.js';
import { goldenName, projectGoldens } from './goldens.js';
import { takeoverReader } from './tasks.js';

/**
 * After `shadowlap fix apply` puts a patch in: the project's other goldens that now diverge on what
 * it changed. A prompt or a tool description goes into every request the agent sends, so a golden
 * recorded before the change replays differently from its first model call, fails the next test,
 * and, when it may fork, forks there, before its task's takeover. Each is replayed offline, as
 * `shadowlap test` replays a golden that may not fork, in a store of its own that nothing keeps,
 * and listed when it diverged on the patch's change: a request field that now holds text the patch
 * added, or no longer holds text it removed. `shadowlap test <goldens> --update` re-records them.
 */

export interface OutdatedGolden {
  /** As the test history names it: the pack folder relative to the project. */
  golden: string;
  /** The call it diverged at, and the request field the patch changed there. */
  callNo: number;
  path: string;
}

/** A replay that takes longer than this is stopped: the check never holds up the apply for long. */
const CHECK_MS = 120_000;

/** The goldens checked (none when the project has no other), and those the patch left behind. */
export async function outdatedGoldens(store: Store, o: { cwd: string; goldens: string; patch: string; skip: readonly string[]; log: (line: string) => void }): Promise<{ checked: number; outdated: OutdatedGolden[] }> {
  const skip = new Set(o.skip.map((g) => goldenName(g, o.cwd)));
  const others = projectGoldens(o.cwd, o.goldens).filter((g) => !g.error && !skip.has(g.path));
  if (!others.length) return { checked: 0, outdated: [] };
  const config = loadConfig(o.cwd);
  let tests: ReturnType<typeof loadTests> = [];
  try {
    tests = loadTests(o.cwd);
  } catch {
    // a config being edited: every golden is checked as one that may not fork
  }
  const takeoverAt = takeoverReader(o.cwd, store);
  const text = patchText(o.patch);
  o.log(`  checking the project's other goldens against the patch: ${others.length} replayed offline`);
  const out: OutdatedGolden[] = [];
  const scratch = Store.open(':memory:');
  try {
    for (const g of others) {
      const dir = resolve(o.cwd, g.path);
      let d: DivergenceReport | null = null;
      let rules = config.normalize;
      try {
        const outcome = await testGolden(dir, g.path, null, { store: scratch, config, cwd: o.cwd, writes: 'block', guard: 'block', online: false, test: null, timeoutMs: CHECK_MS });
        d = outcome.result?.shown.ended.summary.divergence ?? null;
        rules = outcome.normalizers;
      } catch (err) {
        o.log(`  ! ${g.path} could not be replayed: ${(err as Error).message}`);
        continue;
      }
      if (!d || d.type !== 'request_changed') continue;
      const changed = (d.diff ?? []).find((e) => !maskedChange(e, rules, d) && patchMade(e, text));
      if (!changed) continue;
      // A golden that may fork passes on its checks wherever it forks; `test --update` re-records
      // one only when it forks before its task's takeover, where no model can be scored on it.
      if (specFor(tests, dir, o.cwd)?.fork) {
        const takeover = takeoverAt(dir);
        if (takeover === null || d.callNo >= takeover) continue;
      }
      out.push({ golden: g.path, callNo: d.callNo, path: changed.path });
    }
  } finally {
    scratch.close();
  }
  return { checked: others.length, outdated: out };
}

/** Runs of white space as one space, and the escapes source code writes in a string undone. */
function squash(s: string): string {
  return s
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\(['"`\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The text a unified diff adds and removes, without the leading + or -, each line squashed and the
 * lines joined by a space, as a prompt written over several lines reads in a request.
 */
export function patchText(patch: string): { added: string; removed: string } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(squash(line.slice(1)));
    else if (line.startsWith('-')) removed.push(squash(line.slice(1)));
  }
  return { added: added.join(' '), removed: removed.join(' ') };
}

const valueText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** What changed between two texts: what is left of each once their common start and end are taken off. */
function delta(before: string, after: string): { inserted: string; deleted: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { inserted: after.slice(start, after.length - end), deleted: before.slice(start, before.length - end) };
}

/** Text worth matching: three letters or digits at least, so a lone comma or a short word never decides. */
const telling = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').length >= 3;

/**
 * Whether a changed request field is the patch's doing: what it gained is in a line the patch added,
 * what it lost in a line the patch removed, or its new value stands whole in an added line.
 */
export function patchMade(entry: Pick<DiffEntry, 'before' | 'after'>, text: { added: string; removed: string }): boolean {
  const before = valueText(entry.before);
  const after = valueText(entry.after);
  const { inserted, deleted } = delta(before, after);
  const gained = squash(inserted);
  const lost = squash(deleted);
  if (telling(gained) && text.added.includes(gained)) return true;
  if (telling(lost) && text.removed.includes(lost)) return true;
  const whole = squash(after);
  return whole.length >= 8 && telling(whole) && text.added.includes(whole);
}
