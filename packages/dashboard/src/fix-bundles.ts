import { fixLabelInfo, fixLinksOfRun, fixOfRun, keptAttemptVerdict, standingBasis, standingIn, pinWords, type AttemptVerdict, type StandingBasis, type RunRecord, type StoreOf, type StoredBlame, type StoredFix, type StoredRepair, type StoredVerdict, type VerifiedRun, type VerifyOutcome } from '@shadowlap/engine';
import { probeLine, runsRule, verifiedLine, type VerdictTone } from './verdict.js';
import { askedAgain, attemptNote, changeName, fixHref, ROLE, runHref, sprtGate, type VerifyRow } from './fix-shared.js';

/** The Forks view's bundles: blame's probes and verify's runs, each with the attempts that were made of it. */

export interface FixBundleAttempt {
  runId: string;
  passed: boolean;
  /** Passed, failed, or inconclusive: all it fell short on is a check that could not be decided, so it is neither. */
  verdict: AttemptVerdict;
  /** "passed", "issue_refund called", "passed · called escalate". */
  note: string;
  /** The fork blame rescued its run with: it shows as a fork of its own as well. */
  rescued: boolean;
  /** An attempt the provider was unavailable for: retried, never counted, so its probe's tally leaves it out. Absent otherwise. */
  unavailable?: true;
}

export interface FixBundle {
  /** Blame's attempts at one probed call, or verify's attempts at one run under one change. */
  kind: 'blame' | 'verify';
  /** Stays the same from one load to the next. */
  key: string;
  /** The run the attempts replayed: the bundle sits under it in the family. */
  parentRunId: string;
  /** `blame · probe #5`, `verify · target`; under a run several fixes share, with the fix's name: `verify · good · refund-bug`. */
  title: string;
  /** For a probe: the model call asked again; the one blame named is where the run was lost. */
  callNo: number | null;
  blamed: boolean;
  /**
   * For verify: the change it checked, named as the Verify step's switch names it (`changeName`), how it
   * came out, and the run's role. A good run's baseline attempts (`arm`) ran the code before the change.
   */
  change: string | null;
  verdict: VerifyOutcome | null;
  role: VerifyRow['role'] | null;
  /**
   * For a verdict: whether it counts for the fix the bundle leads to, as its Verify step's switch
   * says (false: "doesn't count"). Null for blame's attempts, a candidate a repair dropped (no
   * verdict of the fix's), and attempts no stored report names.
   */
  counts: boolean | null;
  passes: number;
  attempts: FixBundleAttempt[];
  spent: number;
  at: number;
  /**
   * Its verdict as every page says a gate's (decision 9): the word, the tally and the Wilson bound,
   * `rescued · 2 of 2 · rate >= 0.34 (95%)`, `fixed · 12 of 12 · rate >= 0.76 (95%)` (a fixed count
   * its tally alone), in its tone; null for attempts no stored report names.
   */
  verdictLine?: string | null;
  tone?: VerdictTone | null;
  /**
   * The rule it was decided by (`gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20
   * attempts`), which the Forks view states once in the family, under the first bundle it decided;
   * null with no stored report.
   */
  rule?: string | null;
  /**
   * Where it leads: the fix's Blame step for a probe, the verdict on the fix's Verify step, the
   * Repair step for a candidate a repair tried and dropped; the run itself when no fix holds it.
   */
  href: string;
  fixId: string | null;
  /** A good run's baseline attempts, the same run under the code before the change (`verify.arm`), bundled beside the change's and counted apart. Absent otherwise. */
  arm?: 'baseline';
}

/** Runs the dashboard reads in one family at most, as the lineage endpoint does. */
const FAMILY_LIMIT = 5000;

/** A run's family: its root recording and every run that descends from it. */
function familyOf(store: StoreOf<'recording'>, run: RunRecord): Map<string, RunRecord> {
  let root = run;
  const up = new Set([root.runId]);
  while (root.parentRunId) {
    const parent = store.getRun(root.parentRunId);
    if (!parent || up.has(parent.runId)) break;
    up.add(parent.runId);
    root = parent;
  }
  const family = new Map<string, RunRecord>();
  const queue = [root];
  while (queue.length && family.size < FAMILY_LIMIT) {
    const r = queue.shift()!;
    if (family.has(r.runId)) continue;
    family.set(r.runId, r);
    queue.push(...store.childRuns(r.runId));
  }
  return family;
}

/**
 * Every verdict and repair report, read once for each change to fixes: the store's `fixes` counter
 * moves whenever one is written, so a Forks view polled while nothing changes parses none again.
 */
const reportsRead = new WeakMap<object, { n: number; verdicts: StoredVerdict[]; repairs: StoredRepair[] }>();

function storedReports(store: StoreOf<'activity' | 'fixes'>): { verdicts: StoredVerdict[]; repairs: StoredRepair[] } {
  const n = store.changeCounts().fixes;
  const kept = reportsRead.get(store);
  if (kept && n !== undefined && kept.n === n) return kept;
  const read = { n: n ?? -1, verdicts: store.listVerdicts(), repairs: store.listRepairs() };
  if (n !== undefined) reportsRead.set(store, read);
  return read;
}

/**
 * The fix a blame's, verify's or repair's run leads to (`linkedFix`), and whether a verdict counts
 * for it under the check it has (`counts`, standingIn): each fix, each run's fixes and each fix's
 * standing basis read once per family, however many verdicts name them.
 */
function fixReads(store: StoreOf<'fixes'>) {
  const fixes = new Map<string, StoredFix | null>();
  const runFixes = new Map<string, Set<string>>();
  const bases = new Map<string, StandingBasis>();
  const fixOf = (fixId: string) => {
    if (!fixes.has(fixId)) fixes.set(fixId, store.getFix(fixId));
    return fixes.get(fixId)!;
  };
  /** The fixes a run takes part in, as a failing or a good run, but those it left. */
  const fixesOfRun = (runId: string) => {
    let of = runFixes.get(runId);
    if (!of) runFixes.set(runId, (of = new Set([...fixLinksOfRun(store, runId, 'failing'), ...fixLinksOfRun(store, runId, 'good')].map((l) => l.fixId))));
    return of;
  };
  return {
    linkedFix: (ref: string, kind: 'blame' | 'repair' | 'verify', runOf: string): StoredFix | null => {
      const linked = store.linksTo(ref, kind).map((l) => fixOf(l.fixId)).filter((f): f is StoredFix => f !== null);
      // A verdict shared by several fixes leads to the one the run takes part in.
      if (linked.length < 2) return linked[0] ?? null;
      const own = fixesOfRun(runOf);
      return linked.find((f) => own.has(f.fixId)) ?? linked[0]!;
    },
    counts: (fix: StoredFix, v: StoredVerdict): boolean => {
      let basis = bases.get(fix.fixId);
      if (!basis) bases.set(fix.fixId, (basis = standingBasis(store, fix)));
      return standingIn(store, fix, v, basis)?.counts ?? true;
    },
  };
}

/**
 * The attempts blame and verify made in a run's family, bundled per probe and per verified run, for
 * the Forks view: each bundle sits under the run its attempts replayed, says which probe blame named
 * (`blamed`) and how the change a verify checked came out, and links to the step of the fix it
 * belongs to. Attempts no stored report names (a blame made before fixes kept blames) are bundled
 * from the marks on the runs themselves. Null for a run that isn't in the store.
 */
export function fixBundles(store: StoreOf<'recording' | 'activity' | 'fixes'>, runId: string): FixBundle[] | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const family = familyOf(store, run);
  // Only attempts are bundled, so a family without one has no bundle and costs no more than its walk.
  const probed = new Set<string>();
  let checked = false;
  for (const r of family.values()) {
    if (r.meta?.probe && r.parentRunId) probed.add(r.parentRunId);
    if (r.meta?.verify) checked = true;
  }
  if (!probed.size && !checked) return [];
  const out: FixBundle[] = [];
  const bundled = new Set<string>();
  const exists = (id: string) => family.has(id);
  const startedAt = (ids: readonly string[], fallback: number) => Math.min(...ids.map((id) => family.get(id)?.startedAt ?? fallback), fallback);
  const reads = fixReads(store);
  const linkedFix = reads.linkedFix;

  out.push(...blameBundles(store, family, probed, { bundled, linkedFix }));

  // Verify: each verdict on a run in the family, and each candidate a repair tried and dropped (its
  // check is kept in the repair's report, not as a verdict), a bundle per run it replayed.
  const verified = (key: string, x: VerifiedRun, change: string, verdict: VerifyOutcome, counts: boolean | null, fix: StoredFix | null, href: string, at: number, rule: string) => {
    // A good run's baseline attempts ran the code before the change: a bundle of their own beside the change's.
    const base = (x.baselineRuns ?? []).filter((a) => exists(a.runId) && !bundled.has(a.runId));
    if (base.length) out.push(baselineBundle(`${key}:baseline`, x, base, { verdict, counts, href, at, fixId: fix?.fixId ?? null }, family, bundled));
    const attempts = x.attempts.filter((a) => exists(a.runId) && !bundled.has(a.runId));
    if (!attempts.length) return;
    for (const a of attempts) bundled.add(a.runId);
    const v = verifiedLine(x);
    out.push({
      kind: 'verify',
      key,
      parentRunId: x.runId,
      title: `verify · ${ROLE[x.role]}`,
      callNo: null,
      blamed: false,
      change,
      verdict,
      role: ROLE[x.role],
      counts,
      passes: attempts.filter((a) => a.passed).length,
      attempts: attempts.map((a) => ({ runId: a.runId, passed: a.passed, verdict: keptAttemptVerdict(a), note: attemptNote(a.passed, a.failures[0], family.get(a.runId), keptAttemptVerdict(a)), rescued: false })),
      spent: attempts.reduce((s2, a) => s2 + a.spent, 0),
      at: startedAt(attempts.map((a) => a.runId), at),
      verdictLine: v.line,
      tone: v.tone,
      rule,
      href,
      fixId: fix?.fixId ?? null,
    });
  };
  const inFamily = (runs: readonly VerifiedRun[]) => runs.filter((x) => exists(x.runId));
  const { verdicts, repairs } = checked ? storedReports(store) : { verdicts: [], repairs: [] };
  for (const v of verdicts) {
    for (const x of inFamily(v.report.runs)) {
      const fix = linkedFix(v.verifyId, 'verify', x.runId);
      const change = changeName(v);
      // Whether it counts for the fix it leads to, under the check the fix has, as its Verify step says.
      const counts = fix ? reads.counts(fix, v) : null;
      verified(`${v.verifyId}:${x.runId}`, x, change, v.verdict, counts, fix, fix ? fixHref(fix.fixId, 'verify', v.verifyId) : runHref(x.runId), v.at, runsRule({ gate: sprtGate(v.report.gate), needed: v.report.needed, attemptsPerRun: v.report.attemptsPerRun, kept: v.report.kept ?? null }, x));
    }
  }
  const kept = new Set(verdicts.flatMap((v) => (v.repairId !== null && v.candidate !== null ? [`${v.repairId}#${v.candidate}`] : [])));
  for (const r of repairs) {
    for (const c of r.report.candidates) {
      if (!c.verify || kept.has(`${r.repairId}#${c.id}`)) continue;
      for (const x of inFamily(c.verify.runs)) {
        const fix = linkedFix(r.repairId, 'repair', x.runId);
        verified(`${r.repairId}#${c.id}:${x.runId}`, x, `repair candidate ${c.id}`, c.verify.verdict, null, fix, fix ? fixHref(fix.fixId, 'repair') : runHref(x.runId), r.at, runsRule({ gate: sprtGate(c.verify.gate), needed: c.verify.needed, attemptsPerRun: c.verify.attemptsPerRun, kept: c.verify.kept ?? null }, x));
      }
    }
  }

  // Attempts that carry blame's or verify's mark but that no stored report names.
  const loose = new Map<string, { parent: RunRecord; kind: 'blame' | 'verify'; callNo: number | null; role: VerifyRow['role'] | null; runs: RunRecord[] }>();
  for (const r of family.values()) {
    if (bundled.has(r.runId) || !r.parentRunId || !family.has(r.parentRunId)) continue;
    const parent = family.get(r.parentRunId)!;
    const probe = r.meta?.probe;
    const check = r.meta?.verify;
    if (probe && typeof probe.callNo === 'number' && probe.of === parent.runId) {
      const key = `probe:${parent.runId}:${probe.callNo}`;
      const group = loose.get(key) ?? { parent, kind: 'blame' as const, callNo: probe.callNo, role: null, runs: [] };
      group.runs.push(r);
      loose.set(key, group);
    } else if (check && (check.role === 'target' || check.role === 'holdout' || check.role === 'good')) {
      const key = `verify:${parent.runId}:${check.role}`;
      const group = loose.get(key) ?? { parent, kind: 'verify' as const, callNo: null, role: ROLE[check.role], runs: [] };
      group.runs.push(r);
      loose.set(key, group);
    }
  }
  for (const [key, g] of loose) {
    const lost = g.parent.meta?.blame;
    const blamed = g.kind === 'blame' && lost?.outcome === 'blamed' && lost.callNo === g.callNo;
    const rescuedRunId = lost?.rescuedRunId ?? null;
    const fix = g.kind === 'blame' ? fixOfRun(store, g.parent.runId) : null;
    const passed = (r: RunRecord) => (g.kind === 'blame' ? r.meta?.probe?.passed === true : r.meta?.verify?.passed === true);
    const verdict = (r: RunRecord) => keptAttemptVerdict({ passed: passed(r), verdict: g.kind === 'blame' ? r.meta?.probe?.verdict : r.meta?.verify?.verdict });
    out.push({
      kind: g.kind,
      key,
      parentRunId: g.parent.runId,
      title: g.kind === 'blame' ? `blame · probe #${g.callNo!}` : `verify · ${g.role!}`,
      callNo: g.callNo,
      blamed,
      change: null,
      verdict: null,
      role: g.role,
      counts: null,
      passes: g.runs.filter(passed).length,
      attempts: g.runs.map((r) => ({ runId: r.runId, passed: passed(r), verdict: verdict(r), note: attemptNote(passed(r), undefined, r, verdict(r)), rescued: r.runId === rescuedRunId })),
      spent: 0,
      at: Math.min(...g.runs.map((r) => r.startedAt)),
      verdictLine: null,
      tone: null,
      rule: null,
      href: fix ? fixHref(fix.fixId, 'blame') : runHref(g.parent.runId, blamed ? g.callNo : null),
      fixId: fix?.fixId ?? null,
    });
  }
  nameSharedBundles(store, out);
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/**
 * Blame's bundles in a family: each blame of a run in it whose probes are here (they fork from the
 * run blamed), a bundle per probed call, and the check of the call the probes pinned. An attempt blame
 * marked the provider unavailable for is in no report's probe: it joins its probe's bundle, never
 * counted, rather than make a bundle of its own beside it. Each attempt it bundles goes in `bundled`.
 */
function blameBundles(store: StoreOf<'recording' | 'fixes'>, family: ReadonlyMap<string, RunRecord>, probed: ReadonlySet<string>, o: { bundled: Set<string>; linkedFix: ReturnType<typeof fixReads>['linkedFix'] }): FixBundle[] {
  const out: FixBundle[] = [];
  const { bundled, linkedFix } = o;
  const exists = (id: string) => family.has(id);
  const startedAt = (ids: readonly string[], fallback: number) => Math.min(...ids.map((id) => family.get(id)?.startedAt ?? fallback), fallback);
  const unavailable = unavailableProbes(family);
  for (const id of probed) {
    const r = family.get(id);
    if (!r || r.meta?.probe || r.meta?.verify) continue;
    for (const b of store.blamesOfRun(r.runId)) {
      const fix = linkedFix(b.blameId, 'blame', r.runId) ?? fixOfRun(store, r.runId);
      const rescuedRunId = b.report.contrast?.rescuedRunId ?? null;
      const rescuedNote = b.report.contrast ? `passed · ${askedAgain(b.report.contrast.rescued)}` : 'passed';
      const blamedCall = b.outcome === 'blamed' ? (b.report.blamed?.callNo ?? null) : null;
      for (const p of b.report.probes) {
        const attempts = p.attempts.filter((a) => exists(a.runId));
        const down = (unavailable.get(`${r.runId}:${p.callNo}`) ?? []).filter((x) => !bundled.has(x.runId));
        if (!attempts.length && !down.length) continue;
        for (const a of [...attempts, ...down]) bundled.add(a.runId);
        const v = probeLine(p, b.report);
        out.push({
          kind: 'blame',
          key: `${b.blameId}:${p.callNo}`,
          parentRunId: r.runId,
          title: `blame · probe #${p.callNo}`,
          callNo: p.callNo,
          blamed: p.callNo === blamedCall,
          change: null,
          verdict: null,
          role: null,
          counts: null,
          passes: attempts.filter((a) => a.passed).length,
          attempts: [...attempts.map((a) => ({ runId: a.runId, passed: a.passed, verdict: keptAttemptVerdict(a), note: a.passed && a.runId === rescuedRunId ? rescuedNote : attemptNote(a.passed, a.failures[0], family.get(a.runId), keptAttemptVerdict(a)), rescued: a.runId === rescuedRunId })), ...down.map(unavailableAttempt)],
          spent: attempts.reduce((s2, a) => s2 + a.spent, 0),
          at: startedAt([...attempts, ...down].map((a) => a.runId), b.at),
          verdictLine: v.line,
          tone: v.tone,
          rule: v.rule,
          href: fix ? fixHref(fix.fixId, 'blame') : runHref(r.runId, blamedCall),
          fixId: fix?.fixId ?? null,
        });
      }
      // The check of the call the probes pinned: its pairs, both calls' attempts, as one bundle.
      const pinned = pinBundle(b, r.runId, family, { bundled, fixId: fix?.fixId ?? null, blamedCall });
      if (pinned) out.push(pinned);
    }
  }
  return out;
}

/** The check of the call a blame's probes pinned, as one bundle: its pairs, both calls' attempts, those in the family; null with none there. */
function pinBundle(b: StoredBlame, runId: string, family: ReadonlyMap<string, RunRecord>, o: { bundled: Set<string>; fixId: string | null; blamedCall: number | null }): FixBundle | null {
  const check = b.report.pin;
  const checked = check ? check.pairs.flatMap((x) => [x.at, x.next]).filter((a) => family.has(a.runId)) : [];
  if (!check || !checked.length) return null;
  for (const a of checked) o.bundled.add(a.runId);
  return {
    kind: 'blame',
    key: `${b.blameId}:check`,
    parentRunId: runId,
    title: `blame · check of #${check.callNo}`,
    callNo: check.callNo,
    blamed: false,
    change: null,
    verdict: null,
    role: null,
    counts: null,
    passes: checked.filter((a) => a.passed).length,
    attempts: checked.map((a) => ({ runId: a.runId, passed: a.passed, verdict: keptAttemptVerdict(a), note: attemptNote(a.passed, a.failures[0], family.get(a.runId), keptAttemptVerdict(a)), rescued: false })),
    spent: checked.reduce((s2, a) => s2 + a.spent, 0),
    at: Math.min(...checked.map((a) => family.get(a.runId)?.startedAt ?? b.at), b.at),
    verdictLine: pinWords(check),
    tone: check.verdict === 'pinned' ? 'ok' : 'y',
    rule: null,
    href: o.fixId ? fixHref(o.fixId, 'blame') : runHref(runId, o.blamedCall),
    fixId: o.fixId,
  };
}

/** The runs in a family blame marked the provider unavailable for, by the probe they were attempts of (`<run>:<call>`). */
function unavailableProbes(family: ReadonlyMap<string, RunRecord>): Map<string, RunRecord[]> {
  const out = new Map<string, RunRecord[]>();
  for (const r of family.values()) {
    const p = r.meta?.probe;
    if (p?.verdict !== 'unavailable' || typeof p.of !== 'string' || typeof p.callNo !== 'number') continue;
    const key = `${p.of}:${p.callNo}`;
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  return out;
}

/** An attempt the provider was unavailable for, as its probe's bundle lists it: marked apart, its note saying it never counted. */
const unavailableAttempt = (r: RunRecord): FixBundleAttempt => ({ runId: r.runId, passed: false, verdict: 'inconclusive', note: 'the provider was unavailable: retried, never counted', rescued: false, unavailable: true });

/**
 * A good run's baseline attempts, as the Forks view bundles them beside the change's: named as the
 * code before the change (at the base revision, where verify kept one), with the verdict they
 * counted towards, and their own tally, in verify's words (`baseline 2 of 3`).
 */
function baselineBundle(key: string, x: VerifiedRun, base: VerifiedRun['attempts'], o: { verdict: VerifyOutcome; counts: boolean | null; href: string; at: number; fixId: string | null }, family: ReadonlyMap<string, RunRecord>, bundled: Set<string>): FixBundle {
  for (const a of base) bundled.add(a.runId);
  const passes = base.filter((a) => a.passed).length;
  const revision = x.baseline?.revision;
  return {
    kind: 'verify',
    key,
    parentRunId: x.runId,
    title: 'verify · baseline',
    callNo: null,
    blamed: false,
    change: `the code before the change${revision ? ` at ${revision}` : ''}`,
    verdict: o.verdict,
    role: ROLE[x.role],
    counts: o.counts,
    passes,
    attempts: base.map((a) => ({ runId: a.runId, passed: a.passed, verdict: keptAttemptVerdict(a), note: attemptNote(a.passed, a.failures[0], family.get(a.runId), keptAttemptVerdict(a)), rescued: false })),
    spent: base.reduce((n, a) => n + a.spent, 0),
    at: Math.min(...base.map((a) => family.get(a.runId)?.startedAt ?? o.at), o.at),
    verdictLine: `baseline · ${passes} of ${base.length} passed`,
    tone: null,
    rule: null,
    href: o.href,
    fixId: o.fixId,
    arm: 'baseline',
  };
}

/**
 * A run several fixes blamed or verified carries bundles from each, which would read the same
 * ("verify · good" under a good run three fixes kept): there, each title names its fix, by its label
 * or its short id ("verify · good · refund-bug").
 */
function nameSharedBundles(store: StoreOf<'recording' | 'fixes'>, bundles: FixBundle[]): void {
  const fixesUnder = new Map<string, Set<string>>();
  for (const b of bundles) if (b.fixId) fixesUnder.set(b.parentRunId, (fixesUnder.get(b.parentRunId) ?? new Set()).add(b.fixId));
  const names = new Map<string, string>();
  const nameOf = (fixId: string): string => {
    let name = names.get(fixId);
    if (name === undefined) {
      const fix = store.getFix(fixId);
      name = (fix ? fixLabelInfo(store, fix).label : null) ?? fixId.slice(0, 13);
      names.set(fixId, name);
    }
    return name;
  };
  for (const b of bundles) if (b.fixId && (fixesUnder.get(b.parentRunId)?.size ?? 0) > 1) b.title = `${b.title} · ${nameOf(b.fixId)}`;
}
