import type { FactWords } from '../actions.js';
import { num } from '../format.js';
import { draftCommand } from '../job-title.js';
import { packRunCommand } from './share-steps.js';

/**
 * The facts the dialogs that pack or copy a run say, kept off the run page: Pack as golden…'s
 * commands, what a pack holds and what a copy redacts. Only those dialogs import it (the steps',
 * Share's menu and the copies it opens, Pack with injection gate…, Runs' bulk bar and Training's).
 */

/** What Pack as golden… runs, a line each: the pack into the golden's folder, then its test. */
export function packTestCommands(runId: string, dir: string): readonly string[] {
  return [packRunCommand(runId, dir), draftCommand(['test', dir.trim()])];
}

/** What a pack holds, its one fact besides that. */
export const PACK_HOLDS: FactWords = { label: 'Holds', value: '`run.json`, `calls.jsonl` and one file per blob' };

/**
 * What a copy's dialog says of its redaction rules: how many, and that the store never changes, or
 * that the copy holds what was recorded. A trace holds no prompt text whatever they say. No row where
 * the server doesn't say how many.
 */
export function redactsFact(rules: number | null, trace = false): FactWords | null {
  if (rules === null) return null;
  const by = `by ${num(rules)} ${rules === 1 ? 'rule' : 'rules'}`;
  if (trace) return rules ? { label: 'Redacts', value: by, quiet: 'a trace holds no prompt, arguments or results' } : { label: 'Redacts', value: 'nothing', quiet: 'no redaction rules; a trace holds no prompt, arguments or results' };
  return rules ? { label: 'Redacts', value: by, quiet: 'the store never changes' } : { label: 'Redacts', value: 'nothing', quiet: 'no redaction rules: the copy holds what was recorded' };
}
