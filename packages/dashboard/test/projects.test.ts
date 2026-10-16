import { describe, expect, it } from 'vitest';
import { deriveSetup, emptySetup, emptyStoreFacts, type FolderKind, type FolderSuggestions, type ProjectEntry, type RunFact, type SetupFindings, type StoreFacts } from '@shadowlap/engine';
import { addProjectPage, addedMessage, nameMatches, projectEventText, projectSwitcher, removeDialog, setupView, shortPath, type SetupInput } from '../src/projects.js';

const HOME = '/home/dana';
const RUN = '01K5CQ7A3M00000000000000AB';

function entry(id: string, over: Partial<ProjectEntry['setup']> = {}, path = `${HOME}/${id}`): ProjectEntry {
  return { id, name: id, path, addedAt: 1, setup: { ...emptySetup(1), ...over }, confirmed: [] };
}

const kind = (k: string | null, label = k ?? 'No project files', why: string | null = null): FolderKind => ({ kind: k, label, languages: [], managers: [], files: [], why });

const findings = (over: Partial<SetupFindings> = {}): SetupFindings => ({
  at: 1,
  language: 'Python 3.12 · uv',
  files: ['pyproject.toml', 'uv.lock'],
  sdk: 'anthropic 0.69.0',
  framework: 'Anthropic tool runner',
  command: ['uv', 'run', 'research-agent', 'Summarize Northwind’s Q3 10-Q'],
  commandFrom: '[project.scripts] in pyproject.toml',
  config: { file: 'shadowlap.config.json', created: true, existed: false },
  tools: [
    { name: 'search_filings', effect: 'read', wrapped: true, why: 'declared', file: 'research_agent/tools.py', line: 12 },
    { name: 'save_report', effect: 'write', wrapped: false, why: '"save" changes something', file: 'research_agent/tools.py', line: 41 },
    { name: 'notify_slack', effect: 'write', wrapped: false, why: 'no hint in the name; write is the safe guess, it never re-runs after a fork', file: 'research_agent/tools.py', line: 58 },
  ],
  wrap: [{ language: 'python', tools: ['save_report', 'notify_slack'], code: 'from shadowlap import tool\n…' }],
  ...over,
});

const run = (status: RunFact['status'] = 'completed', over: Partial<RunFact> = {}): RunFact => ({ runId: RUN, status, startedAt: 10, endedAt: status === 'running' ? null : 20, live: status === 'running', calls: status === 'running' ? 3 : 12, replayedClean: false, ...over });
const facts = (over: Partial<StoreFacts> = {}): StoreFacts => ({ ...emptyStoreFacts(), ...over });

function view(project: ProjectEntry, f: StoreFacts, extra: Partial<SetupInput> = {}, packs: Array<{ path: string; runIds: string[] }> = []) {
  return setupView({ project, setup: deriveSetup(project.setup, f, { packs }), redactRules: 0, home: HOME, ...extra });
}

describe('projectSwitcher', () => {
  it('lists each project with its path and runs, the current one, and those still being set up', () => {
    const v = projectSwitcher({
      projects: [entry('support-agent', { stage: 'done' }), entry('triage-bot')],
      current: 'support-agent',
      stats: { 'support-agent': { runs: 1200, attempts: 9, goldens: 3 }, 'triage-bot': { runs: 0, attempts: 0, goldens: 0 } },
      home: HOME,
    });
    expect(v.heading).toBe('Projects on this machine');
    expect(v.current).toMatchObject({ id: 'support-agent', initial: 'S', path: '~/support-agent' });
    expect(v.items.map((i) => [i.name, i.detail, i.current, i.settingUp, i.removable])).toEqual([
      ['support-agent', '~/support-agent · 1,200 runs', true, false, true],
      ['triage-bot', '~/triage-bot · no runs yet · setting up', false, true, true],
    ]);
    expect(v.items[1]!.removeLabel).toBe('Remove triage-bot from the dashboard');
    expect(v.add).toEqual({ label: 'Add project…', hint: 'a folder with your agent’s code', href: '#/new' });
    expect(v.note).toBe('Each project keeps its own store.');
  });

  it('keeps a long folder to its last folders on the line, the whole path on hover', () => {
    const deep = '/srv/build/workspaces/team-agents/2026/support/refund-agent';
    const v = projectSwitcher({ projects: [entry('refund-agent', { stage: 'done' }, deep)], current: 'refund-agent', stats: { 'refund-agent': { runs: 2, attempts: 0, goldens: 0 } }, home: HOME });
    expect(v.items[0]).toMatchObject({ path: deep, detail: '…/2026/support/refund-agent · 2 runs' });
    expect(shortPath('~/support-agent')).toBe('~/support-agent');
    expect(shortPath('C:\\Users\\dana\\work\\clients\\northwind\\agents\\refund-agent')).toBe('…\\northwind\\agents\\refund-agent');
  });

  it('offers no × for the only project, and says when a folder is gone', () => {
    const one = projectSwitcher({ projects: [entry('agent', { stage: 'done' })], current: 'agent', stats: { agent: { runs: 1, attempts: 0, goldens: 0, missing: true } }, home: HOME });
    expect(one.items[0]).toMatchObject({ removable: false, missing: true, detail: '~/agent · folder not found' });
  });

  it('says setting up as the setup shows it, and when a store can’t be read', () => {
    const v = projectSwitcher({
      projects: [entry('agent', { stage: 'done' }), entry('newer', { stage: 'done' }), entry('Übung')],
      current: 'agent',
      stats: {
        // Finished, its runs since deleted: the setup shows again.
        agent: { runs: 0, attempts: 0, goldens: 0, settingUp: true },
        newer: { runs: 0, attempts: 0, goldens: 0, settingUp: false, unreadable: 'it was written by a newer Shadowlap' },
        'Übung': { runs: 0, attempts: 0, goldens: 0, settingUp: true },
      },
      home: HOME,
    });
    expect(v.items.map((i) => [i.id, i.detail, i.settingUp, i.unreadable])).toEqual([
      ['agent', '~/agent · no runs yet · setting up', true, false],
      ['newer', '~/newer · store can’t be read', false, true],
      ['Übung', '~/Übung · no runs yet · setting up', true, false],
    ]);
    expect(v.items[1]!.why).toBe('it was written by a newer Shadowlap');
    // A name macOS keeps decomposed gets its letter whole on the badge.
    expect(projectSwitcher({ projects: [{ ...entry('ubung'), name: 'U\u0308bung' }], current: 'ubung', stats: {}, home: HOME }).current.initial).toBe('Ü');
  });
});

describe('addProjectPage', () => {
  const suggestions: FolderSuggestions = {
    query: '',
    listed: '~/',
    truncated: false,
    note: null,
    folders: [
      { path: `${HOME}/research-agent`, display: '~/research-agent', name: 'research-agent', folder: kind('Python · uv', 'Python · uv · pyproject.toml'), added: false, projectId: null },
      { path: `${HOME}/triage-bot`, display: '~/triage-bot', name: 'triage-bot', folder: kind('Node · npm', 'Node · npm · package.json'), added: true, projectId: 'triage-bot' },
      { path: `${HOME}/Downloads`, display: '~/Downloads', name: 'Downloads', folder: kind(null), added: false, projectId: null },
      { path: `${HOME}/web-agent`, display: '~/web-agent', name: 'web-agent', folder: kind('Node · pnpm', 'Node · pnpm · package.json · pnpm-lock.yaml'), added: false, projectId: null },
    ],
  };

  it('lists the suggestions with what each holds, folders already added disabled', () => {
    const v = addProjectPage({ query: '', suggestions, home: HOME });
    expect(v.title).toBe('Add a project');
    expect(v.intro).toBe('Pick the folder your agent’s code is in. Nothing runs until you click.');
    // Those that can be added first, then those already added, then those without project files.
    expect(v.folders.map((f) => [f.display, f.note, f.disabled])).toEqual([
      ['~/research-agent', 'Python · uv · pyproject.toml', false],
      ['~/web-agent', 'Node · pnpm · package.json · pnpm-lock.yaml', false],
      ['~/triage-bot', 'already added', true],
      ['~/Downloads', 'no project files found', false],
    ]);
    expect(v.button).toEqual({ label: 'Add project', disabled: true, path: null });
    expect(v.next.steps.map((s) => s.title)).toEqual(['Inspect', 'Record', 'Calibrate', 'Keep it as a test']);
    expect(v.next.note).toBe('The dashboard runs a command in a project’s folder only when you click, and asks first the first time.');
  });

  it('names the picked folder on the button once it can be added, and says why when it can’t', () => {
    const ok = addProjectPage({ query: '~/res', suggestions, picked: { path: `${HOME}/research-agent`, folder: kind('Python · uv') }, home: HOME });
    expect(ok.button).toEqual({ label: 'Add ~/research-agent', disabled: false, path: `${HOME}/research-agent` });
    expect(ok.folders[0]!.selected).toBe(true);
    expect(ok.error).toBeNull();

    const why = 'No pyproject.toml, package.json or requirements file in ~/Downloads. Pick the folder your agent’s code is in.';
    const none = addProjectPage({ query: '', suggestions, picked: { path: `${HOME}/Downloads`, folder: kind(null, 'No project files', why) }, home: HOME });
    expect(none).toMatchObject({ error: why, button: { disabled: true, label: 'Add project' } });

    const again = addProjectPage({ query: '', suggestions, picked: { path: `${HOME}/triage-bot`, folder: kind('Node · npm'), added: true }, home: HOME });
    expect(again).toMatchObject({ error: '~/triage-bot is already in the dashboard.', button: { disabled: true } });
  });

  it('says when nothing matches, or why nothing is listed', () => {
    expect(addProjectPage({ query: 'zzz', suggestions: { ...suggestions, folders: [] }, home: HOME }).empty).toBe('No folder matches “zzz”.');
    expect(addProjectPage({ query: '~/.ssh/', suggestions: { ...suggestions, folders: [], note: 'Hidden folders aren’t listed.' }, home: HOME }).empty).toBe('Hidden folders aren’t listed.');
  });

  it('says when a folder comes back with its runs', () => {
    expect(addedMessage({ project: entry('support-agent'), again: true, runs: 12 }, HOME)).toBe('Added ~/support-agent back · 12 runs');
    expect(addedMessage({ project: entry('triage-bot'), again: false, runs: 0 }, HOME)).toBe('Added ~/triage-bot');
    // New to the dashboard, with runs recorded in a terminal.
    expect(addedMessage({ project: entry('big-agent'), again: false, runs: 20000 }, HOME)).toBe('Added ~/big-agent · 20,000 runs');
  });
});

describe('setupView', () => {
  it('starts with the folder to inspect, and the other steps waiting', () => {
    const v = view(entry('research-agent'), facts());
    expect(v).toMatchObject({ eyebrow: 'research-agent · ~/research-agent', title: 'No runs yet', intro: 'Record the agent once. Every lap after that replays for free.', skip: null, done: null, shows: 'everywhere' });
    expect(v.steps.map((s) => [s.title, s.state, s.cli])).toEqual([
      ['Inspect the folder', 'current', ['shadowlap init']],
      ['Record a first run', 'todo', ['shadowlap run -- <the command that starts your agent>']],
      ['Make the replay clean', 'todo', ['shadowlap calibrate <run> --write']],
      ['Keep it as a test', 'todo', ['shadowlap pack <run> goldens/research-agent', 'shadowlap test goldens/research-agent']],
    ]);
    expect(v.inspect.button).toEqual({ label: 'Inspect the folder', action: 'init' });
    expect(v.record.button).toEqual({ label: 'Record a run', action: 'record', enabled: false });
    expect(v.record.command).toEqual({ value: '', enabled: false });
  });

  it('shows what init found, flags the tools that aren’t wrapped, and fills in the command to record', () => {
    const v = view(entry('research-agent', { stage: 'inspected', findings: findings() }), facts());
    expect(v.inspect.state).toBe('done');
    expect(v.inspect.cli).toEqual([]);
    expect(v.inspect.findings!.rows.map((r) => [r.label, r.value, r.small])).toEqual([
      ['Language', 'Python 3.12 · uv', 'pyproject.toml · uv.lock'],
      ['Model SDK', 'anthropic 0.69.0', null],
      ['Framework', 'Anthropic tool runner', null],
      ['Command', "uv run research-agent 'Summarize Northwind’s Q3 10-Q'", 'from [project.scripts] in pyproject.toml'],
      ['Config', 'wrote an empty shadowlap.config.json', null],
    ]);
    expect(v.inspect.findings!.tools.map((t) => [t.name, t.text, t.at])).toEqual([
      ['search_filings', 'wrapped · effect declared', null],
      ['save_report', 'not wrapped · suggested write, "save" changes something', 'research_agent/tools.py:41'],
      ['notify_slack', 'not wrapped · suggested write, no hint in the name; write is the safe guess, it never re-runs after a fork', 'research_agent/tools.py:58'],
    ]);
    expect(v.inspect.warning).toEqual({
      title: '2 write tools aren’t wrapped.',
      text: 'Their calls won’t be recorded, so a replay runs them for real: save_report and notify_slack would act again. Wrap them, with the effect declared:',
      code: findings().wrap,
      copy: 'Copy',
      recheck: { label: 'I wrapped them, check again', action: 'recheck' },
    });
    expect(v.record).toMatchObject({ state: 'current', command: { value: "uv run research-agent 'Summarize Northwind’s Q3 10-Q'", enabled: true }, button: { enabled: true } });
    expect(v.record.cli).toEqual(["shadowlap run -- uv run research-agent 'Summarize Northwind’s Q3 10-Q'"]);
  });

  it('records through the model server init found, and says when the dashboard can’t', () => {
    const local = findings({ modelServer: { url: 'http://127.0.0.1:11434/v1', upstream: 'http://127.0.0.1:11434', from: 'OPENAI_BASE_URL in .env' } });
    const v = view(entry('local-agent', { stage: 'inspected', findings: local }), facts());
    expect(v.inspect.findings!.rows.find((r) => r.label === 'Model server')).toEqual({ label: 'Model server', value: 'http://127.0.0.1:11434/v1', code: false, small: 'from OPENAI_BASE_URL in .env' });
    expect(v.record).toMatchObject({
      text: 'Runs the command once with a local sidecar in front of your model server. Model calls go to http://127.0.0.1:11434/v1, the model server this project uses.',
      cli: ["SHADOWLAP_UPSTREAM_OPENAI=http://127.0.0.1:11434 shadowlap run -- uv run research-agent 'Summarize Northwind’s Q3 10-Q'"],
      button: { enabled: true },
    });
    const secret = findings({ modelServer: { url: 'https://llm.internal/v1', upstream: null, from: '.env' } });
    const blocked = view(entry('local-agent', { stage: 'inspected', findings: secret }), facts());
    expect(blocked.record).toMatchObject({
      text: expect.stringContaining('The dashboard can’t record through this project’s model server (https://llm.internal/v1)'),
      cli: ["SHADOWLAP_UPSTREAM_OPENAI=<your model server> shadowlap run -- uv run research-agent 'Summarize Northwind’s Q3 10-Q'"],
      command: { enabled: false },
      button: { enabled: false },
    });
  });

  it('follows the recording as it streams in', () => {
    const p = entry('research-agent', { stage: 'inspected', findings: findings(), runId: RUN, command: ['uv', 'run', 'research-agent'] });
    const v = view(p, facts({ runs: 1, recordings: [run('running')], live: true }), { run: { runId: RUN, status: 'running', calls: 3, spent: 0.01, durationMs: null } });
    expect(v.title).toBe('Set up research-agent');
    expect(v.record).toMatchObject({ state: 'current', cli: [], command: null, button: null, live: { runId: RUN, calls: 3, text: 'Recording 01K5CQ7A3M · 3 calls so far', watch: { label: 'Watch it live', href: `#/run/${RUN}` } } });
    expect(v.skip).toBeNull();
    expect(v.calibrate.button).toEqual({ label: 'Calibrate', action: 'calibrate', enabled: false });
  });

  it('says what was recorded, warns when tools weren’t wrapped, and offers to skip the rest', () => {
    const p = entry('research-agent', { stage: 'inspected', findings: findings(), runId: RUN, command: ['uv', 'run', 'research-agent'], unwrappedAtRecord: ['save_report', 'notify_slack'] });
    const v = view(p, facts({ runs: 1, recordings: [run()] }), { run: { runId: RUN, status: 'completed', calls: 12, spent: 0.0412, durationMs: 38_200 } });
    expect(v.record.state).toBe('done');
    expect(v.record.recorded).toEqual({ runId: RUN, href: `#/run/${RUN}`, calls: 12, spent: 0.0412, durationMs: 38_200, text: 'Recorded 01K5CQ7A3M · 12 calls · ≈$0.041 · 38.2 s' });
    expect(v.record.warning).toBe('2 tools weren’t wrapped, so their calls aren’t in this recording. Wrap them and record again before you keep it as a test.');
    expect(v.record.again).toEqual({ label: 'Record again', action: 'record', command: { value: 'uv run research-agent', enabled: true }, cli: ['shadowlap run -- uv run research-agent'] });
    expect(v.record.empty).toBeNull();
    expect(v.calibrate).toMatchObject({ state: 'current', cli: ['shadowlap calibrate 01K5CQ7A3M --write'], button: { enabled: true } });
    expect(v.skip).toEqual({ label: 'Skip the rest', action: 'finishsetup' });
    expect(v.inspect.folded).toBe(false);
    expect(v.shows).toBe('overview');
  });

  it('folds the findings into one line once a run is recorded and every tool is wrapped', () => {
    const wrapped = findings({ tools: findings().tools.map((t) => ({ ...t, wrapped: true })), wrap: [] });
    const v = view(entry('research-agent', { stage: 'recorded', findings: wrapped, runId: RUN }), facts({ runs: 1, recordings: [run()] }));
    expect(v.inspect).toMatchObject({ folded: true, warning: null, summary: "Python 3.12 · uv · anthropic 0.69.0 · 3 tools, all wrapped · uv run research-agent 'Summarize Northwind’s Q3 10-Q'" });
  });

  it('says what calibrate added, then asks where to keep the golden, with the redaction note', () => {
    const p = entry('research-agent', { stage: 'clean', findings: findings(), runId: RUN, calibration: { added: [{ path: '$.system', why: 'a value generated on each run' }] } });
    const v = view(p, facts({ runs: 1, recordings: [run()] }), { run: { runId: RUN, status: 'completed', calls: 12, spent: 0.04, durationMs: 1000 } });
    expect(v.calibrate).toMatchObject({ state: 'done', cli: [], button: null, text: 'Added a normalizer for $.system: a value generated on each run. The replay is clean now.' });
    expect(v.test).toMatchObject({
      state: 'current',
      cli: ['shadowlap pack 01K5CQ7A3M goldens/research-agent', 'shadowlap test goldens/research-agent'],
      golden: { value: 'goldens/research-agent', enabled: true },
      button: { label: 'Pack as a golden', action: 'packgolden', enabled: true },
      redaction: { rules: 0, text: 'There are no redaction rules yet, so the copy holds what was recorded. Add some in Settings before you commit runs with user data.', href: '#/settings/redaction' },
    });
    expect(view(p, facts({ runs: 1, recordings: [run()] }), { redactRules: 2 }).test.redaction!.text).toBe('Your redaction rules apply to the copy.');
    const clean = entry('research-agent', { stage: 'clean', runId: RUN, calibration: { added: [] } });
    expect(view(clean, facts({ runs: 1, recordings: [run()] })).calibrate.text).toBe('The replay was clean as recorded: nothing to add.');
  });

  it('offers the normalizers calibrate proposed, and says why it stopped', () => {
    const p = entry('research-agent', { stage: 'recorded', findings: findings(), runId: RUN });
    const f = facts({ runs: 1, recordings: [run()] });
    const one = view(p, f, { calibration: { done: false, added: [], proposed: [{ path: '$.metadata.user_id', why: 'this looks like a UUID' }], stopped: null } });
    expect(one.calibrate).toMatchObject({
      state: 'current',
      text: 'Found a value the agent makes anew on every run, at $.metadata.user_id: this looks like a UUID. A normalizer for it makes the replay clean.',
      button: { label: 'Add it', action: 'calibratewrite', enabled: true },
      cli: ['shadowlap calibrate 01K5CQ7A3M --write'],
      proposed: [{ path: '$.metadata.user_id', why: 'this looks like a UUID' }],
      stopped: null,
    });
    const two = view(p, f, { calibration: { done: false, added: [], proposed: [{ path: '$.system', why: null }, { path: '$.metadata.user_id', why: null }], stopped: null } });
    expect(two.calibrate.text).toBe('Found 2 values the agent makes anew on every run, at $.system and $.metadata.user_id. Normalizers for them make the replay clean.');
    expect(two.calibrate.button).toMatchObject({ label: 'Add them', action: 'calibratewrite' });

    const stopped = view(p, f, { calibration: { done: false, added: [], proposed: [], stopped: 'still diverging after 8 rounds' } });
    expect(stopped.calibrate).toMatchObject({ text: 'Calibrate stopped: still diverging after 8 rounds.', button: { label: 'Calibrate', action: 'calibrate', enabled: true }, stopped: 'still diverging after 8 rounds' });
    // Once the list says the step is done, an old result changes nothing.
    const done = entry('research-agent', { stage: 'clean', runId: RUN, calibration: { added: [{ path: '$.metadata.user_id', why: null }] } });
    expect(view(done, f, { calibration: { done: false, added: [], proposed: [{ path: '$.x', why: null }], stopped: null } }).calibrate).toMatchObject({ state: 'done', button: null, proposed: [], text: 'Added a normalizer for $.metadata.user_id. The replay is clean now.' });
  });

  it('ends with the golden replaying clean, and the project set up', () => {
    const p = entry('research-agent', { stage: 'tested', findings: findings(), runId: RUN, golden: 'goldens/northwind-q3' });
    const v = view(p, facts({ runs: 2, recordings: [run()] }), { run: { runId: RUN, status: 'completed', calls: 12, spent: 0.04, durationMs: 1000 } });
    expect(v.test).toMatchObject({ state: 'done', cli: [], golden: null, button: null, result: { text: 'goldens/northwind-q3 replayed clean offline · 12/12 calls', link: { label: 'Open Tests', href: '#/tests' } } });
    expect(v.done).toEqual({ title: 'research-agent is set up.', text: 'Replays of this run cost nothing, and CI catches a change to what the agent sends.', button: { label: 'Go to the overview', action: 'finishsetup' } });
    expect(v.skip).toBeNull();
    expect(v.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('shows the steps a setup finished without as skipped, and claims no golden it never packed', () => {
    const p = entry('research-agent', { stage: 'done', skipped: true, findings: findings(), runId: RUN });
    const v = view(p, facts({ runs: 1, recordings: [run()] }));
    expect(v.steps.map((x) => x.state)).toEqual(['done', 'done', 'skipped', 'skipped']);
    expect(v.test.result).toBeNull();
    expect(v.done).toBeNull();
    expect(v.skip).toBeNull();
    expect(v.shows).toBe('none');
    // Calibrated, then skipped: the calibration still counts. It never ran init, so step 1 was skipped too.
    const calibrated = entry('research-agent', { stage: 'done', skipped: true, runId: RUN, calibration: { added: [] } });
    expect(view(calibrated, facts({ runs: 1, recordings: [run()] })).steps.map((x) => x.state)).toEqual(['skipped', 'done', 'done', 'skipped']);
  });

  it('calls step 1 done only once init ran, and skipped when a recording came first', () => {
    // Recorded in a terminal before init: step 1 can still be done, and says so.
    const terminal = view(entry('triage-bot', { stage: 'recorded', runId: RUN }), facts({ runs: 1, recordings: [run()] }));
    expect(terminal.inspect).toMatchObject({
      state: 'skipped',
      text: 'Recorded before the folder was inspected. Inspect it to see its tools, and whether each one is wrapped.',
      button: { label: 'Inspect the folder', action: 'init' },
      cli: ['shadowlap init'],
      findings: null,
    });
    expect(terminal.record.state).toBe('done');
    // A folder counted as set up when the dashboard started there, its runs since deleted, never inspected:
    // the setup starts from step 1, not from a step 1 marked done with nothing to show for it.
    const restarted = view(entry('agent', { stage: 'done' }), facts());
    expect(restarted).toMatchObject({ title: 'No runs yet', shows: 'everywhere' });
    expect(restarted.steps.map((x) => x.state)).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(restarted.inspect).toMatchObject({ text: expect.stringMatching(/^Finds the model SDKs/), button: { action: 'init' } });
    // Inspected before its runs were deleted: it starts again from recording.
    const inspected = view(entry('agent', { stage: 'done', findings: findings() }), facts());
    expect(inspected.steps.map((x) => x.state)).toEqual(['done', 'current', 'todo', 'todo']);
  });

  it('words one tool that isn’t wrapped in the singular', () => {
    const oneTool = findings({ tools: [findings().tools[0]!, findings().tools[1]!], wrap: [{ language: 'python', tools: ['save_report'], code: 'from shadowlap import tool\n…' }] });
    const v = view(entry('research-agent', { stage: 'inspected', findings: oneTool, runId: RUN }), facts({ runs: 1, recordings: [run()] }));
    expect(v.inspect.warning).toMatchObject({
      title: '1 write tool isn’t wrapped.',
      text: 'Its calls won’t be recorded, so a replay runs it for real: save_report would act again. Wrap it, with the effect declared:',
      recheck: { label: 'I wrapped it, check again', action: 'recheck' },
    });
    expect(v.record.warning).toBe('1 tool wasn’t wrapped, so its calls aren’t in this recording. Wrap it and record again before you keep it as a test.');
  });

  it('says when the tools a recording missed are wrapped now, and offers to record again until the replay is clean', () => {
    const wrappedNow = findings({ at: 50, tools: findings().tools.map((t) => ({ ...t, wrapped: true })), wrap: [] });
    const p = entry('research-agent', { stage: 'recorded', findings: wrappedNow, inspections: [{ at: 1, unwrapped: ['save_report', 'notify_slack'] }, { at: 50, unwrapped: [] }], runId: RUN, command: ['uv', 'run', 'research-agent'] });
    const v = view(p, facts({ runs: 1, recordings: [run()] }));
    expect(v.record.warning).toBe('2 tools weren’t wrapped, so their calls aren’t in this recording. They are wrapped now: record again before you keep it as a test.');
    expect(v.record.again).toMatchObject({ label: 'Record again', action: 'record', command: { value: 'uv run research-agent', enabled: true } });
    expect(v.inspect.warning).toBeNull();
    // Recorded again since: the new recording is the setup's, with nothing missing.
    const r2 = { ...run('completed', { startedAt: 60 }), runId: '01K5CQ9Z0000000000000000R2' };
    const again = view(p, facts({ runs: 2, recordings: [r2, run()] }));
    expect(again.record).toMatchObject({ state: 'done', warning: null, again: null, recorded: { runId: r2.runId } });
    expect(again.calibrate.cli).toEqual(['shadowlap calibrate 01K5CQ9Z00 --write']);
    // Once the replay is clean, the recording stays: no more Record again.
    const clean = entry('research-agent', { stage: 'clean', findings: wrappedNow, inspections: p.setup.inspections, runId: RUN, calibration: { added: [] } });
    expect(view(clean, facts({ runs: 1, recordings: [run()] })).record).toMatchObject({ warning: expect.stringContaining('They are wrapped now'), again: null });
  });

  it('says when the last recording held nothing, and asks for the command again', () => {
    const typo = { ...run('failed', { calls: 0, startedAt: 30 }), runId: '01M4ZKQKEF000000000000TYPO' };
    const v = view(entry('research-agent', { stage: 'inspected', findings: findings(), runId: typo.runId, command: ['nod', 'agent.mjs'] }), facts({ runs: 1, recordings: [typo] }));
    expect(v.title).toBe('Set up research-agent');
    expect(v.record).toMatchObject({ state: 'current', recorded: null, command: { value: 'nod agent.mjs', enabled: true }, button: { label: 'Record a run', enabled: true } });
    expect(v.record.empty).toEqual({ runId: typo.runId, href: `#/run/${typo.runId}`, text: '01M4ZKQKEF holds no calls, so nothing was recorded: the command didn’t start your agent, or no model call reached Shadowlap. Check the command and record again.' });
    expect(v.skip).toBeNull();
    // An earlier recording stays the setup's, and the empty one is still pointed out.
    const kept = view(entry('research-agent', { stage: 'recorded', findings: findings({ tools: [], wrap: [] }), runId: RUN }), facts({ runs: 2, recordings: [typo, run()] }));
    expect(kept.record).toMatchObject({ state: 'done', recorded: { runId: RUN }, empty: { runId: typo.runId } });
    // Once the replay is clean, an empty recording after it no longer concerns the setup.
    const clean = view(entry('research-agent', { stage: 'clean', findings: findings({ tools: [], wrap: [] }), runId: RUN, calibration: { added: [] } }), facts({ runs: 2, recordings: [typo, run()] }));
    expect(clean.record).toMatchObject({ state: 'done', recorded: { runId: RUN }, empty: null });
  });

  it('offers the free golden path the server found, and keeps a pack made in a terminal open until its test passes', () => {
    const p = entry('research-agent', { stage: 'recorded', findings: findings({ tools: [], wrap: [] }), runId: RUN });
    const f = facts({ runs: 1, recordings: [run()] });
    const offered = view(p, f, { golden: 'goldens/research-agent-2' });
    expect(offered.test).toMatchObject({ golden: { value: 'goldens/research-agent-2', enabled: false }, cli: ['shadowlap pack 01K5CQ7A3M goldens/research-agent-2', 'shadowlap test goldens/research-agent-2'], packed: null });
    // Packed, its test not run: the step stays open, with the test to run.
    const packs = [{ path: 'goldens/q3', runIds: [RUN] }];
    const packed = view(p, f, { golden: 'goldens/research-agent-2' }, packs);
    expect(packed.test).toMatchObject({
      state: 'current',
      cli: ['shadowlap test goldens/q3'],
      golden: null,
      redaction: null,
      result: null,
      button: { label: 'Run the test', action: 'testgolden', enabled: true },
      packed: { golden: 'goldens/q3', failed: false, text: 'Packed as goldens/q3. Its test replays it offline: run it to finish.', link: null },
    });
    expect(packed.done).toBeNull();
    expect(packed.skip).toEqual({ label: 'Skip the rest', action: 'finishsetup' });
    // Its test failed: why, and where to look.
    const test = (ok: boolean) => ({ golden: 'goldens/q3', ok, at: 30, reason: ok ? null : 'diverged at call 4 (api POST /v1/messages).', goldenRunId: RUN });
    const failed = view(p, facts({ runs: 1, recordings: [run()], tests: [test(false)] }), {}, packs);
    expect(failed.test).toMatchObject({ state: 'current', button: { label: 'Run the test again', action: 'testgolden' }, packed: { failed: true, text: 'goldens/q3 failed its test: diverged at call 4 (api POST /v1/messages). Fix what changed, or record again, then run it again.', link: { label: 'Open Tests', href: '#/tests' } } });
    // Passed: done. Packed without calibrating first: step 3 was skipped.
    const passed = view(p, facts({ runs: 1, recordings: [run()], tests: [test(true)] }), {}, packs);
    expect(passed.test).toMatchObject({ state: 'done', cli: [], button: null, packed: null, result: { text: 'goldens/q3 replayed clean offline', link: { label: 'Open Tests', href: '#/tests' } } });
    expect(passed.steps.map((x) => x.state)).toEqual(['done', 'done', 'skipped', 'done']);
    expect(passed.skip).toBeNull();
    expect(passed.done).toMatchObject({ title: 'research-agent is set up.' });
  });

  it('counts a clean replay as step 3, and never shows another recording’s calibration', () => {
    const p = entry('research-agent', { stage: 'recorded', findings: findings({ tools: [], wrap: [] }), runId: RUN });
    const replayed = view(p, facts({ runs: 2, recordings: [run('completed', { replayedClean: true })] }));
    expect(replayed.calibrate).toMatchObject({ state: 'done', cli: [], button: null, text: 'A replay of 01K5CQ7A3M ran clean.' });
    expect(replayed.test).toMatchObject({ state: 'current', button: { enabled: true } });
    // The list calibrated a recording since deleted: this one isn't clean yet.
    const other = entry('research-agent', { stage: 'clean', findings: findings({ tools: [], wrap: [] }), runId: 'DELETED', calibration: { added: [{ path: '$.system', why: null }] } });
    expect(view(other, facts({ runs: 1, recordings: [run()] })).calibrate).toMatchObject({ state: 'current', button: { label: 'Calibrate', action: 'calibrate', enabled: true } });
  });

  it('counts a recording made in a terminal, and shows the setup nowhere once it is finished', () => {
    const terminal = view(entry('triage-bot', { stage: 'inspected', findings: findings({ tools: [], wrap: [] }) }), facts({ runs: 1, recordings: [run()] }));
    expect(terminal.record.state).toBe('done');
    expect(terminal.calibrate.state).toBe('current');
    expect(view(entry('triage-bot', { stage: 'done', runId: RUN }), facts({ runs: 4, recordings: [run()] })).shows).toBe('none');
  });
});

describe('removeDialog', () => {
  it('shows the project, what stays on disk, and the separate zone that deletes its recordings', () => {
    const v = removeDialog({ project: entry('support-agent', { stage: 'done' }), stats: { runs: 12, attempts: 4, goldens: 2 }, projects: 2, home: HOME });
    expect(v.title).toBe('Remove support-agent from the dashboard?');
    expect(v.project).toEqual({ id: 'support-agent', name: 'support-agent', path: '~/support-agent', initial: 'S', summary: '12 runs · 2 goldens' });
    expect(v.onDisk).toEqual([
      { key: 'code', label: 'The folder and its code', path: '~/support-agent' },
      { key: 'rec', label: 'Its recordings', path: '.shadowlap/shadowlap.db' },
      { key: 'cfg', label: 'Its settings', path: 'shadowlap.config.json' },
      { key: 'gold', label: 'Its 2 goldens', path: 'goldens/' },
    ]);
    expect(v.keep).toEqual({ text: 'The dashboard stops listing it. Nothing on disk changes.', note: 'Adding the folder again brings it all back.', button: { label: 'Remove', style: 'solid' }, crossedOut: null, done: 'Removed support-agent · its folder and recordings are untouched' });
    expect(v.deleteZone).toEqual({
      label: 'Also delete its recordings',
      detail: '12 runs and their attempts. The goldens are in your repository and stay.',
      confirm: 'Type support-agent to confirm. This can’t be undone.',
      placeholder: 'support-agent',
      name: 'support-agent',
      mode: { text: 'The dashboard stops listing it, and its recordings are deleted.', note: 'Adding the folder again brings back everything but the recordings.', button: { label: 'Remove and delete recordings', style: 'danger' }, crossedOut: 'rec', done: 'Removed support-agent and deleted its recordings' },
    });
    expect(v).toMatchObject({ canRemove: true, why: null });
  });

  it('has no recordings to delete for a project with no runs, and can’t remove the only project', () => {
    const v = removeDialog({ project: entry('triage-bot'), stats: { runs: 0, attempts: 0, goldens: 0 }, projects: 1, home: HOME });
    expect(v.project.summary).toBe('no runs yet');
    expect(v.onDisk.map((r) => r.label)).toEqual(['The folder and its code', 'Its store, empty so far', 'Its settings']);
    expect(v.deleteZone).toBeNull();
    expect(v).toMatchObject({ canRemove: false, why: 'The only project can’t be removed' });
  });

  it('says a folder that is gone holds nothing to keep', () => {
    const v = removeDialog({ project: entry('old-agent'), stats: { runs: 0, attempts: 0, goldens: 0, missing: true }, projects: 2, home: HOME });
    expect(v.onDisk).toEqual([{ key: 'code', label: 'Its folder, not on disk any more', path: '~/old-agent' }]);
    expect(v.keep).toMatchObject({ note: 'Put the folder back and add it again to bring it all back.', crossedOut: 'code' });
    expect(v.deleteZone).toBeNull();
  });

  it('words one run and one golden in the singular', () => {
    const v = removeDialog({ project: entry('triage-bot'), stats: { runs: 1, attempts: 0, goldens: 1 }, projects: 2, home: HOME });
    expect(v.project.summary).toBe('1 run · 1 golden');
    expect(v.onDisk.at(-1)).toEqual({ key: 'gold', label: 'Its golden', path: 'goldens/' });
    expect(v.deleteZone!.detail).toBe('1 run and its attempts. The golden is in your repository and stays.');
  });

  it('confirms by the exact name, however it is composed', () => {
    expect(nameMatches(' support-agent ', 'support-agent')).toBe(true);
    expect(nameMatches('support-agen', 'support-agent')).toBe(false);
    expect(nameMatches('Support-agent', 'support-agent')).toBe(false);
    expect(nameMatches('Bücher-agent', 'Bu\u0308cher-agent')).toBe(true);
  });

  it('names the repair reports and exports that deleting the recordings leaves', () => {
    const v = removeDialog({ project: entry('support-agent', { stage: 'done' }), stats: { runs: 3, attempts: 0, goldens: 0, madeFiles: ['.shadowlap/repairs', '.shadowlap/exports'] }, projects: 2, home: HOME });
    expect(v.onDisk.at(-1)).toEqual({ key: 'made', label: 'Its repair reports and exports', path: '.shadowlap/repairs/ · .shadowlap/exports/' });
    expect(v.deleteZone!.detail).toBe('3 runs and their attempts. Its repair reports and exports in .shadowlap/ stay too: delete them yourself if they hold what you mean to delete.');
    // Ticked, only the store is crossed out.
    expect(v.deleteZone!.mode.crossedOut).toBe('rec');
    const one = removeDialog({ project: entry('support-agent'), stats: { runs: 1, attempts: 0, goldens: 0, madeFiles: ['.shadowlap/uploads'] }, projects: 2, home: HOME });
    expect(one.onDisk.at(-1)).toEqual({ key: 'made', label: 'Its files sent to jobs', path: '.shadowlap/uploads/' });
  });
});

describe('projectEventText', () => {
  it('words the activity a project leaves', () => {
    expect(projectEventText({ kind: 'project.added', ref: 'triage-bot', data: { path: '~/triage-bot' } })).toBe('Project added · ~/triage-bot');
    expect(projectEventText({ kind: 'project.added', ref: 'support-agent', data: { path: '~/support-agent', again: true } })).toBe('Project added back · ~/support-agent');
    expect(projectEventText({ kind: 'project.setup', ref: 'triage-bot', data: { name: 'triage-bot', skipped: false } })).toBe('Set up triage-bot');
    expect(projectEventText({ kind: 'project.setup', ref: 'triage-bot', data: { name: 'triage-bot', skipped: true } })).toBe('Set up triage-bot · skipped the rest');
    expect(projectEventText({ kind: 'project.removed', ref: 'x', data: { path: '~/x' } })).toBe('Removed from the dashboard · ~/x');
    // init logs writing the config under the same kind: a step, not a finished setup.
    expect(projectEventText({ kind: 'project.setup', ref: 'triage-bot', data: { name: 'triage-bot', config: 'created', languages: ['python'] } })).toBe('Inspected triage-bot · wrote shadowlap.config.json');
    expect(projectEventText({ kind: 'project.setup', ref: 'triage-bot', data: { stage: 'done', name: 'triage-bot', skipped: false } })).toBe('Set up triage-bot');
    expect(projectEventText({ kind: 'golden.packed', ref: null, data: null })).toBeNull();
  });
});
