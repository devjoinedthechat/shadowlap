import { checkCommandTemplate, describeBehaviour, messageOf, NO_COMMAND, OUTCOME_WORDS, packingBehaviour, type Behaviour, type BehaviourOutcome, type CoverageScan, type StoreOf, type StoredCoverageGroup, type StoredCoveragePack } from '@shadowlap/engine';
import { expectArgs } from './expect-field.js';
import { splitCommandLine } from './settings.js';
import { links } from './links.js';
import { answer, type ReadTable } from './read-registry.js';

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
  /** Its runs as the scan listed them, newest first; `kept`, those still in the store, which Seen links; `runId`, the newest of them. */
  runIds: string[];
  kept: string[];
  runId: string | null;
  sources: string[];
  firstSeen: number;
  lastSeen: number;
  nearest: StoredCoverageGroup['nearest'];
  packed: StoredCoverageGroup['packed'];
  /**
   * What `coverage --pack` last made of it: the golden and whether it forks, or why it couldn't pack
   * it, and `by`, who tried a pack that couldn't (where the store names people: `shared`), else null.
   */
  lastPack: (Pick<StoredCoveragePack, 'at' | 'golden' | 'mode' | 'reason' | 'why' | 'command'> & { by: string | null }) | null;
  /**
   * For a behaviour no golden covers: the job Pack one starts (`coverage-pack` with its key), the
   * command it runs, and the agent's command it would reproduce the capture with: the one a run here
   * sent the same first request with, or null when nothing says, and the dialog asks for it (with
   * `{message}` where the agent's input goes). `forkable` when the last `--pack` found the agent no
   * longer does this: Keep it as a test then packs it as a golden that forks, with the checks the
   * dialog asks for (`fork: true, expect`).
   */
  pack: { key: string; args: string[]; command: string[] | null; commandFrom: string | null; forkable: boolean } | null;
}

/** The line Needs a look shows while some behaviour has no golden, in its rows' shape. */
export interface CoverageLook {
  kind: 'coverage';
  icon: 'cap';
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
  /** Imported runs that came in after the scan (every one, before a first scan): a scan now would read them too. */
  newRuns: number;
  /** Not covered first, as the scan ordered them. */
  groups: CoverageGroupView[];
  uncovered: number;
  needsLook: CoverageLook | null;
  /** What scanning again runs, and what packing every uncovered behaviour runs. */
  commands: { scan: string[]; pack: string[] };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * Imported runs (captures, traces) that came in after `at`: by when they were imported, not when
 * their traffic ran. As the scan reads them: with no command of their own (a golden made of a
 * capture, unpacked by a test, is no traffic).
 */
function importedSince(store: StoreOf<'readModels'>, at: number): number {
  const row = store.query(
    `SELECT COUNT(*) AS n FROM runs WHERE mode = 'record' AND json_valid(meta) AND json_type(meta, '$.covers') = 'array' AND json_array_length(meta, '$.covers') > 0 AND json_extract(meta, '$.imported.at') > ?
       AND json_valid(command) AND json_extract(command, '$.argv[0]') = ?`,
    at,
    NO_COMMAND,
  )[0];
  return Number(row?.n ?? 0);
}

/**
 * Who tried each pack that couldn't pack its behaviour, where the store names people: the actor of
 * the first scan at or after it whose not-packed list names the behaviour (`--pack` scans again once
 * it has tried). A scan from before the pack names nobody. Only the scans since the oldest such pack
 * are read, a row each.
 */
function packTriers(store: StoreOf<'coverage'>, packs: readonly StoredCoveragePack[], shared: boolean): Map<string, string> {
  const failed = packs.filter((p) => p.golden === null);
  const out = new Map<string, string>();
  if (!shared || !failed.length) return out;
  const scans = store.coverageScansSince(Math.min(...failed.map((p) => p.at)));
  for (const p of failed) {
    const scan = scans.find((s) => s.at >= p.at && !!s.data?.notPacked?.some((n) => n.key === p.key));
    if (scan?.actor) out.set(p.key, scan.actor);
  }
  return out;
}

/** The coverage view; `shared`: the store names people (namesTeamStore), so Last tried says who tried a pack. */
export function coverageView(store: StoreOf<'recording' | 'readModels' | 'coverage'>, o: { shared?: boolean } = {}): CoverageView {
  const scan = store.listCoverageScans(1)[0] ?? null;
  const groups = scan ? store.coverageGroups() : [];
  const kept = store.coveragePacks();
  const packs = new Map(kept.map((p) => [p.key, p]));
  const by = packTriers(store, kept, !!o.shared);
  const views = groups.map((g): CoverageGroupView => {
    const behaviour: Behaviour = { path: g.behaviour.path, writes: g.behaviour.writes, unknown: g.behaviour.unknown, outcome: g.behaviour.outcome as BehaviourOutcome };
    const present = g.runIds.map((id) => store.getRun(id)).filter((r) => r !== null);
    const covered = g.coveredBy.length > 0;
    // The command the scan found would reproduce the group's newest run, when a recording here says it.
    const last = packs.get(g.key) ?? null;
    const pack: CoverageGroupView['pack'] = covered ? null : { key: g.key, args: ['coverage', '--pack', g.key], command: g.command?.argv ?? null, commandFrom: g.command?.from ?? null, forkable: last?.reason === 'not-reproduced' };
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
      kept: present.map((r) => r.runId),
      runId: present[0]?.runId ?? null,
      sources: g.sources,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      nearest: g.nearest,
      packed: g.packed,
      lastPack: last ? { at: last.at, golden: last.golden, mode: last.mode, reason: last.reason, why: last.why, command: last.command, by: by.get(last.key) ?? null } : null,
      pack,
    };
  });
  const uncovered = views.filter((g) => !g.covered);
  const newest = [...uncovered].sort((a, b) => b.lastSeen - a.lastSeen)[0];
  const needsLook = newest ? lookOf(uncovered.length, newest, newest.runId, scan!.at) : null;
  // Before a first scan, every imported run is new: Not covered tells nothing to read apart from runs not read yet.
  return { scan, newRuns: importedSince(store, scan?.at ?? 0), groups: views, uncovered: uncovered.length, needsLook, commands: { scan: ['coverage'], pack: ['coverage', '--pack'] } };
}

/**
 * Tests' Not covered, read beside the server (`GET /api/coverage`): it counts the imported runs no
 * scan has read, a JSON read of every recording no index serves, and reads each behaviour's runs.
 * Whether the store names people is worked out on the server's thread (namesTeamStore).
 */
export type CoverageViewJob = { kind: 'coverage-view'; shared: boolean };

export const COVERAGE_READS: ReadTable<CoverageViewJob> = {
  'coverage-view': (store, job) => answer(coverageView(store, { shared: job.shared }), { tagged: true }),
};

/**
 * The line Needs a look shows while some behaviour seen in production has no golden: how many, and
 * the newest of them; it opens Tests at Not covered, which lists them. `runId` is the newest run of
 * the newest behaviour still in the store.
 */
function lookOf(count: number, newest: { path: readonly string[]; sources: readonly string[] }, runId: string | null, at: number): CoverageLook {
  return {
    kind: 'coverage',
    icon: 'cap',
    title: `${plural(count, 'behaviour')} seen in production ${count === 1 ? 'has' : 'have'} no golden`,
    detail: `the newest: ${newest.path.length ? newest.path.slice(0, 3).join(' → ') + (newest.path.length > 3 ? ' → …' : '') : 'no tool calls'}${newest.sources[0] ? `, in ${newest.sources[0]}` : ''}`,
    action: 'Open',
    href: links.tests({ at: 'notcovered' }),
    runId,
    fixId: null,
    at,
  };
}

/**
 * Needs a look's coverage line on its own, as the Overview reads it on every load: the last scan's
 * groups no golden covers, without working out every group's view; null before a scan, or once
 * every behaviour has a golden.
 */
export function coverageLook(store: StoreOf<'recording' | 'coverage'>): CoverageLook | null {
  return coverageNewest(store)?.look ?? null;
}

/**
 * The coverage line, with the key of the newest behaviour no golden covers, which Needs a look keys
 * its row by and packs; `forkable` when the last `--pack` of it found the agent no longer does it (it
 * then packs as a golden that forks, with checks), and `uncovered`, every such behaviour's key.
 */
export function coverageNewest(store: StoreOf<'recording' | 'coverage'>): { look: CoverageLook; key: string; forkable: boolean; uncovered: string[] } | null {
  const scan = store.listCoverageScans(1)[0] ?? null;
  if (!scan) return null;
  const uncovered = store.coverageGroups().filter((g) => !g.coveredBy.length);
  const newest = [...uncovered].sort((a, b) => b.lastSeen - a.lastSeen)[0];
  if (!newest) return null;
  const runId = newest.runIds.find((id) => store.getRun(id) !== null) ?? null;
  const forkable = store.coveragePacks().find((p) => p.key === newest.key)?.reason === 'not-reproduced';
  return { look: lookOf(uncovered.length, { path: newest.behaviour.path, sources: newest.sources }, runId, scan.at), key: newest.key, forkable, uncovered: uncovered.map((g) => g.key) };
}

/** What `coverage-pack` runs, checked, and the command it asks about before it runs it. */
export interface CoveragePackPlan {
  args: string[];
  title: string;
  /** The agent's command as typed, split: it runs only once confirmed, as a recording's does. */
  command: string[] | null;
}

/**
 * `coverage-pack`'s request, checked: the behaviour (a key the last scan has, not covered), the
 * agent's command as typed (its `{message}` checked as the CLI checks it), and, to pack it as a
 * golden that forks, `fork: true` with the checks (`expect`) that say what it must do instead. A
 * golden that forks is one somebody chose: it needs a key.
 */
export function coveragePackArgs(store: StoreOf<'coverage'>, req: Record<string, unknown>): CoveragePackPlan | { error: string } {
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
      return { error: `command: ${messageOf(err)}` };
    }
    const template = checkCommandTemplate(command);
    if (template) return { error: `command: ${template}` };
  }
  const fork: string[] = [];
  if (req.fork !== undefined && req.fork !== false) {
    if (req.fork !== true) return { error: 'fork is true, to pack it as a golden that forks' };
    if (!keys.length) return { error: 'a golden that forks is packed for one behaviour: name it by its key' };
    const expect = typeof req.expect === 'string' ? safeJson(req.expect) : req.expect;
    if (typeof expect !== 'object' || expect === null || Array.isArray(expect) || !Object.keys(expect).length) return { error: 'a golden that forks needs the checks that say what the agent must do now, such as {"tools":{"issue_refund":0}}' };
    // Checked as `--expect` is, so a check the CLI would refuse is refused here, in its words.
    const checked = expectArgs(expect);
    if ('error' in checked) return checked;
    fork.push('--fork', ...checked.args);
  } else if (req.expect !== undefined) return { error: 'expect goes with fork: a golden that replays its capture is judged by the replay itself' };
  const args = ['coverage', '--pack', ...keys, ...fork, ...(command.length ? ['--', ...command] : [])];
  // The command shows on the drawer's own line, so the title names only the behaviour.
  const title = keys.length ? packingBehaviour(keys[0]!.slice(0, 8), fork.length > 0) : 'Packing goldens of what no golden covers';
  return { args, title, command: command.length ? command : null };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
