import { migrateApplyProblem, migrateHeadline, sameModel, type MigrateApplyInput, type MigratePasses, type MigrateSetInput, type MigrationApplied, type StoreOf } from '@shadowlap/engine';

/**
 * A migration's applied state as the dashboard reads it: when its config change went into the
 * working tree, who put it there, and each golden it left behind with whether it still waits. The one
 * rule for a golden that waits is here, for a migration's page, Needs a look's retire row and Tests'
 * hint on a golden: a golden waits until a result of it at or after the apply passed, which
 * `test --update` writes once it re-records it.
 */

/** A golden the config change left behind: its name as the test history gives it, the call it diverged at, the request field (`$.model`), and whether it still waits. */
export interface AppliedGolden {
  golden: string;
  callNo: number;
  path: string;
  waits: boolean;
}

export interface AppliedState {
  at: number;
  /** Who applied it, only where checks are shared (a team store); null otherwise. */
  by: string | null;
  outdated: AppliedGolden[];
}

/** Whether a golden left behind at `since` still waits: no result of it at or after then passed. */
export const stillWaits = (store: StoreOf<'tests'>, golden: string, since: number): boolean => !store.listTestResults({ golden, since }).some((r) => r.ok);

/** A migration's applied state, each golden it left behind with whether it waits; null until applied. `shared`: names show. */
export function appliedState(store: StoreOf<'tests'>, applied: MigrationApplied | null | undefined, o: { shared?: boolean } = {}): AppliedState | null {
  if (!applied) return null;
  return { at: applied.at, by: o.shared ? applied.by : null, outdated: applied.outdated.map((g) => ({ ...g, waits: stillWaits(store, g.golden, applied.at) })) };
}

/** A golden an applied migration left waiting: the call it diverges at on `$.model`, the switch, and the migration. */
export interface GoldenLeftWaiting {
  golden: string;
  callNo: number;
  path: string;
  from: string[];
  to: string;
  migrationId: string;
}

/**
 * The goldens that applied migrations left waiting to be re-recorded, each once, from the newest
 * migration that left it behind: for a golden's Tests rows to say why it diverges on `$.model`.
 */
export function goldensLeftWaiting(store: StoreOf<'decisions' | 'tests'>): GoldenLeftWaiting[] {
  const seen = new Set<string>();
  const out: GoldenLeftWaiting[] = [];
  for (const row of store.listDecisionSessions({ kind: 'migrate', limit: 200 })) {
    if (!row.applied) continue;
    const kept = store.getDecisionSession(row.sessionId)?.data ?? {};
    const from = Array.isArray(kept.from) ? kept.from.filter((m): m is string => typeof m === 'string') : [];
    const to = typeof kept.to === 'string' ? kept.to : '';
    for (const g of row.applied.outdated) {
      if (seen.has(g.golden)) continue;
      seen.add(g.golden);
      if (stillWaits(store, g.golden, row.applied.at)) out.push({ ...g, from, to, migrationId: row.sessionId });
    }
  }
  return out;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * What `migrateApplyProblem` reads from a kept migration, its report as `migrate --json` printed it,
 * each part a migration kept before it had one read as missing: no runs passed, no config change,
 * no files.
 */
export function applyInputOf(kept: Record<string, unknown>): MigrateApplyInput {
  const passes = kept.passes as Partial<MigratePasses> | undefined;
  const set = (kept.set ?? {}) as Partial<MigrateSetInput>;
  const change = kept.configChange as MigrateApplyInput['configChange'] | undefined;
  const files = kept.files as MigrateApplyInput['files'] | undefined;
  return {
    migrateId: typeof kept.migrateId === 'string' ? kept.migrateId : typeof kept.sessionId === 'string' ? kept.sessionId : null,
    from: strings(kept.from),
    to: typeof kept.to === 'string' ? kept.to : '',
    stopReason: typeof kept.stopReason === 'string' ? kept.stopReason : null,
    passes: { verdict: passes?.verdict ?? 'not-run', runs: Array.isArray(passes?.runs) ? passes.runs : [] },
    configChange: change && Array.isArray(change.files) ? change : null,
    set: { fields: Array.isArray(set.fields) ? set.fields : [], given: set.given && typeof set.given === 'object' ? set.given : {}, ...(Array.isArray(set.byHand) ? { byHand: strings(set.byHand) } : {}) },
    files: files && typeof files.dir === 'string' ? { dir: files.dir, patch: typeof files.patch === 'string' ? files.patch : null } : null,
  };
}

/** A kept migration from a model: its id, its report, and its applied state. */
export interface MigrationFrom {
  sessionId: string;
  kept: Record<string, unknown>;
  applied: MigrationApplied | null;
}

/**
 * The newest migration from each of `models` (by `sameModel`, either way round), read newest first
 * from the 200 newest: a retiring model's row and Migrate's start page say whether one checked it.
 */
export function newestMigrationsFrom(store: StoreOf<'decisions'>, models: readonly string[]): Map<string, MigrationFrom> {
  const found = new Map<string, MigrationFrom>();
  for (const row of store.listDecisionSessions({ kind: 'migrate', limit: 200 })) {
    if (found.size === models.length) break;
    const open = models.filter((m) => !found.has(m));
    const kept = store.getDecisionSession(row.sessionId)?.data ?? {};
    const from = strings(kept.from);
    for (const m of open) if (from.some((f) => sameModel(f, m) || sameModel(m, f))) found.set(m, { sessionId: row.sessionId, kept, applied: row.applied });
  }
  return found;
}

/**
 * A retiring model's state once a migration checked it, as Needs a look's row says it: `checked ·
 * the config change is ready` where Apply is offered, else `checked · <its headline>`; `applied · 3
 * goldens to update` while any golden it left behind waits; null once applied with none waiting.
 */
export function checkedWords(store: StoreOf<'tests'>, m: MigrationFrom): string | null {
  if (m.applied) {
    const waits = m.applied.outdated.filter((g) => stillWaits(store, g.golden, m.applied!.at)).length;
    return waits ? `applied · ${waits} golden${waits === 1 ? '' : 's'} to update` : null;
  }
  const input = applyInputOf({ ...m.kept, sessionId: m.sessionId });
  if (!migrateApplyProblem(input)) return 'checked · the config change is ready';
  const runs = Array.isArray((m.kept.decisions as { runs?: unknown } | undefined)?.runs) ? ((m.kept.decisions as { runs: unknown[] }).runs.length) : input.passes.runs.length;
  const text = migrateHeadline({ from: input.from, to: input.to, runs, passes: input.passes }).text;
  return `checked · ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}
