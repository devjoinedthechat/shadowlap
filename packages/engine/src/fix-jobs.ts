import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { unsettledFirst } from './blame.js';
import { checkStatus } from './check-status.js';
import { fixLabelInfo, fixLabels, fixOfRun, GOOD_LABEL, type FixRecords } from './fixes.js';
import { isObject } from './is-object.js';
import { commandIsImported, hasRecordedCommand, importedCommandSource } from './pack.js';
import { recordingsOfRun, testsEntryFor } from './run-checks.js';
import { lookupRun } from './run-lookup.js';
import type { StoreOf, StoredBlame, StoredFix } from './store.js';
import { quoteArgv } from './text.js';
import type { RunRecord } from './types.js';

/**
 * The commands a repair from a fix and a verify of it run, and the yes they need first, built here
 * for the dashboard and the terminal UI alike, so every place that starts one runs the same line and
 * asks about the same runs:
 * the failing runs (by the fix's label when that selects exactly them), the good runs of the same
 * agent it keeps, the scope its blame searched, its check, and the repairer when the config names
 * none. A run whose command came from someone else's pack or the team store, among every run the
 * line selects, runs only once the user said yes to the exact lines the question showed.
 */

/**
 * What disguises a command line a person is asked to say yes to: a control character, a format
 * character (a right-to-left override, a zero-width space) or a line or paragraph separator. A value
 * holding one is never run again from here.
 */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;
/** A name (a tool's, a scope's): one line, at most 200 characters, never starting like a flag, a file or a space, and nothing hidden in it. */
const NAME = /^[^\s@-][^\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]{0,199}$/u;

/** `--expect` with a check's JSON, nothing for the exit code alone; null for a check that is no object, or that holds a character that would disguise the command line, which is not run again. */
export function expectArgs(expect: unknown): string[] | null {
  if (expect === null || expect === undefined) return [];
  if (typeof expect !== 'object' || Array.isArray(expect)) return null;
  const json = JSON.stringify(expect);
  return HIDDEN.test(json) ? null : ['--expect', json];
}

/** A scope as `--scope` takes it, or null when it isn't of a name's shape. */
export const scopeArg = (scope: string | null | undefined): string[] | null => (!scope ? [] : NAME.test(scope) ? ['--scope', scope] : null);

/** What a pulled record left out, in words: `--build, --base and command after --`. */
export function leftWords(left: readonly string[]): string {
  const words = left.map((f) => (f === '--' ? 'command after --' : f));
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}` : (words[0] ?? '');
}

/** The blame a fix shows: the latest that found where a run was lost, else the latest. */
export function shownBlame(rec: FixRecords): StoredBlame | null {
  return [...rec.blames].reverse().find((b) => b.outcome === 'blamed') ?? rec.blames.at(-1) ?? null;
}

/**
 * Whether a blame placed the failure on no call and knows that no answer of the model's lost the
 * run: its passing attempts answered as the recording did, or every attempt met a write's recorded
 * error again. A prompt repair is no fix for such a run; the tools, the harness or the command are.
 */
export function noAnswerLost(b: StoredBlame | null): boolean {
  return !!b && b.outcome === 'unrescuable' && !!(b.report.sameAnswer || b.report.failedWrite);
}

/**
 * Whether `label:<label>` selects exactly the fix's failing runs that are left: none of another
 * fix's (a customer's label, say), no run in no fix (a run that passed, labelled with the failure
 * it was recorded for), and every one of the fix's. Anything else would be repaired as failing.
 */
export function labelSelectsFix(store: StoreOf<'recording'>, label: string, left: readonly string[]): boolean {
  const failing = new Set(left);
  const labelled = store.allRuns().filter((r) => r.meta?.labels?.includes(label));
  return labelled.length === failing.size && labelled.every((r) => failing.has(r.runId));
}

/** A word of a command that names the script it runs: `agent.mjs`, `src/agent.ts`, `refund_agent.py`. */
const SCRIPT = /\.(?:[cm]?[jt]sx?|py|rb|sh|php|pl|lua|exs?|jl)$/i;

/**
 * The agent a command runs, to tell one agent's runs from another's: its words up to the script it
 * runs (`node agent.mjs`, `python -m support.agent`), without the arguments of one run (`A-1150`,
 * `--persona pushy-customer`); the whole command when no word names a script. Null for none.
 */
export function agentOfArgv(argv: readonly string[]): string | null {
  if (!argv.length) return null;
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === '-m' && i + 1 < argv.length) return argv.slice(0, i + 2).join(' ');
    if (!w.startsWith('-') && SCRIPT.test(w)) return argv.slice(0, i + 1).join(' ');
  }
  return argv.join(' ');
}

/** The agent a run ran: its recording's, for a replay, a fork or an attempt; null for a run with no command (an import). */
export function agentOfRun(store: StoreOf<'recording'>, run: RunRecord): string | null {
  let root = run;
  const seen = new Set([root.runId]);
  while (root.parentRunId) {
    const parent = store.getRun(root.parentRunId);
    if (!parent || seen.has(parent.runId)) break;
    seen.add(parent.runId);
    root = parent;
  }
  return hasRecordedCommand(root) ? agentOfArgv(root.command.argv) : null;
}

/**
 * The good runs a repair or a verify from a fix keeps: the fix's own good runs (those a repair or a
 * verify of it kept); else the runs labelled good that run the same agent as its failing runs
 * (`label:good` when that is all of them, else by id), since a good run of another agent checks
 * nothing a change to this one touches; else none.
 */
export function keepArgs(store: StoreOf<'recording'>, rec: FixRecords, left: readonly string[]): string[] {
  const own = rec.good.filter((id) => store.getRun(id) !== null);
  if (own.length) return own;
  const agents = new Set(left.map((id) => agentOfRun(store, store.getRun(id)!)).filter((a): a is string => a !== null));
  if (!agents.size) return [];
  const failing = new Set(left);
  const good = store.allRuns().filter((r) => r.meta?.labels?.includes(GOOD_LABEL));
  const same = good.filter((r) => !failing.has(r.runId) && agents.has(agentOfRun(store, r) ?? ''));
  if (!same.length) return [];
  return same.length === good.length ? [`label:${GOOD_LABEL}`] : same.map((r) => r.runId);
}

/** What a repair from a fix and a verify of it are given: its failing runs, the good runs it keeps, and its check. */
export function fixRunArgs(store: StoreOf<'recording' | 'fixes'>, rec: FixRecords): { fixes: string[]; keeps: string[]; expect: string[] } | null {
  // Without a failing run left, a label would select nothing, and repair would refuse it.
  const left = rec.failing.filter((id) => store.getRun(id) !== null);
  if (!left.length) return null;
  const { label } = fixLabelInfo(store, rec.fix);
  // A check that is no object (one a pull brought, say) is no `--expect`: nothing runs under it.
  const expect = expectArgs(rec.fix.check.expect);
  if (!expect) return null;
  return {
    fixes: label && labelSelectsFix(store, label, left) ? [`label:${label}`] : left,
    keeps: keepArgs(store, rec, left),
    expect,
  };
}

/**
 * `shadowlap repair` from a fix: its failing runs (by its label when that selects exactly them),
 * the good runs it keeps (`keepArgs`), the scope its blame searched, so the repair blames the same
 * calls and reuses that blame rather than make it again, and its check. Empty when none of its
 * failing runs is left in the store.
 */
export function repairArgv(store: StoreOf<'recording' | 'fixes'>, rec: FixRecords): string[] {
  const runs = fixRunArgs(store, rec);
  // A blame's scope (a pulled one's too) goes as `--scope` only when it is a name, never a flag.
  const scope = scopeArg(shownBlame(rec)?.scope);
  if (!runs || !scope) return [];
  return ['repair', '--fixes', ...runs.fixes, ...(runs.keeps.length ? ['--keeps', ...runs.keeps] : []), ...scope, ...runs.expect];
}

/**
 * Why a repair from here would end "No fix to try" without running the agent, in a sentence, or
 * null when it would run it. A repair reuses the blame kept on a failing run when it searched under
 * the same check, rescue and scope, rather than search again (as `shadowlap repair` does): when that
 * blame of every failing run left rescued it from no call, there is no passing path to learn from.
 * Said as the CLI says why: no answer of the model's lost the runs, blame couldn't settle where they
 * were lost, or nothing rescued them.
 */
export function noFixToTry(store: StoreOf<'recording' | 'fixes'>, rec: FixRecords, scope: string | null): string | null {
  const runs = rec.failing.map((id) => store.getRun(id)).filter((r): r is RunRecord => r !== null);
  if (!runs.length) return null;
  const oracle = JSON.stringify(rec.fix.check.oracle);
  const kept: StoredBlame[] = [];
  for (const run of runs) {
    const stored = run.meta?.blame;
    const last = store.blamesOfRun(run.runId).at(-1);
    if (!stored || !last || stored.outcome !== 'unrescuable') return null;
    if (JSON.stringify(stored.oracle) !== oracle || Object.keys(stored.fields ?? {}).length || (stored.scope ?? null) !== scope) return null;
    kept.push(last);
  }
  const one = runs.length === 1;
  if (kept.every(noAnswerLost)) return `Blame found that no answer of the model's lost ${one ? 'this run' : 'these runs'}, so a rewrite of the prompt can't fix ${one ? 'it' : 'them'}: the repair ends “No fix to try”. Look at the tools, the harness or the command.`;
  if (kept.every((b, i) => runs[i]!.meta?.blame?.unsettled === true || (b.outcome === 'unrescuable' && unsettledFirst(b.report)))) return `Blame couldn't settle where ${one ? 'the run was' : 'the runs were'} lost, so a rewrite of the prompt has nothing to aim at yet: the repair ends “No fix to try”. Settle the blame first.`;
  return 'No failing run was rescued, so there is no passing path to learn from: the repair ends “No fix to try”.';
}

/** `shadowlap verify` of a change for a fix, as its empty Verify step shows it: the runs and the check a repair from it would take. Empty as `repairArgv` is. */
export function verifyArgv(store: StoreOf<'recording' | 'fixes'>, rec: FixRecords): string[] {
  const runs = fixRunArgs(store, rec);
  if (!runs) return [];
  return ['verify', '--fixes', ...runs.fixes, ...(runs.keeps.length ? ['--keeps', ...runs.keeps] : []), ...runs.expect];
}

/** The repairer a repair from the dashboard (or `fix show`'s next step) uses when the config names none. */
export const DEFAULT_REPAIRER = 'claude-code';

/**
 * `shadowlap repair` as the dashboard runs it: a repairer set in shadowlap.config.json applies by
 * itself, as the CLI reads it; otherwise the user's own Claude Code, named on the command line.
 */
export function repairJobArgv(argv: readonly string[], configured: string | null | undefined): string[] {
  return [...argv, ...(configured ? [] : ['--repairer', DEFAULT_REPAIRER])];
}

/**
 * Why the repairer can't be asked, as a sentence for the Repair from here dialog and `fix show`; null
 * when nothing stands in the way. `configured`: shadowlap.config.json names it (otherwise it is the
 * user's own Claude Code, the dashboard's default). Only what is certain is checked: the claude-code
 * repairer runs `claude`, or the program SHADOWLAP_CLAUDE names, and it must be found on the PATH of
 * the environment the repair's command gets.
 */
export function repairerProblem(repairer: string, configured: boolean, o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; isFile?: (path: string) => boolean } = {}): string | null {
  if (!/^claude-code(?::|$)/.test(repairer.trim())) return null;
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const named = envValue(env, 'SHADOWLAP_CLAUDE')?.trim() || null;
  if (findProgram(named ?? 'claude', { path: envValue(env, 'PATH') ?? '', pathext: envValue(env, 'PATHEXT') ?? '', platform, isFile: o.isFile ?? isFile })) return null;
  const elsewhere = configured ? 'or have the config name another repairer' : 'or name another repairer in shadowlap.config.json (repair.repairer)';
  const asks = configured ? 'shadowlap.config.json names Claude Code as the repairer' : 'This repair asks your own Claude Code';
  if (named) return `${asks}, and ${named}, which SHADOWLAP_CLAUDE names, was not found: point SHADOWLAP_CLAUDE at Claude Code, ${elsewhere}.`;
  return `${asks}, and claude was not found on this machine: install Claude Code, or set SHADOWLAP_CLAUDE to its path, ${elsewhere}.`;
}

/**
 * Whether a program is found as starting it would find it: a path where it points (an absolute one;
 * the repairer starts in a folder of its own, so a relative one finds nothing), a bare name in each
 * folder of PATH, which on Windows also tries the extensions PATHEXT lists (`claude.cmd`, as npm
 * installs it). Empty and relative PATH entries name the folder it starts in, so they are skipped.
 */
export function findProgram(program: string, o: { path: string; pathext?: string; platform: NodeJS.Platform; isFile: (path: string) => boolean }): boolean {
  const win = o.platform === 'win32';
  const p = win ? win32 : posix;
  // Windows' names ignore case: `.CMD` in PATHEXT finds claude.cmd, which npm installs.
  const exts = win ? ['', ...(o.pathext || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)] : [''];
  const tries = (base: string) => exts.some((ext) => o.isFile(base + ext));
  if (/[\\/]/.test(program) || (win && /^[a-z]:/i.test(program))) return p.isAbsolute(program) && tries(program);
  return o.path
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && p.isAbsolute(d))
    .some((dir) => tries(p.join(dir, program)));
}

/** A variable of `env`, whatever the case of its name: Windows' names ignore case (`Path`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** A file that is there, and on macOS and Linux one this user may run. */
function isFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A yes to a command someone else's run brings (a pack's, a teammate's pulled from the team store,
 * one a program sent the sidecar) is a yes to the command lines the question showed, never to
 * whatever a second request builds. The question carries `confirm`: a digest of those lines. Saying
 * yes sends it back; the command is built again, so one that would now run another line (a pull
 * changed the fields a blame is made from, the run is another) is asked again, naming that line.
 */
export function consentKey(lines: ReadonlyArray<readonly string[]>): string {
  return createHash('sha256').update(JSON.stringify(lines)).digest('hex').slice(0, 32);
}

/** Whether `yes` is the `confirm` of the question that showed `lines`. */
export function saidYes(yes: unknown, lines: ReadonlyArray<readonly string[]>): boolean {
  return typeof yes === 'string' && yes === consentKey(lines);
}

/** The question: the words it shows, and what saying yes to them sends back. */
export function askConsent(error: string, lines: ReadonlyArray<readonly string[]>): { error: string; status: 409; confirm: string } {
  return { error, status: 409, confirm: consentKey(lines) };
}

/**
 * A job's question about the commands someone else chose that it runs (`lines`), or its answer:
 * `ask`, the question in the words `words` gives, until the request says yes to exactly those lines;
 * then `yes`, the `--yes` the CLI takes so it asks nothing again. With nothing to ask, `yes` is
 * empty: a yes sent anyway answers no question, so it never reaches the CLI, which asks what it asks
 * itself (and refuses it, as a job has no terminal to answer in).
 */
export type JobConsent = { ask: { error: string; status: 409; confirm: string } } | { yes: string[] };

export function jobConsent(lines: ReadonlyArray<readonly string[]>, yes: unknown, words: () => string): JobConsent {
  if (!lines.length) return { yes: [] };
  return saidYes(yes, lines) ? { yes: ['--yes'] } : { ask: askConsent(words(), lines) };
}

/**
 * What runs only once the user said yes to it, with the exact command line the job runs (`args`,
 * after `shadowlap`): a run whose command came from someone else's pack or from the team store, and
 * a blame or a verdict a pull brought (`pulled`), whose command is made here from its checked
 * fields, without what it ran with on a teammate's machine (`left`). The yes is to the lines the
 * question showed: one a pull has since changed is asked again.
 */
export function needsConsent(o: { runs: RunRecord[]; yes: unknown; args: readonly string[]; pulled?: { what: string; left: readonly string[] } | null }): JobConsent {
  const imported = o.runs.find((r) => commandIsImported(r));
  // `--yes` reaches the CLI only once the request said yes to this question: with none asked, a yes sent anyway is passed on to nothing.
  if (!imported && !o.pulled) return jobConsent([], o.yes, () => '');
  const lines = [['shadowlap', ...o.args], ...(imported ? [imported.command.argv] : [])];
  const line = quoteArgv(['shadowlap', ...o.args]);
  return jobConsent(lines, o.yes, () => {
    if (o.pulled) {
      const p = o.pulled;
      const without = p.left.length ? `, without the ${leftWords(p.left)} it ran with there` : '';
      const and = imported ? `, and the command ${imported.runId.slice(0, 10)} was recorded with (${quoteArgv(imported.command.argv)}), which came from ${importedCommandSource(imported)}` : '';
      return `${p.what} came from the team store: this runs the command ${line}, made here from its own fields${without}${and}. Confirm it to run it`;
    }
    return `${imported!.runId.slice(0, 10)} came from ${importedCommandSource(imported!)}: this runs the command it was recorded with (${quoteArgv(imported!.command.argv)}), under ${line}. Confirm it to run it`;
  });
}

/**
 * The runs a repair command line gives its `--fixes`, `--holdout` and `--keeps`, as the CLI selects
 * them when it runs: run ids, and `label:<name>` for every run with that label, imported ones too.
 */
export function selectedRuns(store: StoreOf<'recording'>, argv: readonly string[]): RunRecord[] {
  const out = new Map<string, RunRecord>();
  let listing = false;
  for (const a of argv) {
    if (a.startsWith('--')) {
      listing = a === '--fixes' || a === '--holdout' || a === '--keeps';
      continue;
    }
    if (!listing) continue;
    if (a.startsWith('label:')) {
      const label = a.slice('label:'.length);
      for (const r of store.allRuns()) if (r.meta?.labels?.includes(label)) out.set(r.runId, r);
    } else {
      const r = lookupRun(store, a);
      if (r) out.set(r.runId, r);
    }
  }
  return [...out.values()];
}

/**
 * The check a blame of a run starts from when nobody named one, as the dashboard and the terminal
 * UI both pick it, and where it came from: the run was judged by it with `--expect` (`replay`);
 * shadowlap.config.json's `tests` give it for the recording the run replays, found through its
 * ancestors as the CLI finds it (`config`); the fix the run fails in has it (`fix`); a fix the run's
 * labels point to has it (`labels`); or the agent exited with an error, which every blame checks
 * (`exit`).
 */
export interface BlameCheck {
  /** The check as `--expect` takes it; null to blame on the exit code alone. */
  expect: unknown;
  from: 'replay' | 'config' | 'fix' | 'labels' | 'exit';
}

/**
 * The labels of the checks a run failed, as it recorded them (`meta.checks`, untrusted: a run can
 * come from a pack). Not a check that could not be decided, which is stored with `ok: false` too:
 * an inconclusive check is no failure for a blame to look for.
 */
export function failedCheckLabels(run: RunRecord): string[] {
  const checks: unknown = run.meta?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((c) => (isObject(c) && checkStatus(c) === 'failed' && typeof c.label === 'string' ? [c.label] : []));
}

/**
 * The `expect` shadowlap.config.json's `tests` give the recording a run replays (the golden a test
 * replayed, or the pack it was unpacked from, through its ancestors), or undefined when no entry
 * names one. `tests` is the config's `tests` as written; `configDir` the folder it is in.
 */
export function configExpect(store: StoreOf<'recording'>, run: RunRecord, tests: unknown, configDir: string): Record<string, unknown> | undefined {
  if (!isObject(tests)) return undefined;
  const entries = Object.entries(tests).map(([recording, spec]) => ({ recording, spec }));
  for (const dir of recordingsOfRun(store, run)) {
    const entry = testsEntryFor(entries, dir, configDir);
    if (entry) return isObject(entry.spec) && isObject(entry.spec.expect) ? entry.spec.expect : undefined;
  }
  return undefined;
}

/** Every fix, with the labels it holds its runs by. */
export const labelledFixes = (store: StoreOf<'recording' | 'fixes'>): Array<{ fix: StoredFix; labels: string[] }> => store.listFixes().map((fix) => ({ fix, labels: fixLabelInfo(store, fix).labels }));

/**
 * The check a blame of a run never blamed can use: the check of a fix its labels point to, one that
 * holds every label of the run first, then one not yet applied, then the latest opened.
 */
export function checkSuggestion(run: RunRecord, fixes: Array<{ fix: StoredFix; labels: string[] }>): { expect: unknown } | null {
  const labels = fixLabels(run);
  if (!labels.length) return null;
  const scored = fixes
    .map((x) => ({ ...x, shared: labels.filter((l) => x.labels.includes(l)).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || Number(a.fix.status === 'applied') - Number(b.fix.status === 'applied') || b.fix.openedAt - a.fix.openedAt);
  return scored[0] ? { expect: scored[0].fix.check.expect } : null;
}

/**
 * The check a blame of a run can use when nobody named one, or null when nothing says what a passing
 * run must do: then the dashboard and the terminal UI ask for it. In order: the run's own `--expect`;
 * the config's, for the recording it replays (`tests`, the config's `tests`, and `configDir`, its
 * folder); the fix it fails in; a fix its labels point to; the agent's exit, for a run that exited
 * with an error. A run that failed a check none of these name gets null rather than the exit code:
 * blaming on the exit alone would look for another failure than the one it had. A check that could
 * not be decided is no such failure, so a run whose agent exited with an error is blamed on that.
 */
export function blameCheckFor(store: StoreOf<'recording' | 'fixes'>, run: RunRecord, options: { tests?: unknown; configDir?: string | null } = {}): BlameCheck | null {
  const judged = run.meta?.expect;
  if (isObject(judged)) return { expect: judged, from: 'replay' };
  const configured = options.configDir ? configExpect(store, run, options.tests, options.configDir) : undefined;
  if (configured) return { expect: configured, from: 'config' };
  const failing = fixOfRun(store, run.runId);
  if (failing) return { expect: failing.check.expect ?? null, from: 'fix' };
  const suggested = fixLabels(run).length ? checkSuggestion(run, labelledFixes(store)) : null;
  if (suggested) return { expect: suggested.expect ?? null, from: 'labels' };
  if (failedCheckLabels(run).length) return null;
  if (run.status === 'failed') return { expect: null, from: 'exit' };
  return null;
}
