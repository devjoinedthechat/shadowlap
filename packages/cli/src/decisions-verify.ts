import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codeChangeNeeded, commandIsImported, decisionsName, goldenNeedsConsent, importedCommandSource, messageOf, quoteArgv, type DecisionRemedy, type DecisionRun, type DecisionsChange, type DecisionsVerify, type Store, type StoreOf } from '@shadowlap/engine';
import { judgeRecording } from './attempts.js';
import { specFor } from './checks.js';
import { loadConfig, loadTests } from './config.js';
import { DecisionsError, storeTarget, verifyFields, type DecisionsSettings, type DecisionTarget } from './decisions.js';
import { verifyRuns } from './decisions-verify-runs.js';
import { importGolden } from './golden-test.js';
import { rawExpectFor } from './goldens.js';
import { passesOf, type MigrateRunPass } from './migrate.js';
import { openStore, type GlobalOpts } from './shared.js';

/** A preview's name, which the feed words its verify's events by; a migration's keeps a fix's words until its page links it. */
const previewName = (kind: string, change: DecisionsChange | undefined): { sessionName?: string } => (kind === 'decisions' ? { sessionName: decisionsName({ kind: 'decisions', change: change ?? null }) } : {});

/**
 * `shadowlap decisions --verify <session>`: verify the runs a kept session could not clear, without asking
 * their model calls again: the dashboard's "Verify the changed runs". Each run is verified as
 * `--then-verify` verifies it: under its checks from the config, its golden's, or for a run named by
 * id those of the recording it comes from (one verify per set of checks), in the role its recording
 * plays under them, with the session's change (its model, the fields it set and those migrate sent
 * in place of what the new model refuses, at the models it changed from). What it finds is kept in
 * the session.
 */

export interface SessionVerify {
  sessionId: string;
  kind: 'decisions' | 'migrate';
  change: string;
  /** This verify: the runs it verified, as `--then-verify` reports them. */
  verify: DecisionsVerify;
  /** A migrate session's runs, as its What still passes reads now; null for a decisions session. */
  passes: MigrateRunPass[] | null;
}

/** Where each golden diverges once the config change is in doesn't move with a verify: kept as migrate found it. */
function keptDiverges(passes: MigrateRunPass[], kept: unknown): MigrateRunPass[] {
  const runs = (kept as { runs?: MigrateRunPass[] } | undefined)?.runs ?? [];
  const at = new Map(runs.map((x) => [x.runId, x.diverges ?? null]));
  return passes.map((x) => ({ ...x, diverges: at.get(x.runId) ?? null }));
}

/** A session by its id, or a prefix of one that names a single session. */
export function findSession(store: StoreOf<'decisions'>, id: string): ReturnType<Store['getDecisionSession']> {
  const exact = store.getDecisionSession(id);
  if (exact) return exact;
  if (!/^(dc|mg)-[0-9A-Za-z]{4,}$/.test(id)) return null;
  const matches = store.listDecisionSessions({ limit: 10_000 }).filter((s) => s.sessionId.startsWith(id.toUpperCase().replace(/^(DC|MG)-/, (m) => m.toLowerCase())));
  if (matches.length > 1) throw new DecisionsError(`${id} names ${matches.length} sessions: give more of its id`);
  return matches[0] ? store.getDecisionSession(matches[0].sessionId) : null;
}

/**
 * Verify's findings for the runs verified now, over what an earlier verify of the session found for
 * the others. Accepted only when every run was fixed or kept: a run verify didn't settle, whichever
 * verify took it, leaves the session incomplete until a verify settles it, one whose attempts stopped
 * early (unsettled) as well as one whose gate ran out of attempts between its bounds or that an
 * attempt it could not judge stopped (inconclusive). Each run keeps the rule that decided it, so its
 * tally and bound read under their own rule: the session's `rule` is that rule when one decided every
 * run it keeps, else null.
 */
export function mergeVerify(previous: DecisionsVerify | null, now: DecisionsVerify): DecisionsVerify {
  if (!previous || previous.verdict === 'not-run') return now;
  if (now.verdict === 'not-run' && !now.runs.length) return { ...previous, reasons: [...previous.reasons, ...now.reasons] };
  const fresh = new Set(now.runs.map((r) => r.runId));
  // A run kept before runs carried their rule was decided by the one its verify stated.
  const ruled = (v: DecisionsVerify) => v.runs.map((r) => ({ ...r, rule: r.rule ?? v.rule ?? null }));
  const runs = [...ruled(previous).filter((r) => !fresh.has(r.runId)), ...ruled(now)];
  const settled = runs.every((r) => r.outcome === 'fixed' || r.outcome === 'kept');
  const verdict: DecisionsVerify['verdict'] = runs.some((r) => r.outcome === 'broken' || r.outcome === 'not-fixed') ? 'rejected' : !settled || now.verdict === 'incomplete' ? 'incomplete' : 'accepted';
  const rules = new Set(runs.map((r) => r.rule));
  const warnings = [...(previous.warnings ?? []), ...(now.warnings ?? [])];
  return { ...(warnings.length ? { warnings } : {}), verdict, verifyIds: [...previous.verifyIds, ...now.verifyIds], runs, rule: rules.size === 1 ? [...rules][0]! : null, commands: [...previous.commands, ...now.commands], spent: previous.spent + now.spent, upstreamRequests: previous.upstreamRequests + now.upstreamRequests, reasons: [...previous.reasons, ...now.reasons] };
}

export async function verifySession(input: { opts: GlobalOpts; sessionId: string; runs: readonly string[]; settings: Pick<DecisionsSettings, 'thenVerify' | 'argv' | 'timeoutMs' | 'guard'>; budget: number | null; yes: boolean; log: (line: string) => void }): Promise<SessionVerify> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  let tests: ReturnType<typeof loadTests> = [];
  try {
    tests = loadTests(cwd);
  } catch {
    // no checks the config can give: a golden is then judged by its exit code, as test judges it
  }
  const store = openStore(input.opts);
  try {
    const session = findSession(store, input.sessionId);
    if (!session) throw new DecisionsError(`no session ${input.sessionId}: decisions and migrate print the id of the session they keep (dc-…, mg-…)`);
    const data = session.data;
    const report = (session.kind === 'migrate' ? data.decisions : data) as { flagged?: string[]; toVerify?: string[]; change?: DecisionsChange; remedies?: DecisionRemedy[]; verify?: DecisionsVerify | null } | undefined;
    // The runs it could not clear; a session kept before it said which, the ones it flagged.
    const toVerify = report?.toVerify ?? report?.flagged ?? [];
    const change: Pick<DecisionsChange, 'model' | 'fields' | 'from'> = { model: report?.change?.model ?? null, fields: report?.change?.fields ?? {}, from: report?.change?.from ?? null };
    const named = (id: string, given: string) => id === given || (given.length >= 6 && id.startsWith(given));
    const missing = input.runs.filter((r) => !toVerify.some((id) => named(id, r)));
    if (missing.length) throw new DecisionsError(`${missing.join(', ')}: no run ${session.sessionId} left to verify has that id (it leaves the runs a preview can't clear: ${toVerify.map((id) => id.slice(0, 10)).join(', ') || 'none'})`);
    const chosen = input.runs.length ? toVerify.filter((id) => input.runs.some((r) => named(id, r))) : toVerify;
    if (!chosen.length) throw new DecisionsError(`${session.sessionId} cleared every run: there is nothing to verify`);

    // Each run as the session asked it: a golden from its pack, with its checks from the config.
    const goldenOf = new Map(session.runRows.map((r) => [r.runId, r.golden]));
    const targetOf = (runId: string): DecisionTarget => {
      const golden = goldenOf.get(runId) ?? null;
      if (golden) {
        const abs = resolve(cwd, golden);
        if (!existsSync(join(abs, 'run.json'))) throw new DecisionsError(`${golden}: its pack is not in this project, so its checks can't be read: verify from the project the session was made in`);
        try {
          return { run: importGolden(store, abs), golden, spec: specFor(tests, abs, cwd), expect: rawExpectFor(tests, abs, cwd) };
        } catch (err) {
          throw new DecisionsError(`${golden}: ${messageOf(err)}`);
        }
      }
      const run = store.getRun(runId);
      if (!run) throw new DecisionsError(`${runId.slice(0, 10)}, which ${session.sessionId} names, is no longer in the store`);
      return storeTarget(store, run, cwd);
    };
    const targets = chosen.map(targetOf);
    // A run from someone's pack runs its recorded command only with a yes, and so does a golden whose
    // pack the repository doesn't track, recorded elsewhere, as test asks of one (goldenNeedsConsent).
    const imported = input.settings.argv ? [] : targets.filter((t) => (t.golden === null ? commandIsImported(t.run) : goldenNeedsConsent(t.run, resolve(cwd, t.golden), cwd)));
    if (imported.length && !input.yes) throw new DecisionsError(`${imported.map((t) => (t.golden === null ? `${t.run.runId.slice(0, 10)} came from ${importedCommandSource(t.run)}` : `${t.golden} is from a pack this repository doesn't track`)).join('; ')}: verifying runs the command it was recorded with (${quoteArgv(imported[0]!.run.command.argv)}). Give --yes to run it, or your own command after --`);
    const remedies = report?.remedies ?? [];
    const verify = await verifyRuns({
      opts: input.opts,
      store,
      targets,
      session: session.sessionId,
      ...previewName(session.kind, report?.change),
      fields: verifyFields(change, remedies),
      from: change.from,
      settings: input.settings,
      prices: config.prices,
      budget: input.budget,
      log: input.log,
      blocked: codeChangeNeeded(remedies, change.model),
    });

    // Kept in the session, over what an earlier verify of it found for the other runs.
    const merged = mergeVerify(report?.verify ?? null, verify);
    const runs = session.runRows.map((r) => r.data as unknown as DecisionRun);
    let passes: MigrateRunPass[] | null = null;
    let next: Record<string, unknown>;
    if (session.kind === 'migrate') {
      const recorded = (runId: string) => {
        try {
          const t = targets.find((x) => x.run.runId === runId) ?? targetOf(runId);
          return judgeRecording(store, t.run, store.getCalls(t.run.runId), t.spec, config.prices).passed;
        } catch {
          return null;
        }
      };
      passes = keptDiverges(passesOf(runs, toVerify, merged, recorded), data.passes);
      next = { ...data, decisions: { ...(data.decisions as Record<string, unknown>), verify: merged }, passes: { verdict: merged.verdict, runs: passes } };
    } else next = { ...data, verify: merged };
    store.putDecisionSession({ sessionId: session.sessionId, kind: session.kind, at: session.at, change: session.change, actor: session.actor, revision: session.revision, data: next, runs: session.runRows.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.rank, changed: r.changed, data: r.data })) });
    return { sessionId: session.sessionId, kind: session.kind, change: session.change, verify, passes };
  } finally {
    store.close();
  }
}
