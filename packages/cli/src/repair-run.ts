import { relative } from 'node:path';
import { agentCallsOf, applyEdit, BLAME_DEFAULTS, CHARS_PER_TOKEN, checkEdit, describeBlocks, editSize, findAnchors, footprintDelta, forbiddenDetails, formatUsd, isJudgeCall, isObject, loadApiRequest, lostWhere, messageOf, NO_REPAIRER, normalizeConversation, notTheAnswer, redactRun, releaseLock, repairNeverRewrites, rewriteGrowth, rewriteText, safeLine, Store, toolDefinitions, unavailableStop, unifiedDiff, unrescuedWords, unsettledFirst, type Anchor, type Conversation, type Normalizer, type RepairCandidate, type RepairRange, type RepairReport, type RepairTarget, type SourceFile, type StoreOf, type Surface, type VerifyRole } from '@shadowlap/engine';
import { STOP_SIGNALS } from './agent-signals.js';
import { judgeRecording, oracleLabels, type AttemptTarget } from './attempts.js';
import { BlameError, inScope, responseBlocks, runBlame } from './blame.js';
import { loadConfig } from './config.js';
import { physicalPath } from './real-path.js';
import { gitRoot, goldensInRepo, growthReason, handOver, noDiagnosisWhy, projectFiles, RepairError, repairerMost, repairerTurns, runBuild, startRepair, type RepairInput, type RepairSettings } from './repair.js';
import { CandidatePicker, untriedWords } from './repair-pick.js';
import { candidateTree, COPY_LIMIT, readInside, writeInside } from './repair-tree.js';
import { askRepairer, buildRepairPrompt, cannotAsk, DEFAULT_REPAIRER_TIMEOUT_MS, REPAIRER_ANSWER_TOKENS, RepairerError, type RepairCase, type Repairer } from './repairer.js';
import { openStore } from './shared.js';
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

/** What is copied of the files git ignores into a candidate's worktree, in MB, as a warning says it. */
const REPAIR_COPY_LIMIT_MB = COPY_LIMIT / 1024 / 1024;

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

function requestAt(store: StoreOf<'recording'>, runId: string, callNo: number): unknown {
  const call = store.getCalls(runId).find((c) => c.callNo === callNo);
  return call?.requestRef ? loadApiRequest(store, call.requestRef) : null;
}

/** A run's last model request and answer: what a good run shows the model, for telling a case detail from a rule. A judge check's is none of the agent's. */
function lastExchange(store: StoreOf<'recording'>, runId: string): string {
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
function maskedView(store: StoreOf<'recording'>, rules: Normalizer[]): { of: (...runIds: string[]) => Store; close: () => void } {
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
  const { lock, restored, ignored } = startRepair(cwd, root);
  try {
    return handOver(await repairHere(input, cwd, root, { restored, ignored }), input);
  } finally {
    releaseLock(lock);
  }
}

/** The repair itself, holding the folder's repair lock. */
async function repairHere(input: RepairInput, cwd: string, root: string, recovered: { restored: string[]; ignored: string | null }): Promise<RepairReport> {
  for (const f of recovered.restored) input.log(p.yellow(`  ! restored ${relative(cwd, f)}, which an interrupted repair had left edited`));
  if (recovered.ignored) input.log(p.yellow(`  ! .shadowlap/repair-journal.json is no interrupted repair's of this checkout, so nothing was restored from it: ${recovered.ignored}`));
  const config = loadConfig(cwd);
  // The repairer is a model of the user's choosing, often another machine's: what it is shown of a
  // run goes through the redaction rules first, as every export, pack and share link of a run does.
  let rules: Normalizer[];
  try {
    rules = config.redact;
  } catch (err) {
    throw new RepairError(messageOf(err));
  }
  const store = openStore(input.opts);
  const shown = rules.length ? maskedView(store, rules) : null;
  // A stop signal (Ctrl-C, SIGTERM, a closed terminal) stops a repairer that is still being asked,
  // as it stops verify's attempts, and the repair ends as interrupted.
  const asking = new AbortController();
  const onSignal = () => asking.abort();
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
  try {
    return await new RepairRun(input, { cwd, root, config, rules, store, shown, signal: asking.signal }).repair();
  } finally {
    for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    shown?.close();
    store.close();
  }
}

/** Where a repair runs and what it reads: the project, its config and store, and the signal that stops it. */
interface RepairEnv {
  cwd: string;
  /** The git repository's root, whose files a fix may rewrite. */
  root: string;
  config: ReturnType<typeof loadConfig>;
  /** The project's redaction rules, applied to all the repairer is shown. */
  rules: Normalizer[];
  store: Store;
  /** Runs as the repairer may see them (maskedView), when there are rules to apply. */
  shown: ReturnType<typeof maskedView> | null;
  /** Aborted by a stop signal: the repairer still being asked stops, and so does the repair. */
  signal: AbortSignal;
}

/** A candidate, and the edit it makes: where, the text it replaces, and that text as the agent sent it. */
interface Tried {
  c: RepairCandidate;
  edit: { file: string; offset: number; text: string; sent: string };
}

/** Where a run's blame found it lost: the call, the run that passed from there, and its failures as recorded, when blame read them again. */
interface Lost {
  callNo: number;
  rescuedRunId: string;
  range: RepairRange | null;
  failures?: string[];
}

/** What a fix may rewrite, where it lives, and what it must not mention. */
interface Rewritable {
  files: SourceFile[];
  /** The agent's instructions as the repairer is shown them. */
  instructions: ReturnType<typeof surfacesOf>;
  anchors: Anchor[];
  forbidden: Set<string>;
}

/**
 * One repair, step by step: blame each failing run (1), find what a fix may rewrite (2), propose
 * candidates, first one that needs no model (3a), then the repairer's (3b), and try them smallest
 * first (4), keeping the one the gate accepts twice (5). What the steps share is kept here: the
 * report as far as it got, what each stage spent, and why the repair stopped.
 */
/**
 * A candidate's rewrite on its progress line: the repairer model wrote it, so its escape sequences and
 * line breaks are shown as escapes rather than reaching the terminal, and it is cut at 100 characters.
 */
export function shownRewrite(after: string): string {
  const shown = safeLine(after);
  return shown.length > 100 ? `${shown.slice(0, 99)}…` : shown;
}

class RepairRun {
  private readonly s: RepairSettings;
  private readonly log: (line: string) => void;
  private readonly oracle: string[];
  private readonly warnings: string[] = [];
  /** The held-out runs that fail the check as recorded. */
  private readonly holdout: AttemptTarget[];
  private readonly cost: RepairReport['cost'] = { blame: 0, repairer: null, verify: 0 };
  private readonly report: RepairReport;
  private readonly repairer: Repairer;
  private readonly blamed: Blamed[] = [];
  private readonly candidates: Tried[] = [];
  private readonly picker: CandidatePicker<Tried>;
  /** Each verified run's recorded requests, read once (recordedRequests). */
  private readonly requestsOf = new Map<string, Array<{ body: string; inputTokens: number }>>();
  /** Whether linked files were said. */
  private linkedSaid = false;
  /** Why verify stopped on a provider that stayed unavailable, once it did (`unavailableStop`): the repair tries nothing more. */
  private providerDown: string | null = null;
  private nextId = 1;
  private accepted: { c: RepairCandidate; original: string; patched: string } | null = null;

  constructor(
    private readonly input: RepairInput,
    private readonly env: RepairEnv,
  ) {
    const { store, config } = env;
    const s = (this.s = input.settings);
    this.log = input.log;
    this.oracle = oracleLabels(s.spec);
    // A run that passes the check as recorded is no failing run: held out, it would join the fix as one.
    this.holdout = input.holdout.filter((t) => {
      if (judgeRecording(store, t.parent, store.getCalls(t.parent.runId), s.spec, config.prices).passed !== true) return true;
      this.warnings.push(`${shortId(t.parent.runId)} passes the check as recorded, so it is not held out as a failing run`);
      return false;
    });
    this.report = {
      outcome: 'not-fixed',
      why: null,
      targets: [],
      holdout: this.holdout.map((t) => t.parent.runId),
      good: input.good.map((t) => t.parent.runId),
      heldOutAutomatically: input.heldOutAutomatically,
      oracle: this.oracle,
      repairer: null,
      noRepairer: null,
      diagnosis: null,
      anchors: 0,
      candidates: [],
      accepted: null,
      patch: null,
      cost: this.cost,
      writes: s.writes,
      output: { dir: null, patch: null, report: null, goldens: [], applied: false, branch: null, pr: null },
      warnings: this.warnings,
    };
    this.repairer = { ...s.repairer, ...(config.repair?.baseUrl && !s.repairer.baseUrl ? { baseUrl: config.repair.baseUrl } : {}) };
    this.picker = new CandidatePicker<Tried>(s.gate?.risk ?? null);
  }

  private get interrupted(): boolean {
    return this.env.signal.aborted;
  }

  /** What judge checks' calls cost across blame and verify, apart from the agent's: the budget counts it too. */
  private judgeSpent(r: { judge?: { spent: number } | null }): void {
    if (r.judge?.spent) this.cost.judge = (this.cost.judge ?? 0) + r.judge.spent;
  }

  private budgetLeft(): number | null {
    const { cost } = this;
    return this.s.budget === null ? null : this.s.budget - (cost.blame + (cost.repairer ?? 0) + cost.verify + (cost.judge ?? 0));
  }

  private outOfBudget(): boolean {
    const left = this.budgetLeft();
    return left !== null && left <= 0;
  }

  private budgetSpent(): string {
    return `the budget of $${this.s.budget!.toFixed(2)} is spent`;
  }

  /** What a stopped repair found so far, which is still reported. */
  private stopped(why: string): RepairReport {
    return { ...this.report, targets: this.blamed.map((b) => b.target), candidates: this.candidates.map((x) => x.c), outcome: 'stopped', why };
  }

  /** Says why the repairer proposed nothing: in a few words for the fix's Repair step, and at length, with what to do, as a warning. */
  private notAsked(e: RepairerError): void {
    this.report.noRepairer = `${NO_REPAIRER.notAsked}: ${e.what}`;
    this.warnings.push(`${NO_REPAIRER.notAsked}: ${e.message}`);
  }

  async repair(): Promise<RepairReport> {
    const { s, report } = this;
    // 0. A repairer that can't sign in, or a Claude Code that can't run a repair, is found out before
    // blame spends anything. Only a fix that needs no model (--stronger) is left to look for then;
    // without one, there is nothing to blame for.
    const unaskable = s.repairerConfigured === false ? null : await cannotAsk(this.repairer, { signal: this.env.signal });
    if (this.interrupted) return this.stopped('interrupted');
    if (unaskable) this.log(`  ${p.yellow('!')} ${NO_REPAIRER.notAsked}: ${unaskable.message}${s.stronger ? `; only a switch to ${s.stronger} is looked for` : '; nothing is blamed'}`);
    if (unaskable && !s.stronger) {
      this.notAsked(unaskable);
      this.warnings.push('no failing run was blamed, as the repairer could not be asked, so nothing was spent: repair again once it can be');
      report.outcome = 'not-fixed';
      report.why = report.noRepairer ?? null;
      return report;
    }
    const blameStopped = await this.blameAll();
    if (blameStopped) return blameStopped;
    report.targets = this.blamed.map((b) => b.target);
    if (this.interrupted) return this.stopped('interrupted');
    const learned = this.blamed.filter((b) => b.repairCase);
    // A blame the budget or a signal stopped part way found neither a rescue nor that there is none.
    if (!learned.length && this.blamed.some((b) => b.target.outcome === 'stopped')) return this.stopped(this.outOfBudget() ? this.budgetSpent() : 'interrupted');
    if (!learned.length) {
      report.outcome = 'no-diagnosis';
      report.why = noDiagnosisWhy(this.blamed, s.stronger);
      return report;
    }
    const rewritable = this.rewritable(learned);
    this.strongerCandidate(learned, rewritable.files);
    await this.tryAll(this.candidates);
    if (!this.accepted && !this.interrupted && !this.outOfBudget() && !this.providerDown) {
      const askStopped = await this.repairerCandidates(learned, rewritable, unaskable);
      if (askStopped) return askStopped;
    }
    report.candidates = this.candidates.map((x) => x.c);
    if (!this.accepted) return this.notFixed();
    // 5. Hand it over: a patch and a report always; the change applied, a branch or a pull request on request.
    const won = this.accepted;
    report.outcome = 'fixed';
    report.accepted = won.c.id;
    report.patch = unifiedDiff(won.c.file, won.original, won.patched);
    return report;
  }

  /** 1. Where each failing run was lost, and a path from there that passed; the report when the repair stops there. */
  private async blameAll(): Promise<RepairReport | null> {
    for (const t of this.input.targets) {
      if (this.interrupted) return this.stopped('interrupted');
      if (this.outOfBudget()) return this.stopped(this.budgetSpent());
      const b = await this.blameRun(t);
      this.blamed.push(b);
      // The provider stayed unavailable: nothing was found about this run, and no other run would fare
      // better now. The repair stops, inconclusive, with the provider named.
      if (unavailableStop(b.stopReason)) return this.stopped(b.stopReason!);
    }
    return null;
  }

  /** A failing run blamed by resampling its model, and by the stronger model when that rescued nothing. */
  private async blameRun(t: AttemptTarget): Promise<Blamed> {
    const { s } = this;
    const first = await this.blameOne(t, { ...(s.rescueFields ?? {}) });
    if (unavailableStop(first.stopReason) || first.target.outcome !== 'unrescuable' || !s.stronger) return first;
    this.log(`  resampling did not ${first.target.unsettled ? 'settle whether it rescues' : 'rescue'} ${shortId(t.parent.runId)}; trying ${s.stronger}`);
    const again = await this.blameOne(t, { ...(s.rescueFields ?? {}), model: s.stronger });
    if (again.target.outcome === 'blamed') return { ...again, target: { ...again.target, rescuedBy: s.stronger } };
    // A search with the stronger model that stopped part way found nothing either way, as one the provider stopped did.
    return again.target.outcome === 'stopped' || unavailableStop(again.stopReason) ? again : first;
  }

  /** 2. What a fix may rewrite, where it lives, and what it must not mention. */
  private rewritable(learned: Blamed[]): Rewritable {
    const files = projectFiles(this.env.root);
    const surfaces: Surface[] = [];
    for (const b of learned) {
      for (const x of surfacesOf(b.request).surfaces) if (!surfaces.some((y) => y.label === x.label && y.text === x.text)) surfaces.push(x);
    }
    // The agent's instructions as the repairer is shown them: a system prompt can carry a run's own
    // details (a customer's name filled in), so it is read from the masked copy, while the spans a fix
    // may rewrite are the project's source.
    const instructions = surfacesOf(learned[0]!.shownRequest ?? learned[0]!.request);
    // A span a recording holds (a golden's run.json, its calls) or Shadowlap's config is no fix's to
    // rewrite: they are read, so a copy of a span there keeps it from passing for its source's only
    // one, but no anchor is placed in them (repairNeverRewrites, which a patch from the team store is
    // held to as well).
    const anchors = findAnchors(surfaces, files)
      .filter((a) => !repairNeverRewrites(a.file))
      .map((a, i) => ({ ...a, id: i + 1 }));
    this.report.anchors = anchors.length;
    const failingTexts = learned.map((b) => b.caseText ?? '');
    const allowedTexts = [...surfaces.map((x) => x.text), ...this.input.good.map((g) => lastExchange(this.env.store, g.parent.runId))];
    return { files, instructions, anchors, forbidden: forbiddenDetails(failingTexts, allowedTexts) };
  }

  /** 3a. No model needed: when only a stronger model rescued the runs, the fix is to use it. */
  private strongerCandidate(learned: Blamed[], files: SourceFile[]): void {
    const { s } = this;
    const byStronger = learned.find((b) => b.target.rescuedBy && b.model);
    if (!byStronger || !s.stronger) return;
    const from = byStronger.model!;
    const quoted = files.flatMap((f) => [`'${from}'`, `"${from}"`, `\`${from}\``].flatMap((q) => [...f.content.matchAll(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map((m) => ({ file: f.path, offset: m.index + 1 }))));
    if (quoted.length !== 1) {
      this.warnings.push(`${s.stronger} rescued the runs, but the model name ${from} appears ${quoted.length ? `${quoted.length} times` : 'nowhere'} in the source as a string, so no model switch was proposed`);
      return;
    }
    const at = quoted[0]!;
    this.candidates.push({
      c: { id: this.nextId++, source: 'model', strategy: `Use ${s.stronger} instead of ${from}`, why: `Asking ${from} again did not rescue the failing runs; ${s.stronger} did.`, surface: 'model', file: at.file, offset: at.offset, before: from, after: s.stronger, size: editSize(from, s.stronger), state: 'untried', reason: null, verify: null },
      edit: { file: at.file, offset: at.offset, text: from, sent: from },
    });
  }

  /**
   * 4. Tries candidates smallest first. The first the gate accepts is verified again with fresh
   * attempts and kept only if it passes again: the first of several to pass is likelier than any one
   * to have passed by chance (repair-pick.ts), and no more than ⌊1/risk⌋ are decided.
   */
  private async tryAll(list: Tried[]): Promise<void> {
    const { picker, s } = this;
    const ordered = [...list].filter((x) => x.c.state === 'untried').sort((a, b) => a.c.size - b.c.size || a.c.id - b.c.id);
    await picker.pick(ordered, {
      stopped: () => this.interrupted || this.outOfBudget() || !!this.providerDown,
      verify: async ({ c, edit }, again) => {
        if (again) this.log(`  ${p.dim(`verifying candidate ${c.id} again, with fresh attempts: it is kept only if it passes twice`)}`);
        else this.log(`\n  ${p.bold(`candidate ${c.id}`)} ${p.dim(`(${c.surface}, ${c.size} characters changed)`)}: ${shownRewrite(c.after)}`);
        const before = c.verify;
        const result = await this.tryCandidate(c, edit);
        if (result && again) this.accepted = { c, ...result };
        // Kept only once the second verify accepts it too: one that couldn't run (a write refused, a build that failed) is not.
        else if (again) c.reason = `the gate accepted it once, but ${c.state === 'rejected' ? 'not when it was verified again with fresh attempts' : 'it could not be verified again'}: ${c.reason ?? 'it did not pass'}`;
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
      this.warnings.push(words.warning);
    }
  }

  /** 3b. The repairer, when nothing cheaper worked: its candidates tried as the others were. The report when the budget can't cover asking it. */
  private async repairerCandidates(learned: Blamed[], w: Rewritable, unaskable: RepairerError | null): Promise<RepairReport | null> {
    const { s, report, warnings } = this;
    if (s.repairerConfigured === false) {
      report.noRepairer = NO_REPAIRER.unconfigured;
      warnings.push(`${NO_REPAIRER.unconfigured}, so only fixes that need no model were tried: set one with --repairer anthropic, or repair.repairer in shadowlap.config.json`);
      return null;
    }
    if (!w.anchors.length) {
      report.noRepairer = NO_REPAIRER.nothingToRewrite;
      warnings.push(`${NO_REPAIRER.nothingToRewrite}: none of the system prompt or tool descriptions appears verbatim, exactly once, in the project's files`);
      return null;
    }
    if (unaskable) {
      this.notAsked(unaskable);
      return null;
    }
    const request = buildRepairPrompt({ oracle: this.oracle, system: w.instructions.system, tools: w.instructions.tools, cases: learned.map((b) => b.repairCase!), anchors: w.anchors, candidates: s.candidates });
    // Its call counts against the budget like any other: it is asked only when what is left covers the most it could cost.
    const most = repairerMost(s.repairer, request, this.env.config.prices);
    const left = this.budgetLeft();
    if (left !== null && most !== null && most > left) return this.stopped(`asking the repairer could cost up to ${formatUsd(most)} (its prompt, and an answer of up to ${REPAIRER_ANSWER_TOKENS.toLocaleString('en-US')} tokens${repairerTurns(s.repairer) > 1 ? `, in each of its ${repairerTurns(s.repairer)} turns` : ''}), more than the ${formatUsd(Math.max(left, 0))} left of the budget of $${s.budget!.toFixed(2)}, so it was not asked`);
    this.log(`\n  asking ${s.repairer.model ? `${s.repairer.provider}:${s.repairer.model}` : s.repairer.provider} for ${s.candidates} candidates (${w.anchors.length} spans it may rewrite; held-out runs are not shown to it)`);
    let answer: Awaited<ReturnType<typeof askRepairer>> | null = null;
    try {
      answer = await askRepairer(this.repairer, request, this.env.config.prices, { timeoutMs: s.repairerTimeoutMs ?? DEFAULT_REPAIRER_TIMEOUT_MS, signal: this.env.signal });
    } catch (err) {
      // Whatever kept it from answering, the blames and the fix they opened are kept, with why.
      // Ctrl-C stopped it: the repair is stopped, which says so, not that the repairer could not be asked.
      if (!this.interrupted) this.notAsked(err instanceof RepairerError ? err : new RepairerError(safeLine(messageOf(err).split('\n')[0]!).slice(0, 200) || 'it failed'));
    }
    if (!answer) return null;
    this.cost.repairer = answer.cost;
    report.repairer = { provider: s.repairer.provider, model: s.repairer.model, served: answer.served, cost: answer.cost };
    report.diagnosis = answer.diagnosis || null;
    const fresh = answer.edits.slice(0, Math.max(s.candidates, 1) * 2).map((e) => this.proposed(e, w));
    this.candidates.push(...fresh);
    await this.tryAll(fresh);
    return null;
  }

  /** A candidate the repairer proposed, set aside with why when its edit breaks a rule (checkEdit). */
  private proposed(e: Awaited<ReturnType<typeof askRepairer>>['edits'][number], w: Rewritable): Tried {
    const anchor = w.anchors.find((a) => a.id === e.anchor);
    const check = checkEdit(e, w.anchors, w.forbidden);
    const after = e.replace.trim();
    const c: RepairCandidate = { id: this.nextId++, source: 'repairer', strategy: e.strategy, why: e.why, surface: anchor?.surface ?? `anchor ${e.anchor}`, file: anchor?.file ?? '', offset: anchor?.offset ?? 0, before: anchor?.text ?? '', after, size: anchor ? editSize(anchor.text, after) : 0, state: check.ok ? 'untried' : 'invalid', reason: check.ok ? null : check.reason, verify: null };
    if (!check.ok) this.log(`  ${p.yellow('✗')} candidate ${c.id} set aside: ${check.reason}`);
    return { c, edit: { file: c.file, offset: anchor?.offset ?? 0, text: c.before, sent: sentText(anchor) } };
  }

  /** The report of a repair the gate accepted no candidate of: stopped, when something stopped it, else why none was fixed. */
  private notFixed(): RepairReport {
    if (this.interrupted) return this.stopped('interrupted');
    if (this.outOfBudget()) return this.stopped(this.budgetSpent());
    // Verify stopped on a provider that stayed unavailable: no candidate was found wanting, and none was tried after.
    if (this.providerDown) return this.stopped(this.providerDown);
    this.report.outcome = 'not-fixed';
    this.report.why = notFixedWhy(this.candidates.map((x) => x.c), this.report.noRepairer ?? null, this.s.maxGrowth);
    return this.report;
  }

  /** Blames one failing run, or reuses a blame stored on it under the same oracle and rescue. */
  private async blameOne(t: AttemptTarget, fields: Record<string, unknown>): Promise<Blamed> {
    const { store, config } = this.env;
    const runId = t.parent.runId;
    const parentCalls = store.getCalls(runId);
    // The agent's model calls: a judge check's are none of blame's steps.
    const steps = parentCalls.filter((c) => c.kind === 'api' && c.end && inScope(c.meta.scope, this.s.scope) && !isJudgeCall(c)).map((c) => c.callNo);
    const base: RepairTarget = { runId, outcome: 'error', callNo: null, step: null, steps: steps.length, range: null, rescuedRunId: null, rescuedBy: null, reused: false, recorded: null, rescued: null, note: null };
    const found = this.storedBlame(runId, fields, base, steps) ?? (await this.freshBlame(t, fields, base, steps));
    if ('target' in found) return found;
    const failures = found.failures ?? judgeRecording(store, t.parent, parentCalls, this.s.spec, config.prices).failures;
    return this.blamedCase(runId, steps, base, fields, found, failures);
  }

  /**
   * A search already made under the same oracle, rescue and scope, which is not made again, whatever
   * it found: the run unrescued, or where it was lost. Null for none, or for one that blamed a run no
   * longer in the store. Only a blame kept with its fix is reused, so the repair has a fix to report to.
   */
  private storedBlame(runId: string, fields: Record<string, unknown>, base: RepairTarget, steps: number[]): Blamed | Lost | null {
    const { store } = this.env;
    const stored = store.getRun(runId)?.meta?.blame;
    const kept = store.blamesOfRun(runId).at(-1);
    if (!stored || !kept || JSON.stringify(stored.oracle) !== JSON.stringify(this.oracle) || JSON.stringify(stored.fields ?? {}) !== JSON.stringify(fields) || (stored.scope ?? null) !== (this.s.scope ?? null)) return null;
    if (stored.outcome === 'unrescuable') {
      // What it found is kept whole with its fix: the same search, when the kept blame is the one on the run.
      const same = kept.outcome === 'unrescuable' && JSON.stringify(kept.report.oracle) === JSON.stringify(this.oracle) && JSON.stringify(kept.report.rescue?.fields ?? {}) === JSON.stringify(fields);
      // One whose first probe couldn't tell is not settled, which is no finding that no call rescues the run.
      const unsettled = stored.unsettled === true || (same && unsettledFirst(kept.report));
      this.log(`  ${shortId(runId)}: ${unrescuedWords(unsettled)}, from the blame already stored on it`);
      return { target: { ...base, outcome: 'unrescuable', ...(unsettled ? { unsettled: true } : {}), reused: true }, repairCase: null, request: null, model: null, notTheAnswer: same ? notTheAnswer(kept.report) : null };
    }
    if (stored.outcome !== 'blamed' || stored.callNo === null || !stored.rescuedRunId || !store.getRun(stored.rescuedRunId)) return null;
    this.log(`  ${shortId(runId)}: lost ${lostWhere(stored.callNo, stored.range)}, from the blame already stored on it`);
    base.reused = true;
    return { callNo: stored.callNo, rescuedRunId: stored.rescuedRunId, range: rangeOf(stored.range, steps) };
  }

  /** A new blame of the run: where it was lost, or, for a run blame rescued nothing of, stopped on or could not run, the run as it ended up. */
  private async freshBlame(t: AttemptTarget, fields: Record<string, unknown>, base: RepairTarget, steps: number[]): Promise<Blamed | Lost> {
    const { s } = this;
    this.log(`  blaming ${shortId(t.parent.runId)}${fields.model ? ` with ${String(fields.model)}` : ''}`);
    const left = this.budgetLeft();
    try {
      const r = await runBlame({
        opts: this.input.opts,
        parent: t.parent,
        argv: t.argv,
        commandFromImport: t.commandFromImport,
        // Blame's own gate decides its probes, as shadowlap blame's does without --gate.
        settings: { attempts: BLAME_DEFAULTS.max, needed: 0, gate: { kind: 'sprt', ...BLAME_DEFAULTS }, concurrency: s.concurrency, scan: 2, scope: s.scope ?? null, fields, writes: s.writes, reads: s.reads, liveTools: [], spec: s.spec, expect: s.expect, budget: left, timeoutMs: s.timeoutMs, guard: s.guard, ...(s.allowUnrecorded ? { allowUnrecorded: s.allowUnrecorded } : {}) },
        log: (line) => this.log(`  ${line}`),
      });
      this.cost.blame += r.spent;
      this.judgeSpent(r);
      if (r.outcome !== 'blamed' || !r.blamed || !r.contrast) return { target: { ...base, outcome: r.outcome === 'stopped' ? 'stopped' : 'unrescuable', ...(unsettledFirst(r) ? { unsettled: true } : {}) }, repairCase: null, request: null, model: null, notTheAnswer: r.outcome === 'stopped' ? null : notTheAnswer(r), ...(r.outcome === 'stopped' ? { stopReason: r.stopReason } : {}) };
      return { callNo: r.blamed.callNo, rescuedRunId: r.contrast.rescuedRunId, range: rangeOf(r.range, steps), failures: r.recordedFailures };
    } catch (err) {
      if (!(err instanceof BlameError)) throw err;
      // What its judges cost before blame stopped counts all the same.
      if (err.judge) this.judgeSpent(err);
      // A run that passes its check when replayed is no failure: it isn't linked to the fix as one.
      return { target: { ...base, outcome: err.reason === 'passes' ? 'passes' : 'error', note: err.message.split('\n')[0]! }, repairCase: null, request: null, model: null, notTheAnswer: null };
    }
  }

  /**
   * A run blamed, as the repair uses it: the request as recorded, for the prompt a fix rewrites, which
   * lives in the project's files; what the repairer is shown of the run (the conversation, both
   * answers, how it fails), with the rules applied.
   */
  private blamedCase(runId: string, steps: number[], base: RepairTarget, fields: Record<string, unknown>, lost: Lost, failures: string[]): Blamed {
    const { store, shown, rules } = this.env;
    const { callNo, rescuedRunId, range } = lost;
    const request = requestAt(store, runId, callNo);
    const exchange = (from: StoreOf<'recording'>) => {
      const asked = requestAt(from, runId, callNo);
      return {
        conversation: isObject(asked) ? normalizeConversation(asked) : null,
        recorded: responseBlocks(from, from.getCalls(runId).find((c) => c.callNo === callNo)),
        rescued: responseBlocks(from, from.getCalls(rescuedRunId).find((c) => c.callNo === callNo)),
      };
    };
    const asRecorded = exchange(store);
    const view = shown ? shown.of(runId, rescuedRunId) : store;
    const seen = view === store ? asRecorded : exchange(view);
    const target: RepairTarget = { ...base, outcome: 'blamed', callNo, step: steps.indexOf(callNo) + 1, range, rescuedRunId, recorded: describeBlocks(seen.recorded), rescued: describeBlocks(seen.rescued) };
    return {
      target,
      repairCase: { step: target.step!, steps: steps.length, callNo, ...(range ? { range } : {}), ...seen, failures: failures.map((f) => rewriteText(f, rules)), rescuedBy: typeof fields.model === 'string' ? fields.model : null },
      // Case details are screened against the run as recorded: the check never leaves the machine.
      caseText: `${conversationText(asRecorded.conversation)}\n${describeBlocks(asRecorded.recorded)}`,
      request,
      shownRequest: view === store ? request : requestAt(view, runId, callNo),
      model: asRecorded.conversation?.model ?? (isObject(request) && typeof request.model === 'string' ? request.model : null),
      notTheAnswer: null,
    };
  }

  /**
   * The recorded model requests of the runs a candidate is verified on, each as its body's JSON with
   * the input tokens it recorded: what a rewrite's growth is worked out against before anything runs.
   */
  private recordedRequests(runs: readonly AttemptTarget[]): Array<{ body: string; inputTokens: number }> {
    const { store } = this.env;
    return runs.flatMap((t) => {
      let got = this.requestsOf.get(t.parent.runId);
      if (!got) {
        got = agentCallsOf(store.getCalls(t.parent.runId)).flatMap((c) => {
          const u = c.kind === 'api' ? c.end?.meta.usage : undefined;
          if (!u || !c.requestRef) return [];
          return [{ body: JSON.stringify(loadApiRequest(store, c.requestRef)), inputTokens: u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) }];
        });
        this.requestsOf.set(t.parent.runId, got);
      }
      return got;
    });
  }

  /**
   * Verifies a candidate, never in the working tree. Its rewrite alone is first held to --max-growth,
   * before anything is spent: a rewrite that already grows the recorded requests past it is rejected
   * without a replay. Then a worktree of the working tree as it is gets the edit and, with --build,
   * is built; verify replays every run there; and the worktree is removed, whatever came of it.
   * Returns the file's two versions when the gate accepts it.
   */
  private async tryCandidate(c: RepairCandidate, edit: Tried['edit']): Promise<{ original: string; patched: string } | null> {
    const versions = patchedFile(this.env.root, c, edit);
    if (!versions) return null;
    const role = (list: AttemptTarget[], r: VerifyRole) => list.map((t) => ({ ...t, role: r }));
    const runs = [...role(this.input.targets, 'target'), ...role(this.holdout, 'holdout'), ...role(this.input.good, 'good')];
    if (c.source === 'repairer') {
      const growth = rewriteGrowth(this.recordedRequests(runs), edit.sent, c.after.length - c.before.length);
      if (growth !== null && growth > this.s.maxGrowth) {
        c.state = 'rejected';
        c.reason = `${growthReason(growth, this.s.maxGrowth, `from the rewrite alone, at ${CHARS_PER_TOKEN} characters a token`)}, so it was not verified`;
        this.log(`  ${p.yellow('✗')} candidate ${c.id} rejected before it ran: ${c.reason}`);
        return null;
      }
    }
    let tree: ReturnType<typeof candidateTree>;
    try {
      tree = candidateTree(this.env.root, this.env.cwd, { build: !!this.s.build });
    } catch (err) {
      c.state = 'incomplete';
      c.reason = `the worktree to verify it in could not be made: ${safeLine(((err as { stderr?: Buffer }).stderr?.toString() || messageOf(err)).trim().split('\n')[0]!)}`;
      return null;
    }
    try {
      if (!this.prepared(tree, c, edit, versions.patched)) return null;
      return (await this.verifiedIn(tree, c, edit, versions.original, runs)) ? versions : null;
    } finally {
      tree.remove();
    }
  }

  /** The candidate written into its worktree, and built there with --build; false, with why on the candidate, when it can't be. */
  private prepared(tree: ReturnType<typeof candidateTree>, c: RepairCandidate, edit: Tried['edit'], patched: string): boolean {
    if (tree.linked.length && !this.linkedSaid) {
      this.linkedSaid = true;
      this.warnings.push(`${tree.linked.slice(0, 3).join(', ')}${tree.linked.length > 3 ? ` and ${tree.linked.length - 3} more` : ''}, which git ignores, ${tree.linked.length === 1 ? 'was' : 'were'} linked into the worktree candidates were verified in rather than copied, past the ${REPAIR_COPY_LIMIT_MB} MB copied: a --build that writes there writes the working tree's copy`);
    }
    // Written into the worktree's own file, never through a link out of it.
    try {
      writeInside(tree.root, edit.file, patched);
    } catch (err) {
      c.state = 'incomplete';
      c.reason = `the candidate could not be written into its worktree: ${safeLine(messageOf(err))}`;
      return false;
    }
    if (!this.s.build) return true;
    const b = runBuild(this.s.build, tree.cwd);
    if (b.ok) return true;
    c.state = 'build-failed';
    c.reason = `${this.s.build} failed: ${b.tail}`;
    return false;
  }

  /**
   * Whether the gate accepts the candidate, verify having replayed every run in its worktree. A good
   * run's baseline runs the code without the candidate: that worktree as it was before the edit,
   * copied into one of its own when a good run first forks, and built the same way, so the two arms
   * differ by the candidate alone, whatever the working tree holds by then.
   */
  private async verifiedIn(tree: ReturnType<typeof candidateTree>, c: RepairCandidate, edit: Tried['edit'], original: string, runs: Array<AttemptTarget & { role: VerifyRole }>): Promise<boolean> {
    const { s } = this;
    const withoutCandidate = (): BaseCheckout => {
      const plain = candidateTree(tree.root, tree.cwd, { build: !!s.build });
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
      opts: this.input.opts,
      runs: runs.map((t) => ({ ...t, argv: tree.argv(t.argv) })),
      settings: { attempts: s.attempts, needed: s.needed, gate: s.gate, concurrency: s.concurrency, fields: {}, failFast: true, spec: s.spec, writes: s.writes, reads: s.reads, liveTools: [], budget: this.budgetLeft(), timeoutMs: s.timeoutMs, guard: s.guard, ...(s.allowUnrecorded ? { allowUnrecorded: s.allowUnrecorded } : {}), cwd: tree.cwd, baseCheckout: { label: 'the code without the candidate', open: withoutCandidate } },
      log: (line) => this.log(`  ${line}`),
    });
    this.cost.verify += v.spent;
    this.judgeSpent(v);
    c.verify = v;
    // The provider stayed unavailable for its runs: the candidate is neither accepted nor rejected for
    // it (verify left those runs inconclusive), and the repair tries no other until it answers.
    if (unavailableStop(v.stopReason)) this.providerDown = v.stopReason;
    if (v.verdict === 'rejected') {
      c.state = 'rejected';
      c.reason = v.reasons[0] ?? 'the gate rejected it';
      return false;
    }
    if (v.verdict === 'incomplete') {
      c.state = 'incomplete';
      c.reason = v.reasons.join('; ');
      return false;
    }
    const d = footprintDelta(v.runs);
    if (d && d.recorded.inputTokens > 0 && d.now.inputTokens > d.recorded.inputTokens * (1 + s.maxGrowth)) {
      c.state = 'rejected';
      c.reason = growthReason(d.now.inputTokens / d.recorded.inputTokens - 1, s.maxGrowth);
      return false;
    }
    c.state = 'accepted';
    this.log(`  ${p.green('✓')} candidate ${c.id} accepted`);
    return true;
  }
}

/** The two calls a blame found a run lost between, when it pinned no one call: both of them among its model calls (`steps`). */
function rangeOf(range: { from?: unknown; to?: unknown; gradual?: unknown } | null | undefined, steps: readonly number[]): RepairRange | null {
  const from = range?.from;
  const to = range?.to;
  if (typeof from !== 'number' || typeof to !== 'number' || from === to || !steps.includes(from) || !steps.includes(to)) return null;
  return { from, to, fromStep: steps.indexOf(from) + 1, toStep: steps.indexOf(to) + 1, ...(range!.gradual === true ? { gradual: true as const } : {}) };
}

/** A candidate's file as the repository holds it, and with the candidate's edit; null, with why on the candidate, when either can't be had. */
function patchedFile(root: string, c: RepairCandidate, edit: Tried['edit']): { original: string; patched: string } | null {
  let original: string;
  try {
    original = readInside(physicalPath(root), edit.file);
  } catch (err) {
    c.state = 'invalid';
    c.reason = `${edit.file} can't be read as the repository's own file: ${safeLine(messageOf(err))}`;
    return null;
  }
  try {
    return { original, patched: applyEdit(original, edit, c.after) };
  } catch (err) {
    c.state = 'invalid';
    c.reason = `${edit.file}: ${messageOf(err)}`;
    return null;
  }
}

/**
 * Why a repair fixed nothing, from its candidates: with nothing to try, the repairer's silence ("the
 * repairer could not be asked: claude was not found"); every candidate rejected for its growth before
 * verify ran it, so no gate decided any; every one tried never decided, written into no worktree or
 * one verify could not finish, and why; else that the gate accepted none.
 */
function notFixedWhy(candidates: readonly RepairCandidate[], noRepairer: string | null, maxGrowth: number): string {
  if (!candidates.length) return noRepairer ?? 'there was no candidate to try';
  const tried = candidates.filter((c) => c.state !== 'invalid' && c.state !== 'untried').length;
  if (!tried) return 'no candidate could be tried';
  const grown = candidates.filter((c) => c.state === 'rejected' && !c.verify).length;
  if (grown === tried) return `${tried === 1 ? 'the one candidate' : `all ${tried} candidates`} that could be tried grew the input tokens per run past --max-growth ${+(maxGrowth * 100).toFixed(4)}% by ${tried === 1 ? 'its' : 'their'} rewrite alone, so verify ran none`;
  const incomplete = candidates.filter((c) => c.state === 'incomplete');
  if (incomplete.length === tried) return `${tried === 1 ? 'the one candidate tried could not be verified' : `none of the ${tried} candidates tried could be verified`}: ${incomplete[0]!.reason ?? 'verify did not finish'}`;
  return `the gate accepted none of the ${tried} candidate${tried === 1 ? '' : 's'} tried`;
}

