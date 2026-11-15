import { canonicalize, checkKey, credentialFreeArgv, credentialFreeCommandLine, FIX_RUN_OUTCOMES, FIX_STATUSES, HIDDEN_IN_NAME, HIDDEN_IN_TEXT, isObject, repairPatchProblem, sha256, type FixCheckEntry, type FixData, type FixLink, type FixLinkKind, type FixStatus, type StepRerun, type StoreOf, type StoredBlame, type StoredFix, type StoredRepair, type StoredVerdict } from '@shadowlap/engine';
import { LayoutError } from './layout.js';

/**
 * A fix as the store keeps it: `fixes/<fx-id>.json`, one document per failure, holding the fix (its
 * title, labels, check and status), its links to runs and reports, and every blame, verdict and
 * repair report those links name, so a teammate's Fixes page shows its three steps without
 * running anything. Fixes only grow: a link or a report once made is never taken back, and a status
 * only moves on (open, then verified), so two machines' copies merge by joining them.
 *
 * Applied is not in it. A fix is applied in a working tree, and each machine has its own: a fix
 * applied on one is verified on the others, with its patch ready to apply there, until `fix apply`
 * there puts the patch in (or finds it in already, once the change came through git).
 *
 * Whatever comes from the bucket is someone else's data, checked as strictly as a run: every id in
 * its own form, every report in the shape the Fixes page reads, no string that could rewrite a
 * terminal (`shadowlap fix show` prints them), and a repair's patch, which a pull writes beside the
 * project for `git apply`, no more than the one rewrite its accepted candidate makes. Every blame
 * and verdict a pull brings is marked as pulled (`pulled`, kept on this machine only): the Fixes
 * page runs one again only from its checked fields, never with a teammate's `--build`, `--base` or
 * command after `--`, and only once the user says yes to the exact command line.
 *
 * What goes up holds no key the machine that made it typed: each report's command line, and the
 * flags kept beside a blame or a verdict, go with their credentials masked as a run's command line
 * goes (`shared`), whatever the store's copy held before.
 */

export const FIX_FORMAT = 'shadowlap-store-fix';
export const FIX_VERSION = 1;

export interface FixDoc {
  format: typeof FIX_FORMAT;
  version: typeof FIX_VERSION;
  fix: StoredFix;
  /** Its links, without the fix id each carries locally. */
  links: Array<Omit<FixLink, 'fixId'>>;
  blames: StoredBlame[];
  verdicts: StoredVerdict[];
  repairs: StoredRepair[];
  /**
   * Each check the fix has had, the first first, without the place each machine numbers it by
   * (historyOf). A document without them holds one: the fix's check, from when it was opened, by its
   * opener. A shadowlap from before they synced reads the document and drops them on its next push.
   */
  checks?: FixCheckEntry[];
}

const FIX_ID = /^fx-[0-9A-HJKMNP-TV-Z]{26}$/;
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const BLAME_ID = /^bl-[0-9A-HJKMNP-TV-Z]{26}$/;
const VERDICT_ID = /^vf-[0-9A-HJKMNP-TV-Z]{26}$/;
const REPAIR_ID = /^repair-[0-9a-z]{1,40}$/;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} _.:/-]*$/u;
/**
 * C0 and C1 control characters, format characters (a right-to-left override, a zero-width space:
 * Unicode's Cf) and line and paragraph separators (the engine's HIDDEN_IN_NAME): never part of a
 * name, able to rewrite a terminal or to disguise what a page or a question asking for a yes shows.
 */
const CONTROL = HIDDEN_IN_NAME;
/**
 * The same, but for text that may run over lines, such as a model's answer in a report: a tab, a
 * line feed and a carriage return are allowed (HIDDEN_IN_TEXT). A fix keeps its reports whole, so
 * what else a model wrote is sent as U+FFFD rather than refused by the teammate who pulls it. A
 * check holding one is refused where it is given (hiddenCharacter), since its copy would be another check.
 */
const CONTROL_IN_TEXT = HIDDEN_IN_TEXT;
const CONTROL_IN_TEXT_ALL = new RegExp(HIDDEN_IN_TEXT.source, 'gu');
const LINK_KINDS: readonly FixLinkKind[] = ['failing', 'good', 'blame', 'repair', 'verify'];
const STATUS_RANK: Record<FixStatus, number> = { open: 0, verified: 1, applied: 2 };
/** The most of each a fix document carries: far past any real failure, short of a bucket filled to stall a pull. */
const MAX = { links: 5000, records: 1000, labels: 50, items: 10_000 };

export const fixKey = (fixId: string) => `fixes/${fixId}.json`;
export const FIXES_PREFIX = 'fixes/';

export function isFixId(v: unknown): v is string {
  return typeof v === 'string' && FIX_ID.test(v);
}

// ---------------------------------------------------------------------------------------------- shapes

type Check = (v: unknown, where: string) => void;

function fail(where: string, what: string): never {
  throw new LayoutError(`${where}: ${what}`);
}

const str: Check = (v, w) => {
  if (typeof v !== 'string') fail(w, 'must be a string');
};
const line: Check = (v, w) => {
  if (typeof v !== 'string' || CONTROL.test(v) || v.length > 16_384) fail(w, 'must be one line of text');
};
const num: Check = (v, w) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(w, 'must be a number');
};
/** A number in a report: JSON keeps a NaN or an infinity as null, as this machine's own copy of it would. */
const amount: Check = (v, w) => {
  if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) fail(w, 'must be a number');
};
const bool: Check = (v, w) => {
  if (typeof v !== 'boolean') fail(w, 'must be true or false');
};
const any: Check = () => undefined;
const nullable =
  (c: Check): Check =>
  (v, w) => {
    if (v !== null) c(v, w);
  };
const optional =
  (c: Check): Check =>
  (v, w) => {
    if (v !== undefined) c(v, w);
  };
const oneOf =
  (...values: readonly unknown[]): Check =>
  (v, w) => {
    if (!values.includes(v)) fail(w, `must be one of ${values.map((x) => JSON.stringify(x)).join(', ')}`);
  };
const pattern =
  (re: RegExp, what: string): Check =>
  (v, w) => {
    if (typeof v !== 'string' || !re.test(v)) fail(w, `must be ${what}`);
  };
const runId = pattern(RUN_ID, 'a run id');
const arr =
  (c: Check, max = MAX.items): Check =>
  (v, w) => {
    if (!Array.isArray(v)) fail(w, 'must be a list');
    if (v.length > max) fail(w, `has more than ${max} entries`);
    v.forEach((x, i) => c(x, `${w}[${i}]`));
  };
const obj =
  (fields: Record<string, Check>): Check =>
  (v, w) => {
    if (!isObject(v)) fail(w, 'must be an object');
    for (const [k, c] of Object.entries(fields)) c(v[k], `${w}.${k}`);
  };
const record =
  (c: Check): Check =>
  (v, w) => {
    if (!isObject(v)) fail(w, 'must be an object');
    for (const [k, x] of Object.entries(v)) c(x, `${w}.${k}`);
  };

const footprint = obj({ inputTokens: amount, outputTokens: amount, cost: nullable(amount) });
/** A blame's or a verdict's flags (`StepRerun`): lists of strings, which only the Fixes page's own list of flags turns into a command. */
const rerun = optional(nullable(obj({ flags: arr(str, 400), command: optional(nullable(arr(str, 1000))) })));
const block = obj({ type: oneOf('text', 'thinking', 'tool_call') });
const blameAttempt = obj({ runId, passed: bool, exitCode: amount, failures: arr(str), spent: amount, upstreamRequests: amount });
/** A gate's decision after an attempt (engine stats.ts). */
const decision = oneOf('pass', 'fail', 'continue', 'inconclusive');
/** The gate a blame or a verify decided its probes or runs by: one between two pass rates. */
const sprtGate = obj({ kind: oneOf('sprt'), good: num, bad: num, risk: num, max: num });
/**
 * What a gate made of a probe's or a run's attempts, as the Fixes page and `fix show` read it: its
 * figures, its decision, the attempts, the pass rate's interval and its sentence.
 */
const gateResult: Check = (v, w) => {
  if (!isObject(v)) fail(w, 'must be an object');
  oneOf('sprt', 'baseline')(v.kind, `${w}.kind`);
  for (const k of v.kind === 'sprt' ? ['good', 'bad', 'risk', 'max'] : ['drop', 'risk', 'window', 'min']) num(v[k], `${w}.${k}`);
  obj({
    decision,
    passes: num,
    attempts: num,
    interval: obj({ lo: num, hi: num, confidence: num }),
    passK: optional(arr(obj({ k: num, value: num }), 64)),
    outcomes: optional(arr(bool)),
    evidence: optional(obj({ kind: oneOf('sprt', 'baseline') })),
    clean: optional(bool),
    carried: optional(num),
    sentence: line,
  })(v, w);
};
const blameProbe = obj({ callNo: amount, step: amount, attempts: arr(blameAttempt), passes: amount, rescued: bool, decision: optional(decision), gate: optional(nullable(gateResult)) });
const blameReport = obj({
  outcome: oneOf('blamed', 'unrescuable', 'stopped'),
  blamed: nullable(blameProbe),
  lost: nullable(blameProbe),
  probes: arr(blameProbe),
  nonMonotone: arr(obj({ lost: amount, rescued: amount })),
  confidence: oneOf('high', 'medium', 'low'),
  runId,
  steps: amount,
  attemptsPerProbe: amount,
  needed: amount,
  gate: optional(nullable(sprtGate)),
  rescue: obj({ fields: record(any) }),
  oracle: arr(str),
  recordedFailures: arr(str),
  contrast: nullable(obj({ callNo: amount, recorded: arr(block), rescued: arr(block), rescuedRunId: runId })),
  attempts: amount,
  spent: amount,
  upstreamRequests: amount,
  unknownModels: arr(str),
  stopReason: nullable(str),
  warnings: arr(str),
});
const verifyAttempt = obj({ runId, passed: bool, exitCode: amount, failures: arr(str), forkedAt: nullable(amount), spent: amount, upstreamRequests: amount, footprint });
const verifiedRun = obj({
  runId,
  role: oneOf('target', 'holdout', 'good'),
  attempts: arr(verifyAttempt),
  passes: amount,
  deterministic: bool,
  verdict: oneOf('pass', 'fail', 'open'),
  decision: optional(decision),
  gate: optional(nullable(gateResult)),
  recorded: obj({ passed: nullable(bool), failures: arr(str), footprint }),
});
const verifyReport = obj({
  verdict: oneOf('accepted', 'rejected', 'incomplete'),
  reasons: arr(str),
  warnings: arr(str),
  runs: arr(verifiedRun),
  attemptsPerRun: amount,
  needed: amount,
  gate: optional(nullable(sprtGate)),
  oracle: arr(str),
  fields: record(any),
  codeVersion: nullable(str),
  attempts: amount,
  spent: amount,
  upstreamRequests: amount,
  unknownModels: arr(str),
  stopReason: nullable(str),
  replayWarnings: arr(str),
});
const repairTarget = obj({
  runId,
  outcome: oneOf('blamed', 'unrescuable', 'stopped', 'error'),
  callNo: nullable(amount),
  step: nullable(amount),
  steps: amount,
  rescuedRunId: nullable(runId),
  rescuedBy: nullable(str),
  reused: bool,
  recorded: nullable(str),
  rescued: nullable(str),
  note: nullable(str),
});
const repairCandidate = obj({
  id: amount,
  source: oneOf('repairer', 'model'),
  strategy: str,
  why: str,
  surface: str,
  file: line,
  offset: amount,
  before: str,
  after: str,
  size: amount,
  state: oneOf('invalid', 'untried', 'build-failed', 'rejected', 'incomplete', 'accepted'),
  reason: nullable(str),
  verify: nullable(verifyReport),
});
const repairReport = obj({
  outcome: oneOf('fixed', 'not-fixed', 'no-diagnosis', 'stopped'),
  why: nullable(str),
  targets: arr(repairTarget),
  holdout: arr(runId),
  good: arr(runId),
  heldOutAutomatically: bool,
  oracle: arr(str),
  repairer: nullable(obj({ provider: line, model: line, served: nullable(line), cost: nullable(amount) })),
  // Why no repairer proposed candidates; a report from before it was kept has none.
  noRepairer: optional(nullable(line)),
  diagnosis: nullable(str),
  anchors: amount,
  candidates: arr(repairCandidate),
  accepted: nullable(amount),
  patch: nullable(str),
  cost: obj({ blame: amount, repairer: nullable(amount), verify: amount }),
  output: obj({ dir: nullable(line), patch: nullable(line), report: nullable(line), goldens: arr(line), applied: bool, branch: nullable(line), pr: nullable(line) }),
  warnings: arr(str),
});
/** How a check a fix was given judged its runs: run ids, each passed, failed, inconclusive or gone. */
const runOutcomes: Check = (v, w) => {
  record(oneOf(...FIX_RUN_OUTCOMES))(v, w);
  const ids = Object.keys(v as object);
  if (ids.length > MAX.links) fail(w, `holds more than ${MAX.links} runs`);
  for (const id of ids) runId(id, `${w}.${id}`);
};
const fixCheck = obj({ expect: any, key: line, oracle: arr(str), text: str });
const checkEntry = obj({ at: num, actor: nullable(line), check: fixCheck, judged: optional(nullable(obj({ failing: runOutcomes, good: runOutcomes }))) });

const standing = obj({ counts: bool, why: oneOf(null, 'another-check', 'already-passing', 'no-runs'), missing: optional(arr(str)) });
const fixData = obj({
  source: optional(obj({ ci: optional(pattern(/^[a-z][a-z0-9-]{0,31}$/, 'a CI provider')), pr: optional(obj({ url: line, number: nullable(num), state: optional(oneOf('open', 'merged', 'closed')), at: optional(num) })) })),
  openedBy: optional(nullable(line)),
  titleEdited: optional(bool),
  titleEditedAt: optional(num),
  applied: optional(
    obj({
      patch: oneOf('applied', 'already', 'none'),
      repairId: nullable(pattern(REPAIR_ID, 'a repair id')),
      goldens: arr(line),
      tests: oneOf('passed', 'failed', 'skipped'),
      by: optional(nullable(line)),
      via: optional(oneOf('fix apply', 'repair --apply')),
    }),
  ),
});

/** Every string in a value, its keys included, free of control characters but tabs and line breaks. */
function checkStrings(v: unknown, where: string, depth = 0): void {
  if (typeof v === 'string') {
    if (CONTROL_IN_TEXT.test(v)) fail(where, 'contains control characters');
    return;
  }
  if (v === null || typeof v !== 'object') return;
  if (depth > 40) fail(where, 'is nested too deeply');
  if (Array.isArray(v)) {
    v.forEach((x, i) => checkStrings(x, `${where}[${i}]`, depth + 1));
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    if (CONTROL.test(k)) fail(where, 'has a key with control characters');
    checkStrings(x, `${where}.${k}`, depth + 1);
  }
}

// ---------------------------------------------------------------------------------------------- reading one from the bucket

const REF_OF: Record<FixLinkKind, RegExp> = { failing: RUN_ID, good: RUN_ID, blame: BLAME_ID, verify: VERDICT_ID, repair: REPAIR_ID };

/**
 * Reads a fix document from the bucket and checks it whole: its fix, its links and the reports they
 * name. What a link names and the document doesn't hold is left out; a report no link names is
 * dropped. Throws a LayoutError naming the first thing wrong.
 */
export function parseFixDoc(bytes: Buffer, fixId: string): FixDoc {
  const where = fixKey(fixId);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new LayoutError(`${where} isn't JSON`);
  }
  if (!isObject(raw) || raw.format !== FIX_FORMAT) throw new LayoutError(`${where} isn't a shadowlap fix`);
  if (raw.version !== FIX_VERSION) throw new LayoutError(`${where} is version ${String(raw.version)}; this shadowlap reads version ${FIX_VERSION}. Update shadowlap.`);
  checkStrings(raw, where);
  const f = raw.fix;
  obj({
    fixId: pattern(FIX_ID, 'a fix id'),
    title: line,
    labels: arr(pattern(LABEL, 'a label'), MAX.labels),
    check: fixCheck,
    status: oneOf(...FIX_STATUSES),
    openedAt: num,
    verifiedAt: nullable(num),
    appliedAt: nullable(num),
    data: fixData,
  })(f, `${where}.fix`);
  const fix = f as StoredFix;
  if (fix.fixId !== fixId) throw new LayoutError(`${where} holds another fix (${fix.fixId})`);
  arr(
    (v, w) => {
      obj({ kind: oneOf(...LINK_KINDS), at: num, data: nullable(standing) })(v, w);
      const l = v as { kind: FixLinkKind; ref: unknown };
      pattern(REF_OF[l.kind], `a ${l.kind} reference`)(l.ref, `${w}.ref`);
    },
    MAX.links,
  )(raw.links, `${where}.links`);
  const links = (raw.links as Array<Omit<FixLink, 'fixId'>>).map((l) => ({ kind: l.kind, ref: l.ref, at: l.at, data: l.data ?? null }));
  const named = (kind: FixLinkKind) => new Set(links.filter((l) => l.kind === kind).map((l) => l.ref));
  arr(obj({ blameId: pattern(BLAME_ID, 'a blame id'), runId, at: num, outcome: oneOf('blamed', 'unrescuable', 'stopped'), report: blameReport, expect: any, scope: nullable(line), command: str, rerun }), MAX.records)(raw.blames, `${where}.blames`);
  arr(obj({ verifyId: pattern(VERDICT_ID, 'a verdict id'), at: num, verdict: oneOf('accepted', 'rejected', 'incomplete'), repairId: nullable(pattern(REPAIR_ID, 'a repair id')), candidate: nullable(num), report: verifyReport, expect: any, command: str, rerun }), MAX.records)(raw.verdicts, `${where}.verdicts`);
  arr(
    (v, w) => {
      obj({ repairId: pattern(REPAIR_ID, 'a repair id'), at: num, dir: line, outcome: oneOf('fixed', 'not-fixed', 'no-diagnosis', 'stopped'), accepted: bool, report: repairReport, expect: any, command: str })(v, w);
      // Where `shadowlap fix apply` reads the patch from: never a path a document chose.
      const r = v as StoredRepair;
      if (r.dir !== `.shadowlap/repairs/${r.repairId}`) fail(`${w}.dir`, `must be .shadowlap/repairs/${r.repairId}`);
      for (const g of r.report.output.goldens) if (!g.startsWith(`${r.dir}/goldens/`) || g.split('/').includes('..')) fail(`${w}.report.output.goldens`, `must be inside ${r.dir}/goldens/`);
      // What the pull writes to fix.patch, and `git apply` puts in: never more than the one rewrite the repair verified.
      const problem = repairPatchProblem(r.report);
      if (problem) fail(`${w}.report.patch`, `must be the change its accepted candidate makes, but ${problem}`);
    },
    MAX.records,
  )(raw.repairs, `${where}.repairs`);
  return {
    format: FIX_FORMAT,
    version: FIX_VERSION,
    // A copy that says applied (an older shadowlap sent it) is verified here.
    fix: sharedFix({ fixId: fix.fixId, title: fix.title, labels: [...fix.labels], check: fix.check, status: fix.status, openedAt: fix.openedAt, verifiedAt: fix.verifiedAt, appliedAt: fix.appliedAt, data: fix.data }),
    links,
    // Where a record came from is this machine's to say: a document never says it for it.
    blames: (raw.blames as StoredBlame[]).filter((b) => named('blame').has(b.blameId)).map(unmarked),
    verdicts: (raw.verdicts as StoredVerdict[]).filter((v) => named('verify').has(v.verifyId)).map(unmarked),
    repairs: (raw.repairs as StoredRepair[]).filter((r) => named('repair').has(r.repairId)),
    ...parsedChecks(raw.checks, where),
  };
}

/** A document's checks, checked, when it holds them: a document from before they synced has none. */
function parsedChecks(v: unknown, where: string): Pick<FixDoc, 'checks'> {
  if (v === undefined) return {};
  arr(checkEntry, MAX.records)(v, `${where}.checks`);
  const checks = (v as FixCheckEntry[]).map(entryOf);
  return checks.length ? { checks } : {};
}

const entryOf = (e: FixCheckEntry): FixCheckEntry => ({ at: e.at, actor: e.actor ?? null, check: e.check, judged: e.judged ?? null });

/** A copy's checks, the first first: one, the fix's check from when it was opened by its opener, for a document without them. */
export function historyOf(doc: Pick<FixDoc, 'fix' | 'checks'>): FixCheckEntry[] {
  return doc.checks?.length ? doc.checks.map(entryOf) : [{ at: doc.fix.openedAt, actor: doc.fix.data.openedBy ?? null, check: doc.fix.check, judged: null }];
}

const checkOrder = (x: FixCheckEntry, y: FixCheckEntry): number => x.at - y.at || (x.check.key < y.check.key ? -1 : x.check.key > y.check.key ? 1 : 0);

// ---------------------------------------------------------------------------------------------- this machine's copy

/** A blame or a verdict without the mark of where a pull brought it from, which stays on the machine that pulled it. */
function unmarked<T extends { pulled?: unknown }>(r: T): T {
  if (!('pulled' in r)) return r;
  const { pulled: _here, ...shared } = r;
  return shared as T;
}

/** A step's flags (`StepRerun`) with their credentials masked as a command line's are (credentialFreeArgv): a `--build` script's key, the command after `--`. */
function sharedRerun(rerun: StepRerun): StepRerun {
  // No program before the first flag, which is read as any other.
  const flags = ['', ...rerun.flags];
  const masked = credentialFreeArgv(flags);
  const command = rerun.command && credentialFreeArgv(rerun.command);
  if (masked === flags && command === rerun.command) return rerun;
  return { flags: masked === flags ? rerun.flags : masked.slice(1), command: command && [...command] };
}

/**
 * A blame, a verdict or a repair as it goes to the store: its command line (credentialFreeCommandLine)
 * and its flags (sharedRerun) with the credentials they carry masked, as every copy of a run's command
 * line has them. This machine keeps its flags as they ran, which Blame again and Verify again run
 * with; a teammate's are never run from a pull.
 */
function shared<T extends { command: string; rerun?: StepRerun | null }>(r: T): T {
  const command = credentialFreeCommandLine(r.command);
  const rerun = r.rerun ? sharedRerun(r.rerun) : r.rerun;
  return command === r.command && rerun === r.rerun ? r : { ...r, command, ...(rerun ? { rerun } : {}) };
}

/** A value with every string's control characters (but tabs and line breaks) as U+FFFD, keys included. */
function clean<T>(v: T, depth = 0): T {
  if (typeof v === 'string') return v.replace(CONTROL_IN_TEXT_ALL, '\uFFFD') as T;
  if (v === null || typeof v !== 'object' || depth > 40) return v;
  if (Array.isArray(v)) return (v as unknown[]).map((x) => clean(x, depth + 1)) as T;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(CONTROL_IN_TEXT_ALL, '\uFFFD'), clean(x, depth + 1)])) as T;
}

/**
 * A fix as it syncs: all of it but how it was applied, which belongs to a working tree. A fix
 * applied here goes as verified (when it was verified, it was by then), without `data.applied`.
 */
export function sharedFix(fix: StoredFix): StoredFix {
  const { applied: _here, ...data } = fix.data;
  if (fix.status !== 'applied') return { ...fix, appliedAt: null, data };
  return { ...fix, status: 'verified', verifiedAt: fix.verifiedAt ?? fix.appliedAt ?? fix.openedAt, appliedAt: null, data };
}

/**
 * A fix here as the store keeps it, or null when there is no such fix. Its reports go as they are,
 * but for control characters a model wrote (U+FFFD in their place), which a teammate's pull would
 * refuse; whether it is applied here stays here (`sharedFix`).
 */
export function fixDocOf(store: StoreOf<'fixes'>, fixId: string): FixDoc | null {
  const fix = store.getFix(fixId);
  if (!fix) return null;
  const links = store.fixLinks(fixId).map((l) => ({ kind: l.kind, ref: l.ref, at: l.at, data: l.data }));
  const refs = (kind: FixLinkKind) => links.filter((l) => l.kind === kind).map((l) => l.ref);
  const found = <T>(xs: Array<T | null>): T[] => xs.filter((x): x is T => x !== null);
  return clean({
    format: FIX_FORMAT,
    version: FIX_VERSION,
    fix: sharedFix(fix),
    links,
    blames: found(refs('blame').map((id) => store.getBlame(id))).map((b) => shared(unmarked(b))),
    verdicts: found(refs('verify').map((id) => store.getVerdict(id))).map((v) => shared(unmarked(v))),
    repairs: found(refs('repair').map((id) => store.getRepair(id))).map(shared),
    checks: store.fixChecks(fixId).map(({ at, actor, check, judged }) => ({ at, actor, check, judged })),
  });
}

/**
 * The hash of a fix as it syncs: what a push compares this machine's copy with. The order of links,
 * reports and labels aside, and when each machine made a link: each keeps its own first one.
 */
export function fixDocHash(doc: FixDoc): string {
  const byKey = <T>(xs: readonly T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return sha256(
    canonicalize({
      fix: { ...doc.fix, labels: [...doc.fix.labels].sort() },
      links: byKey(doc.links, (l) => `${l.kind}:${l.ref}`).map((l) => ({ kind: l.kind, ref: l.ref, data: l.data ?? null })),
      blames: byKey(doc.blames, (b) => b.blameId),
      verdicts: byKey(doc.verdicts, (v) => v.verifyId),
      repairs: byKey(doc.repairs, (r) => r.repairId),
      checks: historyOf(doc).sort(checkOrder),
    }),
  );
}

/**
 * Two copies' checks as one: every check either had, by when it was given, the store's (`there`)
 * last of two given at once, so the newest is the one the fix has. A fix verified keeps the check its
 * accepted verdict counted under, whichever copy changed it since: that check goes last, the same way
 * on every machine.
 */
function mergedChecks(here: FixDoc, there: FixDoc, status: FixStatus, verdicts: readonly StoredVerdict[], links: FixDoc['links']): FixCheckEntry[] {
  const theirs = historyOf(there);
  const known = new Set(theirs.map((e) => `${e.at}:${e.check.key}`));
  const all = [...historyOf(here).filter((e) => !known.has(`${e.at}:${e.check.key}`)), ...theirs].sort((x, y) => x.at - y.at);
  if (status === 'open') return all;
  const counted = new Set(links.filter((l) => l.kind === 'verify' && (l.data?.counts ?? true)).map((l) => l.ref));
  const accepted = verdicts.find((v) => v.verdict === 'accepted' && counted.has(v.verifyId));
  const key = accepted ? checkKey(accepted.expect ?? null) : null;
  let i = all.length - 1;
  while (i >= 0 && all[i]!.check.key !== key) i--;
  return i < 0 || i === all.length - 1 ? all : [...all.slice(0, i), ...all.slice(i + 1), all[i]!];
}

// ---------------------------------------------------------------------------------------------- merging two copies

const minOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** The pull request a fix came from: one whose state moved past open says more than one still open. */
function mergeSource(here: FixData['source'], there: FixData['source']): FixData['source'] {
  if (!here) return there;
  if (!there) return here;
  const pr = !here.pr ? there.pr : !there.pr ? here.pr : (there.pr.state ?? 'open') !== 'open' || (here.pr.state ?? 'open') === 'open' ? there.pr : here.pr;
  return { ...here, ...there, ...(pr ? { pr } : {}) };
}

/** When a copy's title was given, or null when it keeps the one it was opened with; 0 for a title given before the time was kept. */
const titleGivenAt = (data: FixData): number | null => (data.titleEdited ? (data.titleEditedAt ?? 0) : null);

/**
 * Two copies of a fix as one. A fix only grows, so they join: every link (the first made of each)
 * and every report, the labels of both, the status furthest along with the earliest time it got
 * there, and where it came from as far as either knows. A title someone gave it wins over the one
 * it was opened with, and of two given, the later rename (`titleEditedAt`), so a rename made since
 * the last sync wins over the title both copies agreed on; at the same time, the store's (`there`)
 * stays. How either was applied is left out (`sharedFix`): the copy merged is the one that syncs,
 * each of its reports with the credentials of its command line masked (`shared`), so a copy the
 * store held with a key in it goes back without it.
 */
export function mergeFixDocs(here: FixDoc, there: FixDoc): FixDoc {
  const a = sharedFix(here.fix);
  const b = sharedFix(there.fix);
  const givenHere = titleGivenAt(a.data);
  const givenThere = titleGivenAt(b.data);
  const ours = givenHere !== null && (givenThere === null || givenHere > givenThere);
  const title = ours ? a.title : b.title;
  const titleAt = ours ? givenHere : givenThere;
  const labels = [...new Set([...b.labels, ...a.labels])];
  const status = STATUS_RANK[a.status] > STATUS_RANK[b.status] ? a.status : b.status;
  const source = mergeSource(a.data.source, b.data.source);
  const data: FixData = {
    ...a.data,
    ...b.data,
    ...(source ? { source } : {}),
    ...(a.data.openedBy || b.data.openedBy ? { openedBy: b.data.openedBy ?? a.data.openedBy ?? null } : {}),
    ...(a.data.titleEdited || b.data.titleEdited ? { titleEdited: true } : {}),
    ...(titleAt ? { titleEditedAt: titleAt } : {}),
  };
  const links = new Map<string, Omit<FixLink, 'fixId'>>();
  for (const l of [...there.links, ...here.links]) {
    const key = `${l.kind}:${l.ref}`;
    const known = links.get(key);
    if (!known || l.at < known.at) links.set(key, l);
  }
  const union = <T>(xs: readonly T[], ys: readonly T[], id: (x: T) => string): T[] => {
    const out = new Map<string, T>();
    for (const x of [...ys, ...xs]) if (!out.has(id(x))) out.set(id(x), x);
    return [...out.values()];
  };
  const merged = [...links.values()].sort((x, y) => x.at - y.at || (x.ref < y.ref ? -1 : 1));
  const verdicts = union(here.verdicts, there.verdicts, (x) => x.verifyId).sort((x, y) => x.at - y.at);
  const checks = mergedChecks(here, there, status, verdicts, merged);
  return {
    format: FIX_FORMAT,
    version: FIX_VERSION,
    fix: {
      fixId: a.fixId,
      title,
      labels,
      check: checks.at(-1)!.check,
      status,
      openedAt: Math.min(a.openedAt, b.openedAt),
      verifiedAt: status === 'open' ? null : minOf(a.verifiedAt, b.verifiedAt),
      appliedAt: null,
      data,
    },
    links: merged,
    blames: union(here.blames, there.blames, (x) => x.blameId).sort((x, y) => x.at - y.at).map(shared),
    verdicts: verdicts.map(shared),
    repairs: union(here.repairs, there.repairs, (x) => x.repairId).sort((x, y) => x.at - y.at).map(shared),
    checks,
  };
}

/**
 * Gives this machine the fix as merged: the fix made or brought up to it, every link added, every
 * report kept that isn't here yet. Nothing here is taken away, and a fix applied here stays applied:
 * that is this working tree's. Returns the repairs it added, whose files the CLI writes beside the
 * project (`.shadowlap/repairs/<id>/`); with `from` (the store it came from), each is marked as made
 * on another machine, where its recordings stayed. Every blame and verdict it adds is marked as
 * pulled (`pulled`, from `from`): someone else's, which the Fixes page runs again only from checked
 * fields and with the user's yes.
 */
export function applyFixDoc(store: StoreOf<'fixes' | 'team'>, doc: FixDoc, o: { from?: string; at?: number } = {}): { created: boolean; repairs: string[] } {
  const fix = sharedFix(doc.fix);
  return store.transaction(() => {
    const here = store.getFix(fix.fixId);
    if (!here) store.insertFix(fix);
    else {
      const applied = here.status === 'applied';
      store.updateFix(fix.fixId, { title: fix.title, labels: fix.labels, status: applied ? 'applied' : fix.status, verifiedAt: fix.verifiedAt ?? here.verifiedAt, appliedAt: applied ? here.appliedAt : null });
      // The merged data whole: what this machine had is in it already, but how it was applied here.
      store.mergeFixData(fix.fixId, Object.fromEntries(Object.keys(here.data).map((k) => [k, null])));
      store.mergeFixData(fix.fixId, { ...fix.data, ...(here.data.applied ? { applied: here.data.applied } : {}) });
    }
    const pulled = { from: o.from ?? 'the team store', at: o.at ?? Date.now() };
    // Kept as a push sends them, a key a teammate's copy held masked (`shared`).
    for (const b of doc.blames) if (!store.getBlame(b.blameId)) store.putBlame({ ...shared(b), pulled });
    for (const v of doc.verdicts) if (!store.getVerdict(v.verifyId)) store.putVerdict({ ...shared(v), pulled });
    const repairs: string[] = [];
    for (const r of doc.repairs) {
      if (store.getRepair(r.repairId)) continue;
      store.putRepair(shared(r));
      if (o.from) store.markRepairPulled(o.from, r.repairId, o.at);
      repairs.push(r.repairId);
    }
    for (const l of doc.links) store.addFixLink(fix.fixId, l.kind, l.ref, l.at, (l.data) ?? null);
    // Its checks as merged, the newest the one it has.
    store.replaceFixChecks(fix.fixId, historyOf(doc));
    return { created: !here, repairs };
  }, 'immediate');
}

/** The document as written to the bucket. */
export function fixDocBytes(doc: FixDoc): Buffer {
  return Buffer.from(JSON.stringify(doc), 'utf8');
}
