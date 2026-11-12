import { useState, type ReactNode } from 'react';
import { CHECK_MARKS, JUDGE_ASKED } from '../../../engine/src/checks/labels.js';
import { isObject } from '../../../engine/src/is-object.js';
import { messageOf } from '../../../engine/src/message-of.js';
import { quoteArgv } from '../../../engine/src/text.js';
import { plural, shortFixId } from '../../../engine/src/words.js';
import { JOB_KINDS } from '../api.js';
import type { FixCheckPreview, FixCheckRow } from '../checks-api.js';
import { CodeBox } from '../components/CodeBox.js';
import type { CostLineProps } from '../components/CostLine.js';
import { DialogFacts } from '../components/DialogFacts.js';
import { tipCard } from '../components/HoverCard.js';
import { Id, namedIn } from '../components/Id.js';
import { ErrorState } from '../components/States.js';
import { goldenName } from '../format.js';
import { ACTIONS } from '../labels.js';
import { packRunCommand } from '../run/share-steps.js';
import type { BuilderFix } from '../run/check-part.js';
import { useApp } from '../state.js';
import { fixJudgeCost } from './Judge.js';
import { useJudged, type Judged } from './judging.js';
import { blankUnit, checkCommand, editAt, fileUnit, judgesIn, saveWhy, titleOf, unitsOf, type Fragment, type Rule, type Settled, type Units } from './model.js';

/**
 * The check builder on a fix. Fix mode (Edit check…, an open fix): the fix's check as units, the
 * first in the editor, its failing and good runs judged by the check as built, judges and all, from
 * what they recorded (Its runs under this check), what a change does to the fix (What changes), and
 * Save check, which gives the fix the check through the `fix-check` job, as `shadowlap fix check`
 * does. Beside a fix of any other status (Add check to <golden>…): golden mode on the golden that
 * guards it, with the fix's runs under the draft for context, folded; with no golden, how to pack one.
 */

/** Fix mode's units: the fix's check, its first in the editor; the exit code alone opens on one blank rule. */
export function fixUnits(expect: unknown): Units {
  const file = unitsOf(expect).map(fileUnit);
  return file.length ? editAt({ units: file, active: 0 }, 0) : { units: [blankUnit()], active: 0 };
}

/** What the fix's check holds, which a change is told from: nothing for the exit code alone. */
export const fixBase = (expect: unknown): Fragment | null => (isObject(expect) ? expect : null);

/** The title and lead: fix mode's, or a check added beside the fix to the golden that guards it, or with none. */
export function fixHead(fix: BuilderFix, own: boolean, golden: string | null): { title: ReactNode; lead: ReactNode } {
  if (own) return { title: 'Edit check', lead: `Changes what “${fix.title}” must do.` };
  const title = titleOf(golden, { edit: false, fromCall: false });
  if (!golden) return { title, lead: 'No golden guards this fix yet.' };
  return { title: namedIn(title, goldenName(golden)), lead: `Adds a check to ${goldenName(golden)}, the golden that guards this fix.` };
}

/** What the fix's runs are judged by: the whole check as built in fix mode, judges in (an empty one judges by the exit code alone), else the draft. */
const judgedBy = (own: boolean, s: Settled): Fragment | null => (own ? s.merged : s.draft);

/**
 * The fix's runs judged beside the server (`POST /api/fixes/:id/check-preview`), as golden mode's
 * recordings are, after the same wait and with one read in flight: in fix mode as Save check would
 * judge, refuse and stop counting; beside a golden for context, refusing nothing. Nothing without a fix.
 */
export function useFixRuns(fix: BuilderFix | null, own: boolean, s: Settled): Judged<FixCheckPreview> {
  const { client } = useApp();
  const check = fix ? judgedBy(own, s) : null;
  return useJudged(fix && check ? JSON.stringify([fix.fixId, own, check]) : null, (k) => {
    const [fixId, mine, expect] = JSON.parse(k) as [string, boolean, Fragment];
    return client.checks.fixPreview(fixId, expect, mine ? {} : { context: true });
  });
}

/** A run that would change for the fix: one the check takes out of it (the read's `left`, by the engine's rule), or one it can't settle. */
function needsLook(r: FixCheckRow, left: FixCheckPreview['left']): boolean {
  return r.outcome === 'inconclusive' || left[r.role].includes(r.runId);
}

/** Why Save check waits on the fix's runs: until the draft as it stands is judged on them, after a read of them that failed, and on the read's refusal. */
function judgedWhy({ answer, error }: Pick<Judged<FixCheckPreview>, 'answer' | 'error'>): string | null {
  if (answer) return answer.refused;
  return error ? 'The fix’s runs couldn’t be judged: Retry them under Its runs under this check' : 'Judging it on the fix’s runs…';
}

/**
 * Save check's words, as golden mode's follow its state: off with why until it can save (until the
 * draft is judged on the fix's runs, and the read's refusal, last), plain while a run needs a look,
 * lime once none does. So Save always matches the rows drawn for the draft as it stands.
 */
export function fixWays(s: Units, d: { settled: Settled; rule: Rule | null }, o: { judged: Pick<Judged<FixCheckPreview>, 'answer' | 'error'>; warn: string | null; redactions: number }) {
  const answer = o.judged.answer;
  const amber = !!answer && answer.rows.some((r) => needsLook(r, answer.left));
  return {
    ok: ACTIONS.editCheck.confirm,
    tone: amber ? ('plain' as const) : ('lime' as const),
    // Saved to the fix, never to a golden: saveWhy's last check, for a golden to save it under, holds.
    okWhy: o.warn ?? saveWhy(d.settled, s.units, s.active, 'the fix') ?? judgedWhy(o.judged),
    okSub: amber ? 'Saves it as it is, though something above needs a look' : 'The fix keeps it in the store',
    startFocus: d.rule ? '.cb-kinds [aria-pressed="true"]' : '.cb-kinds button',
    cost: d.rule?.kind === 'judge' ? fixJudgeCost(d.rule, o.redactions) : (null as CostLineProps | null),
  };
}

/**
 * Save check: the `fix-check` job started with the check as built, the drawer following it as every
 * fix job's does, and the builder closed on its start. A refusal (409, the fix is no longer open; 400,
 * a check the command can't take) keeps it open with what was built, its words in the amber line.
 */
export function useFixSave(fix: BuilderFix | null, merged: Fragment, onWarn: (why: string) => void): () => Promise<boolean> {
  const app = useApp();
  return async () => {
    if (!fix) return false;
    try {
      const job = await app.client.startJob(JOB_KINDS.fixCheck, { fixId: fix.fixId, expect: merged });
      app.watchJob(Promise.resolve(job));
      return true;
    } catch (err) {
      onWarn(messageOf(err));
      return false;
    }
  };
}

/** A run's words under the check: its say word, why, its mark and whether it needs a look (`context`: the fix's runs beside a golden's check, which change nothing). */
function runWords(r: FixCheckRow, left: FixCheckPreview['left'], context: boolean): { say: string; why: string; mark: string; amber: boolean } {
  if (r.outcome === 'gone') return { say: 'gone from the store', why: '', mark: '', amber: false };
  const amber = !context && needsLook(r, left);
  if (r.outcome === 'inconclusive') return { say: 'inconclusive', why: shortWhy(r), mark: 'inc', amber };
  if (r.outcome === 'failed') {
    const say = context ? 'fails' : r.role === 'failing' ? 'still fails' : 'fails';
    return { say, why: amber ? 'it would no longer be kept as good' : shortWhy(r), mark: 'no', amber };
  }
  // A run none of whose checks applied fails nothing, so it leaves a fix as one it passes does, but it is never called passed.
  const say = r.na ? 'not applicable' : context || r.role === 'good' ? 'passes' : 'passes as recorded';
  return { say, why: amber ? 'it would leave the fix' : '', mark: 'ok', amber };
}

/** The first check it fails, else can't settle, as the engine words what it found: the first clause, with the tool a count names. */
function shortWhy(r: FixCheckRow): string {
  const c = r.checks.find((x) => x.status === 'failed') ?? r.checks.find((x) => x.status === 'inconclusive');
  if (!c) return r.why[0] ?? '';
  const found = (c.detail ?? '').split('; ')[0]!;
  const tool = found.startsWith('called ') ? c.label.split(': ').at(-1)!.split(' ')[0] : null;
  return tool ? `${tool} ${found}` : found;
}

/** A run's card while it doesn't pass: each check it fails or can't settle, its words over what it found, or why it failed beyond them. */
function runCard(r: FixCheckRow, say: string): string | null {
  if (r.outcome !== 'failed' && r.outcome !== 'inconclusive') return null;
  const title = `${say.charAt(0).toUpperCase()}${say.slice(1)}`;
  const rows = r.checks
    .filter((c) => c.status === 'failed' || c.status === 'inconclusive')
    .map((c) => ({ label: c.label, value: `${c.status}${c.detail ? ` · ${c.detail.replace(/^inconclusive · /, '')}` : ''}`, color: `var(--cq-${c.status === 'failed' ? 'red' : 'amber'})` }));
  return tipCard(title, rows, rows.length ? null : (r.why[0] ?? null));
}

function RunRow({ r, left, context }: { r: FixCheckRow; left: FixCheckPreview['left']; context: boolean }) {
  const w = runWords(r, left, context);
  const card = runCard(r, w.say);
  const mark = r.outcome === 'gone' || r.na ? CHECK_MARKS['not-applicable'] : CHECK_MARKS[r.outcome];
  return (
    <div className={`cb-row${w.amber ? ' y' : ''}`}>
      <span className="cb-role">{r.role}</span>
      <span className="cb-rid">
        <Id id={r.runId} list />
      </span>
      <b className={`cm${w.mark ? ` ${w.mark}` : ''}`} aria-label={r.na ? 'not applicable' : r.outcome}>
        {mark}
      </b>
      <span className="cb-d" {...(card ? { tabIndex: 0, 'data-tip': card } : {})}>
        {w.say}
        {w.why ? ` · ${w.why}` : null}
      </span>
    </div>
  );
}

/**
 * Its runs under this check (fix mode): one row a run, failing then good, what would change for the
 * fix in amber; then, while one is inconclusive under a judge, when verify asks it; then the command
 * that judges the same. Beside a golden, the fix's runs for context: folded, nothing in amber, no command.
 */
function FixRuns({ judging, own, check }: { judging: Judged<FixCheckPreview>; own: boolean; check: Fragment }) {
  const [open, setOpen] = useState(false);
  const { answer, error, retry } = judging;
  const rows = answer?.rows ?? [];
  const shown = own || open;
  const ids = rows.filter((r) => r.outcome !== 'gone').map((r) => r.runId);
  const cmd = ids.length ? checkCommand(ids, check) : null;
  return (
    <section className="cb-sec">
      <p className="cb-k">
        <span className="k">{own ? 'Its runs under this check' : 'The fix’s runs'}</span>
        <span className="cb-sub">{own ? 'judged from what they recorded · nothing replayed' : 'for context: the fix keeps its own check'}</span>
      </p>
      {error ? <ErrorState retry={retry}>{error}</ErrorState> : null}
      {!answer ? (
        error ? null : <p className="cb-note">Judging it on the fix’s runs…</p>
      ) : (
        <>
          {own || !rows.length ? null : (
            <button className="linkbtn cb-more" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Hide' : 'Show'} {plural(rows.length, 'run')}
            </button>
          )}
          {shown && rows.length ? (
            <div className="cb-rows cb-fixr">
              {rows.map((r) => (
                <RunRow key={`${r.role}:${r.runId}`} r={r} left={answer.left} context={!own} />
              ))}
            </div>
          ) : null}
          {own && rows.some((r) => r.outcome === 'inconclusive') && judgesIn(check) ? <p className="cb-note">Verify’s judge is {JUDGE_ASKED}.</p> : null}
          {own && cmd ? <CodeBox command={cmd.view} full={cmd.full} className="cb-cmd" /> : null}
          {own && cmd?.more ? <p className="cb-cmdn">{cmd.more}</p> : null}
        </>
      )}
    </section>
  );
}

/** What a change does to the fix: blame again first, the check its next steps run under, the verdicts that stop counting, and the config it leaves alone; then the command. */
function FixChange({ fix, merged, uncounted }: { fix: BuilderFix; merged: Fragment; uncounted: FixCheckPreview['uncounted'] }) {
  const n = uncounted.length;
  return (
    <section className="cb-sec">
      <p className="cb-k">
        <span className="k">What changes</span>
      </p>
      <DialogFacts
        rows={[
          fix.blamesAgain && { label: 'Blame', value: 'runs again first, under this check' },
          { label: 'Repair, verify', value: 'use this check' },
          n > 0 && { label: n === 1 ? 'Verdict' : 'Verdicts', value: n === 1 ? `\`${uncounted[0]!.code}\` no longer counts` : `${n} no longer count`, quiet: n === 1 ? 'it checked the old one' : 'they checked the old one' },
          { label: 'Config', value: 'unchanged', quiet: 'the fix keeps its check in the store, not in `shadowlap.config.json`' },
        ]}
      />
      <CodeBox command={quoteArgv(['shadowlap', 'fix', 'check', shortFixId(fix.fixId), '--expect', JSON.stringify(merged)])} className="cb-cmd" />
    </section>
  );
}

/** Beside a fix no golden guards: The change says how to pack one from a recording of it working. */
function NoGuard({ fix }: { fix: BuilderFix }) {
  return (
    <section className="cb-sec">
      <p className="cb-k">
        <span className="k">The change</span>
      </p>
      <p className="cb-note">No golden guards this fix yet. Pack one of its fixed runs as a golden, then add the check to it.</p>
      <CodeBox command={fix.fixedRun ? packRunCommand(fix.fixedRun, `goldens/${fix.label ?? '<name>'}`) : `shadowlap pack <run> goldens/${fix.label ?? '<name>'}`} />
    </section>
  );
}

/**
 * The fix's sections, after the golden's preview where there is one: its runs, then in fix mode
 * What changes, and beside a fix no golden guards, how to pack one in The change's place.
 */
export function FixSections({ fix, own, settled, judging, guarded }: { fix: BuilderFix; own: boolean; settled: Settled; judging: Judged<FixCheckPreview>; guarded: boolean }) {
  const check = judgedBy(own, settled);
  return (
    <>
      {check ? <FixRuns judging={judging} own={own} check={check} /> : null}
      {own ? <FixChange fix={fix} merged={settled.merged} uncounted={judging.answer?.uncounted ?? []} /> : guarded ? null : <NoGuard fix={fix} />}
    </>
  );
}
