import {
  ACTIONS,
  AGENT_NODE_MIN,
  confirmWords,
  UPSTREAM_ENV,
  defaultGolden,
  nameConfirms,
  nodePinTooOld,
  quoteArgv,
  setupCommands,
  stageAtLeast,
  tildePath,
  unwrappedTools,
  type CalibrationOutcome,
  type EffectiveSetup,
  type FolderKind,
  type FolderSuggestions,
  type ProjectEntry,
  type RunTotals,
  type SetupTool,
  type StoredEvent,
  type WrapSnippet,
} from '@shadowlap/engine';
import { projectInitial as initial } from './project-initial.js';
import { SETUP_INTRO } from './setup-words.js';
import { links } from './links.js';

/**
 * The dashboard's read model for projects: plain data for the project switcher, the Add project
 * page, a project's setup and the Remove dialog, built from the project list and what each store
 * says. No HTTP and no file access here: the server gathers the inputs (the registry, store facts
 * and counts from `ProjectHost`, folder suggestions) and these functions decide what the screens
 * say, in the mock's words. `home` is the home folder's real path (`ProjectRegistry.realHome`), as
 * project paths are real paths: paths under it show as `~/…`.
 */

/** What the switcher and the Remove dialog need from a project's store and folder (`ProjectHost.stats()` gives all of it). */
export interface ProjectStats {
  /** Runs, attempts left out. */
  runs: number;
  attempts: number;
  /** Goldens in the project's repository. */
  goldens: number;
  /** The folder is gone from disk. */
  missing?: boolean;
  /** Its setup shows, as `deriveSetup` has it (a finished project with no runs left starts again); without it, what the list says. */
  settingUp?: boolean;
  /** Why its store can't be read: the switcher says so rather than "no runs yet". */
  unreadable?: string | null;
  /** Folders beside the store with what was made from its runs (`.shadowlap/repairs`, …), which deleting the recordings leaves. */
  madeFiles?: readonly string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const runsLabel = (n: number) => (n ? plural(n, 'run') : 'no runs yet');
/** `≈$0.041`, as the mock writes a cost. */
/** A recording's cost as the CLI prints it: `≈$0.041`, and `≈<$0.001` for less than a tenth of a cent. */
const approx = (usd: number) => (!usd ? '$0' : usd < 0.0005 ? '≈<$0.001' : `≈$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`);
/** `38.2 s`, `1m 5s`, as the mock writes a duration. */
const duration = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
/** `a`, `a and b`, `a, b and c`. */
const listed = (items: readonly string[]) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`);
/** A run id as the setup shows it: the first ten characters, which every command takes. */
const short = (runId: string) => runId.slice(0, 10);

// ---------------------------------------------------------------------------------------------
// The project switcher

export interface SwitcherItem {
  id: string;
  name: string;
  /** `~/triage-bot` */
  path: string;
  initial: string;
  runs: number;
  current: boolean;
  /** Its setup isn't finished. */
  settingUp: boolean;
  /** Its folder is gone from disk. */
  missing: boolean;
  /** Its store can't be read (from a newer shadowlap, or not a database): `why` says so, on hover. */
  unreadable: boolean;
  why?: string;
  /** What a row of the switcher says at its right: `2 runs`, `setting up`, `folder not found`; its folder is on its hover card. */
  detail: string;
  /** The × that removes it: shown only while there is more than one project. */
  removable: boolean;
  removeLabel: string;
}

export interface SwitcherView {
  /** The sidebar's button: the current project. */
  current: SwitcherItem;
  heading: string;
  items: SwitcherItem[];
  add: { label: string; hint: string; href: string };
  note: string;
}

/** The switcher at the top of the sidebar: every project with its path and runs, the current one marked. */
export function projectSwitcher(input: { projects: readonly ProjectEntry[]; current: string; stats: Readonly<Record<string, ProjectStats>>; home: string }): SwitcherView {
  const removable = input.projects.length > 1;
  const items = input.projects.map((p): SwitcherItem => {
    const stats = input.stats[p.id] ?? { runs: 0, attempts: 0, goldens: 0 };
    const path = tildePath(p.path, input.home);
    const settingUp = stats.settingUp ?? p.setup.stage !== 'done';
    const missing = !!stats.missing;
    const unreadable = !missing && !!stats.unreadable;
    return {
      id: p.id,
      name: p.name,
      path,
      initial: initial(p.name),
      runs: stats.runs,
      current: p.id === input.current,
      settingUp,
      missing,
      unreadable,
      detail: missing ? 'folder not found' : unreadable ? 'store can’t be read' : settingUp ? 'setting up' : runsLabel(stats.runs),
      ...(unreadable ? { why: stats.unreadable! } : {}),
      removable,
      removeLabel: `Remove project ${p.name}`,
    };
  });
  const current = items.find((i) => i.current) ?? items[0];
  if (!current) throw new Error('the dashboard always has a project');
  return {
    current,
    heading: 'Projects on this machine',
    items,
    add: { label: 'Add project…', hint: 'A folder with your agent’s code', href: links.newProject() },
    note: 'Each project keeps its own store.',
  };
}

// ---------------------------------------------------------------------------------------------
// Add project (#/new)

export interface AddFolderItem {
  /** The real path: what Add sends. */
  path: string;
  /** `~/research-agent` */
  display: string;
  name: string;
  kind: string | null;
  /** The line under the path: `Python · uv · pyproject.toml`, `already added`, `no project files found`. */
  note: string;
  added: boolean;
  /** Already added: it can't be picked. A folder without project files can, to say why it can't be added. */
  disabled: boolean;
  selected: boolean;
}

export interface AddProjectView {
  eyebrow: string;
  title: string;
  intro: string;
  field: { label: string; placeholder: string; value: string };
  /** The folder whose subfolders are listed: `~/code/`. */
  listed: string | null;
  folders: AddFolderItem[];
  /** In place of an empty list: nothing matched, or why nothing is listed. */
  empty: string | null;
  truncated: boolean;
  /** Why the picked folder can't be added. */
  error: string | null;
  /**
   * Names the folder once one that can be added is picked, by its name (`Add research-agent`), with
   * the whole path as its `title`: a long path never widens the button. Disabled until then.
   */
  button: { label: string; disabled: boolean; path: string | null; title: string | null };
  cancel: { label: string; href: string };
  next: { title: string; steps: Array<{ title: string; text: string }>; note: string };
}

/** A folder's own name, the last part of its path (either separator): `research-agent`. */
const folderName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

/** The folder picked on the page, as the server checked it. */
export interface PickedFolder {
  path: string;
  folder: FolderKind;
  added?: boolean;
}

/** Add project: the folder field, its suggestions, the picked folder, and what happens next. */
export function addProjectPage(input: { query: string; suggestions: FolderSuggestions; picked?: PickedFolder | null; home: string }): AddProjectView {
  const picked = input.picked ?? null;
  const folders = input.suggestions.folders.map(
    (f): AddFolderItem => ({
      path: f.path,
      display: f.display,
      name: f.name,
      kind: f.folder.kind,
      note: f.added ? 'already added' : f.folder.kind ? f.folder.label : 'no project files found',
      added: f.added,
      disabled: f.added,
      selected: picked?.path === f.path,
    }),
  );
  // As the design lists them: folders that can be added first, then those already added, then those without project files.
  const rank = (f: AddFolderItem) => (f.added ? 1 : f.kind ? 0 : 2);
  folders.sort((a, b) => rank(a) - rank(b));
  const pickedDisplay = picked ? tildePath(picked.path, input.home) : null;
  const addable = !!picked && !!picked.folder.kind && !picked.added;
  const error = !picked ? null : picked.added ? `${pickedDisplay!} is already in the dashboard.` : picked.folder.kind ? null : (picked.folder.why ?? `${pickedDisplay!} has no project files.`);
  const query = input.query.trim();
  return {
    eyebrow: 'projects',
    title: confirmWords(ACTIONS.addProject.label),
    intro: 'Pick the folder your agent’s code is in. Nothing runs until you click.',
    field: { label: 'Folder', placeholder: '~/path/to/your/agent', value: input.query },
    listed: input.suggestions.listed,
    folders,
    empty: folders.length ? null : (input.suggestions.note ?? (query ? `No folder matches “${query}”.` : 'No folders here.')),
    truncated: input.suggestions.truncated,
    error,
    button: addable ? { label: `Add ${folderName(picked.path) || pickedDisplay!}`, disabled: false, path: picked.path, title: pickedDisplay } : { label: 'Add project', disabled: true, path: null, title: null },
    cancel: { label: 'Cancel', href: links.overview() },
    next: {
      title: 'What happens next',
      steps: [
        { title: 'Inspect', text: 'Reads the folder for SDKs, the start command and tools. Runs nothing.' },
        { title: 'Record', text: 'Runs your command once, after you confirm it.' },
        { title: 'Calibrate', text: 'Replays offline until the replay is clean.' },
        { title: 'Pack', text: 'Packs the run for CI to replay on every commit.' },
      ],
      note: 'The dashboard runs a command in a project’s folder only when you click, and asks first the first time.',
    },
  };
}

/** The toast after adding: a folder added again says its runs came back, one recorded in a terminal how many it has. */
export function addedMessage(added: { project: ProjectEntry; again: boolean; runs: number }, home: string): string {
  const path = tildePath(added.project.path, home);
  return added.again ? `Added ${path} back · ${plural(added.runs, 'run')}` : added.runs ? `Added ${path} · ${plural(added.runs, 'run')}` : `Added ${path}`;
}

// ---------------------------------------------------------------------------------------------
// Setting a project up

/** `skipped`: the setup went past this step without it (Skip setup, or a later step done in a terminal). */
export type StepState = 'done' | 'current' | 'todo' | 'skipped';

interface StepBase {
  n: 1 | 2 | 3 | 4;
  title: string;
  state: StepState;
  /** The commands to run it in a terminal instead ("or in a terminal"); empty once it is done. */
  cli: string[];
}

export interface FindingRow {
  label: string;
  value: string;
  /** Shown as code: the command. */
  code: boolean;
  small: string | null;
}

export interface ToolRow {
  name: string;
  effect: SetupTool['effect'];
  wrapped: boolean;
  /** `wrapped · effect declared`, or `not wrapped · suggested write, "save" changes something`. */
  text: string;
  /** Where an unwrapped tool is defined: `research_agent/tools.py:41`. */
  at: string | null;
}

export interface InspectStep extends StepBase {
  key: 'inspect';
  /** Before it runs: what it does. */
  text: string | null;
  /** Runs `init` (again). */
  button: { label: string; action: 'init'; lime: boolean } | null;
  findings: { rows: FindingRow[]; tools: ToolRow[] } | null;
  /**
   * Once inspected, the findings fold into one line, so the step at hand comes next on the page:
   * these facts (`Python 3.12 · anthropic 0.69 · 5 tools, 2 not wrapped`), then the command.
   */
  summaryFacts: string[] | null;
  /** The command the summary ends on, to show as code. */
  summaryCommand: string | null;
  folded: boolean;
  /**
   * Tools that aren't wrapped: what that means, the code to wrap them, and Check again, the page's
   * lime while one of them is a write (Pack waits for it, `packWait`), plain for reads alone.
   */
  warning: { title: string; text: string; code: WrapSnippet[]; recheck: { label: string; action: 'recheck'; lime: boolean } } | null;
  /**
   * The project pins a Node older than shadowlap's guard takes (18.18): an agent on it wouldn't
   * start, so Record waits until the pin is raised and the folder checked again, which leads.
   */
  node: { title: string; text: string; recheck: { label: string; action: 'recheck'; lime: boolean } } | null;
}

export interface RecordStep extends StepBase {
  key: 'record';
  text: string | null;
  /** The editable command, before the first recording. */
  command: { value: string; enabled: boolean } | null;
  /** Record run: plain while a write tool isn't wrapped, as Check again leads, though it still works. */
  button: { label: string; action: 'record'; enabled: boolean; lime: boolean } | null;
  /** The recording streaming in. */
  live: { runId: string; calls: number; text: string; watch: { label: string; href: string } } | null;
  recorded: { runId: string; href: string; calls: number; spent: number; durationMs: number | null; text: string } | null;
  /** Tools weren't wrapped when it was recorded. */
  warning: string | null;
  /**
   * Record again, with the command and the line for a terminal: offered once every tool the
   * recording missed is wrapped (`recordLead`). The new recording replaces it.
   */
  again: { label: string; action: 'record'; lime: boolean; command: { value: string; enabled: boolean }; cli: string[] } | null;
  /** The newest recording held no calls: nothing was recorded, and why that usually is (until the replay is made clean). */
  empty: { runId: string; href: string; text: string } | null;
}

export interface CalibrateStep extends StepBase {
  key: 'calibrate';
  text: string;
  /**
   * Calibrate, or once it proposed normalizers, add them (`calibrate <run> --write`): plain while
   * Pack waits. Adding them says on hover what it writes, and its command (`tip`).
   */
  button: { label: string; action: 'calibrate' | 'calibratewrite'; enabled: boolean; lime: boolean; tip?: { sub: string; command: string } } | null;
  /** Beside a proposal, Calibrate again, never lime: the proposal left as it is. */
  again: { label: string; action: 'calibrate' } | null;
  /** What the last calibrate proposed and didn't add yet. */
  proposed: Array<{ path: string; why: string | null }>;
  /** Why the last calibrate stopped short of a clean replay. */
  stopped: string | null;
}

export interface TestStep extends StepBase {
  key: 'test';
  text: string | null;
  redaction: { rules: number; text: string; href: string } | null;
  /** The golden's path, editable until it is packed. */
  golden: { value: string; enabled: boolean } | null;
  /**
   * Pack as golden (then its test runs), with no ellipsis as its folder is the field above it, or
   * once it is packed, Run test: plain while it waits (`SetupView.wait`).
   */
  button: { label: string; action: 'packgolden' | 'testgolden'; enabled: boolean; lime: boolean } | null;
  /** Its test passed: the step is done. */
  result: { text: string; link: { label: string; href: string } } | null;
  /** Packed, and its test not passed yet: never run, or failed (with why, and where to look). */
  packed: { golden: string; failed: boolean; text: string; link: { label: string; href: string } | null } | null;
}

export interface SetupView {
  project: { id: string; name: string; path: string };
  eyebrow: string;
  title: string;
  intro: string;
  /** Skip setup: after the first recording, before the golden. */
  skip: { label: string; action: 'finishsetup' } | null;
  inspect: InspectStep;
  record: RecordStep;
  calibrate: CalibrateStep;
  test: TestStep;
  steps: [InspectStep, RecordStep, CalibrateStep, TestStep];
  /** Why Pack as golden, or once the golden is packed its test, waits (`packWait`). */
  wait: PackWait | null;
  /** Once the golden's test passed: its verdict word, the line beside it, and Go to Overview. */
  done: { word: string; title: string; text: string; button: { label: string; action: 'finishsetup' } } | null;
  /** Where the setup shows: with no runs, the Overview and `#/setup`; the Overview while it is set up; nowhere once it is. */
  shows: EffectiveSetup['shows'];
  /**
   * The command a recording here runs, as a terminal takes it: the one the setup recorded with
   * last, else the one `init` found; null when neither is known. Runs' Record run… starts from it,
   * at every stage, where Record's own field is gone once the setup has recorded.
   */
  command: string | null;
}

/** Why Pack as golden waits: the write tools, not wrapped yet or (`since`) wrapped since the recording, and the sentence. */
export interface PackWait {
  tools: string[];
  since: boolean;
  text: string;
}

/**
 * Why Pack as golden waits, or null: while a tool the folder's inspection calls a write isn't
 * wrapped, a replay of the golden would run it for real; once wrapped, until a recording made since,
 * as the setup's recording doesn't hold its calls. Tools that only read never hold it. Once the
 * golden is packed (`packed`), its test waits the same way. None once its test passed or the setup
 * is finished. The setup page draws it, and the setup's pack-test job refuses with it (pack-test.ts).
 */
export function packWait({ findings, setup, packed = false }: { findings: ProjectEntry['setup']['findings']; setup: EffectiveSetup; packed?: boolean }): PackWait | null {
  if (setup.stage === 'done' || setup.steps.tested) return null;
  const now = unwrappedTools(findings)
    .filter((t) => t.effect === 'write')
    .map((t) => t.name);
  const recorded = !!setup.run && !setup.live && setup.steps.recorded;
  const isWrite = (name: string) => !!findings?.tools.some((t) => t.name === name && t.effect === 'write');
  const tools = now.length || !recorded ? now : setup.unwrappedAtRecord.filter(isWrite);
  if (!tools.length) return null;
  const one = tools.length === 1;
  const verb = packed ? 'Testing' : 'Packing';
  const text = now.length
    ? `${verb} waits until ${listed(tools)} ${one ? 'is' : 'are'} wrapped: a replay of this golden would run ${one ? 'it' : 'them'} for real.`
    : `${verb} waits for a recording made since ${listed(tools)} ${one ? 'was' : 'were'} wrapped: ${packed ? 'this golden' : 'this one'} doesn’t hold ${one ? 'its' : 'their'} calls.`;
  return { tools, since: !now.length, text };
}

export interface SetupInput {
  project: ProjectEntry;
  /** `ProjectHost.setup(id)`: `deriveSetup` over the project list, its store and its repository. */
  setup: EffectiveSetup;
  /** The setup recording's calls, cost and duration (`runTotals`), when there is one. */
  run?: RunTotals | null;
  /** Redaction rules in the project's config. */
  redactRules: number;
  home: string;
  /** The last calibrate job's result for the setup's run (`calibrationOutcome`), until the step is done. */
  calibration?: CalibrationOutcome | null;
  /**
   * The golden's path to offer, free on disk (`ProjectHost.suggestGolden`): `goldens/<project>`, or
   * `goldens/<project>-2` when a golden is already there. `goldens/<project>` without it.
   */
  golden?: string | null;
}

function findingRows(f: NonNullable<ProjectEntry['setup']['findings']>): FindingRow[] {
  return [
    { label: 'Language', value: f.language ?? 'not recognised', code: false, small: f.files.length ? f.files.join(' · ') : null },
    { label: 'Model SDK', value: f.sdk ?? 'none found', code: false, small: null },
    ...(f.modelServer ? [{ label: 'Model server', value: f.modelServer.url, code: false, small: f.modelServer.from ? `from ${f.modelServer.from}` : null }] : []),
    { label: 'Framework', value: f.framework ?? 'none detected', code: false, small: null },
    { label: 'Command', value: f.command ? quoteArgv(f.command) : 'none found', code: !!f.command, small: f.commandFrom ? `from ${f.commandFrom}` : null },
    // As the CLI prints it: `wrote shadowlap.config.json (empty)`.
    { label: 'Config', value: f.config.created ? f.config.file : f.config.existed ? `${f.config.file} exists · left as it is` : 'none written', code: f.config.created, small: f.config.created ? 'written, empty' : null },
  ];
}

function toolRow(t: SetupTool): ToolRow {
  return { name: t.name, effect: t.effect, wrapped: t.wrapped, text: t.wrapped ? 'wrapped · effect declared' : `not wrapped · suggested ${t.effect}, ${t.why}`, at: t.wrapped ? null : `${t.file}:${t.line}` };
}

/** Where a project's setup stands, as each of its four steps reads it. */
interface SetupFacts {
  input: SetupInput;
  findings: ProjectEntry['setup']['findings'];
  inspected: boolean;
  run: EffectiveSetup['run'];
  live: boolean;
  finished: boolean;
  recorded: boolean;
  clean: boolean;
  tested: boolean;
  /** A step is done when there is something to show for it; one a later step went past without is skipped. */
  state: (done: boolean, ready: boolean, passed?: boolean) => StepState;
  golden: string;
  argv: string[] | null;
  server: NonNullable<ProjectEntry['setup']['findings']>['modelServer'] | null;
  commands: ReturnType<typeof setupCommands>;
  totals: RunTotals | null;
  unwrapped: ReturnType<typeof unwrappedTools>;
  /** A Node pinned below what the guard takes: the agent wouldn't start, so recording waits for it. */
  oldNode: NonNullable<ProjectEntry['setup']['findings']>['nodePin'] | null;
  /**
   * 4's golden, packed (here or in a terminal) and its test not passed yet: the setup has moved on to
   * it, so step 3 shows as passed by, one step current at a time; it can still be run.
   */
  packedOnly: string | null;
  /** Why Pack (or its test) waits: a write tool not wrapped, or wrapped since the recording. */
  wait: PackWait | null;
  /**
   * Recorded (here or in a terminal) before the folder was inspected: with no findings, Pack's wait
   * can't tell a write tool that isn't wrapped, so Inspect folder leads.
   */
  uninspected: boolean;
  /** The buttons after Inspect read plain, though they still work: Pack waits, or Inspect leads (`uninspected`). */
  held: boolean;
}

/** The four steps of a project's setup, each with its state and the CLI command it runs. */
export function setupView(input: SetupInput): SetupView {
  const { project, setup } = input;
  const path = tildePath(project.path, input.home);
  const f = setupFacts(input);
  const inspect = inspectStep(f);
  const record = recordStep(f);
  const calibrate = calibrateStep(f);
  const test = testStep(f);
  return {
    project: { id: project.id, name: project.name, path },
    eyebrow: `${project.name} · ${path}`,
    title: `Set up ${project.name}`,
    intro: SETUP_INTRO,
    skip: f.recorded && !f.tested && !f.finished ? { label: 'Skip setup', action: 'finishsetup' } : null,
    inspect,
    record,
    calibrate,
    test,
    steps: [inspect, record, calibrate, test],
    wait: f.wait,
    // "Exactly" is the promise the lead makes; what replays save is the line beside it.
    done: f.tested ? { word: 'set up', title: `${project.name} replays exactly.`, text: 'Replays of this run cost nothing, and CI catches a change to what the agent sends.', button: { label: 'Go to Overview', action: 'finishsetup' } } : null,
    shows: setup.shows,
    command: f.argv ? quoteArgv(f.argv) : null,
  };
}

function setupFacts(input: SetupInput): SetupFacts {
  const { project, setup } = input;
  const s = project.setup;
  const stage = setup.stage;
  const findings = s.findings;
  const inspected = stageAtLeast(stage, 'inspected');
  const run = setup.run;
  const live = setup.live && !!run;
  const finished = stage === 'done';
  const recorded = !!run && !live && setup.steps.recorded;
  const clean = recorded && setup.steps.clean;
  const tested = recorded && setup.steps.tested;
  const state = (done: boolean, ready: boolean, passed = false): StepState => (done ? 'done' : finished || passed ? 'skipped' : ready ? 'current' : 'todo');
  const golden = setup.golden ?? input.golden ?? defaultGolden(project.id);
  const argv = s.command ?? findings?.command ?? null;
  const server = findings?.modelServer ?? null;
  const commands = setupCommands({ argv, runId: run?.runId ?? null, golden, modelServer: server });
  const totals = run && input.run?.runId === run.runId ? input.run : null;
  const unwrapped = unwrappedTools(findings);
  const oldNode = findings?.nodePin && nodePinTooOld(findings.nodePin.version) ? findings.nodePin : null;
  const packedOnly = recorded && !tested && !!setup.golden ? setup.golden : null;
  const wait = packWait({ findings, setup, packed: packedOnly !== null });
  const uninspected = !findings && (stageAtLeast(stage, 'recorded') || live);
  return { input, findings, inspected, run, live, finished, recorded, clean, tested, state, golden, argv, server, commands, totals, unwrapped, oldNode, packedOnly, wait, uninspected, held: !!wait || uninspected };
}

/**
 * 1 · Inspect: done once `init` ran and its findings are kept, then folded to one line; skipped when
 * a later step was reached without it (a recording made in a terminal first), which can still be
 * done, and leads until it is, as Pack's wait can't judge the tools without it.
 */
function inspectStep(f: SetupFacts): InspectStep {
  const { findings, uninspected, tested, finished, state, argv, commands } = f;
  return {
    key: 'inspect',
    n: 1,
    title: 'Inspect',
    state: state(!!findings, true, uninspected),
    cli: findings ? [] : commands.inspect,
    text: findings ? null : uninspected ? 'Recorded before the folder was inspected. Inspect it to see its tools, and whether each one is wrapped.' : 'Finds the model SDKs, the command that starts the agent, and every tool with the effect it declares. It runs nothing and writes one empty config file.',
    // Lime until the golden's test passed, whose verdict line leads then.
    button: findings ? null : { label: 'Inspect folder', action: 'init', lime: !tested && !finished },
    findings: findings ? { rows: findingRows(findings), tools: findings.tools.map(toolRow) } : null,
    summaryFacts: findings ? summaryFacts(findings, f.unwrapped.length) : null,
    // The command the run was recorded with, typed or found, as the design's summary ends on it.
    summaryCommand: findings && argv ? quoteArgv(argv) : null,
    folded: !!findings,
    warning: wrapWarning(f),
    node: nodeWarning(f),
  };
}

/** The folded line's facts before its command: the language, the model SDK, and the tools. */
function summaryFacts(findings: NonNullable<SetupFacts['findings']>, unwrapped: number): string[] {
  const tools = findings.tools.length ? `${plural(findings.tools.length, 'tool')}, ${unwrapped ? `${unwrapped} not wrapped` : 'all wrapped'}` : 'no tools found';
  return [findings.language ?? 'not recognised', findings.sdk ?? 'no model SDK found', tools];
}

/** Tools that aren't wrapped: Check again leads while one of them is a write, since Pack waits for it. */
function wrapWarning({ findings, unwrapped, tested, finished }: SetupFacts): InspectStep['warning'] {
  if (!findings || !unwrapped.length) return null;
  const writes = unwrapped.filter((t) => t.effect === 'write');
  const one = unwrapped.length === 1;
  return {
    title: `${unwrapped.length === writes.length ? plural(unwrapped.length, 'write tool') : plural(unwrapped.length, 'tool')} ${one ? 'isn’t' : 'aren’t'} wrapped.`,
    text: `${one ? 'Its' : 'Their'} calls won’t be recorded, so a replay runs ${one ? 'it' : 'them'} for real${writes.length ? `: ${listed(writes.map((t) => t.name))} would act again` : ''}. Wrap ${one ? 'it' : 'them'}, with the effect declared:`,
    code: findings.wrap ?? [],
    recheck: { label: 'Check again', action: 'recheck', lime: writes.length > 0 && !tested && !finished },
  };
}

/** A Node pin the guard refuses: Check again leads while it holds Record, unless the wrap warning's already does. */
function nodeWarning({ oldNode, recorded, live, unwrapped }: SetupFacts): InspectStep['node'] {
  if (!oldNode) return null;
  const writeUnwrapped = unwrapped.some((t) => t.effect === 'write');
  return {
    title: `Node ${oldNode.version} is too old for shadowlap’s guard.`,
    text: `${oldNode.from} pins it, and an agent on a Node before ${AGENT_NODE_MIN} never starts under shadowlap: that Node refuses the guard shadowlap loads into it. Pin ${AGENT_NODE_MIN} or later to record.`,
    recheck: { label: 'Check again', action: 'recheck', lime: !recorded && !live && !writeUnwrapped },
  };
}

/** What Record says before it runs: the sidecar in front of the model API or server, or why it waits or can't. */
function recordText(server: SetupFacts['server'], oldNode: SetupFacts['oldNode']): string {
  if (oldNode) return `Waits for a Node pin of ${AGENT_NODE_MIN} or later: ${oldNode.from} pins ${oldNode.version}, where the agent wouldn’t start under shadowlap.`;
  if (!server) return 'Runs the command once with a local sidecar in front of the model API. Model calls go to the real API with your keys, which are never stored.';
  return server.upstream
    ? `Runs the command once with a local sidecar in front of your model server. Model calls go to ${server.url}, the model server this project uses.`
    : `The dashboard can’t record through this project’s model server (${server.url}): its address isn’t a plain http(s) URL, or holds credentials, which shadowlap never stores. Record it in a terminal with ${UPSTREAM_ENV} set to the server.`;
}

/** 2 · Record. */
function recordStep(f: SetupFacts): RecordStep {
  const { input, inspected, run, live, recorded, clean, tested, finished, state, argv, server, commands, totals, oldNode, held } = f;
  const { setup } = input;
  // A model server the dashboard can't forward to (credentials in its address, or not a plain URL) is recorded in a terminal.
  const canRecord = inspected && !(server && !server.upstream) && !oldNode;
  const command = { value: argv ? quoteArgv(argv) : '', enabled: canRecord };
  const ahead = !recorded && !live;
  return {
    key: 'record',
    n: 2,
    title: 'Record',
    state: state(recorded, inspected),
    cli: ahead ? commands.record : [],
    text: ahead ? recordText(server, oldNode) : null,
    command: ahead ? command : null,
    // Plain while a write tool isn't wrapped: Check again leads, though recording still works.
    button: ahead ? { label: 'Record run', action: 'record', enabled: canRecord, lime: !held } : null,
    live: live && run ? { runId: run.runId, calls: totals?.calls ?? 0, text: `Recording ${short(run.runId)} · ${plural(totals?.calls ?? 0, 'call')} so far`, watch: { label: 'Watch live', href: links.run(run.runId) } } : null,
    recorded: recorded && run ? recordedLine(run, totals) : null,
    ...recordLead(f, command),
    // Until the replay is made clean: past that, a later recording that held nothing changes nothing for the setup.
    empty:
      setup.empty && !clean && !tested && !finished
        ? {
            runId: setup.empty.runId,
            href: links.run(setup.empty.runId),
            text: `${short(setup.empty.runId)} holds no calls, so nothing was recorded: the command didn’t start your agent, or no model call reached shadowlap. Check the command and record again.`,
          }
        : null,
  };
}

/** `Recorded 01K5CQ7A3M · 12 calls · ≈$0.041 · 38.2 s`: the setup's recording, with what it cost where its totals are in. */
function recordedLine(run: NonNullable<SetupFacts['run']>, totals: RunTotals | null): NonNullable<RecordStep['recorded']> {
  const facts = [`Recorded ${short(run.runId)}`, ...(totals ? [plural(totals.calls, 'call'), approx(totals.spent)] : []), ...(totals?.durationMs != null ? [duration(totals.durationMs)] : [])];
  return { runId: run.runId, href: links.run(run.runId), calls: totals?.calls ?? run.calls, spent: totals?.spent ?? 0, durationMs: totals?.durationMs ?? null, text: facts.join(' · ') };
}

/**
 * What Record says of the tools its recording missed, and Record again. It is offered once every
 * missed tool is wrapped (`init` checked again since), as a recording made before then misses the
 * same calls, and whenever Pack waits for a recording made since: the missed writes are wrapped
 * then, though a missed read may not be, and a read never holds Pack. Once the replay is clean, it
 * stays only while Pack waits: only a recording started here replaces a clean setup's, so it is the
 * one way on. Lime while it leads, that is while Pack waits for it; missed tools that only read
 * leave it plain, and Calibrate leads.
 */
function recordLead({ input, findings, run, recorded, clean, tested, finished, commands, unwrapped, wait }: SetupFacts, command: { value: string; enabled: boolean }): Pick<RecordStep, 'warning' | 'again'> {
  const missed = recorded ? input.setup.unwrappedAtRecord : [];
  if (!missed.length) return { warning: null, again: null };
  const one = missed.length === 1;
  // Tools wrapped since: `init` checked again after the recording, and finds none of them unwrapped.
  const wrappedSince = !!findings && !!run && findings.at > run.startedAt && missed.every((name) => !unwrapped.some((t) => t.name === name));
  const leads = wait?.since === true;
  const offered = !tested && !finished && (leads || (wrappedSince && !clean));
  return {
    warning: `${plural(missed.length, 'tool')} ${one ? 'wasn’t' : 'weren’t'} wrapped, so ${one ? 'its' : 'their'} calls aren’t in this recording. ${againHow(one, wrappedSince, leads ? wait : null)} before you pack it as a golden.`,
    again: offered ? { label: 'Record again', action: 'record', lime: leads, command, cli: commands.record } : null,
  };
}

/**
 * How Record's warning goes on: every missed tool wrapped now; else the writes among them, which
 * Pack waits on (`leads`), while a missed read still isn't; else wrap them first.
 */
function againHow(one: boolean, wrappedSince: boolean, leads: PackWait | null): string {
  if (wrappedSince) return `${one ? 'It is' : 'They are'} wrapped now: record again`;
  if (leads) return `${listed(leads.tools)} ${leads.tools.length === 1 ? 'is' : 'are'} wrapped now: record again`;
  return `Wrap ${one ? 'it' : 'them'} and record again`;
}

/** What Calibrate says: what it added once clean, what it proposes, why it stopped, or what it does. */
function calibrateText({ run, clean }: SetupFacts, added: Array<{ path: string; why: string | null }> | null, proposed: Array<{ path: string; why: string | null }>, stopped: string | null): string {
  if (clean) {
    if (added === null) return `A replay of ${short(run!.runId)} ran clean.`;
    if (!added.length) return 'The replay was clean as recorded: nothing to add.';
    return `Added ${added.length === 1 ? 'a normalizer' : 'normalizers'} for ${listed(added.map((a) => a.path))}${added.length === 1 && added[0]!.why ? `: ${added[0]!.why}` : ''}. The replay is clean now.`;
  }
  if (proposed.length && !stopped) {
    const one = proposed.length === 1;
    return `Found ${one ? 'a value' : `${proposed.length} values`} the agent makes anew on every run, at ${listed(proposed.map((p) => p.path))}${one && proposed[0]!.why ? `: ${proposed[0]!.why}` : ''}. ${one ? 'A normalizer for it makes' : 'Normalizers for them make'} the replay clean.`;
  }
  if (stopped) return `Calibrate stopped: ${stopped}.${proposed.length ? ` It found ${listed(proposed.map((p) => p.path))} on the way.` : ''}`;
  return 'Replays the run offline with the same code until it is clean, and proposes a normalizer for every value the agent makes anew. No model calls; writes are blocked.';
}

/** 3 · Calibrate: plain while Pack waits, since a clean replay of this recording still couldn't be packed, or Inspect leads. */
function calibrateStep(f: SetupFacts): CalibrateStep {
  const { input, recorded, clean, tested, state, commands, packedOnly, held } = f;
  const { project, setup } = input;
  const added = setup.own ? (project.setup.calibration?.added ?? null) : null;
  const last = !clean && recorded ? (input.calibration ?? null) : null;
  const proposed = last && !last.done ? last.proposed : [];
  const offer = !clean && proposed.length > 0 && !last?.stopped;
  return {
    key: 'calibrate',
    n: 3,
    title: 'Calibrate',
    state: state(clean, recorded, tested || packedOnly !== null),
    cli: clean ? [] : commands.calibrate,
    text: calibrateText(f, added, proposed, last?.stopped ?? null),
    button: clean ? null : offer ? { label: ACTIONS.addNormalizer.label, action: 'calibratewrite', enabled: true, lime: !held, tip: { sub: `Writes the ${proposed.length === 1 ? 'rule' : 'rules'} calibrate proposed to shadowlap.config.json`, command: commands.calibrate.join(' && ') } } : { label: ACTIONS.calibrate.label, action: 'calibrate', enabled: recorded, lime: !held },
    again: offer ? { label: 'Calibrate again', action: 'calibrate' } : null,
    proposed,
    stopped: last?.stopped ?? null,
  };
}

/**
 * 4 · Pack: packed, then its test; done once the test passed. A golden packed (here or in a
 * terminal) whose test hasn't passed keeps the step open, with the test to run. Either waits, plain,
 * while a write tool isn't wrapped or was wrapped since the recording (`packWait`), and reads plain
 * while Inspect leads.
 */
function testStep({ input, clean, tested, state, golden, commands, totals, packedOnly, held }: SetupFacts): TestStep {
  const { setup } = input;
  const calls = totals?.calls ?? 0;
  const failed = packedOnly !== null && setup.goldenTest?.ok === false;
  const ahead = !tested && !packedOnly;
  return {
    key: 'test',
    n: 4,
    title: 'Pack',
    state: state(tested, clean || packedOnly !== null),
    cli: tested ? [] : packedOnly ? [`shadowlap test ${packedOnly}`] : commands.test,
    text: ahead ? 'Packs the run into the repository, and CI replays it offline on every commit.' : null,
    redaction: ahead
      ? {
          rules: input.redactRules,
          text: input.redactRules ? 'Your redaction rules apply to the copy.' : 'There are no redaction rules yet, so the copy holds what was recorded. Add some in Settings before you commit runs with user data.',
          href: links.settings('redaction'),
        }
      : null,
    golden: ahead ? { value: golden, enabled: clean } : null,
    button: tested ? null : packedOnly ? { label: failed ? ACTIONS.rerunTest.label : 'Run test', action: 'testgolden', enabled: true, lime: !held } : { label: confirmWords(ACTIONS.packAsGolden.label), action: 'packgolden', enabled: clean, lime: !held },
    result: tested ? { text: `${golden} replayed clean offline${totals ? ` · ${calls}/${calls} calls` : ''}`, link: { label: 'Open Tests', href: links.tests() } } : null,
    packed: packedOnly ? packedLine(packedOnly, failed, setup.goldenTest?.reason ?? null) : null,
  };
}

/** The golden packed and its test not passed: never run, or failed, with why and where to look. */
function packedLine(golden: string, failed: boolean, reason: string | null): TestStep['packed'] {
  if (!failed) return { golden, failed: false, text: `Packed as ${golden}. Its test replays it offline: run it to finish.`, link: null };
  return { golden, failed: true, text: `${golden} failed its test${reason ? `: ${reason.replace(/[.\s]+$/, '')}` : ''}. Fix what changed, or record again, then run it again.`, link: { label: 'Open Tests', href: links.tests() } };
}

// ---------------------------------------------------------------------------------------------
// Removing a project

export interface OnDiskRow {
  /** `made`: what commands made from its runs in `.shadowlap/` (repair reports, exports), which stays even when the recordings go. */
  key: 'code' | 'rec' | 'cfg' | 'gold' | 'made';
  label: string;
  path: string;
}

/** What each folder of {@link ProjectStats.madeFiles} holds, as the Remove dialog names it. */
const MADE_NAMES: Record<string, string> = { '.shadowlap/repairs': 'repair reports', '.shadowlap/exports': 'exports', '.shadowlap/uploads': 'files sent to jobs' };

/** What the dialog says and does, with or without "Also delete its recordings" ticked. */
export interface RemoveMode {
  text: string;
  /** What only a folder that is gone needs said: what stays on disk is the list. */
  note: string | null;
  button: { label: string; style: 'plain' | 'danger' };
  /** The on-disk row crossed out. */
  crossedOut: OnDiskRow['key'] | null;
  /** The toast once it is done. */
  done: string;
}

export interface RemoveDialogView {
  title: string;
  project: { id: string; name: string; path: string; initial: string; summary: string };
  /** What stays on disk: the folder and its code, the store, the config, the goldens. */
  onDisk: OnDiskRow[];
  keep: RemoveMode;
  /** Only when the project has runs; the button stays disabled until the name is typed (see {@link nameMatches}). */
  deleteZone: { label: string; detail: string; confirm: string; placeholder: string; name: string; mode: RemoveMode } | null;
  canRemove: boolean;
  /** Why it can't be removed, for the disabled button's hover. */
  why: string | null;
}

/**
 * What the delete zone says of the team store: the runs here it lists too stay there, whatever is
 * deleted here, and the rest exist only here. `listed`: the project's runs here that the store's
 * index lists (`TeamRunCounts.listedHere`).
 */
function storeLine(runs: number, listed: number): string {
  const only = Math.max(0, runs - listed);
  if (listed <= 0) return `${runs === 1 ? 'It isn’t' : 'None of them is'} in the team store: ${runs === 1 ? 'it exists' : 'they exist'} only here.`;
  if (!only) return runs === 1 ? 'It is in the team store too, and stays there.' : `All ${plural(runs, 'run')} are in the team store too, and stay there.`;
  return `${listed.toLocaleString('en-US')} of them ${listed === 1 ? 'is' : 'are'} in the team store too and ${listed === 1 ? 'stays' : 'stay'} there; ${only.toLocaleString('en-US')} ${only === 1 ? 'exists' : 'exist'} only here.`;
}

/**
 * Remove a project, from the switcher's × or Settings → Project. `team`: how its runs here stand
 * with its team store, when it has one, so the delete zone says which of them stay in the store.
 */
export function removeDialog(input: { project: ProjectEntry; stats: ProjectStats; projects: number; home: string; team?: { listed: number } | null }): RemoveDialogView {
  const { project, stats } = input;
  const path = tildePath(project.path, input.home);
  const canRemove = input.projects > 1;
  // Copies of what was recorded that deleting the recordings leaves: said in both places, so nobody deleting for privacy is surprised.
  const made = (stats.madeFiles ?? []).filter((m) => MADE_NAMES[m]);
  const madeText = listed(made.map((m) => MADE_NAMES[m]!));
  // A folder that is gone holds nothing to keep: the dialog says so rather than listing what was in it.
  const onDisk: OnDiskRow[] = stats.missing
    ? [{ key: 'code', label: 'Its folder, not on disk any more', path }]
    : [
        { key: 'code', label: 'The folder and its code', path },
        { key: 'rec', label: stats.runs ? 'Its recordings' : 'Its store, empty so far', path: '.shadowlap/shadowlap.db' },
        { key: 'cfg', label: 'Its settings', path: 'shadowlap.config.json' },
        ...(stats.goldens ? [{ key: 'gold' as const, label: stats.goldens === 1 ? 'Its golden' : `Its ${stats.goldens} goldens`, path: 'goldens/' }] : []),
        ...(made.length ? [{ key: 'made' as const, label: `Its ${madeText}`, path: made.map((m) => `${m}/`).join(' · ') }] : []),
      ];
  return {
    title: `Remove ${project.name} from the dashboard?`,
    project: { id: project.id, name: project.name, path, initial: initial(project.name), summary: stats.runs ? `${runsLabel(stats.runs)}${stats.goldens ? ` · ${plural(stats.goldens, 'golden')}` : ''}` : 'no runs yet' },
    onDisk,
    keep: {
      text: `Takes ${project.name} off the dashboard; nothing on disk changes.`,
      note: stats.missing ? 'Put the folder back and add it again to bring it all back.' : null,
      button: { label: 'Remove project', style: 'plain' },
      crossedOut: stats.missing ? 'code' : null,
      done: removedToast(project.name, { deleted: false, missing: !!stats.missing }).message,
    },
    deleteZone: stats.runs
      ? {
          label: 'Also delete its recordings',
          detail: `${runsLabel(stats.runs)} and ${stats.runs === 1 ? 'its' : 'their'} attempts.${input.team ? ` ${storeLine(stats.runs, input.team.listed)}` : ''}${stats.goldens ? ` ${stats.goldens === 1 ? 'The golden is' : 'The goldens are'} in your repository and ${stats.goldens === 1 ? 'stays' : 'stay'}.` : ''}${made.length ? ` Its ${madeText} in .shadowlap/ stay too: delete them yourself if they hold what you mean to delete.` : ''}`,
          confirm: `Type ${project.name} to confirm. This can’t be undone.`,
          placeholder: project.name,
          name: project.name,
          mode: {
            text: `Takes ${project.name} off the dashboard and deletes its recordings.`,
            note: null,
            button: { label: 'Remove and delete recordings', style: 'danger' },
            crossedOut: 'rec',
            done: removedToast(project.name, { deleted: true, missing: false }).message,
          },
        }
      : null,
    canRemove,
    why: canRemove ? null : 'The only project can’t be removed',
  };
}

/**
 * What removing a project answers for its toast: what was done, and whether the toast's Undo can
 * put the project back (`POST /api/projects/:id/restore`): never once its recordings are deleted,
 * nor with its folder gone, which the Undo would refuse.
 */
export function removedToast(name: string, o: { deleted: boolean; missing: boolean }): { message: string; undo: boolean } {
  return { message: o.deleted ? `Removed ${name} and deleted its recordings` : `Removed ${name} · nothing on disk changed`, undo: !o.deleted && !o.missing };
}

/** The typed name confirms deleting the recordings once it matches the project's name: the server's rule, so the button and the check agree. */
export function nameMatches(typed: string, name: string): boolean {
  return nameConfirms(typed, name);
}

// ---------------------------------------------------------------------------------------------
// Activity

/**
 * The activity feed's line for a project event (`project.added`, `project.setup`, `project.removed`),
 * or null for another kind. `project.setup` is logged when a setup is finished (`stage: 'done'`) and
 * by `init` when it writes the config (`config: 'created'`).
 */
export function projectEventText(event: Pick<StoredEvent, 'kind' | 'ref' | 'data'>): string | null {
  const d = event.data ?? {};
  const path = typeof d.path === 'string' ? d.path : (event.ref ?? '');
  const name = typeof d.name === 'string' ? d.name : (event.ref ?? '');
  switch (event.kind) {
    case 'project.added':
      return `${d.again ? 'Project added back' : 'Project added'} · ${path}`;
    case 'project.setup':
      if (d.stage !== 'done' && d.config === 'created') return `Inspected ${name} · wrote shadowlap.config.json`;
      return `Set up ${name}${d.skipped ? ' · skipped the rest' : ''}`;
    case 'project.removed':
      return `Removed from the dashboard · ${path}`;
    default:
      return null;
  }
}
