import { askedInScope, isReservedScope, messageOf, NOTHING_TO_ASK, type CallRecord, type FromCodeChange, type Normalizer } from '@shadowlap/engine';
import { codeVersion, loadConfig } from './config.js';
import { DecisionsError, fromCodeChange, masking, readFromCode, type DecisionsSettings, type DecisionTarget } from './decisions.js';
import { openStore, type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';

/**
 * `shadowlap decisions <runs> --from-code --dry-run`: what the working tree sends each run, read as
 * the preview reads it (each run replayed offline with the guard blocking, nothing sent), and no
 * further: no model call is asked again and no session is kept. The dashboard's Preview changed
 * prompt reads it before it asks.
 */

/** What `--dry-run` read: the change as a preview's report says it, each run's changed calls, and why a run couldn't be read. */
export interface DecisionsRead {
  kind: 'decisions-read';
  fromCode: FromCodeChange;
  /** Each run: its golden, the recorded calls whose prompt or tools the working tree changes, and why it can't be read so (null when it can). */
  runs: Array<{ runId: string; golden: string | null; changed: number[]; refused: string | null }>;
  notes: string[];
  /** Where no call changed, what the preview would say, in its headline's words (`Nothing to ask: the change leaves every request as recorded`); null where one did. */
  nothing: string | null;
}

/** The model calls a preview would ask of a run: the agent's, in `scope`, with their request kept. */
function askedCalls(calls: readonly CallRecord[], scope: string | null): CallRecord[] {
  return calls.filter((c) => c.kind === 'api' && !!c.requestRef && !isReservedScope(c.meta.scope) && askedInScope(c.meta.scope, scope));
}

export async function readDecisions(input: { opts: GlobalOpts; targets: DecisionTarget[]; settings: Pick<DecisionsSettings, 'argv' | 'timeoutMs' | 'scope'>; log: (line: string) => void }): Promise<DecisionsRead> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  // What it prints goes where a preview's report goes: the redaction rules apply to it.
  let rules: Normalizer[];
  try {
    rules = config.redact;
  } catch (err) {
    throw new DecisionsError(`the redaction rules in shadowlap.config.json: ${messageOf(err)}`);
  }
  const store = openStore(input.opts);
  try {
    const { captures } = await readFromCode(input, store, config, cwd);
    const asked = input.targets.flatMap((target) => askedCalls(store.getCalls(target.run.runId), input.settings.scope).map((call) => ({ target, call })));
    const fromCode = fromCodeChange(captures, store, asked, codeVersion(cwd), masking(rules));
    const runs = input.targets.map((t) => {
      const cap = captures.get(t.run.runId);
      const changed = asked.filter((x) => x.target === t && cap?.prompts.get(x.call.callNo)?.changed).map((x) => x.call.callNo);
      return { runId: t.run.runId, golden: t.golden, changed, refused: cap?.refused ?? null };
    });
    const nothing = runs.some((r) => r.changed.length) ? null : `${NOTHING_TO_ASK.lead}${asked.length ? NOTHING_TO_ASK.untouched : NOTHING_TO_ASK.noCalls}`;
    return { kind: 'decisions-read', fromCode, runs, notes: [...new Set([...captures.values()].flatMap((c) => c.notes))], nothing };
  } finally {
    store.close();
  }
}

/** What `--dry-run` read, as the terminal shows it: each run's changed calls, or why it couldn't be read. */
export function formatDecisionsRead(r: DecisionsRead): string {
  const f = r.fromCode;
  const tools = [f.tools.added.length ? `adds ${f.tools.added.join(', ')}` : '', f.tools.removed.length ? `removes ${f.tools.removed.join(', ')}` : '', f.tools.changed.length ? `changes ${f.tools.changed.join(', ')}` : ''].filter(Boolean).join('; ');
  const lines = [`${p.yellow('⑂')} The working tree changes ${f.calls} model call${f.calls === 1 ? '' : 's'}${f.instructions ? ': its instructions' : ''}${tools ? `${f.instructions ? ', and' : ':'} ${tools}` : ''}`];
  for (const x of r.runs) lines.push(`  ${x.golden ?? shortId(x.runId)}  ${x.refused ? p.yellow(x.refused) : x.changed.length ? `#${x.changed.join(', #')}` : p.dim('as recorded')}`);
  for (const n of r.notes) lines.push(p.dim(`  ${n}`));
  return lines.join('\n') + '\n';
}
