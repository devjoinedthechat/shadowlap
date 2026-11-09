import { decisionsName, decisionsUnsettled, migrateBreaks, migrateUnsettled, unsettledRun, type DecisionRun, type DecisionsReport, type MigratePasses } from '@shadowlap/engine';

/** A report as keepDecisions takes it: a preview's, or a migration's with its preview's runs beside it. */
export type KeptReport = Record<string, unknown> & { runs: DecisionRun[]; flagged: string[]; change: { text: string } };

/**
 * What a kept preview or migration says in its `decisions.done` or `migrate.done` event (the
 * contract in packages/engine/src/events.ts): the change in words and by name (`decisionsName`), the
 * runs it asked and flagged, what it spent asking, judging and verifying, and why it settled
 * nothing (`decisionsUnsettled`, `migrateUnsettled`), null when it settled. `exit` is the status it
 * ends with under the defaults: 1 when verify rejected it or the switch breaks a run, else 3 when
 * it settled nothing, else 0 (`--strict` and `--inconclusive` are the command's, not the session's).
 */
export function sessionEventData(report: KeptReport, kind: 'decisions' | 'migrate'): Record<string, unknown> {
  const r = report as Partial<DecisionsReport> & { costs?: { checking?: { decisions: number; verify: number; judge?: number } }; passes?: MigratePasses; from?: string[]; to?: string; decisions?: Partial<DecisionsReport> };
  const checking = r.costs?.checking;
  const spent = checking ? checking.decisions + checking.verify + (checking.judge ?? 0) : (r.cost?.spent ?? 0) + (r.verify?.spent ?? 0) + (r.judge?.spent ?? 0);
  const stopReason = r.stopReason ?? null;
  const passes = r.passes;
  const why = kind === 'migrate' ? (passes ? migrateUnsettled({ stopReason, passes }) : null) : decisionsUnsettled({ stopReason, flagged: report.flagged, toVerify: r.toVerify ?? null, runs: report.runs.map(unsettledRun), verify: r.verify ?? null });
  const broke = kind === 'migrate' ? !!passes && migrateBreaks(passes) : r.verify?.verdict === 'rejected';
  const change = ((kind === 'migrate' ? r.decisions?.change : r.change) ?? null) as NonNullable<Parameters<typeof decisionsName>[0]['change']> | null;
  return { change: report.change.text, name: decisionsName({ kind, change, from: r.from ?? null, to: r.to ?? null }), runs: report.runs.length, flagged: report.flagged.length, spent, why, exit: broke ? 1 : why ? 3 : 0 };
}
