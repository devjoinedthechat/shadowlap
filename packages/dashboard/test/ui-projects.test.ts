import { describe, expect, it } from 'vitest';
import { dialogFocus } from '../ui/focus.js';
import { aroundRunId, aroundWord, asksForSetup, codeParts, confirmedRecording, exportedLine, keepsPageOnSwitch, liveCalls, nameMatches, recordingLine, setupPageShows, setupShowsOn, stepClass, storePath, switchedText, terminalLine } from '../ui/projects.js';
import { dialogOnSwitch, expectProject, noteDialogDropped, noteRefusal, onProjectSwitched, onShownProject, projectHeader, showProject, shownProject, takeDialogDropped, takeLanding } from '../ui/projects-api.js';
import { parseRoute } from '../ui/route.js';
import type { RunLike } from '../ui/runs.js';
import type { Meta } from '../ui/types.js';

/** The projects screens' logic without the DOM: where the setup shows, the typed name, and how words show names as code. */

const run = (over: Partial<RunLike> = {}): RunLike => ({
  runId: '01M50Y3WTSEH941T7MPAYCFNY4',
  parentRunId: null,
  mode: 'record',
  status: 'completed',
  divergence: null,
  command: 'node main.js',
  codeVersion: null,
  startedAt: 0,
  calls: 30,
  spent: 0.07,
  saved: 0,
  captured: 0,
  imported: false,
  covers: null,
  source: null,
  labels: [],
  ...over,
});

const meta = (over: Partial<Meta> = {}): Meta => ({ version: '0.1.0', dbPath: '/home/dana/agent/.shadowlap/shadowlap.db', actions: true, ...over });

describe('where the setup shows', () => {
  const at = (hash: string) => parseRoute(hash);
  const project = (settingUp: boolean) => meta({ project: { id: 'agent', name: 'agent', path: '/home/dana/agent', settingUp } });

  it('takes every page but Settings while the project has no runs, and #/setup always', () => {
    const none = { exported: false, meta: project(true), runs: [] };
    for (const hash of ['#/', '#/runs', '#/compare', '#/fixes', '#/tests', '#/training', '#/run/01M50Y3WTS']) expect(setupShowsOn(at(hash), none), hash).toBe(true);
    expect(setupShowsOn(at('#/settings/matching'), none)).toBe(false);
    expect(setupShowsOn(at('#/new'), none)).toBe(false);
    expect(setupShowsOn(at('#/setup'), { ...none, runs: [run()], meta: project(false) })).toBe(true);
    // Attempts alone are no runs to show.
    expect(setupShowsOn(at('#/runs'), { ...none, runs: [run({ attemptKind: 'repeat', attemptOf: 'x' } as Partial<RunLike>)] })).toBe(true);
  });

  it('takes the Overview of a project partway through its setup, and nothing else', () => {
    const mid = { exported: false, meta: project(true), runs: [run()] };
    expect(setupShowsOn(at('#/'), mid)).toBe(true);
    expect(setupShowsOn(at('#/runs'), mid)).toBe(false);
    expect(setupShowsOn(at('#/'), { ...mid, meta: project(false) })).toBe(false);
  });

  it('waits until it can tell, never shows in an exported copy, and lets a run page open on its own', () => {
    expect(setupShowsOn(at('#/'), { exported: false, meta: null, runs: null })).toBeNull();
    // The meta's count tells before the run list arrives.
    expect(setupShowsOn(at('#/'), { exported: false, meta: meta({ counts: { runs: 0, attempts: 0 } }), runs: null })).toBe(true);
    expect(setupShowsOn(at('#/run/01M50Y3WTS'), { exported: false, meta: null, runs: null })).toBe(false);
    expect(setupShowsOn(at('#/'), { exported: true, meta: null, runs: [] })).toBe(false);
    expect(setupShowsOn(at('#/'), { exported: false, meta: meta({ static: true }), runs: [] })).toBe(false);
  });
});

describe('the setup on a dashboard that serves one store', () => {
  const project = meta({ project: { id: 'agent', name: 'agent', path: '/home/dana/agent' } });
  const oneStore = meta();

  it('asks the server for a setup only once the meta says it serves projects', () => {
    expect(asksForSetup(null)).toBe(false);
    // `shadowlap dashboard --read-only` and the terminal UI's serve one store, with no setup route to ask.
    expect(asksForSetup(oneStore)).toBe(false);
    expect(asksForSetup(project)).toBe(true);
    // An exported copy answers without asking.
    expect(asksForSetup(meta({ static: true }))).toBe(true);
  });

  it('says there is nothing to set up once the store has runs, and shows the steps from the first before, never made-up progress', () => {
    expect(setupPageShows({ meta: null, view: undefined, runs: null })).toBe('wait');
    expect(setupPageShows({ meta: oneStore, view: undefined, runs: [run()] })).toBe('nothing');
    expect(setupPageShows({ meta: oneStore, view: undefined, runs: [] })).toBe('steps');
    expect(setupPageShows({ meta: oneStore, view: undefined, runs: [run({ attemptKind: 'repeat', attemptOf: 'x' } as Partial<RunLike>)] })).toBe('steps');
    // A project's dashboard waits for its setup, then shows it; one whose server answers none falls back the same way.
    expect(setupPageShows({ meta: project, view: undefined, runs: [] })).toBe('wait');
    expect(setupPageShows({ meta: project, view: { shows: 'setup' }, runs: [] })).toBe('project');
    expect(setupPageShows({ meta: project, view: null, runs: [run()] })).toBe('nothing');
  });
});

describe('a dialog when the dashboard switches project elsewhere', () => {
  it('closes one that asks about the project it opened in, and keeps one that holds only what was typed into it', () => {
    expect(dialogOnSwitch({ openedIn: 'research-agent', shown: 'triage-bot', keeps: false })).toBe('close');
    expect(dialogOnSwitch({ openedIn: 'research-agent', shown: 'triage-bot', keeps: true })).toBe('adopt');
    expect(dialogOnSwitch({ openedIn: 'research-agent', shown: 'research-agent', keeps: false })).toBe('stay');
    // Opened before the meta named a project: it belongs to the first one shown.
    expect(dialogOnSwitch({ openedIn: null, shown: 'triage-bot', keeps: false })).toBe('adopt');
    expect(dialogOnSwitch({ openedIn: 'research-agent', shown: null, keeps: false })).toBe('stay');
  });

  it('hears the page turn to another project once, not every time the meta names the same one', () => {
    showProject('research-agent');
    const heard: Array<string | null> = [];
    const stop = onShownProject((id) => heard.push(id));
    showProject('research-agent');
    showProject('triage-bot');
    showProject('triage-bot');
    expect(heard).toEqual(['triage-bot']);
    expect(shownProject()).toBe('triage-bot');
    expect(projectHeader()).toEqual({ 'x-shadowlap-project': 'triage-bot' });
    stop();
    showProject('research-agent');
    expect(heard).toEqual(['triage-bot']);
    showProject(null);
  });

  it('starts a confirmed first run as the project it was asked in, and says nothing was done when a dialog closed for a switch', () => {
    // The record confirm opened on research-agent: the job names it, so a dashboard switched to triage-bot meanwhile refuses it (409).
    const asked = { confirm: { title: 'Record run in ~/research-agent', lead: 'Records one run: every model and tool call.', moved: null, calls: { value: 'the real API, with your keys', quiet: 'never stored' }, command: 'shadowlap run -- uv run research-agent', button: 'Run and record' }, command: 'uv run research-agent', project: 'research-agent' };
    expect(confirmedRecording(asked)).toEqual({ project: 'research-agent', command: 'uv run research-agent', confirmed: true });
    expect(takeDialogDropped()).toBe(false);
    noteDialogDropped();
    expect(takeDialogDropped()).toBe(true);
    expect(takeDialogDropped()).toBe(false);
  });

  it('starts on Cancel when asked to, or when the action is red', () => {
    expect(dialogFocus('lime', 'cancel')).toEqual(['.dlg-cancel']);
    expect(dialogFocus('danger', 'cancel')).toEqual(['.dlg-cancel']);
    expect(dialogFocus('danger')).toEqual(['.dlg-cancel']);
    expect(dialogFocus('lime')).toEqual([expect.stringMatching(/^textarea, input.*select$/), '.dlg-alt', '.dlg-ok', '.dlg-cancel']);
  });
});

describe('the Remove dialog’s typed name', () => {
  it('matches trimmed and composed, as the server compares it', () => {
    expect(nameMatches(' support-agent ', 'support-agent')).toBe(true);
    expect(nameMatches('support', 'support-agent')).toBe(false);
    // macOS names a folder "Ü" as U and a combining diaeresis; typing it gives the composed letter.
    expect(nameMatches('Übung', 'Übung')).toBe(true);
  });
});

describe('the setup’s words', () => {
  it('marks a step done, current, or still to do (a skipped one too)', () => {
    expect(['done', 'current', 'todo', 'skipped'].map((s) => stepClass(s as 'done'))).toEqual(['done', 'cur', 'todo', 'todo']);
  });

  it('shows names as code where they stand as words, longer names first', () => {
    const parts = codeParts('save_report and notify_slack would act again; save_reports is another', ['save_report', 'notify_slack']);
    expect(parts.filter((p) => p.code).map((p) => p.text)).toEqual(['save_report', 'notify_slack']);
    expect(parts.map((p) => p.text).join('')).toBe('save_report and notify_slack would act again; save_reports is another');
    expect(codeParts('Added a normalizer for $.metadata.user_id.', ['$.metadata.user_id']).filter((p) => p.code).map((p) => p.text)).toEqual(['$.metadata.user_id']);
    expect(codeParts('No pyproject.toml, package.json or requirements file in ~/Downloads.', ['pyproject.toml', 'package.json']).filter((p) => p.code).map((p) => p.text)).toEqual(['pyproject.toml', 'package.json']);
    expect(codeParts('nothing to mark', [])).toEqual([{ text: 'nothing to mark', code: false }]);
  });

  it('links the run id in a recorded line, and counts a live recording’s calls as they arrive', () => {
    expect(aroundRunId('Recorded 01M50Y3WTS · 30 calls · ≈$0.072 · 4.9 s', '01M50Y3WTSEH941T7MPAYCFNY4')).toEqual({ before: 'Recorded ', id: '01M50Y3WTS', after: ' · 30 calls · ≈$0.072 · 4.9 s' });
    expect(aroundRunId('Recorded nothing', '01M50Y3WTSEH941T7MPAYCFNY4')).toEqual({ before: 'Recorded nothing', id: '', after: '' });
    expect(liveCalls('01M50Y3WTS', 3, [{ runId: '01M50Y3WTS', calls: 21 }])).toBe(21);
    expect(liveCalls('01M50Y3WTS', 3, [])).toBe(3);
    expect(recordingLine('01M50Y3WTSEH941T7MPAYCFNY4', 1)).toEqual({ id: '01M50Y3WTS', rest: ' · 1 call so far' });
    expect(recordingLine('01M50Y3WTSEH941T7MPAYCFNY4', 21).rest).toBe(' · 21 calls so far');
  });

  it('links Settings in the golden’s redaction note', () => {
    expect(aroundWord('Add some in Settings before you commit runs with user data.', 'Settings')).toEqual({ before: 'Add some in ', word: 'Settings', after: ' before you commit runs with user data.' });
    expect(aroundWord('Your redaction rules apply to the copy.', 'Settings')).toBeNull();
  });

  it('keeps the terminal line in step with the command as typed', () => {
    const found = ['shadowlap run -- node agent.js'];
    expect(terminalLine(found, 'node agent.js', null)).toBe(found);
    expect(terminalLine(found, 'node agent.js', ' node agent.js ')).toBe(found);
    expect(terminalLine(found, 'node agent.js', 'node main.js')).toEqual(['shadowlap run -- node main.js']);
    // Through the project's own model server, the variable stays in front.
    expect(terminalLine(['SHADOWLAP_UPSTREAM_OPENAI=http://127.0.0.1:11434 shadowlap run -- uv run agent.py'], 'uv run agent.py', 'uv run research-agent')).toEqual(['SHADOWLAP_UPSTREAM_OPENAI=http://127.0.0.1:11434 shadowlap run -- uv run research-agent']);
    // No command found: the typed one takes the placeholder's place.
    expect(terminalLine(['shadowlap run -- <the command that starts your agent>'], '', 'node main.js')).toEqual(['shadowlap run -- node main.js']);
  });
});

describe('the status bar’s store', () => {
  it('names the store under the project’s folder as the server shows it', () => {
    const project = { id: 'agent', name: 'agent', path: '/srv/demo/home/agent', display: '~/agent' };
    expect(storePath({ dbPath: '/srv/demo/home/agent/.shadowlap/shadowlap.db', project })).toBe('~/agent/.shadowlap/shadowlap.db');
    // A store elsewhere (--db), or a folder that only starts the same, keeps its own path.
    expect(storePath({ dbPath: '/srv/demo/home/agent-2/.shadowlap/shadowlap.db', project })).toBe('/srv/demo/home/agent-2/.shadowlap/shadowlap.db');
    expect(storePath({ dbPath: '/home/dana/elsewhere/db.sqlite', project })).toBe('~/elsewhere/db.sqlite');
    expect(storePath({ dbPath: '/home/dana/agent/.shadowlap/shadowlap.db', project: null })).toBe('~/agent/.shadowlap/shadowlap.db');
  });
});

describe('the project a page shows', () => {
  it('names it on every request, and turns the page when a change is refused because the dashboard switched elsewhere', () => {
    showProject('research-agent');
    expect(projectHeader()).toEqual({ 'x-shadowlap-project': 'research-agent' });
    const heard: string[] = [];
    const stop = onProjectSwitched((current) => heard.push(current.id));
    // Refused for another reason, or naming the project shown: nothing to turn to.
    noteRefusal(400, { error: 'no', current: { id: 'support-agent', name: 'support-agent' } });
    noteRefusal(409, { error: 'Record a first run before finishing the setup.' });
    noteRefusal(409, { error: 'x', current: { id: 'research-agent', name: 'research-agent' } });
    expect(heard).toEqual([]);
    noteRefusal(409, { error: 'The dashboard switched to support-agent elsewhere, so nothing was done in research-agent.', current: { id: 'support-agent', name: 'support-agent' } });
    expect(heard).toEqual(['support-agent']);
    stop();
    noteRefusal(409, { current: { id: 'support-agent', name: 'support-agent' } });
    expect(heard).toEqual(['support-agent']);
    // A dashboard that serves one store names no project: nothing is sent.
    showProject(null);
    expect(projectHeader()).toEqual({});
  });
});

describe('the project block of an exported copy', () => {
  it('counts the runs it holds in words', () => {
    expect(exportedLine(1)).toBe('1 run · nothing runs from here');
    expect(exportedLine(2)).toBe('2 runs · nothing runs from here');
  });
});

describe('a switch made elsewhere', () => {
  it('keeps a page every project has, with what is open on it, and leaves one that names the other project’s runs or fixes', () => {
    for (const hash of ['#/', '#/runs', '#/compare', '#/fixes', '#/tests', '#/training/tasks', '#/settings/redaction', '#/new', '#/setup']) expect(keepsPageOnSwitch(parseRoute(hash)), hash).toBe(true);
    for (const hash of ['#/run/01M51X7HV4', '#/run/01M51X7HV4/3/context', '#/compare/01M51X7HV4/01M51X7HR0', '#/fixes/fx-01M51X6N0C', '#/nowhere']) expect(keepsPageOnSwitch(parseRoute(hash)), hash).toBe(false);
  });

  it('says what happened, and that nothing was done when a change was refused for it', () => {
    expect(switchedText({ from: 'support-agent', to: 'triage-bot', refused: true })).toBe('Nothing was done in support-agent: the dashboard switched to triage-bot elsewhere, and this page shows triage-bot now.');
    expect(switchedText({ from: 'support-agent', to: 'triage-bot', refused: false })).toBe('The dashboard switched to triage-bot elsewhere: this page shows it now.');
  });

  it('tells a change made here (a switch, an add, a remove) from one made elsewhere, once', () => {
    expect(takeLanding('triage-bot')).toBeNull();
    expectProject('triage-bot');
    expect(takeLanding('support-agent')).toBeNull();
    expectProject('triage-bot', '#/tests');
    expect(takeLanding('triage-bot')).toBe('#/tests');
    expect(takeLanding('triage-bot')).toBeNull();
  });
});
