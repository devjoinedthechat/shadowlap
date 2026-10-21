import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commandIsImported, importedCommandSource, type DecisionRemedy, type DecisionRun, type DecisionsChange, type DecisionsVerify, type Store } from '@shadowlap/engine';
import { judgeRecording } from './attempts.js';
import { specFor } from './checks.js';
import { loadConfig, loadTests } from './config.js';
import { codeChangeNeeded, DecisionsError, storeTarget, verifyFields, verifyFlagged, type DecisionsSettings, type DecisionTarget } from './decisions.js';
import { importGolden } from './golden-test.js';
import { rawExpectFor } from './goldens.js';
import { passesOf, type MigrateRunPass } from './migrate.js';
import { openStore, type GlobalOpts } from './shared.js';

/**
 * `shadowlap decisions --verify <session>`: verify the runs a kept session flagged, without asking
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

/** A session by its id, or a prefix of one that names a single session. */
function findSession(store: Store, id: string): ReturnType<Store['getDecisionSession']> {
  const exact = store.getDecisionSession(id);
  if (exact) return exact;
  if (!/^(dc|mg)-[0-9A-Za-z]{4,}$/.test(id)) return null;
  const matches = store.listDecisionSessions({ limit: 10_000 }).filter((s) => s.sessionId.startsWith(id.toUpperCase().replace(/^(DC|MG)-/, (m) => m.toLowerCase())));
  if (matches.length > 1) throw new DecisionsError(`${id} names ${matches.length} sessions: give more of its id`);
  return matches[0] ? store.getDecisionSession(matches[0].sessionId) : null;
}

/**
 * Verify's findings for the runs verified now, over what an earlier verify of the session found for
 * the others. A run verify didn't settle, whichever verify took it, leaves the session incomplete: one
 * whose attempts stopped early (unsettled), and one whose gate ran out of attempts between its bounds
 * (inconclusive). Each run keeps the rule that decided it, so its tally and bound read under their
 * own rule: the session's `rule` is that rule when one decided every run it keeps, else null.
 */
export function mergeVerify(previous: DecisionsVerify | null, now: DecisionsVerify): DecisionsVerify {
  if (!previous || previous.verdict === 'not-run') return now;
  if (now.verdict === 'not-run' && !now.runs.length) return { ...previous, reasons: [...previous.reasons, ...now.reasons] };
  const fresh = new Set(now.runs.map((r) => r.runId));
  // A run kept before runs carried their rule was decided by the one its verify stated.
  const ruled = (v: DecisionsVerify) => v.runs.map((r) => ({ ...r, rule: r.rule ?? v.rule ?? null }));
  const runs = [...ruled(previous).filter((r) => !fresh.has(r.runId)), ...ruled(now)];
  const verdict: DecisionsVerify['verdict'] = runs.some((r) => r.outcome === 'broken' || r.outcome === 'not-fixed') ? 'rejected' : runs.some((r) => r.outcome === 'unsettled' || r.outcome === 'inconclusive') || now.verdict === 'incomplete' ? 'incomplete' : 'accepted';
  const rules = new Set(runs.map((r) => r.rule));
  return { verdict, verifyIds: [...previous.verifyIds, ...now.verifyIds], runs, rule: rules.size === 1 ? [...rules][0]! : null, commands: [...previous.commands, ...now.commands], spent: previous.spent + now.spent, upstreamRequests: previous.upstreamRequests + now.upstreamRequests, reasons: [...previous.reasons, ...now.reasons] };
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
    const report = (session.kind === 'migrate' ? data.decisions : data) as { flagged?: string[]; change?: DecisionsChange; remedies?: DecisionRemedy[]; verify?: DecisionsVerify | null } | undefined;
    const flagged = report?.flagged ?? [];
    const change: Pick<DecisionsChange, 'model' | 'fields' | 'from'> = { model: report?.change?.model ?? null, fields: report?.change?.fields ?? {}, from: report?.change?.from ?? null };
    const named = (id: string, given: string) => id === given || (given.length >= 6 && id.startsWith(given));
    const missing = input.runs.filter((r) => !flagged.some((id) => named(id, r)));
    if (missing.length) throw new DecisionsError(`${missing.join(', ')}: no run ${session.sessionId} flagged has that id (it flags the runs with a write, stop or judged change: ${flagged.map((id) => id.slice(0, 10)).join(', ') || 'none'})`);
    const chosen = input.runs.length ? flagged.filter((id) => input.runs.some((r) => named(id, r))) : flagged;
    if (!chosen.length) throw new DecisionsError(`no run in ${session.sessionId} has a write, stop or judged change: there is nothing to verify`);

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
          throw new DecisionsError(`${golden}: ${(err as Error).message}`);
        }
      }
      const run = store.getRun(runId);
      if (!run) throw new DecisionsError(`${runId.slice(0, 10)}, which ${session.sessionId} names, is no longer in the store`);
      return storeTarget(store, run, cwd);
    };
    const targets = chosen.map(targetOf);
    // A run from someone's pack runs its recorded command only with a yes; a golden runs its pack's, as test runs it.
    const imported = input.settings.argv ? [] : targets.filter((t) => t.golden === null && commandIsImported(t.run));
    if (imported.length && !input.yes) throw new DecisionsError(`${imported.map((t) => `${t.run.runId.slice(0, 10)} came from ${importedCommandSource(t.run)}`).join('; ')}: verifying runs the command it was recorded with (${imported[0]!.run.command.argv.join(' ')}). Give --yes to run it, or your own command after --`);
    const remedies = report?.remedies ?? [];
    const verify = await verifyFlagged({
      opts: input.opts,
      store,
      flagged: targets,
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
      passes = passesOf(runs, flagged, merged, recorded);
      next = { ...data, decisions: { ...(data.decisions as Record<string, unknown>), verify: merged }, passes: { verdict: merged.verdict, runs: passes } };
    } else next = { ...data, verify: merged };
    store.putDecisionSession({ sessionId: session.sessionId, kind: session.kind, at: session.at, change: session.change, actor: session.actor, revision: session.revision, data: next, runs: session.runRows.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.rank, changed: r.changed, data: r.data })) });
    return { sessionId: session.sessionId, kind: session.kind, change: session.change, verify, passes };
  } finally {
    store.close();
  }
}
