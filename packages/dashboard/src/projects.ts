import {
  UPSTREAM_ENV,
  defaultGolden,
  nameConfirms,
  quoteArgs,
  setupCommands,
  shortRunId,
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

/**
 * The dashboard's read model for projects: plain data for the project switcher, the Add a project
 * page, a project's setup and the Remove dialog, built from the project list and what each store
 * says. No HTTP and no file access here: the server gathers the inputs (the registry, store facts
 * and counts from `ProjectHost`, folder suggestions) and these functions decide what the screens
 * say, in the mock's words. `home` is the home folder's real path (`ProjectRegistry.realHome`), as
 * project paths are real paths: paths under it show as `~/…`.
 */

/** What the switcher and the Remove dialog need from a project's store and folder. */
export interface ProjectStats {
  /** Runs, attempts left out. */
  runs: number;
  attempts: number;
  /** Goldens in the project's repository. */
  goldens: number;
  /** The folder is gone from disk. */
  missing?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const runsLabel = (n: number) => (n ? plural(n, 'run') : 'no runs yet');
/** `≈$0.041`, as the mock writes a cost. */
const approx = (usd: number) => (usd ? `≈$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}` : '$0');
/** `38.2 s`, `1m 5s`, as the mock writes a duration. */
const duration = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
/** `a`, `a and b`, `a, b and c`. */
const listed = (items: readonly string[]) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
/** The letter on a project's badge. */
const initial = (name: string) => (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?').toUpperCase();

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
  /** The line under the name: `~/triage-bot · no runs yet · setting up`. */
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
    const settingUp = p.setup.stage !== 'done';
    const missing = !!stats.missing;
    return {
      id: p.id,
      name: p.name,
      path,
      initial: initial(p.name),
      runs: stats.runs,
      current: p.id === input.current,
      settingUp,
      missing,
      detail: [path, missing ? 'folder not found' : runsLabel(stats.runs), ...(settingUp && !missing ? ['setting up'] : [])].join(' · '),
      removable,
      removeLabel: `Remove ${p.name} from the dashboard`,
    };
  });
  const current = items.find((i) => i.current) ?? items[0];
  if (!current) throw new Error('the dashboard always has a project');
  return {
    current,
    heading: 'Projects on this machine',
    items,
    add: { label: 'Add project…', hint: 'a folder with your agent’s code', href: '#/new' },
    note: 'Each project keeps its own store.',
  };
}

// ---------------------------------------------------------------------------------------------
// Add a project (#/new)

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
  /** Names the folder once one that can be added is picked; disabled until then. */
  button: { label: string; disabled: boolean; path: string | null };
  cancel: { label: string; href: string };
  next: { title: string; steps: Array<{ title: string; text: string }>; note: string };
}

/** The folder picked on the page, as the server checked it. */
export interface PickedFolder {
  path: string;
  folder: FolderKind;
  added?: boolean;
}

/** Add a project: the folder field, its suggestions, the picked folder, and what happens next. */
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
  const pickedDisplay = picked ? tildePath(picked.path, input.home) : null;
  const addable = !!picked && !!picked.folder.kind && !picked.added;
  const error = !picked ? null : picked.added ? `${pickedDisplay} is already in the dashboard.` : picked.folder.kind ? null : (picked.folder.why ?? `${pickedDisplay} has no project files.`);
  const query = input.query.trim();
  return {
    eyebrow: 'projects',
    title: 'Add a project',
    intro: 'Pick the folder your agent’s code is in. Nothing runs until you click.',
    field: { label: 'Folder', placeholder: '~/path/to/your/agent', value: input.query },
    listed: input.suggestions.listed,
    folders,
    empty: folders.length ? null : (input.suggestions.note ?? (query ? `No folder matches “${query}”.` : 'No folders here.')),
    truncated: input.suggestions.truncated,
    error,
    button: addable ? { label: `Add ${pickedDisplay}`, disabled: false, path: picked!.path } : { label: 'Add project', disabled: true, path: null },
    cancel: { label: 'Cancel', href: '#/' },
    next: {
      title: 'What happens next',
      steps: [
        { title: 'Inspect', text: 'Reads the folder for SDKs, the start command and tools. Runs nothing.' },
        { title: 'Record', text: 'Runs your command once, after you confirm it.' },
        { title: 'Calibrate', text: 'Replays offline until the replay is clean.' },
        { title: 'Keep it as a test', text: 'Packs the run for CI to replay on every commit.' },
      ],
      note: 'The dashboard runs a command in a project’s folder only when you click, and asks first the first time.',
    },
  };
}

/** The toast after adding: a folder added again says its runs came back. */
export function addedMessage(added: { project: ProjectEntry; again: boolean; runs: number }, home: string): string {
  const path = tildePath(added.project.path, home);
  return added.again ? `Added ${path} back · ${plural(added.runs, 'run')}` : `Added ${path}`;
}

// ---------------------------------------------------------------------------------------------
// Setting a project up

/** `skipped`: the setup was finished without this step (Skip the rest, or set up in a terminal). */
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
  button: { label: string; action: 'init' } | null;
  findings: { rows: FindingRow[]; tools: ToolRow[] } | null;
  /** Once a run is recorded and every tool is wrapped, the findings fold into this line. */
  summary: string | null;
  folded: boolean;
  /** Tools that aren't wrapped: what that means, the code to wrap them, and the re-check. */
  warning: { title: string; text: string; code: WrapSnippet[]; copy: string; recheck: { label: string; action: 'recheck' } } | null;
}

export interface RecordStep extends StepBase {
  key: 'record';
  text: string | null;
  /** The editable command, before the first recording. */
  command: { value: string; enabled: boolean } | null;
  button: { label: string; action: 'record'; enabled: boolean } | null;
  /** The recording streaming in. */
  live: { runId: string; calls: number; text: string; watch: { label: string; href: string } } | null;
  recorded: { runId: string; href: string; calls: number; spent: number; durationMs: number | null; text: string } | null;
  /** Tools weren't wrapped when it was recorded. */
  warning: string | null;
}

export interface CalibrateStep extends StepBase {
  key: 'calibrate';
  text: string;
  /** Calibrate, or once it proposed normalizers, add them (`calibrate <run> --write`). */
  button: { label: string; action: 'calibrate' | 'calibratewrite'; enabled: boolean } | null;
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
  button: { label: string; action: 'packgolden'; enabled: boolean } | null;
  result: { text: string; link: { label: string; href: string } } | null;
}

export interface SetupView {
  project: { id: string; name: string; path: string };
  eyebrow: string;
  title: string;
  intro: string;
  /** Skip the rest: after the first recording, before the golden. */
  skip: { label: string; action: 'finishsetup' } | null;
  inspect: InspectStep;
  record: RecordStep;
  calibrate: CalibrateStep;
  test: TestStep;
  steps: [InspectStep, RecordStep, CalibrateStep, TestStep];
  /** Once the golden replays clean. */
  done: { title: string; text: string; button: { label: string; action: 'finishsetup' } } | null;
  /** Where the setup shows: every page but Settings, the Overview, or nowhere. */
  shows: EffectiveSetup['shows'];
}

export interface SetupInput {
  project: ProjectEntry;
  /** `deriveSetup(project.setup, facts)`. */
  setup: EffectiveSetup;
  /** The setup recording's calls, cost and duration (`runTotals`), when there is one. */
  run?: RunTotals | null;
  /** Redaction rules in the project's config. */
  redactRules: number;
  home: string;
  /** The last calibrate job's result for the setup's run (`calibrationOutcome`), until the step is done. */
  calibration?: CalibrationOutcome | null;
}

function findingRows(f: NonNullable<ProjectEntry['setup']['findings']>): FindingRow[] {
  return [
    { label: 'Language', value: f.language ?? 'not recognised', code: false, small: f.files.length ? f.files.join(' · ') : null },
    { label: 'Model SDK', value: f.sdk ?? 'none found', code: false, small: null },
    ...(f.modelServer ? [{ label: 'Model server', value: f.modelServer.url, code: false, small: f.modelServer.from ? `from ${f.modelServer.from}` : null }] : []),
    { label: 'Framework', value: f.framework ?? 'none detected', code: false, small: null },
    { label: 'Command', value: f.command ? quoteArgs(f.command) : 'none found', code: !!f.command, small: f.commandFrom ? `from ${f.commandFrom}` : null },
    { label: 'Config', value: f.config.created ? `wrote an empty ${f.config.file}` : f.config.existed ? `${f.config.file} exists · left as it is` : 'none written', code: false, small: null },
  ];
}

function toolRow(t: SetupTool): ToolRow {
  return { name: t.name, effect: t.effect, wrapped: t.wrapped, text: t.wrapped ? 'wrapped · effect declared' : `not wrapped · suggested ${t.effect}, ${t.why}`, at: t.wrapped ? null : `${t.file}:${t.line}` };
}

/** The four steps of a project's setup, each with its state and the CLI command it runs. */
export function setupView(input: SetupInput): SetupView {
  const { project, setup } = input;
  const s = project.setup;
  const stage = setup.stage;
  const path = tildePath(project.path, input.home);
  const findings = s.findings;
  const inspected = stageAtLeast(stage, 'inspected');
  const run = setup.run;
  const live = setup.live && !!run;
  const recorded = !!run && !live && stageAtLeast(stage, 'recorded');
  // A finished setup is done whichever steps it took: a step counts as done only when the list
  // says what it made (the calibration, the golden), and the rest were skipped.
  const finished = stage === 'done';
  const clean = recorded && stageAtLeast(stage, 'clean') && (!finished || s.calibration !== null);
  const tested = recorded && stageAtLeast(stage, 'tested') && (!finished || s.golden !== null);
  const state = (done: boolean, ready: boolean): StepState => (done ? 'done' : finished ? 'skipped' : ready ? 'current' : 'todo');
  const golden = s.golden ?? defaultGolden(project.id);
  const argv = s.command ?? findings?.command ?? null;
  const server = findings?.modelServer ?? null;
  const commands = setupCommands({ argv, runId: run?.runId ?? null, golden, modelServer: server });
  const totals = run && input.run?.runId === run.runId ? input.run : null;

  // 1 · Inspect the folder
  const unwrapped = unwrappedTools(findings);
  const writes = unwrapped.filter((t) => t.effect === 'write');
  const inspect: InspectStep = {
    key: 'inspect',
    n: 1,
    title: 'Inspect the folder',
    state: state(inspected, true),
    cli: inspected ? [] : commands.inspect,
    text: inspected ? (findings ? null : 'Inspect it again to see what it finds.') : 'Finds the model SDKs, the command that starts the agent, and every tool with the effect it declares. It runs nothing and writes one empty config file.',
    button: inspected && findings ? null : { label: 'Inspect the folder', action: 'init' },
    findings: inspected && findings ? { rows: findingRows(findings), tools: findings.tools.map(toolRow) } : null,
    summary: findings ? [findings.language ?? 'not recognised', findings.sdk ?? 'no model SDK found', findings.tools.length ? `${plural(findings.tools.length, 'tool')}, ${unwrapped.length ? `${unwrapped.length} not wrapped` : 'all wrapped'}` : 'no tools found', ...(findings.command ? [quoteArgs(findings.command)] : [])].join(' · ') : null,
    folded: inspected && !!findings && recorded && unwrapped.length === 0,
    warning:
      inspected && unwrapped.length
        ? {
            title: `${unwrapped.length === writes.length ? plural(unwrapped.length, 'write tool') : plural(unwrapped.length, 'tool')} ${unwrapped.length === 1 ? 'isn’t' : 'aren’t'} wrapped.`,
            text: `Their calls won’t be recorded, so a replay runs them for real${writes.length ? `: ${listed(writes.map((t) => t.name))} would act again` : ''}. Wrap them, with the effect declared:`,
            code: findings?.wrap ?? [],
            copy: 'Copy',
            recheck: { label: 'I wrapped them, check again', action: 'recheck' },
          }
        : null,
  };

  // 2 · Record a first run
  const unwrappedAtRecord = run && s.runId === run.runId ? s.unwrappedAtRecord : [];
  // A model server the dashboard can't forward to (its address holds credentials) is recorded in a terminal.
  const canRecord = inspected && !(server && !server.upstream);
  const recordText = !server
    ? 'Runs the command once with a local sidecar in front of the model API. Model calls go to the real API with your keys, which are never stored.'
    : server.upstream
      ? `Runs the command once with a local sidecar in front of your model server. Model calls go to ${server.url}, the model server this project uses.`
      : `The dashboard can’t record through this project’s model server (${server.url}): its address isn’t a plain http(s) URL, or holds credentials, which Shadowlap never stores. Record it in a terminal with ${UPSTREAM_ENV} set to the server.`;
  const record: RecordStep = {
    key: 'record',
    n: 2,
    title: 'Record a first run',
    state: state(recorded, inspected),
    cli: recorded || live ? [] : commands.record,
    text: recorded || live ? null : recordText,
    command: recorded || live ? null : { value: argv ? quoteArgs(argv) : '', enabled: canRecord },
    button: recorded || live ? null : { label: 'Record a run', action: 'record', enabled: canRecord },
    live: live && run ? { runId: run.runId, calls: totals?.calls ?? 0, text: `Recording ${shortRunId(run.runId)} · ${plural(totals?.calls ?? 0, 'call')} so far`, watch: { label: 'Watch it live', href: `#/run/${run.runId}` } } : null,
    recorded:
      recorded && run
        ? {
            runId: run.runId,
            href: `#/run/${run.runId}`,
            calls: totals?.calls ?? 0,
            spent: totals?.spent ?? 0,
            durationMs: totals?.durationMs ?? null,
            text: [`Recorded ${shortRunId(run.runId)}`, ...(totals ? [plural(totals.calls, 'call'), approx(totals.spent)] : []), ...(totals?.durationMs != null ? [duration(totals.durationMs)] : [])].join(' · '),
          }
        : null,
    warning: recorded && unwrappedAtRecord.length ? `${plural(unwrappedAtRecord.length, 'tool')} ${unwrappedAtRecord.length === 1 ? 'wasn’t' : 'weren’t'} wrapped, so their calls aren’t in this recording. Wrap them and record again before you keep it as a test.` : null,
  };

  // 3 · Make the replay clean
  const added = s.calibration?.added ?? null;
  const last = !clean && recorded ? (input.calibration ?? null) : null;
  const proposed = last && !last.done ? last.proposed : [];
  const offer = proposed.length > 0 && !last?.stopped;
  const calibrate: CalibrateStep = {
    key: 'calibrate',
    n: 3,
    title: 'Make the replay clean',
    state: state(clean, recorded),
    cli: clean ? [] : commands.calibrate,
    text: clean
      ? added === null
        ? 'The replay is clean.'
        : added.length
          ? `Added ${added.length === 1 ? 'a normalizer' : 'normalizers'} for ${listed(added.map((a) => a.path))}${added.length === 1 && added[0]!.why ? `: ${added[0]!.why}` : ''}. The replay is clean now.`
          : 'The replay was clean as recorded: nothing to add.'
      : offer
        ? `Found ${proposed.length === 1 ? 'a value' : `${proposed.length} values`} the agent makes anew on every run, at ${listed(proposed.map((p) => p.path))}${proposed.length === 1 && proposed[0]!.why ? `: ${proposed[0]!.why}` : ''}. ${proposed.length === 1 ? 'A normalizer for it makes' : 'Normalizers for them make'} the replay clean.`
        : last?.stopped
          ? `Calibrate stopped: ${last.stopped}.${proposed.length ? ` It found ${listed(proposed.map((p) => p.path))} on the way.` : ''}`
          : 'Replays the run offline with the same code until it is clean, and proposes a normalizer for every value the agent makes anew. No model calls; writes are blocked.',
    button: clean ? null : offer ? { label: proposed.length === 1 ? 'Add it' : 'Add them', action: 'calibratewrite', enabled: true } : { label: 'Calibrate', action: 'calibrate', enabled: recorded },
    proposed,
    stopped: last?.stopped ?? null,
  };

  // 4 · Keep it as a test
  const calls = totals?.calls ?? 0;
  const test: TestStep = {
    key: 'test',
    n: 4,
    title: 'Keep it as a test',
    state: state(tested, clean),
    cli: tested ? [] : commands.test,
    text: tested ? null : 'Packs the run into the repository, and CI replays it offline on every commit.',
    redaction: tested
      ? null
      : {
          rules: input.redactRules,
          text: input.redactRules ? 'Your redaction rules apply to the copy.' : 'There are no redaction rules yet, so the copy holds what was recorded. Add some in Settings before you commit runs with user data.',
          href: '#/settings/redaction',
        },
    golden: tested ? null : { value: golden, enabled: clean },
    button: tested ? null : { label: 'Pack as a golden', action: 'packgolden', enabled: clean },
    result: tested ? { text: `${golden} replayed clean offline${totals ? ` · ${calls}/${calls} calls` : ''}`, link: { label: 'Open Tests', href: '#/tests' } } : null,
  };

  return {
    project: { id: project.id, name: project.name, path },
    eyebrow: `${project.name} · ${path}`,
    title: run ? `Set up ${project.name}` : 'No runs yet',
    intro: 'Record the agent once. Every lap after that replays for free.',
    skip: recorded && !tested && !finished ? { label: 'Skip the rest', action: 'finishsetup' } : null,
    inspect,
    record,
    calibrate,
    test,
    steps: [inspect, record, calibrate, test],
    done: tested ? { title: `${project.name} is set up.`, text: 'Replays of this run cost nothing, and CI catches a change to what the agent sends.', button: { label: 'Go to the overview', action: 'finishsetup' } } : null,
    shows: setup.shows,
  };
}

// ---------------------------------------------------------------------------------------------
// Removing a project

export interface OnDiskRow {
  key: 'code' | 'rec' | 'cfg' | 'gold';
  label: string;
  path: string;
}

/** What the dialog says and does, with or without "Also delete its recordings" ticked. */
export interface RemoveMode {
  text: string;
  note: string;
  button: { label: string; style: 'solid' | 'danger' };
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

/** Remove a project, from the switcher's × or Settings → Project. */
export function removeDialog(input: { project: ProjectEntry; stats: ProjectStats; projects: number; home: string }): RemoveDialogView {
  const { project, stats } = input;
  const path = tildePath(project.path, input.home);
  const canRemove = input.projects > 1;
  const onDisk: OnDiskRow[] = [
    { key: 'code', label: 'The folder and its code', path },
    { key: 'rec', label: stats.runs ? 'Its recordings' : 'Its store, empty so far', path: '.shadowlap/shadowlap.db' },
    { key: 'cfg', label: 'Its settings', path: 'shadowlap.config.json' },
    ...(stats.goldens ? [{ key: 'gold' as const, label: stats.goldens === 1 ? 'Its golden' : `Its ${stats.goldens} goldens`, path: 'goldens/' }] : []),
  ];
  return {
    title: `Remove ${project.name} from the dashboard?`,
    project: { id: project.id, name: project.name, path, initial: initial(project.name), summary: stats.runs ? `${runsLabel(stats.runs)}${stats.goldens ? ` · ${plural(stats.goldens, 'golden')}` : ''}` : 'no runs yet' },
    onDisk,
    keep: {
      text: 'The dashboard stops listing it. Nothing on disk changes.',
      note: 'Adding the folder again brings it all back.',
      button: { label: 'Remove', style: 'solid' },
      crossedOut: null,
      done: `Removed ${project.name} · its folder and recordings are untouched`,
    },
    deleteZone: stats.runs
      ? {
          label: 'Also delete its recordings',
          detail: `${runsLabel(stats.runs)} and ${stats.runs === 1 ? 'its' : 'their'} attempts.${stats.goldens ? ` ${stats.goldens === 1 ? 'The golden is' : 'The goldens are'} in your repository and ${stats.goldens === 1 ? 'stays' : 'stay'}.` : ''}`,
          confirm: `Type ${project.name} to confirm. This can’t be undone.`,
          placeholder: project.name,
          name: project.name,
          mode: {
            text: 'The dashboard stops listing it, and its recordings are deleted.',
            note: 'Adding the folder again brings back everything but the recordings.',
            button: { label: 'Remove and delete recordings', style: 'danger' },
            crossedOut: 'rec',
            done: `Removed ${project.name} and deleted its recordings`,
          },
        }
      : null,
    canRemove,
    why: canRemove ? null : 'The only project can’t be removed',
  };
}

/** The typed name confirms deleting the recordings once it matches the project's name: the server's rule, so the button and the check agree. */
export function nameMatches(typed: string, name: string): boolean {
  return nameConfirms(typed, name);
}

// ---------------------------------------------------------------------------------------------
// Activity

/** The activity feed's line for a project event (`project.added`, `project.setup`, `project.removed`), or null for another kind. */
export function projectEventText(event: Pick<StoredEvent, 'kind' | 'ref' | 'data'>): string | null {
  const d = event.data ?? {};
  const path = typeof d.path === 'string' ? d.path : (event.ref ?? '');
  const name = typeof d.name === 'string' ? d.name : (event.ref ?? '');
  switch (event.kind) {
    case 'project.added':
      return `${d.again ? 'Project added back' : 'Project added'} · ${path}`;
    case 'project.setup':
      return `Set up ${name}${d.skipped ? ' · skipped the rest' : ''}`;
    case 'project.removed':
      return `Removed from the dashboard · ${path}`;
    default:
      return null;
  }
}
