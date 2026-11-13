import { ACTIONS, changeFixCheck, CHECK_MARKS, FixNotOpenError, fixRecords, messageOf, oracleLabels, shortFixId, type Store, type StoredFix } from '@shadowlap/engine';
import { fixCheckOf, fixCheckRefusal, fixDetail, fixHref, hiddenCheckWords, judgeFixRuns, notOpenWords, uncountedUnder, type FixCheckJudging, type FixCheckRow } from '@shadowlap/dashboard';
import { currentAuthor, logActivity } from './activity.js';
import { checkedLines } from './commands/check.js';
import { readExpectJson } from './commands/fix-flags.js';
import { loadConfig } from './config.js';
import { EXIT } from './exit-codes.js';
import { checkText } from './fixes.js';
import { emitJobEvent } from './job-events.js';
import { palette as p, safe, shortId } from './ui.js';

/**
 * `shadowlap fix check`: an open fix given another check. Its failing and good runs are judged by it
 * again from their recordings, nothing replayed (the dashboard's fix-check.ts, which the Fixes page's
 * preview reads too). A failing run it passes and a good run it fails leave the fix; its blames,
 * repairs and verdicts keep the check each ran under, and a verdict counts only under the check it has.
 */

/** Why the check wasn't changed: exit 2, nothing written. `judging`, how it judged the runs when it got that far. */
export class FixCheckError extends Error {
  constructor(
    message: string,
    readonly fixId: string,
    readonly judging: Pick<FixCheckJudging, 'rows' | 'left'> | null = null,
  ) {
    super(message);
  }
}

export interface FixCheckResult {
  fixId: string;
  /** `unchanged` for the check the fix has: nothing judged, nothing written. */
  status: 'changed' | 'unchanged';
  check: StoredFix['check'];
  previous: StoredFix['check'];
  /** Each run as the check judged it, failing ones first. */
  runs: FixCheckRow[];
  /** The runs it left out of the fix: failing runs it passes, good runs it fails. */
  left: { failing: string[]; good: string[] };
  /** The verdicts that counted for the fix and no longer do, made under the check before. */
  uncounted: string[];
  /** The command of the fix's next step under its check. */
  next: string | null;
}

/** What `fix check` did: what `--json` prints, and each verdict that stopped counting by the change it verified, as the fix's page names it. */
export interface FixCheckDone {
  result: FixCheckResult;
  codes: string[];
}

/** Gives the fix the check `--expect` holds (`raw`, JSON or @file), or throws a FixCheckError saying why not. */
export function changeCheck(store: Store, fix: StoredFix, raw: string, o: { cwd: string }): FixCheckDone {
  if (fix.status !== 'open') throw new FixCheckError(notOpenWords(fix), fix.fixId);
  let asked: ReturnType<typeof readExpectJson>;
  try {
    asked = readExpectJson(raw);
  } catch (err) {
    throw new FixCheckError(messageOf(err), fix.fixId);
  }
  const hidden = hiddenCheckWords(asked.json);
  if (hidden) throw new FixCheckError(hidden, fix.fixId);
  const check = fixCheckOf(asked.json, oracleLabels(asked.spec), checkText(asked.spec));
  const unchanged = (has: StoredFix['check']): FixCheckDone => ({ result: { fixId: fix.fixId, status: 'unchanged', check: has, previous: has, left: { failing: [], good: [] }, uncounted: [], runs: [], next: null }, codes: [] });
  if (check.key === fix.check.key) return unchanged(fix.check);
  const rec = fixRecords(store, fix);
  const prices = loadConfig(o.cwd).prices;
  const judging = judgeFixRuns(store, rec, { spec: asked.spec, expect: asked.json }, prices ? { prices } : {});
  const refused = fixCheckRefusal(fix.fixId, judging.rows);
  if (refused) throw new FixCheckError(refused, fix.fixId, judging);
  const uncounted = uncountedUnder(rec, check, judging);
  // Another `fix check` gave it this check while its runs were judged: nothing more to write or log.
  if (!write(store, fix.fixId, { check, judged: judging.judged, actor: currentAuthor() })) return unchanged(check);
  logActivity(store, { kind: 'fix.check', ref: fix.fixId, data: { title: fix.title, check: check.text, previous: fix.check.text } });
  const next = fixDetail(store, fix.fixId)?.lead?.command ?? null;
  const result: FixCheckResult = { fixId: fix.fixId, status: 'changed', check, previous: fix.check, runs: judging.rows, left: judging.left, uncounted: uncounted.map((v) => v.verifyId), next };
  return { result, codes: uncounted.map((v) => v.code) };
}

/**
 * Writes the check, or false when the fix had it already. A fix a verify settled while its runs were
 * judged, outside the write, is refused as one settled before is: exit 2, in the same words.
 */
function write(store: Store, fixId: string, change: Parameters<typeof changeFixCheck>[2]): boolean {
  try {
    return changeFixCheck(store, fixId, change).changed;
  } catch (err) {
    if (err instanceof FixNotOpenError) throw new FixCheckError(notOpenWords(err.fix), fixId);
    throw err;
  }
}

const COLOUR = { passed: p.green, failed: p.red, inconclusive: p.yellow, 'not-applicable': p.dim } as const;

/**
 * A run as the check judged it, as `shadowlap check` prints a recording (checkedLines), after its
 * role: its mark (a run none of whose checks applied is never marked passed), its id, the outcome,
 * the checks under one that didn't pass; and whether it leaves the fix, as the judging's `left` says
 * (`would`: the check was refused, so it only would).
 */
function runLines(r: FixCheckRow, left: FixCheckJudging['left'], would = false): string[] {
  const role = r.role.padEnd(7);
  if (r.outcome === 'gone') return [`  ${role}   ${shortId(r.runId)}  ${p.dim('gone from the store')}`];
  const status = r.na ? 'not-applicable' : r.outcome;
  const [head, ...under] = checkedLines({ outcome: r.outcome, checks: r.checks, why: r.why }, `  ${role} ${COLOUR[status](CHECK_MARKS[status])} ${shortId(r.runId)}`);
  const leaves = left[r.role].includes(r.runId) ? p.dim(` · ${would ? 'would leave' : 'leaves'} the fix`) : '';
  return [`${head!}${leaves}`, ...under.map((line) => `${' '.repeat(10)}${line}`)];
}

/** What `fix check` did, as text or JSON, with the fix as the job's way on. */
export function reportFixCheck({ result, codes }: FixCheckDone, flags: { json?: boolean }, title: string): void {
  if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else if (result.status === 'unchanged') process.stdout.write(`${shortFixId(result.fixId)} · its check already: ${safe(result.check.text)}\n`);
  else {
    const lines = [`${p.green('✓')} Changed the check of ${shortFixId(result.fixId)} · ${safe(title)}`, `  must: ${safe(result.check.text)}`, `  was:  ${safe(result.previous.text)}`, ...result.runs.flatMap((r) => runLines(r, result.left))];
    const n = codes.length;
    if (n) lines.push(`${p.yellow('!')} ${n} verdict${n === 1 ? '' : 's'} no longer count${n === 1 ? 's' : ''} for it: ${codes.map(safe).join(', ')} checked the old one`);
    if (result.next) lines.push(`next: ${safe(result.next)}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  emitJobEvent({ type: 'link', label: ACTIONS.openFix.label, href: fixHref(result.fixId) });
  emitJobEvent({ type: 'result', data: result });
  process.exitCode = EXIT.ok;
}

/** A refusal, as text (with how the check judged the runs, when it got that far) or JSON: exit 2. */
export function reportFixCheckRefused(err: FixCheckError, flags: { json?: boolean }): void {
  const answer = { fixId: err.fixId, status: 'error', error: { message: err.message } };
  if (flags.json) process.stdout.write(JSON.stringify(answer, null, 2) + '\n');
  else process.stderr.write([`${p.red('✗')} ${safe(err.message)}`, ...(err.judging?.rows ?? []).flatMap((r) => runLines(r, err.judging!.left, true))].join('\n') + '\n');
  emitJobEvent({ type: 'result', data: answer });
  process.exitCode = EXIT.usage;
}
