import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { agentCallsOf, applyEdit, BLAME_DEFAULTS, unavailableStop, CHARS_PER_TOKEN, checkEdit, commitTitle, eachRun, describeBlocks, editSize, estimateCost, findAnchors, footprintDelta, forbiddenDetails, formatUsd, isJudgeCall, loadApiRequest, NO_REPAIRER, normalizeConversation, notTheAnswer, packRun, redactRun, releaseLock, REPAIR_FILE_LIMIT, repairMarkdown, repairPatchProblem, rewriteGrowth, rewriteText, safeLine, Store, takeLock, toolDefinitions, unifiedDiff, unrescuedWords, unsettledFirst, type Anchor, type Conversation, type HeldLock, type Normalizer, type Price, type RepairCandidate, type RepairReport, type RepairTarget, type RunRecord, type SourceFile, type SprtGate, type Surface, type VerifyRole } from '@shadowlap/engine';
import { STOP_SIGNALS } from './agent-signals.js';
import { judgeRecording, oracleLabels, type AttemptSettings, type AttemptTarget } from './attempts.js';
import { BlameError, inScope, responseBlocks, runBlame } from './blame.js';
import { loadConfig } from './config.js';
import { candidateTree, COPY_LIMIT, fileInside, readInside, removeCandidateTrees, writeInside } from './repair-tree.js';
import { askRepairer, buildRepairPrompt, cannotAsk, DEFAULT_ANTHROPIC_REPAIRER, DEFAULT_REPAIRER_TIMEOUT_MS, RepairerError, type RepairCase, type Repairer } from './repairer.js';
import { physicalPath } from './real-path.js';
import { CandidatePicker, untriedWords } from './repair-pick.js';
import { openStore, type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';
import { runVerify } from './verify.js';
import { BaseCheckout } from './verify-base.js';

/**
 * `shadowlap repair`: blame each failing run, propose fixes, and keep the smallest one the verify gate
 * accepts. The loop is detect → localize → propose → verify → hand over, and only "propose" involves
 * a model that isn't the agent's own; blame, applying an edit, replaying and the verdict are all
 * deterministic, so the repairer never grades its own work.
 *
 * Each candidate is verified in a temporary git worktree of the working tree as it is (repair-tree.ts),
 * never in the working tree itself, which an editor, a dev server or a parallel `shadowlap test` reads
 * while verify runs. The accepted one reaches the working tree only at the end, with `--apply`, once
 * its patch is checked against it. Before verify spends anything on a candidate, its rewrite alone is
 * held to `--max-growth`; the repairer is asked within a time limit.
 */

export interface RepairSettings extends AttemptSettings {
  /** The verify gate: the gate each run is decided by (stats.ts), or, when it is null, a fixed count: a run passes at `needed` of `attempts`. */
  attempts: number;
  needed: number;
  gate: SprtGate | null;
  /** Runs verified at once, and attempts of a blame probe at once. */
  concurrency: number;
  /** Candidates to ask the repairer for. */
  candidates: number;
  /** A model to rescue with when resampling the recorded one does not. */
  stronger: string | null;
  /** Blame only model calls made in this scope: the agent's, not a simulated user's. */
  scope?: string | null;
  /** Request fields blame's probes set from the probed call on, such as a temperature that lets them sample. */
  rescueFields?: Record<string, unknown>;
  /** The largest growth in input tokens per run a fix may cause, as a fraction. */
  maxGrowth: number;
  /** A shell command that builds the agent after its source changes. */
  build: string | null;
  repairer: Repairer;
  /** Whether a repairer was configured at all; without one, only fixes that need no model are tried. */
  repairerConfigured?: boolean;
  /** How long the repairer has to answer (`--repairer-timeout`, `repair.timeout`); 10 minutes when absent. */
  repairerTimeoutMs?: number;
}

export interface RepairOutputs {
  /** Leave the accepted change in the working tree. */
  apply: boolean;
  /** Commit the accepted change to a new branch, without checking it out. */
  branch: string | null;
  /** Push the branch and open a pull request with `gh`. */
  pr: boolean;
  /** Where the recordings of the fixed runs go in the project, for `shadowlap test`. */
  goldens: string | null;
}

export interface RepairInput {
  opts: GlobalOpts;
  targets: AttemptTarget[];
  holdout: AttemptTarget[];
  good: AttemptTarget[];
  heldOutAutomatically: boolean;
  settings: RepairSettings;
  outputs: RepairOutputs;
  log: (line: string) => void;
}

/** Repair could not start; the message says why. */
export class RepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepairError';
  }
}

/**
 * The repair ran, and handing it over (`--apply`, `--branch`, `--pr`) failed part way. Its directory,
 * patch and report.json are written, and `report` says what was handed over before the failure, so
 * the repair and its verdict are still kept.
 */
export class HandOverError extends RepairError {
  constructor(
    message: string,
    readonly report: RepairReport,
  ) {
    super(message);
    this.name = 'HandOverError';
  }
}

const journalPath = (cwd: string) => join(cwd, '.shadowlap', 'repair-journal.json');

/** The longest answer the repairer is asked for, in tokens: what the Anthropic request allows it (max_tokens). */
export const REPAIRER_ANSWER_TOKENS = 16_000;

/**
 * The characters one token of the repairer's prompt is taken to hold when what asking it could cost is
 * worked out: fewer than tokenizers fit into a token of English (about 4), so its tokens are counted
 * high, and so is the cost, which is what a budget is checked against.
 */
export const PROMPT_CHARS_PER_TOKEN = 3;

/**
 * The most asking the repairer could cost, before it is asked: its prompt, counted high, and the
 * longest answer it may give, at its model's price (Claude Code's own default is priced as
 * Shadowlap's, DEFAULT_ANTHROPIC_REPAIRER). Null for a model with no price, which no budget can
 * count beforehand: its reported cost, when it has one, is counted once it answers.
 */
export function repairerMost(r: Pick<Repairer, 'provider' | 'model'>, prompt: { system: string; user: string }, prices?: Record<string, Price>): number | null {
  const model = r.model || (r.provider === 'claude-code' ? DEFAULT_ANTHROPIC_REPAIRER : null);
  return estimateCost(model, { inputTokens: Math.ceil((prompt.system.length + prompt.user.length) / PROMPT_CHARS_PER_TOKEN), outputTokens: REPAIRER_ANSWER_TOKENS }, prices);
}

/** What is copied of the files git ignores into a candidate's worktree, in MB, as a warning says it. */
const REPAIR_COPY_LIMIT_MB = COPY_LIMIT / 1024 / 1024;

/** Puts back whatever an interrupted repair left in the working tree. Returns the files it restored. */
export function recoverWorkingTree(cwd: string): string[] {
  const path = journalPath(cwd);
  if (!existsSync(path)) return [];
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { files: Array<{ path: string; original: string; patched: string }> };
  const restored: string[] = [];
  for (const f of journal.files) {
    const now = existsSync(f.path) ? readFileSync(f.path, 'utf8') : null;
    // Only undo our own edit: a file someone changed since is theirs now.
    if (now === Buffer.from(f.patched, 'base64').toString('utf8')) {
      writeFileSync(f.path, Buffer.from(f.original, 'base64'));
      restored.push(f.path);
    }
  }
  rmSync(path, { force: true });
  return restored;
}

/**
 * Starts a repair in `cwd`: takes `.shadowlap/repair.lock` (the engine's lock file), held until the
 * repair ends, then cleans up after one that died: the worktrees it verified candidates in, and the
 * working tree an older Shadowlap, which tried candidates in place, may have left edited (its
 * journal). One repair runs in a folder at a time, as `--apply` writes the working tree, so what is
 * found here is never a running repair's: the repair that left it died, and the lock of a process
 * that died is taken over at once. A repair runs for minutes, so a lock whose holder this machine
 * can't check (one in a container or on another machine that shares the folder) is never taken over
 * by its age: it waits until someone deletes it. Throws when another repair runs here.
 */
export function startRepair(cwd: string): { lock: HeldLock; restored: string[] } {
  mkdirSync(join(cwd, '.shadowlap'), { recursive: true, mode: 0o700 });
  const path = join(cwd, '.shadowlap', 'repair.lock');
  const lock = takeLock(path, { wait: 0, mode: 0o600, ageOut: false, busy: () => new RepairError(`another shadowlap repair is running in this folder: wait for it to end (if none is running, delete ${path})`) });
  try {
    removeCandidateTrees(cwd);
    return { lock, restored: recoverWorkingTree(cwd) };
  } catch (err) {
    releaseLock(lock);
    throw err;
  }
}

function gitRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    throw new RepairError('shadowlap repair edits the agent\'s source, so it has to run inside the git repository that holds it');
  }
}

/**
 * Where `--goldens` puts recordings in the repository, for a commit to `--branch`: the folder, from
 * the one repair runs in, relative to the repository's root. A folder outside it can't be committed.
 */
export function goldensInRepo(root: string, cwd: string, goldens: string): string {
  // Compared as the system names both: git gives the root's long name on Windows, where the folder
  // repair runs in may have been reached by a short one (C:\Users\RUNNER~1).
  const rel = relative(physicalPath(root), physicalPath(resolve(cwd, goldens)));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new RepairError(`--goldens ${goldens} is outside the repository, so its recordings can't be committed to a branch: give a folder inside it`);
  return rel;
}

const git = (root: string, args: string[], o: { input?: string; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...(o.input !== undefined ? { input: o.input } : {}), ...(o.env ? { env: o.env } : {}) }).toString();

/**
 * The project's text files: tracked, and untracked but not ignored. A link is read as the file it
 * ends at, under that file's own path, and only when that file is in the repository too (fileInside):
 * a rewrite is only ever written to a file of the repository's, never through a link to another.
 */
export function projectFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const seen = new Set<string>();
  const real = physicalPath(root);
  for (const listed of git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')) {
    if (!listed) continue;
    // A committed recording (a golden, or __recordings__/) holds copies of the prompts, not their source.
    if (/(^|\/)blobs\/[0-9a-f]{64}$/.test(listed)) continue;
    const path = fileInside(real, listed);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    try {
      if (statSync(join(real, path)).size > REPAIR_FILE_LIMIT) continue;
      const content = readInside(real, path);
      if (!content.includes('\u0000')) out.push({ path, content });
    } catch {
      // deleted in the working tree, or unreadable
    }
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An anchor's text as the agent sent it: its placeholders filled in, for one the file holds with them. */
const sentText = (a: Anchor | undefined): string => (a ? (a.rendered ?? a.text) : '');

/** The texts a model call sends that a fix may rewrite: the system prompt and each tool's description. */
function surfacesOf(body: unknown): { system: string; tools: Array<{ name: string; description: string }>; surfaces: Surface[] } {
  const conv = isObject(body) ? normalizeConversation(body) : null;
  const leading: string[] = [];
  for (const t of conv?.turns ?? []) {
    if (t.role !== 'system') break;
    for (const b of t.blocks) if (b.type === 'text' && b.text.trim()) leading.push(b.text);
  }
  const tools: Array<{ name: string; description: string }> = [];
  if (isObject(body)) {
    for (const [name, def] of toolDefinitions(body)) {
      const d = isObject(def) ? def : {};
      const description = typeof d.description === 'string' ? d.description : '';
      tools.push({ name, description });
    }
  }
  const surfaces: Surface[] = [...leading.map((text) => ({ label: 'system prompt', text })), ...tools.filter((t) => t.description).map((t) => ({ label: `tool ${t.name}`, text: t.description }))];
  return { system: leading.join('\n\n'), tools, surfaces };
}

/** Everything a conversation says, for finding what is particular to a case. */
function conversationText(c: Conversation | null): string {
  return (c?.turns ?? [])
    .flatMap((t) => t.blocks.map((b) => (b.type === 'text' || b.type === 'thinking' ? b.text : b.type === 'tool_call' ? `${b.name} ${JSON.stringify(b.input ?? {})}` : b.type === 'tool_result' ? b.content : '')))
    .join('\n');
}

function requestAt(store: Store, runId: string, callNo: number): unknown {
  const call = store.getCalls(runId).find((c) => c.callNo === callNo);
  return call?.requestRef ? loadApiRequest(store, call.requestRef) : null;
}

/** A run's last model request and answer: what a good run shows the model, for telling a case detail from a rule. A judge check's is none of the agent's. */
function lastExchange(store: Store, runId: string): string {
  const calls = store.getCalls(runId).filter((c) => c.kind === 'api' && c.requestRef && !isJudgeCall(c));
  const last = calls.at(-1);
  if (!last?.requestRef) return '';
  const conv = normalizeConversation(loadApiRequest(store, last.requestRef));
  return `${conversationText(conv)}\n${describeBlocks(responseBlocks(store, last))}`;
}

/**
 * Runs as the repairer may see them: each copied, once, into a store in memory with the redaction
 * rules applied as `export html` applies them (a copy that is read, never replayed), so the path
 * rules reach what calls got back too. The project's store is never changed.
 */
function maskedView(store: Store, rules: Normalizer[]): { of: (...runIds: string[]) => Store; close: () => void } {
  const copy = Store.open(':memory:');
  const copied = new Set<string>();
  return {
    of: (...runIds) => {
      for (const id of runIds) {
        if (copied.has(id)) continue;
        redactRun(store, id, rules, copy, { read: true });
        copied.add(id);
      }
      return copy;
    },
    close: () => copy.close(),
  };
}

function runBuild(cmd: string, cwd: string): { ok: boolean; tail: string } {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-5).join('\n');
  return { ok: r.status === 0, tail };
}

interface Blamed {
  target: RepairTarget;
  /** What the repairer is shown of the run: masked by the project's redaction rules. */
  repairCase: RepairCase | null;
  /** What the run said where it was lost, as recorded: case details are looked for in it. */
  caseText?: string;
  /** The request at the blamed call, whose prompt a fix rewrites. */
  request: unknown;
  /** The same request with the redaction rules applied: the instructions the repairer is shown. */
  shownRequest?: unknown;
  /** The model the recording asked at the blamed call. */
  model: string | null;
  /**
   * For a run no model call rescued: what its blame found that says no answer of the model's lost
   * it (`notTheAnswer`), or null when it found nothing that says so.
   */
  notTheAnswer: string | null;
  /** Why its blame stopped part way, for one that did: the budget, a signal, a provider that stayed unavailable. */
  stopReason?: string | null;
}

/**
 * Why a repair had no rescue to learn from. When blame found, for every run it searched, that no
 * answer of the model's lost it (every attempt met a write's recorded error again, or the attempts
 * that passed answered as the recording did), it says that, as the fix's Blame step does: neither
 * a prompt fix nor a stronger model can help. When no run could be searched at all (each passed its
 * check when replayed, say), why not. When every search its first probe couldn't tell, that blame
 * did not settle it, which is no finding that nothing rescues a run. Otherwise, that nothing rescued
 * a run, and what to try.
 */
export function noDiagnosisWhy(blamed: ReadonlyArray<Pick<Blamed, 'target' | 'notTheAnswer'>>, stronger: string | null): string {
  const unrescued = blamed.filter((b) => b.target.outcome === 'unrescuable');
  const found = unrescued.map((b) => b.notTheAnswer);
  if (unrescued.length && found.every((f): f is string => f !== null)) {
    const said = new Set(found).size === 1 ? found[0]! : unrescued.map((b, i) => `${shortId(b.target.runId)}: ${found[i]!}`).join('; ');
    return `${said}: no answer of the model's lost ${unrescued.length === 1 ? 'the run' : 'these runs'}; look at the tools, the harness or the command`;
  }
  // A search that stopped part way (runRepair reports the repair as stopped) learned nothing either way.
  const searched = blamed.some((b) => b.target.outcome === 'unrescuable');
  const note = blamed.find((b) => b.target.note)?.target.note;
  if (!searched && note) return `no failing run could be blamed: ${note}`;
  if (unrescued.length && unrescued.every((b) => b.target.unsettled)) {
    const one = unrescued.length === 1;
    return `blame did not settle where ${one ? 'the failing run was' : 'the failing runs were'} lost: its first probe could not tell whether resampling rescues ${one ? 'it' : 'them'}, so there is no passing path to learn from yet; shadowlap blame ${unrescued.map((b) => shortId(b.target.runId)).join(' ')} says what settles it`;
  }
  return stronger
    ? `neither resampling nor ${stronger} rescued any failing run, so there is no passing path to learn from: the cause is likely in the code or the tools`
    : 'resampling rescued no failing run, so there is no passing path to learn from; try a stronger model with --stronger <model>, or look at the code and the tools';
}

/**
 * Runs a repair and hands it over, holding the folder's repair lock through both: `--apply` writes
 * the accepted change to the working tree, where another repair would otherwise try a candidate on
 * top of it, or verify one with it in place. A hand-over that fails part way throws a HandOverError
 * with the report as far as it got.
 */
export async function runRepair(input: RepairInput): Promise<RepairReport> {
  const cwd = process.cwd();
  const root = gitRoot(cwd);
  // A hand-over that can't work is refused before anything runs, not after the repair.
  if (input.outputs.branch && input.outputs.goldens) goldensInRepo(root, cwd, input.outputs.goldens);
  const { lock, restored } = startRepair(cwd);
  try {
    return handOver(await repairHere(input, cwd, root, restored), input);
  } finally {
    releaseLock(lock);
  }
}

/** The repair itself, holding the folder's repair lock. */
async function repairHere(input: RepairInput, cwd: string, root: string, restored: string[]): Promise<RepairReport> {
  const { settings: s, log } = input;
  for (const f of restored) log(p.yellow(`  ! restored ${relative(cwd, f)}, which an interrupted repair had left edited`));

  const config = loadConfig(cwd);
  // The repairer is a model of the user's choosing, often another machine's: what it is shown of a
  // run goes through the redaction rules first, as every export, pack and share link of a run does.
  let rules: Normalizer[];
  try {
    rules = config.redact;
  } catch (err) {
    throw new RepairError(err instanceof Error ? err.message : String(err));
  }
  const store = openStore(input.opts);
  const shown = rules.length ? maskedView(store, rules) : null;
  let interrupted = false;
  // A stop signal (Ctrl-C, SIGTERM, a closed terminal) stops a repairer that is still being asked,
  // as it stops verify's attempts, and the repair ends as interrupted.
  const asking = new AbortController();
  const onSignal = () => {
    interrupted = true;
    asking.abort();
  };
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);

  const oracle = oracleLabels(s.spec);
  const warnings: string[] = [];
  // A run that passes the check as recorded is no failing run: held out, it would join the fix as one.
  const holdout = input.holdout.filter((t) => {
    if (judgeRecording(store, t.parent, store.getCalls(t.parent.runId), s.spec, config.prices).passed !== true) return true;
    warnings.push(`${shortId(t.parent.runId)} passes the check as recorded, so it is not held out as a failing run`);
    return false;
  });
  // What judge checks' calls cost across blame and verify, apart from the agent's: the budget counts it too.
  const cost: { blame: number; repairer: number | null; verify: number; judge?: number } = { blame: 0, repairer: null, verify: 0 };
  const judgeSpent = (r: { judge?: { spent: number } | null }) => {
    if (r.judge?.spent) cost.judge = (cost.judge ?? 0) + r.judge.spent;
  };
  const spent = () => cost.blame + (cost.repairer ?? 0) + cost.verify + (cost.judge ?? 0);
  const budgetLeft = () => (s.budget === null ? null : s.budget - spent());
  const outOfBudget = () => {
    const left = budgetLeft();
    return left !== null && left <= 0;
  };
  const report: RepairReport = {
    outcome: 'not-fixed',
    why: null,
    targets: [],
    holdout: holdout.map((t) => t.parent.runId),
    good: input.good.map((t) => t.parent.runId),
    heldOutAutomatically: input.heldOutAutomatically,
    oracle,
    repairer: null,
    noRepairer: null,
    diagnosis: null,
    anchors: 0,
    candidates: [],
    accepted: null,
    patch: null,
    cost,
    writes: s.writes,
    output: { dir: null, patch: null, report: null, goldens: [], applied: false, branch: null, pr: null },
    warnings,
  };
  const blamed: Blamed[] = [];
  /** Each verified run's recorded requests, read once (recordedRequests), and whether linked files were said. */
  const requestsOf = new Map<string, Array<{ body: string; inputTokens: number }>>();
  let linkedSaid = false;
  /** Why verify stopped on a provider that stayed unavailable, once it did (`unavailableStop`): the repair tries nothing more. */
  let providerDown: string | null = null;
  /** Each candidate, and the edit it makes: where, the text it replaces, and that text as the agent sent it. */
  const candidates: Array<{ c: RepairCandidate; edit: { file: string; offset: number; text: string; sent: string } }> = [];
  // What a stopped repair found so far is still reported.
  const stopped = (why: string): RepairReport => ({ ...report, targets: blamed.map((b) => b.target), candidates: candidates.map((x) => x.c), outcome: 'stopped', why });

  const repairer: Repairer = { ...s.repairer, ...(config.repair?.baseUrl && !s.repairer.baseUrl ? { baseUrl: config.repair.baseUrl } : {}) };
  // Says why the repairer proposed nothing: in a few words for the fix's Repair step, and at length, with what to do, as a warning.
  const notAsked = (e: RepairerError) => {
    report.noRepairer = `${NO_REPAIRER.notAsked}: ${e.what}`;
    warnings.push(`${NO_REPAIRER.notAsked}: ${e.message}`);
  };

  try {
    // 0. A repairer that can't sign in is found out before blame spends anything. Only a fix that
    // needs no model (--stronger) is left to look for then; without one, there is nothing to blame for.
    const unaskable = s.repairerConfigured === false ? null : await cannotAsk(repairer);
    if (unaskable) log(`  ${p.yellow('!')} ${NO_REPAIRER.notAsked}: ${unaskable.message}${s.stronger ? `; only a switch to ${s.stronger} is looked for` : '; nothing is blamed'}`);
    if (unaskable && !s.stronger) {
      notAsked(unaskable);
      warnings.push('no failing run was blamed, as the repairer could not be asked, so nothing was spent: repair again once it can be');
      report.outcome = 'not-fixed';
      report.why = report.noRepairer ?? null;
      return report;
    }

    // 1. Where each failing run was lost, and a path from there that passed.
    for (const t of input.targets) {
      if (interrupted) return stopped('interrupted');
      if (outOfBudget()) return stopped(`the budget of $${s.budget!.toFixed(2)} is spent`);
      blamed.push(await blameOne(t, { ...(s.rescueFields ?? {}) }));
      const last = blamed.at(-1)!;
      // The provider stayed unavailable: nothing was found about this run, and no other run would fare
      // better now. The repair stops, inconclusive, with the provider named.
      if (unavailableStop(last.stopReason)) return stopped(last.stopReason!);
      if (last.target.outcome === 'unrescuable' && s.stronger) {
        log(`  resampling did not ${last.target.unsettled ? 'settle whether it rescues' : 'rescue'} ${shortId(t.parent.runId)}; trying ${s.stronger}`);
        const again = await blameOne(t, { ...(s.rescueFields ?? {}), model: s.stronger });
        if (unavailableStop(again.stopReason)) {
          blamed[blamed.length - 1] = again;
          return stopped(again.stopReason!);
        }
        if (again.target.outcome === 'blamed') blamed[blamed.length - 1] = { ...again, target: { ...again.target, rescuedBy: s.stronger } };
        // A search with the stronger model that stopped part way found nothing either way.
        else if (again.target.outcome === 'stopped') blamed[blamed.length - 1] = again;
      }
    }
    report.targets = blamed.map((b) => b.target);
    if (interrupted) return stopped('interrupted');
    const learned = blamed.filter((b) => b.repairCase);
    // A blame the budget or a signal stopped part way found neither a rescue nor that there is none.
    if (!learned.length && blamed.some((b) => b.target.outcome === 'stopped')) return stopped(outOfBudget() ? `the budget of $${s.budget!.toFixed(2)} is spent` : 'interrupted');
    if (!learned.length) {
      report.outcome = 'no-diagnosis';
      report.why = noDiagnosisWhy(blamed, s.stronger);
      return report;
    }

    // 2. What a fix may rewrite, where it lives, and what it must not mention.
    const files = projectFiles(root);
    const surfaces: Surface[] = [];
    for (const b of learned) {
      const found = surfacesOf(b.request);
      for (const x of found.surfaces) if (!surfaces.some((y) => y.label === x.label && y.text === x.text)) surfaces.push(x);
    }
    // The agent's instructions as the repairer is shown them: a system prompt can carry a run's own
    // details (a customer's name filled in), so it is read from the masked copy, while the spans a fix
    // may rewrite are the project's source.
    const instructions = surfacesOf(learned[0]!.shownRequest ?? learned[0]!.request);
    const anchors = findAnchors(surfaces, files);
    report.anchors = anchors.length;
    const failingTexts = learned.map((b) => b.caseText ?? '');
    const allowedTexts = [...surfaces.map((x) => x.text), ...input.good.map((g) => lastExchange(store, g.parent.runId))];
    const forbidden = forbiddenDetails(failingTexts, allowedTexts);

    let nextId = 1;

    // 3a. No model needed: when only a stronger model rescued the runs, the fix is to use it.
    const byStronger = learned.find((b) => b.target.rescuedBy && b.model);
    if (byStronger && s.stronger) {
      const from = byStronger.model!;
      const quoted = files.flatMap((f) => [`'${from}'`, `"${from}"`, `\`${from}\``].flatMap((q) => [...f.content.matchAll(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map((m) => ({ file: f.path, offset: m.index + 1 }))));
      if (quoted.length === 1) {
        const at = quoted[0]!;
        candidates.push({
          c: { id: nextId++, source: 'model', strategy: `Use ${s.stronger} instead of ${from}`, why: `Asking ${from} again did not rescue the failing runs; ${s.stronger} did.`, surface: 'model', file: at.file, offset: at.offset, before: from, after: s.stronger, size: editSize(from, s.stronger), state: 'untried', reason: null, verify: null },
          edit: { file: at.file, offset: at.offset, text: from, sent: from },
        });
      } else {
        warnings.push(`${s.stronger} rescued the runs, but the model name ${from} appears ${quoted.length ? `${quoted.length} times` : 'nowhere'} in the source as a string, so no model switch was proposed`);
      }
    }

    // 4. Try candidates smallest first. The first the gate accepts is verified again with fresh
    // attempts and kept only if it passes again: the first of several to pass is likelier than any one
    // to have passed by chance (repair-pick.ts), and no more than ⌊1/risk⌋ are decided.
    let accepted: { c: RepairCandidate; original: string; patched: string } | null = null;
    const picker = new CandidatePicker<(typeof candidates)[number]>(s.gate?.risk ?? null);
    const tryAll = async (list: typeof candidates): Promise<void> => {
      const ordered = [...list].filter((x) => x.c.state === 'untried').sort((a, b) => a.c.size - b.c.size || a.c.id - b.c.id);
      await picker.pick(ordered, {
        stopped: () => interrupted || outOfBudget() || !!providerDown,
        verify: async ({ c, edit }, again) => {
          if (again) log(`  ${p.dim(`verifying candidate ${c.id} again, with fresh attempts: it is kept only if it passes twice`)}`);
          else log(`\n  ${p.bold(`candidate ${c.id}`)} ${p.dim(`(${c.surface}, ${c.size} characters changed)`)}: ${c.after.length > 100 ? `${c.after.slice(0, 99)}…` : c.after}`);
          const before = c.verify;
          const result = await tryCandidate(c, edit);
          if (result && again) accepted = { c, ...result };
          else if (again) c.reason = `the gate accepted it, then not when it was verified again with fresh attempts: ${c.reason ?? 'it did not pass'}`;
          return result ? 'accepted' : c.verify !== before ? 'rejected' : 'undecided';
        },
      });
      const once = picker.unconfirmed?.c;
      if (once?.state === 'accepted') {
        once.state = 'incomplete';
        once.reason = 'the gate accepted it once, and the repair stopped before it could be verified again';
      }
      const left = list.filter((x) => x.c.state === 'untried');
      if (!picker.kept && !picker.open && s.gate && left.length) {
        const words = untriedWords(picker.most, s.gate.risk, left.length);
        for (const x of left) x.c.reason = words.reason;
        warnings.push(words.warning);
      }
    };
    await tryAll(candidates);

    // 3b. The repairer, when nothing cheaper worked.
    if (!accepted && !interrupted && !outOfBudget() && !providerDown) {
      if (s.repairerConfigured === false) {
        report.noRepairer = NO_REPAIRER.unconfigured;
        warnings.push(`${NO_REPAIRER.unconfigured}, so only fixes that need no model were tried: set one with --repairer anthropic, or repair.repairer in shadowlap.config.json`);
      } else if (!anchors.length) {
        report.noRepairer = NO_REPAIRER.nothingToRewrite;
        warnings.push(`${NO_REPAIRER.nothingToRewrite}: none of the system prompt or tool descriptions appears verbatim, exactly once, in the project's files`);
      } else if (unaskable) {
        notAsked(unaskable);
      } else {
        const request = buildRepairPrompt({ oracle, system: instructions.system, tools: instructions.tools, cases: learned.map((b) => b.repairCase!), anchors, candidates: s.candidates });
        // Its call counts against the budget like any other: it is asked only when what is left covers the most it could cost.
        const most = repairerMost(s.repairer, request, config.prices);
        const left = budgetLeft();
        if (left !== null && most !== null && most > left) return stopped(`asking the repairer could cost up to ${formatUsd(most)} (its prompt, and an answer of up to ${REPAIRER_ANSWER_TOKENS.toLocaleString('en-US')} tokens), more than the ${formatUsd(Math.max(left, 0))} left of the budget of $${s.budget!.toFixed(2)}, so it was not asked`);
        log(`\n  asking ${s.repairer.model ? `${s.repairer.provider}:${s.repairer.model}` : s.repairer.provider} for ${s.candidates} candidates (${anchors.length} spans it may rewrite; held-out runs are not shown to it)`);
        let answer: Awaited<ReturnType<typeof askRepairer>> | null = null;
        try {
          answer = await askRepairer(repairer, request, config.prices, { timeoutMs: s.repairerTimeoutMs ?? DEFAULT_REPAIRER_TIMEOUT_MS, signal: asking.signal });
        } catch (err) {
          // Whatever kept it from answering, the blames and the fix they opened are kept, with why.
          // Ctrl-C stopped it: the repair is stopped, which says so, not that the repairer could not be asked.
          if (!interrupted) notAsked(err instanceof RepairerError ? err : new RepairerError(safeLine((err instanceof Error ? err.message : String(err)).split('\n')[0]!).slice(0, 200) || 'it failed'));
        }
        if (answer) {
          cost.repairer = answer.cost;
          report.repairer = { provider: s.repairer.provider, model: s.repairer.model, served: answer.served, cost: answer.cost };
          report.diagnosis = answer.diagnosis || null;
          const fresh: typeof candidates = [];
          for (const e of answer.edits.slice(0, Math.max(s.candidates, 1) * 2)) {
            const anchor = anchors.find((a) => a.id === e.anchor);
            const check = checkEdit(e, anchors, forbidden);
            const after = e.replace.trim();
            const c: RepairCandidate = { id: nextId++, source: 'repairer', strategy: e.strategy, why: e.why, surface: anchor?.surface ?? `anchor ${e.anchor}`, file: anchor?.file ?? '', offset: anchor?.offset ?? 0, before: anchor?.text ?? '', after, size: anchor ? editSize(anchor.text, after) : 0, state: check.ok ? 'untried' : 'invalid', reason: check.ok ? null : check.reason, verify: null };
            if (!check.ok) log(`  ${p.yellow('✗')} candidate ${c.id} set aside: ${check.reason}`);
            fresh.push({ c, edit: { file: c.file, offset: anchor?.offset ?? 0, text: c.before, sent: sentText(anchor) } });
          }
          candidates.push(...fresh);
          await tryAll(fresh);
        }
      }
    }
    report.candidates = candidates.map((x) => x.c);

    if (!accepted) {
      if (interrupted) return stopped('interrupted');
      if (outOfBudget()) return stopped(`the budget of $${s.budget!.toFixed(2)} is spent`);
      // Verify stopped on a provider that stayed unavailable: no candidate was found wanting, and none was tried after.
      if (providerDown) return stopped(providerDown);
      report.outcome = 'not-fixed';
      const tried = candidates.filter((x) => x.c.state !== 'invalid' && x.c.state !== 'untried').length;
      // Rejected for their growth before verify ran them: no gate decided any of them.
      const grown = candidates.filter((x) => x.c.state === 'rejected' && !x.c.verify).length;
      // Never decided either: written into no worktree, or one verify could not finish, and why.
      const incomplete = candidates.filter((x) => x.c.state === 'incomplete');
      // With nothing to try, the repairer's silence is why: "the repairer could not be asked: claude was not found".
      report.why = !candidates.length
        ? (report.noRepairer ?? 'there was no candidate to try')
        : tried && grown === tried
          ? `${tried === 1 ? 'the one candidate' : `all ${tried} candidates`} that could be tried grew the input tokens per run past --max-growth ${+(s.maxGrowth * 100).toFixed(4)}% by ${tried === 1 ? 'its' : 'their'} rewrite alone, so verify ran none`
          : tried && incomplete.length === tried
            ? `${tried === 1 ? 'the one candidate tried could not be verified' : `none of the ${tried} candidates tried could be verified`}: ${incomplete[0]!.c.reason ?? 'verify did not finish'}`
            : tried
              ? `the gate accepted none of the ${tried} candidate${tried === 1 ? '' : 's'} tried`
              : 'no candidate could be tried';
      return report;
    }

    // 5. Hand it over: a patch and a report always; the change applied, a branch or a pull request on request.
    const won = accepted as { c: RepairCandidate; original: string; patched: string };
    report.outcome = 'fixed';
    report.accepted = won.c.id;
    report.patch = unifiedDiff(won.c.file, won.original, won.patched);
    return report;
  } finally {
    for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    shown?.close();
    store.close();
  }

  /** Blames one failing run, or reuses a blame stored on it under the same oracle and rescue. */
  async function blameOne(t: AttemptTarget, fields: Record<string, unknown>): Promise<Blamed> {
    const runId = t.parent.runId;
    const parentCalls = store.getCalls(runId);
    // The agent's model calls: a judge check's are none of blame's steps.
    const steps = parentCalls.filter((c) => c.kind === 'api' && c.end && inScope(c.meta.scope, s.scope) && !isJudgeCall(c)).map((c) => c.callNo);
    const base: RepairTarget = { runId, outcome: 'error', callNo: null, step: null, steps: steps.length, rescuedRunId: null, rescuedBy: null, reused: false, recorded: null, rescued: null, note: null };
    let callNo: number | null = null;
    let rescuedRunId: string | null = null;
    let failures: string[] = judgeRecording(store, t.parent, parentCalls, s.spec, config.prices).failures;

    const stored = store.getRun(runId)?.meta?.blame;
    // Only a blame kept with its fix is reused, so the repair has a fix to report to.
    const kept = store.blamesOfRun(runId).at(-1);
    const sameSearch = !!stored && !!kept && JSON.stringify(stored.oracle) === JSON.stringify(oracle) && JSON.stringify(stored.fields ?? {}) === JSON.stringify(fields) && (stored.scope ?? null) === (s.scope ?? null);
    // A search already made under the same oracle, rescue and scope is not made again, whatever it found.
    if (sameSearch && stored.outcome === 'unrescuable') {
      // What it found is kept whole with its fix: the same search, when the kept blame is the one on the run.
      const same = kept.outcome === 'unrescuable' && JSON.stringify(kept.report.oracle) === JSON.stringify(oracle) && JSON.stringify(kept.report.rescue?.fields ?? {}) === JSON.stringify(fields);
      // One whose first probe couldn't tell is not settled, which is no finding that no call rescues the run.
      const unsettled = stored.unsettled === true || (same && unsettledFirst(kept.report));
      log(`  ${shortId(runId)}: ${unrescuedWords(unsettled)}, from the blame already stored on it`);
      return { target: { ...base, outcome: 'unrescuable', ...(unsettled ? { unsettled: true } : {}), reused: true }, repairCase: null, request: null, model: null, notTheAnswer: same ? notTheAnswer(kept.report) : null };
    }
    const same = sameSearch && stored.outcome === 'blamed' && stored.callNo !== null && stored.rescuedRunId && store.getRun(stored.rescuedRunId);
    if (same) {
      callNo = stored.callNo;
      rescuedRunId = stored.rescuedRunId;
      log(`  ${shortId(runId)}: lost at model call #${callNo!}, from the blame already stored on it`);
      base.reused = true;
    } else {
      log(`  blaming ${shortId(runId)}${fields.model ? ` with ${String(fields.model)}` : ''}`);
      const left = budgetLeft();
      try {
        const r = await runBlame({
          opts: input.opts,
          parent: t.parent,
          argv: t.argv,
          commandFromImport: t.commandFromImport,
          // Blame's own gate decides its probes, as shadowlap blame's does without --gate.
          settings: { attempts: BLAME_DEFAULTS.max, needed: 0, gate: { kind: 'sprt', ...BLAME_DEFAULTS }, concurrency: s.concurrency, scan: 2, scope: s.scope ?? null, fields, writes: s.writes, reads: s.reads, liveTools: [], spec: s.spec, expect: s.expect, budget: left, timeoutMs: s.timeoutMs, guard: s.guard, ...(s.allowUnrecorded ? { allowUnrecorded: s.allowUnrecorded } : {}) },
          log: (line) => log(`  ${line}`),
        });
        cost.blame += r.spent;
        judgeSpent(r);
        failures = r.recordedFailures;
        if (r.outcome !== 'blamed' || !r.blamed || !r.contrast) return { target: { ...base, outcome: r.outcome === 'stopped' ? 'stopped' : 'unrescuable', ...(unsettledFirst(r) ? { unsettled: true } : {}) }, repairCase: null, request: null, model: null, notTheAnswer: r.outcome === 'stopped' ? null : notTheAnswer(r), ...(r.outcome === 'stopped' ? { stopReason: r.stopReason } : {}) };
        callNo = r.blamed.callNo;
        rescuedRunId = r.contrast.rescuedRunId;
      } catch (err) {
        if (!(err instanceof BlameError)) throw err;
        // What its judges cost before blame stopped counts all the same.
        if (err.judge) judgeSpent(err);
        // A run that passes its check when replayed is no failure: it isn't linked to the fix as one.
        return { target: { ...base, outcome: err.reason === 'passes' ? 'passes' : 'error', note: err.message.split('\n')[0]! }, repairCase: null, request: null, model: null, notTheAnswer: null };
      }
    }
    // The request as recorded, for the prompt a fix rewrites, which lives in the project's files; what
    // the repairer is shown of the run (the conversation, both answers, how it fails), with the rules applied.
    const request = requestAt(store, runId, callNo!);
    const exchange = (from: Store) => {
      const asked = requestAt(from, runId, callNo!);
      return {
        conversation: isObject(asked) ? normalizeConversation(asked) : null,
        recorded: responseBlocks(from, from.getCalls(runId).find((c) => c.callNo === callNo)),
        rescued: responseBlocks(from, from.getCalls(rescuedRunId!).find((c) => c.callNo === callNo)),
      };
    };
    const asRecorded = exchange(store);
    const view = shown ? shown.of(runId, rescuedRunId!) : store;
    const seen = view === store ? asRecorded : exchange(view);
    const target: RepairTarget = { ...base, outcome: 'blamed', callNo, step: steps.indexOf(callNo!) + 1, rescuedRunId, recorded: describeBlocks(seen.recorded), rescued: describeBlocks(seen.rescued) };
    return {
      target,
      repairCase: { step: target.step!, steps: steps.length, callNo: callNo!, ...seen, failures: failures.map((f) => rewriteText(f, rules)), rescuedBy: typeof fields.model === 'string' ? fields.model : null },
      // Case details are screened against the run as recorded: the check never leaves the machine.
      caseText: `${conversationText(asRecorded.conversation)}\n${describeBlocks(asRecorded.recorded)}`,
      request,
      shownRequest: view === store ? request : requestAt(view, runId, callNo!),
      model: asRecorded.conversation?.model ?? (isObject(request) && typeof request.model === 'string' ? request.model : null),
      notTheAnswer: null,
    };
  }

  /**
   * The recorded model requests of the runs a candidate is verified on, each as its body's JSON with
   * the input tokens it recorded: what a rewrite's growth is worked out against before anything runs.
   */
  function recordedRequests(runs: readonly AttemptTarget[]): Array<{ body: string; inputTokens: number }> {
    return runs.flatMap((t) => {
      let got = requestsOf.get(t.parent.runId);
      if (!got) {
        got = agentCallsOf(store.getCalls(t.parent.runId)).flatMap((c) => {
          const u = c.kind === 'api' ? c.end?.meta.usage : undefined;
          if (!u || !c.requestRef) return [];
          return [{ body: JSON.stringify(loadApiRequest(store, c.requestRef)), inputTokens: u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) }];
        });
        requestsOf.set(t.parent.runId, got);
      }
      return got;
    });
  }

  /**
   * Verifies a candidate, never in the working tree. Its rewrite alone is first held to --max-growth,
   * before anything is spent: a rewrite that already grows the recorded requests past it is rejected
   * without a replay. Then a worktree of the working tree as it is gets the edit and, with --build,
   * is built; verify replays every run there; and the worktree is removed, whatever came of it. A
   * good run's baseline runs the code without the candidate: that worktree as it was before the edit,
   * copied into one of its own when a good run first forks, and built the same way, so the two arms
   * differ by the candidate alone, whatever the working tree holds by then. Returns the file's two
   * versions when the gate accepts it.
   */
  async function tryCandidate(c: RepairCandidate, edit: { file: string; offset: number; text: string; sent: string }): Promise<{ original: string; patched: string } | null> {
    let original: string;
    try {
      original = readInside(physicalPath(root), edit.file);
    } catch (err) {
      c.state = 'invalid';
      c.reason = `${edit.file} can't be read as the repository's own file: ${safeLine((err as Error).message)}`;
      return null;
    }
    let patched: string;
    try {
      patched = applyEdit(original, edit, c.after);
    } catch (err) {
      c.state = 'invalid';
      c.reason = `${edit.file}: ${(err as Error).message}`;
      return null;
    }
    const role = (list: AttemptTarget[], r: VerifyRole) => list.map((t) => ({ ...t, role: r }));
    const runs = [...role(input.targets, 'target'), ...role(holdout, 'holdout'), ...role(input.good, 'good')];
    if (c.source === 'repairer') {
      const growth = rewriteGrowth(recordedRequests(runs), edit.sent, c.after.length - c.before.length);
      if (growth !== null && growth > s.maxGrowth) {
        c.state = 'rejected';
        c.reason = `${growthReason(growth, s.maxGrowth, `from the rewrite alone, at ${CHARS_PER_TOKEN} characters a token`)}, so it was not verified`;
        log(`  ${p.yellow('✗')} candidate ${c.id} rejected before it ran: ${c.reason}`);
        return null;
      }
    }
    let tree: ReturnType<typeof candidateTree>;
    try {
      tree = candidateTree(root, cwd, { build: !!s.build });
    } catch (err) {
      c.state = 'incomplete';
      c.reason = `the worktree to verify it in could not be made: ${safeLine(((err as { stderr?: Buffer }).stderr?.toString() || (err as Error).message).trim().split('\n')[0]!)}`;
      return null;
    }
    try {
      if (tree.linked.length && !linkedSaid) {
        linkedSaid = true;
        warnings.push(`${tree.linked.slice(0, 3).join(', ')}${tree.linked.length > 3 ? ` and ${tree.linked.length - 3} more` : ''}, which git ignores, ${tree.linked.length === 1 ? 'was' : 'were'} linked into the worktree candidates were verified in rather than copied, past the ${REPAIR_COPY_LIMIT_MB} MB copied: a --build that writes there writes the working tree's copy`);
      }
      // Written into the worktree's own file, never through a link out of it.
      try {
        writeInside(tree.root, edit.file, patched);
      } catch (err) {
        c.state = 'incomplete';
        c.reason = `the candidate could not be written into its worktree: ${safeLine((err as Error).message)}`;
        return null;
      }
      if (s.build) {
        const b = runBuild(s.build, tree.cwd);
        if (!b.ok) {
          c.state = 'build-failed';
          c.reason = `${s.build} failed: ${b.tail}`;
          return null;
        }
      }
      const candidate = tree;
      const withoutCandidate = (): BaseCheckout => {
        const plain = candidateTree(candidate.root, candidate.cwd, { build: !!s.build });
        try {
          writeInside(plain.root, edit.file, original);
          if (s.build) {
            const b = runBuild(s.build, plain.cwd);
            if (!b.ok) throw new Error(`${s.build} failed on the code without the candidate: ${b.tail.split('\n').at(-1) ?? ''}`);
          }
        } catch (err) {
          plain.remove();
          throw err;
        }
        // A run's command as verify is given it, pointed into the candidate's worktree, is pointed into this one.
        return BaseCheckout.of(plain.cwd, (argv) => plain.argv(argv), plain.remove);
      };
      const v = await runVerify({
        opts: input.opts,
        runs: runs.map((t) => ({ ...t, argv: tree.argv(t.argv) })),
        settings: { attempts: s.attempts, needed: s.needed, gate: s.gate, concurrency: s.concurrency, fields: {}, failFast: true, spec: s.spec, writes: s.writes, reads: s.reads, liveTools: [], budget: budgetLeft(), timeoutMs: s.timeoutMs, guard: s.guard, ...(s.allowUnrecorded ? { allowUnrecorded: s.allowUnrecorded } : {}), cwd: tree.cwd, baseCheckout: { label: 'the code without the candidate', open: withoutCandidate } },
        log: (line) => log(`  ${line}`),
      });
      cost.verify += v.spent;
      judgeSpent(v);
      c.verify = v;
      // The provider stayed unavailable for its runs: the candidate is neither accepted nor rejected for
      // it (verify left those runs inconclusive), and the repair tries no other until it answers.
      if (unavailableStop(v.stopReason)) providerDown = v.stopReason;
      if (v.verdict === 'rejected') {
        c.state = 'rejected';
        c.reason = v.reasons[0] ?? 'the gate rejected it';
        return null;
      }
      if (v.verdict === 'incomplete') {
        c.state = 'incomplete';
        c.reason = v.reasons.join('; ');
        return null;
      }
      const d = footprintDelta(v.runs);
      if (d && d.recorded.inputTokens > 0 && d.now.inputTokens > d.recorded.inputTokens * (1 + s.maxGrowth)) {
        c.state = 'rejected';
        c.reason = growthReason(d.now.inputTokens / d.recorded.inputTokens - 1, s.maxGrowth);
        return null;
      }
      c.state = 'accepted';
      log(`  ${p.green('✓')} candidate ${c.id} accepted`);
      return { original, patched };
    } finally {
      tree.remove();
    }
  }
}

/**
 * Writes what a repair produced: always a directory with the report (JSON and Markdown) and, for a
 * fix, the patch and a recording of every fixed run; then, on request, the change applied to the
 * working tree, committed to a branch, and opened as a pull request. When one of those requests
 * fails, report.json is still written and a HandOverError carries the report as far as it got.
 * Called holding the folder's repair lock.
 */
function handOver(report: RepairReport, input: Pick<RepairInput, 'opts' | 'outputs' | 'settings' | 'log'>): RepairReport {
  const cwd = process.cwd();
  const root = gitRoot(cwd);
  const id = `repair-${Date.now().toString(36)}`;
  const dir = join(cwd, '.shadowlap', 'repairs', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = report.output;
  // Paths in the report are relative to the folder repair ran in, with forward slashes on every
  // system: the report is kept in the store, which other machines read.
  const rel = (f: string) => relative(cwd, f).split(sep).join('/');
  out.dir = rel(dir);
  const accepted = report.candidates.find((c) => c.id === report.accepted) ?? null;

  // Verify replayed the working tree; a branch is HEAD with the fix. Tracked changes not committed are
  // in what was verified and not in what is committed: the report, the commit and the pull request say so.
  if (accepted && report.patch && input.outputs.branch) {
    const uncommitted = uncommittedFiles(root);
    if (uncommitted.length) {
      report.uncommitted = uncommitted;
      const named = uncommitted.length > 3 ? `${uncommitted.slice(0, 3).join(', ')} and ${uncommitted.length - 3} more` : uncommitted.join(', ');
      report.warnings.push(`the working tree has uncommitted changes to ${named}, which verify replayed and the branch ${input.outputs.branch} does not hold: it is HEAD with the fix. Commit them and repair again, or check that the branch passes without them`);
    }
  }

  if (accepted && report.patch) {
    writeFileSync(join(dir, 'fix.patch'), report.patch);
    out.patch = rel(join(dir, 'fix.patch'));
    // A recording of each fixed failing run, made by the fixed code: replayed by `shadowlap test`, it
    // fails the build if the fix is ever undone.
    const store = openStore(input.opts);
    const config = loadConfig(cwd);
    try {
      for (const run of accepted.verify?.runs ?? []) {
        if (run.role === 'good' || run.verdict !== 'pass') continue;
        const passing = run.attempts.find((a) => a.passed);
        if (!passing) continue;
        const target = join(dir, 'goldens', shortId(run.runId));
        packRun(store, passing.runId, target, { redact: config.redact });
        out.goldens.push(rel(target));
      }
    } finally {
      store.close();
    }
  }

  const md = repairMarkdown(report);
  writeFileSync(join(dir, 'report.md'), md);
  out.report = rel(join(dir, 'report.md'));

  let failed: RepairError | null = null;
  if (accepted && report.patch) {
    // `--goldens`, from the folder repair runs in, so an absolute path is that path.
    const goldens = input.outputs.goldens;
    const goldensDir = goldens ? resolve(cwd, goldens) : null;
    try {
      if (input.outputs.apply) {
        applyAccepted(report, root);
        out.applied = true;
        if (goldensDir) {
          try {
            for (const g of out.goldens) cpSync(join(cwd, g), join(goldensDir, basename(g)), { recursive: true });
          } catch (err) {
            throw new RepairError(`the fix is in the working tree, but copying its recordings to ${goldens!} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (input.settings.build) {
          const b = runBuild(input.settings.build, cwd);
          if (!b.ok) report.warnings.push(`${input.settings.build} failed after the fix was applied: ${b.tail}`);
        }
      }
      if (input.outputs.branch) {
        const inRepo = goldens ? goldensInRepo(root, cwd, goldens) : null;
        out.branch = commitBranch(root, input.outputs.branch, accepted, inRepo !== null ? out.goldens.map((g) => ({ from: join(cwd, g), to: join(inRepo, basename(g)) })) : [], commitMessage(report, accepted), dir);
        input.log(`  committed to ${out.branch}`);
        if (input.outputs.pr) out.pr = openPullRequest(root, out.branch, commitTitle(accepted), join(dir, 'report.md'));
      }
    } catch (err) {
      // Whatever stopped it, the repair ran and its verdict stands: it is kept, with where the hand-over stopped.
      failed = err instanceof RepairError ? err : new RepairError(err instanceof Error ? err.message : String(err));
      report.warnings.push(`handing the fix over stopped: ${failed.message}`);
    }
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (failed) throw new HandOverError(failed.message, report);
  return report;
}

/**
 * Puts the accepted candidate in the working tree: the only change a repair makes there, after every
 * candidate was verified in a worktree of its own. Its patch is checked first to be that candidate's
 * rewrite and nothing more (`repairPatchProblem`, as `shadowlap fix apply` checks a patch from the
 * store), and its text to be where it was found; otherwise nothing is written and it says why.
 */
export function applyAccepted(report: Pick<RepairReport, 'patch' | 'candidates' | 'accepted' | 'output'>, root: string): void {
  const accepted = report.candidates.find((c) => c.id === report.accepted);
  if (!accepted || !report.patch) throw new RepairError('there is no accepted candidate to apply');
  const problem = repairPatchProblem(report);
  if (problem) throw new RepairError(`the patch is not the accepted candidate's change (${problem}), so nothing was applied`);
  // The working tree's own file, never one a link in it names: a link would take the fix outside the repository.
  const real = physicalPath(root);
  let now: string;
  try {
    now = readInside(real, accepted.file);
  } catch (err) {
    throw new RepairError(`${accepted.file} can't be written as the repository's own file (${(err as Error).message}); apply ${report.output.patch ?? 'the patch'} by hand`);
  }
  if (now.slice(accepted.offset, accepted.offset + accepted.before.length) !== accepted.before) throw new RepairError(`${accepted.file} changed during the repair; apply ${report.output.patch ?? 'the patch'} by hand`);
  writeInside(real, accepted.file, applyEdit(now, { offset: accepted.offset, text: accepted.before }, accepted.after));
}

function commitMessage(r: RepairReport, c: RepairCandidate): string {
  const v = c.verify;
  const count = (role: VerifyRole) => v?.runs.filter((x) => x.role === role) ?? [];
  const pass = (role: VerifyRole) => count(role).filter((x) => x.verdict === 'pass').length;
  const lines = [commitTitle(c), ''];
  if (c.why.trim()) lines.push(c.why.trim(), '');
  lines.push(`The failing runs were lost at ${r.targets.filter((t) => t.callNo !== null).map((t) => `model call #${t.callNo!} of ${shortId(t.runId)}`).join(', ')}.`);
  if (v) lines.push(`Verified by replaying them under the change: fixes ${pass('target')} of ${count('target').length} target and ${pass('holdout')} of ${count('holdout').length} held-out failing runs, keeps ${pass('good')} of ${count('good').length} good runs, ${eachRun(v)}.`);
  if (r.uncommitted?.length) lines.push('', `The runs were replayed on a working tree with uncommitted changes to ${r.uncommitted.join(', ')}, which this commit does not hold: it is HEAD with the fix alone.`);
  return lines.join('\n') + '\n';
}

/** Tracked files whose working-tree content differs from HEAD's, staged or not, relative to the repository's root. */
function uncommittedFiles(root: string): string[] {
  try {
    return git(root, ['diff', '--name-only', '-z', 'HEAD', '--']).split('\0').filter(Boolean);
  } catch {
    return [];
  }
}


/** A commit on a new branch with the fix, made without checking anything out: HEAD and the working tree stay as they are. */
function commitBranch(root: string, name: string, c: RepairCandidate, extra: Array<{ from: string; to: string }>, message: string, scratch: string): string {
  try {
    git(root, ['check-ref-format', '--branch', name]);
  } catch {
    throw new RepairError(`"${name}" is not a valid branch name`);
  }
  let exists = true;
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  } catch {
    exists = false;
  }
  if (exists) throw new RepairError(`a branch named ${name} already exists`);
  let head: string;
  try {
    head = git(root, ['show', `HEAD:${c.file}`]);
  } catch {
    throw new RepairError(`${c.file} is not committed, so there is nothing to branch from; commit it, or apply the patch`);
  }
  // Where the working tree had it, when HEAD's file is the same there; otherwise the one place HEAD has it.
  let at = head.slice(c.offset, c.offset + c.before.length) === c.before ? c.offset : head.indexOf(c.before);
  if (at !== c.offset && (at < 0 || head.indexOf(c.before, at + 1) >= 0)) throw new RepairError(`${c.file} at HEAD does not hold the text the fix replaces exactly once; commit your changes to it first, or apply the patch`);
  at = Math.max(at, 0);
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  git(root, ['read-tree', 'HEAD'], { env });
  const mode = git(root, ['ls-tree', 'HEAD', '--', c.file]).split(/\s+/)[0] || '100644';
  const blob = git(root, ['hash-object', '-w', '--stdin'], { input: applyEdit(head, { offset: at, text: c.before }, c.after) }).trim();
  git(root, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${c.file}`], { env });
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  for (const x of extra) {
    for (const f of files(x.from)) {
      const b = git(root, ['hash-object', '-w', f]).trim();
      const to = `${x.to}/${relative(x.from, f)}`.split(/[\\/]+/).join('/');
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${b},${to}`], { env });
    }
  }
  const tree = git(root, ['write-tree'], { env }).trim();
  const commit = git(root, ['commit-tree', tree, '-p', 'HEAD', '-F', '-'], { input: message }).trim();
  git(root, ['update-ref', `refs/heads/${name}`, commit, '']);
  rmSync(join(scratch, 'index'), { force: true });
  return name;
}

function openPullRequest(root: string, branch: string, title: string, body: string): string {
  const base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (base === 'HEAD') throw new RepairError('HEAD is detached, so there is no branch to open the pull request against');
  try {
    git(root, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
  } catch (err) {
    throw new RepairError(`git push origin ${branch} failed: ${(err as { stderr?: Buffer }).stderr?.toString().trim() ?? (err as Error).message}`);
  }
  const r = spawnSync('gh', ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body-file', body], { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new RepairError(`gh pr create failed: ${(r.stderr || r.error?.message || '').trim()}; the branch ${branch} is pushed, so it can be opened by hand`);
  return r.stdout.trim().split('\n').at(-1) ?? '';
}

/** Splits failing runs into the ones the repairer sees and the ones held out from it: every other run, oldest first. */
export function splitHoldout<T extends { parent: RunRecord }>(runs: T[]): { targets: T[]; holdout: T[] } {
  const sorted = [...runs].sort((a, b) => a.parent.startedAt - b.parent.startedAt || a.parent.runId.localeCompare(b.parent.runId));
  return { targets: sorted.filter((_, i) => i % 2 === 0), holdout: sorted.filter((_, i) => i % 2 === 1) };
}

/**
 * Why a candidate was rejected for its footprint: `input tokens per run grow 30%, more than
 * --max-growth 25%`. Both as precise as they need to be, so a limit given as 0.5 reads 0.5%, and a
 * growth past it never reads as no more than it.
 */
export function growthReason(growth: number, maxGrowth: number, from?: string): string {
  const limit = +(maxGrowth * 100).toFixed(4);
  const whole = Math.round(growth * 100);
  return `input tokens per run grow ${whole > limit ? whole : +(growth * 100).toFixed(2)}%${from ? ` ${from}` : ''}, more than --max-growth ${limit}%`;
}
