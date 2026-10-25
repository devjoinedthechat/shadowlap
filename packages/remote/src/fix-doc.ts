import { canonicalize, FIX_STATUSES, repairPatchProblem, sha256, type FixData, type FixLink, type FixLinkKind, type FixStatus, type Store, type StoredBlame, type StoredFix, type StoredRepair, type StoredVerdict } from '@shadowlap/engine';
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
 * project for `git apply`, no more than the one rewrite its accepted candidate makes.
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
}

const FIX_ID = /^fx-[0-9A-HJKMNP-TV-Z]{26}$/;
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const BLAME_ID = /^bl-[0-9A-HJKMNP-TV-Z]{26}$/;
const VERDICT_ID = /^vf-[0-9A-HJKMNP-TV-Z]{26}$/;
const REPAIR_ID = /^repair-[0-9a-z]{1,40}$/;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} _.:/-]*$/u;
/** C0 and C1 control characters: never part of a name, and able to rewrite a terminal. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * The same, but for text that may run over lines, such as a model's answer in a report: a tab, a
 * line feed and a carriage return are allowed. A fix keeps its reports whole, so what else a model
 * wrote is sent as U+FFFD rather than refused by the teammate who pulls it.
 */
const CONTROL_IN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const CONTROL_IN_TEXT_ALL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const LINK_KINDS: readonly FixLinkKind[] = ['failing', 'good', 'blame', 'repair', 'verify'];
const STATUS_RANK: Record<FixStatus, number> = { open: 0, verified: 1, applied: 2 };
/** The most of each a fix document carries: far past any real failure, short of a bucket filled to stall a pull. */
const MAX = { links: 5000, records: 1000, labels: 50, items: 10_000 };

export const fixKey = (fixId: string) => `fixes/${fixId}.json`;
export const FIXES_PREFIX = 'fixes/';

export function isFixId(v: unknown): v is string {
  return typeof v === 'string' && FIX_ID.test(v);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
  if (!isObject(raw) || raw.format !== FIX_FORMAT) throw new LayoutError(`${where} isn't a Shadowlap fix`);
  if (raw.version !== FIX_VERSION) throw new LayoutError(`${where} is version ${String(raw.version)}; this Shadowlap reads version ${FIX_VERSION}. Update Shadowlap.`);
  checkStrings(raw, where);
  const f = raw.fix;
  obj({
    fixId: pattern(FIX_ID, 'a fix id'),
    title: line,
    labels: arr(pattern(LABEL, 'a label'), MAX.labels),
    check: obj({ expect: any, key: line, oracle: arr(str), text: str }),
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
  arr(obj({ blameId: pattern(BLAME_ID, 'a blame id'), runId, at: num, outcome: oneOf('blamed', 'unrescuable', 'stopped'), report: blameReport, expect: any, scope: nullable(line), command: str }), MAX.records)(raw.blames, `${where}.blames`);
  arr(obj({ verifyId: pattern(VERDICT_ID, 'a verdict id'), at: num, verdict: oneOf('accepted', 'rejected', 'incomplete'), repairId: nullable(pattern(REPAIR_ID, 'a repair id')), candidate: nullable(num), report: verifyReport, expect: any, command: str }), MAX.records)(raw.verdicts, `${where}.verdicts`);
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
    // A copy that says applied (an older Shadowlap sent it) is verified here.
    fix: sharedFix({ fixId: fix.fixId, title: fix.title, labels: [...fix.labels], check: fix.check, status: fix.status, openedAt: fix.openedAt, verifiedAt: fix.verifiedAt, appliedAt: fix.appliedAt, data: fix.data }),
    links,
    blames: (raw.blames as StoredBlame[]).filter((b) => named('blame').has(b.blameId)),
    verdicts: (raw.verdicts as StoredVerdict[]).filter((v) => named('verify').has(v.verifyId)),
    repairs: (raw.repairs as StoredRepair[]).filter((r) => named('repair').has(r.repairId)),
  };
}

// ---------------------------------------------------------------------------------------------- this machine's copy

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
export function fixDocOf(store: Store, fixId: string): FixDoc | null {
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
    blames: found(refs('blame').map((id) => store.getBlame(id))),
    verdicts: found(refs('verify').map((id) => store.getVerdict(id))),
    repairs: found(refs('repair').map((id) => store.getRepair(id))),
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
    }),
  );
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
 * stays. How either was applied is left out (`sharedFix`): the copy merged is the one that syncs.
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
  return {
    format: FIX_FORMAT,
    version: FIX_VERSION,
    fix: {
      fixId: a.fixId,
      title,
      labels,
      check: b.check,
      status,
      openedAt: Math.min(a.openedAt, b.openedAt),
      verifiedAt: status === 'open' ? null : minOf(a.verifiedAt, b.verifiedAt),
      appliedAt: null,
      data,
    },
    links: [...links.values()].sort((x, y) => x.at - y.at || (x.ref < y.ref ? -1 : 1)),
    blames: union(here.blames, there.blames, (x) => x.blameId).sort((x, y) => x.at - y.at),
    verdicts: union(here.verdicts, there.verdicts, (x) => x.verifyId).sort((x, y) => x.at - y.at),
    repairs: union(here.repairs, there.repairs, (x) => x.repairId).sort((x, y) => x.at - y.at),
  };
}

/**
 * Gives this machine the fix as merged: the fix made or brought up to it, every link added, every
 * report kept that isn't here yet. Nothing here is taken away, and a fix applied here stays applied:
 * that is this working tree's. Returns the repairs it added, whose files the CLI writes beside the
 * project (`.shadowlap/repairs/<id>/`); with `from` (the store it came from), each is marked as made
 * on another machine, where its recordings stayed.
 */
export function applyFixDoc(store: Store, doc: FixDoc, o: { from?: string; at?: number } = {}): { created: boolean; repairs: string[] } {
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
    for (const b of doc.blames) if (!store.getBlame(b.blameId)) store.putBlame(b);
    for (const v of doc.verdicts) if (!store.getVerdict(v.verifyId)) store.putVerdict(v);
    const repairs: string[] = [];
    for (const r of doc.repairs) {
      if (store.getRepair(r.repairId)) continue;
      store.putRepair(r);
      if (o.from) store.markRepairPulled(o.from, r.repairId, o.at);
      repairs.push(r.repairId);
    }
    for (const l of doc.links) store.addFixLink(fix.fixId, l.kind, l.ref, l.at, (l.data) ?? null);
    return { created: !here, repairs };
  }, 'immediate');
}

/** The document as written to the bucket. */
export function fixDocBytes(doc: FixDoc): Buffer {
  return Buffer.from(JSON.stringify(doc), 'utf8');
}
