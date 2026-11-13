import { checkKey, checkRecordings, fixRecords, hiddenCharacter, hiddenCharacterWords, leavesFix, messageOf, notApplicable, oracleLabels, parseExpect, runsLeft, shortFixId, standingOn, type CheckResult, type FixCheckJudged, type FixRecords, type FixRunOutcome, type Price, type Store, type StoredFix, type StoredFixCheck, type TestSpec } from '@shadowlap/engine';
import { changeName } from './fix-shared.js';
import { answer, failed, type ReadAnswer, type ReadTable } from './read-registry.js';

/**
 * Giving a fix another check (E11, `shadowlap fix check`): its failing and good runs judged again by
 * it from their recordings, nothing replayed, what refuses it, and the verdicts it would stop
 * counting. The CLI's command writes it, and the Fixes page's preview reads the same before it does,
 * so the two say the same.
 */

/** One of a fix's runs judged by a check: as `shadowlap check` judges it (`na`: passed only because none of its checks applied, which fails nothing), or `gone` from the store. */
export interface FixCheckRow {
  runId: string;
  role: 'failing' | 'good';
  outcome: FixRunOutcome;
  na: boolean;
  why: string[];
  checks: CheckResult[];
}

export interface FixCheckJudging {
  /** The failing runs first, then the good ones, each in the order it joined the fix. */
  rows: FixCheckRow[];
  /** How it judged each run, as the fix keeps it beside the check (runsLeft reads it). */
  judged: FixCheckJudged;
  /** The runs it would leave out of the fix: failing runs it passes, good runs it fails. */
  left: { failing: string[]; good: string[] };
}

/**
 * Every run the fix holds as failing or good, those an earlier check left out included, judged by
 * `spec` from what it recorded, judges and all (a judge with no verdict kept reads inconclusive).
 */
export function judgeFixRuns(store: Store, rec: Pick<FixRecords, 'fix'>, check: { spec: TestSpec; expect: unknown }, o: { prices?: Record<string, Price> } = {}): FixCheckJudging {
  const linked = (kind: 'failing' | 'good') => [...new Set(store.fixLinks(rec.fix.fixId, kind).map((l) => l.ref))];
  const roles = [...linked('failing').map((runId) => ({ runId, role: 'failing' as const })), ...linked('good').map((runId) => ({ runId, role: 'good' as const }))];
  const here = roles.flatMap(({ runId }) => {
    const run = store.getRun(runId);
    return run ? [{ run, store, pack: null, spec: check.spec, source: '--expect' }] : [];
  });
  const report = checkRecordings(here, { expect: check.expect, ...(o.prices ? { prices: o.prices } : {}) });
  const byId = new Map(report.recordings.map((r) => [r.runId, r]));
  const rows = roles.map(({ runId, role }): FixCheckRow => {
    const r = byId.get(runId);
    return r ? { runId, role, outcome: r.outcome, na: notApplicable(r), why: r.why, checks: r.checks } : { runId, role, outcome: 'gone', na: false, why: [], checks: [] };
  });
  const judged: FixCheckJudged = { failing: {}, good: {} };
  for (const row of rows) judged[row.role][row.runId] = row.outcome;
  const left = runsLeft([{ judged }]);
  return { rows, judged, left: { failing: [...left.failing], good: [...left.good] } };
}

/**
 * Why a fix can't take a check its runs were judged by, or null: none of its failing runs is in the
 * store to judge it on, or none of them fails it as recorded (a run none of its checks applied to
 * passes), so it would no longer be this failure. One a judge can't settle from the recording keeps it.
 */
export function fixCheckRefusal(fixId: string, rows: readonly FixCheckRow[]): string | null {
  const failing = rows.filter((r) => r.role === 'failing' && r.outcome !== 'gone');
  if (!failing.length) return `None of ${shortFixId(fixId)}'s failing runs is left in the store to judge the check on. Nothing changed.`;
  return failing.every((r) => leavesFix('failing', r.outcome)) ? `None of ${shortFixId(fixId)}'s failing runs fails this check as recorded, so it would no longer be this failure. Nothing changed.` : null;
}

/** Why a fix that isn't open keeps its check: its accepted verdict was given under it, and a golden takes another. */
export const notOpenWords = (fix: Pick<StoredFix, 'fixId' | 'status'>): string =>
  `${shortFixId(fix.fixId)} is ${fix.status}: it keeps the check its accepted verdict was given under. Add a check to the golden that guards it instead, under "tests" in shadowlap.config.json.`;

/** Why a check is refused before anything is judged: one holding a character the team store can't keep (hiddenCharacter). */
export function hiddenCheckWords(expect: unknown): string | null {
  const hidden = hiddenCharacter(expect);
  return hidden ? hiddenCharacterWords(hidden) : null;
}

/**
 * The verdicts that count for the fix and would stop under `draft`, judged as `judging` says (standingOn,
 * as fixRecords reads them once it is the fix's check), each with its code: the change it verified, as
 * the Verify step's switch and Changes → Verdicts name it (changeName).
 */
export function uncountedUnder(rec: FixRecords, draft: StoredFix['check'], judging: Pick<FixCheckJudging, 'judged'>): Array<{ verifyId: string; code: string }> {
  if (draft.key === rec.fix.check.key) return [];
  const entry: StoredFixCheck = { fixId: rec.fix.fixId, position: rec.checks.length, at: Date.now(), actor: null, check: draft, judged: judging.judged };
  const checks = [...rec.checks, entry];
  const left = runsLeft(checks).failing;
  const failing = new Set([...rec.failing, ...rec.left.failing].filter((id) => !left.has(id)));
  return rec.verdicts
    .filter((v) => rec.standing.get(v.verifyId)?.counts !== false && !standingOn({ check: draft }, checks, v, { counts: true, why: null }, { failing, left }).counts)
    .map((v) => ({ verifyId: v.verifyId, code: changeName(v) }));
}

/** The check a fix keeps for `expect`, given its oracle and words, by its key. */
export const fixCheckOf = (expect: unknown, oracle: string[], text: string): StoredFix['check'] => ({ expect, key: checkKey(expect), oracle, text });


/**
 * Fix mode's preview (`POST /api/fixes/:id/check-preview`): a draft check judged on the fix's runs
 * beside the server, before Save check writes it. With `context`, the fix's runs only, for a check
 * added to the golden that guards a fix of any status: nothing would be saved to the fix, so nothing
 * is refused or stops counting.
 */
export type FixCheckPreviewJob = { kind: 'fix-check-preview'; fixId: string; expect: Record<string, unknown>; context?: true; prices?: Record<string, Price> };

/** What the preview answers: `shadowlap fix check` would judge the same, refuse the same and stop counting the same verdicts. */
export interface FixCheckPreview {
  rows: FixCheckRow[];
  /** Why Save check would be refused (fixCheckRefusal), or null. */
  refused: string | null;
  /** The runs it would leave out of the fix (judgeFixRuns' `left`, by the engine's leavesFix); none for context. */
  left: FixCheckJudging['left'];
  /** The verdicts that count for the fix and would stop, by id and by the change each verified (changeName), as the page names them. */
  uncounted: Array<{ verifyId: string; code: string }>;
}

/** Judged on every run the fix holds; a fix that is no longer open, or a draft the CLI would refuse before judging, answers as its job would (409, 400). */
function fixCheckPreview(store: Store, job: FixCheckPreviewJob): ReadAnswer {
  const fix = store.getFix(job.fixId);
  if (!fix) return failed(404, `no fix ${job.fixId.slice(0, 40)}`);
  if (fix.status !== 'open' && !job.context) return failed(409, notOpenWords(fix));
  const hidden = hiddenCheckWords(job.expect);
  if (hidden) return failed(400, hidden);
  let spec: TestSpec;
  try {
    spec = parseExpect(job.expect, 'expect');
  } catch (err) {
    return failed(400, messageOf(err));
  }
  const rec = fixRecords(store, fix);
  const judging = judgeFixRuns(store, rec, { spec, expect: job.expect }, job.prices ? { prices: job.prices } : {});
  const body: FixCheckPreview = job.context
    ? { rows: judging.rows, refused: null, left: { failing: [], good: [] }, uncounted: [] }
    : { rows: judging.rows, refused: fixCheckRefusal(fix.fixId, judging.rows), left: judging.left, uncounted: uncountedUnder(rec, fixCheckOf(job.expect, oracleLabels(spec), ''), judging) };
  return answer(body);
}

export const FIX_CHECK_READS: ReadTable<FixCheckPreviewJob> = {
  'fix-check-preview': (store, job) => fixCheckPreview(store, job),
};
