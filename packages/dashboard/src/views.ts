/**
 * The shapes the dashboard's API answers with, beyond the run and call views in `api.ts`. Types
 * only and no imports: the browser code type-checks against this file, and `api.ts` re-exports
 * everything here.
 */

/** A link a job or an activity entry offers: a label and a dashboard route such as `#/run/<id>`. */
export interface JobLink {
  label: string;
  href: string;
  /** Beside the job's primary action rather than one of its own: the drawer shows it as a plain link. */
  secondary?: boolean;
}

/**
 * Something a job wrote inside the project folder. A file downloads from `GET /api/files/<fileId>`
 * (with the session token, as an attachment); a folder, such as a pack, is only named.
 */
export interface JobFile {
  fileId: string;
  /** Its name, for the drawer and the download. */
  name: string;
  /** Its path relative to the project folder, with `/` separators. */
  path: string;
  /** What the command called it ("Pack", "Dataset"), or null. */
  label: string | null;
  /** Its size; null for a folder. */
  bytes: number | null;
  /** A folder: named in the drawer, not downloadable. */
  directory: boolean;
}

/**
 * A job as `GET /api/jobs/:id?after=n` returns it: the CLI run the dashboard started, and what it
 * made. While it runs, poll this (every half second or so) with `after` set to the last `total`:
 * output lines do not show in the change feed.
 */
export interface JobView {
  id: string;
  /** The registered kind it was started as: `action` for the run actions, then `blame`, `import`, … */
  kind: string;
  /** What the drawer calls it: "Replaying", "Forking", "Importing a capture". */
  title: string;
  /** The CLI arguments the server built (never sent by the browser), without the `--db` it adds. */
  args: string[];
  /**
   * How it uses its project's working tree, the agent's files: `writes` (repair, fix apply) runs
   * alone in it, `reads` (an agent run from them) never alongside one that writes; `doing` says what
   * it is doing there, and `folder` is the folder it runs in (null: the dashboard's own). Null when
   * it runs no agent. See worktree.ts.
   */
  worktree: { use: 'reads' | 'writes'; doing: string; folder: string | null } | null;
  /** The run the job is about (full id), or null when it is about none (an import, the tests). */
  runId: string | null;
  /** Whether the job makes a run to open when it ends. */
  opensRun: boolean;
  startedAt: number;
  endedAt: number | null;
  done: boolean;
  /** Someone asked it to stop (`POST /api/jobs/:id/stop`): its end is that stop, not its own. */
  stopped: boolean;
  /** The exit code; null while running, or when the process was killed by a signal. */
  code: number | null;
  /** The run to open: the last one the job reported that is not an attempt (or found in its output). */
  newRunId: string | null;
  /** Every run the job made, attempts included, in the order it reported them. */
  runs: string[];
  /** Where to go next: the new run, the fix, Tests, the scores. */
  links: JobLink[];
  /** Files and folders it wrote inside the project folder. */
  files: JobFile[];
  /** The last structured result the CLI reported (what `--json` prints, a verdict), or null. */
  result: unknown;
  /** Output lines from `after` on, ANSI colours removed. */
  lines: string[];
  /** Output lines so far, counted from the first (the job keeps the last 2,000): pass it as `after`. */
  total: number;
  /**
   * On a dashboard that serves several projects, the project the job runs in: its runs and links are
   * that project's, so a page showing another one switches before it opens them.
   */
  project?: { id: string; name: string };
}

/** A job in `GET /api/jobs` (`{ jobs }`, newest first): everything but its output and its result, which `GET /api/jobs/:id` has. */
export type JobListItem = Omit<JobView, 'lines' | 'result'>;

/** A run recording now, with its calls so far. */
export interface LiveRun {
  runId: string;
  calls: number;
  /**
   * Its call events, starts and answers: moves when a call starts and when one is answered, so a
   * recording's page asks for what changed, its newest calls, and nothing when another run records.
   */
  events?: number;
}

/** The project folder the dashboard works in: jobs run there, uploads and exports are kept there. */
export interface ProjectView {
  /** The folder's name. */
  name: string;
  /** Its absolute path. */
  path: string;
  /** Its id in the dashboard's project list, on a dashboard that serves several (`GET /api/projects`). */
  id?: string;
  /** Its folder as the switcher shows it: `~/support-agent`. */
  display?: string;
  /** Its setup isn't finished: once it has runs, the Overview shows the setup. */
  settingUp?: boolean;
  /**
   * Why its store can't be opened (its folder is gone, or the store is from a newer Shadowlap): the
   * dashboard shows an empty stand-in for it, and refuses its jobs with this reason.
   */
  problem?: string;
  /** Its folder is gone from disk (with `problem`): Settings changes nothing in it until it is back. */
  missing?: boolean;
  /** Part of the dashboard couldn't start for this project (a feature's module failed): what failed, for the switcher to say. */
  notice?: string;
}

/** `GET /api/meta`: what the shell needs once, and the status bar. */
export interface MetaView {
  version: string | null;
  /** The store file, or null for a store in memory or an exported copy. */
  dbPath: string | null;
  /** Whether actions can run: started by `shadowlap dashboard`, and not read-only. */
  actions: boolean;
  /** Nothing can be changed from here: every page shows, actions are disabled with `readOnlyReason`. */
  readOnly: boolean;
  /** Why it is read-only, for the disabled actions' hover; null when it is not. */
  readOnlyReason: string | null;
  /** Where it listens, such as "127.0.0.1:4777"; null in an exported copy. */
  address: string | null;
  /** The store's size on disk (database and write-ahead log), or null. */
  storeBytes: number | null;
  /** Runs (attempts left out, as the run count shows them) and attempts (`--repeat`, blame probes, verify). */
  counts: { runs: number; attempts: number };
  /** Runs recording now. */
  live: LiveRun[];
  /** The job kinds `POST /api/jobs` accepts. */
  jobKinds: string[];
  /** The most `POST /api/uploads` takes, in bytes; null when uploads are not possible (no project folder, read-only, an exported copy). */
  uploadLimit: number | null;
  /** The project folder, or null. */
  project: ProjectView | null;
  /** An exported HTML copy: recorded data only, no server behind it. */
  static?: boolean;
  exportedAt?: number;
  redacted?: boolean;
  /** An exported copy: how many redaction rules were applied to it (0: none, so it holds what was recorded). */
  redactedRules?: number;
  runIds?: string[];
  /**
   * Compare in an exported copy: the run every comparison it holds includes, when it holds too many
   * runs to compare every pair; null or absent when every pair is in it.
   */
  compareWith?: string | null;
}

/** The icon an activity entry shows, as in the mock (each comes with its words beside it or on hover). */
/** `warn`: neither passed nor failed, as an inconclusive test. */
export type ActivityIcon = 'live' | 'rec' | 'fail' | 'warn' | 'clean' | 'fork' | 'cap' | 'test' | 'blame' | 'fixok' | 'fixbad' | 'project' | 'setting' | 'train';

/** One entry of the activity feed. */
export interface ActivityItem {
  /** Stable across requests: `e:<event id>` for a stored event, `r:<run id>:<what>` or `g:<group>` for one derived from runs. */
  id: string;
  at: number;
  /** The icon. */
  kind: ActivityIcon;
  /** What happened, in the mock's words: "Replay clean · 30/30 · 0 upstream". */
  text: string;
  /** The run it is about. */
  runId?: string;
  /** Where it opens: a dashboard route. */
  href?: string;
  /** Who did it: SHADOWLAP_AUTHOR, `ci`, a git email or an OS user. */
  actor?: string;
  /** The short code shown at the end: a run id, a file, a rule. */
  ref?: string;
  /** The run it is about is recording now (a "Recording started" dot pulses only then). */
  live?: boolean;
  /** The rule of the gate whose verdict it says, for its hover (decision 9: the line says the verdict, the tally and the bound). */
  rule?: string;
}

/**
 * `GET /api/activity?limit=&before=`: newest first, `limit` entries a page (50 by default, at most
 * 200). Pass `next` back as `before` for the page after; `before` also takes a time in milliseconds
 * (everything older than it).
 */
export interface ActivityPage {
  items: ActivityItem[];
  /** Opaque: where this page ended. Null on the last page. */
  next: string | null;
}

/**
 * `GET /api/changes?since=<cursor>`: whether anything the UI shows changed since the cursor. Poll it
 * (every 2 s is plenty; it reads two tiny tables) and refetch only what it names; ETags make most
 * refetches a 304 anyway. Without `since`, or with a cursor from before a restart, everything counts
 * as changed.
 */
export interface ChangesView {
  /** Opaque. Pass it back as `since`. */
  cursor: string;
  /** False when nothing changed since `since`. */
  changed: boolean;
  /** A run was added, ended, deleted, labelled, noted, blamed or otherwise updated: refetch `/api/runs`, open runs, `/api/meta` and `/api/activity` (much of the feed comes from runs). */
  runs: boolean;
  /** A call was recorded: a live run grew. `live` says which runs are recording and how many calls each has. */
  calls: boolean;
  /** An activity event was stored (a normalizer added, a golden packed): refetch `/api/activity`. */
  events: boolean;
  /**
   * A job started, ended, or reported a run, link, file or result: refetch `/api/jobs` or the open
   * job. Output lines do not count: follow a running job's output with `GET /api/jobs/:id?after=n`.
   */
  jobs: boolean;
  /** Other counted tables that changed, by name (features add their own: `fixes`, `tests`, …). */
  other: string[];
  /** Runs recording now, with their call counts: enough for the live chip and counters without a refetch. */
  live: LiveRun[];
}

/** `POST /api/uploads`: a file stored for a job to use, by its id. */
export interface UploadView {
  uploadId: string;
  /** The name it was stored under (letters, digits, `.`, `_`, `-`). */
  name: string;
  bytes: number;
}
