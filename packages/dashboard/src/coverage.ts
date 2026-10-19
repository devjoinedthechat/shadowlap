import { describeBehaviour, OUTCOME_WORDS, quoteArgv, type Behaviour, type BehaviourOutcome, type CoverageScan, type Store, type StoredCoverageGroup } from '@shadowlap/engine';
import { splitCommandLine } from './settings.js';

/**
 * Production coverage as the dashboard shows it: the last `shadowlap coverage` scan, kept in the
 * store, read here as it was left (Tests' Not covered panel, and the line Needs a look shows). A scan
 * is the CLI's work: it reads the goldens on disk and every imported run, so the dashboard starts one
 * as a job (`coverage`) and never works it out on a request. What it adds is what has moved since:
 * imported runs that came in after the scan, and runs of a group gc has deleted since.
 */

/** One behaviour the last scan found, with what Pack one runs for it. */
export interface CoverageGroupView {
  key: string;
  covered: boolean;
  coveredBy: string[];
  path: string[];
  writes: string[];
  unknown: string[];
  outcome: string;
  /** The behaviour in one line: `lookup_order → issue_refund · writes issue_refund · answered`. */
  line: string;
  /** How it ended, in words. */
  ended: string;
  runs: number;
  /** Its runs as the scan listed them, newest first; `runId` is the newest still in the store. */
  runIds: string[];
  runId: string | null;
  sources: string[];
  firstSeen: number;
  lastSeen: number;
  nearest: StoredCoverageGroup['nearest'];
  packed: StoredCoverageGroup['packed'];
  /**
   * For a behaviour no golden covers: the job Pack one starts (`coverage-pack` with its key), the
   * command it runs, and the agent's command it would reproduce the capture with: the one a recording
   * here sent the same first request with, or null when nothing says, and the dialog asks for it.
   */
  pack: { key: string; args: string[]; command: string[] | null; commandFrom: string | null } | null;
}

/** The line Needs a look shows while some behaviour has no golden, in its rows' shape. */
export interface CoverageLook {
  kind: 'coverage';
  icon: 'rec';
  title: string;
  detail: string;
  action: string;
  href: string;
  runId: string | null;
  fixId: null;
  at: number;
}

export interface CoverageView {
  /** The last scan, or null when coverage never ran on this store. */
  scan: CoverageScan | null;
  /** Imported runs that came in after the scan: a scan now would read them too. */
  newRuns: number;
  /** Not covered first, as the scan ordered them. */
  groups: CoverageGroupView[];
  uncovered: number;
  needsLook: CoverageLook | null;
  /** What scanning again runs, and what packing every uncovered behaviour runs. */
  commands: { scan: string[]; pack: string[] };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Imported runs (captures, traces) that came in after `at`: by when they were imported, not when their traffic ran. */
function importedSince(store: Store, at: number): number {
  const row = store.query(
    `SELECT COUNT(*) AS n FROM runs WHERE mode = 'record' AND json_valid(meta) AND json_type(meta, '$.covers') = 'array' AND json_array_length(meta, '$.covers') > 0 AND json_extract(meta, '$.imported.at') > ?`,
    at,
  )[0];
  return Number(row?.n ?? 0);
}

export function coverageView(store: Store): CoverageView {
  const scan = store.listCoverageScans(1)[0] ?? null;
  const groups = scan ? store.coverageGroups() : [];
  const views = groups.map((g): CoverageGroupView => {
    const behaviour: Behaviour = { path: g.behaviour.path, writes: g.behaviour.writes, unknown: g.behaviour.unknown, outcome: g.behaviour.outcome as BehaviourOutcome };
    const present = g.runIds.map((id) => store.getRun(id)).filter((r) => r !== null);
    const covered = g.coveredBy.length > 0;
    // The command the scan found would reproduce the group's newest run, when a recording here says it.
    const pack: CoverageGroupView['pack'] = covered ? null : { key: g.key, args: ['coverage', '--pack', g.key], command: g.command?.argv ?? null, commandFrom: g.command?.from ?? null };
    return {
      key: g.key,
      covered,
      coveredBy: g.coveredBy,
      path: behaviour.path,
      writes: behaviour.writes,
      unknown: behaviour.unknown,
      outcome: behaviour.outcome,
      line: describeBehaviour(behaviour),
      ended: OUTCOME_WORDS[behaviour.outcome] ?? behaviour.outcome,
      runs: g.runs,
      runIds: g.runIds,
      runId: present[0]?.runId ?? null,
      sources: g.sources,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      nearest: g.nearest,
      packed: g.packed,
      pack,
    };
  });
  const uncovered = views.filter((g) => !g.covered);
  const newest = [...uncovered].sort((a, b) => b.lastSeen - a.lastSeen)[0];
  const needsLook: CoverageLook | null = newest
    ? {
        kind: 'coverage',
        icon: 'rec',
        title: `${plural(uncovered.length, 'behaviour')} seen in production ${uncovered.length === 1 ? 'has' : 'have'} no golden`,
        detail: `the newest: ${newest.path.length ? newest.path.slice(0, 3).join(' → ') + (newest.path.length > 3 ? ' → …' : '') : 'no tool calls'}${newest.sources[0] ? `, in ${newest.sources[0]}` : ''}`,
        action: 'Open',
        href: '#/tests',
        runId: newest.runId,
        fixId: null,
        at: scan!.at,
      }
    : null;
  return { scan, newRuns: scan ? importedSince(store, scan.at) : 0, groups: views, uncovered: uncovered.length, needsLook, commands: { scan: ['coverage'], pack: ['coverage', '--pack'] } };
}

/** `coverage-pack`'s request, checked: the behaviour (a key the last scan has, not covered), and the agent's command as typed. */
export function coveragePackArgs(store: Store, req: Record<string, unknown>): { args: string[]; title: string } | { error: string } {
  const groups = store.coverageGroups();
  let keys: string[] = [];
  if (req.key !== undefined) {
    if (typeof req.key !== 'string' || !/^[0-9a-f]{4,16}$/.test(req.key)) return { error: 'key is a behaviour as the last coverage scan names it (16 hex characters)' };
    const g = groups.find((x) => x.key.startsWith(req.key as string));
    if (!g) return { error: `the last coverage scan has no behaviour ${req.key}: scan again` };
    if (g.coveredBy.length) return { error: `behaviour ${g.key} is covered already, by ${g.coveredBy.join(', ')}` };
    keys = [g.key];
  } else if (!groups.some((g) => !g.coveredBy.length)) return { error: 'every behaviour the last scan found has a golden: nothing to pack' };
  let command: string[] = [];
  if (req.command !== undefined && req.command !== null && req.command !== '') {
    if (typeof req.command !== 'string' || req.command.length > 4096) return { error: "command is the agent's command line, as you'd type it" };
    try {
      command = splitCommandLine(req.command);
    } catch (err) {
      return { error: `command: ${(err as Error).message}` };
    }
  }
  const args = ['coverage', '--pack', ...keys, ...(command.length ? ['--', ...command] : [])];
  return { args, title: keys.length ? `Packing a golden of ${keys[0]!.slice(0, 8)}${command.length ? ` with ${quoteArgv(command)}` : ''}` : 'Packing goldens of what no golden covers' };
}
